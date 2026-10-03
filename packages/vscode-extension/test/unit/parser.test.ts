import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQmd, readJupyterHint } from '../../src/notebook';
import { emit, listFixtures, load, readFixture } from './helpers';

const kinds = (text: string) => parseQmd(text).segments.map((s) => s.kind[0]).join('');
const pySources = (text: string) =>
  parseQmd(text)
    .segments.filter((s) => s.kind === 'python')
    .map((s) => (s as { source: string }).source);

test('every fixture round-trips byte for byte with no edits', () => {
  for (const name of listFixtures()) {
    const text = readFixture(name);
    const loaded = load(text);
    assert.equal(emit(loaded), text, `round trip failed for ${name}`);
  }
});

test('empty file', () => {
  const doc = parseQmd('');
  assert.equal(doc.segments.length, 0);
  assert.equal(doc.finalEol, true);
});

test('markdown only', () => {
  assert.equal(kinds(readFixture('markdown-only.qmd')), 'm');
});

test('basic: yaml + markdown + one python cell', () => {
  const text = readFixture('basic.qmd');
  assert.equal(kinds(text), 'mpm');
  assert.deepEqual(pySources(text), ['import numpy as np\nx = np.arange(5)']);
  assert.equal(readJupyterHint(text), 'python3');
  const doc = parseQmd(text);
  const first = doc.segments[0]!;
  assert.equal(first.kind, 'markdown');
  assert.ok(first.kind === 'markdown' && first.text.startsWith('---\ntitle: "Basic"'));
});

test('adjacent cells become separate python cells without empty markdown cells', () => {
  const text = readFixture('adjacent-cells.qmd');
  assert.equal(kinds(text), 'mpppp');
  const doc = parseQmd(text);
  const p1 = doc.segments[1]!;
  const p2 = doc.segments[2]!;
  assert.ok(p1.kind === 'python' && p1.trailing === '\n');
  assert.ok(p2.kind === 'python' && p2.trailing === '\n\n');
  const p3 = doc.segments[3]!;
  assert.ok(p3.kind === 'python' && p3.trailing === '\n\n\n');
});

test('no final newline', () => {
  const text = readFixture('no-final-newline.qmd');
  const doc = parseQmd(text);
  assert.equal(doc.finalEol, false);
  assert.equal(kinds(text), 'mp');
  const last = doc.segments[1]!;
  assert.ok(last.kind === 'python' && last.trailing === '');
});

test('CRLF is detected and preserved', () => {
  const text = readFixture('crlf.qmd');
  const doc = parseQmd(text);
  assert.equal(doc.eol, '\r\n');
  assert.deepEqual(pySources(text), ['x = 1\r\ny = 2']);
});

test('nested fences protect inner python fences', () => {
  const text = readFixture('nested-fences.qmd');
  assert.deepEqual(pySources(text), ['print("real")']);
});

test('tilde fences are never executable and protect their contents', () => {
  const text = readFixture('tilde-fences.qmd');
  assert.deepEqual(pySources(text), ['real = 1']);
});

test('long fences close only with the same tick count', () => {
  const text = readFixture('long-fences.qmd');
  assert.deepEqual(pySources(text), [
    'x = "````"',
    'y = 2\n````\nstill inside because closer has 4 not 5 ticks',
  ]);
  assert.equal(parseQmd(text).fenceLength, 4);
});

test('attributes on the opener are accepted; {.python} is not executable', () => {
  const text = readFixture('attributes.qmd');
  assert.deepEqual(pySources(text), ['a = 1', 'b = 2', 'c = 3', 'd = 4', 'e = 5']);
});

test('callouts and divs stay markdown while inner cells are still cells', () => {
  const text = readFixture('callouts-divs.qmd');
  assert.equal(kinds(text), 'mpmppm');
});

test('citations, math, shortcodes, raw blocks, mermaid stay markdown', () => {
  const text = readFixture('citations-math-shortcodes-raw-mermaid.qmd');
  assert.deepEqual(pySources(text), ['print("still a cell")']);
});

test('literal {{python}} is not executable', () => {
  const text = readFixture('literal-double-brace.qmd');
  assert.deepEqual(pySources(text), ['print("run")']);
});

test('other engines and plain fences stay markdown', () => {
  const text = readFixture('other-engines.qmd');
  assert.deepEqual(pySources(text), ['only_this = True']);
});

test('python-looking text inside YAML front matter is opaque', () => {
  const text = readFixture('yaml-with-python-text.qmd');
  assert.deepEqual(pySources(text), ['real = True']);
  assert.equal(readJupyterHint(text), 'python3');
});

