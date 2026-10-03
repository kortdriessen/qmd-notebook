/**
 * Conservative line-aware QMD segmenter.
 *
 * Executable cells follow Quarto's own rule (quarto-cli src/core/lib/break-quarto-md.ts):
 * a backtick fence (3+ ticks, any leading whitespace) whose info block is `{python ...}`,
 * closed by a line containing exactly the same number of backticks. Only `{python}` becomes a
 * code cell; every other construct (tilde fences, plain ```python blocks, other engines,
 * `{{python}}` literals, indented/nested fences, YAML front matter) stays opaque Markdown.
 *
 * Protective (non-executable) fences follow CommonMark so that a ```{python} line inside a
 * longer outer fence is not treated as a cell.
 */
import { parseCellOptions } from './cellOptions';
import {
  DEFAULT_FENCE_LENGTH,
  type Eol,
  type LineSpan,
  type MarkdownSegment,
  type PythonSegment,
  type QmdDiagnostic,
  type QmdDocument,
  type QmdSegment,
} from './model';

interface Line {
  text: string;
  eol: string;
}

const PYTHON_OPENER = /^\s*(`{3,})\s*\{python( *[ ,].*)?\}\s*$/;
const BACKTICK_CLOSER = /^\s*(`+)\s*$/;
const GENERIC_BACKTICK_OPENER = /^ {0,3}(`{3,})([^`]*)$/;
const GENERIC_TILDE_OPENER = /^ {0,3}(~{3,})(.*)$/;
const YAML_DELIM = /^---\s*$/;
const YAML_END = /^(---|\.\.\.)\s*$/;
const BLANK = /^\s*$/;

export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      const hasCr = i > start && text.charCodeAt(i - 1) === 13;
      const end = hasCr ? i - 1 : i;
      lines.push({ text: text.slice(start, end), eol: hasCr ? '\r\n' : '\n' });
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), eol: '' });
  }
  return lines;
}

