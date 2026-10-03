import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexFocusSkillDirectory, installCodexFocusSkill } from '../../src/agent/codexSkill';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qmd-skill-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundled = path.join(root, 'bundled');
  fs.cpSync(path.resolve(__dirname, '../../../../skills/focus-notebook'), bundled, { recursive: true });
  const home = path.join(root, 'home');
  const target = codexFocusSkillDirectory(home);
  return { root, bundled, home, target };
}

test('installs a complete user-wide skill and preserves the legacy prompt', (t) => {
  const { bundled, home, target } = fixture(t);
  const legacy = path.join(home, '.codex', 'prompts', 'focus-notebook.md');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, 'My existing custom prompt');
  assert.deepEqual(installCodexFocusSkill(bundled, home), { status: 'installed', directory: target });
  assert.equal(target, path.join(home, '.agents', 'skills', 'focus-notebook'));
  for (const file of ['SKILL.md', 'agents/openai.yaml']) {
    assert.deepEqual(fs.readFileSync(path.join(target, file)), fs.readFileSync(path.join(bundled, file)));
  }
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'My existing custom prompt');
});

test('repeated activation leaves unchanged skill files alone', (t) => {
  const { bundled, home, target } = fixture(t);
  installCodexFocusSkill(bundled, home);
  const skill = path.join(target, 'SKILL.md');
  fs.utimesSync(skill, 1000, 1000);
  const mtime = fs.statSync(skill).mtimeMs;
  assert.equal(installCodexFocusSkill(bundled, home).status, 'unchanged');
  assert.equal(fs.statSync(skill).mtimeMs, mtime);
});

test('extension upgrades refresh managed files and keep additional user files', (t) => {
  const { bundled, home, target } = fixture(t);
  installCodexFocusSkill(bundled, home);
  fs.writeFileSync(path.join(target, 'notes.md'), 'User notes');
  fs.appendFileSync(path.join(bundled, 'SKILL.md'), '\nUpdated bundled workflow.\n');
  assert.equal(installCodexFocusSkill(bundled, home).status, 'updated');
  assert.deepEqual(fs.readFileSync(path.join(target, 'SKILL.md')), fs.readFileSync(path.join(bundled, 'SKILL.md')));
  assert.equal(fs.readFileSync(path.join(target, 'notes.md'), 'utf8'), 'User notes');
  assert.equal(installCodexFocusSkill(bundled, home).status, 'unchanged');
});

test('an existing unmanaged skill is preserved', (t) => {
  const { bundled, home, target } = fixture(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'User-authored skill');
  assert.equal(installCodexFocusSkill(bundled, home).status, 'conflict');
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'User-authored skill');
  assert.deepEqual(fs.readdirSync(target), ['SKILL.md']);
});

for (const file of ['SKILL.md', 'agents/openai.yaml']) {
  test(`a customized ${file} prevents an automatic overwrite`, (t) => {
    const { bundled, home, target } = fixture(t);
    installCodexFocusSkill(bundled, home);
    fs.appendFileSync(path.join(target, file), '\nPersonal customization\n');
    const originalSkill = fs.readFileSync(path.join(target, 'SKILL.md'));
    const originalUi = fs.readFileSync(path.join(target, 'agents/openai.yaml'));
    fs.appendFileSync(path.join(bundled, 'SKILL.md'), '\nExtension update\n');
    assert.equal(installCodexFocusSkill(bundled, home).status, 'conflict');
    assert.deepEqual(fs.readFileSync(path.join(target, 'SKILL.md')), originalSkill);
    assert.deepEqual(fs.readFileSync(path.join(target, 'agents/openai.yaml')), originalUi);
  });
}

test('an existing skill symlink is preserved', (t) => {
  const { root, bundled, home, target } = fixture(t);
  const personal = path.join(root, 'personal');
  fs.mkdirSync(personal);
  fs.writeFileSync(path.join(personal, 'SKILL.md'), 'Personal skill');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(personal, target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(installCodexFocusSkill(bundled, home).status, 'conflict');
  assert.equal(fs.readFileSync(path.join(personal, 'SKILL.md'), 'utf8'), 'Personal skill');
  assert.ok(fs.lstatSync(target).isSymbolicLink());
});

test('missing bundled assets fail before creating a partial skill', (t) => {
  const { bundled, home, target } = fixture(t);
  fs.rmSync(path.join(bundled, 'agents/openai.yaml'));
  assert.throws(() => installCodexFocusSkill(bundled, home), /ENOENT/);
  assert.equal(fs.existsSync(target), false);
});
