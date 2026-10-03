/**
 * Builds bounded, structured context packets from the live notebook: cells, selections, outputs.
 * Shared by the MCP bridge (read_* tools, get_active_context) and by Ask Agent requests.
 */
import * as vscode from 'vscode';
import { hashBytes, hashText, makeOutputId, type CellInfo, type OutputItemSummary, type OutputSummary, type RangeInfo, type RequestAttachment } from '@qmd-notebook/shared';
import { cellRecord, emitNotebook } from '../notebook/serializer';
import { cellIdOf } from '../notebook/identity';
import { getSetting } from '../util/config';

const TEXT_MIMES = new Set(['text/plain', 'text/html', 'text/markdown', 'text/latex', 'application/json', 'image/svg+xml', 'application/vnd.code.notebook.stdout', 'application/vnd.code.notebook.stderr', 'application/vnd.code.notebook.error']);

export function isTextMime(mime: string): boolean {
  return TEXT_MIMES.has(mime) || mime.startsWith('text/') || mime.endsWith('+json') || mime.endsWith('+xml');
}

export function outputHash(output: vscode.NotebookCellOutput): string {
  const parts = output.items.map((i) => `${i.mime}:${hashBytes(i.data)}`).join('|');
  return hashText(parts);
}

export function outputIdFor(cellId: string, index: number, output: vscode.NotebookCellOutput): string {
  return makeOutputId(cellId, index, outputHash(output));
}