export function detectEol(lines: Line[]): Eol {
  let lf = 0;
  let crlf = 0;
  for (const l of lines) {
    if (l.eol === '\n') lf++;
    else if (l.eol === '\r\n') crlf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

function joinLines(lines: Line[], from: number, to: number): string {
  let out = '';
  for (let i = from; i < to; i++) out += lines[i]!.text + lines[i]!.eol;
  return out;
}

/** Returns the exclusive end index of a YAML front matter block starting at line 0, or 0 if none. */
function frontMatterEnd(lines: Line[]): number {
  if (lines.length === 0 || !YAML_DELIM.test(lines[0]!.text)) return 0;
  for (let i = 1; i < lines.length; i++) {
    if (YAML_END.test(lines[i]!.text)) return i + 1;
  }
  return 0; // unterminated: not front matter (Pandoc treats it as a horizontal rule)
}

export function parseQmd(text: string): QmdDocument {
  // A byte-order mark is document trivia, never cell content (VS Code text models would strip it
  // from a cell and the byte-exact round trip would break).
  let bom = '';
  if (text.startsWith('\uFEFF')) {
    bom = '\uFEFF';
    text = text.slice(1);
  }
  const lines = splitLines(text);
  const eol = detectEol(lines);
  const finalEol = text.length === 0 || text.endsWith('\n');
  const diagnostics: QmdDiagnostic[] = [];
  const segments: QmdSegment[] = [];
  const fenceLengths: number[] = [];

  const opaqueUntil = frontMatterEnd(lines);

  let leading = bom;
  let regionStart = 0; // first line of the current markdown region (inclusive)
  let i = 0;

  const flushMarkdown = (endExclusive: number): void => {
    if (endExclusive <= regionStart) return;
    // Trim whitespace-only lines at both ends; those become trivia.
    let first = regionStart;
    while (first < endExclusive && BLANK.test(lines[first]!.text)) first++;
    if (first === endExclusive) {
      // whitespace-only region → owned by previous segment trailing (or document leading)
      const ws = joinLines(lines, regionStart, endExclusive);
      appendTrailing(ws, regionStart, endExclusive);
      return;
    }
    let last = endExclusive - 1;
    while (last > first && BLANK.test(lines[last]!.text)) last--;
    const leadingWs = joinLines(lines, regionStart, first);
    if (leadingWs) appendTrailing(leadingWs, regionStart, first);
    let textOut = '';
    for (let k = first; k < last; k++) textOut += lines[k]!.text + lines[k]!.eol;
    textOut += lines[last]!.text;
    const trailing = lines[last]!.eol + joinLines(lines, last + 1, endExclusive);
    const seg: MarkdownSegment = {
      kind: 'markdown',
      text: textOut,
      trailing,
      lines: { startLine: first, endLine: endExclusive },
      contentLines: { startLine: first, endLine: last + 1 },
    };
    segments.push(seg);
  };

  const appendTrailing = (ws: string, _from: number, to: number): void => {
    const prev = segments[segments.length - 1];
    if (!prev) {
      leading += ws;
      return;
    }
    prev.trailing += ws;
    prev.lines = { startLine: prev.lines.startLine, endLine: to };
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (i < opaqueUntil) {
      i++;
      continue;
    }
    const py = PYTHON_OPENER.exec(line.text);
    if (py) {
      const ticks = py[1]!.length;
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const m = BACKTICK_CLOSER.exec(lines[j]!.text);
        if (m && m[1]!.length === ticks) {
          close = j;
          break;
        }
      }
      if (close < 0) {
        diagnostics.push({
          line: i,
          message: `Unmatched executable Python fence (expected a closing line with ${ticks} backticks). The remainder is shown as Markdown.`,
          severity: 'warning',
        });
        i++;
        continue;
      }
      flushMarkdown(i);
      const bodyStart = i + 1;
      const bodyEnd = close; // exclusive
      let source = '';
      let bodyEol = '';
      if (bodyEnd > bodyStart) {
        for (let k = bodyStart; k < bodyEnd - 1; k++) source += lines[k]!.text + lines[k]!.eol;
        source += lines[bodyEnd - 1]!.text;
        bodyEol = lines[bodyEnd - 1]!.eol;
      }
      // Trailing whitespace-only lines after the closer belong to this segment.
      let t = close + 1;
      while (t < lines.length && BLANK.test(lines[t]!.text)) t++;
      const trailing = lines[close]!.eol + joinLines(lines, close + 1, t);
      const seg: PythonSegment = {
        kind: 'python',
        opener: line.text,
        openerEol: line.eol,
        source,
        bodyEol,
        closer: lines[close]!.text,
        trailing,
        lines: { startLine: i, endLine: t },
        bodyLines: { startLine: bodyStart, endLine: bodyEnd },
        options: parseCellOptions(source),
      };
      segments.push(seg);
      fenceLengths.push(ticks);
      i = t;
      regionStart = t;
      continue;
    }
    const gb = GENERIC_BACKTICK_OPENER.exec(line.text);
    const gt = gb ? null : GENERIC_TILDE_OPENER.exec(line.text);
    const generic = gb ?? gt;
    if (generic) {
      const ch = generic[1]![0]!;
      const len = generic[1]!.length;
      const closer = new RegExp(`^ {0,3}(${ch === '`' ? '`' : '~'}{${len},})\\s*$`);
      let j = i + 1;
      while (j < lines.length && !closer.test(lines[j]!.text)) j++;
      // unclosed fence extends to EOF (CommonMark); either way the content is Markdown
      i = j < lines.length ? j + 1 : lines.length;
      continue;
    }
    i++;
  }
  flushMarkdown(lines.length);

  const fenceLength = mode(fenceLengths) ?? DEFAULT_FENCE_LENGTH;
  return { leading, eol, finalEol, fenceLength, segments, diagnostics };
}

function mode(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<number, number>();
  let best = values[0]!;
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestCount || (c === bestCount && v < best)) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/** Extract a `jupyter:` kernel hint from YAML front matter without a YAML library. */
export function readJupyterHint(text: string): string | null {
  const lines = splitLines(text);
  const end = frontMatterEnd(lines);
  for (let i = 1; i < end - 1; i++) {
    const m = /^jupyter:\s*(.*)$/.exec(lines[i]!.text);
    if (!m) continue;
    const value = m[1]!.trim().replace(/^['"]|['"]$/g, '');
    if (value) return value;
    // block form: jupyter:\n  kernelspec:\n    name: python3
    for (let j = i + 1; j < end - 1; j++) {
      const l = lines[j]!.text;
      if (!/^\s+/.test(l)) break;
      const n = /^\s+name:\s*(.*)$/.exec(l);
      if (n) return n[1]!.trim().replace(/^['"]|['"]$/g, '');
    }
    return null;
  }
  return null;
}

export function lineSpanOfSegment(seg: QmdSegment): LineSpan {
  return seg.kind === 'python' ? seg.bodyLines : seg.contentLines;
}
