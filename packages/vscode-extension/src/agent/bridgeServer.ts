/**
 * Local authenticated bridge: Unix domain socket (loopback TCP fallback) speaking NDJSON
 * JSON-RPC 2.0. A discovery record (0600) in a user-private directory (0700) tells the
 * qmd-notebook-mcp companion where to connect and which token to present.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  BridgeError,
  NdjsonDecoder,
  PROTOCOL_VERSION,
  RpcErrorCodes,
  encodeMessage,
  newInstanceId,
  newToken,
  type DiscoveryRecord,
  type RpcRequest,
  type RpcResponse,
} from '@qmd-notebook/shared';
import type { Logger } from '../util/logger';

export type BridgeHandler = (method: string, params: unknown, client: BridgeClient) => Promise<unknown>;

export interface BridgeClient {
  id: number;
  name: string;
  authenticated: boolean;
  connectedAt: string;
}

export function runtimeDir(): string {
  const base = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : path.join(os.tmpdir(), `qmd-notebook-${os.userInfo().uid ?? 'user'}`);
  return path.join(base, 'qmd-notebook');
}

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort on platforms without POSIX perms */
  }
}

/** Remove discovery records whose VS Code process is gone. */
export function cleanupStaleRecords(dir: string, logger?: Logger): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as DiscoveryRecord;
      let alive = true;
      try {
        process.kill(rec.pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        fs.rmSync(file, { force: true });
        if (rec.socketPath && !rec.socketPath.startsWith('tcp:')) fs.rmSync(rec.socketPath, { force: true });
        logger?.info(`removed stale bridge record ${name}`);
      }
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
}

export class BridgeServer implements vscode.Disposable {
  readonly instanceId = newInstanceId();
  private readonly token = newToken();
  private server: net.Server | null = null;
  private socketPath = '';
  private recordPath = '';
  private readonly clients = new Map<number, { client: BridgeClient; socket: net.Socket }>();
  private nextClientId = 1;
  private readonly _onDidChangeClients = new vscode.EventEmitter<void>();
  readonly onDidChangeClients = this._onDidChangeClients.event;
  private started = false;

  constructor(
    private readonly handler: BridgeHandler,
    private readonly logger: Logger,
    private readonly extensionVersion: string,
  ) {}

  get isRunning(): boolean {
    return this.started;
  }

  get connectedClients(): BridgeClient[] {
    return Array.from(this.clients.values())
      .map((c) => c.client)
      .filter((c) => c.authenticated);
  }

  get discoveryPath(): string {
    return this.recordPath;
  }

