import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as vscode from 'vscode';
import type { QmdExtensionApi } from '../../src/extension';

export const EXTENSION_ID = 'kortdriessen.qmd-notebook';
export const NOTEBOOK_TYPE = 'qmd-notebook';

export function workspaceDir(): string {
  return process.env.QMD_TEST_WORKSPACE ?? vscode.workspace.workspaceFolders![0]!.uri.fsPath;
}

export function testPython(): string {
  return process.env.QMD_TEST_PYTHON!;
}

export async function api(): Promise<QmdExtensionApi> {
  const ext = vscode.extensions.getExtension<QmdExtensionApi>(EXTENSION_ID);
  assert.ok(ext, 'extension not found');
  return (await ext.activate()) as QmdExtensionApi;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(fn: () => T | Promise<T> | undefined | null | false, timeoutMs = 30000, interval = 250, label = 'condition'): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ''}`);
}

/** Copy a fixture to a scratch file so tests never mutate the shared fixture. */
export function scratchCopy(fixture: string, name = fixture): vscode.Uri {
  const src = path.join(workspaceDir(), fixture);
  const dst = path.join(workspaceDir(), 'scratch', name);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return vscode.Uri.file(dst);
}

export async function openNotebook(uri: vscode.Uri): Promise<{ notebook: vscode.NotebookDocument; editor: vscode.NotebookEditor }> {
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  assert.equal(notebook.notebookType, NOTEBOOK_TYPE);
  const editor = await vscode.window.showNotebookDocument(notebook);
  await waitFor(() => notebook.getCells().every((c) => c.metadata?.qmd?.id), 10000, 100, 'cell ids');
  return { notebook, editor };
}

export async function closeAll(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await sleep(200);
}

export async function selectTestKernel(notebook: vscode.NotebookDocument): Promise<void> {
  const a = await api();
  await a.controllers.refresh();
  const ctrl = await waitFor(() => a.controllers.all.find((c) => c.candidate.pythonPath && fs.realpathSync(c.candidate.pythonPath) === fs.realpathSync(testPython())), 30000, 500, 'test kernel controller');
  await vscode.commands.executeCommand('notebook.selectKernel', { id: ctrl.id, extension: EXTENSION_ID });
  await waitFor(() => a.registry.getSelectedController(notebook)?.id === ctrl.id, 15000, 200, 'kernel selection');
}

export async function runCell(notebook: vscode.NotebookDocument, index: number): Promise<vscode.NotebookCell> {
  await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: index, end: index + 1 }], document: notebook.uri });
  const cell = notebook.cellAt(index);
  await waitFor(() => cell.executionSummary?.executionOrder !== undefined || cell.outputs.length > 0, 60000, 100, `execution of cell ${index}`);
  return cell;
}

export function outputText(cell: vscode.NotebookCell, mime: string): string {
  return cell.outputs
    .flatMap((o) => o.items)
    .filter((i) => i.mime === mime)
    .map((i) => Buffer.from(i.data).toString('utf8'))
    .join('');
}

export function outputMimes(cell: vscode.NotebookCell): string[][] {
  return cell.outputs.map((o) => o.items.map((i) => i.mime));
}

export function readFile(uri: vscode.Uri): string {
  return fs.readFileSync(uri.fsPath, 'utf8');
}

export async function replaceCellText(cell: vscode.NotebookCell, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const doc = cell.document;
  edit.replace(doc.uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

// ------------------------------------------------------------------ images
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]!) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** A solid-colour RGB PNG (valid, decodable by any viewer) for image-attachment tests. */
export function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
