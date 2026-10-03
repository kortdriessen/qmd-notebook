import test from 'node:test';
import assert from 'node:assert/strict';
import { emit, load } from './helpers';

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  '',
  '\n',
  '\n\n',
  '# Heading\n',
  'Some text with `inline` code.\n',
  '```{python}\nx = 1\n```\n',
  '```{python}\n```\n',
  '```{python}\n\n\n```\n',
  '````{python}\ny = 2\n```\nstill\n````\n',
  '```{python, echo=false}\nz = 3\n```\n',
  '```python\nplain = 1\n```\n',
  '~~~\n```{python}\nnope\n```\n~~~\n',
  '````\n```{python}\nnope\n```\n````\n',
  '```{r}\nx <- 1\n```\n',
  '```{{python}}\nliteral\n```\n',
  '::: {.callout-note}\nnote\n:::\n',
  '$$\nx^2\n$$\n',
  '```{python}\n#| eval: false\nw = 4\n```\n',
  '```{python}\nunclosed = 1\n',
  '   \n',
  '\t\n',
  'trailing spaces   \n',
  '---\ntitle: x\n---\n',
];

test('random documents round-trip byte for byte (1000 cases, LF and CRLF, with/without final EOL)', () => {
  const rand = mulberry32(12345);
  for (let n = 0; n < 1000; n++) {
    const count = Math.floor(rand() * 8);
    let text = '';
    for (let i = 0; i < count; i++) text += PIECES[Math.floor(rand() * PIECES.length)];
    if (rand() < 0.3) text = text.replace(/\n/g, '\r\n');
    if (rand() < 0.3 && text.endsWith('\n')) text = text.slice(0, text.endsWith('\r\n') ? -2 : -1);
    if (rand() < 0.1) text = '﻿' + text;
    const loaded = load(text);
    assert.equal(emit(loaded), text, `case ${n}: ${JSON.stringify(text)}`);
    // every python cell's visible source re-emits verbatim after a no-op edit (EOL-normalised)
    const cells = loaded.cells.map((c) => ({ ...c, source: c.source.replace(/\r\n/g, '\n') }));
    assert.equal(emit(loaded, cells), text, `normalised case ${n}: ${JSON.stringify(text)}`);
  }
});