export function summarizeOutputItem(item: vscode.NotebookCellOutputItem, maxChars: number): OutputItemSummary {
  const summary: OutputItemSummary = { mime: item.mime, bytes: item.data.byteLength };
  if (isTextMime(item.mime)) {
    let text = Buffer.from(item.data).toString('utf8');
    if (item.mime === 'application/vnd.code.notebook.error') {
      try {
        const err = JSON.parse(text);
        text = `${err.name}: ${err.message}\n${stripAnsi(String(err.stack ?? ''))}`;
      } catch {
        /* keep raw */
      }
    }
    if (item.mime === 'text/html') text = compactHtml(text, maxChars);
    if (text.length > maxChars) {
      summary.text = text.slice(0, maxChars);
      summary.truncated = true;
    } else summary.text = text;
  }
  return summary;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/** Reduce a pandas-style HTML table to something an agent can read; keeps the raw HTML if short. */
export function compactHtml(html: string, maxChars: number): string {
  if (html.length <= maxChars) return html;
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(tr|p|div|h\d|li)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Comment threads are rendered as transient outputs; they are UI, not results, so agents never see them as outputs. */
export const COMMENT_OUTPUT_MIME = 'application/x-qmd-comment+json';

export function isCommentOutput(output: vscode.NotebookCellOutput): boolean {
  return output.items.length > 0 && output.items.every((i) => i.mime === COMMENT_OUTPUT_MIME);
}

/** The cell's real outputs with their true indices (comment-thread outputs skipped). */
export function realOutputs(cell: vscode.NotebookCell): Array<{ output: vscode.NotebookCellOutput; index: number }> {
  return cell.outputs.map((output, index) => ({ output, index })).filter((o) => !isCommentOutput(o.output));
}

export function summarizeOutputs(cell: vscode.NotebookCell, cellId: string, maxCharsPerItem = 2000): OutputSummary[] {
  return realOutputs(cell).map(({ output: o, index }) => ({
    outputId: outputIdFor(cellId, index, o),
    index,
    items: o.items.map((i) => summarizeOutputItem(i, maxCharsPerItem)),
  }));
}

export function cellInfo(cell: vscode.NotebookCell, options: { includeOutputs?: boolean; maxSourceChars?: number; sourceLines?: { start: number; end: number } | null; running?: boolean } = {}): CellInfo {
  const rec = cellRecord(cell);
  const cellId = cellIdOf(cell) ?? `unassigned:${cell.index}`;
  const fullSource = cell.document.getText();
  const max = options.maxSourceChars ?? Number.MAX_SAFE_INTEGER;
  const truncated = fullSource.length > max;
  const summary = cell.executionSummary;
  const info: CellInfo = {
    cellId,
    index: cell.index,
    kind: cell.kind === vscode.NotebookCellKind.Code ? 'python' : 'markdown',
    language: cell.document.languageId,
    source: truncated ? fullSource.slice(0, max) : fullSource,
    sourceHash: hashText(fullSource),
    sourceBytes: Buffer.byteLength(fullSource, 'utf8'),
    options: rec?.options && Object.keys(rec.options).length ? rec.options : undefined,
    executionOrder: summary?.executionOrder ?? null,
    executionSuccess: summary?.success ?? null,
    running: options.running ?? false,
    sourceLines: options.sourceLines ?? undefined,
  };
  if (truncated) info.truncated = true;
  if (options.includeOutputs !== false) info.outputs = summarizeOutputs(cell, cellId);
  return info;
}

/** 1-based line spans of every cell as a save would write them. */
export function sourceLineMap(nb: vscode.NotebookDocument): Array<{ start: number; end: number }> {
  try {
    const emitted = emitNotebook(nb);
    return emitted.cellLines.map((l) => ({ start: l.startLine + 1, end: Math.max(l.startLine + 1, l.endLine) }));
  } catch {
    return [];
  }
}

export function rangeInfo(r: vscode.Range): RangeInfo {
  return { startLine: r.start.line, startCharacter: r.start.character, endLine: r.end.line, endCharacter: r.end.character };
}

/** The current text selection inside a cell of the given notebook, if a cell editor has focus. */
export function currentCellSelection(nb: vscode.NotebookDocument): { cell: vscode.NotebookCell; text: string; range: vscode.Range } | null {
  const text = vscode.window.activeTextEditor;
  if (!text || text.document.uri.scheme !== 'vscode-notebook-cell') return null;
  const cell = nb.getCells().find((c) => c.document === text.document);
  if (!cell) return null;
  const sel = text.selection;
  if (sel.isEmpty) return null;
  return { cell, text: text.document.getText(sel), range: sel };
}

export function attachmentForCell(cell: vscode.NotebookCell, kind: 'cell' | 'neighbor', maxChars: number): RequestAttachment {
  const source = cell.document.getText();
  const outputs = kind === 'cell' ? summarizeOutputs(cell, cellIdOf(cell) ?? '', 1500) : [];
  const firstText = outputs.flatMap((o) => o.items).find((i) => i.text)?.text;
  return {
    kind,
    cellId: cellIdOf(cell) ?? `unassigned:${cell.index}`,
    cellKind: cell.kind === vscode.NotebookCellKind.Code ? 'python' : 'markdown',
    sourceHash: hashText(source),
    source: source.length > maxChars ? source.slice(0, maxChars) : source,
    executionOrder: cell.executionSummary?.executionOrder ?? null,
    outputText: kind === 'cell' ? firstText : undefined,
    imageAvailable: kind === 'cell' ? cell.outputs.some((o) => o.items.some((i) => i.mime.startsWith('image/'))) : undefined,
  };
}

export function attachmentForOutput(cell: vscode.NotebookCell, index: number, maxChars: number): RequestAttachment | null {
  const output = cell.outputs[index];
  const id = cellIdOf(cell);
  if (!output || !id) return null;
  const items = output.items.map((i) => summarizeOutputItem(i, maxChars));
  const preferred = items.find((i) => i.mime.startsWith('image/') && i.mime !== 'image/svg+xml') ?? items.find((i) => i.mime === 'text/html') ?? items.find((i) => i.text) ?? items[0];
  return {
    kind: 'output',
    cellId: id,
    cellKind: 'python',
    sourceHash: hashText(cell.document.getText()),
    source: cell.document.getText().slice(0, maxChars),
    executionOrder: cell.executionSummary?.executionOrder ?? null,
    outputId: outputIdFor(id, index, output),
    outputMime: preferred?.mime,
    outputText: items.find((i) => i.text)?.text,
    imageAvailable: output.items.some((i) => i.mime.startsWith('image/')),
  };
}

export function neighborAttachments(nb: vscode.NotebookDocument, index: number, maxChars: number): RequestAttachment[] {
  const n = getSetting<number>('agent.contextNeighborCells', 1);
  const out: RequestAttachment[] = [];
  for (let i = Math.max(0, index - n); i <= Math.min(nb.cellCount - 1, index + n); i++) {
    if (i === index) continue;
    out.push(attachmentForCell(nb.cellAt(i), 'neighbor', maxChars));
  }
  return out;
}

export function cellIdSafe(cell: vscode.NotebookCell): string {
  return cellIdOf(cell) ?? `unassigned:${cell.index}`;
}
