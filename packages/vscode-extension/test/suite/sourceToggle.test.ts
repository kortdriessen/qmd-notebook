import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { api, closeAll, openNotebook, outputText, replaceCellText, runCell, scratchCopy, selectTestKernel, waitFor } from './helpers';

describe('Edit in Source ⇄ Reopen as Notebook', function () {
  after(async () => {
    await closeAll();
  });

  it('opens the text view at the selected cell and reopens as notebook with kernel state intact', async () => {
    const uri = scratchCopy('basic.qmd', 'toggle.qmd');
    const { notebook, editor } = await openNotebook(uri);
    await selectTestKernel(notebook);
    await runCell(notebook, 1);
    await replaceCellText(notebook.cellAt(1), 'import numpy as np\nx = np.arange(5)\nstate = 123');
    await runCell(notebook, 1);
    editor.selections = [new vscode.NotebookRange(2, 3)];
    await vscode.commands.executeCommand('qmdNotebook.editInSource');
    const text = await waitFor(() => {
      const t = vscode.window.activeTextEditor;
      return t && t.document.uri.fsPath === uri.fsPath ? t : undefined;
    }, 10000, 100, 'text editor');
    assert.equal(vscode.window.activeNotebookEditor, undefined, 'notebook view closed before source view opened');
    assert.ok(text.document.getText().includes('state = 123'), 'notebook was saved before switching');
    assert.equal(text.selection.active.line, text.document.getText().split('\n').indexOf('Done.'), 'cursor on the selected cell');
    // reopen as notebook: selection maps back to the cell under the cursor
    await vscode.commands.executeCommand('qmdNotebook.reopenAsNotebook');
    const nbEditor = await waitFor(() => (vscode.window.activeNotebookEditor?.notebook.uri.fsPath === uri.fsPath ? vscode.window.activeNotebookEditor : undefined), 10000, 100, 'notebook editor');
    assert.equal(nbEditor.selections[0]!.start, 2);
    const a = await api();
    const nb = nbEditor.notebook;
    await waitFor(() => a.registry.getSelectedController(nb), 10000, 100, 'kernel reselected');
    assert.equal(a.registry.kernelInfo(nb).status, 'idle', 'kernel retained across the toggle');
    const c = await runCell(nb, 1);
    void c;
    const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'state', 'python');
    const edit = new vscode.WorkspaceEdit();
    edit.set(nb.uri, [vscode.NotebookEdit.insertCells(nb.cellCount, [data])]);
    await vscode.workspace.applyEdit(edit);
    const last = await runCell(nb, nb.cellCount - 1);
    assert.equal(outputText(last, 'text/plain'), '123');
    await a.registry.shutdown(nb);
  });
});
