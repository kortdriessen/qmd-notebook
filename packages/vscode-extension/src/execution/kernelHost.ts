/**
 * Node-side client for python/qmd_kernel_host.py (NDJSON over stdio). No VS Code imports so it
 * can be exercised by plain node tests against a real kernel.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { NdjsonDecoder } from '@qmd-notebook/shared';

export interface HostLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface IopubMessage {
  msg_type: string;
  msg_id: string;
  parent_msg_id: string | null;
  content: any;
  metadata: any;
  buffers?: string[];
}

export type KernelState = 'starting' | 'idle' | 'busy' | 'restarting' | 'dead';

export type HostEvent =
  | { event: 'ready'; protocolVersion: number }
  | { event: 'status'; state: KernelState; requestId?: string | null }
  | { event: 'iopub'; requestId: string | null; msg: IopubMessage }
  | { event: 'execute_done'; requestId: string; reply: ExecuteReply }
  | { event: 'stdin_request'; requestId: string | null; prompt: string; password: boolean }
  | { event: 'kernel_died' }
  | { event: 'log'; level: string; message: string }
  | { event: 'fatal'; code: string; message: string };

export interface ExecuteReply {
  status: 'ok' | 'error' | 'aborted';
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  [key: string]: unknown;
}

export interface HostSpawnOptions {
  pythonPath: string;
  hostScript: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger: HostLogger;
  readyTimeoutMs?: number;
}

export class HostProcessError extends Error {
  constructor(
    message: string,
    public readonly code: number | string = -32603,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'HostProcessError';
  }
}

type Listener = (e: HostEvent) => void;

export class KernelHostProcess {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }
  >();
  private readonly listeners = new Set<Listener>();
  private readonly exitListeners = new Set<(code: number | null, signal: string | null) => void>();
  private exited = false;
  private stderrTail: string[] = [];
  readonly pid: number | undefined;

  private constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly logger: HostLogger,
  ) {
    this.pid = proc.pid;
    const decoder = new NdjsonDecoder(
      (m) => this.handleMessage(m as any),
      (line, err) =>
        logger.warn(`kernel host: unparseable line (${String(err)}): ${line.slice(0, 120)}`),
    );
    proc.stdout.on('data', (chunk: Buffer) => decoder.feed(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
        if (!/Kernel is running over TCP without encryption/.test(line)) {
          logger.debug(`kernel host stderr: ${line}`);
        }
      }
    });
    proc.on('exit', (code, signal) => {
      this.exited = true;
      const err = new HostProcessError(
        `kernel host exited (code ${code}, signal ${signal})${this.stderrSummary()}`,
        'host-exited',
      );
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      for (const l of this.exitListeners) l(code, signal);
    });
    proc.on('error', (e) => logger.error(`kernel host process error: ${String(e)}`));
  }

  static spawn(options: HostSpawnOptions): Promise<KernelHostProcess> {
    const { pythonPath, hostScript, cwd, env, logger } = options;
    const proc = spawn(pythonPath, ['-u', hostScript], {
      cwd,
      env: { ...process.env, ...env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const host = new KernelHostProcess(proc, logger);
    const readyTimeout = options.readyTimeoutMs ?? 30000;
    return new Promise<KernelHostProcess>((resolve, reject) => {
      const timer = setTimeout(() => {
        host.kill();
        reject(
          new HostProcessError(
            `kernel host did not start within ${readyTimeout} ms${host.stderrSummary()}`,
            'host-start-timeout',
          ),
        );
      }, readyTimeout);
      const off = host.onEvent((e) => {
        if (e.event === 'ready') {
          clearTimeout(timer);
          off();
          resolve(host);
        } else if (e.event === 'fatal') {
          clearTimeout(timer);
          off();
          reject(new HostProcessError(e.message, e.code));
        }
      });
      host.onExit(() => {
        clearTimeout(timer);
        reject(
          new HostProcessError(
            `kernel host exited before becoming ready${host.stderrSummary()}`,
            'host-exited',
          ),
        );
      });
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(new HostProcessError(`failed to spawn ${pythonPath}: ${String(e)}`, 'spawn-failed'));
      });
    });
  }

  private stderrSummary(): string {
    const interesting = this.stderrTail.filter(
      (l) => !/WARNING \| Kernel is running over TCP/.test(l),
    );
    return interesting.length ? `\n${interesting.slice(-8).join('\n')}` : '';
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private handleMessage(m: any): void {
    if (m && typeof m === 'object' && 'event' in m) {
      const e = m as HostEvent;
      if (e.event === 'log') this.logger.debug(`kernel host: [${e.level}] ${e.message}`);
      for (const l of this.listeners) {
        try {
          l(e);
        } catch (err) {
          this.logger.error(`kernel host listener failed: ${String(err)}`);
        }
      }
      return;
    }
    if (m && typeof m === 'object' && 'id' in m) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      if (m.error) {
        p.reject(
          new HostProcessError(m.error.message ?? 'kernel host error', m.error.code, m.error.data),
        );
      } else {
        p.resolve(m.result);
      }
    }
  }

  request<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 60000,
  ): Promise<T> {
    if (this.exited) {
      return Promise.reject(new HostProcessError('kernel host has exited', 'host-exited'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new HostProcessError(
            `kernel host request '${method}' timed out after ${timeoutMs} ms`,
            'timeout',
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(
            new HostProcessError(`failed to write to kernel host: ${String(err)}`, 'write-failed'),
          );
        }
      });
    });
  }

  kill(): void {
    if (this.exited) return;
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => {
      if (!this.exited) {
        try {
          this.proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 3000);
    t.unref();
  }
}
