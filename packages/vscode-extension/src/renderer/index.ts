/**
 * Notebook renderer for QMD agent comment threads. Renders a compact thread card under the cell:
 * a compose box for drafts, the user/agent messages of a thread, and resolve/reopen/delete
 * actions. All actions are sent to the extension through renderer messaging.
 */
import type { ActivationFunction, RendererContext } from './api';
import type { CommentOutput, ComposeTarget, ExtensionToRenderer, ImagePreview, PastedImage, RendererToExtension, ThreadMessage } from './protocol';

const STYLE = `
.qmd-thread { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-editor-foreground);
  border: 1px solid var(--vscode-notebook-cellBorderColor, rgba(128,128,128,0.35)); border-left: 3px solid var(--vscode-charts-blue, #3794ff);
  border-radius: 4px; margin: 4px 0 2px 0; padding: 6px 10px 8px 10px; background: var(--vscode-notebook-outputContainerBackgroundColor, transparent); max-width: 900px; }
.qmd-thread.resolved { border-left-color: var(--vscode-charts-green, #89d185); opacity: 0.85; }
.qmd-thread.failed { border-left-color: var(--vscode-charts-red, #f14c4c); }
.qmd-thread.needs-input { border-left-color: var(--vscode-charts-yellow, #cca700); }
.qmd-thread.draft { border-left-color: var(--vscode-focusBorder, #3794ff); border-style: dashed; }
.qmd-hdr { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 0.92em; }
.qmd-hdr .qmd-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qmd-hdr .qmd-title b { color: var(--vscode-editor-foreground); font-weight: 600; }
.qmd-hdr button, .qmd-compose button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 2px 8px; cursor: pointer;
  background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); font-size: 0.9em; }
.qmd-hdr button:hover, .qmd-compose button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.qmd-compose button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
.qmd-compose button.primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.qmd-msgs { margin: 6px 0 2px 0; display: flex; flex-direction: column; gap: 6px; }
.qmd-msg { display: grid; grid-template-columns: 88px 1fr; gap: 8px; align-items: start; }
.qmd-msg .qmd-who { color: var(--vscode-descriptionForeground); font-size: 0.9em; padding-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qmd-msg.agent .qmd-who { color: var(--vscode-charts-blue, #3794ff); }
.qmd-msg .qmd-body { white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
.qmd-msg .qmd-body code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; background: rgba(128,128,128,0.18); padding: 0 3px; border-radius: 3px; }
.qmd-msg .qmd-body pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; background: rgba(128,128,128,0.14); padding: 6px 8px; border-radius: 3px; overflow-x: auto; margin: 4px 0; }
.qmd-compose { display: flex; gap: 6px; margin-top: 6px; align-items: flex-end; }
.qmd-compose textarea { flex: 1; min-height: 34px; max-height: 160px; resize: vertical; font-family: var(--vscode-font-family); font-size: inherit;
  background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 5px 7px; }
.qmd-compose textarea:focus { outline: 1px solid var(--vscode-focusBorder, #3794ff); }
.qmd-hint { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 3px; }
.qmd-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-blue, #3794ff); }
.qmd-thread.resolved .qmd-dot { background: var(--vscode-charts-green, #89d185); }
.qmd-thread.failed .qmd-dot { background: var(--vscode-charts-red, #f14c4c); }
.qmd-thread.needs-input .qmd-dot { background: var(--vscode-charts-yellow, #cca700); }
.qmd-thread.working .qmd-dot { animation: qmd-pulse 1.2s ease-in-out infinite; }
@keyframes qmd-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.qmd-images { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px 0; }
.qmd-images .qmd-img { position: relative; display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--vscode-notebook-cellBorderColor, rgba(128,128,128,0.35)); border-radius: 4px; padding: 2px; background: rgba(128,128,128,0.08); }
.qmd-images img { max-height: 96px; max-width: 200px; display: block; border-radius: 2px; cursor: zoom-in; }
.qmd-images .qmd-chip { font-size: 0.85em; color: var(--vscode-descriptionForeground); padding: 4px 6px; }
.qmd-images .qmd-x { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; line-height: 16px; border-radius: 50%; padding: 0; font-size: 11px; text-align: center; }
.qmd-compose textarea.qmd-drop { outline: 2px dashed var(--vscode-focusBorder, #3794ff); }
.qmd-compose .qmd-attach { padding: 2px 6px; }
`;

