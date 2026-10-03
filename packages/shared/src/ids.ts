import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function newCellId(): string {
  return `qmdcell_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function newDocumentId(): string {
  return `qmddoc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function newRequestId(): string {
  return `qmdreq_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function newInstanceId(): string {
  return `qmdvs_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Stable, short content hash used for optimistic concurrency preconditions. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export function makeOutputId(cellId: string, index: number, contentHash: string): string {
  return `${cellId}:${index}:${contentHash.slice(0, 8)}`;
}

export function parseOutputId(
  outputId: string,
): { cellId: string; index: number; hash: string } | null {
  const m = /^(qmdcell_[a-f0-9]+):(\d+):([a-f0-9]{8})$/.exec(outputId);
  if (!m) return null;
  return { cellId: m[1]!, index: Number(m[2]), hash: m[3]! };
}
