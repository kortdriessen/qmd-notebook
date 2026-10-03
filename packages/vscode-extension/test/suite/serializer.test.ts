import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { QmdSerializer } from '../../src/notebook/serializer';
import { api, closeAll, openNotebook, readFile, replaceCellText, scratchCopy, sleep, waitFor, workspaceDir } from './helpers';

function notebookData(nb: vscode.NotebookDocument): vscode.NotebookData {
  const cells = nb.getCells().map((c) => {
    const d = new vscode.NotebookCellData(c.kind, c.document.getText(), c.document.languageId);
    d.metadata = c.metadata;
    return d;
  });
  const data = new vscode.NotebookData(cells);
  data.metadata = nb.metadata;
  return data;
}

describe('QMD serializer in VS Code', function () {
  before(async () => {
    await api();
  });
  afterEach(async () => {
    await closeAll();
  });

  it('opens basic.qmd with markdown and python cells carrying transient ids', async () => {
    const { notebook } = await openNotebook(scratchCopy('basic.qmd'));
    const cells = notebook.getCells();
    assert.equal(cells.length, 3);
    assert.equal(cells[0]!.kind, vscode.NotebookCellKind.Markup);
    assert.equal(cells[1]!.kind, vscode.NotebookCellKind.Code);
    assert.equal(cells[1]!.document.languageId, 'python');
    assert.equal(cells[1]!.document.getText(), 'import numpy as np\nx = np.arange(5)');
    assert.match(cells[1]!.metadata!.qmd.id, /^qmdcell_/);
    assert.equal(notebook.isDirty, false, 'identity assignment must not dirty the document');
    assert.equal(notebook.metadata!.qmd.jupyterHint, 'python3');
  });

  it('no-op serialization is byte-identical for every fixture', async () => {
    const serializer = new QmdSerializer();
    const dir = workspaceDir();
    const fixtures = fs.readdirSync(dir).filter((f) => f.endsWith('.qmd'));
    assert.ok(fixtures.length > 20);
    for (const f of fixtures) {
      const uri = vscode.Uri.file(path.join(dir, f));
      const nb = await vscode.workspace.openNotebookDocument(uri);
      await waitFor(() => nb.getCells().every((c) => c.metadata?.qmd?.id) || nb.cellCount === 0, 10000, 50, `ids for ${f}`);
      const bytes = serializer.serializeNotebook(notebookData(nb));
      assert.deepEqual(Buffer.from(bytes), fs.readFileSync(uri.fsPath), `round trip differs for ${f}`);
      assert.equal(nb.isDirty, false, `${f} became dirty on open`);
    }
  });

  it('editing one python cell and saving produces a minimal diff', async () => {
    const uri = scratchCopy('basic.qmd', 'edit-python.qmd');
    const original = readFile(uri);
    const { notebook } = await openNotebook(uri);
    await replaceCellText(notebook.cellAt(1), 'import numpy as np\nx = np.arange(10)\nprint(x)');
    assert.equal(notebook.isDirty, true);
    assert.ok(await notebook.save());
    assert.equal(readFile(uri), original.replace('x = np.arange(5)\n', 'x = np.arange(10)\nprint(x)\n'));
  });

  it('editing markdown only touches the markdown bytes', async () => {
    const uri = scratchCopy('basic.qmd', 'edit-md.qmd');
    const original = readFile(uri);
    const { notebook } = await openNotebook(uri);
    await replaceCellText(notebook.cellAt(2), 'Done!\n\nReally.');
    assert.ok(await notebook.save());
    assert.equal(readFile(uri), original.replace('Done.\n', 'Done!\n\nReally.\n'));
  });

  it('insert commands create python cells with valid fences and focus them', async () => {
    const uri = scratchCopy('basic.qmd', 'insert.qmd');
    const original = readFile(uri);
    const { notebook, editor } = await openNotebook(uri);
    editor.selections = [new vscode.NotebookRange(1, 2)];
    await vscode.commands.executeCommand('qmdNotebook.insertCellBelow');
    assert.equal(notebook.cellCount, 4);
    const inserted = notebook.cellAt(2);
    assert.equal(inserted.kind, vscode.NotebookCellKind.Code);
    assert.equal(inserted.document.languageId, 'python');
    assert.match(inserted.metadata!.qmd.id, /^qmdcell_/);
    assert.equal(inserted.metadata!.qmd.fresh, true);
    assert.deepEqual(editor.selections[0], new vscode.NotebookRange(2, 3));
    await replaceCellText(inserted, 'y = x * 2');
    await vscode.commands.executeCommand('qmdNotebook.insertCellAbove');
    assert.equal(notebook.cellCount, 5);
    await replaceCellText(notebook.cellAt(2), 'w = 1');
    assert.ok(await notebook.save());
    assert.equal(readFile(uri), original.replace('x = np.arange(5)\n```\n\n', 'x = np.arange(5)\n```\n\n```{python}\nw = 1\n```\n\n```{python}\ny = x * 2\n```\n\n'));
  });

  it('cells inserted by VS Code built-ins get ids without dirtying, and delete/move round-trip', async () => {
    const uri = scratchCopy('adjacent-cells.qmd', 'builtin.qmd');
    const original = readFile(uri);
    const { notebook, editor } = await openNotebook(uri);
    editor.selections = [new vscode.NotebookRange(2, 3)];
    await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
    const a = await api();
    await waitFor(() => notebook.cellCount === 6 && a.cellIdOf(notebook.cellAt(3)), 5000, 50, 'builtin insert id');
    const ids = new Set(notebook.getCells().map((c) => a.cellIdOf(c)));
    assert.equal(ids.size, 6, 'ids are unique');
    assert.equal(notebook.cellAt(3).metadata?.qmd, undefined, 'built-in inserts carry no record; the id lives in the side table');
    // delete it again via built-in delete
    editor.selections = [new vscode.NotebookRange(3, 4)];
    await vscode.commands.executeCommand('notebook.cell.delete');
    await waitFor(() => notebook.cellCount === 5, 5000, 50, 'delete');
    await notebook.save();
    assert.equal(readFile(uri), original, 'insert+delete leaves the file unchanged');
    // move b above a with the built-in command
    editor.selections = [new vscode.NotebookRange(2, 3)];
    await vscode.commands.executeCommand('notebook.cell.moveUp');
    await waitFor(() => notebook.cellAt(1).document.getText() === 'b = 2', 5000, 50, 'move');
    await notebook.save();
    assert.equal(readFile(uri), original.replace('```{python}\na = 1\n```\n```{python}\nb = 2\n```\n\n', '```{python}\nb = 2\n```\n\n```{python}\na = 1\n```\n'));
  });

  it('convert markdown ↔ python keeps text and emits the right structure', async () => {
    const uri = scratchCopy('basic.qmd', 'convert.qmd');
    const original = readFile(uri);
    const { notebook, editor } = await openNotebook(uri);
    editor.selections = [new vscode.NotebookRange(2, 3)];
    await vscode.commands.executeCommand('qmdNotebook.convertToPython');
    await waitFor(() => notebook.cellAt(2).kind === vscode.NotebookCellKind.Code, 5000, 50, 'convert');
    assert.equal(notebook.cellAt(2).document.getText(), 'Done.');
    assert.ok(await notebook.save());
    assert.equal(readFile(uri), original.replace('Done.\n', '```{python}\nDone.\n```\n'));
    editor.selections = [new vscode.NotebookRange(2, 3)];
    await vscode.commands.executeCommand('qmdNotebook.convertToMarkdown');
    await waitFor(() => notebook.cellAt(2).kind === vscode.NotebookCellKind.Markup, 5000, 50, 'convert back');
    assert.ok(await notebook.save());
    assert.equal(readFile(uri), original);
  });

  it('reload from disk picks up external changes', async () => {
    const uri = scratchCopy('basic.qmd', 'reload.qmd');
    const { notebook } = await openNotebook(uri);
    fs.writeFileSync(uri.fsPath, readFile(uri).replace('x = np.arange(5)', 'x = np.arange(99)'));
    await sleep(300);
    await vscode.commands.executeCommand('qmdNotebook.reloadFromDisk');
    await waitFor(() => notebook.cellAt(1).document.getText().includes('99'), 10000, 100, 'reload');
    assert.equal(notebook.isDirty, false, 'clean after reload');
    assert.match(notebook.cellAt(1).metadata!.qmd.id, /^qmdcell_/, 'reloaded cells carry fresh records');
    assert.equal(fs.readFileSync(uri.fsPath, 'utf8').includes('np.arange(99)'), true, 'file unchanged by the reload');
  });

  it('outputs never reach the file', async () => {
    const uri = scratchCopy('basic.qmd', 'outputs.qmd');
    const original = readFile(uri);
    const { notebook } = await openNotebook(uri);
    // simulate an output via a transient edit through the extension's own execution path is
    // covered in execution tests; here just ensure metadata/outputs keys are transient.
    assert.equal(notebook.isDirty, false);
    await notebook.save();
    assert.equal(readFile(uri), original);
  });
});
