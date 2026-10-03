/**
 * Zod shapes for every bridge method / MCP tool. The MCP server uses the raw shapes as tool
 * input schemas; the extension validates incoming RPC params with `z.object(shape)`.
 */
import { z } from 'zod';

const documentId = z
  .string()
  .describe('Document ID from list_open_notebooks / get_active_context (omit to use the active notebook)');
const cellId = z.string().describe('Runtime cell ID (qmdcell_...)');
const expectedVersion = z
  .number()
  .int()
  .optional()
  .describe('Optional and informational: the notebook content version you last saw. Edits are guarded per cell (expectedSourceHash, anchor cell ids), so the user editing other cells never conflicts with yours');
const expectedSourceHash = z
  .string()
  .describe('Expected sourceHash of the target cell (from the comment packet, a previous read, or the previous edit result); the edit is rejected if it changed');
const requestId = z
  .string()
  .optional()
  .describe('The comment you are working on (requestId from wait_for_comments): marks it "working", links the touched cells to it and shows `note` in its thread, so no separate update_request call is needed');
const note = z.string().optional().describe('One-line plan or progress note shown in the comment thread (used with requestId)');
const linking = { requestId, note };
const executeAfter = {
  execute: z.boolean().optional().describe('Run the edited/inserted python cell(s) right away and include the execution result(s) (same semantics as execute_cell)'),
  timeoutMs: z.number().int().min(0).optional().describe('Wait budget for that execution (default 45000 ms; on timeout the cell keeps running and stillRunning is reported)'),
};
const longPoll = z
  .number()
  .int()
  .positive()
  .max(21600000)
  .optional()
  .describe('Long-poll budget in ms. Omit it: the companion then waits as long as your MCP client allows (hours for Claude Code; under a minute for Codex unless its tool_timeout_sec was raised). The call returns the moment a comment arrives, so a long wait costs nothing');

const textReplacement = z.object({
  oldText: z.string().describe('Exact text to find in the cell (must occur exactly once unless replaceAll); include enough surrounding lines to make it unique'),
  newText: z.string().describe('Replacement text (empty deletes the matched text)'),
  replaceAll: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one'),
});
const textEdits = z.array(textReplacement).min(1).describe('Applied in order; later edits see the result of earlier ones. Nothing is written if any edit fails');

export const CellEditOperation = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('replace'),
    cellId,
    expectedSourceHash,
    source: z.string(),
  }),
  z.object({
    op: z.literal('edit'),
    cellId,
    expectedSourceHash,
    edits: textEdits,
  }),
  z.object({
    op: z.literal('insert'),
    anchorCellId: cellId.nullable().describe('Anchor cell; null inserts at the start/end of the notebook'),
    position: z.enum(['above', 'below']),
    kind: z.enum(['python', 'markdown']),
    source: z.string(),
  }),
  z.object({
    op: z.literal('delete'),
    cellId,
    expectedSourceHash,
  }),
  z.object({
    op: z.literal('move'),
    cellId,
    anchorCellId: cellId,
    position: z.enum(['above', 'below']),
  }),
]);

