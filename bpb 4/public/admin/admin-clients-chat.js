/* ═══════════════════════════════════════════════════════════════════════════
   admin-clients-chat.js — Sprint 10b

   Chat drawer module loaded on demand from admin-clients.js when the
   designer/master clicks "Open chat" on any client card. Slides in from
   the right; reads/writes client_messages directly via Supabase RLS.

   Per-client threading: one thread per client_id, all proposals share it.
     - Master sees + sends for any client
     - Designer sees + sends only for clients with proposals they own
     - (Homeowner uses a different UI in Sprint 10c — different drawer)

   Realtime: subscribes to a per-client postgres_changes channel filtered
   to client_messages inserts so new messages appear instantly. Subscription
   is torn down on drawer close.

   Sender role on insert is determined by the current user's profile.role
   ('master' or 'designer'). RLS enforces this matches reality.

   Sprint 10d will add file uploads (PDF + images, 25MB cap) — schema and
   attachment table are already in place from Sprint 10a.
   ═══════════════════════════════════════════════════════════════════════════ */

import { supabase } from '/js/supabase-client.js';

let _drawer = null;
let _backdrop = null;
let _channel = null;
let _currentUser = null;          // { id, role, display_name, email }
let _currentClient = null;
const _profileCache = new Map();  // user_id → { display_name, email, role }
let _escListener = null;

// ─── Public API ──────────────────────────────────────────────────────────
export async function openClientChatDrawer(client) {
  _currentClient = client;

  if (!_currentUser) {
    _currentUser = await fetchCurrentUser();
    if (!_currentUser) {
      alert('Could not load your profile. Please refresh and try again.');
      return;
    }
  }

  injectStyles();
  buildDrawer();
  await loadAndRenderMessages();
  subscribeRealtime();
}

