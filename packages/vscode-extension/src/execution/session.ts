/**
 * KernelSession: one persistent kernel per notebook, with a strictly serial execution queue
 * shared by user cells and agent scratch executions.
 */
import { randomUUID } from 'node:crypto';
import {
  HostProcessError,
  KernelHostProcess,
  type ExecuteReply,
  type HostEvent,
  type HostLogger,
  type IopubMessage,
  type KernelState,
} from './kernelHost';

export interface KernelLaunchSpec {
  /** Python used to run the host helper (must import jupyter_client). */
  hostPython: string;
  hostScript: string;
  /** Either a kernelspec name or an explicit argv containing `{connection_file}`. */
  kernelName?: string;
  argv?: string[];
  displayName: string;
  cwd: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
}

export type ExecutionKind = 'cell' | 'scratch';

export interface ExecuteRequest {
  code: string;
  kind: ExecutionKind;
  label?: string;
  allowStdin?: boolean;
  storeHistory?: boolean;
  stopOnError?: boolean;
  /** Interrupt the kernel and fail this execution if it exceeds the budget. */
  timeoutMs?: number;
}

export type KernelEvent =
  | { type: 'started' }
  | { type: 'iopub'; msg: IopubMessage }
  | { type: 'input_request'; prompt: string; password: boolean; reply: (value: string) => void };

export interface ExecutionOutcome {
  reply: ExecuteReply;
  success: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

interface QueuedExecution {
  id: string;
  request: ExecuteRequest;
  handler: (event: KernelEvent) => void;
  resolve: (o: ExecutionOutcome) => void;
  reject: (e: Error) => void;
  cancelled: boolean;
}

type CurrentExecution = QueuedExecution & {
  requestId: string;
  startedAt: number;
  timer?: NodeJS.Timeout;
  timedOut: boolean;
};

export class KernelSession {
  readonly sessionId = `qmdsess_${randomUUID().slice(0, 8)}`;
  private host: KernelHostProcess | null = null;
  private _status: KernelState = 'starting';
  private readonly statusListeners = new Set<(s: KernelState) => void>();
  private readonly activityListeners = new Set<(a: string | null) => void>();
  private queue: QueuedExecution[] = [];
  private current: CurrentExecution | null = null;
  private starting: Promise<void> | null = null;
  private disposed = false;
  private _agentActivity: string | null = null;
  kernelInfo: any = null;

  constructor(
    readonly spec: KernelLaunchSpec,
    private readonly logger: HostLogger,
  ) {}

  get status(): KernelState {
    return this._status;
  }

  get kernelDisplayName(): string {
    return this.spec.displayName;
  }

  get agentActivity(): string | null {
    return this._agentActivity;
  }

