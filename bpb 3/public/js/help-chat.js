// ═══════════════════════════════════════════════════════════════════════════
// help-chat.js — SPRINT 4 (in-app knowledge base chat widget)
//
// Floating chat panel opened from the "?" Help menu (tour.js lazy-imports
// this module on first use, so pages pay zero cost until someone asks for
// help). Talks to /api/help-chat, which is JWT-gated to staff and grounded
// in the portal capability manual stored in Supabase.
//
// History persists in sessionStorage so the conversation survives page
// navigation within the tab.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { getBranding } from '/js/branding.js';

const HISTORY_KEYS = { portal: 'bpb-help-chat-v1', pro: 'bpb-ask-pro-v1' };
const MAX_KEPT = 24; // stored turns (API truncates further)

const CHIPS = {
  portal: ['How do I publish a proposal?', 'What does my client see?', 'How do substitutions work?'],
  pro: ['Base depth for a driveway in clay soil?', 'Do I need a permit for a 4-ft retaining wall in Contra Costa County?', 'Best jointing sand for a pool deck?'],
};

let panel = null;
let sending = false;
let mode = 'pro';   // field-first default; Portal help one tap away

export async function openHelpChat(startMode) {
  if (panel) { panel.remove(); panel = null; if (!startMode) return; }
  if (startMode === 'pro' || startMode === 'portal') mode = startMode;
  ensureStyles();

  const brand = await getBranding().catch(() => ({ product_name: 'Portal' }));

  panel = document.createElement('div');
  panel.id = 'bpbHelpChatPanel';
  panel.innerHTML = `
    <div class="hc-head">
      <div>
        <div class="hc-title" id="hcTitle"></div>
        <div class="hc-sub" id="hcSub"></div>
      </div>
      <button class="hc-close" type="button" title="Close">✕</button>
    </div>
    <div class="hc-tabs">
      <button type="button" data-mode="pro" id="hcTabPro">🛠 Ask a Pro</button>
      <button type="button" data-mode="portal" id="hcTabPortal">❔ Portal help</button>
    </div>
    <div class="hc-thread" id="hcThread"></div>
    <div class="hc-chips" id="hcChips"></div>
    <div class="hc-compose">
      <textarea id="hcInput" rows="1" placeholder="Type a question…"></textarea>
      <button id="hcSend" type="button">Send</button>
    </div>`;
  document.body.appendChild(panel);
  panel.dataset.brandProduct = brand.product_name || 'Portal';

  panel.querySelector('.hc-close').addEventListener('click', () => { panel.remove(); panel = null; });
  panel.querySelector('#hcSend').addEventListener('click', () => send());
  const input = panel.querySelector('#hcInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  panel.querySelectorAll('.hc-tabs button').forEach(t =>
    t.addEventListener('click', () => setMode(t.dataset.mode)));

  setMode(mode);
  input.focus();
}

function setMode(m) {
  mode = m === 'portal' ? 'portal' : 'pro';
  if (!panel) return;
  const product = panel.dataset.brandProduct || 'Portal';
  panel.querySelector('#hcTitle').textContent = mode === 'pro' ? 'Ask a Pro' : product + ' Help';
  panel.querySelector('#hcSub').textContent = mode === 'pro'
    ? 'Materials, installs, codes — expert answers in the field'
    : 'Ask anything about using the portal';
  panel.querySelectorAll('.hc-tabs button').forEach(t =>
    t.classList.toggle('active', t.dataset.mode === mode));
  const chips = panel.querySelector('#hcChips');
  chips.innerHTML = CHIPS[mode].map(c => `<button type="button">${esc(c)}</button>`).join('');
  chips.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { panel.querySelector('#hcInput').value = b.textContent; send(); }));
  renderThread(true);
}

// ── History ────────────────────────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(sessionStorage.getItem(HISTORY_KEYS[mode])) || []; }
  catch (_) { return []; }
}
function saveHistory(h) {
  try { sessionStorage.setItem(HISTORY_KEYS[mode], JSON.stringify(h.slice(-MAX_KEPT))); } catch (_) {}
}

// ── Send / render ──────────────────────────────────────────────────────────
async function send() {
  if (sending || !panel) return;
  const input = panel.querySelector('#hcInput');
  const text = input.value.trim();
  if (!text) return;

  const history = loadHistory();
  history.push({ role: 'user', content: text });
  saveHistory(history);
  input.value = '';
  renderThread(true);

  sending = true;
  const sendBtn = panel.querySelector('#hcSend');
  sendBtn.disabled = true;
  appendTyping();

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const resp = await fetch('/api/help-chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session && session.access_token ? { Authorization: 'Bearer ' + session.access_token } : {}),
      },
      body: JSON.stringify({ mode, messages: history.map(({ role, content }) => ({ role, content })) }),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok || !out.ok) throw new Error(out.error || ('HTTP ' + resp.status));
    history.push({ role: 'assistant', content: out.reply });
    saveHistory(history);
  } catch (e) {
    history.push({ role: 'assistant', content: '⚠️ ' + (e.message || 'Something went wrong — try again.') });
    saveHistory(history);
  } finally {
    sending = false;
    if (panel) {
      panel.querySelector('#hcSend').disabled = false;
      renderThread(true);
      panel.querySelector('#hcInput').focus();
    }
  }
}

