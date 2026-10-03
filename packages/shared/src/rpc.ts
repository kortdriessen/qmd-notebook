/** Minimal newline-delimited JSON-RPC 2.0 framing helpers shared by client and server. */
import type { RpcMessage } from './protocol';

export function encodeMessage(msg: RpcMessage): string {
  return JSON.stringify(msg) + '\n';
}

/**
 * Incremental NDJSON decoder. Feed raw chunks; receive parsed messages. Invalid JSON lines are
 * reported through `onError` and skipped.
 */
export class NdjsonDecoder {
  private buffer = '';

  constructor(
    private readonly onMessage: (msg: RpcMessage) => void,
    private readonly onError: (line: string, error: unknown) => void,
    private readonly maxLineBytes = 64 * 1024 * 1024,
  ) {}

  feed(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (this.buffer.length > this.maxLineBytes) {
      const dropped = this.buffer;
      this.buffer = '';
      this.onError(dropped.slice(0, 200), new Error('line too long'));
      return;
    }
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.onMessage(JSON.parse(trimmed) as RpcMessage);
      } catch (e) {
        this.onError(trimmed, e);
      }
    }
  }
}