/** Compose-box text and focus survive re-renders (attaching an image re-syncs the output). */
const composeState = new Map<string, { text: string; focused: boolean }>();

function targetKey(target: ComposeTarget): string {
  return 'draftId' in target ? `draft:${target.draftId}` : `req:${target.requestId}`;
}

const THUMB_MAX = 160;

/** Read an image file from the clipboard/picker, measure it and make a small thumbnail. */
function loadPastedImage(file: File): Promise<PastedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const img = new Image();
      img.onerror = () => reject(new Error('not a decodable image'));
      img.onload = () => {
        let thumbnail: string | undefined;
        try {
          const scale = Math.min(1, THUMB_MAX / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
          thumbnail = canvas.toDataURL('image/png');
        } catch {
          thumbnail = undefined;
        }
        resolve({ name: file.name || `pasted-${Date.now()}.${(file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`, mime: file.type, width: img.naturalWidth, height: img.naturalHeight, base64, thumbnail });
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  if (!out.length) for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith('image/')) out.push(f);
  return out;
}

const expanded = new Set<string>();

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Tiny, safe markdown subset: fenced code, inline code, bold, line breaks. */
function renderMarkdown(text: string): string {
  const parts = text.split(/```/);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i] ?? '';
    if (i % 2 === 1) {
      const body = chunk.replace(/^[a-zA-Z0-9_+-]*\n/, '');
      html += `<pre>${escapeHtml(body.replace(/\n$/, ''))}</pre>`;
    } else {
      html += escapeHtml(chunk)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/\n/g, '<br>');
    }
  }
  return html;
}

function statusText(status: string, agent: string | null, watching: boolean): string {
  const who = agent ?? 'agent';
  switch (status) {
    case 'queued':
      return watching ? `queued for ${who}` : 'queued · no agent watching';
    case 'delivered':
      return `delivered to ${who}`;
    case 'working':
      return `${who} working…`;
    case 'needs-input':
      return `${who} needs your input`;
    case 'completed':
      return 'resolved';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'closed';
    default:
      return status;
  }
}

function anchorText(anchor: string, excerpt: string): string {
  if (anchor === 'output') return `output${excerpt ? ` ${excerpt}` : ''}`;
  if (anchor === 'selection') return `selection${excerpt ? ` <b>“${escapeHtml(excerpt)}”</b>` : ''}`;
  return anchor;
}

export const activate: ActivationFunction = (context: RendererContext) => {
  const post = (message: RendererToExtension): void => {
    context.postMessage?.(message);
  };
  const styleId = 'qmd-comment-style';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  context.onDidReceiveMessage?.((raw) => {
    const msg = raw as ExtensionToRenderer;
    if (msg?.type === 'expand') {
      expanded.add(msg.requestId);
      const el = document.querySelector<HTMLElement>(`[data-request-id="${msg.requestId}"]`);
      if (el) el.dispatchEvent(new CustomEvent('qmd-rerender'));
    }
  });

  /** Thumbnails (with an optional remove button) for images attached to a message or a compose box. */
  function imageRow(images: ImagePreview[] | undefined, onRemove?: (imageId: string) => void, onOpen?: (imageId: string) => void): HTMLElement | null {
    if (!images || images.length === 0) return null;
    const row = document.createElement('div');
    row.className = 'qmd-images';
    for (const im of images) {
      const wrap = document.createElement('span');
      wrap.className = 'qmd-img';
      wrap.title = `${im.name} · ${im.width}×${im.height} · ${Math.round(im.bytes / 1024)} KB`;
      if (im.thumbnail) {
        const img = document.createElement('img');
        img.src = im.thumbnail;
        img.alt = im.name;
        if (onOpen) img.addEventListener('click', () => onOpen(im.imageId));
        wrap.appendChild(img);
      } else {
        const chip = document.createElement('span');
        chip.className = 'qmd-chip';
        chip.textContent = `🖼 ${im.name}`;
        if (onOpen) chip.addEventListener('click', () => onOpen(im.imageId));
        wrap.appendChild(chip);
      }
      if (onRemove) {
        const x = document.createElement('button');
        x.className = 'qmd-x';
        x.textContent = '✕';
        x.title = 'Remove this image';
        x.addEventListener('click', () => onRemove(im.imageId));
        wrap.appendChild(x);
      }
      row.appendChild(wrap);
    }
    return row;
  }

  function compose(el: HTMLElement, target: ComposeTarget, images: ImagePreview[] | undefined, placeholder: string, onSend: (text: string) => void, onCancel?: () => void, autofocus = false): void {
    const key = targetKey(target);
    const state = composeState.get(key) ?? { text: '', focused: false };
    composeState.set(key, state);
    const pending = imageRow(images, (imageId) => post({ type: 'removeImage', target, imageId }));
    if (pending) el.appendChild(pending);
    const box = document.createElement('div');
    box.className = 'qmd-compose';
    const ta = document.createElement('textarea');
    ta.placeholder = placeholder;
    ta.rows = 1;
    ta.value = state.text;
    const send = document.createElement('button');
    send.className = 'primary';
    send.textContent = 'Send';
    send.title = 'Send to the watching agent (Ctrl+Enter)';
    const doSend = () => {
      const text = ta.value.trim();
      if (!text && !(images && images.length)) return;
      send.disabled = true;
      composeState.delete(key);
      onSend(text || (images && images.length ? '(see attached image)' : ''));
    };
    send.addEventListener('click', doSend);
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        doSend();
      } else if (e.key === 'Escape' && onCancel) {
        e.preventDefault();
        composeState.delete(key);
        onCancel();
      }
      e.stopPropagation();
    });
    const grow = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(160, ta.scrollHeight)}px`;
    };
    ta.addEventListener('input', () => {
      state.text = ta.value;
      grow();
    });
    ta.addEventListener('focus', () => (state.focused = true));
    ta.addEventListener('blur', () => (state.focused = false));
    // Images from the clipboard (Ctrl+V) or dropped onto the box go to the extension, which stores
    // them privately and re-syncs this output with a thumbnail; text pastes are left to the browser.
    const attach = async (files: File[]) => {
      for (const f of files) {
        try {
          const image = await loadPastedImage(f);
          post({ type: 'attachImage', target, image });
        } catch (err) {
          hint.textContent = `Could not read image: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    };
    ta.addEventListener('paste', (e) => {
      const files = imageFilesFrom(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      hint.textContent = 'Attaching image…';
      void attach(files);
    });
    ta.addEventListener('dragover', (e) => {
      if (imageFilesFrom(e.dataTransfer).length || Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
        e.preventDefault();
        ta.classList.add('qmd-drop');
      }
    });
    ta.addEventListener('dragleave', () => ta.classList.remove('qmd-drop'));
    ta.addEventListener('drop', (e) => {
      ta.classList.remove('qmd-drop');
      const files = imageFilesFrom(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      void attach(files);
    });
    box.appendChild(ta);
    const pick = document.createElement('button');
    pick.className = 'qmd-attach';
    pick.textContent = '🖼';
    pick.title = 'Attach an image file (or paste one with Ctrl+V)';
    pick.addEventListener('click', () => post({ type: 'pickImage', target }));
    box.appendChild(pick);
    box.appendChild(send);
    if (onCancel) {
      const cancel = document.createElement('button');
      cancel.textContent = 'Discard';
      cancel.addEventListener('click', () => {
        composeState.delete(key);
        onCancel();
      });
      box.appendChild(cancel);
    }
    el.appendChild(box);
    const hint = document.createElement('div');
    hint.className = 'qmd-hint';
    hint.textContent = 'Ctrl+Enter to send · paste an image with Ctrl+V';
    el.appendChild(hint);
    if (autofocus || state.focused) {
      setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        grow();
      }, 30);
    } else if (state.text) setTimeout(grow, 0);
  }

  function renderDraft(data: Extract<CommentOutput, { kind: 'draft' }>, element: HTMLElement): void {
    element.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'qmd-thread draft';
    const hdr = document.createElement('div');
    hdr.className = 'qmd-hdr';
    hdr.innerHTML = `<span class="qmd-dot"></span><span class="qmd-title">Comment for the agent · ${anchorText(data.anchor, data.excerpt)}${data.watching ? ` · <b>${escapeHtml(data.agentName ?? 'agent')}</b> is watching` : ' · no agent watching yet'}</span>`;
    card.appendChild(hdr);
    compose(card, { draftId: data.draftId }, data.images, data.anchor === 'output' ? 'What about this output?' : data.anchor === 'selection' ? 'What about this selection?' : 'What should the agent do with this cell?', (text) => post({ type: 'submitDraft', draftId: data.draftId, text }), () => post({ type: 'cancelDraft', draftId: data.draftId }), true);
    element.appendChild(card);
  }

  function renderThread(data: Extract<CommentOutput, { kind: 'thread' }>, element: HTMLElement): void {
    element.innerHTML = '';
    const done = ['completed', 'failed', 'cancelled'].includes(data.status);
    const card = document.createElement('div');
    card.className = `qmd-thread ${data.status === 'completed' ? 'resolved' : data.status}`;
    card.dataset.requestId = data.requestId;
    const isExpanded = !done || expanded.has(data.requestId);
    const hdr = document.createElement('div');
    hdr.className = 'qmd-hdr';
    hdr.innerHTML = `<span class="qmd-dot"></span><span class="qmd-title">Agent comment · ${anchorText(data.anchor, data.excerpt)} · <b>${escapeHtml(statusText(data.status, data.agentName, data.watching))}</b></span>`;
    const actions = document.createElement('span');
    if (done) {
      const toggle = document.createElement('button');
      toggle.textContent = isExpanded ? 'Collapse' : `Show (${data.messages.filter((m) => m.from !== 'system').length})`;
      toggle.addEventListener('click', () => {
        if (expanded.has(data.requestId)) expanded.delete(data.requestId);
        else expanded.add(data.requestId);
        renderThread(data, element);
      });
      actions.appendChild(toggle);
      const reopen = document.createElement('button');
      reopen.textContent = 'Ask again';
      reopen.title = 'Reopen this comment for the agent';
      reopen.addEventListener('click', () => post({ type: 'reopen', requestId: data.requestId }));
      actions.appendChild(reopen);
    } else {
      const resolve = document.createElement('button');
      resolve.textContent = 'Close';
      resolve.title = 'Close this comment without waiting for the agent';
      resolve.addEventListener('click', () => post({ type: 'resolve', requestId: data.requestId }));
      actions.appendChild(resolve);
    }
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Delete this comment thread';
    del.addEventListener('click', () => post({ type: 'delete', requestId: data.requestId }));
    actions.appendChild(del);
    hdr.appendChild(actions);
    card.appendChild(hdr);
    if (isExpanded) {
      const msgs = document.createElement('div');
      msgs.className = 'qmd-msgs';
      for (const m of data.messages as ThreadMessage[]) {
        if (m.from === 'system') continue;
        const row = document.createElement('div');
        row.className = `qmd-msg ${m.from}`;
        const who = document.createElement('div');
        who.className = 'qmd-who';
        who.textContent = m.from === 'agent' ? (data.agentName ?? 'agent') : 'You';
        who.title = new Date(m.at).toLocaleString();
        const body = document.createElement('div');
        body.className = 'qmd-body';
        body.innerHTML = m.from === 'agent' ? renderMarkdown(m.text) : escapeHtml(m.text).replace(/\n/g, '<br>');
        const imgs = imageRow(m.images, undefined, (imageId) => post({ type: 'openImage', requestId: data.requestId, imageId }));
        if (imgs) body.appendChild(imgs);
        row.appendChild(who);
        row.appendChild(body);
        msgs.appendChild(row);
      }
      card.appendChild(msgs);
      if (data.canReply && !done) {
        compose(card, { requestId: data.requestId }, data.pendingImages, data.status === 'needs-input' ? 'Answer the agent…' : 'Reply or add a follow-up…', (text) => post({ type: 'reply', requestId: data.requestId, text }));
      } else if (data.canReply && done) {
        compose(card, { requestId: data.requestId }, data.pendingImages, 'Follow up (reopens the comment)…', (text) => post({ type: 'reply', requestId: data.requestId, text }));
      }
    }
    element.appendChild(card);
    element.addEventListener('qmd-rerender', () => renderThread(data, element), { once: true });
  }

  return {
    renderOutputItem(outputItem, element) {
      let data: CommentOutput;
      try {
        data = outputItem.json() as CommentOutput;
      } catch {
        element.textContent = outputItem.text();
        return;
      }
      if (data.kind === 'draft') renderDraft(data, element);
      else renderThread(data, element);
    },
    disposeOutputItem() {
      /* nothing to clean up */
    },
  };
};
