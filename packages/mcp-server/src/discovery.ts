/**
 * Locate the VS Code bridge instance serving a workspace by reading discovery records from the
 * user-private runtime directory written by the extension.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DiscoveryRecord } from '@qmd-notebook/shared';

/**
 * Directories that may hold discovery records. Agent clients (Codex in particular) launch MCP
 * servers with a sanitized environment, so besides $XDG_RUNTIME_DIR we also try the standard
 * Linux location /run/user/<uid> and the tmpdir fallback used by the extension.
 */
export function runtimeDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.QMD_NOTEBOOK_RUNTIME_DIR) dirs.push(process.env.QMD_NOTEBOOK_RUNTIME_DIR);
  if (process.env.XDG_RUNTIME_DIR) dirs.push(path.join(process.env.XDG_RUNTIME_DIR, 'qmd-notebook'));
  const uid = os.userInfo().uid;
  if (process.platform === 'linux' && typeof uid === 'number' && uid >= 0) dirs.push(path.join('/run/user', String(uid), 'qmd-notebook'));
  dirs.push(path.join(os.tmpdir(), `qmd-notebook-${uid ?? 'user'}`, 'qmd-notebook'));
  return Array.from(new Set(dirs));
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export interface FoundRecord {
  record: DiscoveryRecord;
  file: string;
  alive: boolean;
  mode: number | null;
}

export function listRecords(): FoundRecord[] {
  const out: FoundRecord[] = [];
  for (const dir of runtimeDirs()) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8')) as DiscoveryRecord;
        let mode: number | null = null;
        try {
          mode = fs.statSync(file).mode & 0o777;
        } catch {
          /* ignore */
        }
        out.push({ record, file, alive: isPidAlive(record.pid), mode });
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A workspace matches a bridge when it is one of its folders or a directory inside one. */
export function matchesWorkspace(record: DiscoveryRecord, workspace: string): boolean {
  const ws = realpathSafe(workspace);
  return record.workspaceFolders.some((f) => isInside(ws, realpathSafe(f)));
}

/** The looser relation: one of the bridge's folders lies inside the given directory. */
export function containsWorkspaceFolder(record: DiscoveryRecord, workspace: string): boolean {
  const ws = realpathSafe(workspace);
  return record.workspaceFolders.some((f) => isInside(realpathSafe(f), ws));
}

export class NoBridgeError extends Error {
  constructor(
    message: string,
    public readonly candidates: FoundRecord[],
  ) {
    super(message);
    this.name = 'NoBridgeError';
  }
}

/** Pick the live bridge for a workspace; throws a NoBridgeError with a human-readable hint. */
export function findBridge(workspace: string): FoundRecord {
  const all = listRecords();
  const alive = all.filter((r) => r.alive);
  const matching = alive.filter((r) => matchesWorkspace(r.record, workspace));
  if (matching.length === 1) return matching[0]!;
  if (matching.length > 1) {
    matching.sort((a, b) => b.record.startedAt.localeCompare(a.record.startedAt));
    return matching[0]!;
  }
  // Agent started above the folder VS Code has open (e.g. the repo root while VS Code shows a
  // subfolder): accept only when exactly one live window qualifies, so nothing is ambiguous.
  const below = alive.filter((r) => containsWorkspaceFolder(r.record, workspace));
  if (below.length === 1) return below[0]!;
  const ws = path.resolve(workspace);
  const lines = [
    `No QMD Notebook bridge is active for ${ws}.`,
    'Open this project in VS Code, open a .qmd with QMD Notebook,',
    'and run "QMD Notebook: Agent Connection Status".',
  ];
  if (alive.length) {
    lines.push('', below.length > 1 ? 'Several live VS Code windows are below this directory; start the agent inside the project folder or pass --workspace:' : 'Live VS Code windows with the QMD Notebook extension:');
    for (const r of alive) lines.push(`  - ${r.record.workspaceFolders.join(', ') || '(no folder)'} (pid ${r.record.pid})`);
    lines.push('Pass --workspace <one of those folders> (or run the agent inside it) to connect.');
  }
  throw new NoBridgeError(lines.join('\n'), alive);
}
