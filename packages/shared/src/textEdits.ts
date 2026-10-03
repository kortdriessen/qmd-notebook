/**
 * Targeted edits inside a cell: exact oldText → newText substitutions, the same contract agents
 * know from file-edit tools. Pure functions so the bridge and the tests share one implementation.
 */

export interface TextReplacement {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export type TextEditFailure = 'empty' | 'identical' | 'not-found' | 'ambiguous';

export class TextEditError extends Error {
  constructor(
    public readonly reason: TextEditFailure,
    public readonly index: number,
    message: string,
    public readonly occurrences = 0,
    public readonly lines: number[] = [],
    public readonly hint?: string,
    public readonly candidateLines?: number[],
  ) {
    super(message);
  }
}

export interface AppliedReplacement {
  index: number;
  occurrences: number;
  /** 1-based line numbers where the replacement started (in the text as it was before that edit). */
  lines: number[];
}

function occurrencesOf(text: string, needle: string): number[] {
  const starts: number[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i < 0) break;
    starts.push(i);
    from = i + needle.length;
  }
  return starts;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const collapseWs = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();

/** Lines whose whitespace-collapsed text contains the collapsed first line of the needle. */
function whitespaceCandidates(text: string, needle: string): number[] {
  const first = collapseWs(needle.split('\n').find((l) => l.trim()) ?? '');
  if (!first) return [];
  const out: number[] = [];
  text.split('\n').forEach((l, i) => {
    if (collapseWs(l).includes(first)) out.push(i + 1);
  });
  return out;
}

/**
 * Apply the replacements in order (later ones see the result of earlier ones). Throws
 * TextEditError, leaving nothing half-applied, when an oldText is empty, identical to its newText,
 * missing, or ambiguous without replaceAll.
 */
export function applyTextEdits(text: string, edits: TextReplacement[]): { text: string; applied: AppliedReplacement[] } {
  let current = text;
  const applied: AppliedReplacement[] = [];
  edits.forEach((e, index) => {
    if (!e.oldText) throw new TextEditError('empty', index, `edit ${index + 1}: oldText is empty; use replace_cell_source to rewrite a cell or insert_cell to add one`);
    if (e.oldText === e.newText) throw new TextEditError('identical', index, `edit ${index + 1}: oldText and newText are identical`);
    const starts = occurrencesOf(current, e.oldText);
    if (starts.length === 0) {
      const candidates = whitespaceCandidates(current, e.oldText);
      const hint = candidates.length
        ? `oldText was not found verbatim but a whitespace-insensitive match exists near line${candidates.length > 1 ? 's' : ''} ${candidates.join(', ')}: check indentation, tabs vs spaces and line breaks`
        : undefined;
      throw new TextEditError('not-found', index, `edit ${index + 1}: oldText not found in the cell${hint ? ` (${hint})` : ''}`, 0, [], hint, candidates.length ? candidates : undefined);
    }
    if (starts.length > 1 && !e.replaceAll) {
      const lines = starts.map((s) => lineOf(current, s));
      throw new TextEditError('ambiguous', index, `edit ${index + 1}: oldText occurs ${starts.length} times (lines ${lines.join(', ')}); include more surrounding context to make it unique, or set replaceAll: true`, starts.length, lines);
    }
    const lines = starts.map((s) => lineOf(current, s));
    if (e.replaceAll) current = current.split(e.oldText).join(e.newText);
    else current = current.slice(0, starts[0]!) + e.newText + current.slice(starts[0]! + e.oldText.length);
    applied.push({ index, occurrences: starts.length, lines });
  });
  return { text: current, applied };
}

/** The smallest single span of `before` that must be replaced to obtain `after`. */
export function minimalSpan(before: string, after: string): { start: number; end: number; text: string } {
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  return { start: prefix, end: before.length - suffix, text: after.slice(prefix, after.length - suffix) };
}
