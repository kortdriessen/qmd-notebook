/**
 * Wire protocol between the QMD Notebook VS Code extension (bridge server) and the
 * companion `qmd-notebook-mcp` process (bridge client).
 *
 * Transport: newline-delimited JSON-RPC 2.0 over a Unix domain socket (Linux/macOS)
 * or a loopback TCP socket (fallback). The first message on a connection MUST be a
 * `hello` request carrying the session token from the discovery record.
 */

export const PROTOCOL_VERSION = 1;

/** Discovery record written by the extension into the user-private runtime directory. */
export interface DiscoveryRecord {
  protocolVersion: number;
  instanceId: string;
  pid: number;
  /** Unix socket path, or `tcp:<port>` for the loopback fallback. */
  socketPath: string;
  token: string;
  workspaceFolders: string[];
  remoteName: string | null;
  vscodeVersion: string;
  extensionVersion: string;
  startedAt: string;
}

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: RpcError;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export const RpcErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  Unauthorized: -32001,
  NotFound: -32002,
  Conflict: -32003,
  KernelUnavailable: -32004,
  Timeout: -32005,
  Untrusted: -32006,
  Cancelled: -32007,
  Unsupported: -32008,
} as const;

/** Names of bridge RPC methods. Each has a matching MCP tool (see schemas.ts). */
export const BridgeMethods = {
  hello: 'hello',
  status: 'status',
  listOpenNotebooks: 'listOpenNotebooks',
  getActiveContext: 'getActiveContext',
  readNotebook: 'readNotebook',
  readCell: 'readCell',
  readOutput: 'readOutput',
  readAttachment: 'readAttachment',
  replaceCellSource: 'replaceCellSource',
  editCellText: 'editCellText',
  insertCell: 'insertCell',
  deleteCell: 'deleteCell',
  moveCell: 'moveCell',
  applyCellEdits: 'applyCellEdits',
  executeCell: 'executeCell',
  executeCells: 'executeCells',
  executeScratch: 'executeScratch',
  listVariables: 'listVariables',
  summarizeVariable: 'summarizeVariable',
  interruptKernel: 'interruptKernel',
  restartKernel: 'restartKernel',
  assignNotebook: 'assignNotebook',
  releaseNotebook: 'releaseNotebook',
  waitForComments: 'waitForComments',
  getRequest: 'getRequest',
  listRequests: 'listRequests',
  updateRequest: 'updateRequest',
  resolveRequest: 'resolveRequest',
  waitForRequest: 'waitForRequest',
  cancelWait: 'cancelWait',
} as const;

export type BridgeMethod = (typeof BridgeMethods)[keyof typeof BridgeMethods];

// ---------------------------------------------------------------------------
// Shared data shapes returned by the bridge
// ---------------------------------------------------------------------------

export type CellKind = 'python' | 'markdown';

export interface OutputItemSummary {
  mime: string;
  bytes: number;
  /** Bounded text preview for textual mimes (text/plain, stderr, html, json, errors). */
  text?: string;
  truncated?: boolean;
}

export interface OutputSummary {
  /** `<cellId>:<index>:<hash8>` — stable while the output content is unchanged. */
  outputId: string;
  index: number;
  items: OutputItemSummary[];
}

export interface CellOptions {
  eval?: boolean;
  label?: string;
  [key: string]: unknown;
}

export interface CellInfo {
  cellId: string;
  index: number;
  kind: CellKind;
  language: string;
  source: string;
  sourceHash: string;
  sourceBytes: number;
  truncated?: boolean;
  /** Set by delta reads (read_notebook knownHashes): the source matched your hash and was omitted. */
  unchanged?: boolean;
  options?: CellOptions;
  executionOrder?: number | null;
  executionSuccess?: boolean | null;
  running?: boolean;
  outputs?: OutputSummary[];
  /** 1-based line span in the last-saved .qmd, when known. */
  sourceLines?: { start: number; end: number } | null;
}

export type KernelStatusName =
  | 'none'
  | 'not-started'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'restarting'
  | 'dead';

export interface KernelInfo {
  status: KernelStatusName;
  displayName: string | null;
  controllerId: string | null;
  pythonPath: string | null;
  sessionId: string | null;
  agentActivity: string | null;
}

export interface AssignmentInfo {
  agentName: string;
  clientId: number;
  since: string;
}

export interface NotebookInfo {
  documentId: string;
  uri: string;
  fsPath: string;
  displayName: string;
  version: number;
  isDirty: boolean;
  isActive: boolean;
  cellCount: number;
  kernel: KernelInfo;
  /** Agent currently watching this notebook for comments (assign_notebook), if any. */
  assignment: AssignmentInfo | null;
  pendingComments: number;
}

export interface ActiveContext {
  notebook: NotebookInfo | null;
  selectedCellIds: string[];
  activeCellId: string | null;
  selection: { cellId: string; text: string; range: RangeInfo } | null;
  focusedOutputId: string | null;
  pendingRequests: RequestSummary[];
  untrustedWorkspace: boolean;
}

