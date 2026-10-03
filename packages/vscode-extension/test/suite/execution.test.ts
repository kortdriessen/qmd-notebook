import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { api, closeAll, openNotebook, outputMimes, outputText, runCell, selectTestKernel, sleep, waitFor, workspaceDir } from './helpers';

const STDOUT = 'application/vnd.code.notebook.stdout';
const STDERR = 'application/vnd.code.notebook.stderr';
const ERROR = 'application/vnd.code.notebook.error';

const SOURCE = [
  "---",
  "title: \"Execution\"",
  "---",
  "",
  "```{python}",
  "x = 41",
  "```",
  "",
  "```{python}",
  "x + 1",
  "```",
  "",
  "```{python}",
  "import matplotlib",
  "matplotlib.use(\"module://matplotlib_inline.backend_inline\")",
  "import matplotlib.pyplot as plt, pandas as pd",
  "plt.plot([1, 2, 3]); plt.show()",
  "pd.DataFrame({\"a\": [1, 2]})",
  "```",
  "",
  "```{python}",
  "import sys",
  "print(\"out\")",
  "print(\"err\", file=sys.stderr)",
  "raise ValueError(\"boom\")",
  "```",
  "",
  "```{python}",
  "#| eval: false",
  "never = \"ran\"",
  "```",
  "",
  "```{python}",
  "import time",
  "for i in range(200):",
  "    time.sleep(0.1)",
  "```",
  "",
].join('\n');

describe('execution with a real kernel', function () {
  let notebook: vscode.NotebookDocument;
  let uri: vscode.Uri;

  before(async () => {
    uri = vscode.Uri.file(path.join(workspaceDir(), 'scratch', 'exec.qmd'));
    fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
    fs.writeFileSync(uri.fsPath, SOURCE);
    ({ notebook } = await openNotebook(uri));
    await selectTestKernel(notebook);
  });
  after(async () => {
    const a = await api();
    await a.registry.shutdown(notebook);
    await closeAll();
  });

  it('kernel picker lists the test environment as a controller', async () => {
    const a = await api();
    assert.ok(a.controllers.all.some((c) => c.candidate.pythonPath));
    assert.equal(a.registry.kernelInfo(notebook).status, 'not-started');
  });

  it('dependent cells share one kernel and show execution counts', async () => {
    const c1 = await runCell(notebook, 1);
    assert.equal(c1.executionSummary?.success, true);
    assert.equal(c1.executionSummary?.executionOrder, 1);
    const c2 = await runCell(notebook, 2);
    assert.equal(outputText(c2, 'text/plain'), '42');
    assert.equal(c2.executionSummary?.executionOrder, 2);
    const a = await api();
    assert.equal(a.registry.kernelInfo(notebook).status, 'idle');
  });

  it('matplotlib renders as image/png and pandas as text/html', async () => {
    const c = await runCell(notebook, 3);
    const mimes = outputMimes(c);
    assert.ok(mimes.some((m) => m.includes('image/png')), JSON.stringify(mimes));
    assert.ok(mimes.some((m) => m.includes('text/html')), JSON.stringify(mimes));
    assert.ok(outputText(c, 'text/html').includes('<table'));
    assert.equal(notebook.isDirty, false, 'outputs are transient');
  });

  it('stdout, stderr and tracebacks render inline; shift-enter-style advance stays on the failing cell', async () => {
    const c = await runCell(notebook, 4);
    assert.equal(outputText(c, STDOUT), 'out\n');
    assert.equal(outputText(c, STDERR), 'err\n');
    const err = JSON.parse(outputText(c, ERROR));
    assert.equal(err.name, 'ValueError');
    assert.equal(err.message, 'boom');
    assert.equal(c.executionSummary?.success, false);
    const editor = vscode.window.activeNotebookEditor!;
    editor.selections = [new vscode.NotebookRange(4, 5)];
    await vscode.commands.executeCommand('qmdNotebook.runCellAndAdvance');
    await sleep(300);
    assert.equal(editor.selections[0]!.start, 4, 'stays on the failing cell');
    editor.selections = [new vscode.NotebookRange(1, 2)];
    await vscode.commands.executeCommand('qmdNotebook.runCellAndAdvance');
    await sleep(300);
    assert.equal(editor.selections[0]!.start, 2, 'advances after success');
  });

  it('cells with eval: false are skipped unless forced', async () => {
    const editor = vscode.window.activeNotebookEditor!;
    const c = notebook.cellAt(5);
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 5, end: 6 }], document: notebook.uri });
    await sleep(500);
    assert.equal(c.outputs.length, 0);
    const a = await api();
    const check = await a.registry.executeScratch(notebook, 'print("never" in dir())');
    assert.equal(check.stdout.trim(), 'False');
    editor.selections = [new vscode.NotebookRange(5, 6)];
    await vscode.commands.executeCommand('qmdNotebook.forceRunCell');
    const check2 = await waitFor(async () => {
      const r = await a.registry.executeScratch(notebook, 'print("never" in dir())');
      return r.stdout.trim() === 'True' ? r : undefined;
    }, 20000, 500, 'forced run');
    assert.equal(check2!.stdout.trim(), 'True');
  });

  it('interrupt stops a long-running cell', async () => {
    const promise = vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 6, end: 7 }], document: notebook.uri });
    const a = await api();
    await waitFor(() => a.registry.kernelInfo(notebook).status === 'busy', 15000, 100, 'busy');
    await sleep(500);
    await vscode.commands.executeCommand('qmdNotebook.interruptKernel');
    await promise;
    const c = notebook.cellAt(6);
    assert.equal(c.executionSummary?.success, false);
    assert.match(outputText(c, ERROR), /KeyboardInterrupt/);
  });

  it('scratch execution is visible as agent activity and does not add cells', async () => {
    const a = await api();
    const count = notebook.cellCount;
    const p = a.registry.executeScratch(notebook, 'import time\ntime.sleep(1.5)\nprint(x)');
    await waitFor(() => a.registry.kernelInfo(notebook).agentActivity, 5000, 50, 'agent activity indicator');
    const r = await p;
    assert.equal(r.stdout.trim(), '41');
    assert.equal(notebook.cellCount, count);
    assert.equal(a.registry.kernelInfo(notebook).agentActivity, null);
  });

  it('restart clears state but keeps outputs', async () => {
    await vscode.commands.executeCommand('qmdNotebook.restartKernel');
    const a = await api();
    await waitFor(() => a.registry.kernelInfo(notebook).status === 'idle', 60000, 200, 'idle after restart');
    assert.ok(notebook.cellAt(2).outputs.length > 0, 'outputs kept');
    const c = await runCell(notebook, 2);
    assert.match(outputText(c, ERROR), /NameError/);
  });
});
