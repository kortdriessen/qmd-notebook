import test from 'node:test';
import assert from 'node:assert/strict';
import { hashText, makeOutputId, parseOutputId, newCellId } from '../src/ids';
import { NdjsonDecoder, encodeMessage } from '../src/rpc';

test('hashText is stable and short', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.equal(hashText('abc').length, 16);
  assert.notEqual(hashText('abc'), hashText('abd'));
});

test('output ids round trip', () => {
  const cell = newCellId();
  const id = makeOutputId(cell, 3, hashText('x'));
  const parsed = parseOutputId(id);
  assert.deepEqual(parsed, { cellId: cell, index: 3, hash: hashText('x').slice(0, 8) });
  assert.equal(parseOutputId('garbage'), null);
});

test('ndjson decoder handles split chunks and bad lines', () => {
  const got: unknown[] = [];
  const errs: string[] = [];
  const d = new NdjsonDecoder(
    (m) => got.push(m),
    (line) => errs.push(line),
  );
  const a = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'x' });
  d.feed(a.slice(0, 5));
  d.feed(a.slice(5) + 'not json\n' + encodeMessage({ jsonrpc: '2.0', method: 'n' }));
  assert.equal(got.length, 2);
  assert.deepEqual(errs, ['not json']);
});
