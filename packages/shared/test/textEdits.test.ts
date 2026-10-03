import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTextEdits, minimalSpan, TextEditError } from '../src/textEdits';

const SRC = 'x = 1\ny = 2\nprint(x, y)\nprint(x, y)\n';

test('single exact replacement, applied in order', () => {
  const r = applyTextEdits(SRC, [
    { oldText: 'y = 2', newText: 'y = 20' },
    { oldText: 'y = 20', newText: 'y = 200' },
  ]);
  assert.equal(r.text, 'x = 1\ny = 200\nprint(x, y)\nprint(x, y)\n');
  assert.deepEqual(r.applied.map((a) => a.lines), [[2], [2]]);
});

test('ambiguous without replaceAll, all occurrences with it', () => {
  assert.throws(() => applyTextEdits(SRC, [{ oldText: 'print(x, y)', newText: 'print(y)' }]), (e: unknown) => e instanceof TextEditError && e.reason === 'ambiguous' && e.occurrences === 2 && e.lines.join() === '3,4');
  const r = applyTextEdits(SRC, [{ oldText: 'print(x, y)', newText: 'print(y)', replaceAll: true }]);
  assert.equal(r.text, 'x = 1\ny = 2\nprint(y)\nprint(y)\n');
  assert.equal(r.applied[0]!.occurrences, 2);
});

test('missing text: nothing applied, whitespace hint when indentation differs', () => {
  assert.throws(() => applyTextEdits(SRC, [{ oldText: 'z = 3', newText: 'z' }]), (e: unknown) => e instanceof TextEditError && e.reason === 'not-found' && e.hint === undefined);
  assert.throws(() => applyTextEdits(SRC, [{ oldText: 'x  =  1', newText: 'x = 10' }]), (e: unknown) => e instanceof TextEditError && e.reason === 'not-found' && !!e.hint && e.candidateLines?.join() === '1');
  assert.throws(() => applyTextEdits(SRC, [{ oldText: '', newText: 'a' }]), (e: unknown) => e instanceof TextEditError && e.reason === 'empty');
  assert.throws(() => applyTextEdits(SRC, [{ oldText: 'x = 1', newText: 'x = 1' }]), (e: unknown) => e instanceof TextEditError && e.reason === 'identical');
  // a failing later edit leaves the earlier ones unapplied (the caller gets an exception, not a partial text)
  assert.throws(() => applyTextEdits(SRC, [{ oldText: 'x = 1', newText: 'x = 2' }, { oldText: 'nope', newText: '' }]));
});

test('deleting and multi-line replacements', () => {
  const r = applyTextEdits(SRC, [{ oldText: 'print(x, y)\nprint(x, y)\n', newText: '' }]);
  assert.equal(r.text, 'x = 1\ny = 2\n');
  const r2 = applyTextEdits('a\nb\nc', [{ oldText: 'b', newText: 'b1\nb2' }]);
  assert.equal(r2.text, 'a\nb1\nb2\nc');
});

test('minimal span covers exactly the changed region', () => {
  assert.deepEqual(minimalSpan('x = 1\ny = 2\n', 'x = 1\ny = 20\n'), { start: 11, end: 11, text: '0' });
  assert.deepEqual(minimalSpan('abc', 'abc'), { start: 3, end: 3, text: '' });
  assert.deepEqual(minimalSpan('abc', ''), { start: 0, end: 3, text: '' });
  assert.deepEqual(minimalSpan('', 'abc'), { start: 0, end: 0, text: 'abc' });
  assert.deepEqual(minimalSpan('aXa', 'aYa'), { start: 1, end: 2, text: 'Y' });
  assert.deepEqual(minimalSpan('aa', 'aaa'), { start: 2, end: 2, text: 'a' });
  // two far-apart edits collapse into one span that re-emits the unchanged middle verbatim
  const before = 'x = 1\nkeep\ny = 2\n';
  const after = 'x = 10\nkeep\ny = 20\n';
  const s = minimalSpan(before, after);
  assert.equal(before.slice(0, s.start) + s.text + before.slice(s.end), after);
});