// ─── Build the drawer DOM ────────────────────────────────────────────────
function buildDrawer() {
  closeDrawerInstantly(); // tear down any prior drawer

  _backdrop = document.createElement('div');
  _backdrop.className = 'acc-backdrop';

  _drawer = document.createElement('aside');
  _drawer.className = 'acc-drawer';
  _drawer.setAttribute('role', 'dialog');
  _drawer.setAttribute('aria-modal', 'true');
  _drawer.innerHTML = `
    <header class="acc-head">
      <div class="acc-head-info">
        <div class="acc-eyebrow">Chat</div>
        <h3 class="acc-title">${escapeHtml(_currentClient.name)}</h3>
        <div class="acc-meta">${escapeHtml(_currentClient.email || '')}</div>
      </div>
      <button class="acc-close" aria-label="Close chat">×</button>
    </header>
    <div class="acc-messages" id="accMessages">
      <div class="acc-loading">Loading messages…</div>
    </div>
    <div class="acc-composer">
      <textarea id="accInput" rows="2"
        placeholder="Type a message — Enter to send, Shift+Enter for new line"></textarea>
      <button id="accSend" class="acc-send">Send</button>
    </div>
  `;

  document.body.appendChild(_backdrop);
  document.body.appendChild(_drawer);
  document.body.classList.add('acc-drawer-open');

  requestAnimationFrame(() => {
    _backdrop.classList.add('open');
    _drawer.classList.add('open');
  });

  _drawer.querySelector('.acc-close').addEventListener('click', closeDrawer);
  _backdrop.addEventListener('click', closeDrawer);
  _drawer.querySelector('#accSend').addEventListener('click', handleSend);
  const input = _drawer.querySelector('#accInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  _escListener = (e) => { if (e.key === 'Escape') closeDrawer(); };
  document.addEventListener('keydown', _escListener);

  setTimeout(() => input.focus(), 280);
}

function closeDrawer() {
  if (!_drawer) return;
  _drawer.classList.remove('open');
  _backdrop.classList.remove('open');
  document.body.classList.remove('acc-drawer-open');
  unsubscribeRealtime();
  if (_escListener) {
    document.removeEventListener('keydown', _escListener);
    _escListener = null;
  }
  setTimeout(() => {
    if (_drawer) _drawer.remove();
    if (_backdrop) _backdrop.remove();
    _drawer = null;
    _backdrop = null;
    _currentClient = null;
  }, 280);
}

function closeDrawerInstantly() {
  if (_drawer) _drawer.remove();
  if (_backdrop) _backdrop.remove();
  _drawer = null;
  _backdrop = null;
  unsubscribeRealtime();
  if (_escListener) {
    document.removeEventListener('keydown', _escListener);
    _escListener = null;
  }
}

// ─── Load + render messages ──────────────────────────────────────────────
async function loadAndRenderMessages() {
  const { data, error } = await supabase
    .from('client_messages')
    .select('id, sender_user_id, sender_role, body, created_at')
    .eq('client_id', _currentClient.id)
    .order('created_at', { ascending: true });

  if (error) {
    showError(`Could not load messages: ${error.message}`);
    return;
  }

  const messages = data || [];

  // Resolve sender display names for staff senders (homeowner = client.name)
  const staffSenderIds = [...new Set(
    messages
      .filter(m => m.sender_role === 'designer' || m.sender_role === 'master')
      .map(m => m.sender_user_id)
      .filter(Boolean)
  )];
  if (staffSenderIds.length > 0) {
    const uncached = staffSenderIds.filter(id => !_profileCache.has(id));
    if (uncached.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, email, role')
        .in('id', uncached);
      for (const p of (profiles || [])) {
        _profileCache.set(p.id, p);
      }
    }
  }

  const messagesEl = _drawer.querySelector('#accMessages');
  if (messages.length === 0) {
    messagesEl.innerHTML = `
      <div class="acc-empty">
        <div class="acc-empty-icon">💬</div>
        <div class="acc-empty-title">No messages yet</div>
        <div class="acc-empty-sub">Start the conversation with ${escapeHtml(_currentClient.name)}.</div>
      </div>
    `;
  } else {
    messagesEl.innerHTML = messages.map(renderMessage).join('');
    scrollToBottom();
  }
}

function renderMessage(message) {
  const isOutbound = message.sender_user_id === _currentUser.id;
  const senderName = getSenderName(message);
  const rolePill = message.sender_role === 'master'
    ? '<span class="acc-role-pill acc-role-master">Master</span>'
    : message.sender_role === 'designer'
      ? '<span class="acc-role-pill acc-role-designer">Designer</span>'
      : '<span class="acc-role-pill acc-role-homeowner">Homeowner</span>';
  const time = formatMessageTime(message.created_at);
  const bodyHtml = escapeHtml(message.body || '').replace(/\n/g, '<br>');

  return `
    <div class="acc-msg ${isOutbound ? 'acc-msg-out' : 'acc-msg-in'}" data-message-id="${escapeAttr(message.id)}">
      <div class="acc-msg-meta">
        <span class="acc-msg-sender">${escapeHtml(senderName)}</span>
        ${rolePill}
        <span class="acc-msg-time">${escapeHtml(time)}</span>
      </div>
      <div class="acc-msg-body">${bodyHtml}</div>
    </div>
  `;
}

function getSenderName(message) {
  if (message.sender_role === 'homeowner') {
    return _currentClient.name || 'Homeowner';
  }
  const profile = _profileCache.get(message.sender_user_id);
  return profile?.display_name || profile?.email || 'Designer';
}

// ─── Realtime subscription ───────────────────────────────────────────────
function subscribeRealtime() {
  unsubscribeRealtime();
  const channelName = `client_messages_${_currentClient.id}_${Date.now()}`;
  _channel = supabase
    .channel(channelName)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'client_messages',
      filter: `client_id=eq.${_currentClient.id}`,
    }, async (payload) => {
      const message = payload.new;
      if ((message.sender_role === 'designer' || message.sender_role === 'master')
          && !_profileCache.has(message.sender_user_id)) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, display_name, email, role')
          .eq('id', message.sender_user_id)
          .maybeSingle();
        if (profile) _profileCache.set(profile.id, profile);
      }
      appendMessage(message);
    })
    .subscribe();
}

