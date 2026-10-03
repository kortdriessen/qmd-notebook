import test from 'node:test';
import assert from 'node:assert/strict';
import { emit, load, md, py, readFixture } from './helpers';
import { emitQmd } from '../../src/notebook';

const BASIC = readFixture('basic.qmd');

test('editing only a python body changes only those bytes', () => {
  const loaded = load(BASIC);
  const cells = loaded.cells.map((c) => ({ ...c }));
  cells[1]!.source = 'import numpy as np\nx = np.arange(10)\nprint(x)';
  const out = emit(loaded, cells);
  assert.equal(
    out,
    BASIC.replace('x = np.arange(5)\n', 'x = np.arange(10)\nprint(x)\n'),
  );
});

test('editing only markdown changes only those bytes', () => {
  const loaded = load(BASIC);
  const cells = loaded.cells.map((c) => ({ ...c }));
  cells[2]!.source = 'Done!\n\nReally.';
  assert.equal(emit(loaded, cells), BASIC.replace('Done.\n', 'Done!\n\nReally.\n'));
});

test('emptying a python cell leaves an empty fence', () => {
  const loaded = load(BASIC);
  const cells = loaded.cells.map((c) => ({ ...c }));
  cells[1]!.source = '';
  assert.equal(emit(loaded, cells), BASIC.replace('import numpy as np\nx = np.arange(5)\n', ''));
});

test('insert python cell below the first cell', () => {
  const loaded = load(BASIC);
  const cells = [loaded.cells[0]!, loaded.cells[1]!, py('y = x * 2'), loaded.cells[2]!];
  const out = emit(loaded, cells);
  assert.equal(
    out,
    BASIC.replace('x = np.arange(5)\n```\n\n', 'x = np.arange(5)\n```\n\n```{python}\ny = x * 2\n```\n\n'),
  );
});

test('insert python cell above the first cell adds a blank line separator', () => {
  const loaded = load(BASIC);
  const cells = [py('import os'), ...loaded.cells];
  const out = emit(loaded, cells);
  assert.equal(out, '```{python}\nimport os\n```\n\n' + BASIC);
});

test('insert at the end of a file without final newline keeps no final newline', () => {
  const text = readFixture('no-final-newline.qmd');
  const loaded = load(text);
  const cells = [...loaded.cells, py('z = 1')];
  const out = emit(loaded, cells);
  assert.equal(out, text + '\n\n```{python}\nz = 1\n```');
});

test('insert markdown cell', () => {
  const loaded = load(BASIC);
  const cells = [loaded.cells[0]!, md('## Analysis'), loaded.cells[1]!, loaded.cells[2]!];
  assert.equal(emit(loaded, cells), BASIC.replace('## Setup\n\n', '## Setup\n\n## Analysis\n\n'));
});

test('delete first / middle / last cell', () => {
  const text = readFixture('adjacent-cells.qmd');
  const loaded = load(text);
  // delete first (markdown header)
  let cells = loaded.cells.slice(1);
  assert.equal(emit(loaded, cells), text.replace('# Adjacent\n\n', ''));
  // delete middle python cell (b = 2)
  cells = [loaded.cells[0]!, loaded.cells[1]!, ...loaded.cells.slice(3)];
  assert.equal(emit(loaded, cells), text.replace('```{python}\nb = 2\n```\n\n', ''));
  // delete last cell: new last cell gets a single final newline
  cells = loaded.cells.slice(0, -1);
  assert.equal(emit(loaded, cells), text.replace('\n\n\n```{python}\nc\n```\n', '\n'));
});

test('moving cells moves complete segments including fences', () => {
  const text = readFixture('adjacent-cells.qmd');
  const loaded = load(text);
  const [h, a, b, c, d] = loaded.cells;
  const cells = [h!, b!, a!, c!, d!];
  const out = emit(loaded, cells);
  assert.equal(out, text.replace('```{python}\na = 1\n```\n```{python}\nb = 2\n```\n\n', '```{python}\nb = 2\n```\n\n```{python}\na = 1\n```\n'));
});

test('moving the last cell to the middle ensures separation', () => {
  const text = readFixture('no-final-newline.qmd');
  const loaded = load(text);
  const [m, p] = loaded.cells;
  const out = emit(loaded, [p!, m!]);
  // the file had no final newline; the new last cell keeps that convention
  assert.equal(out, '```{python}\nprint("hi")\n```\n\n# No final newline');
});

test('convert markdown to python and back', () => {
  const loaded = load(BASIC);
  const cells = loaded.cells.map((c) => ({ ...c }));
  cells[2] = { ...cells[2]!, kind: 'python', language: 'python' };
  assert.equal(emit(loaded, cells), BASIC.replace('Done.\n', '```{python}\nDone.\n```\n'));
  const cells2 = loaded.cells.map((c) => ({ ...c }));
  cells2[1] = { ...cells2[1]!, kind: 'markdown', language: 'markdown' };
  assert.equal(
    emit(loaded, cells2),
    BASIC.replace('```{python}\nimport numpy as np\nx = np.arange(5)\n```\n', 'import numpy as np\nx = np.arange(5)\n'),
  );
});

test('new cells follow the document fence and newline conventions', () => {
  const text = readFixture('crlf.qmd');
  const loaded = load(text);
  const cells = [...loaded.cells, py('z = 1\nw = 2')];
  const out = emit(loaded, cells);
  assert.ok(out.endsWith('Text after.\r\n\r\n```{python}\r\nz = 1\r\nw = 2\r\n```\r\n'));
  const long = load(readFixture('long-fences.qmd'));
  const out2 = emit(long, [...long.cells, py('q = 1')]);
  assert.ok(out2.endsWith('Text.\n\n````{python}\nq = 1\n````\n'));
});

test('non-python code cells emit their language', () => {
  const loaded = load(BASIC);
  const cells = [...loaded.cells, { kind: 'python' as const, language: 'r', source: 'x <- 1', record: null }];
  assert.ok(emit(loaded, cells).endsWith('```{r}\nx <- 1\n```\n'));
});

test('emit result exposes editable line spans', () => {
  const loaded = load(BASIC);
  const res = emitQmd(loaded.ctx, loaded.cells);
  // basic.qmd: markdown lines 0-6 (content 0..6), python body lines 9-10, markdown line 13
  assert.deepEqual(res.cellLines[1], { startLine: 9, endLine: 11 });
  assert.deepEqual(res.cellLines[2], { startLine: 13, endLine: 14 });
  assert.deepEqual(res.cellFullLines[1], { startLine: 8, endLine: 13 });
});

test('mixed line endings inside an unchanged cell are emitted verbatim', () => {
  const text = '```{python}\na = 1\r\nb = 2\n```\n';
  const loaded = load(text);
  assert.equal(emit(loaded), text);
  // VS Code normalises EOLs inside a cell document; unchanged content still emits verbatim
  const cells = loaded.cells.map((c) => ({ ...c, source: c.source.replace(/\r\n/g, '\n') }));
  assert.equal(emit(loaded, cells), text);
});

test('empty document gains a first cell with final newline', () => {
  const loaded = load('');
  assert.equal(emit(loaded, [py('x = 1')]), '```{python}\nx = 1\n```\n');
  assert.equal(emit(loaded, [md('# Title'), py('x = 1')]), '# Title\n\n```{python}\nx = 1\n```\n');
});