function renderThread(scroll) {
  if (!panel) return;
  const thread = panel.querySelector('#hcThread');
  const chips = panel.querySelector('#hcChips');
  const history = loadHistory();

  chips.style.display = history.length ? 'none' : 'flex';

  if (!history.length) {
    thread.innerHTML = mode === 'pro'
      ? '<div class="hc-empty">Standing in a yard with a question? Materials, base prep, drainage, ICPI standards, county permit rules — ask and I\'ll answer like the sharpest estimator you know. I can check current local codes on the web, but always confirm with the building department.</div>'
      : '<div class="hc-empty">Hi! I know this portal inside and out — how proposals work, what your clients see, chat, substitutions, redesigns, publishing… Ask me anything.</div>';
    return;
  }
  thread.innerHTML = history.map(m =>
    `<div class="hc-msg ${m.role === 'user' ? 'me' : 'bot'}">${esc(m.content)}</div>`
  ).join('');
  if (scroll) thread.scrollTop = thread.scrollHeight;
}

function appendTyping() {
  if (!panel) return;
  const thread = panel.querySelector('#hcThread');
  const t = document.createElement('div');
  t.className = 'hc-msg bot hc-typing';
  t.textContent = '…';
  thread.appendChild(t);
  thread.scrollTop = thread.scrollHeight;
}

// ── Styles ─────────────────────────────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById('bpb-helpchat-css')) return;
  const css = document.createElement('style');
  css.id = 'bpb-helpchat-css';
  css.textContent = `
    #bpbHelpChatPanel {
      position: fixed; right: 18px; bottom: 74px; z-index: 9995;
      width: 360px; max-width: calc(100vw - 24px); height: 480px; max-height: calc(100vh - 110px);
      background: #fff; border: 1px solid #e5e5e5; border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.25);
      display: flex; flex-direction: column; overflow: hidden;
      font-family: 'Onest', -apple-system, sans-serif;
    }
    #bpbHelpChatPanel .hc-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px; background: #33281c; color: #fff;
    }
    #bpbHelpChatPanel .hc-title { font-size: 14px; font-weight: 700; }
    #bpbHelpChatPanel .hc-sub { font-size: 11px; opacity: 0.75; margin-top: 1px; }
    #bpbHelpChatPanel .hc-close {
      background: transparent; border: 0; color: #fff; opacity: 0.7;
      font-size: 14px; cursor: pointer; padding: 4px 6px;
    }
    #bpbHelpChatPanel .hc-close:hover { opacity: 1; }
    #bpbHelpChatPanel .hc-tabs { display: flex; gap: 0; border-bottom: 1px solid #eee; background: #fff; }
    #bpbHelpChatPanel .hc-tabs button {
      flex: 1; font: 600 12px 'Onest', sans-serif; color: #8a857c; background: #fff;
      border: 0; border-bottom: 2px solid transparent; padding: 10px 6px; cursor: pointer;
    }
    #bpbHelpChatPanel .hc-tabs button.active { color: #7d5c31; border-bottom-color: #9c7440; background: #faf6ee; }
    @media (max-width: 640px) {
      #bpbHelpChatPanel {
        inset: 0 !important; right: 0 !important; bottom: 0 !important;
        width: 100vw !important; max-width: 100vw !important;
        height: 100dvh !important; max-height: 100dvh !important;
        border-radius: 0 !important; border: 0 !important;
      }
    }
    #bpbHelpChatPanel .hc-thread {
      flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px;
      background: #faf8f3;
    }
    #bpbHelpChatPanel .hc-empty { font-size: 13px; color: #666; line-height: 1.55; padding: 6px 2px; }
    #bpbHelpChatPanel .hc-msg {
      max-width: 85%; padding: 9px 12px; border-radius: 12px;
      font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    }
    #bpbHelpChatPanel .hc-msg.me { align-self: flex-end; background: #9c7440; color: #fff; border-bottom-right-radius: 4px; }
    #bpbHelpChatPanel .hc-msg.bot { align-self: flex-start; background: #fff; border: 1px solid #eee; color: #23282f; border-bottom-left-radius: 4px; }
    #bpbHelpChatPanel .hc-typing { color: #999; letter-spacing: 2px; }
    #bpbHelpChatPanel .hc-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 10px; background: #faf8f3; }
    #bpbHelpChatPanel .hc-chips button {
      font: 500 11.5px 'Onest', sans-serif; color: #7d5c31; background: #f1e7d3;
      border: 0; border-radius: 999px; padding: 7px 11px; cursor: pointer;
    }
    #bpbHelpChatPanel .hc-chips button:hover { background: #e9dcc0; }
    #bpbHelpChatPanel .hc-compose {
      display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #eee; background: #fff;
    }
    #bpbHelpChatPanel .hc-compose textarea {
      flex: 1; resize: none; font: 400 13px/1.4 'Onest', sans-serif;
      border: 1px solid #e5e5e5; border-radius: 10px; padding: 9px 11px; max-height: 90px;
    }
    #bpbHelpChatPanel .hc-compose textarea:focus { outline: 2px solid #f1e7d3; border-color: #9c7440; }
    #bpbHelpChatPanel .hc-compose button {
      font: 600 13px 'Onest', sans-serif; color: #fff; background: #9c7440;
      border: 0; border-radius: 10px; padding: 0 16px; cursor: pointer;
    }
    #bpbHelpChatPanel .hc-compose button:hover { background: #7d5c31; }
    #bpbHelpChatPanel .hc-compose button:disabled { opacity: 0.6; cursor: wait; }
  `;
  document.head.appendChild(css);
}

function esc(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
