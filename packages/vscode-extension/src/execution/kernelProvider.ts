/**
 * Kernel discovery: Python environments (via the Python extension's public API), registered
 * Jupyter kernelspecs, configured extra interpreters, and a PATH fallback. Each candidate becomes
 * one VS Code NotebookController for the qmd-notebook type.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { Logger } from '../util/logger';
import { getSetting } from '../util/config';

export interface KernelCandidate {
  id: string;
  label: string;
  description: string;
  detail?: string;
  kind: 'python-env' | 'kernelspec';
  /** Interpreter for python-env candidates. */
  pythonPath?: string;
  kernelName?: string;
  specDir?: string;
  specArgv?: string[];
  envKind?: string;
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 10);
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Run `python -c code` with a timeout; resolves stdout or null. */
export function probePython(python: string, code: string, timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(python, ['-c', code], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : stdout.toString());
      });
    } catch {
      resolve(null);
    }
  });
}

export function jupyterKernelDirs(extraPrefixes: string[] = []): string[] {
  const dirs: string[] = [];
  const envPath = process.env.JUPYTER_PATH;
  if (envPath) for (const p of envPath.split(path.delimiter)) if (p) dirs.push(path.join(p, 'kernels'));
  const dataHome = process.env.JUPYTER_DATA_DIR;
  if (dataHome) dirs.push(path.join(dataHome, 'kernels'));
  if (process.platform === 'darwin') dirs.push(path.join(os.homedir(), 'Library', 'Jupyter', 'kernels'));
  else if (process.platform === 'win32') {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'jupyter', 'kernels'));
  } else {
    const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    dirs.push(path.join(xdg, 'jupyter', 'kernels'));
  }
  for (const prefix of extraPrefixes) dirs.push(path.join(prefix, 'share', 'jupyter', 'kernels'));
  dirs.push('/usr/local/share/jupyter/kernels', '/usr/share/jupyter/kernels');
  return Array.from(new Set(dirs));
}

export function readKernelspecs(dirs: string[]): KernelCandidate[] {
  const out: KernelCandidate[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (seen.has(name)) continue;
      const specDir = path.join(dir, name);
      const specPath = path.join(specDir, 'kernel.json');
      if (!exists(specPath)) continue;
      try {
        const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
        const language = String(spec.language ?? '').toLowerCase();
        if (language !== 'python') continue;
        if (spec.metadata?.qmd) continue;
        seen.add(name);
        out.push({
          id: `qmd-kernelspec:${name}`,
          label: String(spec.display_name ?? name),
          description: `kernelspec ${name}`,
          detail: specDir,
          kind: 'kernelspec',
          kernelName: name,
          specDir,
          specArgv: Array.isArray(spec.argv) ? spec.argv.map(String) : undefined,
        });
      } catch {
        /* ignore malformed spec */
      }
    }
  }
  return out;
}

interface PythonEnvInfo {
  path: string;
  label: string;
  kind: string;
  version?: string;
  isActive: boolean;
}

async function discoverPythonEnvironments(logger: Logger): Promise<PythonEnvInfo[]> {
  const envs: PythonEnvInfo[] = [];
  const pyExt = vscode.extensions.getExtension('ms-python.python');
  if (pyExt) {
    try {
      if (!pyExt.isActive) await pyExt.activate();
      const api: any = pyExt.exports;
      const environments = api?.environments;
      if (environments) {
        const activePath: string | undefined = environments.getActiveEnvironmentPath?.()?.path;
        const known: any[] = environments.known ?? [];
        for (const env of known) {
          const p: string | undefined = env?.path;
          if (!p) continue;
          let resolved: any = env;
          try {
            resolved = (await environments.resolveEnvironment(env)) ?? env;
          } catch {
            /* keep unresolved */
          }
          const exe: string = resolved?.executable?.uri?.fsPath ?? resolved?.path ?? p;
          if (!exe || !exists(exe)) continue;
          const v = resolved?.version;
          const version = v && typeof v.major === 'number' ? `${v.major}.${v.minor}.${v.micro}` : undefined;
          const envKind: string = resolved?.environment?.type ?? resolved?.tools?.[0] ?? 'Python';
          const envName: string | undefined = resolved?.environment?.name;
          const folder: string | undefined = resolved?.environment?.folderUri?.fsPath;
          const label = envName
            ? `${envName} (Python ${version ?? '?'})`
            : folder
              ? `${path.basename(folder)} (Python ${version ?? '?'})`
              : `Python ${version ?? '?'}`;
          envs.push({ path: exe, label, kind: String(envKind), version, isActive: !!activePath && (activePath === p || activePath === exe) });
        }
      }
    } catch (e) {
      logger.warn(`Python extension API unavailable: ${String(e)}`);
    }
  }
  return envs;
}

