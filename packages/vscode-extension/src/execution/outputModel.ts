/**
 * Translates Jupyter IOPub messages into an editor-agnostic output model with Jupyter semantics:
 * stream merging, display_data / execute_result bundles, update_display_data by display_id,
 * error outputs, and clear_output(wait).
 *
 * The controller supplies an OutputSink that maps these operations onto VS Code's
 * NotebookCellExecution API; tests use an in-memory sink.
 */
import type { IopubMessage } from './kernelHost';

export const STDOUT_MIME = 'application/vnd.code.notebook.stdout';
export const STDERR_MIME = 'application/vnd.code.notebook.stderr';
export const ERROR_MIME = 'application/vnd.code.notebook.error';

export interface OutputItem {
  mime: string;
  data: Uint8Array;
}

export interface OutputRecord {
  kind: 'stream' | 'display_data' | 'execute_result' | 'error';
  items: OutputItem[];
  metadata: Record<string, unknown>;
  displayId?: string;
  streamName?: 'stdout' | 'stderr';
}

export interface OutputSink {
  append(output: OutputRecord): void;
  appendItems(output: OutputRecord, items: OutputItem[]): void;
  replaceItems(output: OutputRecord, items: OutputItem[]): void;
  clear(): void;
}

const enc = new TextEncoder();

const BINARY_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

export function bundleToItems(data: Record<string, unknown>): OutputItem[] {
  const items: OutputItem[] = [];
  for (const [mime, raw] of Object.entries(data ?? {})) {
    const value = Array.isArray(raw) ? raw.join('') : raw;
    if (BINARY_IMAGE_MIMES.has(mime)) {
      if (typeof value === 'string') {
        items.push({ mime, data: Buffer.from(value.replace(/\s+/g, ''), 'base64') });
      }
      continue;
    }
    if (typeof value === 'string') {
      items.push({ mime, data: enc.encode(value) });
    } else {
      items.push({ mime, data: enc.encode(JSON.stringify(value)) });
    }
  }
  // Richer mimes first so VS Code's display-order picks them sensibly.
  const rank = (m: string): number => {
    if (m === 'text/plain') return 9;
    if (m === 'text/html') return 2;
    if (m.startsWith('image/')) return 1;
    return 5;
  };
  items.sort((a, b) => rank(a.mime) - rank(b.mime));
  return items;
}

export function errorToItem(ename: string, evalue: string, traceback: string[]): OutputItem {
  const stack = (traceback ?? []).join('\n');
  return {
    mime: ERROR_MIME,
    data: enc.encode(JSON.stringify({ name: ename, message: evalue, stack })),
  };
}

export class OutputAccumulator {
  readonly outputs: OutputRecord[] = [];
  private readonly byDisplayId = new Map<string, OutputRecord>();
  private clearPending = false;
  executionCount: number | null = null;
  lastError: { ename: string; evalue: string; traceback: string[] } | null = null;

  constructor(private readonly sink: OutputSink) {}

  private flushClearIfPending(): void {
    if (this.clearPending) {
      this.clearPending = false;
      this.doClear();
    }
  }

  private doClear(): void {
    this.outputs.length = 0;
    this.byDisplayId.clear();
    this.sink.clear();
  }

  handle(msg: IopubMessage): void {
    const c = msg.content ?? {};
    switch (msg.msg_type) {
      case 'execute_input':
        if (typeof c.execution_count === 'number') this.executionCount = c.execution_count;
        return;
      case 'stream': {
        this.flushClearIfPending();
        const name: 'stdout' | 'stderr' = c.name === 'stderr' ? 'stderr' : 'stdout';
        const text = Array.isArray(c.text) ? c.text.join('') : String(c.text ?? '');
        const item: OutputItem = {
          mime: name === 'stderr' ? STDERR_MIME : STDOUT_MIME,
          data: enc.encode(text),
        };
        const last = this.outputs[this.outputs.length - 1];
        if (last && last.kind === 'stream' && last.streamName === name) {
          last.items.push(item);
          this.sink.appendItems(last, [item]);
        } else {
          const rec: OutputRecord = { kind: 'stream', items: [item], metadata: {}, streamName: name };
          this.outputs.push(rec);
          this.sink.append(rec);
        }
        return;
      }
      case 'display_data':
      case 'execute_result': {
        this.flushClearIfPending();
        if (msg.msg_type === 'execute_result' && typeof c.execution_count === 'number') {
          this.executionCount = c.execution_count;
        }
        const items = bundleToItems(c.data ?? {});
        const displayId: string | undefined = c.transient?.display_id;
        const rec: OutputRecord = {
          kind: msg.msg_type,
          items,
          metadata: {
            outputType: msg.msg_type,
            metadata: c.metadata ?? {},
            ...(msg.msg_type === 'execute_result'
              ? { executionCount: c.execution_count ?? null }
              : {}),
          },
          displayId,
        };
        this.outputs.push(rec);
        if (displayId) this.byDisplayId.set(displayId, rec);
        this.sink.append(rec);
        return;
      }
      case 'update_display_data': {
        const displayId: string | undefined = c.transient?.display_id;
        if (!displayId) return;
        const rec = this.byDisplayId.get(displayId);
        if (!rec) return;
        const items = bundleToItems(c.data ?? {});
        rec.items = items;
        rec.metadata = { ...rec.metadata, metadata: c.metadata ?? {} };
        this.sink.replaceItems(rec, items);
        return;
      }
      case 'error': {
        this.flushClearIfPending();
        const ename = String(c.ename ?? 'Error');
        const evalue = String(c.evalue ?? '');
        const traceback: string[] = Array.isArray(c.traceback) ? c.traceback.map(String) : [];
        this.lastError = { ename, evalue, traceback };
        const rec: OutputRecord = {
          kind: 'error',
          items: [errorToItem(ename, evalue, traceback)],
          metadata: { outputType: 'error' },
        };
        this.outputs.push(rec);
        this.sink.append(rec);
        return;
      }
      case 'clear_output': {
        if (c.wait) this.clearPending = true;
        else this.doClear();
        return;
      }
      default:
        return; // status is handled by the session; comm_* / debug messages are ignored in V1
    }
  }
}

/** Convenience: decode output items for summaries. */
export function itemText(item: OutputItem, maxChars = 4000): { text: string; truncated: boolean } {
  const text = Buffer.from(item.data).toString('utf8');
  if (text.length > maxChars) return { text: text.slice(0, maxChars), truncated: true };
  return { text, truncated: false };
}
