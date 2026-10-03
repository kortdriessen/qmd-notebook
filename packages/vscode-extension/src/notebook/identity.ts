/**
 * Runtime cell identity.
 *
 * Cells that came from the file carry their parse record (including a runtime id) in
 * `metadata.qmd`. That metadata is deliberately NOT transient: VS Code strips transient metadata
 * before handing NotebookData to the serializer on save, and the emitter needs the records.
 * We therefore never edit metadata after open (that would dirty the document); cells created by
 * VS Code's own commands (insert, paste, split, undo) get their runtime id from a side table
 * keyed by the live NotebookCell object, which is stable for the cell's lifetime.
 */
import * as vscode from 'vscode';
import { newCellId } from '@qmd-notebook/shared';
import { isQmdNotebook } from '../util/config';
import type { QmdCellRecord } from './model';
import { cellRecord } from './serializer';

export function freshRecord(kind: 'python' | 'markdown'): QmdCellRecord {
  return {
    v: 1,
    id: newCellId(),
    kind,
    fresh: true,
    origSource: '',
    origBody: '',
    trailing: '',
    wasLast: false,
  };
}

export function kindOf(cell: vscode.NotebookCell | vscode.NotebookCellData): 'python' | 'markdown' {
  return cell.kind === vscode.NotebookCellKind.Code ? 'python' : 'markdown';
}

/** Side table for cells without (or with duplicated) record ids. */
const overrides = new WeakMap<vscode.NotebookCell, string>();

/** Runtime id of a cell: side-table override first, then the parse record. */
export function cellIdOf(cell: vscode.NotebookCell): string | null {
  return overrides.get(cell) ?? cellRecord(cell)?.id ?? null;
}

/** Find a cell by runtime id. */
export function findCell(nb: vscode.NotebookDocument, cellId: string): vscode.NotebookCell | undefined {
  return nb.getCells().find((c) => cellIdOf(c) === cellId);
}

/** Make sure every cell of the notebook has a unique runtime id (no edits, no dirtying). */
export function ensureIds(nb: vscode.NotebookDocument): boolean {
  if (nb.isClosed) return false;
  const seen = new Set<string>();
  let changed = false;
  for (const cell of nb.getCells()) {
    const existing = overrides.get(cell);
    if (existing && !seen.has(existing)) {
      seen.add(existing);
      continue;
    }
    const rec = cellRecord(cell);
    if (!existing && rec && !seen.has(rec.id)) {
      seen.add(rec.id);
      continue;
    }
    // no record, or a duplicate id (copy/paste, split): allocate a fresh runtime id
    const id = newCellId();
    overrides.set(cell, id);
    seen.add(id);
    changed = true;
  }
  return changed;
}

export class CellIdentityTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidAssign = new vscode.EventEmitter<vscode.NotebookDocument>();
  readonly onDidAssign = this._onDidAssign.event;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidOpenNotebookDocument((nb) => this.check(nb)),
      vscode.workspace.onDidChangeNotebookDocument((e) => {
        if (e.contentChanges.length > 0) this.check(e.notebook);
      }),
      this._onDidAssign,
    );
    for (const nb of vscode.workspace.notebookDocuments) this.check(nb);
  }

  private check(nb: vscode.NotebookDocument): void {
    if (!isQmdNotebook(nb)) return;
    if (ensureIds(nb)) this._onDidAssign.fire(nb);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
