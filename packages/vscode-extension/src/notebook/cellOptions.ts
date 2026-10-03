import type { CellOptions } from '@qmd-notebook/shared';

const OPTION_LINE = /^\s*#\|\s?(.*)$/;

/**
 * Parse Quarto `#|` cell options from the top of a Python cell. Only used for behaviour hints
 * (eval, label); the option lines themselves are preserved verbatim as cell source.
 */
export function parseCellOptions(source: string): CellOptions {
  const options: CellOptions = {};
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '') {
      if (Object.keys(options).length === 0) continue;
      break;
    }
    const m = OPTION_LINE.exec(line);
    if (!m) break;
    const body = m[1]!.trim();
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(body);
    if (!kv) continue;
    const key = kv[1]!;
    options[key] = parseScalar(kv[2]!.trim());
  }
  return options;
}

function parseScalar(raw: string): unknown {
  if (raw === '') return null;
  const lower = raw.toLowerCase();
  if (lower === 'true' || lower === 'yes' || lower === 'on') return true;
  if (lower === 'false' || lower === 'no' || lower === 'off') return false;
  if (lower === 'null' || lower === '~') return null;
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) return Number(raw);
  const quoted = /^(['"])(.*)\1$/.exec(raw);
  if (quoted) return quoted[2];
  return raw;
}

export function isEvalDisabled(options: CellOptions | undefined): boolean {
  return options?.eval === false;
}