function unsubscribeRealtime() {
  if (_channel) {
    supabase.removeChannel(_channel);
    _channel = null;
  }
}

function appendMessage(message) {
  if (!_drawer) return;
  const messagesEl = _drawer.querySelector('#accMessages');
  const empty = messagesEl.querySelector('.acc-empty');
  if (empty) empty.remove();
  if (messagesEl.querySelector(`[data-message-id="${message.id}"]`)) return;

  const wasNearBottom = isScrolledNearBottom();
  messagesEl.insertAdjacentHTML('beforeend', renderMessage(message));
  if (wasNearBottom) scrollToBottom();
}

// ─── Sending ─────────────────────────────────────────────────────────────
async function handleSend() {
  const input = _drawer.querySelector('#accInput');
  const sendBtn = _drawer.querySelector('#accSend');
  const body = input.value.trim();
  if (!body) return;

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';

  const { error } = await supabase
    .from('client_messages')
    .insert({
      client_id: _currentClient.id,
      sender_user_id: _currentUser.id,
      sender_role: _currentUser.role,
      body,
    });

  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';

  if (error) {
    showError(`Could not send: ${error.message}`);
    return;
  }

  input.value = '';
  input.focus();
  // Realtime delivers the message back to us → renders in the thread.
}

// ─── Helpers ─────────────────────────────────────────────────────────────
async function fetchCurrentUser() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, role, display_name, email, is_active')
    .eq('id', session.user.id)
    .maybeSingle();
  if (error || !profile || !profile.is_active) return null;
  _profileCache.set(profile.id, profile);
  return profile;
}

