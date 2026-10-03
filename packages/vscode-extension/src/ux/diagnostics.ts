/**
 * Diagnostics for malformed or surprising fences:
 *  - unmatched ```{python} openers found when the file was parsed (from document metadata);
 *  - Markdown cells that currently contain a complete executable fence (they will turn into a
 *    code cell after save + reopen; suggest Convert to Python instead).
 */
import * as vscode from 'vscode';
import { parseQmd } from '../notebook';
import { cellRecord, documentRecord } from '../notebook/serializer';
import { isQmdNotebook } from '../util/config';

export class QmdDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('qmd-notebook');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor() {
    this.disposables.push(
      this.collection,
      vscode.workspace.onDidOpenNotebookDocument((nb) => this.schedule(nb)),
      vscode.workspace.onDidChangeNotebookDocument((e) => this.schedule(e.notebook)),
      vscode.workspace.onDidSaveNotebookDocument((nb) => this.schedule(nb)),
      vscode.workspace.onDidCloseNotebookDocument((nb) => {
        for (const cell of nb.getCells()) this.collection.delete(cell.document.uri);
      }),
    );
    for (const nb of vscode.workspace.notebookDocuments) this.schedule(nb);
  }

  private schedule(nb: vscode.NotebookDocument): void {
    if (!isQmdNotebook(nb)) return;
    const key = nb.uri.toString();
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.refresh(nb);
      }, 300),
    );
  }

  refresh(nb: vscode.NotebookDocument): void {
    if (nb.isClosed) return;
    const fileDiagnostics = documentRecord(nb)?.diagnostics ?? [];
    for (const cell of nb.getCells()) {
      const diags: vscode.Diagnostic[] = [];
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        const text = cell.document.getText();
        if (/^\s*`{3,}\s*\{python/m.test(text)) {
          const parsed = parseQmd(text);
          for (const d of parsed.diagnostics) {
            const line = Math.min(d.line, Math.max(0, cell.document.lineCount - 1));
            const range = cell.document.lineAt(line).range;
            const diag = new vscode.Diagnostic(range, d.message, vscode.DiagnosticSeverity.Warning);
            diag.source = 'QMD Notebook';
            diags.push(diag);
          }
          for (const seg of parsed.segments) {
            if (seg.kind !== 'python') continue;
            const line = Math.min(seg.lines.startLine, Math.max(0, cell.document.lineCount - 1));
            const range = cell.document.lineAt(line).range;
            const diag = new vscode.Diagnostic(
              range,
              'This Markdown cell contains an executable ```{python} fence. It will become a separate code cell the next time the file is opened; use "Convert Cell to Python" or "Edit in Source" to restructure it deliberately.',
              vscode.DiagnosticSeverity.Information,
            );
            diag.source = 'QMD Notebook';
            diags.push(diag);
          }
        }
        // Diagnostics recorded at parse time map to the cell whose original span contains the line.
        const rec = cellRecord(cell);
        if (rec?.origLines && !rec.fresh) {
          for (const d of fileDiagnostics) {
            if (d.line >= rec.origLines.startLine && d.line < rec.origLines.endLine) {
              const local = Math.min(d.line - rec.origLines.startLine, Math.max(0, cell.document.lineCount - 1));
              const range = cell.document.lineAt(local).range;
              if (diags.some((x) => x.range.start.line === local)) continue;
              const diag = new vscode.Diagnostic(range, d.message, vscode.DiagnosticSeverity.Warning);
              diag.source = 'QMD Notebook';
              diags.push(diag);
            }
          }
        }
      }
      this.collection.set(cell.document.uri, diags);
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}
