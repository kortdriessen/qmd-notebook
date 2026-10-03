/**
 * Internal document model for QMD parsing and lossless emission.
 *
 * Ownership rule: every byte of the source file is owned by exactly one place:
 *   document.leading      – whitespace-only lines before the first content line
 *   MarkdownSegment.text  – first content line .. last content line (without the final EOL)
 *   MarkdownSegment.trailing – the final EOL plus following whitespace-only lines
 *   PythonSegment.opener/openerEol/body/closer/trailing – the executable fence and its trivia
 */
import type { CellKind, CellOptions } from '@qmd-notebook/shared';

export type Eol = '\n' | '\r\n';

/** 0-based line span; `endLine` is exclusive. */
export interface LineSpan {
  startLine: number;
  endLine: number;
}

export interface QmdDiagnostic {
  /** 0-based line in the source file. */
  line: number;
  message: string;
  severity: 'warning' | 'error';
}

export interface MarkdownSegment {
  kind: 'markdown';
  /** Visible/editable text (content lines joined with their original EOLs, no final EOL). */
  text: string;
  /** Final EOL of the last content line plus following whitespace-only lines. */
  trailing: string;
  lines: LineSpan;
  contentLines: LineSpan;
}

export interface PythonSegment {
  kind: 'python';
  opener: string;
  openerEol: string;
  /** Visible/editable body without the EOL of its last line. */
  source: string;
  /** EOL that terminated the last body line ('' when the body is empty). */
  bodyEol: string;
  closer: string;
  /** Closer EOL plus following whitespace-only lines ('' when the file ends right after the closer). */
  trailing: string;
  lines: LineSpan;
  bodyLines: LineSpan;
  options: CellOptions;
}

export type QmdSegment = MarkdownSegment | PythonSegment;

export interface QmdDocument {
  leading: string;
  eol: Eol;
  finalEol: boolean;
  fenceLength: number;
  segments: QmdSegment[];
  diagnostics: QmdDiagnostic[];
}

/** Per-cell record kept in (transient) notebook cell metadata under `metadata.qmd`. */
export interface QmdCellRecord {
  v: 1;
  id: string;
  /** Kind at parse time; a cell converted by the user keeps this record but changes NotebookCellKind. */
  kind: CellKind;
  /** True for cells created in-session (no original bytes); emitted as new segments. */
  fresh?: boolean;
  /** Visible source at parse time (used to detect "unchanged" for byte-exact emission). */
  origSource: string;
  /** Exact original bytes of the editable region (markdown text, or python body incl. its final EOL). */
  origBody: string;
  opener?: string;
  openerEol?: string;
  closer?: string;
  bodyEol?: string;
  trailing: string;
  wasLast: boolean;
  origLines?: LineSpan;
  options?: CellOptions;
}

/** Document-level record kept in (transient) notebook metadata under `metadata.qmd`. */
export interface QmdDocumentRecord {
  v: 1;
  documentId: string;
  leading: string;
  eol: Eol;
  finalEol: boolean;
  fenceLength: number;
  diagnostics: QmdDiagnostic[];
  /** Front matter hints, parsed non-destructively. */
  jupyterHint?: string | null;
}

/** Input to the emitter: the current cell list. */
export interface EmitCell {
  kind: CellKind;
  /** Language id for code cells (python by default). */
  language?: string;
  source: string;
  record?: QmdCellRecord | null;
}

export interface EmitResult {
  text: string;
  /** Line span (0-based, exclusive end) of each cell's editable region in the emitted text. */
  cellLines: LineSpan[];
  /** Line span of each whole cell including fence lines. */
  cellFullLines: LineSpan[];
}

export const DEFAULT_FENCE_LENGTH = 3;
