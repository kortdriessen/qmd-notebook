import * as vscode from 'vscode';

export const NOTEBOOK_TYPE = 'qmd-notebook';

export function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('qmdNotebook');
}

export function getSetting<T>(key: string, fallback: T): T {
  return config().get<T>(key, fallback);
}

export function isQmdNotebook(doc: vscode.NotebookDocument | undefined | null): doc is vscode.NotebookDocument {
  return !!doc && doc.notebookType === NOTEBOOK_TYPE;
}

export function activeQmdEditor(): vscode.NotebookEditor | undefined {
  const editor = vscode.window.activeNotebookEditor;
  return editor && isQmdNotebook(editor.notebook) ? editor : undefined;
}

export function isWorkspaceTrusted(): boolean {
  return vscode.workspace.isTrusted;
}
