/**
 * End-to-end validation with the real Claude Code and Codex CLIs (Phase 2 gate).
 * Opt-in: QMD_E2E_AGENTS=claude,codex (each run costs agent usage). Each agent is asked to
 * inspect the live kernel, edit a selected cell through the notebook tools, execute it and report
 * the new output — without touching the .qmd on disk.
 */
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { focusNotebookPrompt } from '@qmd-notebook/shared';
import { api, closeAll, openNotebook, outputText, runCell, scratchCopy, selectTestKernel, sleep, solidPng, waitFor, workspaceDir } from './helpers';

const MCP_CLI = path.resolve(__dirname, '../../../../dist/qmd-notebook-mcp.js');
const AGENTS = (process.env.QMD_E2E_AGENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
/** A real node binary: process.execPath inside the extension host is VS Code's Electron. */
function nodeBinary(): string {
  if (process.env.QMD_NODE) return process.env.QMD_NODE;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'node');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'node';
}
const NODE = nodeBinary();

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Detached + stdin ignored: the CLIs must never share the extension host's stdio/process group.
    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + String(e) });
    });
  });
}

const TASK = (cellId: string) =>
  `Use the QMD Notebook MCP tools only (never edit files on disk). 1) Call get_active_context and read_notebook. ` +
  `2) Call summarize_variable for the variable "counter" in the live kernel and report its value. ` +
  `3) Read cell ${cellId} (read_cell), then replace its source with exactly: counter = counter + 100\\nprint("agent", counter) ` +
  `using replace_cell_source with the expectedSourceHash you read. 4) Execute that cell with execute_cell and report the stdout you got back. ` +
  `Finish with one line: DONE counter=<the value printed>.`;

