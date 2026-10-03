/**
 * Contextual request threads ("comments for the agent"). Stored in extension workspace storage,
 * never in the .qmd. Agents subscribe to a notebook (assign) and long-poll for new comments; they
 * post progress and replies back into the same thread.
 */
import * as vscode from 'vscode';
import {
  newRequestId,
  type AssignmentInfo,
  type KernelInfo,
  type RequestAnchor,
  type RequestAttachment,
  type RequestMessage,
  type RequestPacket,
  type RequestStatus,
  type RequestSummary,
} from '@qmd-notebook/shared';

const STORAGE_KEY = 'qmdNotebook.requests.v2';
const MAX_STORED = 200;
const PENDING: RequestStatus[] = ['queued', 'delivered', 'working', 'needs-input'];

export function isPending(status: RequestStatus): boolean {
  return PENDING.includes(status);
}

export interface Assignment extends AssignmentInfo {
  documentId: string;
}

const MAX_WAIT_MS = 6 * 60 * 60 * 1000;

interface Waiter {
  documentId: string | null;
  /** Bridge client that is waiting (null for internal waiters). */
  clientId: number | null;
  resolve: (batch: RequestPacket[] | 'stopped') => void;
  timer: NodeJS.Timeout;
}

export class RequestStore implements vscode.Disposable {
  private readonly requests = new Map<string, RequestPacket>();
  private readonly assignments = new Map<string, Assignment>();
  private readonly _onDidChange = new vscode.EventEmitter<RequestPacket | undefined>();
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidChangeAssignments = new vscode.EventEmitter<void>();
  readonly onDidChangeAssignments = this._onDidChangeAssignments.event;
  private waiters: Waiter[] = [];
  private persistTimer: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.workspaceState.get<RequestPacket[]>(STORAGE_KEY, []);
    for (const r of stored) {
      // Anything that was in flight when VS Code closed cannot still be worked on.
      if (r.status === 'working' || r.status === 'delivered' || r.status === 'needs-input') r.status = 'queued';
      if (!r.anchor) r.anchor = r.cellId ? 'cell' : 'notebook';
      if (r.followUp === undefined) r.followUp = false;
      if (!r.latestUserMessage) r.latestUserMessage = r.prompt;
      this.requests.set(r.requestId, r);
    }
  }

  // ------------------------------------------------------------------ requests
  create(input: {
    prompt: string;
    documentId: string;
    uri: string;
    documentVersion: number;
    cellId: string | null;
    anchor: RequestAnchor;
    kernel: KernelInfo;
    attachments: RequestAttachment[];
    attachmentHashes: string[];
    images?: RequestMessage['images'];
  }): RequestPacket {
    const now = new Date().toISOString();
    const packet: RequestPacket = {
      requestId: newRequestId(),
      createdAt: now,
      status: 'queued',
      prompt: input.prompt,
      documentId: input.documentId,
      uri: input.uri,
      cellId: input.cellId,
      anchor: input.anchor,
      followUp: false,
      latestUserMessage: input.prompt,
      documentVersion: input.documentVersion,
      kernel: input.kernel,
      attachments: input.attachments,
      attachmentHashes: input.attachmentHashes,
      messages: [{ at: now, from: 'user', text: input.prompt, status: 'queued', ...(input.images?.length ? { images: input.images } : {}) }],
      linkedCellIds: [],
      deliveredTo: null,
    };
    this.requests.set(packet.requestId, packet);
    this.trim();
    this.changed(packet);
    this.notifyWaiters();
    return packet;
  }

  get(id: string): RequestPacket | undefined {
    return this.requests.get(id);
  }

  list(filter: 'pending' | 'all' | 'queued' = 'all', documentId?: string): RequestPacket[] {
    let all = Array.from(this.requests.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (documentId) all = all.filter((r) => r.documentId === documentId);
    if (filter === 'pending') return all.filter((r) => isPending(r.status));
    if (filter === 'queued') return all.filter((r) => r.status === 'queued');
    return all;
  }

  forCell(uri: vscode.Uri, cellId: string): RequestPacket[] {
    const u = uri.toString();
    return this.list('all').filter((r) => r.uri === u && (r.cellId === cellId || r.attachments.some((a) => a.cellId === cellId && a.kind !== 'neighbor')));
  }

  summary(r: RequestPacket): RequestSummary {
    return {
      requestId: r.requestId,
      createdAt: r.createdAt,
      status: r.status,
      prompt: r.prompt,
      documentId: r.documentId,
      uri: r.uri,
      cellId: r.cellId,
      anchor: r.anchor,
      followUp: r.followUp,
      latestUserMessage: r.latestUserMessage,
    };
  }

  update(id: string, change: { status?: RequestStatus; message?: string; from?: 'user' | 'agent' | 'system' }): RequestPacket {
    const r = this.requests.get(id);
    if (!r) throw new Error(`request ${id} not found`);
    if (change.status) r.status = change.status;
    if (change.message) r.messages.push({ at: new Date().toISOString(), from: change.from ?? 'agent', text: change.message, status: r.status });
    else if (change.status) r.messages.push({ at: new Date().toISOString(), from: change.from ?? 'system', text: `status → ${change.status}`, status: r.status });
    this.changed(r);
    return r;
  }

  resolve(id: string, input: { summary?: string; linkedCellIds?: string[]; status?: 'completed' | 'failed' }): RequestPacket {
    const r = this.requests.get(id);
    if (!r) throw new Error(`request ${id} not found`);
    r.status = input.status ?? 'completed';
    if (input.linkedCellIds) r.linkedCellIds = Array.from(new Set([...r.linkedCellIds, ...input.linkedCellIds]));
    r.messages.push({ at: new Date().toISOString(), from: 'agent', text: input.summary ?? (r.status === 'completed' ? 'Completed.' : 'Failed.'), status: r.status });
    this.changed(r);
    return r;
  }

  /** The user typed a follow-up into an existing thread: re-queue it for the agent. */
  userReply(id: string, text: string, extra: { images?: RequestMessage['images']; attachments?: RequestAttachment[] } = {}): RequestPacket {
    const r = this.requests.get(id);
    if (!r) throw new Error(`request ${id} not found`);
    r.status = 'queued';
    r.followUp = true;
    r.latestUserMessage = text;
    if (extra.attachments?.length) r.attachments = [...r.attachments, ...extra.attachments];
    r.messages.push({ at: new Date().toISOString(), from: 'user', text, status: 'queued', ...(extra.images?.length ? { images: extra.images } : {}) });
    this.changed(r);
    this.notifyWaiters();
    return r;
  }

  cancel(id: string): void {
    const r = this.requests.get(id);
    if (!r) return;
    r.status = 'cancelled';
    r.messages.push({ at: new Date().toISOString(), from: 'user', text: 'Cancelled by the user.', status: 'cancelled' });
    this.changed(r);
  }

  /**
   * An agent touched the notebook on behalf of a comment (requestId on an edit/execute call):
   * the comment becomes "working", the note lands in its thread, and the cells are linked.
   */
  linkWork(id: string, input: { note?: string; cellIds?: string[] }): RequestPacket | undefined {
    const r = this.requests.get(id);
    if (!r || !isPending(r.status)) return undefined;
    if (input.cellIds?.length) r.linkedCellIds = Array.from(new Set([...r.linkedCellIds, ...input.cellIds]));
    const becameWorking = r.status !== 'working';
    r.status = 'working';
    const note = input.note?.trim();
    if (note) r.messages.push({ at: new Date().toISOString(), from: 'agent', text: note, status: 'working' });
    else if (becameWorking) r.messages.push({ at: new Date().toISOString(), from: 'system', text: 'status → working', status: 'working' });
    this.changed(r);
    return r;
  }

  /** Called when an agent fetches/receives a request. */
  markDelivered(id: string, agentName: string): void {
    const r = this.requests.get(id);
    if (!r || r.status !== 'queued') return;
    r.status = 'delivered';
    r.deliveredTo = agentName;
    r.messages.push({ at: new Date().toISOString(), from: 'system', text: `Delivered to ${agentName}.`, status: 'delivered' });
    this.changed(r);
  }

  delete(id: string): void {
    if (this.requests.delete(id)) this.changed(undefined);
  }

  clearFinished(): void {
    for (const [id, r] of this.requests) if (!isPending(r.status)) this.requests.delete(id);
    this.changed(undefined);
  }

  // ------------------------------------------------------------------ assignments
  assign(documentId: string, clientId: number, agentName: string): Assignment {
    const a: Assignment = { documentId, clientId, agentName, since: new Date().toISOString() };
    this.assignments.set(documentId, a);
    this._onDidChangeAssignments.fire();
    return a;
  }

  release(documentId: string, reason = 'released'): void {
    if (!this.assignments.delete(documentId)) return;
    this._onDidChangeAssignments.fire();
    this.wakeWaiters(documentId, 'stopped', reason);
  }

  assignment(documentId: string): Assignment | undefined {
    return this.assignments.get(documentId);
  }

  allAssignments(): Assignment[] {
    return Array.from(this.assignments.values());
  }

  /** Drop assignments (and pending long-polls) whose bridge client is gone. */
  pruneAssignments(connectedClientIds: number[]): void {
    for (const w of this.waiters) if (w.clientId !== null && !connectedClientIds.includes(w.clientId)) this.cancelWaiters(w.clientId);
    let changed = false;
    for (const [docId, a] of this.assignments) {
      if (!connectedClientIds.includes(a.clientId)) {
        this.assignments.delete(docId);
        changed = true;
      }
    }
    if (changed) this._onDidChangeAssignments.fire();
  }

  // ------------------------------------------------------------------ long-poll
  /**
   * Resolve with the queued requests for the notebook (or any notebook when documentId is
   * null), immediately if some exist, otherwise when the next one arrives or the timeout ends.
   * Resolves with 'stopped' when the assignment for that notebook is released.
   */
  waitForRequests(documentId: string | null, timeoutMs: number, clientId: number | null = null): Promise<RequestPacket[] | 'stopped'> {
    const queued = this.list('queued', documentId ?? undefined);
    if (queued.length) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        documentId,
        clientId,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve([]);
        }, Math.min(Math.max(timeoutMs, 1000), MAX_WAIT_MS)),
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * The client abandoned its long-poll (MCP cancellation, client timeout, disconnect): resolve it
   * empty now so a comment arriving later is not marked delivered to nobody.
   */
  cancelWaiters(clientId: number): number {
    const mine = this.waiters.filter((w) => w.clientId === clientId);
    if (!mine.length) return 0;
    this.waiters = this.waiters.filter((w) => w.clientId !== clientId);
    for (const w of mine) {
      clearTimeout(w.timer);
      w.resolve([]);
    }
    return mine.length;
  }

  /** Number of long-polls currently parked (tests/diagnostics). */
  waiterCount(clientId?: number): number {
    return clientId === undefined ? this.waiters.length : this.waiters.filter((w) => w.clientId === clientId).length;
  }

  private notifyWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      const queued = this.list('queued', w.documentId ?? undefined);
      if (queued.length) {
        clearTimeout(w.timer);
        w.resolve(queued);
      } else this.waiters.push(w);
    }
  }

  private wakeWaiters(documentId: string, result: 'stopped', _reason: string): void {
    const keep: Waiter[] = [];
    for (const w of this.waiters) {
      if (w.documentId === documentId || w.documentId === null) {
        clearTimeout(w.timer);
        w.resolve(result);
      } else keep.push(w);
    }
    this.waiters = keep;
  }

  /** Wake all waiters for a notebook that just closed. */
  notebookClosed(documentId: string): void {
    this.release(documentId, 'notebook closed');
  }

  // ------------------------------------------------------------------ misc
  private trim(): void {
    const all = this.list('all');
    if (all.length <= MAX_STORED) return;
    for (const r of all.slice(0, all.length - MAX_STORED)) if (!isPending(r.status)) this.requests.delete(r.requestId);
  }

  private changed(r: RequestPacket | undefined): void {
    this._onDidChange.fire(r);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => void this.persist(), 500);
  }

  private persist(): Thenable<void> {
    return this.context.workspaceState.update(STORAGE_KEY, this.list('all').slice(-MAX_STORED));
  }

  threadAsMarkdown(r: RequestPacket): string {
    const lines = [`## Agent comment ${r.requestId}`, '', `- Created: ${r.createdAt}`, `- Status: ${r.status}`, `- Notebook: ${r.uri}`, r.cellId ? `- Cell: ${r.cellId}` : '', `- Anchor: ${r.anchor}`, '', `**Prompt:** ${r.prompt}`, ''];
    for (const a of r.attachments) {
      if (a.kind === 'neighbor') continue;
      lines.push(`### Attachment: ${a.kind} (${a.cellId})`);
      if (a.text) lines.push('', '```', a.text, '```');
      else if (a.source) lines.push('', '```' + (a.cellKind === 'python' ? 'python' : ''), a.source, '```');
      if (a.outputText) lines.push('', 'Output:', '', '```', a.outputText, '```');
      lines.push('');
    }
    lines.push('### Thread', '');
    for (const m of r.messages) lines.push(`- ${m.at} **${m.from}**${m.status ? ` (${m.status})` : ''}: ${m.text}`);
    return lines.filter((l) => l !== undefined).join('\n') + '\n';
  }

  dispose(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    void this.persist();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve([]);
    }
    this._onDidChange.dispose();
    this._onDidChangeAssignments.dispose();
  }
}