async function pathFallbacks(): Promise<PythonEnvInfo[]> {
  const out: PythonEnvInfo[] = [];
  for (const name of ['python3', 'python']) {
    const which = await new Promise<string | null>((resolve) => {
      execFile(process.platform === 'win32' ? 'where' : 'which', [name], { timeout: 5000 }, (err, stdout) =>
        resolve(err ? null : stdout.toString().split(/\r?\n/)[0]?.trim() || null),
      );
    });
    if (which && exists(which)) {
      out.push({ path: which, label: `${name} on PATH`, kind: 'System', isActive: false });
      break;
    }
  }
  return out;
}

export class KernelDiscovery {
  private readonly hostProbeCache = new Map<string, Promise<boolean>>();

  constructor(private readonly logger: Logger) {}

  async discover(workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined): Promise<KernelCandidate[]> {
    const envs = await discoverPythonEnvironments(this.logger);
    const seenPaths = new Set<string>();
    const candidates: KernelCandidate[] = [];

    const addEnv = (env: PythonEnvInfo): void => {
      const real = safeRealpath(env.path);
      if (seenPaths.has(real)) return;
      seenPaths.add(real);
      candidates.push({
        id: `qmd-python-env:${shortHash(real)}`,
        label: env.label,
        description: env.isActive ? 'active interpreter' : env.kind,
        detail: env.path,
        kind: 'python-env',
        pythonPath: env.path,
        envKind: env.kind,
      });
    };

    for (const env of envs) addEnv(env);
    for (const extra of getSetting<string[]>('execution.pythonCandidates', [])) {
      if (exists(extra)) addEnv({ path: extra, label: `${path.basename(path.dirname(path.dirname(extra)))} (configured)`, kind: 'configured', isActive: false });
    }
    // Workspace-local .venv folders not reported by the Python extension.
    for (const folder of workspaceFolders ?? []) {
      for (const venv of ['.venv', 'venv', '.env']) {
        const exe = path.join(folder.uri.fsPath, venv, process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
        if (exists(exe)) addEnv({ path: exe, label: `${venv} (${path.basename(folder.uri.fsPath)})`, kind: 'Venv', isActive: false });
      }
    }
    if (candidates.length === 0) for (const env of await pathFallbacks()) addEnv(env);

    const prefixes = candidates
      .filter((c) => c.pythonPath)
      .map((c) => path.dirname(path.dirname(c.pythonPath!)));
    for (const spec of readKernelspecs(jupyterKernelDirs(prefixes))) candidates.push(spec);

    this.logger.info(`kernel discovery: ${candidates.length} candidate(s)`);
    return candidates;
  }

  /** Does this interpreter have jupyter_client (and therefore can run the host helper)? Cached. */
  hasJupyterClient(python: string): Promise<boolean> {
    let p = this.hostProbeCache.get(python);
    if (!p) {
      p = probePython(python, 'import jupyter_client, ipykernel').then((r) => r !== null);
      this.hostProbeCache.set(python, p);
    }
    return p;
  }

  invalidateProbe(python: string): void {
    this.hostProbeCache.delete(python);
  }

  /** Pick a Python able to host a kernelspec-based kernel. */
  async hostPythonForKernelspec(candidate: KernelCandidate, others: KernelCandidate[]): Promise<string | null> {
    const tried: string[] = [];
    const argv0 = candidate.specArgv?.[0];
    if (argv0 && path.isAbsolute(argv0) && exists(argv0) && /python/i.test(path.basename(argv0))) tried.push(argv0);
    for (const c of others) if (c.pythonPath) tried.push(c.pythonPath);
    for (const python of tried) {
      if (await this.hasJupyterClient(python)) return python;
    }
    return null;
  }
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
