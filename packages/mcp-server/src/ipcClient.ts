/**
 * NDJSON JSON-RPC client for the extension bridge with lazy connect, authentication and
 * re-discovery after the VS Code window restarts.
 */
import * as net from 'node:net';
import { NdjsonDecoder, PROTOCOL_VERSION, encodeMessage, type RpcResponse } from '@qmd-notebook/shared';
import { findBridge, type FoundRecord } from './discovery';

export class BridgeCallError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'BridgeCallError';
  }
}

export interface BridgeClientOptions {
  workspace: string;
  clientName: string;
  log?: (message: string) => void;
}

export class BridgeClient {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private record: FoundRecord | null = null;

  constructor(private readonly options: BridgeClientOptions) {}

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  get currentRecord(): FoundRecord | null {
    return this.record;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const found = findBridge(this.options.workspace);
    this.record = found;
    const rec = found.record;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = rec.socketPath.startsWith('tcp:') ? net.connect({ host: '127.0.0.1', port: Number(rec.socketPath.slice(4)) }) : net.connect(rec.socketPath);
      const onError = (e: Error) => reject(new Error(`cannot connect to bridge at ${rec.socketPath}: ${e.message}`));
      s.once('error', onError);
      s.once('connect', () => {
        s.off('error', onError);
        resolve(s);
      });
    });
    const decoder = new NdjsonDecoder(
      (msg) => this.onMessage(msg as RpcResponse),
      (line) => this.log(`unparseable line from bridge: ${line.slice(0, 80)}`),
      64 * 1024 * 1024,
    );
    socket.on('data', (chunk) => decoder.feed(chunk));
    socket.on('error', (e) => this.log(`bridge socket error: ${e.message}`));
    socket.on('close', () => {
      this.log('bridge connection closed');
      if (this.socket === socket) this.socket = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new BridgeCallError('bridge connection closed', -32000));
      }
      this.pending.clear();
    });
    this.socket = socket;
    await this.rawCall('hello', { token: rec.token, protocolVersion: PROTOCOL_VERSION, client: this.options.clientName, workspace: this.options.workspace }, 10000);
    this.log(`connected to bridge ${rec.instanceId} (${rec.workspaceFolders.join(', ')})`);
  }

  private onMessage(msg: RpcResponse): void {
    if (!msg || typeof msg !== 'object' || !('id' in msg) || typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new BridgeCallError(msg.error.message, msg.error.code, msg.error.data));
    else p.resolve(msg.result);
  }

  private rawCall(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new BridgeCallError('not connected', -32000));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeCallError(`bridge call ${method} timed out after ${timeoutMs} ms`, -32005));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async call(method: string, params: unknown = {}, timeoutMs = 130000): Promise<unknown> {
    await this.connect();
    try {
      return await this.rawCall(method, params, timeoutMs);
    } catch (e) {
      if (e instanceof BridgeCallError && e.code === -32000) {
        // connection dropped (VS Code reloaded?) → one reconnect attempt
        this.socket = null;
        await this.connect();
        return this.rawCall(method, params, timeoutMs);
      }
      throw e;
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
