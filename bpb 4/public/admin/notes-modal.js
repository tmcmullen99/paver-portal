/**
 * BPB Sprint 14 — Shared quick-note modal
 *
 * Imported by /admin/inbox.html, /admin/today.html, /admin/conversations.html
 * (and anywhere else a "+ Note" button needs to appear). Opens a one-textarea
 * dialog that prepends a timestamped entry to clients.notes via the
 * /api/admin-client-notes endpoint in `append` mode.
 *
 * Usage:
 *   import { openQuickNoteModal } from '/admin/notes-modal.js';
 *
 *   openQuickNoteModal({
 *     clientId:   '1d227deb-79bc-…',
 *     clientName: 'Masood Delfarah',
 *     createdBy:  '99112ba0-76cd-…',   // optional (auth.user.id)
 *     onSaved:    () => { … },          // optional callback
 *   });
 *
 * One modal at a time. Multiple open() calls reuse the same DOM.
 */

const STYLE_ID = 'qn-modal-styles';
const ROOT_ID  = 'qn-modal-root';

function injectStylesOnce() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .qn-backdrop {
      position: fixed; inset: 0;
      background: rgba(14, 18, 24, 0.55);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999;
      opacity: 0;
      transition: opacity 0.15s ease;
      padding: 20px;
    }
    .qn-backdrop.is-open { opacity: 1; }
    .qn-dialog {
      background: #fff;
      border-radius: 12px;
      width: 100%;
      max-width: 520px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.28);
      transform: translateY(8px);
      transition: transform 0.18s ease;
      font-family: 'Onest', system-ui, sans-serif;
      color: #353535;
      overflow: hidden;
    }
    .qn-backdrop.is-open .qn-dialog { transform: translateY(0); }
    .qn-header {
      padding: 16px 20px 12px;
      border-bottom: 1px solid #e8e8e3;
      display: flex; justify-content: space-between; align-items: center;
      gap: 12px;
    }
    .qn-eyebrow {
      font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
      color: #9c7440; font-weight: 700; margin-bottom: 3px;
    }
    .qn-title {
      font-size: 16px; font-weight: 600; color: #33281c;
      letter-spacing: -0.005em;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .qn-close {
      background: none; border: none; font-size: 20px; color: #999;
      cursor: pointer; padding: 0; width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 6px;
      flex-shrink: 0;
    }
    .qn-close:hover { background: #f5f5f0; color: #353535; }
    .qn-body { padding: 16px 20px; }
    .qn-textarea {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid #e0e0db;
      border-radius: 8px;
      font: inherit; font-family: 'Onest', system-ui, sans-serif;
      font-size: 14px; color: #353535;
      background: #fff;
      resize: vertical;
      min-height: 120px; max-height: 320px;
      line-height: 1.5;
      box-sizing: border-box;
    }
    .qn-textarea:focus {
      outline: none;
      border-color: #9c7440;
      box-shadow: 0 0 0 3px #eef3ef;
    }
    .qn-meta {
      display: flex; justify-content: space-between; align-items: center;
      margin-top: 8px;
      font-size: 11px; color: #999;
      font-family: 'JetBrains Mono', monospace;
      gap: 12px;
    }
    .qn-hint { font-family: 'Onest', sans-serif; }
    .qn-char.is-near-limit { color: #c08a3a; }
    .qn-char.is-at-limit   { color: #c0392b; font-weight: 600; }
    .qn-actions {
      padding: 12px 20px 16px;
      background: #fafafa;
      border-top: 1px solid #e8e8e3;
      display: flex; justify-content: flex-end; gap: 8px;
    }
    .qn-btn {
      padding: 8px 14px;
      background: #fff;
      border: 1px solid #d8d8d3;
      border-radius: 7px;
      font: inherit; font-family: 'Onest', sans-serif;
      font-size: 13px; font-weight: 500;
      color: #353535;
      cursor: pointer;
    }
    .qn-btn:hover:not(:disabled) {
      border-color: #9c7440;
      color: #7d5c31;
      background: #eef3ef;
    }
    .qn-btn.is-primary {
      background: #9c7440; color: #fff; border-color: #9c7440;
    }
    .qn-btn.is-primary:hover:not(:disabled) {
      background: #7d5c31; border-color: #7d5c31;
    }
    .qn-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .qn-toast {
      position: fixed; bottom: 24px; right: 24px;
      padding: 12px 16px;
      background: #167d3a; color: #fff;
      border-radius: 8px;
      font-family: 'Onest', sans-serif;
      font-size: 13px; font-weight: 500;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      z-index: 10000;
      opacity: 0; transform: translateY(10px);
      transition: all 0.25s ease;
      pointer-events: none;
      max-width: 340px;
    }
    .qn-toast.is-visible { opacity: 1; transform: translateY(0); }
    .qn-toast.is-error { background: #c0392b; }
  `;
  document.head.appendChild(style);
}

function ensureRoot() {
  let root = document.getElementById(ROOT_ID);
  if (root) return root;
  root = document.createElement('div');
  root.id = ROOT_ID;
  document.body.appendChild(root);
  return root;
}

function showToast(msg, kind = 'success') {
  const existing = document.querySelector('.qn-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'qn-toast' + (kind === 'error' ? ' is-error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  // Force layout, then animate in
  requestAnimationFrame(() => el.classList.add('is-visible'));
  setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

export function openQuickNoteModal({ clientId, clientName, createdBy, onSaved }) {
  if (!clientId) {
    console.warn('openQuickNoteModal: clientId is required');
    return;
  }
  injectStylesOnce();
  const root = ensureRoot();

  root.innerHTML = `
    <div class="qn-backdrop" data-qn-role="backdrop">
      <div class="qn-dialog" data-qn-role="dialog">
        <div class="qn-header">
          <div>
            <div class="qn-eyebrow">QUICK NOTE</div>
            <div class="qn-title">${escapeHtml(clientName || 'Client')}</div>
          </div>
          <button class="qn-close" type="button" data-qn-role="close" aria-label="Close">✕</button>
        </div>
        <div class="qn-body">
          <textarea
            class="qn-textarea"
            data-qn-role="textarea"
            placeholder="Called him today, wants to talk pricing next week…"
            maxlength="5000"
            rows="5"></textarea>
          <div class="qn-meta">
            <span class="qn-hint">Prepends to designer notes with a timestamp · ⌘ + Enter to save</span>
            <span class="qn-char" data-qn-role="char">0 / 5,000</span>
          </div>
        </div>
        <div class="qn-actions">
          <button class="qn-btn" type="button" data-qn-role="cancel">Cancel</button>
          <button class="qn-btn is-primary" type="button" data-qn-role="save">Save note</button>
        </div>
      </div>
    </div>
  `;

  const backdrop = root.querySelector('[data-qn-role="backdrop"]');
  const dialog   = root.querySelector('[data-qn-role="dialog"]');
  const textarea = root.querySelector('[data-qn-role="textarea"]');
  const charEl   = root.querySelector('[data-qn-role="char"]');
  const closeBtn = root.querySelector('[data-qn-role="close"]');
  const cancelBtn= root.querySelector('[data-qn-role="cancel"]');
  const saveBtn  = root.querySelector('[data-qn-role="save"]');

  // Open animation + focus
  requestAnimationFrame(() => {
    backdrop.classList.add('is-open');
    textarea.focus();
  });

  function close() {
    backdrop.classList.remove('is-open');
    setTimeout(() => { root.innerHTML = ''; }, 200);
  }

  function updateChar() {
    const len = textarea.value.length;
    charEl.textContent = `${len.toLocaleString()} / 5,000`;
    charEl.classList.remove('is-near-limit', 'is-at-limit');
    if (len >= 5000)     charEl.classList.add('is-at-limit');
    else if (len > 4500) charEl.classList.add('is-near-limit');
  }
  textarea.addEventListener('input', updateChar);
  updateChar();

  async function save() {
    const text = textarea.value.trim();
    if (!text) { textarea.focus(); return; }

    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      const resp = await fetch('/api/admin-client-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          append: text,
          created_by: createdBy || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        showToast(`Couldn't save: ${data.error || resp.status}`, 'error');
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = 'Save note';
        return;
      }
      close();
      showToast('✓ Note added');
      if (typeof onSaved === 'function') onSaved(data);
    } catch (e) {
      showToast('Network error: ' + (e.message || e), 'error');
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = 'Save note';
    }
  }

  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  dialog.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', escHandler);
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
