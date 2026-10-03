/**
 * In-cell comment threads for agent requests, rendered as transient notebook outputs by the
 * `qmd-notebook.comments` renderer (VS Code's Comments API cannot place threads inside notebook
 * cells from an extension; see docs/research-decisions.md, Spike D).
 *
 * A draft output carries a compose box; once submitted it becomes a request whose thread output
 * shows the user's message, the agent's plan/replies, and the status. Outputs are transient for
 * QMD notebooks, so nothing reaches the .qmd file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { hashText, newRequestId, type ImageAttachmentInfo, type RequestAnchor, type RequestAttachment, type RequestPacket } from '@qmd-notebook/shared';
import type { SessionRegistry } from '../execution/sessionRegistry';
import { cellIdOf, findCell } from '../notebook/identity';
import { getSetting, isQmdNotebook } from '../util/config';
import type { Logger } from '../util/logger';
import { COMMENT_MIME, RENDERER_ID, type CommentOutput, type ComposeTarget, type DraftOutput, type ImagePreview, type PastedImage, type RendererToExtension, type ThreadOutput } from '../renderer/protocol';
import { ensurePrivateDir, runtimeDir } from './bridgeServer';
import { attachmentForCell, attachmentForOutput, neighborAttachments, rangeInfo } from './contextCapture';
import { documentIdFor } from './notebookService';
import { isPending, type RequestStore } from './requestStore';

export function handoffText(requestId: string): string {
  return `Handle QMD Notebook request ${requestId} using the connected notebook tools.`;
}

interface Draft {
  draftId: string;
  notebook: vscode.NotebookDocument;
  cell: vscode.NotebookCell;
  anchor: RequestAnchor;
  range?: vscode.Range;
  outputIndex?: number;
  excerpt: string;
  images: StoredImage[];
}

/** An attached image: bytes on disk (private), thumbnail in memory/workspace state for the UI. */
export type StoredImage = ImageAttachmentInfo & { thumbnail?: string };

const enc = new TextEncoder();
const IMAGE_MIMES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };
const MAX_THUMBNAIL_CHARS = 120000;

export function attachmentsDir(): string {
  const dir = path.join(runtimeDir(), 'attachments');
  ensurePrivateDir(dir);
  return dir;
}

function previewOf(im: StoredImage): ImagePreview {
  return { imageId: im.imageId, name: im.name, width: im.width, height: im.height, bytes: im.bytes, thumbnail: im.thumbnail };
}

function toAttachment(im: StoredImage): RequestAttachment {
  return { kind: 'image', cellId: '', imageId: im.imageId, name: im.name, mime: im.mime, bytes: im.bytes, width: im.width, height: im.height, filePath: im.filePath };
}

export class CommentBridge implements vscode.Disposable {
  private readonly messaging = vscode.notebooks.createRendererMessaging(RENDERER_ID);
  private readonly drafts = new Map<string, Draft>();
  /** Images attached to a thread's reply box that has not been sent yet, by requestId. */
  private readonly pendingReplyImages = new Map<string, StoredImage[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];
  private warnedNoKernel = false;

  constructor(
    private readonly requests: RequestStore,
    private readonly registry: SessionRegistry,
    private readonly logger: Logger,
  ) {
    this.disposables.push(
      this.messaging.onDidReceiveMessage((e) => void this.onMessage(e.message as RendererToExtension)),
      requests.onDidChange((r) => (r ? this.scheduleForRequest(r) : this.scheduleAll())),
      requests.onDidChangeAssignments(() => this.scheduleAll()),
      registry.onDidChange((nb) => (nb ? this.scheduleNotebook(nb) : this.scheduleAll())),
      vscode.workspace.onDidOpenNotebookDocument((nb) => this.scheduleNotebook(nb)),
      vscode.workspace.onDidChangeNotebookDocument((e) => {
        if (!isQmdNotebook(e.notebook)) return;
        for (const c of e.cellChanges) if (c.outputs) this.schedule(c.cell);
      }),
    );
    for (const nb of vscode.workspace.notebookDocuments) this.scheduleNotebook(nb);
  }

