import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { matchesWorkspace, findBridge, NoBridgeError, isPidAlive } from '../src/discovery';
import { parseArgs } from '../src/cli';
import type { DiscoveryRecord } from '@qmd-notebook/shared';

function record(folders: string[], extra: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return {
    protocolVersion: 1,
    instanceId: 'qmdvs_test',
    pid: process.pid,
    socketPath: '/nonexistent.sock',
    token: 't',
    workspaceFolders: folders,
    remoteName: null,
    vscodeVersion: '1.130.0',
    extensionVersion: '0.1.0',
    startedAt: new Date().toISOString(),
    ...extra,
  };
}

test('workspace matching accepts the folder and subfolders only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qmd-disc-'));
  const sub = path.join(tmp, 'analysis');
  fs.mkdirSync(sub);
  const rec = record([tmp]);
  assert.equal(matchesWorkspace(rec, tmp), true);
  assert.equal(matchesWorkspace(rec, sub), true);
  assert.equal(matchesWorkspace(record([sub]), tmp), false, 'strict match: parent folders are handled separately (only when unambiguous)');
  assert.equal(matchesWorkspace(rec, '/definitely/elsewhere'), false);
  assert.equal(matchesWorkspace(rec, tmp + '-sibling'), false);
});

test('a parent directory attaches only when exactly one live window is below it', () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'qmd-xdg-'));
  process.env.XDG_RUNTIME_DIR = xdg;
  const dir = path.join(xdg, 'qmd-notebook');
  fs.mkdirSync(dir);
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'qmd-proj-'));
  const a = path.join(proj, 'a');
  const b = path.join(proj, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(record([a], { instanceId: 'a' })));
  assert.equal(findBridge(proj).record.instanceId, 'a', 'one window below the cwd → attach');
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(record([b], { instanceId: 'b' })));
  assert.throws(() => findBridge(proj), (e: unknown) => e instanceof NoBridgeError && /Several live VS Code windows/.test(e.message));
  assert.equal(findBridge(b).record.instanceId, 'b', 'inside a folder still wins');
});

test('findBridge explains when nothing matches', () => {
  process.env.XDG_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qmd-xdg-'));
  assert.throws(() => findBridge('/nope'), (e: unknown) => e instanceof NoBridgeError && /No QMD Notebook bridge is active for \/nope/.test(e.message));
});

test('stale records (dead pid) are ignored', () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'qmd-xdg-'));
  process.env.XDG_RUNTIME_DIR = xdg;
  const dir = path.join(xdg, 'qmd-notebook');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(record(['/tmp'], { pid: 999999999 })));
  assert.equal(isPidAlive(999999999), false);
  assert.throws(() => findBridge('/tmp'), NoBridgeError);
});

test('parseArgs', () => {
  assert.equal(parseArgs(['--workspace', '/x']).workspace, '/x');
  assert.equal(parseArgs(['doctor', '-w', '/y']).command, 'doctor');
  assert.equal(parseArgs(['--version']).command, 'version');
  assert.equal(parseArgs([]).command, 'serve');
});