describe('end-to-end with real agent CLIs', function () {
  this.timeout(600000);
  let notebook: vscode.NotebookDocument;
  let uri: vscode.Uri;
  let mcpConfigPath: string;

  before(async function () {
    if (AGENTS.length === 0) this.skip();
    uri = scratchCopy('basic.qmd', 'agents.qmd');
    ({ notebook } = await openNotebook(uri));
    await selectTestKernel(notebook);
    // set up kernel state + a target cell
    const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'counter = 7', 'python');
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(notebook.cellCount, [data])]);
    await vscode.workspace.applyEdit(edit);
    const a = await api();
    await waitFor(() => a.cellIdOf(notebook.cellAt(notebook.cellCount - 1)), 5000, 50, 'id');
    await runCell(notebook, notebook.cellCount - 1);
    await notebook.save();
    mcpConfigPath = path.join(os.tmpdir(), 'qmd-e2e-mcp.json');
    console.log('[e2e] node binary for the MCP companion:', NODE);
    fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { 'qmd-notebook': { command: NODE, args: [MCP_CLI, '--workspace', workspaceDir()] } } }));
  });
  after(async () => {
    if (AGENTS.length === 0) return;
    const a = await api();
    await a.registry.shutdown(notebook);
    await closeAll();
  });

  async function verify(agentName: string, transcript: string): Promise<void> {
    const target = notebook.cellAt(notebook.cellCount - 1);
    assert.equal(target.document.getText(), 'counter = counter + 100\nprint("agent", counter)', `${agentName} did not edit the live cell`);
    await waitFor(() => outputText(target, 'application/vnd.code.notebook.stdout').includes('agent 107'), 5000, 100, 'executed output');
    assert.match(transcript, /DONE counter=107/);
    const onDisk = fs.readFileSync(uri.fsPath, 'utf8');
    assert.ok(!onDisk.includes('agent'), 'the .qmd on disk must not be touched by the agent');
    assert.equal(notebook.isDirty, true, 'edits live in the notebook model until the user saves');
    // reset for the next agent
    const edit = new vscode.WorkspaceEdit();
    edit.replace(target.document.uri, target.document.validateRange(new vscode.Range(0, 0, target.document.lineCount, 0)), 'counter = 7');
    await vscode.workspace.applyEdit(edit);
    await runCell(notebook, notebook.cellCount - 1);
    await notebook.save();
  }

  it('Claude Code CLI edits and runs the live cell through the bridge', async function () {
    if (!AGENTS.includes('claude')) this.skip();
    const cellId = (await api()).cellIdOf(notebook.cellAt(notebook.cellCount - 1))!;
    const r = await run('claude', ['-p', TASK(cellId), '--mcp-config', mcpConfigPath, '--strict-mcp-config', '--allowedTools', 'mcp__qmd-notebook__*', '--max-turns', '20', '--output-format', 'text'], workspaceDir(), 500000);
    console.log('[claude stdout]', r.stdout.slice(-2000));
    if (r.stderr) console.log('[claude stderr]', r.stderr.slice(-1500));
    assert.equal(r.code, 0, r.stderr);
    await verify('claude', r.stdout);
  });

  const FOCUS_TASK = () =>
    focusNotebookPrompt('agents.qmd') +
    '\n\nFor this session: handle the comment(s) already waiting (they are returned by assign_notebook and by the first wait_for_comments), then call release_notebook and stop. Do not wait for more comments after that.';

  async function commentScenario(agentName: 'claude' | 'codex'): Promise<{ requestId: string; runOutput: () => string }> {
    const a = await api();
    const target = notebook.cellAt(notebook.cellCount - 1);
    const draftId = await a.comments.startDraft(target, 'cell');
    await a.comments.submitDraft(draftId, 'Change this cell so it prints "hello from the comment" after the counter line, then run it.');
    const requestId = a.requests.list('queued')[0]!.requestId;
    void agentName;
    return { requestId, runOutput: () => outputText(target, 'application/vnd.code.notebook.stdout') };
  }

  async function verifyComment(agentName: string, requestId: string, runOutput: () => string): Promise<void> {
    const a = await api();
    const packet = a.requests.get(requestId)!;
    assert.equal(packet.status, 'completed', `${agentName}: comment status is ${packet.status}`);
    assert.ok(packet.messages.some((m) => m.from === 'agent'), `${agentName} posted no reply into the thread`);
    assert.ok(runOutput().includes('hello from the comment'), `${agentName} did not run the edited cell (stdout: ${runOutput()})`);
    await waitFor(() => !a.requests.allAssignments().length, 10000, 200, 'assignment released');
    assert.ok(!fs.readFileSync(uri.fsPath, 'utf8').includes('hello from the comment'), 'the .qmd on disk must not be touched');
    // reset for the next agent
    const target = notebook.cellAt(notebook.cellCount - 1);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(target.document.uri, target.document.validateRange(new vscode.Range(0, 0, target.document.lineCount, 0)), 'counter = 7');
    await vscode.workspace.applyEdit(edit);
    await runCell(notebook, notebook.cellCount - 1);
    await notebook.save();
  }

  it('Claude Code CLI focuses the notebook and resolves an in-editor comment', async function () {
    if (!AGENTS.includes('claude')) this.skip();
    const { requestId, runOutput } = await commentScenario('claude');
    const r = await run('claude', ['-p', FOCUS_TASK(), '--mcp-config', mcpConfigPath, '--strict-mcp-config', '--allowedTools', 'mcp__qmd-notebook__*', '--max-turns', '30', '--output-format', 'text'], workspaceDir(), 500000);
    console.log('[claude focus stdout]', r.stdout.slice(-1500));
    if (r.stderr) console.log('[claude focus stderr]', r.stderr.slice(-800));
    assert.equal(r.code, 0, r.stderr);
    await verifyComment('claude', requestId, runOutput);
  });

  it('Codex CLI focuses the notebook and resolves an in-editor comment', async function () {
    if (!AGENTS.includes('codex')) this.skip();
    const { requestId, runOutput } = await commentScenario('codex');
    const args = [
      'exec',
      '--skip-git-repo-check',
      '-c', `mcp_servers.qmd_notebook.command=${JSON.stringify(NODE)}`,
      '-c', `mcp_servers.qmd_notebook.args=${JSON.stringify([MCP_CLI, '--workspace', workspaceDir()])}`,
      '--sandbox', 'read-only',
      FOCUS_TASK(),
    ];
    const r = await run('codex', args, workspaceDir(), 500000);
    console.log('[codex focus stdout]', r.stdout.slice(-1500));
    if (r.stderr) console.log('[codex focus stderr]', r.stderr.slice(-1500));
    assert.equal(r.code, 0, r.stderr);
    await verifyComment('codex', requestId, runOutput);
    await sleep(100);
  });

  async function imageScenario(): Promise<string> {
    const a = await api();
    const target = notebook.cellAt(notebook.cellCount - 1);
    const draftId = await a.comments.startDraft(target, 'cell');
    await a.comments.attachImage({ draftId }, { name: 'swatch.png', mime: 'image/png', width: 64, height: 64, base64: solidPng(64, 64, [220, 25, 25]).toString('base64') });
    await a.comments.submitDraft(draftId, 'Look at the attached image. Reply with the name of its dominant colour (one word) and resolve this comment. Do not edit or run any cell.');
    return a.requests.list('queued')[0]!.requestId;
  }

  async function verifyImage(agentName: string, requestId: string): Promise<void> {
    const a = await api();
    const packet = a.requests.get(requestId)!;
    assert.equal(packet.status, 'completed', `${agentName}: comment status is ${packet.status}`);
    const replies = packet.messages.filter((m) => m.from === 'agent').map((m) => m.text.toLowerCase()).join(' ');
    assert.match(replies, /red/, `${agentName} did not see the red image (replies: ${replies})`);
    await waitFor(() => !a.requests.allAssignments().length, 10000, 200, 'assignment released');
    a.comments.deleteThread(requestId);
  }

  it('Claude Code CLI sees an image pasted into a comment', async function () {
    if (!AGENTS.includes('claude')) this.skip();
    const requestId = await imageScenario();
    const r = await run('claude', ['-p', FOCUS_TASK(), '--mcp-config', mcpConfigPath, '--strict-mcp-config', '--allowedTools', 'mcp__qmd-notebook__*', '--max-turns', '30', '--output-format', 'text'], workspaceDir(), 500000);
    console.log('[claude image stdout]', r.stdout.slice(-800));
    if (r.stderr) console.log('[claude image stderr]', r.stderr.slice(-800));
    assert.equal(r.code, 0, r.stderr);
    await verifyImage('claude', requestId);
  });

  it('Codex CLI sees an image pasted into a comment', async function () {
    if (!AGENTS.includes('codex')) this.skip();
    const requestId = await imageScenario();
    const args = [
      'exec',
      '--skip-git-repo-check',
      '-c', `mcp_servers.qmd_notebook.command=${JSON.stringify(NODE)}`,
      '-c', `mcp_servers.qmd_notebook.args=${JSON.stringify([MCP_CLI, '--workspace', workspaceDir()])}`,
      '--sandbox', 'read-only',
      FOCUS_TASK(),
    ];
    const r = await run('codex', args, workspaceDir(), 500000);
    console.log('[codex image stdout]', r.stdout.slice(-800));
    if (r.stderr) console.log('[codex image stderr]', r.stderr.slice(-800));
    assert.equal(r.code, 0, r.stderr);
    await verifyImage('codex', requestId);
  });

  it('Codex CLI edits and runs the live cell through the bridge', async function () {
    if (!AGENTS.includes('codex')) this.skip();
    const cellId = (await api()).cellIdOf(notebook.cellAt(notebook.cellCount - 1))!;
    const args = [
      'exec',
      '--skip-git-repo-check',
      '-c', `mcp_servers.qmd_notebook.command=${JSON.stringify(NODE)}`,
      '-c', `mcp_servers.qmd_notebook.args=${JSON.stringify([MCP_CLI, '--workspace', workspaceDir()])}`,
      '--sandbox', 'read-only',
      TASK(cellId),
    ];
    const r = await run('codex', args, workspaceDir(), 500000);
    console.log('[codex stdout]', r.stdout.slice(-2000));
    if (r.stderr) console.log('[codex stderr]', r.stderr.slice(-2500));
    assert.equal(r.code, 0, r.stderr);
    await verify('codex', r.stdout + r.stderr);
  });
});
