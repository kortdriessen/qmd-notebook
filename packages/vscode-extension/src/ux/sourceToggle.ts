/**
 * Edit in Source ⇄ Reopen as Notebook. V1 closes the writable notebook view before opening the
 * text view (and vice versa) so two unsynchronised writable models of the same file never
 * coexist; the kernel stays alive for the configured grace period.
 */
import * as vscode from 'vscode';
import { parseQmd, lineSpanOfSegment } from '../notebook';
import { emitNotebook } from '../notebook/serializer';
import { NOTEBOOK_TYPE, activeQmdEditor } from '../util/config';
import type { Logger } from '../util/logger';

export async function editInSource(logger: Logger): Promise<void> {
  const editor = activeQmdEditor();
  if (!editor) {
    void vscode.window.showInformationMessage('Open a .qmd as QMD Notebook first.');
    return;
  }
  const nb = editor.notebook;
  const selectedIndex = editor.selections[0]?.start ?? 0;
  if (nb.isDirty) {
    const ok = await nb.save();
    if (!ok) {
      const choice = await vscode.window.showWarningMessage('The notebook could not be saved. Open the source view anyway (unsaved cell edits stay only in the notebook view)?', { modal: true }, 'Open Source');
      if (choice !== 'Open Source') return;
    }
  }
  // Map the selected cell to its line span in the saved file.
  let line = 0;
  try {
    const emitted = emitNotebook(nb);
    line = emitted.cellLines[selectedIndex]?.startLine ?? 0;
  } catch (e) {
    logger.warn(`source map failed: ${String(e)}`);
  }
  const uri = nb.uri;
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  const text = vscode.window.activeTextEditor;
  if (text && text.document.uri.toString() === uri.toString()) {
    const pos = new vscode.Position(Math.min(line, text.document.lineCount - 1), 0);
    text.selection = new vscode.Selection(pos, pos);
    text.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

export async function reopenAsNotebook(uriArg?: vscode.Uri): Promise<void> {
  const text = vscode.window.activeTextEditor;
  let uri = uriArg;
  let cursorLine = 0;
  let closeText = false;
  if (!uri && text && text.document.uri.fsPath.toLowerCase().endsWith('.qmd')) {
    uri = text.document.uri;
    cursorLine = text.selection.active.line;
    closeText = true;
    if (text.document.isDirty) {
      const ok = await text.document.save();
      if (!ok) return;
    }
  }
  if (!uri) {
    void vscode.window.showInformationMessage('Open a .qmd file first.');
    return;
  }
  let targetCell = 0;
  if (closeText && text) {
    const doc = parseQmd(text.document.getText());
    for (let i = 0; i < doc.segments.length; i++) {
      const span = doc.segments[i]!.lines;
      if (cursorLine >= span.startLine && cursorLine < span.endLine) {
        targetCell = i;
        break;
      }
      if (cursorLine >= span.endLine) targetCell = i;
    }
    void lineSpanOfSegment;
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, NOTEBOOK_TYPE);
  const editor = vscode.window.activeNotebookEditor;
  if (editor && editor.notebook.uri.toString() === uri.toString() && editor.notebook.cellCount > 0) {
    const idx = Math.min(targetCell, editor.notebook.cellCount - 1);
    editor.selections = [new vscode.NotebookRange(idx, idx + 1)];
    editor.revealRange(new vscode.NotebookRange(idx, idx + 1), vscode.NotebookEditorRevealType.InCenter);
  }
}