test('an opener closed only by a much later fence becomes one big cell (Quarto rule)', () => {
  // In the fixture the second ```{python} line is not a closer (it has an info string); the final
  // ``` closes the first opener, exactly as Quarto would execute it.
  const text = readFixture('unmatched-opener.qmd');
  const doc = parseQmd(text);
  assert.equal(doc.diagnostics.length, 0);
  const py = doc.segments.filter((s) => s.kind === 'python');
  assert.equal(py.length, 1);
  const seg = py[0]!;
  assert.ok(seg.kind === 'python' && seg.source.startsWith('x = 1') && seg.source.endsWith('y = 2'));
});

test('a truly unmatched opener produces a diagnostic and stays markdown', () => {
  const text = '# Title\n\n```{python}\nx = 1\n\nText continues without any closing fence.\n';
  const doc = parseQmd(text);
  assert.equal(doc.diagnostics.length, 1);
  assert.equal(doc.diagnostics[0]!.line, 2);
  assert.equal(doc.segments.filter((s) => s.kind === 'python').length, 0);
  assert.equal(kinds(text), 'm');
  assert.equal(emit(load(text)), text);
});

test('fence-like text inside a triple-quoted string: only a bare fence line closes the cell (Quarto rule)', () => {
  // The inner ```{python} line carries an info string, so it is not a closer; the bare ``` after
  // "nested text in string" is. We mirror Quarto so the notebook shows what Quarto will run.
  const text = readFixture('triple-quoted-fence.qmd');
  const sources = pySources(text);
  assert.equal(sources[0], 'doc = """\n```{python}\nnested text in string');
  assert.equal(sources.length, 1);
});

test('cell options are parsed for hints and preserved in source', () => {
  const text = readFixture('cell-options.qmd');
  const doc = parseQmd(text);
  const cells = doc.segments.filter((s) => s.kind === 'python') as Array<{
    options: Record<string, unknown>;
    source: string;
  }>;
  assert.equal(cells[0]!.options.eval, false);
  assert.equal(cells[0]!.options.label, 'setup');
  assert.equal(cells[0]!.options['fig-cap'], 'Not run');
  assert.ok(cells[0]!.source.startsWith('#| label: setup'));
  assert.equal(cells[1]!.options.echo, false);
  assert.equal(cells[1]!.options.eval, undefined);
  // options after a non-option line are ignored
  assert.equal(cells[2]!.options.eval, undefined);
});

test('unicode survives', () => {
  const text = readFixture('unicode.qmd');
  assert.deepEqual(pySources(text), ['名前 = "値"\nprint(f"→ {名前} — ✓")']);
});

test('indented fences follow the Quarto rule (any leading whitespace)', () => {
  const text = readFixture('indented-fence.qmd');
  assert.deepEqual(pySources(text), ['   inside_list = 1', '    four_spaces = 2', 'top = 3']);
});

test('blank lines are owned as trivia, never as empty cells', () => {
  const text = readFixture('blank-lines-everywhere.qmd');
  const doc = parseQmd(text);
  assert.equal(doc.leading, '\n\n\n');
  assert.equal(kinds(text), 'mppmp');
  for (const s of doc.segments) {
    if (s.kind === 'markdown') assert.notEqual(s.text.trim(), '');
  }
});

test('BOM is preserved as leading trivia', () => {
  const text = readFixture('bom.qmd');
  const doc = parseQmd(text);
  assert.equal(doc.leading, '\uFEFF');
  assert.equal(kinds(text), 'mp');
  const first = doc.segments[0]!;
  assert.ok(first.kind === 'markdown' && first.text.startsWith('---'), 'BOM must not be part of the cell text');
});

test('empty python cells', () => {
  const text = readFixture('empty-cells.qmd');
  const doc = parseQmd(text);
  assert.equal(kinds(text), 'ppp');
  const [a, b, c] = doc.segments as Array<{ source: string; bodyEol: string }>;
  assert.equal(a!.source, '');
  assert.equal(a!.bodyEol, '');
  assert.equal(b!.source, '');
  assert.equal(b!.bodyEol, '\n');
  assert.equal(c!.source, '\n');
});

test('unterminated front matter is not treated as front matter', () => {
  const text = readFixture('frontmatter-unterminated.qmd');
  assert.deepEqual(pySources(text), ['x = 1']);
});

test('realistic analysis segments as expected', () => {
  const text = readFixture('realistic-analysis.qmd');
  assert.equal(kinds(text), 'mpmpmpmpm');
  assert.equal(parseQmd(text).diagnostics.length, 0);
});