  get endpoint(): string {
    return this.socketPath;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const dir = runtimeDir();
    ensurePrivateDir(dir);
    cleanupStaleRecords(dir, this.logger);
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    server.on('error', (e) => this.logger.error(`bridge server error: ${String(e)}`));
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const addr = server.address() as net.AddressInfo;
      this.socketPath = `tcp:${addr.port}`;
    } else {
      this.socketPath = path.join(dir, `${this.instanceId}.sock`);
      fs.rmSync(this.socketPath, { force: true });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
      try {
        fs.chmodSync(this.socketPath, 0o600);
      } catch {
        /* ignore */
      }
    }
    this.recordPath = path.join(dir, `${this.instanceId}.json`);
    this.writeRecord();
    this.started = true;
    this.logger.info(`agent bridge listening at ${this.socketPath}`);
  }

  writeRecord(): void {
    if (!this.recordPath) return;
    const record: DiscoveryRecord = {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this.instanceId,
      pid: process.pid,
      socketPath: this.socketPath,
      token: this.token,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      remoteName: vscode.env.remoteName ?? null,
      vscodeVersion: vscode.version,
      extensionVersion: this.extensionVersion,
      startedAt: new Date().toISOString(),
    };
    const tmp = `${this.recordPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.recordPath);
  }

  private accept(socket: net.Socket): void {
    const id = this.nextClientId++;
    const client: BridgeClient = { id, name: 'unknown', authenticated: false, connectedAt: new Date().toISOString() };
    this.clients.set(id, { client, socket });
    this.logger.debug(`bridge: client ${id} connected`);
    const authTimer = setTimeout(() => {
      if (!client.authenticated) {
        this.logger.warn(`bridge: client ${id} did not authenticate in time`);
        socket.destroy();
      }
    }, 5000);
    const decoder = new NdjsonDecoder(
      (msg) => void this.onMessage(msg as RpcRequest, client, socket),
      (line) => {
        this.send(socket, { jsonrpc: '2.0', id: null, error: { code: RpcErrorCodes.ParseError, message: 'parse error' } });
        this.logger.warn(`bridge: unparseable line from client ${id}: ${line.slice(0, 80)}`);
      },
      8 * 1024 * 1024,
    );
    socket.on('data', (chunk) => decoder.feed(chunk));
    socket.on('error', (e) => this.logger.debug(`bridge: client ${id} socket error ${String(e)}`));
    socket.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(id);
      this.logger.debug(`bridge: client ${id} disconnected`);
      this._onDidChangeClients.fire();
    });
  }

  private send(socket: net.Socket, msg: RpcResponse): void {
    if (socket.destroyed) return;
    socket.write(encodeMessage(msg));
  }

  private async onMessage(msg: RpcRequest, client: BridgeClient, socket: net.Socket): Promise<void> {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      this.send(socket, { jsonrpc: '2.0', id: (msg as any)?.id ?? null, error: { code: RpcErrorCodes.InvalidRequest, message: 'invalid request' } });
      return;
    }
    const id = msg.id ?? null;
    if (!client.authenticated) {
      if (msg.method !== 'hello') {
        this.send(socket, { jsonrpc: '2.0', id, error: { code: RpcErrorCodes.Unauthorized, message: 'hello with token required first' } });
        socket.destroy();
        return;
      }
      const p = (msg.params ?? {}) as { token?: string; protocolVersion?: number; client?: string };
      if (!p.token || !timingSafeEqualStr(p.token, this.token)) {
        this.send(socket, { jsonrpc: '2.0', id, error: { code: RpcErrorCodes.Unauthorized, message: 'invalid token' } });
        this.logger.warn(`bridge: client ${client.id} presented an invalid token`);
        socket.destroy();
        return;
      }
      if (p.protocolVersion !== PROTOCOL_VERSION) {
        this.send(socket, { jsonrpc: '2.0', id, error: { code: RpcErrorCodes.Unsupported, message: `protocol version ${p.protocolVersion} not supported (extension speaks ${PROTOCOL_VERSION})` } });
        socket.destroy();
        return;
      }
      client.authenticated = true;
      client.name = p.client ?? 'unknown';
      this.logger.info(`bridge: client ${client.id} authenticated (${client.name})`);
      this._onDidChangeClients.fire();
      try {
        const result = await this.handler('hello', msg.params, client);
        this.send(socket, { jsonrpc: '2.0', id, result });
      } catch (e) {
        this.send(socket, { jsonrpc: '2.0', id, error: toRpcError(e) });
      }
      return;
    }
    try {
      const result = await this.handler(msg.method, msg.params, client);
      this.send(socket, { jsonrpc: '2.0', id, result: result ?? null });
    } catch (e) {
      const err = toRpcError(e);
      if (err.code === RpcErrorCodes.Internal) this.logger.error(`bridge: ${msg.method} failed: ${err.message}`);
      else this.logger.debug(`bridge: ${msg.method} -> ${err.code} ${err.message}`);
      this.send(socket, { jsonrpc: '2.0', id, error: err });
    }
  }

  dispose(): void {
    for (const { socket } of this.clients.values()) socket.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    if (this.recordPath) fs.rmSync(this.recordPath, { force: true });
    if (this.socketPath && !this.socketPath.startsWith('tcp:')) fs.rmSync(this.socketPath, { force: true });
    this.started = false;
    this._onDidChangeClients.dispose();
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

export function toRpcError(e: unknown): { code: number; message: string; data?: unknown } {
  if (e instanceof BridgeError) return e.toRpc();
  if (e && typeof e === 'object' && (e as any).name === 'BridgeError') {
    const be = e as { code: number; message: string; data?: unknown };
    return be.data === undefined ? { code: be.code, message: be.message } : { code: be.code, message: be.message, data: be.data };
  }
  return { code: RpcErrorCodes.Internal, message: e instanceof Error ? e.message : String(e) };
}
