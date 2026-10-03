/**
 * "Agent Requests" tree view: one node per request thread with its messages and attachments.
 */
import * as vscode from 'vscode';
import type { RequestPacket } from '@qmd-notebook/shared';
import { findCell, freshRecord } from '../notebook/identity';
import { isQmdNotebook } from '../util/config';
import { handoffText } from './commentThreads';
import { isPending, type RequestStore } from './requestStore';

type Node = { type: 'request'; request: RequestPacket } | { type: 'message'; request: RequestPacket; index: number } | { type: 'attachment'; request: RequestPacket; index: number } | { type: 'info'; label: string; description?: string };

function statusIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case 'working':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('notebookStatusRunningIcon.foreground'));
    case 'completed':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('notebookStatusSuccessIcon.foreground'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('notebookStatusErrorIcon.foreground'));
    case 'cancelled':
      return new vscode.ThemeIcon('circle-slash');
    case 'needs-input':
      return new vscode.ThemeIcon('question', new vscode.ThemeColor('editorWarning.foreground'));
    case 'delivered':
      return new vscode.ThemeIcon('mail-read');
    default:
      return new vscode.ThemeIcon('mail');
  }
}

export class RequestsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly view: vscode.TreeView<Node>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly requests: RequestStore) {
    this.view = vscode.window.createTreeView('qmdNotebook.requests', { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      this.view,
      requests.onDidChange(() => {
        this._onDidChangeTreeData.fire(undefined);
        const pending = requests.list('pending').length;
        this.view.badge = pending ? { value: pending, tooltip: `${pending} pending agent request(s)` } : undefined;
      }),
      vscode.commands.registerCommand('qmdNotebook.showRequests', async (requestId?: string) => {
        await vscode.commands.executeCommand('qmdNotebook.requests.focus');
        if (requestId) {
          const r = requests.get(requestId);
          if (r) await this.view.reveal({ type: 'request', request: r }, { select: true, expand: true });
        }
      }),
      vscode.commands.registerCommand('qmdNotebook.copyRequestToken', async (node?: Node) => {
        const r = node?.type === 'request' ? node.request : undefined;
        if (!r) return;
        await vscode.env.clipboard.writeText(handoffText(r.requestId));
        vscode.window.setStatusBarMessage('$(check) Handoff copied', 3000);
      }),
      vscode.commands.registerCommand('qmdNotebook.copyThreadAsMarkdown', async (node?: Node) => {
        const r = node && 'request' in node ? node.request : undefined;
        if (!r) return;
        await vscode.env.clipboard.writeText(requests.threadAsMarkdown(r));
        vscode.window.setStatusBarMessage('$(check) Thread copied as Markdown', 3000);
      }),
      vscode.commands.registerCommand('qmdNotebook.cancelRequest', (node?: Node) => {
        if (node?.type === 'request') requests.cancel(node.request.requestId);
      }),
      vscode.commands.registerCommand('qmdNotebook.clearFinishedRequests', () => requests.clearFinished()),
      vscode.commands.registerCommand('qmdNotebook.revealRequestCell', async (node?: Node) => {
        const r = node && 'request' in node ? node.request : undefined;
        if (!r) return;
        await this.revealCell(r);
      }),
      vscode.commands.registerCommand('qmdNotebook.insertThreadSummary', async (node?: Node) => {
        const r = node && 'request' in node ? node.request : undefined;
        if (!r) return;
        const nb = vscode.workspace.notebookDocuments.find((n) => n.uri.toString() === r.uri && isQmdNotebook(n));
        if (!nb) throw new Error('The notebook for this request is not open');
        const last = [...r.messages].reverse().find((m) => m.from === 'agent');
        const text = `::: {.callout-note collapse="true" title="Agent note"}\n**Request:** ${r.prompt}\n\n${last ? last.text : '(no agent response recorded)'}\n:::`;
        const anchor = r.cellId ? findCell(nb, r.cellId) : undefined;
        const index = anchor ? anchor.index + 1 : nb.cellCount;
        const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, text, 'markdown');
        data.metadata = { qmd: freshRecord('markdown') };
        const edit = new vscode.WorkspaceEdit();
        edit.set(nb.uri, [vscode.NotebookEdit.insertCells(index, [data])]);
        await vscode.workspace.applyEdit(edit);
        await vscode.window.showNotebookDocument(nb, { selections: [new vscode.NotebookRange(index, index + 1)] });
      }),
    );
  }

  private async revealCell(r: RequestPacket): Promise<void> {
    const uri = vscode.Uri.parse(r.uri);
    const nb = vscode.workspace.notebookDocuments.find((n) => n.uri.toString() === r.uri) ?? (await vscode.workspace.openNotebookDocument(uri));
    const cell = r.cellId ? findCell(nb, r.cellId) : undefined;
    const index = cell?.index ?? 0;
    await vscode.window.showNotebookDocument(nb, { selections: [new vscode.NotebookRange(index, index + 1)] });
    await vscode.commands.executeCommand('qmdNotebook.comments.reveal', { requestId: r.requestId });
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'request') {
      const r = node.request;
      const item = new vscode.TreeItem(r.prompt.length > 70 ? r.prompt.slice(0, 70) + '…' : r.prompt, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = r.requestId;
      item.description = `${r.status} · ${new Date(r.createdAt).toLocaleTimeString()}`;
      item.iconPath = statusIcon(r.status);
      item.tooltip = new vscode.MarkdownString(`**${r.requestId}**\n\n${r.prompt}\n\n${r.uri.split('/').pop()} · ${r.attachments.filter((a) => a.kind !== 'neighbor').map((a) => a.kind).join(', ')}`);
      item.contextValue = isPending(r.status) ? 'request-pending' : 'request-done';
      item.command = { command: 'qmdNotebook.revealRequestCell', title: 'Reveal', arguments: [node] };
      return item;
    }
    if (node.type === 'message') {
      const m = node.request.messages[node.index]!;
      const item = new vscode.TreeItem(m.text.length > 90 ? m.text.slice(0, 90) + '…' : m.text);
      item.description = `${m.from} · ${new Date(m.at).toLocaleTimeString()}`;
      item.iconPath = new vscode.ThemeIcon(m.from === 'agent' ? 'hubot' : m.from === 'user' ? 'account' : 'info');
      item.tooltip = m.text;
      item.contextValue = 'message';
      return item;
    }
    if (node.type === 'attachment') {
      const a = node.request.attachments[node.index]!;
      const item = new vscode.TreeItem(`${a.kind}: ${a.cellId}${a.outputMime ? ` (${a.outputMime})` : ''}`);
      item.iconPath = new vscode.ThemeIcon(a.kind === 'output' ? 'graph' : a.kind === 'selection' ? 'selection' : 'notebook');
      item.tooltip = (a.text ?? a.source ?? '').slice(0, 1000);
      item.contextValue = 'attachment';
      return item;
    }
    const item = new vscode.TreeItem(node.label);
    item.description = node.description;
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.requests.list('all').slice().reverse().map((request) => ({ type: 'request', request }));
    if (node.type === 'request') {
      const r = node.request;
      const attachments: Node[] = r.attachments.map((a, index): Node | null => (a.kind === 'neighbor' ? null : { type: 'attachment', request: r, index })).filter((n): n is Node => n !== null);
      const messages: Node[] = r.messages.map((_, index): Node => ({ type: 'message', request: r, index }));
      return [...attachments, ...messages];
    }
    return [];
  }

  getParent(node: Node): Node | undefined {
    if (node.type === 'message' || node.type === 'attachment') return { type: 'request', request: node.request };
    return undefined;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