function isScrolledNearBottom() {
  const messagesEl = _drawer.querySelector('#accMessages');
  if (!messagesEl) return true;
  return (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 100;
}

function scrollToBottom() {
  const messagesEl = _drawer.querySelector('#accMessages');
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showError(msg) {
  if (!_drawer) { alert(msg); return; }
  const messagesEl = _drawer.querySelector('#accMessages');
  const errEl = document.createElement('div');
  errEl.className = 'acc-error';
  errEl.textContent = msg;
  messagesEl.appendChild(errEl);
  scrollToBottom();
  setTimeout(() => errEl.remove(), 6000);
}

function formatMessageTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  if (d > sevenDaysAgo) {
    return d.toLocaleDateString('en-US', {
      weekday: 'short', hour: 'numeric', minute: '2-digit',
    });
  }
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s) { return escapeHtml(s); }

// ─── Styles ──────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('acc-styles')) return;
  const style = document.createElement('style');
  style.id = 'acc-styles';
  style.textContent = `
    body.acc-drawer-open { overflow: hidden; }

    .acc-backdrop {
      position: fixed; inset: 0; z-index: 1100;
      background: rgba(26, 31, 46, 0.45);
      opacity: 0; transition: opacity 0.25s ease-out;
      pointer-events: none;
    }
    .acc-backdrop.open { opacity: 1; pointer-events: auto; }

    .acc-drawer {
      position: fixed; top: 0; right: 0; bottom: 0;
      width: 480px; max-width: 100vw;
      background: #fff;
      box-shadow: -10px 0 40px rgba(0, 0, 0, 0.15);
      z-index: 1101;
      display: flex; flex-direction: column;
      transform: translateX(100%);
      transition: transform 0.28s cubic-bezier(0.32, 0.72, 0, 1);
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      color: #353535;
    }
    .acc-drawer.open { transform: translateX(0); }

    .acc-head {
      padding: 22px 24px 18px;
      border-bottom: 1px solid #e8e6dd;
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: 14px;
      background: #faf8f3;
    }
    .acc-head-info { flex: 1; min-width: 0; }
    .acc-eyebrow {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 10px; letter-spacing: 0.18em;
      color: #9c7440; text-transform: uppercase;
      margin-bottom: 4px; font-weight: 600;
    }
    .acc-title {
      font-size: 19px; font-weight: 600;
      letter-spacing: -0.012em; margin: 0 0 4px;
      line-height: 1.2;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .acc-meta { font-size: 12px; color: #888; }
    .acc-close {
      width: 32px; height: 32px;
      background: transparent; border: 0; cursor: pointer;
      font-size: 22px; line-height: 1; color: #888;
      border-radius: 6px;
      transition: background 0.12s, color 0.12s;
      flex-shrink: 0;
    }
    .acc-close:hover { background: #ece9dd; color: #353535; }

    .acc-messages {
      flex: 1; overflow-y: auto;
      padding: 22px 24px;
      display: flex; flex-direction: column; gap: 14px;
      background: #fff;
    }
    .acc-loading { color: #888; font-size: 13px; padding: 20px 0; text-align: center; }
    .acc-empty {
      text-align: center; padding: 60px 20px;
      color: #888;
    }
    .acc-empty-icon { font-size: 38px; margin-bottom: 12px; opacity: 0.6; }
    .acc-empty-title { font-size: 15px; font-weight: 600; color: #555; margin-bottom: 4px; }
    .acc-empty-sub { font-size: 13px; }
    .acc-error {
      background: #fbeeee; color: #b91c1c;
      border-left: 3px solid #b91c1c;
      padding: 10px 14px; border-radius: 6px;
      font-size: 13px; line-height: 1.5;
    }

    .acc-msg {
      display: flex; flex-direction: column; gap: 4px;
      max-width: 90%;
    }
    .acc-msg-in { align-self: flex-start; }
    .acc-msg-out { align-self: flex-end; align-items: flex-end; }
    .acc-msg-meta {
      display: flex; gap: 6px; align-items: center;
      font-size: 11px; color: #888;
      flex-wrap: wrap;
    }
    .acc-msg-sender { font-weight: 600; color: #555; }
    .acc-msg-time { color: #aaa; font-family: 'JetBrains Mono', ui-monospace, monospace; }
    .acc-role-pill {
      font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
      padding: 1px 6px; border-radius: 4px; font-weight: 600;
    }
    .acc-role-master { background: #33281c; color: #fff; }
    .acc-role-designer { background: #9c7440; color: #fff; }
    .acc-role-homeowner { background: #ece9dd; color: #58595b; }
    .acc-msg-body {
      padding: 10px 14px; border-radius: 12px;
      font-size: 14px; line-height: 1.5;
      white-space: pre-wrap; word-wrap: break-word;
    }
    .acc-msg-in .acc-msg-body {
      background: #f4f4ef; color: #353535;
      border-bottom-left-radius: 4px;
    }
    .acc-msg-out .acc-msg-body {
      background: #9c7440; color: #fff;
      border-bottom-right-radius: 4px;
    }

    .acc-composer {
      padding: 14px 20px 18px;
      border-top: 1px solid #e8e6dd;
      background: #faf8f3;
      display: flex; gap: 10px; align-items: flex-end;
    }
    .acc-composer textarea {
      flex: 1;
      font-family: inherit; font-size: 14px;
      padding: 10px 12px;
      border: 1px solid #d4cfc0; border-radius: 8px;
      background: #fff; color: #353535;
      resize: none; min-height: 42px; max-height: 140px;
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    .acc-composer textarea:focus {
      outline: none; border-color: #9c7440;
      box-shadow: 0 0 0 3px #f1e7d3;
    }
    .acc-send {
      font-family: inherit; font-size: 14px; font-weight: 600;
      padding: 10px 18px; border-radius: 8px;
      border: 1px solid transparent; cursor: pointer;
      background: #9c7440; color: #fff;
      box-shadow: 0 2px 8px rgba(93, 126, 105, 0.18);
      transition: background 0.12s, transform 0.1s, opacity 0.12s;
      flex-shrink: 0;
    }
    .acc-send:hover:not(:disabled) {
      background: #7d5c31; transform: translateY(-1px);
    }
    .acc-send:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

    @media (max-width: 640px) {
      .acc-drawer { width: 100vw; }
      .acc-head { padding: 18px 18px 14px; }
      .acc-messages { padding: 18px; }
      .acc-composer { padding: 12px 16px 14px; }
    }
  `;
  document.head.appendChild(style);
}
