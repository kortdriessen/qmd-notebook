/**
 * Agent bridge tests through the real MCP companion (stdio) using the MCP SDK client.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { hashText } from '@qmd-notebook/shared';
import { api, closeAll, openNotebook, replaceCellText, scratchCopy, selectTestKernel, sleep, solidPng, waitFor, workspaceDir } from './helpers';

const MCP_CLI = path.resolve(__dirname, '../../../../dist/qmd-notebook-mcp.js');

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

// The companion adapts image delivery to the client it serves (identified at the MCP handshake):
// the default test client presents itself as Claude Code, which displays image content.
async function startClient(workspace: string, clientName = 'claude-code'): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_CLI, '--workspace', workspace], env: { ...process.env } as Record<string, string> });
  const client = new Client({ name: clientName, version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ raw: ToolResult; json: any }> {
  const raw = (await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 })) as ToolResult;
  const text = raw.content.find((c) => c.type === 'text')?.text ?? '';
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { raw, json };
}

describe('agent bridge via the MCP companion', function () {
  let client: Client;
  let notebook: vscode.NotebookDocument;
  let editor: vscode.NotebookEditor;
  let uri: vscode.Uri;

  before(async () => {
    assert.ok(fs.existsSync(MCP_CLI), `missing ${MCP_CLI}`);
    uri = scratchCopy('realistic-analysis.qmd', 'bridge.qmd');
    ({ notebook, editor } = await openNotebook(uri));
    await selectTestKernel(notebook);
    // warm the kernel so per-call timeouts measure execution, not a cold start
    await (await api()).registry.executeScratch(notebook, 'pass', { timeoutMs: 120000 });
    client = await startClient(workspaceDir());
  });
  after(async () => {
    await client.close().catch(() => undefined);
    const a = await api();
    await a.registry.shutdown(notebook);
    await closeAll();
  });

  it('exposes the documented tool surface', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    for (const n of ['list_open_notebooks', 'get_active_context', 'read_notebook', 'read_cell', 'read_output', 'replace_cell_source', 'insert_cell', 'delete_cell', 'move_cell', 'apply_cell_edits', 'execute_cell', 'execute_cells', 'execute_scratch', 'list_variables', 'summarize_variable', 'interrupt_kernel', 'restart_kernel', 'get_request', 'update_request', 'resolve_request', 'wait_for_request', 'list_requests']) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
  });

  it('lists open notebooks and the active context including the text selection', async () => {
    const { json } = await call(client, 'list_open_notebooks');
    assert.equal(json.length, 1);
    assert.equal(json[0].displayName, 'bridge.qmd');
    assert.equal(json[0].kernel.status, 'idle', 'kernel was warmed up in before()');
    // put a text selection inside cell 1 (the setup cell)
    editor.selections = [new vscode.NotebookRange(1, 2)];
    await vscode.commands.executeCommand('notebook.cell.edit');
    const text = await waitFor(() => (vscode.window.activeTextEditor?.document === notebook.cellAt(1).document ? vscode.window.activeTextEditor : undefined), 5000, 50, 'cell editor');
    text.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 18));
    const ctx = (await call(client, 'get_active_context')).json;
    assert.equal(ctx.notebook.documentId, json[0].documentId);
    assert.equal(ctx.activeCellId, notebook.cellAt(1).metadata!.qmd.id);
    assert.equal(ctx.selection.text, 'import numpy as np');
    assert.equal(ctx.selection.cellId, ctx.activeCellId);
    await vscode.commands.executeCommand('notebook.cell.quitEdit');
  });

  it('reads the notebook with stable ids, hashes and source line spans', async () => {
    const { json } = await call(client, 'read_notebook');
    assert.equal(json.cells.length, notebook.cellCount);
    assert.equal(json.cells[1].kind, 'python');
    assert.equal(json.cells[1].cellId, notebook.cellAt(1).metadata!.qmd.id);
    assert.equal(json.cells[1].sourceHash, hashText(notebook.cellAt(1).document.getText()));
    assert.equal(json.cells[1].options.label, 'setup');
    assert.deepEqual(json.cells[1].sourceLines, { start: 17, end: 22 });
    const one = (await call(client, 'read_cell', { cellId: json.cells[1].cellId })).json;
    assert.equal(one.cell.source, notebook.cellAt(1).document.getText());
  });

  it('rejects stale edits and applies fresh ones through VS Code (undoable)', async () => {
    const before = (await call(client, 'read_cell', { cellId: notebook.cellAt(1).metadata!.qmd.id })).json;
    const cellId = before.cell.cellId;
    // user edits concurrently
    await replaceCellText(notebook.cellAt(1), before.cell.source + '\nuser_edit = True');
    const stale = await call(client, 'replace_cell_source', { cellId, expectedVersion: before.notebook.version, expectedSourceHash: before.cell.sourceHash, source: 'agent = 1' });
    assert.equal(stale.raw.isError, true);
    assert.equal(stale.json.code, -32003, JSON.stringify(stale.json));
    assert.ok(notebook.cellAt(1).document.getText().includes('user_edit = True'), 'user edit preserved');
    assert.ok(stale.json.data.currentSource.includes('user_edit = True'), 'the conflict carries the current source to rebase on');
    // re-read and rebase; meanwhile the user types in ANOTHER cell, which must not block the agent
    const fresh = (await call(client, 'read_cell', { cellId })).json;
    const elsewhere = notebook.cellAt(notebook.cellCount - 1);
    const elsewhereText = elsewhere.document.getText();
    await replaceCellText(elsewhere, elsewhereText + '\nuser_typing = True');
    assert.notEqual((await call(client, 'list_open_notebooks')).json[0].version, fresh.notebook.version, 'the notebook version moved');
    const ok = await call(client, 'replace_cell_source', { cellId, expectedVersion: fresh.notebook.version, expectedSourceHash: fresh.cell.sourceHash, source: fresh.cell.source.replace('user_edit = True', 'user_edit = True\nagent_edit = True') });
    assert.equal(ok.raw.isError, undefined, `edits are guarded per cell, not by the notebook version: ${JSON.stringify(ok.json)}`);
    await replaceCellText(elsewhere, elsewhereText);
    assert.ok(notebook.cellAt(1).document.getText().includes('agent_edit = True'));
    // undo through VS Code restores the user's version (focus the cell editor first; retry if
    // focus landed elsewhere)
    for (let attempt = 0; attempt < 4 && notebook.cellAt(1).document.getText().includes('agent_edit'); attempt++) {
      await vscode.window.showNotebookDocument(notebook, { selections: [new vscode.NotebookRange(1, 2)] });
      await vscode.commands.executeCommand('notebook.cell.edit');
      await waitFor(() => vscode.window.activeTextEditor?.document === notebook.cellAt(1).document, 5000, 50, 'edit');
      await vscode.commands.executeCommand('undo');
      await sleep(400);
    }
    await waitFor(() => !notebook.cellAt(1).document.getText().includes('agent_edit'), 5000, 50, 'undo');
    assert.ok(notebook.cellAt(1).document.getText().includes('user_edit = True'));
    await vscode.commands.executeCommand('notebook.cell.quitEdit');
  });

  it('insert, move and delete cells by id with per-cell preconditions', async () => {
    const nb = (await call(client, 'read_notebook', { includeOutputs: false })).json;
    const anchor = nb.cells[1].cellId;
    const ins = await call(client, 'insert_cell', { anchorCellId: anchor, position: 'below', kind: 'python', source: 'inserted = 1', expectedVersion: nb.notebook.version });
    assert.equal(ins.raw.isError, undefined, JSON.stringify(ins.json));
    assert.equal(notebook.cellAt(2).document.getText(), 'inserted = 1');
    assert.equal(notebook.cellAt(2).metadata!.qmd.id, ins.json.cellId);
    const gone = await call(client, 'insert_cell', { anchorCellId: 'qmdcell_000000000000000000000', position: 'below', kind: 'markdown', source: 'x' });
    assert.equal(gone.raw.isError, true, 'a missing anchor is the only insert precondition');
    const staleVersion = await call(client, 'insert_cell', { anchorCellId: anchor, position: 'below', kind: 'markdown', source: 'x', expectedVersion: nb.notebook.version - 5 });
    assert.equal(staleVersion.raw.isError, undefined, 'a stale notebook version is informational, not a conflict');
    await call(client, 'delete_cell', { cellId: staleVersion.json.cellId, expectedSourceHash: hashText('x') });
    const v1 = (await call(client, 'list_open_notebooks')).json[0].version;
    const mv = await call(client, 'move_cell', { cellId: ins.json.cellId, anchorCellId: nb.cells[0].cellId, position: 'below', expectedVersion: v1 });
    assert.equal(mv.raw.isError, undefined, JSON.stringify(mv.json));
    assert.equal(notebook.cellAt(1).document.getText(), 'inserted = 1');
    assert.equal(notebook.cellAt(1).metadata!.qmd.id, ins.json.cellId, 'id survives a move');
    const del = await call(client, 'delete_cell', { cellId: ins.json.cellId, expectedVersion: mv.json.version, expectedSourceHash: hashText('inserted = 1') });
    assert.equal(del.raw.isError, undefined, JSON.stringify(del.json));
    assert.equal(notebook.cellCount, nb.cells.length);
    const batch = await call(client, 'apply_cell_edits', {
      expectedVersion: del.json.version,
      edits: [
        { op: 'insert', anchorCellId: null, position: 'below', kind: 'markdown', source: 'tail note' },
        { op: 'insert', anchorCellId: null, position: 'above', kind: 'python', source: 'head = 1' },
      ],
    });
    assert.equal(batch.raw.isError, undefined, JSON.stringify(batch.json));
    assert.equal(notebook.cellAt(0).document.getText(), 'head = 1');
    assert.equal(notebook.cellAt(notebook.cellCount - 1).document.getText(), 'tail note');
    // clean up and make sure the file still serializes to valid QMD around the agent's cells
    await notebook.save();
    const text = fs.readFileSync(uri.fsPath, 'utf8');
    assert.ok(text.startsWith('```{python}\nhead = 1\n```\n\n---\n'));
    assert.ok(text.endsWith('\n\ntail note\n'));
  });

  it('executes a cell, returns bounded outputs, and serves the plot as an image', async () => {
    const nb = (await call(client, 'read_notebook', { includeOutputs: false })).json;
    const setup = nb.cells.find((c: any) => c.source.includes('import numpy as np'));
    const simulate = nb.cells.find((c: any) => c.source.includes('bouts = pd.DataFrame'));
    const fig = nb.cells.find((c: any) => c.source.includes('fig-stage-time'));
    const r1 = await call(client, 'execute_cells', { cellIds: [setup.cellId, simulate.cellId], stopOnError: true });
    assert.equal(r1.raw.isError, undefined, JSON.stringify(r1.json));
    assert.equal(r1.json.length, 2);
    assert.equal(r1.json[1].success, true);
    assert.ok(r1.json[1].outputs.some((o: any) => o.items.some((i: any) => i.mime === 'text/html')));
    const r2 = await call(client, 'execute_cell', { cellId: fig.cellId, timeoutMs: 60000 });
    assert.equal(r2.raw.isError, undefined, JSON.stringify(r2.json));
    assert.equal(r2.json.success, true);
    const png = r2.json.outputs.flatMap((o: any) => o.items.map((i: any) => ({ ...i, outputId: o.outputId }))).find((i: any) => i.mime === 'image/png');
    assert.ok(png, JSON.stringify(r2.json.outputs));
    const img = await call(client, 'read_output', { cellId: fig.cellId, outputId: png.outputId });
    assert.equal(img.raw.isError, undefined, JSON.stringify(img.json));
    const image = img.raw.content.find((c) => c.type === 'image');
    assert.ok(image && image.mimeType === 'image/png' && (image.data ?? '').length > 100, 'image content returned');
    assert.ok(img.json.filePath && fs.existsSync(img.json.filePath), 'temp file written');
    assert.equal(fs.statSync(img.json.filePath).mode & 0o777, 0o600);
    assert.ok(img.json.width > 0 && img.json.height > 0);
    // stale output id → conflict after re-execution
    await call(client, 'execute_cell', { cellId: fig.cellId, timeoutMs: 60000 });
    const gone = await call(client, 'read_output', { cellId: fig.cellId, outputId: png.outputId });
    assert.ok(gone.raw.isError === true || gone.json.outputId === png.outputId);
    // a failing cell reports the traceback
    const ins = await call(client, 'insert_cell', { anchorCellId: null, position: 'below', kind: 'python', source: '1/0', expectedVersion: (await call(client, 'list_open_notebooks')).json[0].version });
    const bad = await call(client, 'execute_cell', { cellId: ins.json.cellId });
    assert.equal(bad.json.success, false);
    assert.equal(bad.json.error.name, 'ZeroDivisionError');
  });

  it('inspects the live kernel without creating cells', async () => {
    const count = notebook.cellCount;
    const vars = (await call(client, 'list_variables')).json;
    const names = vars.variables.map((v: any) => v.name);
    assert.ok(names.includes('bouts'), names.join(','));
    const df = (await call(client, 'summarize_variable', { name: 'bouts', maxRows: 3 })).json;
    assert.deepEqual(df.columns, ['day', 'start_s', 'duration_s', 'stage']);
    assert.ok(df.head.includes('stage'));
    const scratch = (await call(client, 'execute_scratch', { code: 'print(len(bouts))' })).json;
    assert.equal(scratch.success, true);
    assert.match(scratch.stdout, /^\d+\n$/);
    const err = (await call(client, 'summarize_variable', { name: '__last_error__' })).json;
    assert.equal(err.type, 'ZeroDivisionError');
    assert.equal(notebook.cellCount, count);
  });

  it('runs the contextual request lifecycle', async () => {
    const a = await api();
    const cell = notebook.getCells().find((c) => c.document.getText().includes('fig-stage-time'))!;
    const cellId = cell.metadata!.qmd.id;
    const dirtyBefore = notebook.isDirty;
    const waiting = call(client, 'wait_for_request', { timeoutMs: 10000 });
    await sleep(300);
    const packet = a.requests.create({
      prompt: 'Why does the REM bar look wrong?',
      documentId: (await call(client, 'list_open_notebooks')).json[0].documentId,
      uri: notebook.uri.toString(),
      documentVersion: notebook.version,
      cellId,
      anchor: 'cell',
      kernel: a.registry.kernelInfo(notebook),
      attachments: [{ kind: 'cell', cellId, cellKind: 'python', sourceHash: hashText(cell.document.getText()), source: cell.document.getText() }],
      attachmentHashes: [],
    });
    const w = (await waiting).json;
    assert.equal(w.requestId, packet.requestId);
    const got = (await call(client, 'get_request', { requestId: packet.requestId })).json;
    assert.equal(got.prompt, 'Why does the REM bar look wrong?');
    assert.equal(got.attachments[0].cellId, cellId);
    assert.equal(a.requests.get(packet.requestId)!.status, 'delivered');
    await call(client, 'update_request', { requestId: packet.requestId, status: 'working', message: 'inspecting summary' });
    assert.equal(a.requests.get(packet.requestId)!.status, 'working');
    await call(client, 'resolve_request', { requestId: packet.requestId, summary: 'Fixed the grouping.', linkedCellIds: [cellId] });
    assert.equal(a.requests.get(packet.requestId)!.status, 'completed');
    assert.deepEqual(a.requests.get(packet.requestId)!.linkedCellIds, [cellId]);
    const none = (await call(client, 'wait_for_request', { timeoutMs: 1000 })).json;
    assert.equal(none, null);
    assert.equal(notebook.isDirty, dirtyBefore, 'composing a request must not change the dirty state');
    await notebook.save();
    assert.ok(!fs.readFileSync(uri.fsPath, 'utf8').includes('qmdreq_'), 'request threads never save into the qmd');
  });

  it('routes in-editor comments to an assigned agent: assign, wait, reply, resolve, release', async () => {
    const a = await api();
    const docId = (await call(client, 'list_open_notebooks')).json[0].documentId;
    // 1. the agent focuses the notebook by file name
    const assigned = await call(client, 'assign_notebook', { notebook: 'bridge.qmd', agentName: 'Test Agent' });
    assert.equal(assigned.raw.isError, undefined, JSON.stringify(assigned.json));
    assert.equal(assigned.json.notebook.documentId, docId);
    assert.equal(assigned.json.agentName, 'Test Agent');
    assert.equal(a.requests.assignment(docId)?.agentName, 'Test Agent');
    // 2. the user comments on a cell: a draft compose box appears under the cell
    const cell = notebook.getCells().find((c) => c.document.getText().includes('fig-stage-time'))!;
    const cellId = a.cellIdOf(cell)!;
    const realOutputs = cell.outputs.length;
    const waiting = call(client, 'wait_for_comments', { timeoutMs: 20000 });
    await sleep(300);
    const draftId = await a.comments.startDraft(cell, 'cell');
    await waitFor(() => a.comments.threadOutputsOf(cell).some((o) => o.kind === 'draft'), 5000, 50, 'draft output');
    const packet0 = await a.comments.submitDraft(draftId, 'Make the bars horizontal.');
    assert.ok(packet0);
    const batch = (await waiting).json;
    assert.equal(batch.stopped, false);
    assert.equal(batch.assigned, true);
    assert.equal(batch.comments.length, 1);
    const requestId = batch.comments[0].requestId;
    assert.equal(requestId, packet0!.requestId);
    assert.equal(batch.comments[0].cellId, cellId);
    assert.equal(batch.comments[0].anchor, 'cell');
    assert.equal(batch.comments[0].followUp, false);
    // the wait returns full packets: everything needed to edit without a read
    assert.equal(batch.comments[0].version, batch.notebook.version, 'packet carries the content version');
    assert.equal(batch.comments[0].attachments.find((x: any) => x.kind === 'cell').sourceHash, hashText(cell.document.getText()));
    assert.equal(batch.comments[0].messages.filter((m: any) => m.from === 'user').length, 1);
    assert.equal(batch.map.cellCount, notebook.cellCount, 'a notebook map rides along with comments');
    assert.equal(batch.map.cells.find((c: any) => c.cellId === cellId).label, 'fig-stage-time');
    assert.equal(a.requests.get(requestId)!.status, 'delivered');
    assert.equal(a.requests.get(requestId)!.deliveredTo, 'Test Agent');
    const threadOut = () => a.comments.threadOutputsOf(cell).find((o) => o.kind === 'thread' && o.requestId === requestId) as any;
    await waitFor(() => threadOut()?.status === 'delivered', 5000, 50, 'thread output shows delivered');
    assert.equal(threadOut().messages.filter((m: any) => m.from === 'user').length, 1);
    assert.equal(cell.outputs.length, realOutputs + 1, 'the thread is one extra transient output');
    assert.ok(cell.executionSummary?.executionOrder !== undefined, 'execution summary preserved');
    // 3. agent progress and reply land in the thread
    await call(client, 'update_request', { requestId, status: 'working', message: 'Flipping the axes.' });
    await waitFor(() => threadOut()?.status === 'working', 5000, 50, 'working');
    assert.equal(threadOut().messages.filter((m: any) => m.from === 'agent').length, 1);
    assert.equal(threadOut().agentName, 'Test Agent');
    await call(client, 'resolve_request', { requestId, summary: 'Done: horizontal bars.', linkedCellIds: [cellId] });
    await waitFor(() => threadOut()?.status === 'completed', 5000, 50, 'resolved');
    // 4. the user replies in the same thread → comes back as a follow-up
    const waiting2 = call(client, 'wait_for_comments', { timeoutMs: 20000 });
    await sleep(300);
    a.comments.reply(requestId, 'Also add a legend.');
    const batch2 = (await waiting2).json;
    assert.equal(batch2.comments.length, 1);
    assert.equal(batch2.comments[0].requestId, requestId);
    assert.equal(batch2.comments[0].followUp, true);
    assert.equal(batch2.comments[0].latestUserMessage, 'Also add a legend.');
    assert.equal(batch2.comments[0].messages.filter((m: any) => m.from === 'user').length, 2, 'the follow-up packet carries the whole thread');
    const packet = (await call(client, 'get_request', { requestId })).json;
    assert.equal(packet.messages.filter((m: any) => m.from === 'user').length, 2);
    await call(client, 'resolve_request', { requestId, summary: 'Legend added.' });
    await waitFor(() => threadOut()?.status === 'completed', 5000, 50, 'resolved again');
    // 5. cell indicator dots and notebook info
    const counts = a.comments.countsForCell(notebook, cellId);
    assert.ok(counts.resolved >= 1, 'the resolved thread counts as a hollow dot');
    assert.equal(counts.pending, 0);
    const info = (await call(client, 'list_open_notebooks')).json[0];
    assert.equal(info.assignment.agentName, 'Test Agent');
    // 6. release → a pending wait returns stopped
    const waiting3 = call(client, 'wait_for_comments', { timeoutMs: 20000 });
    await sleep(300);
    await vscode.commands.executeCommand('qmdNotebook.releaseAgent');
    const batch3 = (await waiting3).json;
    assert.equal(batch3.stopped, true);
    assert.equal(a.requests.assignment(docId), undefined);
    // 7. a comment with no agent watching stays queued; re-running the cell keeps the thread
    const d2 = await a.comments.startDraft(notebook.cellAt(1), 'cell');
    await a.comments.submitDraft(d2, 'Nobody home?');
    const queued = a.requests.list('queued', docId);
    assert.equal(queued.length, 1);
    await call(client, 'execute_cell', { cellId: a.cellIdOf(notebook.cellAt(1))!, timeoutMs: 30000 });
    await waitFor(() => a.comments.threadOutputsOf(notebook.cellAt(1)).length === 1, 5000, 100, 'thread restored after a run');
    a.comments.deleteThread(queued[0]!.requestId);
    await waitFor(() => a.comments.threadOutputsOf(notebook.cellAt(1)).length === 0, 5000, 100, 'thread removed');
    assert.ok(!fs.readFileSync(uri.fsPath, 'utf8').includes('horizontal'), 'comments never reach the file');
  });

  it('handles a comment in two calls: edit with requestId/note/execute, then resolve', async () => {
    const a = await api();
    const docId = (await call(client, 'list_open_notebooks')).json[0].documentId;
    await call(client, 'assign_notebook', { notebook: 'bridge.qmd', agentName: 'Two-Call Agent' });
    const cell = notebook.getCells().find((c) => c.kind === vscode.NotebookCellKind.Code && !c.document.getText().includes('fig-stage-time'))!;
    const cellId = a.cellIdOf(cell)!;
    const original = cell.document.getText();
    // the user edits the cell after commenting: the delivered packet must carry the fresh hash
    const draftId = await a.comments.startDraft(cell, 'cell');
    await a.comments.submitDraft(draftId, 'Print a greeting instead.');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(cell.document.uri, cell.document.validateRange(new vscode.Range(0, 0, cell.document.lineCount, 0)), original + '\n# user tweak');
    await vscode.workspace.applyEdit(edit);
    const batch = (await call(client, 'wait_for_comments', { timeoutMs: 5000 })).json;
    assert.equal(batch.comments.length, 1);
    const packet = batch.comments[0];
    const attached = packet.attachments.find((x: any) => x.kind === 'cell');
    assert.equal(attached.changedSinceComment, true);
    assert.equal(attached.sourceHash, hashText(cell.document.getText()));
    assert.ok(attached.source.endsWith('# user tweak'));
    // call 1: edit + run, linked to the comment with a plan
    const r = await call(client, 'replace_cell_source', {
      cellId,
      expectedSourceHash: attached.sourceHash,
      source: 'print("two calls")',
      requestId: packet.requestId,
      note: 'Rewriting the cell to print the greeting.',
      execute: true,
      timeoutMs: 30000,
    });
    assert.equal(r.raw.isError, undefined, JSON.stringify(r.json));
    assert.equal(r.json.execution.success, true, JSON.stringify(r.json.execution));
    assert.ok(JSON.stringify(r.json.execution.outputs).includes('two calls'), 'the edit result carries the run outputs');
    assert.equal(cell.document.getText(), 'print("two calls")');
    const stored = a.requests.get(packet.requestId)!;
    assert.equal(stored.status, 'working', 'requestId on the edit marks the comment working');
    assert.ok(stored.messages.some((m) => m.from === 'agent' && m.text.includes('Rewriting the cell')), 'the note is in the thread');
    assert.deepEqual(stored.linkedCellIds, [cellId]);
    const threadOut = () => a.comments.threadOutputsOf(cell).find((o) => o.kind === 'thread' && o.requestId === packet.requestId) as any;
    await waitFor(() => threadOut()?.status === 'working', 5000, 50, 'thread shows working');
    // call 2: resolve
    await call(client, 'resolve_request', { requestId: packet.requestId, summary: 'Prints the greeting now.' });
    assert.equal(a.requests.get(packet.requestId)!.status, 'completed');
    // agent-facing reads never show the comment thread as an output
    const readBack = (await call(client, 'read_cell', { cellId })).json.cell;
    assert.ok(readBack.outputs.every((o: any) => o.items.every((i: any) => i.mime !== 'application/x-qmd-comment+json')));
    assert.ok(readBack.outputs.length >= 1);
    // delta reads and the outline
    const outline = (await call(client, 'read_notebook', { outline: true })).json;
    assert.equal(outline.map.cells.length, notebook.cellCount);
    assert.equal(outline.cells, undefined);
    const known: Record<string, string> = {};
    for (const c of outline.map.cells) known[c.cellId] = c.sourceHash;
    const delta = (await call(client, 'read_notebook', { knownHashes: known, includeOutputs: false })).json;
    assert.ok(delta.cells.every((c: any) => c.unchanged === true && c.source === ''), 'nothing changed → no sources');
    delete known[cellId];
    const delta2 = (await call(client, 'read_notebook', { knownHashes: known, includeOutputs: false })).json;
    assert.equal(delta2.cells.filter((c: any) => !c.unchanged).length, 1);
    assert.equal(delta2.cells.find((c: any) => c.cellId === cellId).source, 'print("two calls")');
    // a wait the client abandons (its own timeout → MCP cancellation) must not swallow later comments
    assert.equal(a.requests.waiterCount(), 0);
    await assert.rejects(client.callTool({ name: 'wait_for_comments', arguments: {} }, undefined, { timeout: 1500 }));
    await waitFor(() => a.requests.waiterCount() === 0, 5000, 50, 'cancelled wait removed on the bridge');
    const d2 = await a.comments.startDraft(cell, 'cell');
    const late = await a.comments.submitDraft(d2, 'Still here?');
    await sleep(300);
    assert.equal(a.requests.get(late!.requestId)!.status, 'queued', 'no phantom delivery after a cancelled wait');
    a.comments.deleteThread(late!.requestId);
    a.comments.deleteThread(packet.requestId);
    await vscode.commands.executeCommand('qmdNotebook.releaseAgent');
    assert.equal(a.requests.assignment(docId), undefined);
    // restore the cell for the remaining tests
    const restore = new vscode.WorkspaceEdit();
    restore.replace(cell.document.uri, cell.document.validateRange(new vscode.Range(0, 0, cell.document.lineCount, 0)), original);
    await vscode.workspace.applyEdit(restore);
  });

  it('edits inside a cell with exact text pairs, like a file edit', async () => {
    const a = await api();
    const cell = notebook.getCells().find((c) => c.kind === vscode.NotebookCellKind.Code && !c.document.getText().includes('fig-stage-time'))!;
    const cellId = a.cellIdOf(cell)!;
    const original = cell.document.getText();
    const SRC = 'x = 1\ny = 2\nprint(x, y)\nprint(x, y)';
    await replaceCellText(cell, SRC);
    const before = (await call(client, 'read_cell', { cellId })).json.cell;
    // failures reject before anything is written and explain themselves
    const missing = await call(client, 'edit_cell_text', { cellId, expectedSourceHash: before.sourceHash, edits: [{ oldText: 'z = 3', newText: 'z = 4' }] });
    assert.equal(missing.raw.isError, true);
    assert.equal(missing.json.code, -32602, JSON.stringify(missing.json));
    assert.equal(missing.json.data.reason, 'not-found');
    assert.ok(missing.json.data.currentSource.includes('x = 1'), 'the current source comes back for a fix-up');
    const ambiguous = await call(client, 'edit_cell_text', { cellId, expectedSourceHash: before.sourceHash, edits: [{ oldText: 'print(x, y)', newText: 'print(y, x)' }] });
    assert.equal(ambiguous.json.data.reason, 'ambiguous');
    assert.deepEqual(ambiguous.json.data.lines, [3, 4]);
    const spaced = await call(client, 'edit_cell_text', { cellId, expectedSourceHash: before.sourceHash, edits: [{ oldText: 'x  =  1', newText: 'x = 10' }] });
    assert.equal(spaced.json.data.reason, 'not-found');
    assert.match(spaced.json.data.hint, /whitespace/);
    assert.deepEqual(spaced.json.data.candidateLines, [1]);
    assert.equal(cell.document.getText(), SRC, 'nothing applied on failure');
    // a good edit: two replacements, one of them replaceAll, run right away
    const ok = await call(client, 'edit_cell_text', {
      cellId,
      expectedSourceHash: before.sourceHash,
      edits: [
        { oldText: 'y = 2', newText: 'y = 20' },
        { oldText: 'print(x, y)', newText: 'print(x + y)', replaceAll: true },
      ],
      execute: true,
      timeoutMs: 30000,
    });
    assert.equal(ok.raw.isError, undefined, JSON.stringify(ok.json));
    assert.equal(cell.document.getText(), 'x = 1\ny = 20\nprint(x + y)\nprint(x + y)');
    assert.equal(ok.json.sourceHash, hashText(cell.document.getText()));
    assert.deepEqual(ok.json.applied.map((r: any) => r.occurrences), [1, 2]);
    assert.equal(ok.json.execution.success, true, JSON.stringify(ok.json.execution));
    assert.ok(JSON.stringify(ok.json.execution.outputs).includes('21'), 'ran with the edited source');
    // the hash precondition still guards the cell
    const stale = await call(client, 'edit_cell_text', { cellId, expectedSourceHash: before.sourceHash, edits: [{ oldText: 'x = 1', newText: 'x = 2' }] });
    assert.equal(stale.json.code, -32003);
    // the same op inside a batch; a bad op rejects the whole batch untouched
    const badBatch = await call(client, 'apply_cell_edits', { edits: [{ op: 'edit', cellId, expectedSourceHash: ok.json.sourceHash, edits: [{ oldText: 'x = 1', newText: 'x = 100' }] }, { op: 'edit', cellId, expectedSourceHash: ok.json.sourceHash, edits: [{ oldText: 'nope', newText: '' }] }] });
    assert.equal(badBatch.raw.isError, true);
    assert.ok(cell.document.getText().startsWith('x = 1\n'), 'batch rejected before writing');
    const batch = await call(client, 'apply_cell_edits', { edits: [{ op: 'edit', cellId, expectedSourceHash: ok.json.sourceHash, edits: [{ oldText: 'x = 1', newText: 'x = 100' }] }] });
    assert.equal(batch.raw.isError, undefined, JSON.stringify(batch.json));
    assert.ok(cell.document.getText().startsWith('x = 100\n'));
    // one undo step reverts the whole targeted edit
    await replaceCellText(cell, original);
  });

  it('delivers images pasted into a comment to the agent as image content', async () => {
    const a = await api();
    await call(client, 'assign_notebook', { notebook: 'bridge.qmd', agentName: 'Vision Agent' });
    const cell = notebook.getCells().find((c) => c.kind === vscode.NotebookCellKind.Code && !c.document.getText().includes('fig-stage-time'))!;
    const green = solidPng(8, 8, [10, 200, 10]).toString('base64');
    const draftId = await a.comments.startDraft(cell, 'cell');
    const imageId = await a.comments.attachImage({ draftId }, { name: 'green.png', mime: 'image/png', width: 8, height: 8, base64: green, thumbnail: `data:image/png;base64,${green}` });
    await waitFor(() => (a.comments.threadOutputsOf(cell).find((o) => o.kind === 'draft') as any)?.images?.length === 1, 5000, 50, 'the draft shows the thumbnail');
    await assert.rejects(a.comments.attachImage({ draftId }, { name: 'x.svg', mime: 'image/svg+xml', width: 1, height: 1, base64: green }), /unsupported image type/);
    const waiting = call(client, 'wait_for_comments', { timeoutMs: 10000 });
    await sleep(300);
    const packet0 = (await a.comments.submitDraft(draftId, 'What colour is this?'))!;
    const res = await waiting;
    assert.equal(res.raw.isError, undefined, JSON.stringify(res.json));
    const images = (res.raw.content as any[]).filter((c) => c.type === 'image');
    assert.equal(images.length, 1, 'the image rides along as MCP image content');
    assert.equal(images[0].mimeType, 'image/png');
    assert.equal(images[0].data, green);
    const comment = res.json.comments[0];
    const att = comment.attachments.find((x: any) => x.kind === 'image');
    assert.equal(att.imageId, imageId);
    assert.equal(att.name, 'green.png');
    assert.ok(fs.existsSync(att.filePath), 'bytes live in a private file');
    assert.equal(fs.statSync(att.filePath).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(res.json).includes('data:image'), 'thumbnails never reach the agent');
    assert.equal(comment.inlineImages, undefined, 'inline bytes are lifted out of the JSON');
    assert.deepEqual(comment.inlineImagesDelivered, [imageId]);
    // refetch on demand
    const again = await call(client, 'read_attachment', { requestId: packet0.requestId, imageId });
    assert.equal((again.raw.content as any[]).filter((c) => c.type === 'image').length, 1);
    assert.equal(again.json.name, 'green.png');
    assert.equal(again.json.width, 8);
    // a client that cannot display image content (Codex) gets file paths and an instruction instead of bytes
    const codexLike = await startClient(workspaceDir(), 'codex-mcp-client');
    try {
      const viaPath = await call(codexLike, 'get_request', { requestId: packet0.requestId });
      assert.equal((viaPath.raw.content as any[]).filter((c) => c.type === 'image').length, 0, 'no image blocks for a client that ignores them');
      assert.equal(viaPath.json.attachedImages[0].filePath, att.filePath);
      assert.match(viaPath.json.attachedImagesHint, /view_image/);
      assert.ok(!JSON.stringify(viaPath.json).includes(green), 'no base64 in the JSON either');
      const pathOnly = await call(codexLike, 'read_attachment', { requestId: packet0.requestId, imageId });
      assert.equal((pathOnly.raw.content as any[]).filter((c) => c.type === 'image').length, 0);
      assert.equal(pathOnly.json.base64, null);
      assert.equal(pathOnly.json.filePath, att.filePath);
      assert.match(pathOnly.json.viewHint, /view_image/);
    } finally {
      await codexLike.close();
    }
    // the thread shows the thumbnail; a reply can carry another image, only the new one is inlined
    const threadOut = () => a.comments.threadOutputsOf(cell).find((o) => o.kind === 'thread' && o.requestId === packet0.requestId) as any;
    await waitFor(() => threadOut()?.messages?.[0]?.images?.[0]?.thumbnail?.startsWith('data:image/png'), 5000, 50, 'thread thumbnail');
    await call(client, 'resolve_request', { requestId: packet0.requestId, summary: 'green' });
    const waiting2 = call(client, 'wait_for_comments', { timeoutMs: 10000 });
    await sleep(300);
    const blue = solidPng(8, 8, [10, 10, 200]).toString('base64');
    await a.comments.attachImage({ requestId: packet0.requestId }, { name: 'blue.png', mime: 'image/png', width: 8, height: 8, base64: blue });
    await waitFor(() => threadOut()?.pendingImages?.length === 1, 5000, 50, 'pending reply image shown');
    a.comments.reply(packet0.requestId, 'And this one?');
    const res2 = await waiting2;
    const images2 = (res2.raw.content as any[]).filter((c) => c.type === 'image');
    assert.equal(images2.length, 1, "only the new message's image is inlined");
    assert.equal(images2[0].data, blue);
    assert.equal(res2.json.comments[0].attachments.filter((x: any) => x.kind === 'image').length, 2);
    await waitFor(() => threadOut()?.pendingImages === undefined && threadOut()?.messages?.filter((m: any) => m.images).length === 2, 5000, 50, 'reply image moved into the thread');
    // deleting the thread removes the private files
    const files: string[] = res2.json.comments[0].attachments.filter((x: any) => x.kind === 'image').map((x: any) => x.filePath);
    a.comments.deleteThread(packet0.requestId);
    await waitFor(() => files.every((f) => !fs.existsSync(f)), 5000, 50, 'image files removed with the thread');
    await vscode.commands.executeCommand('qmdNotebook.releaseAgent');
  });

  it('rejects unauthenticated connections and the wrong workspace', async () => {
    const a = await api();
    const bridge = a.bridge()!;
    const record = JSON.parse(fs.readFileSync(bridge.discoveryPath, 'utf8'));
    assert.equal(fs.statSync(bridge.discoveryPath).mode & 0o777, 0o600);
    const reply = await new Promise<string>((resolve) => {
      const s = net.connect(record.socketPath, () => {
        s.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { token: 'wrong', protocolVersion: 1, client: 'x' } }) + '\n');
      });
      let buf = '';
      s.on('data', (d) => (buf += d.toString()));
      s.on('close', () => resolve(buf));
      s.on('error', () => resolve(buf));
    });
    assert.match(reply, /-32001/);
    const noAuth = await new Promise<string>((resolve) => {
      const s = net.connect(record.socketPath, () => {
        s.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'listOpenNotebooks' }) + '\n');
      });
      let buf = '';
      s.on('data', (d) => (buf += d.toString()));
      s.on('close', () => resolve(buf));
      s.on('error', () => resolve(buf));
    });
    assert.match(noAuth, /-32001/);
    const other = await startClient('/usr');
    try {
      const r = await call(other, 'list_open_notebooks');
      assert.equal(r.raw.isError, true);
      assert.match(String(r.json), /No QMD Notebook bridge is active for \/usr/);
    } finally {
      await other.close();
    }
  });

  it('doctor reports a healthy bridge', async () => {
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(process.execPath, [MCP_CLI, 'doctor', '--workspace', workspaceDir()], { timeout: 30000 }, (err, stdout) => resolve({ code: err ? (err as any).code ?? 1 : 0, stdout: stdout.toString() }));
    });
    assert.equal(out.code, 0, out.stdout);
    assert.match(out.stdout, /connected and authenticated/);
    assert.match(out.stdout, /bridge\.qmd/);
    assert.ok(!out.stdout.includes(JSON.parse(fs.readFileSync((await api()).bridge()!.discoveryPath, 'utf8')).token), 'token never printed');
  });
});
