import * as vscode from 'vscode';
import { NOTEBOOK_TYPE, activeQmdEditor } from '../util/config';
import { isEvalDisabled } from '../notebook/cellOptions';
import { cellRecord } from '../notebook/serializer';
import { cellIdOf } from '../notebook/identity';
import { isPending, type RequestStore } from '../agent/requestStore';

export class QmdCellStatusBarProvider implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];
  /** cell id → label of the last agent edit, cleared after a few seconds. */
  private readonly agentTouched = new Map<string, string>();

  constructor(private readonly requests: RequestStore) {
    this.disposables.push(
      vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, this),
      vscode.window.onDidChangeNotebookEditorSelection(() => this._onDidChange.fire()),
      vscode.window.onDidChangeActiveNotebookEditor(() => this._onDidChange.fire()),
      requests.onDidChange(() => this._onDidChange.fire()),
      this._onDidChange,
    );
  }

  markAgentTouched(cellId: string, label: string): void {
    this.agentTouched.set(cellId, label);
    this._onDidChange.fire();
    setTimeout(() => {
      if (this.agentTouched.get(cellId) === label) {
        this.agentTouched.delete(cellId);
        this._onDidChange.fire();
      }
    }, 8000);
  }

  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    const items: vscode.NotebookCellStatusBarItem[] = [];
    const rec = cellRecord(cell);
    if (cell.kind === vscode.NotebookCellKind.Code && isEvalDisabled(rec?.options)) {
      const item = new vscode.NotebookCellStatusBarItem('$(circle-slash) eval: false', vscode.NotebookCellStatusBarAlignment.Left);
      item.tooltip = 'This cell has `#| eval: false`; Run skips it. Click to force-run it in the kernel.';
      item.command = 'qmdNotebook.forceRunCell';
      item.priority = 50;
      items.push(item);
    }
    const id = cellIdOf(cell);
    if (id) {
      const touched = this.agentTouched.get(id);
      if (touched) {
        const item = new vscode.NotebookCellStatusBarItem(`$(hubot) ${touched}`, vscode.NotebookCellStatusBarAlignment.Left);
        item.tooltip = 'Edited through the agent bridge';
        item.priority = 40;
        items.push(item);
      }
      const threads = this.requests.forCell(cell.notebook.uri, id);
      if (threads.length) {
        const pending = threads.filter((t) => isPending(t.status));
        const working = pending.find((t) => t.status === 'working');
        const needsInput = pending.find((t) => t.status === 'needs-input');
        const dots = '●'.repeat(Math.min(pending.length, 5)) + (pending.length > 5 ? `+${pending.length - 5}` : '') + '○'.repeat(Math.min(threads.length - pending.length, 3));
        const icon = needsInput ? '$(question)' : working ? '$(sync~spin)' : '$(comment)';
        const item = new vscode.NotebookCellStatusBarItem(`${icon} ${dots}`, vscode.NotebookCellStatusBarAlignment.Left);
        const lines = threads.map((t) => `${isPending(t.status) ? '●' : '○'} ${t.status}: ${t.prompt.length > 70 ? t.prompt.slice(0, 70) + '…' : t.prompt}`);
        item.tooltip = `${pending.length} open, ${threads.length - pending.length} resolved agent comment(s)\n${lines.join('\n')}\nClick to expand the threads`;
        item.command = { command: 'qmdNotebook.comments.reveal', title: 'Show comments', arguments: [{ cellId: id, uri: cell.notebook.uri.toString() }] };
        item.priority = 45;
        items.push(item);
      }
    }
    const editor = activeQmdEditor();
    const isActive = editor && editor.notebook === cell.notebook && editor.selections.some((r) => r.start === cell.index);
    if (isActive) {
      const ask = new vscode.NotebookCellStatusBarItem('$(comment-discussion) Comment', vscode.NotebookCellStatusBarAlignment.Right);
      ask.tooltip = 'Add a comment for the watching agent about this cell (or the current selection)';
      ask.command = 'qmdNotebook.askAgentAboutCell';
      ask.priority = 5;
      items.push(ask);
    }
    return items;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
