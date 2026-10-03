/**
 * MCP tool surface. Every tool maps 1:1 onto a bridge method; results are returned as JSON text
 * (plus image content for image outputs) so any MCP client can use them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BridgeMethods, Shapes, type ShapeName } from '@qmd-notebook/shared';
import { BridgeCallError, type BridgeClient } from './ipcClient';
import { NoBridgeError } from './discovery';

export interface ToolOptions {
  /** Upper bound for long-polls when the agent omits timeoutMs (CLI --max-wait / QMD_NOTEBOOK_MAX_WAIT_MS). */
  maxWaitMs?: number;
}

/** Long-poll tools: the companion fills in the wait budget and forwards MCP cancellation to the bridge. */
export const WAIT_TOOLS = new Set(['wait_for_comments', 'wait_for_request']);
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
/** Claude Code's default per-call MCP tool timeout is ~28 h (MCP_TOOL_TIMEOUT); Codex's is 60 s (tool_timeout_sec). */
const CLIENT_ALLOWANCE_MS: Record<string, number> = { 'claude-code': 4 * 60 * 60 * 1000 };
const CONSERVATIVE_ALLOWANCE_MS = 55000;

/**
 * How long an omitted long-poll waits: the configured maximum if any, otherwise what the MCP client
 * (identified at the initialize handshake) is known to allow per tool call.
 */
export function defaultWaitMs(clientName: string | undefined, maxWaitMs?: number): number {
  const allowance = (clientName ? CLIENT_ALLOWANCE_MS[clientName] : undefined) ?? CONSERVATIVE_ALLOWANCE_MS;
  const cap = maxWaitMs ?? allowance;
  return Math.max(1000, Math.min(cap, MAX_WAIT_MS));
}

interface ToolSpec {
  name: string;
  method: keyof typeof BridgeMethods;
  shape: ShapeName;
  title: string;
  description: string;
  readOnly: boolean;
  destructive?: boolean;
}

