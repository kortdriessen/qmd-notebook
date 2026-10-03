import * as vscode from 'vscode';
import { activeQmdEditor, getSetting, isQmdNotebook } from '../util/config';
import type { SessionRegistry } from '../execution/sessionRegistry';
import type { RequestStore } from '../agent/requestStore';
import { documentIdFor } from '../agent/notebookService';

export type FocusMode = 'nav' | 'edit' | 'none';

/** Best-effort focus mode: a cell editor of the active QMD notebook has text focus → edit. */
export function currentMode(): FocusMode {
  const editor = activeQmdEditor();
  if (!editor) return 'none';
  const text = vscode.window.activeTextEditor;
  if (text && text.document.uri.scheme === 'vscode-notebook-cell') {
    const belongs = editor.notebook.getCells().some((c) => c.document === text.document);
    if (belongs) return 'edit';
  }
  return 'nav';
}

export class StatusBar implements vscode.Disposable {
  private readonly modeItem: vscode.StatusBarItem;
  private readonly kernelItem: vscode.StatusBarItem;
  private readonly bridgeItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private bridgeSummary: { clients: number; enabled: boolean; pending: number } = { clients: 0, enabled: false, pending: 0 };

  constructor(
    private readonly registry: SessionRegistry,
    private readonly requests: RequestStore,
  ) {
    this.modeItem = vscode.window.createStatusBarItem('qmdNotebook.mode', vscode.StatusBarAlignment.Right, 210);
    this.modeItem.name = 'QMD Notebook: mode';
    this.modeItem.command = 'qmdNotebook.exitToNavigationMode';
    this.kernelItem = vscode.window.createStatusBarItem('qmdNotebook.kernel', vscode.StatusBarAlignment.Right, 209);
    this.kernelItem.name = 'QMD Notebook: kernel';
    this.kernelItem.command = 'qmdNotebook.selectKernel';
    this.bridgeItem = vscode.window.createStatusBarItem('qmdNotebook.bridge', vscode.StatusBarAlignment.Right, 208);
    this.bridgeItem.name = 'QMD Notebook: agent bridge';
    this.bridgeItem.command = 'qmdNotebook.agentConnectionStatus';
    this.disposables.push(
      this.modeItem,
      this.kernelItem,
      this.bridgeItem,
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.onDidChangeActiveNotebookEditor(() => this.update()),
      vscode.window.onDidChangeNotebookEditorSelection(() => this.update()),
      vscode.window.onDidChangeTextEditorSelection(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('qmdNotebook')) this.update();
      }),
      registry.onDidChange(() => this.update()),
      requests.onDidChange(() => this.update()),
      requests.onDidChangeAssignments(() => this.update()),
    );
    this.update();
  }

  setBridgeSummary(summary: { clients: number; enabled: boolean; pending: number }): void {
    this.bridgeSummary = summary;
    this.update();
  }

  update(): void {
    const editor = activeQmdEditor();
    if (!editor) {
      this.modeItem.hide();
      this.kernelItem.hide();
      this.bridgeItem.hide();
      return;
    }
    const mode = currentMode();
    if (getSetting<boolean>('navigation.showModeIndicator', true)) {
      this.modeItem.text = mode === 'edit' ? '$(edit) QMD: EDIT' : '$(list-selection) QMD: NAV';
      this.modeItem.tooltip =
        mode === 'edit'
          ? 'Editing a cell. Escape → navigation mode.'
          : 'Navigation mode: j/k move, a/b insert, Enter edits, m/y convert, d d deletes.';
      this.modeItem.show();
    } else this.modeItem.hide();

    const info = this.registry.kernelInfo(editor.notebook);
    const icon =
      info.status === 'busy' ? '$(sync~spin)' : info.status === 'starting' || info.status === 'restarting' ? '$(loading~spin)' : info.status === 'dead' ? '$(error)' : '$(vm)';
    const name = info.displayName ?? 'no kernel';
    const activity = info.agentActivity ? ` · $(hubot) ${info.agentActivity}` : '';
    this.kernelItem.text = `${icon} ${name} · ${info.status}${activity}`;
    this.kernelItem.tooltip = info.pythonPath ? `${name}\n${info.pythonPath}\nClick to select a kernel` : 'Click to select a kernel';
    this.kernelItem.show();

    const b = this.bridgeSummary;
    const docId = documentIdFor(editor.notebook);
    const assignment = this.requests.assignment(docId);
    const open = this.requests.list('pending', docId).length;
    if (assignment) {
      this.bridgeItem.text = `$(hubot) ${assignment.agentName} watching${open ? ` · ${open} open` : ''}`;
      this.bridgeItem.tooltip = `${assignment.agentName} is watching this notebook for comments (since ${new Date(assignment.since).toLocaleTimeString()}). Click for connection status.`;
    } else {
      this.bridgeItem.text = b.enabled ? `$(plug) no agent watching${open ? ` · ${open} open` : ''}${b.clients ? ` · ${b.clients} connected` : ''}` : '$(debug-disconnect) bridge off';
      this.bridgeItem.tooltip = b.enabled ? 'No agent has focused this notebook yet. In Codex use $focus-notebook <name>; in Claude Code use /focus-notebook <name>. Click for connection status.' : 'Agent bridge disabled (qmdNotebook.agent.enableBridge)';
    }
    this.bridgeItem.show();
    void isQmdNotebook;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
