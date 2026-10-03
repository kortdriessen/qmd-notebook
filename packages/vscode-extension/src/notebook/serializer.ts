import * as vscode from 'vscode';
import { newCellId } from '@qmd-notebook/shared';
import { contextFromRecord, emitQmd, parseQmd, readJupyterHint, recordsFromDocument } from './index';
import type { EmitCell, QmdCellRecord, QmdDocumentRecord } from './model';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();

export function cellRecord(cell: { metadata?: { [key: string]: any } | undefined }): QmdCellRecord | null {
  const rec = cell.metadata?.qmd;
  return rec && rec.v === 1 && typeof rec.id === 'string' ? (rec as QmdCellRecord) : null;
}

export function documentRecord(notebook: { metadata?: { [key: string]: any } | undefined }): QmdDocumentRecord | null {
  const rec = notebook.metadata?.qmd;
  return rec && rec.v === 1 ? (rec as QmdDocumentRecord) : null;
}

export function emitCellsFromNotebook(notebook: vscode.NotebookDocument): EmitCell[] {
  return notebook.getCells().map((cell) => ({
    kind: cell.kind === vscode.NotebookCellKind.Code ? 'python' : 'markdown',
    language: cell.document.languageId,
    source: cell.document.getText(),
    record: cellRecord(cell),
  }));
}

/** Emit the current in-memory notebook exactly as a save would. */
export function emitNotebook(notebook: vscode.NotebookDocument) {
  return emitQmd(contextFromRecord(documentRecord(notebook)), emitCellsFromNotebook(notebook));
}

export class QmdSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const text = decoder.decode(content);
    const doc = parseQmd(text);
    const records = recordsFromDocument(doc, newCellId);
    const cells = doc.segments.map((seg, i) => {
      const data =
        seg.kind === 'python'
          ? new vscode.NotebookCellData(vscode.NotebookCellKind.Code, seg.source, 'python')
          : new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, seg.text, 'markdown');
      data.metadata = { qmd: records[i] };
      return data;
    });
    const notebook = new vscode.NotebookData(cells);
    const record: QmdDocumentRecord = {
      v: 1,
      documentId: '',
      leading: doc.leading,
      eol: doc.eol,
      finalEol: doc.finalEol,
      fenceLength: doc.fenceLength,
      diagnostics: doc.diagnostics,
      jupyterHint: readJupyterHint(text),
    };
    notebook.metadata = { qmd: record };
    return notebook;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const record = documentRecord(data);
    const cells: EmitCell[] = data.cells.map((cell) => ({
      kind: cell.kind === vscode.NotebookCellKind.Code ? 'python' : 'markdown',
      language: cell.languageId,
      source: cell.value,
      record: cellRecord(cell),
    }));
    const { text } = emitQmd(contextFromRecord(record), cells);
    return encoder.encode(text);
  }
}

/**
 * Outputs are transient (never saved). The `qmd` metadata records are NOT transient: VS Code
 * strips transient metadata before calling serializeNotebook, and the emitter needs the records
 * to reproduce the original bytes. The extension never edits that metadata after open.
 */
export const SERIALIZER_OPTIONS: vscode.NotebookDocumentContentOptions = {
  transientOutputs: true,
};
