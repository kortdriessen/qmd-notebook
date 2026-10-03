import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { closeAll, openNotebook, scratchCopy, sleep, waitFor } from './helpers';

describe('navigation commands and keybinding guards', function () {
  let notebook: vscode.NotebookDocument;
  let editor: vscode.NotebookEditor;

  before(async () => {
    ({ notebook, editor } = await openNotebook(scratchCopy('adjacent-cells.qmd', 'nav.qmd')));
  });
  after(async () => {
    await closeAll();
  });

  it('next/previous move the selection and clamp at the ends', async () => {
    editor.selections = [new vscode.NotebookRange(0, 1)];
    await vscode.commands.executeCommand('qmdNotebook.nextCell');
    assert.equal(editor.selections[0]!.start, 1);
    await vscode.commands.executeCommand('qmdNotebook.nextCell');
    assert.equal(editor.selections[0]!.start, 2);
    await vscode.commands.executeCommand('qmdNotebook.previousCell');
    assert.equal(editor.selections[0]!.start, 1);
    editor.selections = [new vscode.NotebookRange(0, 1)];
    await vscode.commands.executeCommand('qmdNotebook.previousCell');
    assert.equal(editor.selections[0]!.start, 0);
    editor.selections = [new vscode.NotebookRange(notebook.cellCount - 1, notebook.cellCount)];
    await vscode.commands.executeCommand('qmdNotebook.nextCell');
    assert.equal(editor.selections[0]!.start, notebook.cellCount - 1);
  });

  it('enter focuses the cell editor, escape returns to the cell list', async () => {
    editor.selections = [new vscode.NotebookRange(1, 2)];
    await vscode.commands.executeCommand('qmdNotebook.enterEditMode');
    await waitFor(() => vscode.window.activeTextEditor?.document === notebook.cellAt(1).document, 5000, 50, 'cell editor focus');
    await vscode.commands.executeCommand('qmdNotebook.exitToNavigationMode');
    await sleep(200);
    // after quitEdit the notebook editor stays active; the cell editor loses text focus
    assert.equal(vscode.window.activeNotebookEditor?.notebook, notebook);
  });

  it('Alt+J/K style commands also work from edit mode', async () => {
    editor.selections = [new vscode.NotebookRange(1, 2)];
    await vscode.commands.executeCommand('qmdNotebook.enterEditMode');
    await waitFor(() => vscode.window.activeTextEditor?.document === notebook.cellAt(1).document, 5000, 50, 'edit');
    await vscode.commands.executeCommand('qmdNotebook.nextCell');
    assert.equal(editor.selections[0]!.start, 2);
  });

  it('single-letter keybindings are guarded so they never fire inside text inputs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf8'));
    const bindings: Array<{ key: string; command: string; when: string }> = pkg.contributes.keybindings;
    for (const b of bindings) {
      const single = /^[a-z]$/.test(b.key) || b.key === 'd d' || b.key === 'enter';
      if (!single) continue;
      assert.match(b.when, /!inputFocus/, `${b.key} (${b.command}) must require !inputFocus`);
      assert.match(b.when, /notebookType == 'qmd-notebook'/, `${b.key} must be scoped to the qmd-notebook type`);
      assert.match(b.when, /!notebookFindWidgetFocused/, `${b.key} must not fire in the find widget`);
      assert.match(b.when, /!notebookOutputInputFocused/, `${b.key} must not fire in output inputs`);
    }
    for (const b of bindings.filter((x) => x.key.startsWith('alt+'))) {
      assert.match(b.when, /notebookEditorFocused/, `${b.key} needs notebookEditorFocused`);
    }
  });
});
