import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeTimeoutFor, clientSupportsImageContent, defaultWaitMs, splitImages, WAIT_TOOLS } from '../src/tools';
import { parseArgs, parseDuration } from '../src/cli';

const HOUR = 3600000;

test('an omitted wait budget follows what the MCP client allows', () => {
  assert.equal(defaultWaitMs('claude-code'), 4 * HOUR, 'Claude Code allows ~28 h per call; we poll for 4 h');
  assert.equal(defaultWaitMs('codex-mcp-client'), 55000, 'Codex tool_timeout_sec defaults to 60');
  assert.equal(defaultWaitMs(undefined), 55000, 'unknown clients get the conservative budget');
  assert.equal(defaultWaitMs('codex-mcp-client', 4 * HOUR), 4 * HOUR, '--max-wait overrides the client default');
  assert.equal(defaultWaitMs('claude-code', 90000), 90000);
  assert.equal(defaultWaitMs('claude-code', 24 * HOUR), 6 * HOUR, 'capped at the bridge maximum');
  assert.equal(defaultWaitMs('claude-code', 10), 1000, 'never below a second');
});

test('durations: ms, s, m, h; env and --max-wait', () => {
  assert.equal(parseDuration('90000'), 90000);
  assert.equal(parseDuration('55s'), 55000);
  assert.equal(parseDuration('10m'), 600000);
  assert.equal(parseDuration('4h'), 4 * HOUR);
  assert.equal(parseDuration('1.5h'), 1.5 * HOUR);
  assert.equal(parseDuration('soon'), undefined);
  assert.equal(parseDuration(''), undefined);
  assert.equal(parseArgs([], {}).maxWaitMs, undefined);
  assert.equal(parseArgs(['--max-wait', '4h'], {}).maxWaitMs, 4 * HOUR);
  assert.equal(parseArgs(['--max-wait=55s'], {}).maxWaitMs, 55000);
  assert.equal(parseArgs([], { QMD_NOTEBOOK_MAX_WAIT_MS: '120000' }).maxWaitMs, 120000);
  assert.equal(parseArgs(['--max-wait', '2h'], { QMD_NOTEBOOK_MAX_WAIT_MS: '120000' }).maxWaitMs, 2 * HOUR, 'flag beats env');
  assert.equal(parseArgs(['--max-wait', 'bogus'], { QMD_NOTEBOOK_MAX_WAIT_MS: '120000' }).maxWaitMs, 120000, 'invalid flag keeps the env value');
});

test('the bridge call budget follows the agent wait plus a margin', () => {
  assert.ok(WAIT_TOOLS.has('wait_for_comments'));
  assert.equal(bridgeTimeoutFor('wait_for_comments', { timeoutMs: 4 * HOUR }), 4 * HOUR + 30000);
  assert.equal(bridgeTimeoutFor('execute_cell', {}), 130000);
  assert.equal(bridgeTimeoutFor('execute_cell', { timeoutMs: 600000 }), 630000);
  assert.equal(bridgeTimeoutFor('execute_cells', { cellIds: ['a', 'b', 'c', 'd'] }), 210000);
  assert.equal(bridgeTimeoutFor('apply_cell_edits', { execute: true, edits: [1, 2, 3, 4] }), 210000);
  assert.equal(bridgeTimeoutFor('read_cell', {}), 130000);
});

test('image content is delivered as blocks to Claude Code and as file paths to other clients', () => {
  assert.equal(clientSupportsImageContent('claude-code'), true);
  assert.equal(clientSupportsImageContent('codex-mcp-client'), false);
  assert.equal(clientSupportsImageContent(undefined), false);
  const packet = { requestId: 'qmdreq_1', prompt: 'look', inlineImages: [{ imageId: 'qmdimg_1', name: 'a.png', mime: 'image/png', base64: 'AAAA', filePath: '/run/x/a.png' }] };
  const batch = { comments: [packet], stopped: false };
  const claude = splitImages(batch, true);
  assert.equal(claude.trailing.filter((b) => b.type === 'image').length, 1);
  assert.deepEqual((claude.json as any).comments[0].inlineImagesDelivered, ['qmdimg_1']);
  assert.ok(!JSON.stringify(claude.json).includes('AAAA'), 'no base64 in the JSON text');
  const codex = splitImages(batch, false);
  assert.equal(codex.trailing.length, 0);
  assert.equal(codex.leading.length, 0);
  const c0 = (codex.json as any).comments[0];
  assert.equal(c0.attachedImages[0].filePath, '/run/x/a.png');
  assert.match(c0.attachedImagesHint, /view_image/);
  assert.ok(!JSON.stringify(codex.json).includes('AAAA'));
  // read_output / read_attachment shape
  const out = { outputId: 'o', mime: 'image/png', base64: 'BBBB', filePath: '/run/x/o.png' };
  assert.equal(splitImages(out, true).leading[0]?.type, 'image');
  const codexOut = splitImages(out, false);
  assert.equal(codexOut.leading.length, 0);
  assert.match((codexOut.json as any).viewHint, /\/run\/x\/o\.png/);
});
