/**
 * Bridge method implementations: everything an agent can do to the live notebook and kernel.
 * All mutations go through VS Code WorkspaceEdit/NotebookEdit with optimistic concurrency checks.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  BridgeError,
  PROTOCOL_VERSION,
  RpcErrorCodes,
  hashBytes,
  hashText,
  parseOutputId,
  schemaFor,
  type ActiveContext,
  type BridgeStatus,
  type CellInfo,
  type CommentBatch,
  type ExecutionResult,
  type NotebookInfo,
  type NotebookMap,
  type NotebookMapCell,
  type RequestPacket,
  type ShapeName,
  TextEditError,
  applyTextEdits,
  minimalSpan,
} from '@qmd-notebook/shared';
import { z } from 'zod';
import type { SessionRegistry } from '../execution/sessionRegistry';
import { cellRecord } from '../notebook/serializer';
import { cellIdOf, findCell, freshRecord } from '../notebook/identity';
import { NOTEBOOK_TYPE, getSetting, isQmdNotebook } from '../util/config';
import type { Logger } from '../util/logger';
import type { RequestStore } from './requestStore';
import { cellInfo, currentCellSelection, isTextMime, outputHash, rangeInfo, realOutputs, sourceLineMap, stripAnsi, summarizeOutputItem, summarizeOutputs } from './contextCapture';
import type { BridgeClient } from './bridgeServer';
import { ensurePrivateDir, runtimeDir } from './bridgeServer';

export interface NotebookServiceDeps {
  registry: SessionRegistry;
  requests: RequestStore;
  /** Resolve an image attached to a comment (bytes live in a private file). */
  imageAttachment?: (requestId: string, imageId: string) => { imageId: string; name: string; mime: string; bytes: number; width: number; height: number; filePath: string } | undefined;
  logger: Logger;
  extensionVersion: string;
  instanceId: () => string;
  connectedClients: () => number;
  onAgentTouchedCell: (cellId: string, label: string) => void;
}

export function documentIdFor(nb: vscode.NotebookDocument): string {
  return `qmddoc_${hashText(nb.uri.toString()).slice(0, 12)}`;
}

/**
 * Content version: increments only when cell text, kind, order or count changes — not when
 * outputs, execution summaries or metadata change. Agents use it as the edit precondition, so an
 * agent's own progress note (which rewrites comment outputs) must not invalidate its read.
 */
const contentVersions = new Map<string, number>();
export function contentVersion(nb: vscode.NotebookDocument): number {
  return contentVersions.get(nb.uri.toString()) ?? 0;
}
export function trackContentVersions(): vscode.Disposable {
  return vscode.workspace.onDidChangeNotebookDocument((e) => {
    if (!isQmdNotebook(e.notebook)) return;
    const structural = e.contentChanges.length > 0;
    const textual = e.cellChanges.some((c) => c.document !== undefined);
    if (structural || textual) {
      const key = e.notebook.uri.toString();
      contentVersions.set(key, (contentVersions.get(key) ?? 0) + 1);
    }
  });
}