export interface RangeInfo {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface ExecutionResult {
  cellId: string;
  executionOrder: number | null;
  success: boolean | null;
  timedOut: boolean;
  stillRunning?: boolean;
  hint?: string;
  durationMs: number;
  outputs: OutputSummary[];
  error?: { name: string; message: string; traceback?: string[] } | null;
}

export interface ScratchResult {
  success: boolean;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  results: OutputItemSummary[];
  displays: OutputItemSummary[];
  error?: { name: string; message: string; traceback?: string[] } | null;
  truncated: boolean;
}

export type RequestStatus =
  | 'draft'
  | 'queued'
  | 'delivered'
  | 'working'
  | 'needs-input'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** An image the user attached to a comment (pasted into the compose box or picked from disk). */
export interface ImageAttachmentInfo {
  imageId: string;
  name: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  /** Private 0600 file under the bridge runtime dir; agents may open it directly. */
  filePath: string;
}

export interface RequestAttachment {
  kind: 'selection' | 'cell' | 'output' | 'neighbor' | 'image';
  /** Empty for image attachments. */
  cellId: string;
  imageId?: string;
  name?: string;
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  filePath?: string;
  cellKind?: CellKind;
  sourceHash?: string;
  source?: string;
  text?: string;
  range?: RangeInfo;
  outputId?: string;
  outputMime?: string;
  outputText?: string;
  executionOrder?: number | null;
  imageAvailable?: boolean;
  /** The cell changed between the comment and its delivery; source/sourceHash were refreshed. */
  changedSinceComment?: boolean;
}

export interface RequestMessage {
  at: string;
  from: 'user' | 'agent' | 'system';
  text: string;
  status?: RequestStatus;
  /** Images sent with this message (thumbnail is a small data URL for the notebook UI; stripped for agents). */
  images?: Array<ImageAttachmentInfo & { thumbnail?: string }>;
}

/** Image bytes delivered inline with a packet; the MCP companion turns these into image content blocks. */
export interface InlineImage {
  imageId: string;
  name: string;
  mime: string;
  base64: string;
  /** Private file with the same bytes, for clients that cannot show MCP image content. */
  filePath: string;
}

export type RequestAnchor = 'selection' | 'cell' | 'output' | 'notebook';

export interface RequestSummary {
  requestId: string;
  createdAt: string;
  status: RequestStatus;
  prompt: string;
  documentId: string;
  uri: string;
  cellId: string | null;
  anchor: RequestAnchor;
  /** True when the user replied inside an existing thread (the packet's messages carry the conversation). */
  followUp: boolean;
  /** Text of the latest user message (the prompt for first requests, the reply for follow-ups). */
  latestUserMessage: string;
}

/** One line per cell: enough to navigate and to build edit preconditions without reading sources. */
export interface NotebookMapCell {
  cellId: string;
  index: number;
  kind: CellKind;
  /** First non-empty line of the cell (trimmed, bounded). */
  head: string;
  lines: number;
  sourceHash: string;
  label?: string;
  eval?: false;
  executionOrder?: number | null;
  executionSuccess?: boolean | null;
  running?: boolean;
  outputCount: number;
}

export interface NotebookMap {
  documentId: string;
  version: number;
  cellCount: number;
  cells: NotebookMapCell[];
  truncated: boolean;
}

export interface CommentBatch {
  notebook: NotebookInfo | null;
  /** Full packets (prompt, attachments with current source/sourceHash, thread so far). */
  comments: RequestPacket[];
  /** Compact map of the notebook at delivery time (only when comments were returned). */
  map?: NotebookMap;
  assigned: boolean;
  /** True when the notebook was closed or the assignment was released: stop the loop. */
  stopped: boolean;
  reason?: string;
}

export interface RequestPacket extends RequestSummary {
  /** Agent-facing copies only: images attached to the message being delivered. */
  inlineImages?: InlineImage[];
  /** Agent-facing copies only: attached images too large to inline (fetch with read_attachment). */
  inlineImagesOmitted?: string[];
  documentVersion: number;
  /** Notebook content version at delivery: use it as expectedVersion for your first edit. */
  version?: number;
  kernel: KernelInfo;
  attachments: RequestAttachment[];
  messages: RequestMessage[];
  linkedCellIds: string[];
  attachmentHashes: string[];
  deliveredTo?: string | null;
}

export interface BridgeStatus {
  protocolVersion: number;
  extensionVersion: string;
  vscodeVersion: string;
  remoteName: string | null;
  workspaceFolders: string[];
  workspaceTrusted: boolean;
  notebooks: NotebookInfo[];
  activeNotebookId: string | null;
  connectedClients: number;
  pendingRequests: number;
  assignments: Array<{ documentId: string; displayName: string; agentName: string; since: string }>;
}
