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

const HISTORY_KEY = 'bpb-help-chat-v1';
const MAX_KEPT = 24; // stored turns (API truncates further)

let panel = null;
let sending = false;

export async function openHelpChat() {
  if (panel) { panel.remove(); panel = null; return; }
  ensureStyles();

  const brand = await getBranding().catch(() => ({ product_name: 'Portal' }));

  panel = document.createElement('div');
  panel.id = 'bpbHelpChatPanel';
  panel.innerHTML = `
    <div class="hc-head">
      <div>
        <div class="hc-title">${esc(brand.product_name || 'Portal')} Help</div>
        <div class="hc-sub">Ask anything about using the portal</div>
      </div>
      <button class="hc-close" type="button" title="Close">✕</button>
    </div>
    <div class="hc-thread" id="hcThread"></div>
    <div class="hc-chips" id="hcChips">
      <button type="button">How do I publish a proposal?</button>
      <button type="button">What does my client see?</button>
      <button type="button">How do substitutions work?</button>
    </div>
    <div class="hc-compose">
      <textarea id="hcInput" rows="1" placeholder="Type a question…"></textarea>
      <button id="hcSend" type="button">Send</button>
    </div>`;
  document.body.appendChild(panel);

  panel.querySelector('.hc-close').addEventListener('click', () => { panel.remove(); panel = null; });
  panel.querySelector('#hcSend').addEventListener('click', () => send());
  const input = panel.querySelector('#hcInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  panel.querySelectorAll('#hcChips button').forEach(b =>
    b.addEventListener('click', () => { input.value = b.textContent; send(); }));

  renderThread();
  input.focus();
}

// ── History ────────────────────────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(sessionStorage.getItem(HISTORY_KEY)) || []; }
  catch (_) { return []; }
}
function saveHistory(h) {
  try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-MAX_KEPT))); } catch (_) {}
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
      body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
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
    thread.innerHTML = '<div class="hc-empty">Hi! I know this portal inside and out — how proposals work, what your clients see, chat, substitutions, redesigns, publishing… Ask me anything.</div>';
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
      padding: 14px 16px; background: #1a1f2e; color: #fff;
    }
    #bpbHelpChatPanel .hc-title { font-size: 14px; font-weight: 700; }
    #bpbHelpChatPanel .hc-sub { font-size: 11px; opacity: 0.75; margin-top: 1px; }
    #bpbHelpChatPanel .hc-close {
      background: transparent; border: 0; color: #fff; opacity: 0.7;
      font-size: 14px; cursor: pointer; padding: 4px 6px;
    }
    #bpbHelpChatPanel .hc-close:hover { opacity: 1; }
    #bpbHelpChatPanel .hc-thread {
      flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px;
      background: #faf8f3;
    }
    #bpbHelpChatPanel .hc-empty { font-size: 13px; color: #666; line-height: 1.55; padding: 6px 2px; }
    #bpbHelpChatPanel .hc-msg {
      max-width: 85%; padding: 9px 12px; border-radius: 12px;
      font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    }
    #bpbHelpChatPanel .hc-msg.me { align-self: flex-end; background: #5d7e69; color: #fff; border-bottom-right-radius: 4px; }
    #bpbHelpChatPanel .hc-msg.bot { align-self: flex-start; background: #fff; border: 1px solid #eee; color: #23282f; border-bottom-left-radius: 4px; }
    #bpbHelpChatPanel .hc-typing { color: #999; letter-spacing: 2px; }
    #bpbHelpChatPanel .hc-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 10px; background: #faf8f3; }
    #bpbHelpChatPanel .hc-chips button {
      font: 500 11.5px 'Onest', sans-serif; color: #4a6654; background: #e8eee9;
      border: 0; border-radius: 999px; padding: 7px 11px; cursor: pointer;
    }
    #bpbHelpChatPanel .hc-chips button:hover { background: #d9e4dc; }
    #bpbHelpChatPanel .hc-compose {
      display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #eee; background: #fff;
    }
    #bpbHelpChatPanel .hc-compose textarea {
      flex: 1; resize: none; font: 400 13px/1.4 'Onest', sans-serif;
      border: 1px solid #e5e5e5; border-radius: 10px; padding: 9px 11px; max-height: 90px;
    }
    #bpbHelpChatPanel .hc-compose textarea:focus { outline: 2px solid #e8eee9; border-color: #5d7e69; }
    #bpbHelpChatPanel .hc-compose button {
      font: 600 13px 'Onest', sans-serif; color: #fff; background: #5d7e69;
      border: 0; border-radius: 10px; padding: 0 16px; cursor: pointer;
    }
    #bpbHelpChatPanel .hc-compose button:hover { background: #4a6654; }
    #bpbHelpChatPanel .hc-compose button:disabled { opacity: 0.6; cursor: wait; }
  `;
  document.head.appendChild(css);
}

function esc(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
