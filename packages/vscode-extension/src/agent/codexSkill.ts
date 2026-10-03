/** Install the bundled skill in Codex's user-wide discovery directory. No VS Code dependency. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FILES = ['SKILL.md', 'agents/openai.yaml'] as const;
const MANIFEST = '.qmd-notebook-managed.json';

export interface SkillInstallResult {
  status: 'installed' | 'updated' | 'unchanged' | 'conflict';
  directory: string;
}

export function codexFocusSkillDirectory(home = os.homedir()): string {
  return path.join(home, '.agents', 'skills', 'focus-notebook');
}

function hash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Refresh only files previously installed by us and still unmodified. An existing user skill
 * (including a symlink) or a customized copy is left intact. Old custom prompts are untouched.
 */
export function installCodexFocusSkill(bundledDirectory: string, home = os.homedir()): SkillInstallResult {
  // Read all bundled assets before creating anything in the user's skill directory.
  const contents = FILES.map((file) => ({ file, data: fs.readFileSync(path.join(bundledDirectory, file)) }));
  const directory = codexFocusSkillDirectory(home);
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(directory);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  if (existing) {
    const conflict: SkillInstallResult = { status: 'conflict', directory };
    if (!existing.isDirectory() || existing.isSymbolicLink()) return conflict;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST), 'utf8')) as {
        owner?: string;
        files?: Record<string, string>;
      };
      if (manifest.owner !== 'qmd-notebook' || !manifest.files) return conflict;
      for (const file of FILES) {
        const target = path.join(directory, file);
        if (!fs.lstatSync(target).isFile() || hash(fs.readFileSync(target)) !== manifest.files[file]) return conflict;
      }
    } catch {
      return conflict;
    }
    if (contents.every(({ file, data }) => fs.readFileSync(path.join(directory, file)).equals(data))) {
      return { status: 'unchanged', directory };
    }
  }

  fs.mkdirSync(path.join(directory, 'agents'), { recursive: true });
  for (const { file, data } of contents) fs.writeFileSync(path.join(directory, file), data);
  fs.writeFileSync(
    path.join(directory, MANIFEST),
    JSON.stringify({ owner: 'qmd-notebook', files: Object.fromEntries(contents.map(({ file, data }) => [file, hash(data)])) }, null, 2) + '\n',
  );
  return { status: existing ? 'updated' : 'installed', directory };
}
