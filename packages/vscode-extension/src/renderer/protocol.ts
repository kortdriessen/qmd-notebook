/**
 * Data exchanged between the extension and the comment renderer (runs in the notebook webview).
 * Shared by both sides; keep it dependency-free.
 */
export const COMMENT_MIME = 'application/x-qmd-comment+json';
export const RENDERER_ID = 'qmd-notebook.comments';

export interface ImagePreview {
  imageId: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  /** Small data URL for display; absent for images picked from disk that were too large to preview. */
  thumbnail?: string;
}

export interface ThreadMessage {
  from: 'user' | 'agent' | 'system';
  text: string;
  at: string;
  status?: string;
  images?: ImagePreview[];
}

export interface ThreadOutput {
  kind: 'thread';
  requestId: string;
  cellId: string;
  status: string;
  /** 'selection' | 'cell' | 'output' | 'notebook' */
  anchor: string;
  /** Short quote of the selected text, or output label. */
  excerpt: string;
  agentName: string | null;
  watching: boolean;
  messages: ThreadMessage[];
  canReply: boolean;
  /** Images attached to the reply being composed (not sent yet). */
  pendingImages?: ImagePreview[];
}

export interface DraftOutput {
  kind: 'draft';
  draftId: string;
  cellId: string;
  anchor: string;
  excerpt: string;
  agentName: string | null;
  watching: boolean;
  images?: ImagePreview[];
}

export type CommentOutput = ThreadOutput | DraftOutput;

/** Which compose box an image belongs to: a draft, or the reply box of an existing thread. */
export type ComposeTarget = { draftId: string } | { requestId: string };

export interface PastedImage {
  name: string;
  mime: string;
  width: number;
  height: number;
  /** Raw image bytes, base64 (no data: prefix). */
  base64: string;
  /** Small data URL rendered by the renderer, made in the webview with a canvas. */
  thumbnail?: string;
}

export type RendererToExtension =
  | { type: 'submitDraft'; draftId: string; text: string }
  | { type: 'cancelDraft'; draftId: string }
  | { type: 'reply'; requestId: string; text: string }
  | { type: 'resolve'; requestId: string }
  | { type: 'reopen'; requestId: string }
  | { type: 'delete'; requestId: string }
  | { type: 'attachImage'; target: ComposeTarget; image: PastedImage }
  | { type: 'removeImage'; target: ComposeTarget; imageId: string }
  | { type: 'pickImage'; target: ComposeTarget }
  | { type: 'openImage'; requestId: string; imageId: string };

export type ExtensionToRenderer = { type: 'expand'; requestId: string };