  get queueLength(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  onDidChangeStatus(l: (s: KernelState) => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  onDidChangeAgentActivity(l: (a: string | null) => void): () => void {
    this.activityListeners.add(l);
    return () => this.activityListeners.delete(l);
  }

  private setStatus(s: KernelState): void {
    if (this._status === s) return;
    this._status = s;
    for (const l of this.statusListeners) l(s);
  }

  private setActivity(a: string | null): void {
    this._agentActivity = a;
    for (const l of this.activityListeners) l(a);
  }

  /** Start the host and kernel. Idempotent. */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doStart().catch((e) => {
      this.starting = null;
      this.setStatus('dead');
      throw e;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.setStatus('starting');
    const host = await KernelHostProcess.spawn({
      pythonPath: this.spec.hostPython,
      hostScript: this.spec.hostScript,
      cwd: this.spec.cwd,
      env: this.spec.env,
      logger: this.logger,
    });
    this.host = host;
    host.onEvent((e) => this.handleHostEvent(e));
    host.onExit(() => {
      if (this.disposed) return;
      this.logger.warn('kernel host exited unexpectedly');
      this.setStatus('dead');
      this.failCurrent('Kernel host exited');
      this.cancelQueue('Kernel host exited');
    });
    const hello = await host.request('hello', {}, 15000);
    this.logger.info(
      `kernel host ready: python ${hello.python} jupyter_client ${hello.jupyterClient} ipykernel ${hello.ipykernel}`,
    );
    const startupMs = this.spec.startupTimeoutMs ?? 60000;
    const result = await host.request(
      'start',
      {
        kernelName: this.spec.kernelName,
        argv: this.spec.argv,
        cwd: this.spec.cwd,
        displayName: this.spec.displayName,
        startupTimeout: Math.floor(startupMs / 1000),
      },
      startupMs + 15000,
    );
    this.kernelInfo = result.kernelInfo ?? null;
    this.setStatus('idle');
  }

  private handleHostEvent(e: HostEvent): void {
    switch (e.event) {
      case 'status':
        if (e.state === 'dead') {
          this.setStatus('dead');
        } else if (e.state === 'busy' || e.state === 'idle') {
          if (this._status !== 'restarting' && this._status !== 'starting') this.setStatus(e.state);
        }
        return;
      case 'iopub':
        if (this.current && e.requestId === this.current.requestId) {
          this.current.handler({ type: 'iopub', msg: e.msg });
        }
        return;
      case 'stdin_request':
        if (this.current && (e.requestId === this.current.requestId || e.requestId === null)) {
          const host = this.host;
          this.current.handler({
            type: 'input_request',
            prompt: e.prompt,
            password: e.password,
            reply: (value: string) => {
              host
                ?.request('input_reply', { value })
                .catch((err) => this.logger.warn(`input_reply failed: ${String(err)}`));
            },
          });
        }
        return;
      case 'execute_done':
        if (this.current && e.requestId === this.current.requestId) this.finishCurrent(e.reply);
        return;
      case 'kernel_died':
        this.setStatus('dead');
        this.failCurrent('Kernel died');
        this.cancelQueue('Kernel died');
        return;
      default:
        return;
    }
  }

  execute(request: ExecuteRequest, handler: (event: KernelEvent) => void): Promise<ExecutionOutcome> {
    if (this.disposed) return Promise.reject(new Error('session disposed'));
    return new Promise<ExecutionOutcome>((resolve, reject) => {
      const item: QueuedExecution = {
        id: randomUUID(),
        request,
        handler,
        resolve,
        reject,
        cancelled: false,
      };
      this.queue.push(item);
      this.pump();
    });
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    if (item.cancelled) {
      item.resolve({
        reply: { status: 'aborted' },
        success: false,
        timedOut: false,
        cancelled: true,
        durationMs: 0,
      });
      this.pump();
      return;
    }
    // Claim the slot synchronously so a second execute() cannot start before the kernel is up.
    const current: CurrentExecution = { ...item, requestId: '', startedAt: Date.now(), timedOut: false };
    this.current = current;
    void this.runItem(current);
  }

  private async runItem(current: CurrentExecution): Promise<void> {
    const item = current;
    try {
      await this.start();
    } catch (e) {
      if (this.current === current) this.current = null;
      item.reject(e instanceof Error ? e : new Error(String(e)));
      this.pump();
      return;
    }
    if (this._status === 'dead' || !this.host) {
      if (this.current === current) this.current = null;
      item.reject(new HostProcessError('Kernel is not running', 'kernel-dead'));
      this.pump();
      return;
    }
    if (this.current !== current) {
      // cancelled/failed while starting
      item.resolve({ reply: { status: 'aborted' }, success: false, timedOut: false, cancelled: true, durationMs: 0 });
      return;
    }
    const requestId = `req_${randomUUID().slice(0, 8)}`;
    current.requestId = requestId;
    current.startedAt = Date.now();
    if (item.request.kind === 'scratch') {
      this.setActivity(item.request.label ?? 'agent scratch execution');
    }
    item.handler({ type: 'started' });
    if (item.request.timeoutMs && item.request.timeoutMs > 0) {
      current.timer = setTimeout(() => {
        if (this.current && this.current.requestId === requestId) {
          this.current.timedOut = true;
          this.logger.warn(
            `execution ${requestId} timed out after ${item.request.timeoutMs} ms; interrupting`,
          );
          this.interrupt(false).catch(() => undefined);
        }
      }, item.request.timeoutMs);
    }
    try {
      await this.host.request('execute', {
        requestId,
        code: item.request.code,
        allowStdin: item.request.allowStdin ?? item.request.kind === 'cell',
        storeHistory: item.request.storeHistory ?? item.request.kind === 'cell',
        stopOnError: item.request.stopOnError ?? true,
      });
    } catch (e) {
      const cur = this.current;
      this.current = null;
      if (cur?.timer) clearTimeout(cur.timer);
      if (item.request.kind === 'scratch') this.setActivity(null);
      item.reject(e instanceof Error ? e : new Error(String(e)));
      this.pump();
    }
  }

  private finishCurrent(reply: ExecuteReply): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    if (cur.timer) clearTimeout(cur.timer);
    if (cur.request.kind === 'scratch') this.setActivity(null);
    cur.resolve({
      reply,
      success: reply.status === 'ok',
      timedOut: cur.timedOut,
      cancelled: cur.cancelled,
      durationMs: Date.now() - cur.startedAt,
    });
    this.pump();
  }

  private failCurrent(reason: string): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    if (cur.timer) clearTimeout(cur.timer);
    if (cur.request.kind === 'scratch') this.setActivity(null);
    cur.resolve({
      reply: { status: 'error', ename: 'KernelUnavailable', evalue: reason, traceback: [] },
      success: false,
      timedOut: cur.timedOut,
      cancelled: true,
      durationMs: Date.now() - cur.startedAt,
    });
  }

  /** Cancel queued (not yet started) executions. */
  cancelQueue(_reason: string, kind?: ExecutionKind): number {
    let n = 0;
    const keep: QueuedExecution[] = [];
    for (const q of this.queue) {
      if (kind && q.request.kind !== kind) {
        keep.push(q);
        continue;
      }
      q.cancelled = true;
      q.resolve({
        reply: { status: 'aborted' },
        success: false,
        timedOut: false,
        cancelled: true,
        durationMs: 0,
      });
      n++;
    }
    this.queue = keep;
    return n;
  }

  /** Interrupt the running execution; by default also drops queued cell executions (Jupyter semantics). */
  async interrupt(dropQueuedCells = true): Promise<void> {
    if (!this.host) return;
    if (dropQueuedCells) this.cancelQueue('interrupted', 'cell');
    if (this.current) this.current.cancelled = true;
    await this.host.request('interrupt', {}, 10000);
  }

  async restart(): Promise<void> {
    if (!this.host) {
      await this.start();
      return;
    }
    this.cancelQueue('restart');
    this.setStatus('restarting');
    const startupMs = this.spec.startupTimeoutMs ?? 60000;
    try {
      await this.host.request(
        'restart',
        { startupTimeout: Math.floor(startupMs / 1000) },
        startupMs + 15000,
      );
      this.setStatus('idle');
    } catch (e) {
      this.setStatus('dead');
      throw e;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelQueue('disposed');
    this.failCurrent('Kernel shut down');
    const host = this.host;
    this.host = null;
    this.setStatus('dead');
    if (host) {
      try {
        await host.request('shutdown', {}, 10000);
      } catch {
        /* ignore */
      }
      host.kill();
    }
  }
}