  // ------------------------------------------------------------------ drafts & actions
  /** Open a compose box under the cell (falls back to an input box when no kernel is selected). */
  async startDraft(cell: vscode.NotebookCell, anchor: RequestAnchor, range?: vscode.Range, outputIndex?: number): Promise<string> {
    const excerpt = anchor === 'output' ? `#${(outputIndex ?? 0) + 1}` : range && !range.isEmpty ? cell.document.getText(range).replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    const draft: Draft = { draftId: newRequestId().replace('qmdreq_', 'draft_'), notebook: cell.notebook, cell, anchor, range: range && !range.isEmpty ? range : undefined, outputIndex, excerpt, images: [] };
    if (!this.registry.getSelectedController(cell.notebook)) {
      // No kernel → no way to write outputs; collect the text directly.
      if (!this.warnedNoKernel) {
        this.warnedNoKernel = true;
        void vscode.window.showInformationMessage('Select a kernel to see agent comments inline under cells. Until then comments are collected through an input box.');
      }
      const text = await vscode.window.showInputBox({ title: `Comment for the agent (${anchor}${excerpt ? ` “${excerpt}”` : ''})`, prompt: 'What should the agent do?', ignoreFocusOut: true });
      if (text?.trim()) await this.createRequest(draft, text.trim());
      return draft.draftId;
    }
    for (const [id, d] of this.drafts) if (d.cell === cell) this.drafts.delete(id);
    this.drafts.set(draft.draftId, draft);
    await this.sync(cell);
    // bring the cell (and its outputs) into view; the renderer focuses the textarea
    const editor = vscode.window.visibleNotebookEditors.find((e) => e.notebook === cell.notebook);
    if (editor) {
      editor.selections = [new vscode.NotebookRange(cell.index, cell.index + 1)];
      editor.revealRange(new vscode.NotebookRange(cell.index, cell.index + 1), vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
      try {
        await vscode.commands.executeCommand('notebook.cell.focusInOutput');
      } catch {
        /* best effort */
      }
    }
    return draft.draftId;
  }

  async submitDraft(draftId: string, text: string): Promise<RequestPacket | undefined> {
    const draft = this.drafts.get(draftId);
    if (!draft) return undefined;
    this.drafts.delete(draftId);
    const packet = await this.createRequest(draft, text.trim());
    return packet;
  }

  async cancelDraft(draftId: string): Promise<void> {
    const draft = this.drafts.get(draftId);
    if (!draft) return;
    this.drafts.delete(draftId);
    for (const im of draft.images) this.removeFile(im);
    await this.sync(draft.cell);
  }

  reply(requestId: string, text: string): void {
    const packet = this.requests.get(requestId);
    const images = this.pendingReplyImages.get(requestId) ?? [];
    if (!packet || (!text.trim() && !images.length)) return;
    this.pendingReplyImages.delete(requestId);
    this.requests.userReply(requestId, text.trim() || '(see attached image)', { images: images.map((im) => ({ ...im })), attachments: images.map(toAttachment) });
    if (images.length) this.logger.info(`comment ${requestId}: follow-up with ${images.length} image(s)`);
  }

  // ------------------------------------------------------------------ image attachments
  /**
   * Store an image pasted (or picked) into a compose box: bytes to a private 0600 file under the
   * bridge runtime dir, thumbnail with the draft/thread for the UI. Returns the imageId.
   */
  async attachImage(target: ComposeTarget, image: PastedImage): Promise<string> {
    const ext = IMAGE_MIMES[image.mime];
    if (!ext) throw new Error(`unsupported image type ${image.mime || '(unknown)'}; paste PNG, JPEG, GIF or WebP`);
    const data = Buffer.from(image.base64, 'base64');
    const max = getSetting<number>('agent.maxImageBytes', 5000000);
    if (data.byteLength === 0) throw new Error('empty image');
    if (data.byteLength > max) throw new Error(`image is ${Math.round(data.byteLength / 1024)} KB; the limit (qmdNotebook.agent.maxImageBytes) is ${Math.round(max / 1024)} KB`);
    const imageId = newRequestId().replace('qmdreq_', 'qmdimg_');
    const filePath = path.join(attachmentsDir(), `${imageId}.${ext}`);
    fs.writeFileSync(filePath, data, { mode: 0o600 });
    const stored: StoredImage = {
      imageId,
      name: (image.name || `image.${ext}`).replace(/[\\/]/g, '_').slice(0, 120),
      mime: image.mime,
      bytes: data.byteLength,
      width: image.width,
      height: image.height,
      filePath,
      thumbnail: image.thumbnail && image.thumbnail.length <= MAX_THUMBNAIL_CHARS ? image.thumbnail : undefined,
    };
    const cell = this.cellFor(target);
    if ('draftId' in target) {
      const draft = this.drafts.get(target.draftId);
      if (!draft) {
        fs.rmSync(filePath, { force: true });
        throw new Error('the comment box is gone');
      }
      draft.images.push(stored);
    } else {
      if (!this.requests.get(target.requestId)) {
        fs.rmSync(filePath, { force: true });
        throw new Error('the comment thread is gone');
      }
      this.pendingReplyImages.set(target.requestId, [...(this.pendingReplyImages.get(target.requestId) ?? []), stored]);
    }
    this.logger.info(`comment image ${imageId} attached (${stored.width}×${stored.height}, ${Math.round(stored.bytes / 1024)} KB)`);
    if (cell) await this.sync(cell);
    return imageId;
  }

  async removeImage(target: ComposeTarget, imageId: string): Promise<void> {
    let removed: StoredImage | undefined;
    if ('draftId' in target) {
      const draft = this.drafts.get(target.draftId);
      if (!draft) return;
      removed = draft.images.find((im) => im.imageId === imageId);
      draft.images = draft.images.filter((im) => im.imageId !== imageId);
    } else {
      const list = this.pendingReplyImages.get(target.requestId) ?? [];
      removed = list.find((im) => im.imageId === imageId);
      this.pendingReplyImages.set(target.requestId, list.filter((im) => im.imageId !== imageId));
    }
    if (removed) this.removeFile(removed);
    const cell = this.cellFor(target);
    if (cell) await this.sync(cell);
  }

  /** Attach an image file chosen through the OS file picker (no canvas here: small files preview as-is). */
  async pickImage(target: ComposeTarget): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }, title: 'Attach image(s) to the comment' });
    for (const uri of picked ?? []) {
      const data = fs.readFileSync(uri.fsPath);
      const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
      const mime = Object.entries(IMAGE_MIMES).find(([, e]) => e === (ext === 'jpeg' ? 'jpg' : ext))?.[0] ?? 'image/png';
      const dims = mime === 'image/png' ? pngSize(data) : null;
      const base64 = data.toString('base64');
      await this.attachImage(target, { name: path.basename(uri.fsPath), mime, width: dims?.width ?? 0, height: dims?.height ?? 0, base64, thumbnail: base64.length <= MAX_THUMBNAIL_CHARS ? `data:${mime};base64,${base64}` : undefined });
    }
  }

  /** Open an attached image in VS Code's image viewer. */
  async openImage(requestId: string, imageId: string): Promise<void> {
    const packet = this.requests.get(requestId);
    const att = packet?.attachments.find((a) => a.kind === 'image' && a.imageId === imageId);
    if (att?.filePath && fs.existsSync(att.filePath)) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(att.filePath), { preview: true });
  }

  /** Images attached to a request (from its attachments), for the bridge. */
  imageAttachment(requestId: string, imageId: string): ImageAttachmentInfo | undefined {
    const att = this.requests.get(requestId)?.attachments.find((a) => a.kind === 'image' && a.imageId === imageId);
    if (!att || !att.filePath) return undefined;
    return { imageId, name: att.name ?? imageId, mime: att.mime ?? 'image/png', bytes: att.bytes ?? 0, width: att.width ?? 0, height: att.height ?? 0, filePath: att.filePath };
  }

  private removeFile(im: StoredImage): void {
    try {
      fs.rmSync(im.filePath, { force: true });
    } catch {
      /* ignore */
    }
  }

  private cellFor(target: ComposeTarget): vscode.NotebookCell | undefined {
    if ('draftId' in target) return this.drafts.get(target.draftId)?.cell;
    const packet = this.requests.get(target.requestId);
    const nb = packet && vscode.workspace.notebookDocuments.find((n) => n.uri.toString() === packet.uri);
    return nb && packet?.cellId ? findCell(nb, packet.cellId) : undefined;
  }

  markResolved(requestId: string): void {
    const packet = this.requests.get(requestId);
    if (packet && isPending(packet.status)) this.requests.cancel(requestId);
  }

  reopen(requestId: string): void {
    const packet = this.requests.get(requestId);
    if (packet) this.requests.userReply(requestId, packet.latestUserMessage || packet.prompt);
  }

  deleteThread(requestId: string): void {
    const packet = this.requests.get(requestId);
    this.requests.delete(requestId);
    for (const im of this.pendingReplyImages.get(requestId) ?? []) this.removeFile(im);
    this.pendingReplyImages.delete(requestId);
    if (packet) {
      for (const a of packet.attachments) if (a.kind === 'image' && a.filePath) fs.rmSync(a.filePath, { force: true });
      const nb = vscode.workspace.notebookDocuments.find((n) => n.uri.toString() === packet.uri);
      const cell = nb && packet.cellId ? findCell(nb, packet.cellId) : undefined;
      if (cell) this.schedule(cell);
    }
  }

  /** Select the cell of a request/cell and expand its thread. */
  async reveal(target: { requestId?: string; cellId?: string; uri?: string }): Promise<void> {
    const packet = target.requestId ? this.requests.get(target.requestId) : this.requests.list('all').find((r) => r.cellId === target.cellId && (!target.uri || r.uri === target.uri));
    if (!packet) return;
    const nb = vscode.workspace.notebookDocuments.find((n) => n.uri.toString() === packet.uri) ?? (await vscode.workspace.openNotebookDocument(vscode.Uri.parse(packet.uri)));
    const cell = packet.cellId ? findCell(nb, packet.cellId) : undefined;
    if (!cell) return;
    const editor = await vscode.window.showNotebookDocument(nb, { selections: [new vscode.NotebookRange(cell.index, cell.index + 1)], preserveFocus: true });
    editor.revealRange(new vscode.NotebookRange(cell.index, cell.index + 1), vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
    void this.messaging.postMessage({ type: 'expand', requestId: packet.requestId }, editor);
  }

  countsForCell(nb: vscode.NotebookDocument, cellId: string): { pending: number; resolved: number; statuses: string[] } {
    const threads = this.requests.forCell(nb.uri, cellId);
    const pending = threads.filter((t) => isPending(t.status)).length;
    return { pending, resolved: threads.length - pending, statuses: threads.map((t) => t.status) };
  }

  /** Thread outputs currently shown under a cell (for tests). */
  threadOutputsOf(cell: vscode.NotebookCell): CommentOutput[] {
    const out: CommentOutput[] = [];
    for (const o of cell.outputs) {
      const item = o.items.find((i) => i.mime === COMMENT_MIME);
      if (!item) continue;
      try {
        out.push(JSON.parse(Buffer.from(item.data).toString('utf8')) as CommentOutput);
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  private async onMessage(msg: RendererToExtension): Promise<void> {
    try {
      switch (msg?.type) {
        case 'submitDraft':
          await this.submitDraft(msg.draftId, msg.text);
          return;
        case 'cancelDraft':
          await this.cancelDraft(msg.draftId);
          return;
        case 'reply':
          this.reply(msg.requestId, msg.text);
          return;
        case 'resolve':
          this.markResolved(msg.requestId);
          return;
        case 'reopen':
          this.reopen(msg.requestId);
          return;
        case 'delete':
          this.deleteThread(msg.requestId);
          return;
        case 'attachImage':
          await this.attachImage(msg.target, msg.image);
          return;
        case 'removeImage':
          await this.removeImage(msg.target, msg.imageId);
          return;
        case 'pickImage':
          await this.pickImage(msg.target);
          return;
        case 'openImage':
          await this.openImage(msg.requestId, msg.imageId);
          return;
      }
    } catch (e) {
      this.logger.error(`comment action failed: ${String(e)}`);
      void vscode.window.showWarningMessage(`QMD Notebook: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async createRequest(d: Draft, text: string): Promise<RequestPacket> {
    const maxChars = getSetting<number>('agent.maxTextBytes', 200000);
    const attachments: RequestAttachment[] = [];
    const cellId = cellIdOf(d.cell);
    if (d.anchor === 'selection' && d.range) {
      attachments.push({
        kind: 'selection',
        cellId: cellId ?? '',
        cellKind: d.cell.kind === vscode.NotebookCellKind.Code ? 'python' : 'markdown',
        sourceHash: hashText(d.cell.document.getText()),
        text: d.cell.document.getText(d.range).slice(0, maxChars),
        range: rangeInfo(d.range),
        source: d.cell.document.getText().slice(0, maxChars),
        executionOrder: d.cell.executionSummary?.executionOrder ?? null,
      });
    }
    if (d.anchor === 'output') {
      const a = attachmentForOutput(d.cell, d.outputIndex ?? 0, maxChars);
      if (a) attachments.push(a);
    }
    attachments.push(attachmentForCell(d.cell, 'cell', maxChars), ...neighborAttachments(d.notebook, d.cell.index, 4000));
    attachments.push(...d.images.map(toAttachment));
    const packet = this.requests.create({
      prompt: text,
      documentId: documentIdFor(d.notebook),
      uri: d.notebook.uri.toString(),
      documentVersion: d.notebook.version,
      cellId,
      anchor: d.anchor,
      kernel: this.registry.kernelInfo(d.notebook),
      attachments,
      attachmentHashes: attachments.map((a) => hashText(JSON.stringify(a))),
      images: d.images.map((im) => ({ ...im })),
    });
    this.logger.info(`comment ${packet.requestId} created on ${d.anchor} of cell ${cellId}${d.images.length ? ` with ${d.images.length} image(s)` : ''}`);
    await this.sync(d.cell);
    if (!this.requests.assignment(packet.documentId)) {
      void vscode.window
        .showInformationMessage('Comment queued, but no agent is watching this notebook. In Codex use $focus-notebook <name>; in Claude Code use /focus-notebook <name> (or the focus_notebook MCP prompt); or copy a one-line handoff.', 'Copy handoff')
        .then(async (choice) => {
          if (choice === 'Copy handoff') await vscode.env.clipboard.writeText(handoffText(packet.requestId));
        });
    }
    return packet;
  }

  // ------------------------------------------------------------------ output sync
  private scheduleForRequest(r: RequestPacket): void {
    const nb = vscode.workspace.notebookDocuments.find((n) => n.uri.toString() === r.uri);
    const cell = nb && r.cellId ? findCell(nb, r.cellId) : undefined;
    if (cell) this.schedule(cell);
  }

  private scheduleNotebook(nb: vscode.NotebookDocument): void {
    if (!isQmdNotebook(nb) || nb.isClosed) return;
    const docId = documentIdFor(nb);
    const cellIds = new Set(this.requests.list('all', docId).map((r) => r.cellId).filter(Boolean) as string[]);
    for (const d of this.drafts.values()) if (d.notebook === nb) this.schedule(d.cell);
    for (const cell of nb.getCells()) {
      const id = cellIdOf(cell);
      if ((id && cellIds.has(id)) || this.threadOutputsOf(cell).length) this.schedule(cell);
    }
  }

  private scheduleAll(): void {
    for (const nb of vscode.workspace.notebookDocuments) this.scheduleNotebook(nb);
  }

  private schedule(cell: vscode.NotebookCell): void {
    const key = `${cell.notebook.uri.toString()}#${cellIdOf(cell) ?? cell.index}`;
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.sync(cell).catch((e) => this.logger.warn(`comment sync failed: ${String(e)}`));
      }, 150),
    );
  }

  private desiredOutputs(cell: vscode.NotebookCell): CommentOutput[] {
    const nb = cell.notebook;
    const cellId = cellIdOf(cell);
    if (!cellId) return [];
    const assignment = this.requests.assignment(documentIdFor(nb));
    const out: CommentOutput[] = [];
    const threads = this.requests.forCell(nb.uri, cellId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const r of threads) {
      const selection = r.attachments.find((a) => a.kind === 'selection');
      const output = r.attachments.find((a) => a.kind === 'output');
      const t: ThreadOutput = {
        kind: 'thread',
        requestId: r.requestId,
        cellId,
        status: r.status,
        anchor: r.anchor,
        excerpt: selection?.text ? selection.text.replace(/\s+/g, ' ').trim().slice(0, 40) : output?.outputMime ? `(${output.outputMime})` : '',
        agentName: r.deliveredTo ?? assignment?.agentName ?? null,
        watching: !!assignment,
        messages: r.messages.map((m) => ({ from: m.from, text: m.text, at: m.at, status: m.status, ...(m.images?.length ? { images: m.images.map((im) => previewOf(im)) } : {}) })),
        canReply: r.status !== 'cancelled' || true,
      };
      const pending = this.pendingReplyImages.get(r.requestId);
      if (pending?.length) t.pendingImages = pending.map(previewOf);
      out.push(t);
    }
    for (const d of this.drafts.values()) {
      if (d.cell !== cell) continue;
      const draft: DraftOutput = { kind: 'draft', draftId: d.draftId, cellId, anchor: d.anchor, excerpt: d.excerpt, agentName: assignment?.agentName ?? null, watching: !!assignment };
      if (d.images.length) draft.images = d.images.map(previewOf);
      out.push(draft);
    }
    return out;
  }

  /** Make the cell's comment outputs match the desired state (no-op when already equal). */
  /** The comment-thread outputs a cell should carry right now (drafts + threads), as cell outputs. */
  commentOutputsFor(cell: vscode.NotebookCell): vscode.NotebookCellOutput[] {
    return this.desiredOutputs(cell).map((o) => new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(enc.encode(JSON.stringify(o)), COMMENT_MIME)], { qmdComment: true }));
  }

  async sync(cell: vscode.NotebookCell): Promise<void> {
    const nb = cell.notebook;
    if (nb.isClosed || !isQmdNotebook(nb)) return;
    if (this.registry.isRunning(cell)) return; // the run re-attaches the threads itself (trailing outputs)
    const desired = this.desiredOutputs(cell).map((o) => JSON.stringify(o));
    const current = this.threadOutputsOf(cell).map((o) => JSON.stringify(o));
    if (desired.length === current.length && desired.every((d, i) => d === current[i])) return;
    const controller = this.registry.getSelectedController(nb);
    if (!controller) return; // cannot write outputs without a selected kernel; status bar dots still show
    const real = cell.outputs.filter((o) => !o.items.some((i) => i.mime === COMMENT_MIME));
    const commentOutputs = this.commentOutputsFor(cell);
    let execution: vscode.NotebookCellExecution;
    try {
      execution = controller.controller.createNotebookCellExecution(cell);
    } catch (e) {
      // an execution is in flight (or the controller is not associated any more): retry shortly
      this.logger.debug(`comment sync deferred: ${String(e)}`);
      setTimeout(() => this.schedule(cell), 500);
      return;
    }
    // VS Code requires start() before outputs can be modified; replay the cell's previous
    // execution summary (order, timing, success) so its ✓/timing indicator does not change.
    const summary = cell.executionSummary;
    execution.start(summary?.timing?.startTime ?? Date.now());
    if (summary?.executionOrder !== undefined) execution.executionOrder = summary.executionOrder;
    // Append when no thread output is present yet: appending never touches the real outputs, so
    // a momentarily stale view of them (right after a run) cannot wipe fresh results.
    if (current.length === 0) await execution.appendOutput(commentOutputs);
    else await execution.replaceOutput([...real, ...commentOutputs]);
    execution.end(summary?.success, summary?.timing?.endTime);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}

function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50) return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}