export const TOOLS: ToolSpec[] = [
  { name: 'list_open_notebooks', method: 'listOpenNotebooks', shape: 'listOpenNotebooks', title: 'List open QMD notebooks', readOnly: true, description: 'List the .qmd notebooks open in the connected VS Code window: document IDs, paths, version, dirty state, selected kernel and cell counts. Call this first when several notebooks may be open.' },
  { name: 'get_active_context', method: 'getActiveContext', shape: 'getActiveContext', title: 'Get active notebook context', readOnly: true, description: 'The active QMD notebook, selected cell IDs, current text selection inside a cell (if any), kernel status, and pending user requests. Use this to find out what the user is looking at without asking them for paths or cell numbers.' },
  { name: 'read_notebook', method: 'readNotebook', shape: 'readNotebook', title: 'Read notebook cells', readOnly: true, description: 'Ordered cells of a live notebook with runtime cell IDs, kind, source, sourceHash, execution state and bounded output summaries. Returns the notebook content version (informational; edits are guarded per cell). outline: true returns just the map (one line per cell); knownHashes makes it a delta read (unchanged cells come back without source). Use startIndex/endIndex to page through large notebooks.' },
  { name: 'read_cell', method: 'readCell', shape: 'readCell', title: 'Read one cell', readOnly: true, description: 'Read one cell by runtime cell ID (source, sourceHash, outputs). Only needed when you do not already hold the cell\'s current sourceHash: comment packets, edit results and execution results all carry it.' },
  { name: 'read_attachment', method: 'readAttachment', shape: 'readAttachment', title: 'Read an image attached to a comment', readOnly: true, description: 'Fetch an image the user pasted into a comment (imageId from the packet\'s attachments of kind "image"): MCP image content for clients that display it (Claude Code), otherwise the private file path to open with your image viewing tool (Codex: view_image). Images attached to the message being delivered already arrive with wait_for_comments; use this for earlier ones or ones listed in inlineImagesOmitted.' },
  { name: 'read_output', method: 'readOutput', shape: 'readOutput', title: 'Read an output (text, HTML, or image)', readOnly: true, description: 'Fetch one output of a cell by outputId. Images (e.g. matplotlib PNGs) are returned as MCP image content and/or written to a private temp file whose path is returned; text/HTML outputs are returned as bounded text with the producing cell source.' },
  { name: 'replace_cell_source', method: 'replaceCellSource', shape: 'replaceCellSource', title: 'Replace a cell\'s source', readOnly: false, description: 'Replace the whole source of a live cell through VS Code (undoable, visible to the user immediately); for changes to a few lines use edit_cell_text instead. Requires expectedSourceHash (from the comment packet, a read, or your previous edit); rejected with a conflict carrying the current source only if the user changed that cell since (other cells changing never conflicts). With execute: true the cell is run right away and the result includes its outputs/error. With requestId (+ note) the comment thread shows you working. Never edits the .qmd file directly.' },
  { name: 'edit_cell_text', method: 'editCellText', shape: 'editCellText', title: 'Edit text inside a cell', readOnly: false, description: 'Targeted edit inside a cell, like a file edit tool: exact oldText → newText pairs (each must match exactly once unless replaceAll), applied in order and written through VS Code as one undoable change that leaves the rest of the cell untouched. Requires expectedSourceHash. Prefer this over replace_cell_source for anything smaller than a rewrite: far fewer output tokens and nothing can drift. Missing or ambiguous oldText is rejected before anything is written, with the current source, the ambiguous line numbers and a whitespace hint. Supports execute: true and requestId/note.' },
  { name: 'insert_cell', method: 'insertCell', shape: 'insertCell', title: 'Insert a cell', readOnly: false, description: 'Insert a python or markdown cell above/below an anchor cell (or at the start/end). Returns the new cell ID and sourceHash. Requires only that the anchor cell still exists. Supports execute: true and requestId/note like replace_cell_source.' },
  { name: 'delete_cell', method: 'deleteCell', shape: 'deleteCell', title: 'Delete a cell', readOnly: false, destructive: true, description: 'Delete a cell by ID. Requires expectedSourceHash. Supports requestId/note.' },
  { name: 'move_cell', method: 'moveCell', shape: 'moveCell', title: 'Move a cell', readOnly: false, description: 'Move a cell above/below another cell (both addressed by id, so other edits never conflict). Supports requestId/note.' },
  { name: 'apply_cell_edits', method: 'applyCellEdits', shape: 'applyCellEdits', title: 'Apply several cell edits', readOnly: false, description: 'Batch of edit (oldText/newText pairs)/replace/insert/delete/move operations with per-cell preconditions, all checked before anything is applied. With execute: true the replaced/inserted python cells are run in notebook order (stopping at the first error) and their results are returned. Supports requestId/note.' },
  { name: 'execute_cell', method: 'executeCell', shape: 'executeCell', title: 'Execute a cell', readOnly: false, description: 'Execute a cell by ID in the notebook\'s live kernel (the same kernel the user sees) and wait up to timeoutMs (default 45 s) for completion. Returns execution count, success, bounded outputs and any error/traceback; full outputs appear under the cell in VS Code. If the wait expires the cell keeps running (stillRunning: true): poll read_cell or interrupt_kernel. Cells with `#| eval: false` are skipped unless force=true. Supports requestId/note. (Prefer execute: true on the edit call when you just changed the cell.)' },
  { name: 'execute_cells', method: 'executeCells', shape: 'executeCells', title: 'Execute several cells in order', readOnly: false, description: 'Execute cells in the given order, stopping at the first error by default.' },
  { name: 'execute_scratch', method: 'executeScratch', shape: 'executeScratch', title: 'Run scratch code in the live kernel', readOnly: false, description: 'Run temporary Python in the notebook\'s live kernel WITHOUT creating a cell (store_history=False). It CAN mutate kernel state (assignments, imports, side effects) — prefer list_variables/summarize_variable for inspection. Returns bounded stdout/stderr/results/error. The user sees an "agent scratch execution" indicator while it runs.' },
  { name: 'list_variables', method: 'listVariables', shape: 'listVariables', title: 'List kernel variables', readOnly: true, description: 'List user variables in the live kernel with type, shape and approximate size, without creating a cell.' },
  { name: 'summarize_variable', method: 'summarizeVariable', shape: 'summarizeVariable', title: 'Summarize a kernel variable', readOnly: true, description: 'Bounded structured summary of one variable: DataFrame shape/columns/dtypes/head/nulls, Series head, ndarray dtype/min/max/mean/NaNs, dict keys, exception traceback (name "__last_error__" gives the last exception). Accepts dotted paths like model.coef_.' },
  { name: 'interrupt_kernel', method: 'interruptKernel', shape: 'interruptKernel', title: 'Interrupt the kernel', readOnly: false, description: 'Interrupt the running execution in the notebook\'s kernel.' },
  { name: 'restart_kernel', method: 'restartKernel', shape: 'restartKernel', title: 'Restart the kernel', readOnly: false, destructive: true, description: 'Restart the notebook\'s kernel (all variables are lost; outputs stay). Ask the user before doing this unless they requested it.' },
  { name: 'assign_notebook', method: 'assignNotebook', shape: 'assignNotebook', title: 'Watch a notebook for comments', readOnly: false, description: 'Assign yourself to a notebook (by file name, path suffix, documentId, or the active one). The notebook UI then shows you as the watching agent; comments the user adds to cells/selections/outputs are routed to you through wait_for_comments. Returns the comments already waiting (full packets) and a map of the notebook (one line per cell: id, first line, sourceHash, execution state).' },
  { name: 'release_notebook', method: 'releaseNotebook', shape: 'releaseNotebook', title: 'Stop watching a notebook', readOnly: false, description: 'Release your assignment to a notebook (the UI shows "no agent watching" again).' },
  { name: 'wait_for_comments', method: 'waitForComments', shape: 'waitForComments', title: 'Wait for the next user comments', readOnly: true, description: 'Long-poll for comments the user attached inside the notebook editor. Omit timeoutMs to wait as long as your client allows (the call returns the instant a comment arrives, so waiting is free). Returns the queued comments as full packets (prompt, attached cell source with its current sourceHash, the notebook version to use as expectedVersion, selection/output preview, neighbouring cells, kernel status, the thread so far; followUp: true when the user replied in an existing thread) plus a notebook map, an empty list when the wait expires (call again), or stopped: true when the notebook was closed or you were released.' },
  { name: 'get_request', method: 'getRequest', shape: 'getRequest', title: 'Get a comment/request by ID', readOnly: true, description: 'Fetch the stored packet of a user comment (prompt, attachments, thread). wait_for_comments already returns the same packet; use this for older threads or when the user hands you a request ID.' },
  { name: 'list_requests', method: 'listRequests', shape: 'listRequests', title: 'List user requests', readOnly: true, description: 'List pending (default) or all contextual requests.' },
  { name: 'update_request', method: 'updateRequest', shape: 'updateRequest', title: 'Post progress on a comment', readOnly: false, description: 'Set the comment status (working, needs-input, …) and/or post a short note; it appears as your reply inside the comment thread in the notebook. Passing requestId + note to an edit/execute call does the same without an extra call; use update_request for questions (needs-input) or notes between steps.' },
  { name: 'resolve_request', method: 'resolveRequest', shape: 'resolveRequest', title: 'Resolve a comment', readOnly: false, description: 'Mark a comment completed/failed with a concise reply (posted into the thread, which then collapses as resolved) and the IDs of cells you edited or executed.' },
  { name: 'wait_for_request', method: 'waitForRequest', shape: 'waitForRequest', title: 'Wait for the next user request', readOnly: true, description: 'Bounded long-poll (max 120 s) that returns the next queued user request or null on timeout. Only use this when the user explicitly asked you to watch the notebook for requests; loop deliberately and stop when asked.' },
];

type ContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/**
 * Which MCP clients show image content blocks to their model. Verified 2026-09-03: Claude Code
 * does; Codex 0.149 parses them but the model never sees them (it guessed the colour of a solid
 * swatch), while its built-in view_image tool reads a local file path fine. Unknown clients get
 * the file-path route too, which always works.
 */
export function clientSupportsImageContent(clientName: string | undefined): boolean {
  return clientName === 'claude-code';
}

const VIEW_HINT = 'this client does not display MCP image content; open the file with your image viewing tool (Codex: view_image) before acting';

/**
 * Pull image bytes out of a bridge result. For clients that show image content, a top-level
 * `base64`+`mime` (read_output / read_attachment) becomes one image block and every entry of an
 * `inlineImages` array (comment packets) becomes a labelled image block, so no base64 ever counts
 * as text tokens. For other clients the bytes are dropped and replaced by the private file path.
 */
export function splitImages(result: unknown, imagesSupported = true): { json: unknown; leading: ContentBlock[]; trailing: ContentBlock[] } {
  const leading: ContentBlock[] = [];
  const trailing: ContentBlock[] = [];
  if (!result || typeof result !== 'object') return { json: result, leading, trailing };
  const top = result as Record<string, unknown>;
  // read_output / read_attachment image results: `base64` is a string (inline) or null (file-only).
  if (typeof top.mime === 'string' && Object.prototype.hasOwnProperty.call(top, 'base64')) {
    const { base64, ...rest } = top;
    if (imagesSupported) {
      if (typeof base64 === 'string') leading.push({ type: 'image', data: base64, mimeType: top.mime });
      else rest.base64 = base64;
    } else {
      rest.base64 = null;
      rest.viewHint = typeof rest.filePath === 'string' ? `${VIEW_HINT}: ${rest.filePath}` : VIEW_HINT;
    }
    return { json: rest, leading, trailing };
  }
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 3 || !node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((n) => walk(n, depth + 1));
    const obj = { ...(node as Record<string, unknown>) };
    const inline = obj.inlineImages;
    if (Array.isArray(inline)) {
      delete obj.inlineImages;
      const entries = inline as Array<{ imageId: string; name: string; mime: string; base64: string; filePath?: string }>;
      if (imagesSupported) {
        for (const im of entries) {
          trailing.push({ type: 'text', text: `[image attached to comment ${String(obj.requestId ?? '')}: ${im.name} (${im.imageId})]` });
          trailing.push({ type: 'image', data: im.base64, mimeType: im.mime });
        }
        obj.inlineImagesDelivered = entries.map((im) => im.imageId);
      } else {
        obj.attachedImages = entries.map((im) => ({ imageId: im.imageId, name: im.name, mime: im.mime, filePath: im.filePath ?? null }));
        obj.attachedImagesHint = `${entries.length} image(s) attached by the user; ${VIEW_HINT}: ${entries.map((im) => im.filePath ?? im.imageId).join(', ')}`;
      }
    }
    for (const k of Object.keys(obj)) obj[k] = walk(obj[k], depth + 1);
    return obj;
  };
  return { json: walk(result, 0), leading, trailing };
}

