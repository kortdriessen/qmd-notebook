/**
 * "Comment for the agent" entry points: open a native comment thread on the current selection,
 * cell or output. Submission, agent replies and status live in the thread (see commentThreads.ts).
 * Also hosts the optional live-terminal (Mode C) helpers.
 */
import * as vscode from 'vscode';
import type { SessionRegistry } from '../execution/sessionRegistry';
import { activeQmdEditor } from '../util/config';
import type { Logger } from '../util/logger';
import { currentCellSelection, summarizeOutputItem } from './contextCapture';
import { handoffText, type CommentBridge } from './commentThreads';
import type { RequestStore } from './requestStore';
import type { AgentSurfaces } from './agentSurfaces';

export { handoffText };

export interface AskDeps {
  requests: RequestStore;
  registry: SessionRegistry;
  surfaces: AgentSurfaces;
  comments: CommentBridge;
  logger: Logger;
}

function resolveCell(editor: vscode.NotebookEditor, arg: unknown): vscode.NotebookCell {
  if (arg && typeof arg === 'object' && 'notebook' in (arg as any) && 'index' in (arg as any)) return arg as vscode.NotebookCell;
  const idx = Math.min(editor.selections[0]?.start ?? 0, editor.notebook.cellCount - 1);
  return editor.notebook.cellAt(idx);
}

export function registerAskCommands(deps: AskDeps): vscode.Disposable[] {
  const { requests, surfaces, comments, logger } = deps;

  const reg = (id: string, fn: (...args: any[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.error(`${id}: ${message}`);
        void vscode.window.showErrorMessage(`QMD Notebook: ${message}`);
        return undefined;
      }
    });

  const needEditor = (): vscode.NotebookEditor => {
    const editor = activeQmdEditor();
    if (!editor) throw new Error('No QMD notebook is active');
    return editor;
  };

  return [
    reg('qmdNotebook.askAgentAboutSelection', async () => {
      const editor = needEditor();
      const sel = currentCellSelection(editor.notebook);
      if (sel) await comments.startDraft(sel.cell, 'selection', sel.range);
      else await comments.startDraft(resolveCell(editor, undefined), 'cell');
    }),
    reg('qmdNotebook.askAgentAboutCell', async (arg?: unknown) => {
      const editor = needEditor();
      const cell = resolveCell(editor, arg);
      const sel = currentCellSelection(editor.notebook);
      if (sel && sel.cell === cell) await comments.startDraft(cell, 'selection', sel.range);
      else await comments.startDraft(cell, 'cell');
    }),
    reg('qmdNotebook.askAgentAboutOutput', async (arg?: unknown) => {
      const editor = needEditor();
      const cell = resolveCell(editor, arg);
      if (cell.outputs.length === 0) {
        void vscode.window.showInformationMessage('This cell has no outputs yet. Run it first, then comment on its output.');
        return;
      }
      let index = 0;
      if (cell.outputs.length > 1) {
        const pick = await vscode.window.showQuickPick(
          cell.outputs.map((o, i) => {
            const best = o.items.find((it) => it.mime.startsWith('image/')) ?? o.items[0]!;
            const s = summarizeOutputItem(best, 80);
            return { label: `#${i + 1}  ${best.mime}`, description: s.text ? s.text.replace(/\s+/g, ' ').slice(0, 80) : `${best.data.byteLength} bytes`, index: i };
          }),
          { title: 'Which output?' },
        );
        if (!pick) return;
        index = pick.index;
      }
      await comments.startDraft(cell, 'output', undefined, index);
    }),

    // thread actions (tree view / renderer)
    reg('qmdNotebook.comments.resolve', (arg?: string | { requestId?: string; request?: { requestId: string } }) => {
      const id = typeof arg === 'string' ? arg : (arg?.requestId ?? arg?.request?.requestId);
      if (id) comments.markResolved(id);
    }),
    reg('qmdNotebook.comments.reopen', (arg?: string | { requestId?: string; request?: { requestId: string } }) => {
      const id = typeof arg === 'string' ? arg : (arg?.requestId ?? arg?.request?.requestId);
      if (id) comments.reopen(id);
    }),
    reg('qmdNotebook.comments.delete', (arg?: string | { requestId?: string; request?: { requestId: string } }) => {
      const id = typeof arg === 'string' ? arg : (arg?.requestId ?? arg?.request?.requestId);
      if (id) comments.deleteThread(id);
    }),
    reg('qmdNotebook.comments.reveal', (arg?: { requestId?: string; cellId?: string; uri?: string } | string) => comments.reveal(typeof arg === 'string' ? { requestId: arg } : (arg ?? {}))),
    reg('qmdNotebook.releaseAgent', async () => {
      const editor = needEditor();
      const { documentIdFor } = await import('./notebookService');
      const docId = documentIdFor(editor.notebook);
      const a = requests.assignment(docId);
      if (!a) {
        void vscode.window.showInformationMessage('No agent is watching this notebook.');
        return;
      }
      requests.release(docId, 'released by the user');
      void vscode.window.showInformationMessage(`${a.agentName} was released from this notebook.`);
    }),

    // optional live-terminal helpers (Mode C)
    reg('qmdNotebook.focusAgent', () => surfaces.focus()),
    reg('qmdNotebook.startLiveClaude', () => surfaces.startLive('claude')),
    reg('qmdNotebook.startLiveCodex', () => surfaces.startLive('codex')),
    reg('qmdNotebook.sendRequestToLiveAgent', async (arg?: { requestId?: string } | string) => {
      const id = typeof arg === 'string' ? arg : arg?.requestId;
      let requestId = id;
      if (!requestId) {
        const pending = requests.list('pending');
        if (pending.length === 0) throw new Error('No pending comments');
        const pick = await vscode.window.showQuickPick(pending.map((r) => ({ label: r.prompt.slice(0, 80), description: `${r.status} · ${r.requestId}`, id: r.requestId })), { title: 'Send which comment?' });
        if (!pick) return;
        requestId = pick.id;
      }
      const kind = surfaces.preferredClient();
      if (kind === 'none') throw new Error('Set qmdNotebook.agent.preferredClient to claude or codex');
      if (!surfaces.liveSession(kind)) await surfaces.startLive(kind);
      if (await surfaces.sendToLive(handoffText(requestId), kind)) requests.markDelivered(requestId, kind === 'codex' ? 'Codex' : 'Claude Code');
    }),
  ];
}
