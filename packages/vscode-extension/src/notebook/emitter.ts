/**
 * Deterministic QMD emission from the current cell list.
 *
 * Invariant: with no edits, `emit(parse(text)) === text` byte for byte. Edits only touch the
 * bytes owned by the edited cell (plus minimal separator fix-ups around inserted/moved cells).
 */
import {
  DEFAULT_FENCE_LENGTH,
  type EmitCell,
  type EmitResult,
  type Eol,
  type LineSpan,
  type QmdCellRecord,
  type QmdDocument,
  type QmdDocumentRecord,
} from './model';

export interface EmitContext {
  leading: string;
  eol: Eol;
  finalEol: boolean;
  fenceLength: number;
}

const EOL_RE = /\r?\n/g;

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function toEol(text: string, eol: Eol): string {
  return text.replace(EOL_RE, eol);
}

function countEols(s: string): number {
  return (s.match(/\r?\n/g) ?? []).length;
}

function endsWithEol(s: string): boolean {
  return /\r?\n$/.test(s);
}

function fenceLanguage(cell: EmitCell): string {
  const lang = (cell.language ?? 'python').toLowerCase();
  if (lang === 'shellscript') return 'bash';
  return lang;
}

function countLines(s: string): number {
  return s.length === 0 ? 0 : countEols(s) + (endsWithEol(s) ? 0 : 1);
}

export function emitQmd(ctx: EmitContext, cells: EmitCell[]): EmitResult {
  const { eol } = ctx;
  const fenceLength = ctx.fenceLength || DEFAULT_FENCE_LENGTH;
  let out = ctx.leading;
  let line = countEols(ctx.leading);
  const cellLines: LineSpan[] = [];
  const cellFullLines: LineSpan[] = [];

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    const r = cell.record && !cell.record.fresh ? cell.record : null;
    const isLast = i === cells.length - 1;
    const sameKind = r !== null && r.kind === cell.kind;
    const unchanged = sameKind && normalizeEol(cell.source) === normalizeEol(r.origSource);
    const isNew = r === null || !sameKind;
    const displaced = r !== null && r.wasLast && !isLast;

    let bytes: string;
    let trailing: string;
    let editableStart: number;
    let editableEnd: number;
    const fullStart = line;

    if (cell.kind === 'python') {
      let opener: string;
      let openerEol: string;
      let closer: string;
      let body: string;
      if (sameKind && r) {
        opener = r.opener ?? '`'.repeat(fenceLength) + '{python}';
        openerEol = r.openerEol || eol;
        closer = r.closer ?? '`'.repeat(fenceLength);
        if (unchanged) body = r.origBody;
        else body = cell.source === '' ? '' : toEol(cell.source, eol) + (r.bodyEol || eol);
        trailing = r.trailing;
      } else {
        const ticks = '`'.repeat(fenceLength);
        opener = `${ticks}{${fenceLanguage(cell)}}`;
        openerEol = eol;
        closer = ticks;
        body = cell.source === '' ? '' : toEol(cell.source, eol) + eol;
        trailing = r ? r.trailing : eol + eol;
      }
      bytes = opener + openerEol + body + closer;
      editableStart = line + 1;
      editableEnd = editableStart + countLines(body);
    } else {
      let body: string;
      if (sameKind && r) {
        body = unchanged ? r.origBody : toEol(cell.source, eol);
        trailing = r.trailing;
      } else {
        body = toEol(cell.source, eol);
        trailing = r ? r.trailing : eol + eol;
      }
      bytes = body;
      editableStart = line;
      editableEnd = line + Math.max(1, countLines(body));
    }

    // Separator fix-ups
    if (isLast) {
      if (r && r.wasLast && sameKind) {
        trailing = r.trailing;
      } else if (r && r.wasLast) {
        trailing = r.trailing || (ctx.finalEol ? eol : '');
      } else {
        trailing = ctx.finalEol ? eol : '';
      }
    } else {
      if (!endsWithEol(trailing)) trailing += eol;
      const next = cells[i + 1]!;
      const nextIsNew = !next.record || next.record.fresh || next.record.kind !== next.kind;
      if ((isNew || displaced || nextIsNew) && countEols(trailing) < 2) trailing += eol;
    }

    out += bytes + trailing;
    line += countEols(bytes + trailing);
    cellLines.push({ startLine: editableStart, endLine: editableEnd });
    cellFullLines.push({ startLine: fullStart, endLine: line });
  }
  return { text: out, cellLines, cellFullLines };
}

export function contextFromDocument(doc: QmdDocument): EmitContext {
  return { leading: doc.leading, eol: doc.eol, finalEol: doc.finalEol, fenceLength: doc.fenceLength };
}

export function contextFromRecord(rec: QmdDocumentRecord | undefined | null): EmitContext {
  return {
    leading: rec?.leading ?? '',
    eol: rec?.eol ?? '\n',
    finalEol: rec?.finalEol ?? true,
    fenceLength: rec?.fenceLength ?? DEFAULT_FENCE_LENGTH,
  };
}

/** Build cell records for a freshly parsed document. */
export function recordsFromDocument(doc: QmdDocument, makeId: () => string): QmdCellRecord[] {
  return doc.segments.map((seg, idx) => {
    const wasLast = idx === doc.segments.length - 1;
    if (seg.kind === 'python') {
      return {
        v: 1,
        id: makeId(),
        kind: 'python',
        origSource: seg.source,
        origBody: seg.source + seg.bodyEol,
        opener: seg.opener,
        openerEol: seg.openerEol,
        closer: seg.closer,
        bodyEol: seg.bodyEol,
        trailing: seg.trailing,
        wasLast,
        origLines: seg.bodyLines,
        options: seg.options,
      };
    }
    return {
      v: 1,
      id: makeId(),
      kind: 'markdown',
      origSource: seg.text,
      origBody: seg.text,
      trailing: seg.trailing,
      wasLast,
      origLines: seg.contentLines,
    };
  });
}
