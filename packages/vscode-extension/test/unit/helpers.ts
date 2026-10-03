import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  contextFromDocument,
  emitQmd,
  parseQmd,
  recordsFromDocument,
  type EmitCell,
  type EmitContext,
  type QmdCellRecord,
  type QmdDocument,
} from '../../src/notebook';

export function findFixturesDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'fixtures', 'qmd');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('fixtures/qmd not found above ' + __dirname);
}

export function readFixture(name: string): string {
  return fs.readFileSync(path.join(findFixturesDir(), name), 'utf8');
}

export function listFixtures(): string[] {
  return fs
    .readdirSync(findFixturesDir())
    .filter((f) => f.endsWith('.qmd'))
    .sort();
}

let counter = 0;
export const makeId = (): string => `qmdcell_test${(counter++).toString().padStart(4, '0')}`;

export interface Loaded {
  doc: QmdDocument;
  ctx: EmitContext;
  records: QmdCellRecord[];
  cells: EmitCell[];
}

export function load(text: string): Loaded {
  const doc = parseQmd(text);
  const ctx = contextFromDocument(doc);
  const records = recordsFromDocument(doc, makeId);
  const cells: EmitCell[] = doc.segments.map((seg, i) => ({
    kind: seg.kind,
    language: seg.kind === 'python' ? 'python' : 'markdown',
    source: seg.kind === 'python' ? seg.source : seg.text,
    record: records[i]!,
  }));
  return { doc, ctx, records, cells };
}

export function emit(loaded: Loaded, cells = loaded.cells): string {
  return emitQmd(loaded.ctx, cells).text;
}

export function py(source: string): EmitCell {
  return { kind: 'python', language: 'python', source, record: null };
}

export function md(source: string): EmitCell {
  return { kind: 'markdown', language: 'markdown', source, record: null };
}
