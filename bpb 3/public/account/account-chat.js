/* ═══════════════════════════════════════════════════════════════════════════
   account-chat.js — Sprint 10e

   Homeowner chat module loaded by /account/index.html. Mounts an inline
   chat panel that lets the homeowner read and send messages with their
   assigned Bayside designer.

   Sprint 10e additions (on top of 10d):
     - Composer file picker (📎) + chips queue
     - Pre-generated message UUID via crypto.randomUUID() so files land
       in {client_id}/{messageUuid}/{N}_filename BEFORE the message row
     - Upload → insert message → insert attachments
     - Attachment rendering: 120px image thumbnails (click → fullscreen)
       and PDF rows with download links
     - Signed URL caching (1 hour TTL)
     - Realtime: 250ms delay then fetch attachments for new message_id

   Per-client threading (Sprint 10a): one thread per client. Reads/writes
   client_messages and client_message_attachments via Supabase RLS.

   Staff senders are shown as "Bayside Pavers" — no need to expose
   individual designer names from a homeowner-scoped session.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL  = 'https://gfgbypcnxkschnfsitfb.supabase.co';
const SUPABASE_ANON = 'sb_publishable_Ko4LNw2VjhZVFmwJ-i2qtA_XeGgBcew';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// Sprint 10e attachment constants
const ATTACHMENT_BUCKET = 'client-messages';
const MAX_FILE_SIZE = 26214400; // 25 MB
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const SIGNED_URL_TTL = 3600;
const REALTIME_ATTACHMENT_DELAY = 250;

let _client = null;
let _userId = null;
let _messages = [];
let _channel = null;
let _attachmentsByMessageId = new Map();
let _signedUrlCache = new Map();
let _queuedFiles = [];

// ─── Bootstrap ─────────────────────────────────────────────────────────────
(async function init() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
    return;
  }

  const mount = document.getElementById('ho-chat-section');
  if (!mount) return;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;
  _userId = session.user.id;

  const { data: client, error } = await supabase
    .from('clients')
    .select('id, name, email')
    .eq('user_id', _userId)
    .maybeSingle();

  if (error || !client) return;
  _client = client;

  injectStyles();
  renderShell(mount);
  await loadMessages();
  hydrateSignedUrls(document.getElementById('hochat-messages'));
  subscribeRealtime();
})();

// ─── Load messages + attachments ───────────────────────────────────────────
async function loadMessages() {
  const { data, error } = await supabase
    .from('client_messages')
    .select('id, sender_user_id, sender_role, body, created_at')
    .eq('client_id', _client.id)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[account-chat] load failed:', error);
    showInlineError('Could not load messages: ' + error.message);
    return;
  }
  _messages = data || [];

  await loadAttachments(_messages.map(m => m.id));
  renderMessages();
}

async function loadAttachments(messageIds) {
  _attachmentsByMessageId = new Map();
  if (!messageIds || messageIds.length === 0) return;
  const { data, error } = await supabase
    .from('client_message_attachments')
    .select('id, message_id, storage_path, file_name, mime_type, size_bytes')
    .in('message_id', messageIds);
  if (error) {
    console.error('[account-chat] attachments load failed:', error);
    return;
  }
  for (const att of (data || [])) {
    if (!_attachmentsByMessageId.has(att.message_id)) {
      _attachmentsByMessageId.set(att.message_id, []);
    }
    _attachmentsByMessageId.get(att.message_id).push(att);
  }
}

// ─── Render ────────────────────────────────────────────────────────────────
function renderShell(mount) {
  mount.innerHTML = `
    <div class="ho-section-head">
      <h2>Messages</h2>
      <span class="ho-section-meta" id="hochat-status"></span>
    </div>
    <p class="ho-section-sub">
      Direct line to your designer at Bayside Pavers. Questions, requests,
      or photos — send them here. We aim to respond within one business day.
    </p>
    <div class="hochat-card">
      <div class="hochat-messages" id="hochat-messages">
        <div class="hochat-loading">Loading messages…</div>
      </div>
      <div class="hochat-file-queue" id="hochat-file-queue" style="display:none;"></div>
      <div class="hochat-composer">
        <button type="button" class="hochat-attach-btn" id="hochat-attach"
          title="Attach images or PDFs (25 MB max)">📎</button>
        <input type="file" id="hochat-file-input" multiple
          accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
          style="display:none;">
        <textarea id="hochat-input" rows="2"
          placeholder="Send a message — Enter to send, Shift+Enter for new line"></textarea>
        <button type="button" id="hochat-send">Send</button>
      </div>
    </div>
  `;

  document.getElementById('hochat-send').addEventListener('click', handleSend);
  document.getElementById('hochat-attach').addEventListener('click', () => {
    document.getElementById('hochat-file-input').click();
  });
  document.getElementById('hochat-file-input').addEventListener('change', handleFileSelect);

  const input = document.getElementById('hochat-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
}

function renderMessages() {
  const messagesEl = document.getElementById('hochat-messages');
  const statusEl = document.getElementById('hochat-status');
  if (!messagesEl) return;

  if (_messages.length === 0) {
    messagesEl.innerHTML = `
      <div class="hochat-empty">
        <div class="hochat-empty-icon">💬</div>
        <div class="hochat-empty-title">No messages yet</div>
        <div class="hochat-empty-sub">Send the first message to start a conversation with your designer.</div>
      </div>
    `;
    if (statusEl) statusEl.textContent = '';
    return;
  }

  messagesEl.innerHTML = _messages.map(renderOne).join('');
  scrollToBottom();

  if (statusEl) {
    const last = _messages[_messages.length - 1];
    statusEl.textContent = `Last activity ${formatRelative(last.created_at)}`;
  }
}

function renderOne(message) {
  const isOutbound = message.sender_user_id === _userId;
  const senderName = isOutbound ? 'You' : 'Bayside Pavers';
  const time = formatTime(message.created_at);
  const bodyHtml = message.body ? escapeHtml(message.body).replace(/\n/g, '<br>') : '';

  const atts = _attachmentsByMessageId.get(message.id) || [];
  const attsHtml = atts.length > 0 ? renderAttachments(atts) : '';

  return `
    <div class="hochat-msg ${isOutbound ? 'hochat-msg-out' : 'hochat-msg-in'}" data-message-id="${escapeAttr(message.id)}">
      <div class="hochat-msg-meta">
        <span class="hochat-msg-sender">${escapeHtml(senderName)}</span>
        <span class="hochat-msg-time">${escapeHtml(time)}</span>
      </div>
      ${bodyHtml ? `<div class="hochat-msg-body">${bodyHtml}</div>` : ''}
      ${attsHtml}
    </div>
  `;
}

function renderAttachments(attachments) {
  const html = attachments.map(att => {
    if (att.mime_type.startsWith('image/')) {
      return `
        <div class="hochat-msg-attachment-img"
             data-storage-path="${escapeAttr(att.storage_path)}"
             data-file-name="${escapeAttr(att.file_name)}">
          <div class="hochat-msg-attachment-loading">Loading…</div>
        </div>
      `;
    }
    return `
      <div class="hochat-msg-attachment-pdf"
           data-storage-path="${escapeAttr(att.storage_path)}"
           data-file-name="${escapeAttr(att.file_name)}">
        <span class="hochat-msg-attachment-pdf-icon">📄</span>
        <div class="hochat-msg-attachment-pdf-info">
          <div class="hochat-msg-attachment-pdf-name">${escapeHtml(att.file_name)}</div>
          <div class="hochat-msg-attachment-pdf-meta">${escapeHtml(formatFileSize(att.size_bytes))} · PDF</div>
        </div>
        <a class="hochat-msg-attachment-pdf-download" target="_blank" rel="noopener" download="${escapeAttr(att.file_name)}">Open</a>
      </div>
    `;
  }).join('');
  return `<div class="hochat-msg-attachments">${html}</div>`;
}

// ─── File picker + queue ───────────────────────────────────────────────────
function handleFileSelect(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  for (const file of files) {
    let error = null;
    if (file.size > MAX_FILE_SIZE) {
      error = `File too large (${formatFileSize(file.size)}). Max 25 MB.`;
    } else if (!ALLOWED_MIMES.includes(file.type)) {
      error = `Unsupported type. Use JPG, PNG, GIF, WebP, or PDF.`;
    }
    _queuedFiles.push({
      id: crypto.randomUUID(),
      file,
      error,
    });
  }
  renderFileQueue();
}

function renderFileQueue() {
  const queueEl = document.getElementById('hochat-file-queue');
  if (!queueEl) return;

  if (_queuedFiles.length === 0) {
    queueEl.innerHTML = '';
    queueEl.style.display = 'none';
    return;
  }

  queueEl.style.display = 'flex';
  queueEl.innerHTML = _queuedFiles.map(item => {
    const isImage = item.file.type.startsWith('image/');
    const sizeStr = formatFileSize(item.file.size);
    const errorHtml = item.error ? `<div class="hochat-file-chip-error">${escapeHtml(item.error)}</div>` : '';
    return `
      <div class="hochat-file-chip ${item.error ? 'has-error' : ''}" data-chip-id="${escapeAttr(item.id)}">
        <span class="hochat-file-chip-icon">${isImage ? '🖼' : '📄'}</span>
        <div class="hochat-file-chip-info">
          <span class="hochat-file-chip-name">${escapeHtml(item.file.name)}</span>
          <span class="hochat-file-chip-meta">${escapeHtml(sizeStr)}</span>
          ${errorHtml}
        </div>
        <button type="button" class="hochat-file-chip-remove" aria-label="Remove">×</button>
      </div>
    `;
  }).join('');

  queueEl.querySelectorAll('.hochat-file-chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const chipId = e.currentTarget.closest('.hochat-file-chip').dataset.chipId;
      _queuedFiles = _queuedFiles.filter(f => f.id !== chipId);
      renderFileQueue();
    });
  });
}

function sanitizeFilename(name) {
  return (name || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

// ─── Send ──────────────────────────────────────────────────────────────────
async function handleSend() {
  const input = document.getElementById('hochat-input');
  const sendBtn = document.getElementById('hochat-send');
  const body = input.value.trim();

  const validFiles = _queuedFiles.filter(f => !f.error);
  const hasInvalidQueued = _queuedFiles.some(f => f.error);

  if (hasInvalidQueued) {
    alert('Please remove the invalid file(s) from the queue before sending.');
    return;
  }
  if (!body && validFiles.length === 0) return;

  sendBtn.disabled = true;
  const messageUuid = crypto.randomUUID();

  // Step 1: upload files
  const uploaded = [];
  if (validFiles.length > 0) {
    for (let i = 0; i < validFiles.length; i++) {
      const item = validFiles[i];
      sendBtn.textContent = `Uploading ${i + 1}/${validFiles.length}…`;
      const sanitized = sanitizeFilename(item.file.name);
      const path = `${_client.id}/${messageUuid}/${i}_${sanitized}`;
      const { error: upErr } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .upload(path, item.file, {
          contentType: item.file.type,
          upsert: false,
        });
      if (upErr) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        showInlineError(`Upload failed for "${item.file.name}": ${upErr.message}`);
        return;
      }
      uploaded.push({
        storage_path: path,
        file_name: item.file.name,
        mime_type: item.file.type,
        size_bytes: item.file.size,
      });
    }
  }

  // Step 2: insert message with explicit UUID
  sendBtn.textContent = 'Sending…';
  const { error: msgErr } = await supabase
    .from('client_messages')
    .insert({
      id: messageUuid,
      client_id: _client.id,
      sender_user_id: _userId,
      sender_role: 'homeowner',
      body: body || null,
    });

  if (msgErr) {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    showInlineError('Could not send: ' + msgErr.message);
    return;
  }

  // Step 3: bulk insert attachments
  if (uploaded.length > 0) {
    const rows = uploaded.map(u => ({
      message_id: messageUuid,
      storage_path: u.storage_path,
      file_name: u.file_name,
      mime_type: u.mime_type,
      size_bytes: u.size_bytes,
    }));
    const { error: attErr } = await supabase
      .from('client_message_attachments')
      .insert(rows);
    if (attErr) {
      console.error('[account-chat] attachment row insert failed:', attErr);
      showInlineError(`Message sent but attachments failed to register: ${attErr.message}`);
    }
  }

  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';
  input.value = '';
  _queuedFiles = [];
  renderFileQueue();
  input.focus();
}

// ─── Realtime ──────────────────────────────────────────────────────────────
function subscribeRealtime() {
  if (_channel) supabase.removeChannel(_channel);
  _channel = supabase
    .channel(`account_chat_${_client.id}_${Date.now()}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'client_messages',
      filter: `client_id=eq.${_client.id}`,
    }, async (payload) => {
      const message = payload.new;
      if (_messages.some(m => m.id === message.id)) return;
      _messages.push(message);
      appendMessage(message);

      // Sprint 10e: 250ms delay, then fetch attachments for this message
      setTimeout(async () => {
        const { data: atts } = await supabase
          .from('client_message_attachments')
          .select('id, message_id, storage_path, file_name, mime_type, size_bytes')
          .eq('message_id', message.id);
        if (atts && atts.length > 0) {
          _attachmentsByMessageId.set(message.id, atts);
          const node = document.querySelector(`.hochat-msg[data-message-id="${CSS.escape(message.id)}"]`);
          if (node) {
            const wasNearBottom = isScrolledNearBottom();
            node.outerHTML = renderOne(message);
            const newNode = document.querySelector(`.hochat-msg[data-message-id="${CSS.escape(message.id)}"]`);
            if (newNode) hydrateSignedUrls(newNode);
            if (wasNearBottom) scrollToBottom();
          }
        }
      }, REALTIME_ATTACHMENT_DELAY);
    })
    .subscribe();
}

function appendMessage(message) {
  const messagesEl = document.getElementById('hochat-messages');
  if (!messagesEl) return;
  if (messagesEl.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
  const empty = messagesEl.querySelector('.hochat-empty');
  if (empty) empty.remove();
  const wasNearBottom = isScrolledNearBottom();
  messagesEl.insertAdjacentHTML('beforeend', renderOne(message));
  if (wasNearBottom) scrollToBottom();

  const statusEl = document.getElementById('hochat-status');
  if (statusEl) statusEl.textContent = `Last activity ${formatRelative(message.created_at)}`;
}

// ─── Signed URL hydration + image viewer ──────────────────────────────────
async function hydrateSignedUrls(scope) {
  if (!scope) return;
  const placeholders = scope.querySelectorAll('[data-storage-path]:not([data-hydrated])');
  for (const el of placeholders) {
    const path = el.dataset.storagePath;
    const fileName = el.dataset.fileName || '';
    const url = await getCachedSignedUrl(path);
    if (!url) {
      el.dataset.hydrated = 'error';
      const loading = el.querySelector('.hochat-msg-attachment-loading');
      if (loading) loading.textContent = 'Could not load file';
      continue;
    }

    if (el.classList.contains('hochat-msg-attachment-img')) {
      el.innerHTML = `<img src="${escapeAttr(url)}" alt="${escapeAttr(fileName)}" loading="lazy">`;
      el.style.cursor = 'zoom-in';
      el.addEventListener('click', () => openImageViewer(url, fileName));
    } else if (el.classList.contains('hochat-msg-attachment-pdf')) {
      const link = el.querySelector('.hochat-msg-attachment-pdf-download');
      if (link) link.href = url;
    }
    el.dataset.hydrated = 'true';
  }
}

async function getCachedSignedUrl(path) {
  const cached = _signedUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.url;

  const { data, error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);

  if (error || !data?.signedUrl) {
    console.error('[account-chat] signed URL failed for', path, error);
    return null;
  }

  _signedUrlCache.set(path, {
    url: data.signedUrl,
    expiresAt: Date.now() + (SIGNED_URL_TTL * 1000),
  });
  return data.signedUrl;
}

function openImageViewer(url, fileName) {
  const overlay = document.createElement('div');
  overlay.className = 'hochat-image-viewer';
  overlay.innerHTML = `
    <img src="${escapeAttr(url)}" alt="${escapeAttr(fileName)}">
    <button type="button" class="hochat-image-viewer-close" aria-label="Close">×</button>
  `;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onEsc);
  };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('hochat-image-viewer-close')) close();
  });
  document.addEventListener('keydown', onEsc);
  document.body.appendChild(overlay);
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function isScrolledNearBottom() {
  const m = document.getElementById('hochat-messages');
  if (!m) return true;
  return (m.scrollHeight - m.scrollTop - m.clientHeight) < 80;
}
function scrollToBottom() {
  const m = document.getElementById('hochat-messages');
  if (m) m.scrollTop = m.scrollHeight;
}

function showInlineError(msg) {
  const messagesEl = document.getElementById('hochat-messages');
  if (!messagesEl) return;
  const errEl = document.createElement('div');
  errEl.className = 'hochat-error';
  errEl.textContent = msg;
  messagesEl.appendChild(errEl);
  scrollToBottom();
  setTimeout(() => errEl.remove(), 8000);
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  if (d > sevenDaysAgo) {
    return d.toLocaleDateString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatRelative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

function formatFileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

// ─── Styles ────────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('hochat-styles')) return;
  const style = document.createElement('style');
  style.id = 'hochat-styles';
  style.textContent = `
    /* Inherits CSS variables from :root in /account/index.html (--bp-*) */
    .hochat-card {
      background: #fff;
      border: 1px solid var(--bp-border);
      border-radius: 12px;
      overflow: hidden;
      display: flex; flex-direction: column;
    }
    .hochat-messages {
      max-height: 460px; min-height: 220px;
      overflow-y: auto;
      padding: 22px 24px;
      background: var(--bp-bg);
      display: flex; flex-direction: column; gap: 12px;
    }
    .hochat-loading {
      color: var(--bp-muted); font-size: 13px;
      text-align: center; padding: 40px 0;
    }
    .hochat-empty {
      text-align: center; padding: 40px 20px;
      color: var(--bp-muted);
    }
    .hochat-empty-icon { font-size: 32px; margin-bottom: 10px; opacity: 0.5; }
    .hochat-empty-title {
      font-size: 14px; font-weight: 600;
      color: var(--bp-text); margin-bottom: 4px;
    }
    .hochat-empty-sub {
      font-size: 13px; line-height: 1.5;
      max-width: 340px; margin: 0 auto;
    }
    .hochat-error {
      background: #fef2f2; color: var(--bp-err);
      border: 1px solid #fecaca;
      border-radius: 8px; padding: 10px 14px;
      font-size: 13px; line-height: 1.5;
    }
    .hochat-msg {
      display: flex; flex-direction: column;
      gap: 4px; max-width: 85%;
    }
    .hochat-msg-in { align-self: flex-start; }
    .hochat-msg-out { align-self: flex-end; align-items: flex-end; }
    .hochat-msg-meta {
      font-size: 11px; color: var(--bp-muted);
      display: flex; gap: 8px; align-items: center;
    }
    .hochat-msg-sender { font-weight: 600; color: var(--bp-charcoal); }
    .hochat-msg-time { color: #aaa; }
    .hochat-msg-body {
      padding: 10px 14px; border-radius: 12px;
      font-size: 14px; line-height: 1.5;
      white-space: pre-wrap; word-wrap: break-word;
    }
    .hochat-msg-in .hochat-msg-body {
      background: #fff; color: var(--bp-text);
      border: 1px solid var(--bp-border);
      border-bottom-left-radius: 4px;
    }
    .hochat-msg-out .hochat-msg-body {
      background: var(--bp-green); color: #fff;
      border-bottom-right-radius: 4px;
    }

    /* Composer + attach button */
    .hochat-composer {
      background: #fff;
      border-top: 1px solid var(--bp-border);
      padding: 14px 18px 16px;
      display: flex; gap: 10px; align-items: flex-end;
    }
    .hochat-attach-btn {
      flex-shrink: 0;
      width: 40px; height: 40px;
      background: transparent;
      border: 1px solid var(--bp-border);
      border-radius: 8px;
      cursor: pointer;
      font-size: 18px;
      color: var(--bp-charcoal);
      transition: background .12s, border-color .12s, color .12s;
      display: flex; align-items: center; justify-content: center;
      align-self: flex-end;
      font-family: inherit;
    }
    .hochat-attach-btn:hover {
      background: var(--bp-cream);
      border-color: var(--bp-green);
      color: var(--bp-green-dk);
    }
    .hochat-composer textarea {
      flex: 1; font-family: inherit; font-size: 14px;
      padding: 10px 12px;
      border: 1px solid var(--bp-border);
      border-radius: 8px;
      background: #fff; color: var(--bp-text);
      resize: none; min-height: 44px; max-height: 120px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .hochat-composer textarea:focus {
      outline: none; border-color: var(--bp-green);
      box-shadow: 0 0 0 3px rgba(93, 126, 105, 0.16);
    }
    .hochat-composer button#hochat-send {
      background: var(--bp-green); color: #fff;
      border: 0; padding: 10px 18px;
      border-radius: 8px;
      font: inherit; font-size: 14px; font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .hochat-composer button#hochat-send:hover:not(:disabled) {
      background: var(--bp-green-dk);
    }
    .hochat-composer button#hochat-send:disabled {
      opacity: 0.5; cursor: not-allowed;
    }

    /* Queue chips */
    .hochat-file-queue {
      background: #fff;
      border-top: 1px solid var(--bp-border);
      padding: 10px 18px;
      display: flex; flex-wrap: wrap; gap: 8px;
    }
    .hochat-file-chip {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 8px 10px;
      background: var(--bp-cream);
      border: 1px solid var(--bp-border);
      border-radius: 8px;
      max-width: 320px;
      font-size: 12px;
    }
    .hochat-file-chip.has-error {
      background: #fef2f2;
      border-color: #fecaca;
    }
    .hochat-file-chip-icon {
      font-size: 16px; flex-shrink: 0;
      margin-top: 1px;
    }
    .hochat-file-chip-info {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column; gap: 2px;
    }
    .hochat-file-chip-name {
      font-weight: 600;
      color: var(--bp-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hochat-file-chip-meta {
      font-size: 11px;
      color: var(--bp-muted);
    }
    .hochat-file-chip-error {
      font-size: 11px;
      color: var(--bp-err);
      margin-top: 2px;
    }
    .hochat-file-chip-remove {
      flex-shrink: 0;
      background: transparent; border: 0;
      color: var(--bp-muted); font-size: 16px;
      cursor: pointer; padding: 0 4px;
      line-height: 1; align-self: flex-start;
      font-family: inherit;
    }
    .hochat-file-chip-remove:hover { color: var(--bp-err); }

    /* Attachments inside message bubbles */
    .hochat-msg-attachments {
      display: flex; flex-wrap: wrap; gap: 8px;
      margin-top: 6px;
      max-width: 100%;
    }
    .hochat-msg-attachment-img {
      width: 120px; height: 120px;
      border-radius: 8px;
      overflow: hidden;
      background: var(--bp-cream);
      border: 1px solid rgba(0, 0, 0, 0.08);
      transition: transform 0.12s, box-shadow 0.12s;
    }
    .hochat-msg-attachment-img:hover {
      transform: scale(1.02);
      box-shadow: 0 6px 14px rgba(0, 0, 0, 0.14);
    }
    .hochat-msg-attachment-img img {
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
    }
    .hochat-msg-attachment-loading {
      display: flex; align-items: center; justify-content: center;
      width: 100%; height: 100%;
      font-size: 11px; color: var(--bp-muted);
    }
    .hochat-msg-attachment-pdf {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      background: #fff;
      border: 1px solid var(--bp-border);
      border-radius: 10px;
      max-width: 320px;
      transition: border-color 0.12s;
    }
    .hochat-msg-out .hochat-msg-attachment-pdf {
      background: rgba(255, 255, 255, 0.94);
      border-color: rgba(255, 255, 255, 0.4);
    }
    .hochat-msg-attachment-pdf:hover { border-color: var(--bp-green); }
    .hochat-msg-attachment-pdf-icon { font-size: 22px; flex-shrink: 0; }
    .hochat-msg-attachment-pdf-info {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column; gap: 2px;
    }
    .hochat-msg-attachment-pdf-name {
      font-size: 13px; font-weight: 600;
      color: var(--bp-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hochat-msg-attachment-pdf-meta {
      font-size: 11px;
      color: var(--bp-muted);
    }
    .hochat-msg-attachment-pdf-download {
      background: var(--bp-green);
      color: #fff;
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      text-decoration: none;
      flex-shrink: 0;
      transition: background 0.12s;
    }
    .hochat-msg-attachment-pdf-download:hover {
      background: var(--bp-green-dk); color: #fff;
    }

    /* Fullscreen image viewer */
    .hochat-image-viewer {
      position: fixed; inset: 0;
      z-index: 9999;
      background: rgba(0, 0, 0, 0.88);
      display: flex; align-items: center; justify-content: center;
      cursor: zoom-out;
      animation: hochatViewerFade 0.16s ease-out;
    }
    @keyframes hochatViewerFade { from { opacity: 0; } to { opacity: 1; } }
    .hochat-image-viewer img {
      max-width: 92vw; max-height: 92vh;
      object-fit: contain;
      border-radius: 6px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
    }
    .hochat-image-viewer-close {
      position: fixed; top: 20px; right: 24px;
      width: 40px; height: 40px;
      background: rgba(255, 255, 255, 0.16);
      border: 0; color: #fff;
      border-radius: 50%;
      font-size: 22px;
      cursor: pointer;
      line-height: 1;
      transition: background 0.12s;
      font-family: inherit;
    }
    .hochat-image-viewer-close:hover { background: rgba(255, 255, 255, 0.3); }
  `;
  document.head.appendChild(style);
}
