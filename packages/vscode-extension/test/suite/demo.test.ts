/**
 * Not a test: with QMD_DEMO=1 this opens the realistic analysis notebook, runs it, applies the
 * recommended appearance settings, and then idles so a screenshot/recording can be taken
 * (see scripts/screenshot.sh). Skipped otherwise.
 */
import * as vscode from 'vscode';
import { api, openNotebook, runCell, scratchCopy, selectTestKernel, sleep } from './helpers';
import { recommendedSettings } from '../../src/ux/settings';

describe('demo (screenshot)', function () {
  this.timeout(600000);

  it('opens, runs and idles', async function () {
    if (!process.env.QMD_DEMO) this.skip();
    const config = vscode.workspace.getConfiguration();
    for (const s of recommendedSettings()) await config.update(s.key, s.value, vscode.ConfigurationTarget.Workspace);
    for (const [key, value] of [
      ['window.zoomLevel', Number(process.env.QMD_DEMO_ZOOM ?? -1.5)],
      ['workbench.secondarySideBar.defaultVisibility', 'hidden'],
      ['chat.commandCenter.enabled', false],
    ] as const) {
      try {
        await config.update(key, value, vscode.ConfigurationTarget.Workspace);
      } catch {
        /* cosmetic; setting may not exist in this profile */
      }
    }
    for (const cmd of ['workbench.action.closeAuxiliaryBar', 'workbench.action.closeSidebar']) {
      try {
        await vscode.commands.executeCommand(cmd);
      } catch {
        /* cosmetic */
      }
    }
    const { notebook, editor } = await openNotebook(scratchCopy('realistic-analysis.qmd', 'demo.qmd'));
    await selectTestKernel(notebook);
    for (const cell of notebook.getCells()) {
      if (cell.kind === vscode.NotebookCellKind.Code) await runCell(notebook, cell.index);
    }
    const target = notebook.getCells().find((c) => c.document.getText().includes('fig-stage-time'))!;
    // a comment thread with an agent reply, as the user would see it
    const ext = await api();
    ext.requests.assign((await import('../../src/agent/notebookService')).documentIdFor(notebook), 9999, 'Claude Code');
    const draftId = await ext.comments.startDraft(target, 'cell');
    await ext.comments.submitDraft(draftId, 'Why does day 1 have so little NREM? Check the filtering and rerun.');
    const requestId = ext.requests.list('pending')[0]!.requestId;
    ext.requests.markDelivered(requestId, 'Claude Code');
    ext.requests.update(requestId, { status: 'working', message: 'Checking `bouts` for day 1 in the live kernel…', from: 'agent' });
    editor.selections = [new vscode.NotebookRange(target.index, target.index + 1)];
    editor.revealRange(new vscode.NotebookRange(target.index, target.index + 1), vscode.NotebookEditorRevealType.AtTop);
    await vscode.commands.executeCommand('notebook.cell.quitEdit');
    const seconds = Number(process.env.QMD_DEMO_SECONDS ?? 25);
    await sleep(seconds * 1000);
    const a = await api();
    await a.registry.shutdown(notebook);
  });
});