function formatError(e: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  if (e instanceof NoBridgeError) return { content: [{ type: 'text', text: e.message }], isError: true };
  if (e instanceof BridgeCallError) {
    const payload = { error: e.message, code: e.code, ...(e.data !== undefined ? { data: e.data } : {}) };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
  }
  return { content: [{ type: 'text', text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
}

/** Bridge call budget: the agent's own wait/execution budget plus a margin for the round trip. */
export function bridgeTimeoutFor(toolName: string, params: Record<string, unknown>): number {
  const base = 130000;
  if (WAIT_TOOLS.has(toolName)) return Number(params.timeoutMs ?? 60000) + 30000;
  if (typeof params.timeoutMs === 'number') return Math.max(base, params.timeoutMs + 30000);
  if (toolName === 'execute_cells' && Array.isArray(params.cellIds)) return Math.max(base, 45000 * params.cellIds.length + 30000);
  if ((toolName === 'apply_cell_edits' && params.execute && Array.isArray(params.edits))) return Math.max(base, 45000 * params.edits.length + 30000);
  return base;
}

export function registerTools(server: McpServer, client: BridgeClient, options: ToolOptions = {}): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: Shapes[tool.shape] as any,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: !!tool.destructive, idempotentHint: tool.readOnly, openWorldHint: false },
      },
      async (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => {
        const params: Record<string, unknown> = { ...(args ?? {}) };
        const imagesSupported = clientSupportsImageContent(server.server.getClientVersion()?.name);
        // Clients that cannot show image content get file paths instead of megabytes of base64.
        if (!imagesSupported && (tool.name === 'read_output' || tool.name === 'read_attachment') && params.imageDelivery === undefined) params.imageDelivery = 'file';
        const isWait = WAIT_TOOLS.has(tool.name);
        if (isWait && params.timeoutMs === undefined) params.timeoutMs = defaultWaitMs(server.server.getClientVersion()?.name, options.maxWaitMs);
        // The client gave up (Escape in the CLI, its own timeout): tell the bridge so the comment is
        // not marked as delivered to a wait nobody is reading.
        const onAbort = () => void client.call(BridgeMethods.cancelWait, {}, 10000).catch(() => undefined);
        if (isWait) extra?.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const result = await client.call(BridgeMethods[tool.method], params, bridgeTimeoutFor(tool.name, params));
          const { json, leading, trailing } = splitImages(result, imagesSupported);
          return { content: [...leading, { type: 'text' as const, text: JSON.stringify(json ?? null, null, 2) }, ...trailing] };
        } catch (e) {
          return formatError(e);
        } finally {
          if (isWait) extra?.signal?.removeEventListener('abort', onAbort);
        }
      },
    );
  }
}