function validate<K extends ShapeName>(name: K, params: unknown): z.infer<ReturnType<typeof schemaFor<K>>> {
  const result = schemaFor(name).safeParse(params ?? {});
  if (!result.success) {
    throw BridgeError.invalidParams(`invalid params for ${name}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return result.data as z.infer<ReturnType<typeof schemaFor<K>>>;
}

export class NotebookService {
  constructor(private readonly deps: NotebookServiceDeps) {}

  // ------------------------------------------------------------------ dispatch
  async handle(method: string, params: unknown, client: BridgeClient): Promise<unknown> {
    this.deps.logger.debug(`bridge: ${client.name}#${client.id} → ${method}`);
    switch (method) {
      case 'hello':
        return this.hello(validate('hello', params));
      case 'status':
        return this.status();
      case 'listOpenNotebooks':
        return this.listOpenNotebooks();
      case 'getActiveContext':
        return this.getActiveContext();
      case 'readNotebook':
        return this.readNotebook(validate('readNotebook', params));
      case 'readCell':
        return this.readCell(validate('readCell', params));
      case 'readOutput':
        return this.readOutput(validate('readOutput', params));
      case 'readAttachment':
        return this.readAttachment(validate('readAttachment', params));
      case 'replaceCellSource':
        return this.replaceCellSource(validate('replaceCellSource', params), client);
      case 'editCellText':
        return this.editCellText(validate('editCellText', params), client);
      case 'insertCell':
        return this.insertCell(validate('insertCell', params), client);
      case 'deleteCell':
        return this.deleteCell(validate('deleteCell', params), client);
      case 'moveCell':
        return this.moveCell(validate('moveCell', params), client);
      case 'applyCellEdits':
        return this.applyCellEdits(validate('applyCellEdits', params), client);
      case 'executeCell':
        return this.executeCell(validate('executeCell', params));
      case 'executeCells':
        return this.executeCells(validate('executeCells', params));
      case 'executeScratch':
        return this.executeScratch(validate('executeScratch', params));
      case 'listVariables': {
        const p = validate('listVariables', params);
        this.requireTrust();
        return this.deps.registry.listVariables(this.resolveNotebook(p.documentId), p.maxCount ?? 200);
      }
      case 'summarizeVariable': {
        const p = validate('summarizeVariable', params);
        this.requireTrust();
        return this.deps.registry.summarizeVariable(this.resolveNotebook(p.documentId), p.name, p.maxRows ?? 10, p.maxChars ?? 4000);
      }
      case 'interruptKernel': {
        const p = validate('interruptKernel', params);
        await this.deps.registry.interrupt(this.resolveNotebook(p.documentId));
        return { ok: true };
      }
      case 'restartKernel': {
        const p = validate('restartKernel', params);
        this.requireTrust();
        await this.deps.registry.restart(this.resolveNotebook(p.documentId));
        return { ok: true, kernel: this.deps.registry.kernelInfo(this.resolveNotebook(p.documentId)) };
      }
      case 'assignNotebook':
        return this.assignNotebook(validate('assignNotebook', params), client);
      case 'releaseNotebook': {
        const p = validate('releaseNotebook', params);
        const nb = this.resolveNotebook(p.documentId);
        this.deps.requests.release(documentIdFor(nb), `released by ${client.name}`);
        return { ok: true };
      }
      case 'waitForComments':
        return this.waitForComments(validate('waitForComments', params), client);
      case 'getRequest': {
        const p = validate('getRequest', params);
        const r = this.deps.requests.get(p.requestId);
        if (!r) throw BridgeError.notFound(`request ${p.requestId}`);
        if (r.status === 'queued') this.deps.requests.markDelivered(r.requestId, this.agentNameFor(client, r.documentId));
        return this.agentView(r);
      }
      case 'listRequests': {
        const p = validate('listRequests', params);
        return this.deps.requests.list(p.status === 'all' ? 'all' : 'pending').map((r) => this.deps.requests.summary(r)).reverse();
      }
      case 'updateRequest': {
        const p = validate('updateRequest', params);
        if (!this.deps.requests.get(p.requestId)) throw BridgeError.notFound(`request ${p.requestId}`);
        const r = this.deps.requests.update(p.requestId, { status: p.status, message: p.message, from: 'agent' });
        return { requestId: r.requestId, status: r.status };
      }
      case 'resolveRequest': {
        const p = validate('resolveRequest', params);
        if (!this.deps.requests.get(p.requestId)) throw BridgeError.notFound(`request ${p.requestId}`);
        const r = this.deps.requests.resolve(p.requestId, { summary: p.summary, linkedCellIds: p.linkedCellIds, status: p.status });
        return { requestId: r.requestId, status: r.status };
      }
      case 'waitForRequest': {
        const p = validate('waitForRequest', params);
        const r = await this.deps.requests.waitForRequests(null, p.timeoutMs ?? 60000, client.id);
        if (r === 'stopped' || r.length === 0) return null;
        this.deps.requests.markDelivered(r[0]!.requestId, this.agentNameFor(client, r[0]!.documentId));
        return this.deps.requests.summary(r[0]!);
      }
      case 'cancelWait': {
        validate('cancelWait', params);
        return { ok: true, cancelled: this.deps.requests.cancelWaiters(client.id) };
      }
      default:
        throw new BridgeError(RpcErrorCodes.MethodNotFound, `unknown method ${method}`);
    }
  }

  // ------------------------------------------------------------------ helpers
  private requireTrust(): void {
    if (!vscode.workspace.isTrusted) throw BridgeError.untrusted();
  }

  private openNotebooks(): vscode.NotebookDocument[] {
    return vscode.workspace.notebookDocuments.filter((nb) => isQmdNotebook(nb) && !nb.isClosed);
  }

  private activeNotebook(): vscode.NotebookDocument | undefined {
    const active = vscode.window.activeNotebookEditor?.notebook;
    if (active && isQmdNotebook(active)) return active;
    const visible = vscode.window.visibleNotebookEditors.map((e) => e.notebook).find((nb) => isQmdNotebook(nb));
    if (visible) return visible;
    const open = this.openNotebooks();
    return open.length === 1 ? open[0] : undefined;
  }

  resolveNotebook(documentId?: string): vscode.NotebookDocument {
    if (documentId) {
      const nb = this.openNotebooks().find((n) => documentIdFor(n) === documentId);
      if (!nb) throw BridgeError.notFound(`notebook ${documentId}`, { openNotebooks: this.openNotebooks().map((n) => documentIdFor(n)) });
      return nb;
    }
    const nb = this.activeNotebook();
    if (!nb) {
      const open = this.openNotebooks();
      throw BridgeError.notFound('active QMD notebook', {
        hint: open.length ? 'Several QMD notebooks are open and none is active; pass documentId.' : 'No .qmd is open as a QMD Notebook in this VS Code window.',
        openNotebooks: open.map((n) => documentIdFor(n)),
      });
    }
    return nb;
  }

  private resolveCell(nb: vscode.NotebookDocument, cellId: string): vscode.NotebookCell {
    const cell = findCell(nb, cellId);
    if (!cell) throw BridgeError.notFound(`cell ${cellId}`, { documentId: documentIdFor(nb), version: contentVersion(nb), cellIds: nb.getCells().map((c) => cellIdOf(c)) });
    return cell;
  }

  notebookInfo(nb: vscode.NotebookDocument): NotebookInfo {
    const active = vscode.window.activeNotebookEditor?.notebook === nb;
    const docId = documentIdFor(nb);
    const a = this.deps.requests.assignment(docId);
    return {
      documentId: docId,
      uri: nb.uri.toString(),
      fsPath: nb.uri.fsPath,
      displayName: path.basename(nb.uri.fsPath),
      version: contentVersion(nb),
      isDirty: nb.isDirty,
      isActive: active,
      cellCount: nb.cellCount,
      kernel: this.deps.registry.kernelInfo(nb),
      assignment: a ? { agentName: a.agentName, clientId: a.clientId, since: a.since } : null,
      pendingComments: this.deps.requests.list('pending', docId).length,
    };
  }

  private agentNameFor(client: BridgeClient, documentId: string): string {
    const a = this.deps.requests.assignment(documentId);
    if (a && a.clientId === client.id) return a.agentName;
    return client.name.replace(/^qmd-notebook-mcp\/[^ ]*/, '').trim() || 'agent';
  }

  /** Resolve a notebook by documentId, file name / path suffix, or fall back to the active one. */
  private resolveNotebookByName(documentId: string | undefined, name: string | undefined): vscode.NotebookDocument {
    if (documentId) return this.resolveNotebook(documentId);
    if (name && name.trim()) {
      const needle = name.trim();
      const open = this.openNotebooks();
      const hit =
        open.find((nb) => documentIdFor(nb) === needle) ??
        open.find((nb) => path.basename(nb.uri.fsPath) === needle) ??
        open.find((nb) => nb.uri.fsPath.endsWith(needle.startsWith('/') ? needle : `/${needle}`)) ??
        open.find((nb) => path.basename(nb.uri.fsPath, '.qmd') === needle.replace(/\.qmd$/, ''));
      if (!hit) throw BridgeError.notFound(`notebook "${needle}"`, { openNotebooks: open.map((nb) => ({ documentId: documentIdFor(nb), displayName: path.basename(nb.uri.fsPath), fsPath: nb.uri.fsPath })) });
      return hit;
    }
    return this.resolveNotebook(undefined);
  }

  assignNotebook(p: { documentId?: string; notebook?: string; agentName: string }, client: BridgeClient) {
    const nb = this.resolveNotebookByName(p.documentId, p.notebook);
    const docId = documentIdFor(nb);
    const previous = this.deps.requests.assignment(docId);
    const a = this.deps.requests.assign(docId, client.id, p.agentName.trim() || client.name);
    this.deps.logger.info(`bridge: ${a.agentName} (client ${client.id}) is now watching ${path.basename(nb.uri.fsPath)}${previous ? ` (replacing ${previous.agentName})` : ''}`);
    const queued = this.deliver(nb, this.deps.requests.list('queued', docId), client);
    return {
      notebook: this.notebookInfo(nb),
      map: this.notebookMap(nb),
      agentName: a.agentName,
      replaced: previous ? previous.agentName : null,
      pendingComments: queued,
      hint: 'Loop on wait_for_comments (omit timeoutMs). Each comment is a full packet: edit with its version/sourceHash, pass requestId + note + execute: true to the edit call, then resolve_request.',
    };
  }

  /** One line per cell: ids, first lines, hashes and execution state, without sources. */
  notebookMap(nb: vscode.NotebookDocument): NotebookMap {
    const MAX_CELLS = 400;
    const cells: NotebookMapCell[] = [];
    const n = Math.min(nb.cellCount, MAX_CELLS);
    for (let i = 0; i < n; i++) {
      const cell = nb.cellAt(i);
      const text = cell.document.getText();
      const rec = cellRecord(cell);
      const lines = text.split('\n');
      const head = lines.map((l) => l.trim()).find((l) => l && !l.startsWith('#|')) ?? lines[0]?.trim() ?? '';
      const summary = cell.executionSummary;
      const entry: NotebookMapCell = {
        cellId: cellIdOf(cell) ?? `unassigned:${i}`,
        index: i,
        kind: cell.kind === vscode.NotebookCellKind.Code ? 'python' : 'markdown',
        head: head.slice(0, 80),
        lines: lines.length,
        sourceHash: hashText(text),
        outputCount: realOutputs(cell).length,
      };
      if (typeof rec?.options?.label === 'string') entry.label = rec.options.label;
      if (rec?.options?.eval === false) entry.eval = false;
      if (cell.kind === vscode.NotebookCellKind.Code) {
        entry.executionOrder = summary?.executionOrder ?? null;
        entry.executionSuccess = summary?.success ?? null;
        if (this.deps.registry.isRunning(cell)) entry.running = true;
      }
      cells.push(entry);
    }
    return { documentId: documentIdFor(nb), version: contentVersion(nb), cellCount: nb.cellCount, cells, truncated: nb.cellCount > MAX_CELLS };
  }

  /**
   * Hand packets to an agent: mark them delivered, stamp the current content version and refresh
   * attachment sources/hashes that changed since the comment was written, so the agent can edit
   * straight from the packet without a read.
   */
  private deliver(nb: vscode.NotebookDocument, packets: RequestPacket[], client: BridgeClient): RequestPacket[] {
    const agentName = this.agentNameFor(client, documentIdFor(nb));
    const version = contentVersion(nb);
    const maxChars = getSetting<number>('agent.maxTextBytes', 200000);
    for (const r of packets) {
      this.deps.requests.markDelivered(r.requestId, agentName);
      r.version = version;
      for (const a of r.attachments) {
        const cell = findCell(nb, a.cellId);
        if (!cell) continue;
        const text = cell.document.getText();
        const current = hashText(text);
        if (a.sourceHash && a.sourceHash !== current) {
          a.sourceHash = current;
          a.source = text.slice(0, a.kind === 'neighbor' ? 4000 : maxChars);
          a.changedSinceComment = true;
        }
      }
    }
    return packets.map((r) => this.agentView(r));
  }

  /**
   * The packet as an agent should see it: UI thumbnails stripped, and the images attached to the
   * message being delivered (the latest user message) inlined as bytes, bounded; larger ones are
   * listed in inlineImagesOmitted for read_attachment.
   */
  private agentView(r: RequestPacket): RequestPacket {
    const view: RequestPacket = { ...r, messages: r.messages.map((m) => (m.images ? { ...m, images: m.images.map(({ thumbnail: _t, ...rest }) => rest) } : m)) };
    const latestUser = [...r.messages].reverse().find((m) => m.from === 'user');
    const images = latestUser?.images ?? [];
    if (!images.length) return view;
    const maxOne = getSetting<number>('agent.maxImageBytes', 5000000);
    let budget = Math.max(maxOne, 8000000);
    const inline: NonNullable<RequestPacket['inlineImages']> = [];
    const omitted: string[] = [];
    for (const im of images) {
      const info = this.deps.imageAttachment?.(r.requestId, im.imageId);
      if (!info || !fs.existsSync(info.filePath) || info.bytes > maxOne || info.bytes > budget) {
        omitted.push(im.imageId);
        continue;
      }
      budget -= info.bytes;
      inline.push({ imageId: im.imageId, name: im.name, mime: im.mime, base64: fs.readFileSync(info.filePath).toString('base64'), filePath: info.filePath });
    }
    if (inline.length) view.inlineImages = inline;
    if (omitted.length) view.inlineImagesOmitted = omitted;
    return view;
  }

  readAttachment(p: { requestId: string; imageId: string; imageDelivery?: 'inline' | 'file' | 'both' }) {
    if (!this.deps.requests.get(p.requestId)) throw BridgeError.notFound(`request ${p.requestId}`);
    const info = this.deps.imageAttachment?.(p.requestId, p.imageId);
    if (!info || !fs.existsSync(info.filePath)) throw BridgeError.notFound(`image ${p.imageId} on request ${p.requestId}`);
    const delivery = p.imageDelivery ?? 'both';
    const tooBig = info.bytes > getSetting<number>('agent.maxImageBytes', 5000000);
    return {
      ...info,
      filePath: delivery === 'inline' ? null : info.filePath,
      base64: delivery !== 'file' && !tooBig ? fs.readFileSync(info.filePath).toString('base64') : null,
      tooBigForInline: tooBig,
    };
  }

  /** requestId/note on an edit or execute call: the comment becomes "working" with the note in its thread. */
  private linkRequest(p: { requestId?: string; note?: string }, cellIds: string[]): void {
    if (!p.requestId) return;
    if (!this.deps.requests.get(p.requestId)) throw BridgeError.notFound(`request ${p.requestId}`);
    this.deps.requests.linkWork(p.requestId, { note: p.note, cellIds });
  }

  async waitForComments(p: { documentId?: string; timeoutMs?: number }, client: BridgeClient): Promise<CommentBatch> {
    let docId = p.documentId;
    if (!docId) {
      const mine = this.deps.requests.allAssignments().find((a) => a.clientId === client.id);
      docId = mine?.documentId;
    }
    if (!docId) docId = documentIdFor(this.resolveNotebook(undefined));
    const nb = this.openNotebooks().find((n) => documentIdFor(n) === docId);
    if (!nb) return { notebook: null, comments: [], assigned: false, stopped: true, reason: 'notebook is not open' };
    const result = await this.deps.requests.waitForRequests(docId, p.timeoutMs ?? 60000, client.id);
    if (result === 'stopped') {
      return { notebook: this.notebookInfo(nb), comments: [], assigned: false, stopped: true, reason: 'assignment released or notebook closed' };
    }
    if (nb.isClosed) return { notebook: null, comments: [], assigned: false, stopped: true, reason: 'notebook closed' };
    const assignment = this.deps.requests.assignment(docId);
    const comments = this.deliver(nb, result, client);
    return {
      notebook: this.notebookInfo(nb),
      ...(comments.length ? { map: this.notebookMap(nb) } : {}),
      comments,
      assigned: !!assignment && assignment.clientId === client.id,
      stopped: false,
    };
  }

  /**
   * The notebook content version is informational: it moves with every keystroke anywhere in the
   * notebook, so rejecting on it would block the agent whenever the user types in another cell.
   * Edits are guarded per cell (source hash, anchor ids) instead.
   */
  private noteVersion(nb: vscode.NotebookDocument, expected: number | undefined): void {
    const current = contentVersion(nb);
    if (expected !== undefined && current !== expected) this.deps.logger.debug(`bridge: notebook version moved ${expected} → ${current} since the agent's read (other cells changed); proceeding on cell preconditions`);
  }

  private checkHash(cell: vscode.NotebookCell, expected: string): void {
    const current = hashText(cell.document.getText());
    if (current !== expected) {
      throw BridgeError.conflict(`cell ${cellIdOf(cell)} changed since you read it (expected hash ${expected}, now ${current}); rebase your edit on currentSource and retry`, {
        cellId: cellIdOf(cell),
        currentSourceHash: current,
        currentSource: cell.document.getText().slice(0, getSetting<number>('agent.maxTextBytes', 200000)),
        currentVersion: contentVersion(cell.notebook),
      });
    }
  }

  private async apply(nb: vscode.NotebookDocument, edit: vscode.WorkspaceEdit, what: string): Promise<void> {
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) throw new BridgeError(RpcErrorCodes.Internal, `VS Code rejected the ${what} edit`);
    void nb;
  }

  // ------------------------------------------------------------------ discovery / context
  private hello(p: { client: string; workspace?: string }) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this.deps.instanceId(),
      extensionVersion: this.deps.extensionVersion,
      vscodeVersion: vscode.version,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      notebookType: NOTEBOOK_TYPE,
      client: p.client,
    };
  }

  status(): BridgeStatus {
    const notebooks = this.openNotebooks().map((nb) => this.notebookInfo(nb));
    const active = this.activeNotebook();
    return {
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: this.deps.extensionVersion,
      vscodeVersion: vscode.version,
      remoteName: vscode.env.remoteName ?? null,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      workspaceTrusted: vscode.workspace.isTrusted,
      notebooks,
      activeNotebookId: active ? documentIdFor(active) : null,
      connectedClients: this.deps.connectedClients(),
      pendingRequests: this.deps.requests.list('pending').length,
      assignments: this.deps.requests.allAssignments().map((a) => ({
        documentId: a.documentId,
        displayName: notebooks.find((n) => n.documentId === a.documentId)?.displayName ?? a.documentId,
        agentName: a.agentName,
        since: a.since,
      })),
    };
  }

  listOpenNotebooks(): NotebookInfo[] {
    return this.openNotebooks().map((nb) => this.notebookInfo(nb));
  }

  getActiveContext(): ActiveContext {
    const nb = this.activeNotebook();
    const pending = this.deps.requests.list('pending').map((r) => this.deps.requests.summary(r));
    if (!nb) {
      return { notebook: null, selectedCellIds: [], activeCellId: null, selection: null, focusedOutputId: null, pendingRequests: pending, untrustedWorkspace: !vscode.workspace.isTrusted };
    }
    const editor = vscode.window.activeNotebookEditor?.notebook === nb ? vscode.window.activeNotebookEditor : vscode.window.visibleNotebookEditors.find((e) => e.notebook === nb);
    const selectedCellIds: string[] = [];
    let activeCellId: string | null = null;
    if (editor) {
      for (const range of editor.selections) {
        for (let i = range.start; i < range.end && i < nb.cellCount; i++) {
          const id = cellIdOf(nb.cellAt(i));
          if (id) selectedCellIds.push(id);
        }
      }
      const first = editor.selections[0];
      if (first && first.start < nb.cellCount) activeCellId = cellIdOf(nb.cellAt(first.start));
    }
    const sel = currentCellSelection(nb);
    const maxChars = getSetting<number>('agent.maxTextBytes', 200000);
    return {
      notebook: this.notebookInfo(nb),
      selectedCellIds,
      activeCellId,
      selection: sel ? { cellId: cellIdOf(sel.cell) ?? '', text: sel.text.slice(0, maxChars), range: rangeInfo(sel.range) } : null,
      focusedOutputId: null,
      pendingRequests: pending.filter((r) => r.uri === nb.uri.toString()),
      untrustedWorkspace: !vscode.workspace.isTrusted,
    };
  }

  // ------------------------------------------------------------------ reads
  readNotebook(p: { documentId?: string; startIndex?: number; endIndex?: number; includeOutputs?: boolean; maxBytes?: number; knownHashes?: Record<string, string>; outline?: boolean }) {
    const nb = this.resolveNotebook(p.documentId);
    if (p.outline) return { notebook: this.notebookInfo(nb), map: this.notebookMap(nb) };
    const maxBytes = p.maxBytes ?? getSetting<number>('agent.maxTextBytes', 200000);
    const lines = sourceLineMap(nb);
    const start = Math.max(0, p.startIndex ?? 0);
    const end = Math.min(nb.cellCount, p.endIndex ?? nb.cellCount);
    const cells: CellInfo[] = [];
    let budget = maxBytes;
    let truncated = false;
    for (let i = start; i < end; i++) {
      const cell = nb.cellAt(i);
      const info = cellInfo(cell, { includeOutputs: p.includeOutputs !== false, maxSourceChars: Math.max(0, budget), sourceLines: lines[i] ?? null, running: this.deps.registry.isRunning(cell) });
      if (p.knownHashes && p.knownHashes[info.cellId] === info.sourceHash) {
        // Delta read: the agent already holds this source.
        info.source = '';
        info.unchanged = true;
        delete info.truncated;
      }
      budget -= info.source.length;
      if (info.truncated) truncated = true;
      cells.push(info);
      if (budget <= 0 && i < end - 1) {
        truncated = true;
        cells.push(...[]);
        return { notebook: this.notebookInfo(nb), cells, truncated, nextIndex: i + 1, totalCells: nb.cellCount };
      }
    }
    return { notebook: this.notebookInfo(nb), cells, truncated, nextIndex: end < nb.cellCount ? end : null, totalCells: nb.cellCount };
  }

  readCell(p: { documentId?: string; cellId: string; includeOutputs?: boolean; maxBytes?: number }) {
    const nb = this.resolveNotebook(p.documentId);
    const cell = this.resolveCell(nb, p.cellId);
    const lines = sourceLineMap(nb);
    return { notebook: this.notebookInfo(nb), cell: cellInfo(cell, { includeOutputs: p.includeOutputs !== false, maxSourceChars: p.maxBytes ?? getSetting<number>('agent.maxTextBytes', 200000), sourceLines: lines[cell.index] ?? null, running: this.deps.registry.isRunning(cell) }) };
  }

  readOutput(p: { documentId?: string; cellId: string; outputId: string; preferredMime?: string; maxBytes?: number; imageDelivery?: 'inline' | 'file' | 'both' }) {
    const nb = this.resolveNotebook(p.documentId);
    const cell = this.resolveCell(nb, p.cellId);
    const parsed = parseOutputId(p.outputId);
    if (!parsed || parsed.cellId !== p.cellId) throw BridgeError.invalidParams(`malformed outputId ${p.outputId}`);
    const output = cell.outputs[parsed.index];
    if (!output) throw BridgeError.notFound(`output ${p.outputId}`, { outputs: summarizeOutputs(cell, p.cellId, 200) });
    if (outputHash(output).slice(0, 8) !== parsed.hash) {
      throw BridgeError.conflict(`output ${p.outputId} changed (the cell was re-executed); re-read the cell`, { outputs: summarizeOutputs(cell, p.cellId, 200) });
    }
    const maxText = p.maxBytes ?? getSetting<number>('agent.maxTextBytes', 200000);
    const maxImage = getSetting<number>('agent.maxImageBytes', 5000000);
    const items = output.items;
    const pick =
      (p.preferredMime && items.find((i) => i.mime === p.preferredMime)) ||
      items.find((i) => i.mime === 'image/png') ||
      items.find((i) => i.mime.startsWith('image/') && i.mime !== 'image/svg+xml') ||
      items.find((i) => i.mime === 'text/html') ||
      items.find((i) => isTextMime(i.mime)) ||
      items[0];
    if (!pick) throw BridgeError.notFound('output item');
    const alternatives = items.map((i) => ({ mime: i.mime, bytes: i.data.byteLength }));
    const base = {
      outputId: p.outputId,
      cellId: p.cellId,
      mime: pick.mime,
      bytes: pick.data.byteLength,
      alternatives,
      producingCell: { source: cell.document.getText().slice(0, 4000), executionOrder: cell.executionSummary?.executionOrder ?? null },
      textAlternative: items.filter((i) => i.mime === 'text/plain').map((i) => summarizeOutputItem(i, 2000).text)[0] ?? null,
      metadata: output.metadata ?? null,
    };
    if (pick.mime.startsWith('image/') && pick.mime !== 'image/svg+xml') {
      const delivery = p.imageDelivery ?? 'both';
      const tooBig = pick.data.byteLength > maxImage;
      const dims = pick.mime === 'image/png' ? pngDimensions(pick.data) : null;
      let filePath: string | null = null;
      if (delivery !== 'inline') {
        const dir = path.join(runtimeDir(), 'outputs');
        ensurePrivateDir(dir);
        const ext = pick.mime === 'image/png' ? 'png' : pick.mime === 'image/jpeg' ? 'jpg' : pick.mime.split('/')[1] ?? 'bin';
        filePath = path.join(dir, `${p.outputId.replace(/[^a-zA-Z0-9_.-]/g, '_')}.${ext}`);
        fs.writeFileSync(filePath, pick.data, { mode: 0o600 });
        pruneOutputDir(dir, 200);
      }
      return {
        ...base,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        filePath,
        base64: delivery !== 'file' && !tooBig ? Buffer.from(pick.data).toString('base64') : null,
        tooBigForInline: tooBig,
      };
    }
    const summary = summarizeOutputItem(pick, maxText);
    return { ...base, text: summary.text ?? Buffer.from(pick.data).toString('utf8').slice(0, maxText), truncated: !!summary.truncated };
  }

  // ------------------------------------------------------------------ edits
  private touched(cellId: string, label: string): void {
    this.deps.onAgentTouchedCell(cellId, label);
  }

  async replaceCellSource(p: { documentId?: string; cellId: string; expectedVersion?: number; expectedSourceHash: string; source: string; requestId?: string; note?: string; execute?: boolean; timeoutMs?: number }, client: BridgeClient) {
    this.requireTrust();
    const nb = this.resolveNotebook(p.documentId);
    this.noteVersion(nb, p.expectedVersion);
    const cell = this.resolveCell(nb, p.cellId);
    this.checkHash(cell, p.expectedSourceHash);
    const edit = new vscode.WorkspaceEdit();
    const doc = cell.document;
    const full = new vscode.Range(0, 0, doc.lineCount, 0);
    edit.replace(doc.uri, doc.validateRange(full), p.source);
    await this.apply(nb, edit, 'replace');
    this.touched(p.cellId, `edited by ${client.name}`);
    this.linkRequest(p, [p.cellId]);
    this.deps.logger.info(`bridge: ${client.name} replaced source of ${p.cellId}`);
    const result = { documentId: documentIdFor(nb), version: contentVersion(nb), cellId: p.cellId, sourceHash: hashText(cell.document.getText()) };
    if (!p.execute) return result;
    return { ...result, execution: await this.executeAfterEdit(nb, cell, p.timeoutMs) };
  }

  /**
   * Targeted edit: exact oldText → newText pairs (file-edit semantics) applied to the current
   * source, then written as the single smallest span that differs, so the rest of the cell, the
   * user's cursor elsewhere in it, and the undo stack stay untouched.
   */
  async editCellText(p: { documentId?: string; cellId: string; expectedSourceHash: string; edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>; requestId?: string; note?: string; execute?: boolean; timeoutMs?: number }, client: BridgeClient) {
    this.requireTrust();
    const nb = this.resolveNotebook(p.documentId);
    const cell = this.resolveCell(nb, p.cellId);
    this.checkHash(cell, p.expectedSourceHash);
    const doc = cell.document;
    const original = doc.getText();
    let outcome: ReturnType<typeof applyTextEdits>;
    try {
      outcome = applyTextEdits(original, p.edits);
    } catch (e) {
      if (!(e instanceof TextEditError)) throw e;
      throw BridgeError.invalidParams(`edit_cell_text on ${p.cellId}: ${e.message}; nothing was changed`, {
        reason: e.reason,
        editIndex: e.index,
        occurrences: e.occurrences,
        lines: e.lines,
        ...(e.hint ? { hint: e.hint, candidateLines: e.candidateLines } : {}),
        currentSource: original.slice(0, getSetting<number>('agent.maxTextBytes', 200000)),
        currentSourceHash: hashText(original),
      });
    }
    const span = minimalSpan(original, outcome.text);
    if (span.start === span.end && span.text === '') {
      return { documentId: documentIdFor(nb), version: contentVersion(nb), cellId: p.cellId, sourceHash: hashText(original), applied: outcome.applied, unchanged: true };
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end)), span.text);
    await this.apply(nb, edit, 'text edit');
    this.touched(p.cellId, `edited by ${client.name}`);
    this.linkRequest(p, [p.cellId]);
    this.deps.logger.info(`bridge: ${client.name} edited ${p.cellId} (${outcome.applied.length} replacement${outcome.applied.length === 1 ? '' : 's'})`);
    const result = { documentId: documentIdFor(nb), version: contentVersion(nb), cellId: p.cellId, sourceHash: hashText(cell.document.getText()), applied: outcome.applied };
    if (!p.execute) return result;
    return { ...result, execution: await this.executeAfterEdit(nb, cell, p.timeoutMs) };
  }

  /** `execute: true` on an edit: run the (python) cell and report like execute_cell would. */
  private async executeAfterEdit(nb: vscode.NotebookDocument, cell: vscode.NotebookCell, timeoutMs: number | undefined): Promise<ExecutionResult | { skipped: string }> {
    if (cell.kind !== vscode.NotebookCellKind.Code) return { skipped: 'markdown cells are not executed' };
    return this.runOne(nb, cell, timeoutMs ?? 45000, false);
  }

  private cellDataFor(kind: 'python' | 'markdown', source: string): vscode.NotebookCellData {
    const data = kind === 'python' ? new vscode.NotebookCellData(vscode.NotebookCellKind.Code, source, 'python') : new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, source, 'markdown');
    data.metadata = { qmd: freshRecord(kind) };
    return data;
  }

  async insertCell(p: { documentId?: string; anchorCellId?: string | null; position: 'above' | 'below'; kind: 'python' | 'markdown'; source: string; expectedVersion?: number; requestId?: string; note?: string; execute?: boolean; timeoutMs?: number }, client: BridgeClient) {
    this.requireTrust();
    const nb = this.resolveNotebook(p.documentId);
    this.noteVersion(nb, p.expectedVersion);
    let index: number;
    if (p.anchorCellId) {
      const anchor = this.resolveCell(nb, p.anchorCellId);
      index = p.position === 'above' ? anchor.index : anchor.index + 1;
    } else index = p.position === 'above' ? 0 : nb.cellCount;
    const data = this.cellDataFor(p.kind, p.source);
    const cellId = (data.metadata!.qmd as { id: string }).id;
    const edit = new vscode.WorkspaceEdit();
    edit.set(nb.uri, [vscode.NotebookEdit.insertCells(index, [data])]);
    await this.apply(nb, edit, 'insert');
    this.touched(cellId, `inserted by ${client.name}`);
    this.linkRequest(p, [cellId]);
    const result = { documentId: documentIdFor(nb), version: contentVersion(nb), cellId, index, sourceHash: hashText(p.source) };
    if (!p.execute) return result;
    const inserted = findCell(nb, cellId);
    if (!inserted) return { ...result, execution: { skipped: 'inserted cell not found after the edit' } };
    return { ...result, execution: await this.executeAfterEdit(nb, inserted, p.timeoutMs) };
  }

  async deleteCell(p: { documentId?: string; cellId: string; expectedVersion?: number; expectedSourceHash: string; requestId?: string; note?: string }, _client: BridgeClient) {
    this.requireTrust();
    const nb = this.resolveNotebook(p.documentId);
    this.noteVersion(nb, p.expectedVersion);
    const cell = this.resolveCell(nb, p.cellId);
    this.checkHash(cell, p.expectedSourceHash);
    const edit = new vscode.WorkspaceEdit();
    edit.set(nb.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cell.index, cell.index + 1))]);
    await this.apply(nb, edit, 'delete');
    this.linkRequest(p, []);
    return { documentId: documentIdFor(nb), version: contentVersion(nb) };
  }

  async moveCell(p: { documentId?: string; cellId: string; anchorCellId: string; position: 'above' | 'below'; expectedVersion?: number; requestId?: string; note?: string }, client: BridgeClient) {
    this.requireTrust();
    const nb = this.resolveNotebook(p.documentId);
    this.noteVersion(nb, p.expectedVersion);
    const cell = this.resolveCell(nb, p.cellId);
    const anchor = this.resolveCell(nb, p.anchorCellId);
    if (cell.index === anchor.index) throw BridgeError.invalidParams('cell and anchor are the same cell');
    const target = p.position === 'above' ? anchor.index : anchor.index + 1;
    const data = new vscode.NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId);
    data.metadata = cell.metadata;
    data.outputs = [...cell.outputs];
    data.executionSummary = cell.executionSummary;
    const edits: vscode.NotebookEdit[] = [];
    // Delete first, then insert at the adjusted index, in one undoable WorkspaceEdit.
    const insertIndex = target > cell.index ? target - 1 : target;
    edits.push(vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cell.index, cell.index + 1)));
    edits.push(vscode.NotebookEdit.insertCells(insertIndex, [data]));
    const edit = new vscode.WorkspaceEdit();
    edit.set(nb.uri, edits);
    await this.apply(nb, edit, 'move');
    this.touched(p.cellId, `moved by ${client.name}`);
    this.linkRequest(p, [p.cellId]);
    return { documentId: documentIdFor(nb), version: contentVersion(nb), cellId: p.cellId, index: insertIndex };
  }

  async applyCellEdits(p: { documentId?: string; expectedVersion?: number; edits: Array<any>; requestId?: string; note?: string; execute?: boolean; timeoutMs?: number }, client: BridgeClient) {
    this.requireTrust();
    const nb = this.resolveNotebook(p.documentId);
    this.noteVersion(nb, p.expectedVersion);
    // Validate all preconditions before touching anything.
    for (const e of p.edits) {
      if (e.op === 'replace' || e.op === 'delete' || e.op === 'edit') this.checkHash(this.resolveCell(nb, e.cellId), e.expectedSourceHash);
      if (e.op === 'edit') {
        // dry run so a bad oldText rejects the whole batch before anything is written
        try {
          applyTextEdits(this.resolveCell(nb, e.cellId).document.getText(), e.edits);
        } catch (err) {
          if (err instanceof TextEditError) throw BridgeError.invalidParams(`apply_cell_edits: edit op on ${e.cellId}: ${err.message}; nothing was changed`, { cellId: e.cellId, reason: err.reason, editIndex: err.index, lines: err.lines, hint: err.hint });
          throw err;
        }
      }
      if (e.op === 'move') {
        this.resolveCell(nb, e.cellId);
        this.resolveCell(nb, e.anchorCellId);
      }
      if (e.op === 'insert' && e.anchorCellId) this.resolveCell(nb, e.anchorCellId);
    }
    // Apply sequentially (each as its own WorkspaceEdit so indices stay valid); VS Code groups
    // rapid edits reasonably, and preconditions were all checked up front.
    const results: unknown[] = [];
    const touchedIds: string[] = [];
    for (const e of p.edits) {
      switch (e.op) {
        case 'replace': {
          const r = await this.replaceCellSource({ documentId: p.documentId, cellId: e.cellId, expectedSourceHash: e.expectedSourceHash, source: e.source }, client);
          touchedIds.push(r.cellId);
          results.push(r);
          break;
        }
        case 'edit': {
          const r = await this.editCellText({ documentId: p.documentId, cellId: e.cellId, expectedSourceHash: e.expectedSourceHash, edits: e.edits }, client);
          touchedIds.push(r.cellId);
          results.push(r);
          break;
        }
        case 'insert': {
          const r = await this.insertCell({ documentId: p.documentId, anchorCellId: e.anchorCellId, position: e.position, kind: e.kind, source: e.source }, client);
          touchedIds.push(r.cellId);
          results.push(r);
          break;
        }
        case 'delete':
          results.push(await this.deleteCell({ documentId: p.documentId, cellId: e.cellId, expectedSourceHash: e.expectedSourceHash }, client));
          break;
        case 'move':
          results.push(await this.moveCell({ documentId: p.documentId, cellId: e.cellId, anchorCellId: e.anchorCellId, position: e.position }, client));
          break;
      }
    }
    this.linkRequest(p, touchedIds);
    if (!p.execute) return { documentId: documentIdFor(nb), version: contentVersion(nb), results };
    // Run the replaced/inserted python cells in notebook order, stopping at the first error.
    const toRun = touchedIds
      .map((id) => findCell(nb, id))
      .filter((c): c is vscode.NotebookCell => !!c && c.kind === vscode.NotebookCellKind.Code)
      .sort((a, b) => a.index - b.index);
    const executions: ExecutionResult[] = [];
    const deadline = Date.now() + (p.timeoutMs ?? 45000 * Math.max(1, toRun.length));
    for (const cell of toRun) {
      const r = await this.runOne(nb, cell, Math.max(1000, deadline - Date.now()), false);
      executions.push(r);
      if (r.success === false || r.timedOut) break;
    }
    return { documentId: documentIdFor(nb), version: contentVersion(nb), results, executions };
  }

  // ------------------------------------------------------------------ execution
  private async runOne(nb: vscode.NotebookDocument, cell: vscode.NotebookCell, timeoutMs: number, force: boolean): Promise<ExecutionResult> {
    const controller = this.deps.registry.getSelectedController(nb);
    if (!controller) throw BridgeError.kernelUnavailable('No kernel is selected for this notebook. Ask the user to choose one in the kernel picker (QMD Notebook: Select Kernel).');
    if (cell.kind !== vscode.NotebookCellKind.Code) throw BridgeError.invalidParams(`cell ${cellIdOf(cell)} is a Markdown cell`);
    const started = Date.now();
    const run = this.deps.registry.runCells(nb, [cell], controller, { force });
    let timedOut = false;
    const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
    const winner = await Promise.race([run, timer]);
    const result = Array.isArray(winner) ? winner[0] : undefined;
    if (winner === 'timeout') {
      timedOut = true;
      // Leave the cell running in the notebook (the user can see it); report back now.
    }
    const cellId = cellIdOf(cell) ?? '';
    // The API cell's outputs are updated asynchronously after the execution ends; wait briefly so
    // the summary (and the output ids derived from it) match what read_cell will return.
    if (result) {
      // Wait until the extension host's view of the cell shows exactly the outputs this run produced
      // (compared by content: a stale view can still hold the previous run's outputs with the same
      // count). Comment-thread outputs ride along on the cell and are ignored.
      const wanted = result.outputs.map((o) => hashText(o.items.map((i) => `${i.mime}:${hashBytes(i.data)}`).join('|')));
      const landed = () => {
        const current = realOutputs(cell).map((o) => outputHash(o.output));
        return current.length === wanted.length && current.every((h, i) => h === wanted[i]);
      };
      const deadline = Date.now() + 3000;
      while (!landed() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    }
    return {
      cellId,
      executionOrder: result?.executionOrder ?? cell.executionSummary?.executionOrder ?? null,
      success: result ? result.success : null,
      timedOut,
      ...(timedOut ? { stillRunning: true, hint: 'The cell is still executing in the notebook; poll read_cell (executionSuccess/outputs) or call interrupt_kernel.' } : {}),
      durationMs: Date.now() - started,
      outputs: summarizeOutputs(cell, cellId, 3000),
      error: result?.error ? { name: result.error.name, message: result.error.message, traceback: result.error.traceback.slice(-20).map((l) => stripAnsi(l)) } : null,
    };
  }

  async executeCell(p: { documentId?: string; cellId: string; timeoutMs?: number; force?: boolean; requestId?: string; note?: string }): Promise<ExecutionResult> {
    this.requireTrust();
    const nb = this.resolveNotebook(p.documentId);
    const cell = this.resolveCell(nb, p.cellId);
    this.linkRequest(p, [p.cellId]);
    return this.runOne(nb, cell, p.timeoutMs ?? 45000, !!p.force);
  }

  async executeCells(p: { documentId?: string; cellIds: string[]; stopOnError?: boolean; timeoutMs?: number; requestId?: string; note?: string }): Promise<ExecutionResult[]> {
    this.requireTrust();
    const nb = this.resolveNotebook(p.documentId);
    this.linkRequest(p, p.cellIds);
    const results: ExecutionResult[] = [];
    const deadline = Date.now() + (p.timeoutMs ?? 45000 * p.cellIds.length);
    for (const id of p.cellIds) {
      const cell = this.resolveCell(nb, id);
      const remaining = Math.max(1000, deadline - Date.now());
      const r = await this.runOne(nb, cell, remaining, false);
      results.push(r);
      if ((p.stopOnError ?? true) && (r.success === false || r.timedOut)) break;
    }
    return results;
  }

  async executeScratch(p: { documentId?: string; code: string; timeoutMs?: number; maxBytes?: number; requestId?: string; note?: string }) {
    this.requireTrust();
    const nb = this.resolveNotebook(p.documentId);
    this.linkRequest(p, []);
    return this.deps.registry.executeScratch(nb, p.code, { timeoutMs: p.timeoutMs ?? 60000, maxBytes: p.maxBytes, label: 'agent scratch execution' });
  }
}

function pngDimensions(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24) return null;
  if (data[0] !== 0x89 || data[1] !== 0x50) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function pruneOutputDir(dir: string, keep: number): void {
  try {
    const files = fs
      .readdirSync(dir)
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    /* ignore */
  }
}