export const Shapes = {
  hello: {
    token: z.string(),
    protocolVersion: z.number().int(),
    client: z.string(),
    workspace: z.string().optional(),
  },
  status: {},
  listOpenNotebooks: {},
  getActiveContext: {
    includeNeighborCells: z.boolean().optional(),
  },
  readNotebook: {
    documentId: documentId.optional(),
    startIndex: z.number().int().min(0).optional().describe('First cell index to include (0-based)'),
    endIndex: z.number().int().min(0).optional().describe('Exclusive end cell index'),
    includeOutputs: z.boolean().optional().describe('Include bounded output summaries (default true)'),
    maxBytes: z.number().int().positive().optional().describe('Total byte budget for cell sources'),
    knownHashes: z.record(z.string(), z.string()).optional().describe('cellId → sourceHash you already hold; matching cells come back without source (unchanged: true), so only what changed costs tokens'),
    outline: z.boolean().optional().describe('Return only the notebook map (cell ids, kinds, first lines, hashes, execution state): the cheapest overview of the whole notebook'),
  },
  readCell: {
    documentId: documentId.optional(),
    cellId,
    includeOutputs: z.boolean().optional(),
    maxBytes: z.number().int().positive().optional(),
  },
  readOutput: {
    documentId: documentId.optional(),
    cellId,
    outputId: z.string().describe('Output ID from a cell read (cellId:index:hash)'),
    preferredMime: z.string().optional().describe('Preferred MIME type, e.g. image/png or text/html'),
    maxBytes: z.number().int().positive().optional(),
    imageDelivery: z
      .enum(['inline', 'file', 'both'])
      .optional()
      .describe('For images: return inline base64 image content, a secure temp file path, or both (default both)'),
  },
  readAttachment: {
    requestId: z.string().describe('The comment the image was attached to'),
    imageId: z.string().describe('imageId from the comment packet (attachments of kind "image" / message images)'),
    imageDelivery: z
      .enum(['inline', 'file', 'both'])
      .optional()
      .describe('Return inline image content, just the private file path, or both (default both)'),
  },
  replaceCellSource: {
    documentId: documentId.optional(),
    cellId,
    expectedVersion,
    expectedSourceHash,
    source: z.string().describe('Replacement source for the whole cell'),
    ...linking,
    ...executeAfter,
  },
  editCellText: {
    documentId: documentId.optional(),
    cellId,
    expectedSourceHash,
    edits: textEdits,
    ...linking,
    ...executeAfter,
  },
  insertCell: {
    documentId: documentId.optional(),
    anchorCellId: cellId.nullable().optional().describe('Anchor cell; omit/null to insert at the end (below) or start (above)'),
    position: z.enum(['above', 'below']),
    kind: z.enum(['python', 'markdown']),
    source: z.string(),
    expectedVersion,
    ...linking,
    ...executeAfter,
  },
  deleteCell: {
    documentId: documentId.optional(),
    cellId,
    expectedVersion,
    expectedSourceHash,
    ...linking,
  },
  moveCell: {
    documentId: documentId.optional(),
    cellId,
    anchorCellId: cellId,
    position: z.enum(['above', 'below']),
    expectedVersion,
    ...linking,
  },
  applyCellEdits: {
    documentId: documentId.optional(),
    expectedVersion,
    edits: z.array(CellEditOperation).min(1),
    ...linking,
    ...executeAfter,
  },
  executeCell: {
    documentId: documentId.optional(),
    cellId,
    timeoutMs: z.number().int().min(0).optional().describe('How long to wait for completion (default 45000 ms; keep it below your MCP client tool timeout; 0 = start and return immediately). On timeout the cell keeps running and the result says stillRunning: true; poll read_cell'),
    force: z.boolean().optional().describe('Run even if the cell has `#| eval: false`'),
    ...linking,
  },
  executeCells: {
    documentId: documentId.optional(),
    cellIds: z.array(cellId).min(1),
    stopOnError: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    ...linking,
  },
  executeScratch: {
    documentId: documentId.optional(),
    code: z.string().describe('Python code to run in the live kernel; it can mutate kernel state'),
    timeoutMs: z.number().int().positive().optional(),
    maxBytes: z.number().int().positive().optional(),
    ...linking,
  },
  listVariables: {
    documentId: documentId.optional(),
    maxCount: z.number().int().positive().optional(),
  },
  summarizeVariable: {
    documentId: documentId.optional(),
    name: z.string().describe('Variable name or dotted attribute path (e.g. df or model.coef_)'),
    maxRows: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
  },
  interruptKernel: { documentId: documentId.optional() },
  restartKernel: { documentId: documentId.optional() },
  assignNotebook: {
    documentId: documentId.optional(),
    notebook: z.string().optional().describe('Notebook to watch: file name (analysis.qmd), path suffix, or documentId; omit for the active notebook'),
    agentName: z.string().describe('How the notebook UI should label you, e.g. "Claude Code" or "Codex"'),
  },
  releaseNotebook: { documentId: documentId.optional() },
  waitForComments: {
    documentId: documentId.optional().describe('Notebook to watch (defaults to the notebook you assigned yourself to)'),
    timeoutMs: longPoll,
  },
  getRequest: { requestId: z.string() },
  listRequests: {
    status: z.enum(['pending', 'all']).optional().describe('pending = queued/delivered/working/needs-input (default)'),
  },
  updateRequest: {
    requestId: z.string(),
    status: z.enum(['delivered', 'working', 'needs-input', 'completed', 'failed']).optional(),
    message: z.string().optional().describe('Progress note or concise response shown in the request thread'),
  },
  resolveRequest: {
    requestId: z.string(),
    summary: z.string().optional(),
    linkedCellIds: z.array(cellId).optional(),
    status: z.enum(['completed', 'failed']).optional(),
  },
  waitForRequest: {
    timeoutMs: longPoll,
  },
  cancelWait: {},
} as const;

export type ShapeName = keyof typeof Shapes;

export function schemaFor<K extends ShapeName>(name: K) {
  return z.object(Shapes[name]);
}
