/**
 * Notebook UX commands: navigation/focus model, cell insertion/conversion, execution shortcuts,
 * kernel lifecycle, source toggle, Quarto render, settings and diagnostics.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SessionRegistry } from '../execution/sessionRegistry';
import type { ControllerManager } from '../execution/controller';
import { freshRecord } from '../notebook/identity';
import { QmdSerializer } from '../notebook/serializer';
import { NOTEBOOK_TYPE, activeQmdEditor, getSetting } from '../util/config';
import type { Logger } from '../util/logger';
import { currentMode } from './statusBar';
import { editInSource, reopenAsNotebook } from './sourceToggle';
import { applyRecommendedSettings } from './settings';

export interface CommandDeps {
  context: vscode.ExtensionContext;
  registry: SessionRegistry;
  controllers: ControllerManager;
  logger: Logger;
  diagnosticReport: () => string;
}

function selectedIndex(editor: vscode.NotebookEditor): number {
  return Math.min(editor.selections[0]?.start ?? 0, Math.max(0, editor.notebook.cellCount - 1));
}

async function selectCell(editor: vscode.NotebookEditor, index: number, mode: 'nav' | 'edit' | 'keep'): Promise<void> {
  const count = editor.notebook.cellCount;
  if (count === 0) return;
  const idx = Math.max(0, Math.min(index, count - 1));
  const wasEditing = currentMode() === 'edit';
  editor.selections = [new vscode.NotebookRange(idx, idx + 1)];
  editor.revealRange(new vscode.NotebookRange(idx, idx + 1), vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
  const target = mode === 'keep' ? (wasEditing ? 'edit' : 'nav') : mode;
  if (target === 'edit') await vscode.commands.executeCommand('notebook.cell.edit');
  else await vscode.commands.executeCommand('notebook.cell.quitEdit');
}

async function insertCell(editor: vscode.NotebookEditor, index: number, kind: 'python' | 'markdown', source = ''): Promise<number> {
  const data = kind === 'python' ? new vscode.NotebookCellData(vscode.NotebookCellKind.Code, source, 'python') : new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, source, 'markdown');
  data.metadata = { qmd: freshRecord(kind) };
  const edit = new vscode.WorkspaceEdit();
  edit.set(editor.notebook.uri, [vscode.NotebookEdit.insertCells(index, [data])]);
  await vscode.workspace.applyEdit(edit);
  await selectCell(editor, index, 'edit');
  return index;
}

async function convertCell(editor: vscode.NotebookEditor, kind: 'python' | 'markdown'): Promise<void> {
  const nb = editor.notebook;
  const idx = selectedIndex(editor);
  const cell = nb.cellAt(idx);
  const wantKind = kind === 'python' ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup;
  if (cell.kind === wantKind && (kind !== 'python' || cell.document.languageId === 'python')) return;
  const data = kind === 'python' ? new vscode.NotebookCellData(vscode.NotebookCellKind.Code, cell.document.getText(), 'python') : new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, cell.document.getText(), 'markdown');
  data.metadata = cell.metadata; // keeps the runtime id and original bytes so the emitter can restructure precisely
  const edit = new vscode.WorkspaceEdit();
  edit.set(nb.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(idx, idx + 1), [data])]);
  await vscode.workspace.applyEdit(edit);
  await selectCell(editor, idx, 'nav');
}

async function executeIndex(editor: vscode.NotebookEditor, idx: number): Promise<void> {
  await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: idx, end: idx + 1 }], document: editor.notebook.uri });
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { registry, logger } = deps;
  const reg = (id: string, fn: (...args: any[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.error(`${id}: ${message}`);
        void vscode.window.showErrorMessage(`QMD Notebook: ${message}`);
        return undefined;
      }
    });

  const needEditor = (): vscode.NotebookEditor => {
    const editor = activeQmdEditor();
    if (!editor) throw new Error('No QMD notebook is active');
    return editor;
  };

  return [
    reg('qmdNotebook.openAsNotebook', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) throw new Error('Open or select a .qmd file first');
      await vscode.commands.executeCommand('vscode.openWith', target, NOTEBOOK_TYPE);
    }),
    reg('qmdNotebook.editInSource', () => editInSource(logger)),
    reg('qmdNotebook.reopenAsNotebook', (uri?: vscode.Uri) => reopenAsNotebook(uri instanceof vscode.Uri ? uri : undefined)),
    reg('qmdNotebook.reloadFromDisk', async () => {
      // VS Code keeps a clean notebook model cached (revert is a no-op unless dirty, and the
      // extension host holds a reference after the editor closes), so reload explicitly: read the
      // file, deserialize it, replace the cells + metadata, and save to re-synchronise the saved
      // state (the bytes written are identical to the file). Outputs are dropped like any reload.
      const editor = needEditor();
      const nb = editor.notebook;
      if (nb.isDirty) {
        const choice = await vscode.window.showWarningMessage('Discard unsaved notebook changes and reload from disk?', { modal: true }, 'Reload');
        if (choice !== 'Reload') return;
      }
      const index = editor.selections[0]?.start ?? 0;
      const bytes = await vscode.workspace.fs.readFile(nb.uri);
      const data = new QmdSerializer().deserializeNotebook(bytes);
      const edit = new vscode.WorkspaceEdit();
      edit.set(nb.uri, [
        vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, nb.cellCount), data.cells),
        vscode.NotebookEdit.updateNotebookMetadata(data.metadata ?? {}),
      ]);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code rejected the reload edit');
      await nb.save();
      if (nb.cellCount > 0) {
        const idx = Math.min(index, nb.cellCount - 1);
        editor.selections = [new vscode.NotebookRange(idx, idx + 1)];
      }
      logger.info(`reloaded ${path.basename(nb.uri.fsPath)} from disk (${nb.cellCount} cells)`);
    }),

    // ---- focus model
    reg('qmdNotebook.enterEditMode', () => vscode.commands.executeCommand('notebook.cell.edit')),
    reg('qmdNotebook.exitToNavigationMode', () => vscode.commands.executeCommand('notebook.cell.quitEdit')),
    reg('qmdNotebook.nextCell', async () => {
      const editor = needEditor();
      await selectCell(editor, selectedIndex(editor) + 1, 'nav');
    }),
    reg('qmdNotebook.previousCell', async () => {
      const editor = needEditor();
      await selectCell(editor, selectedIndex(editor) - 1, 'nav');
    }),

    // ---- structure
    reg('qmdNotebook.insertCellAbove', async () => {
      const editor = needEditor();
      await insertCell(editor, selectedIndex(editor), getSetting<'python' | 'markdown'>('insertCellKind', 'python'));
    }),
    reg('qmdNotebook.insertCellBelow', async () => {
      const editor = needEditor();
      await insertCell(editor, editor.notebook.cellCount === 0 ? 0 : selectedIndex(editor) + 1, getSetting<'python' | 'markdown'>('insertCellKind', 'python'));
    }),
    reg('qmdNotebook.insertMarkdownCellAbove', async () => {
      const editor = needEditor();
      await insertCell(editor, selectedIndex(editor), 'markdown');
    }),
    reg('qmdNotebook.insertMarkdownCellBelow', async () => {
      const editor = needEditor();
      await insertCell(editor, editor.notebook.cellCount === 0 ? 0 : selectedIndex(editor) + 1, 'markdown');
    }),
    reg('qmdNotebook.convertToMarkdown', () => convertCell(needEditor(), 'markdown')),
    reg('qmdNotebook.convertToPython', () => convertCell(needEditor(), 'python')),
    reg('qmdNotebook.deleteCell', () => vscode.commands.executeCommand('notebook.cell.delete')),

    // ---- execution
    reg('qmdNotebook.runCell', async () => {
      const editor = needEditor();
      await executeIndex(editor, selectedIndex(editor));
    }),
    reg('qmdNotebook.runCellAndAdvance', async () => {
      const editor = needEditor();
      const nb = editor.notebook;
      const idx = selectedIndex(editor);
      const cell = nb.cellAt(idx);
      const wasEditing = currentMode() === 'edit';
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        await vscode.commands.executeCommand('notebook.cell.quitEdit');
      } else {
        await executeIndex(editor, idx);
        const result = await registry.waitForCell(cell);
        const advanceOnError = getSetting<boolean>('navigation.advanceOnError', false);
        if (result && result.success === false && !advanceOnError) {
          await selectCell(editor, idx, wasEditing ? 'edit' : 'nav');
          return;
        }
        if (!result) return; // no kernel selected yet: the picker took over
      }
      if (idx + 1 < nb.cellCount) await selectCell(editor, idx + 1, wasEditing ? 'edit' : 'nav');
      else await insertCell(editor, nb.cellCount, 'python');
    }),
    reg('qmdNotebook.runCellAndInsert', async () => {
      const editor = needEditor();
      const idx = selectedIndex(editor);
      await executeIndex(editor, idx);
      await insertCell(editor, idx + 1, 'python');
    }),
    reg('qmdNotebook.forceRunCell', async (cellArg?: vscode.NotebookCell) => {
      const editor = needEditor();
      const nb = editor.notebook;
      const controller = registry.getSelectedController(nb);
      if (!controller) {
        await vscode.commands.executeCommand('notebook.selectKernel');
        return;
      }
      const cells = cellArg && cellArg.notebook === nb ? [cellArg] : editor.selections.flatMap((r) => nb.getCells(r));
      await registry.runCells(nb, cells.filter((c) => c.kind === vscode.NotebookCellKind.Code), controller, { force: true });
    }),
    reg('qmdNotebook.runCellsAbove', () => vscode.commands.executeCommand('notebook.cell.executeCellsAbove')),
    reg('qmdNotebook.runAll', () => vscode.commands.executeCommand('notebook.execute')),
    reg('qmdNotebook.selectKernel', () => vscode.commands.executeCommand('notebook.selectKernel')),
    reg('qmdNotebook.interruptKernel', () => registry.interrupt(needEditor().notebook)),
    reg('qmdNotebook.restartKernel', async () => {
      const nb = needEditor().notebook;
      await registry.restart(nb);
      vscode.window.setStatusBarMessage('$(check) QMD: kernel restarted (outputs kept, state cleared)', 4000);
    }),
    reg('qmdNotebook.shutdownKernel', async () => {
      const nb = needEditor().notebook;
      await registry.shutdown(nb);
      vscode.window.setStatusBarMessage('$(check) QMD: kernel shut down', 4000);
    }),
    reg('qmdNotebook.clearCellOutputs', () => vscode.commands.executeCommand('notebook.cell.clearOutputs')),
    reg('qmdNotebook.clearAllOutputs', () => vscode.commands.executeCommand('notebook.clearAllCellsOutputs')),

    // ---- quarto
    reg('qmdNotebook.renderWithQuarto', async () => {
      const editor = activeQmdEditor();
      const uri = editor?.notebook.uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri || !uri.fsPath.endsWith('.qmd')) throw new Error('No .qmd document is active');
      if (editor?.notebook.isDirty) {
        const ok = await editor.notebook.save();
        if (!ok) return;
      }
      const quartoExt = vscode.extensions.getExtension('quarto.quarto');
      const commands = await vscode.commands.getCommands(true);
      if (quartoExt && commands.includes('quarto.render') && !editor) {
        await vscode.commands.executeCommand('quarto.render');
        return;
      }
      const terminal = vscode.window.terminals.find((t) => t.name === 'Quarto render') ?? vscode.window.createTerminal({ name: 'Quarto render', cwd: path.dirname(uri.fsPath) });
      terminal.show(true);
      terminal.sendText(`quarto render "${uri.fsPath}"`, true);
    }),

    // ---- settings / diagnostics
    reg('qmdNotebook.applyRecommendedSettings', () => applyRecommendedSettings()),
    reg('qmdNotebook.copyDiagnosticReport', async () => {
      const report = deps.diagnosticReport();
      await vscode.env.clipboard.writeText(report);
      void vscode.window.showInformationMessage('QMD Notebook diagnostic report copied to the clipboard (no notebook content included).');
    }),
    reg('qmdNotebook.showOutputChannel', () => logger.show()),
  ];
}

export function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
