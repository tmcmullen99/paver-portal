// ═══════════════════════════════════════════════════════════════════════════
// admin-clients.js
// Admin client management — Tim's interface for managing clients.
//
// Sprint 8a baseline + Sprint 10c update:
//   - Row click navigates to /admin/client.html?id=<uuid> (War Room)
//     instead of expanding inline. The chat drawer module from Sprint 10b
//     is still imported but no longer wired up — chat lives on the client
//     page now, not in a drawer.
//
// Sprint 14C.4 — Client soft-delete:
//   - Per-row 🗑 trash button. Master can trash any client; designer can
//     trash only clients where created_by = auth.uid(). Calls delete_client
//     SECURITY DEFINER RPC; falls back to clean error toast on permission
//     denied.
//   - Confirm modal shows blast radius (proposal/message/event counts) via
//     get_client_dependents RPC before deletion.
//   - "Show deleted" toggle next to search reveals trashed rows with a
//     Restore button instead of trash. Restore calls restore_client RPC.
//   - Master gets a "Permanently delete (no recovery)" checkbox in the
//     confirm modal, available even on already-soft-deleted clients in the
//     deleted view. Hard delete cascades through every client_id FK.
//   - Active list query filters .is('deleted_at', null) by default; the
//     deleted view inverts that filter.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireAdmin, sendMagicLink } from '/js/auth-util.js';
import { getProposalEngagementBulk, formatRelativeTime } from '/js/engagement-utils.js';

const DISCOUNT_WINDOW_MS = 48 * 60 * 60 * 1000;

const loadingState = document.getElementById('loadingState');
const clientsList = document.getElementById('clientsList');
const emptyState = document.getElementById('emptyState');
const searchInput = document.getElementById('searchInput');
const counter = document.getElementById('counter');
const statusBox = document.getElementById('status');
const addClientBtn = document.getElementById('addClientBtn');
const addForm = document.getElementById('addForm');
const cancelAddBtn = document.getElementById('cancelAddBtn');
const saveClientBtn = document.getElementById('saveClientBtn');
const newName = document.getElementById('newName');
const newEmail = document.getElementById('newEmail');
const newPhone = document.getElementById('newPhone');
const newAddress = document.getElementById('newAddress');
const newNotes = document.getElementById('newNotes');

const ctx = {
  admin: null,
  role: null,         // 'master' | 'designer' — fetched after requireAdmin
  clients: [],
  proposals: [],
  engagement: new Map(),
  searchTerm: '',
  showDeleted: false, // 14C.4: true when "Show deleted" toggle is on
  // Cache of dependents counts (keyed by client_id) so the confirm modal
  // is fast on a second open. Cleared on any delete/restore.
  dependentsCache: new Map(),
};

(async function init() {
  ctx.admin = await requireAdmin();
  if (!ctx.admin) return;

  // 14C.4: fetch role for UI gating (master gets hard-delete checkbox).
  // Failure to load is non-fatal — we default to 'designer' (more
  // restrictive). RPC server-side enforcement is what actually matters.
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', ctx.admin.id)
    .maybeSingle();
  ctx.role = profile?.role === 'master' ? 'master' : 'designer';

  ensureDeleteUiStyles();

  await Promise.all([loadClients(), loadAllProposals()]);
  await loadEngagement();
  render();
  attachEventListeners();
})();

async function loadClients() {
  let q = supabase
    .from('clients')
    .select(`
      id, name, email, phone, address, notes, user_id, created_at, created_by,
      deleted_at,
      referral_credit_cents, referral_credit_used_cents, refer_code,
      client_proposals (
        id, status, sent_at, first_viewed_at, signed_at, created_at,
        proposal:proposals!proposal_id (
          id,
          address,
          show_signing_discount,
          published_proposals (id, slug, published_at, is_canonical)
        )
      ),
      sent_referrals:referrals!referrer_client_id (
        id, referred_email, referred_name, referred_phone, status,
        invite_sent_at, scheduled_at, appointment_completed_at,
        credit_awarded_at, credit_amount_cents
      )
    `);

  // 14C.4: in normal mode, hide trashed clients; in "Show deleted" mode,
  // show only trashed clients (so the trash bin is its own focused view).
  if (ctx.showDeleted) {
    q = q.not('deleted_at', 'is', null);
  } else {
    q = q.is('deleted_at', null);
  }

  const { data, error } = await q.order('created_at', { ascending: false });

  if (error) {
    showStatus('error', `Could not load clients: ${error.message}`);
    ctx.clients = [];
    return;
  }
  ctx.clients = data || [];
}

async function loadAllProposals() {
  const { data, error } = await supabase
    .from('proposals')
    .select(`
      id, address, created_at,
      published_proposals (id, slug)
    `)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error('Could not load proposals:', error);
    ctx.proposals = [];
    return;
  }
  ctx.proposals = data || [];
}

async function loadEngagement() {
  const ids = new Set();
  for (const client of ctx.clients) {
    for (const cp of (client.client_proposals || [])) {
      if (cp.proposal && cp.proposal.id) ids.add(cp.proposal.id);
    }
  }
  if (ids.size === 0) {
    ctx.engagement = new Map();
    return;
  }
  ctx.engagement = await getProposalEngagementBulk([...ids]);
}

function attachEventListeners() {
  // 14C.4: inject the "Show deleted" toggle into the toolbar at runtime so
  // we don't have to edit clients.html. Placed after the counter so it
  // groups with the active/trash mode metadata.
  injectShowDeletedToggle();

  searchInput.addEventListener('input', (e) => {
    ctx.searchTerm = e.target.value.trim().toLowerCase();
    render();
  });

  addClientBtn.addEventListener('click', () => {
    addForm.classList.add('visible');
    newName.focus();
  });
  cancelAddBtn.addEventListener('click', () => {
    addForm.classList.remove('visible');
    clearAddForm();
  });
  saveClientBtn.addEventListener('click', handleAddClient);
}

// 14C.4: inject "Show deleted" toggle into the toolbar (clients.html doesn't
// have it; we add it here to avoid touching the HTML).
function injectShowDeletedToggle() {
  if (document.getElementById('wrcShowDeletedToggle')) return;
  const counterEl = document.getElementById('counter');
  if (!counterEl) return;

  const wrap = document.createElement('label');
  wrap.id = 'wrcShowDeletedWrap';
  wrap.className = 'wrc-show-deleted';
  wrap.innerHTML = `
    <input type="checkbox" id="wrcShowDeletedToggle">
    <span>Show deleted</span>
  `;
  counterEl.parentNode.insertBefore(wrap, addClientBtn);

  document.getElementById('wrcShowDeletedToggle').addEventListener('change', async (e) => {
    ctx.showDeleted = !!e.target.checked;
    document.body.classList.toggle('wrc-deleted-mode', ctx.showDeleted);
    loadingState.style.display = 'block';
    clientsList.style.display = 'none';
    await loadClients();
    await loadEngagement();
    render();
  });
}

function render() {
  loadingState.style.display = 'none';

  const visible = ctx.searchTerm
    ? ctx.clients.filter(c => {
        const haystack = [c.name, c.email, c.phone, c.address, c.notes]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(ctx.searchTerm);
      })
    : ctx.clients;

  // 14C.4: counter copy reflects which list we're showing
  const noun = ctx.showDeleted ? 'deleted' : 'clients';
  counter.textContent = `${visible.length} of ${ctx.clients.length} ${noun}`;

  if (ctx.clients.length === 0) {
    if (ctx.showDeleted) {
      // No deleted clients: replace the empty-state copy temporarily
      emptyState.style.display = 'block';
      emptyState.innerHTML = `
        <div style="font-size: 14px; color: var(--muted);">
          🗑 No deleted clients in the trash.
        </div>
      `;
      clientsList.style.display = 'none';
      return;
    }
    emptyState.style.display = 'block';
    clientsList.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  clientsList.style.display = 'grid';
  clientsList.innerHTML = `
    <style>
      @keyframes adminClientsEngPulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.4); opacity: 0.6; }
      }
    </style>
    ${visible.map(renderClientCard).join('')}
  `;

  visible.forEach(c => {
    wireCardHandlers(c);
  });
}

function renderClientCard(client) {
  const linkedBadge = client.user_id
    ? '<span class="badge linked">Logged in</span>'
    : '<span class="badge unlinked">Not yet logged in</span>';

  const proposalCount = (client.client_proposals || []).length;
  const proposalBadge = proposalCount > 0
    ? `<span class="badge proposals">${proposalCount} proposal${proposalCount === 1 ? '' : 's'}</span>`
    : '';

  const referralCount = (client.sent_referrals || []).length;
  const referralBadge = referralCount > 0
    ? `<span class="badge proposals" style="background:#fff4d4;color:#7a5a10;">${referralCount} referral${referralCount === 1 ? '' : 's'}</span>`
    : '';

  const aggEng = aggregateClientEngagement(client);
  const engagementLine = renderClientEngagementLine(aggEng);

  const createdLine = client.created_at
    ? `<span style="font-family:'JetBrains Mono', ui-monospace, monospace; font-size:11px; color:var(--muted);">Client since ${formatDate(client.created_at)}</span>`
    : '';

  // 14C.4: per-row delete or restore button. Designer can only act on
  // clients they created; master can act on any. Server-side RPC also
  // enforces; this is just for hiding the affordance.
  const canAct = ctx.role === 'master' || client.created_by === ctx.admin.id;
  let actionBtnHtml = '';
  if (canAct) {
    if (ctx.showDeleted) {
      const deletedLine = client.deleted_at
        ? `<span class="wrc-deleted-tag">Deleted ${formatDate(client.deleted_at)}</span>`
        : '';
      actionBtnHtml = `
        ${deletedLine}
        <button class="wrc-row-btn wrc-restore-btn" data-restore-id="${escapeAttr(client.id)}" title="Restore this client (sets deleted_at = NULL)" aria-label="Restore client">↺ Restore</button>
        ${ctx.role === 'master' ? `
          <button class="wrc-row-btn wrc-hard-delete-btn" data-hard-delete-id="${escapeAttr(client.id)}" title="Permanently delete (master-only, cannot be undone)" aria-label="Permanently delete client">✕</button>
        ` : ''}
      `;
    } else {
      actionBtnHtml = `
        <button class="wrc-row-btn wrc-trash-btn" data-trash-id="${escapeAttr(client.id)}" title="Delete this client (recoverable)" aria-label="Delete client">🗑</button>
      `;
    }
  }

  return `
    <div class="client-card${ctx.showDeleted ? ' wrc-card-deleted' : ''}" data-client-id="${client.id}">
      <div class="client-row">
        <div class="client-info">
          <div class="client-name">${escapeHtml(client.name)}</div>
          <div class="client-meta">
            <span>${escapeHtml(client.email)}</span>
            ${client.phone ? `<span>${escapeHtml(client.phone)}</span>` : ''}
            ${client.address ? `<span>${escapeHtml(client.address)}</span>` : ''}
          </div>
          ${(createdLine || engagementLine) ? `
            <div style="display:flex; gap:14px; align-items:center; margin-top:6px; flex-wrap:wrap;">
              ${createdLine}
              ${engagementLine}
            </div>
          ` : ''}
        </div>
        <div class="client-badges">
          ${linkedBadge}
          ${proposalBadge}
          ${referralBadge}
          ${actionBtnHtml}
          ${ctx.showDeleted ? '' : '<span class="client-chevron">›</span>'}
        </div>
      </div>
    </div>
  `;
}

function aggregateClientEngagement(client) {
  let totalEvents = 0;
  let lastViewMs = 0;
  let isLive = false;
  for (const cp of (client.client_proposals || [])) {
    const propId = cp.proposal && cp.proposal.id;
    if (!propId) continue;
    const eng = ctx.engagement.get(propId);
    if (!eng || eng.totalEvents === 0) continue;
    totalEvents += eng.totalEvents;
    if (eng.isLive) isLive = true;
    if (eng.lastView) {
      const t = new Date(eng.lastView).getTime();
      if (t > lastViewMs) lastViewMs = t;
    }
  }
  if (totalEvents === 0) return null;
  return { totalEvents, lastViewMs, isLive };
}

function renderClientEngagementLine(agg) {
  if (!agg) return '';
  const dotColor = agg.isLive
    ? '#10a04a'
    : (Date.now() - agg.lastViewMs < 24 * 3600 * 1000 ? 'var(--green-dark)' : 'var(--muted)');
  const animation = agg.isLive ? 'animation: adminClientsEngPulse 1.5s ease-in-out infinite;' : '';
  const recency = agg.isLive
    ? 'active right now'
    : agg.lastViewMs > 0 ? `last activity ${formatRelativeTime(new Date(agg.lastViewMs).toISOString())}` : '';
  return `
    <span style="display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--green-dark); font-weight:500;">
      <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${dotColor}; ${animation}"></span>
      ${agg.totalEvents} event${agg.totalEvents === 1 ? '' : 's'}${recency ? ' · ' + escapeHtml(recency) : ''}
    </span>
  `;
}

// ── Event wiring (per-card, after render) ──────────────────────────────────
// Sprint 10c: row click navigates to dedicated client page (War Room).
// 14C.4: trash/restore/hard-delete buttons short-circuit navigation.
function wireCardHandlers(client) {
  const card = clientsList.querySelector(`[data-client-id="${client.id}"]`);
  if (!card) return;

  // Per-card action buttons — wired before the row-click handler so they
  // can stopPropagation and prevent navigation.
  const trashBtn = card.querySelector(`[data-trash-id="${client.id}"]`);
  trashBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    openDeleteConfirmModal(client, { mode: 'soft' });
  });

  const restoreBtn = card.querySelector(`[data-restore-id="${client.id}"]`);
  restoreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    handleRestoreClient(client);
  });

  const hardDeleteBtn = card.querySelector(`[data-hard-delete-id="${client.id}"]`);
  hardDeleteBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    openDeleteConfirmModal(client, { mode: 'hard' });
  });

  // Row click: navigate to the war room. In "Show deleted" mode, navigation
  // is disabled — the war room redirects deleted clients anyway, but we
  // skip the round-trip.
  card.querySelector('.client-row').addEventListener('click', (e) => {
    if (e.target.closest('button, select, a, input, textarea')) return;
    if (ctx.showDeleted) return;
    window.location.href = '/admin/client.html?id=' + encodeURIComponent(client.id);
  });
}

// 14C.4: fetch dependents counts for the confirm modal. Cached per session.
async function getClientDependents(clientId) {
  if (ctx.dependentsCache.has(clientId)) return ctx.dependentsCache.get(clientId);
  const { data, error } = await supabase.rpc('get_client_dependents', { p_client_id: clientId });
  if (error) {
    console.warn('[admin-clients] get_client_dependents failed:', error);
    return null;
  }
  ctx.dependentsCache.set(clientId, data);
  return data;
}

// 14C.4: confirm modal. mode='soft' shows the trash flow; mode='hard'
// shows the master-only permanent-delete flow with a stronger warning.
let _delConfirmOverlay = null;

function buildDeleteConfirmModal() {
  const overlay = document.createElement('div');
  overlay.className = 'wrc-del-overlay';
  overlay.innerHTML = `
    <div class="wrc-del-modal" role="dialog" aria-modal="true" aria-labelledby="wrcDelTitle">
      <button type="button" class="wrc-del-close" aria-label="Close">×</button>
      <div class="wrc-del-head">
        <div class="wrc-del-eyebrow" id="wrcDelEyebrow">Delete client</div>
        <h2 id="wrcDelTitle" class="wrc-del-title">Delete this client?</h2>
        <div class="wrc-del-sub" id="wrcDelSub"></div>
      </div>
      <div class="wrc-del-body">
        <div class="wrc-del-error hidden" id="wrcDelErr"></div>
        <div class="wrc-del-blast" id="wrcDelBlast">Counting dependent records…</div>
        <label class="wrc-del-hardcheck hidden" id="wrcDelHardCheckWrap">
          <input type="checkbox" id="wrcDelHardCheck">
          <span>Permanently delete (cannot be undone — wipes all messages, events, nurture history, and links)</span>
        </label>
      </div>
      <div class="wrc-del-foot">
        <button type="button" class="wrace-btn wrace-cancel" id="wrcDelCancel">Cancel</button>
        <button type="button" class="wrace-btn wrace-save wrc-del-confirm" id="wrcDelConfirm">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => closeDeleteConfirmModal();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.wrc-del-close').addEventListener('click', close);
  overlay.querySelector('#wrcDelCancel').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _delConfirmOverlay && _delConfirmOverlay.style.display !== 'none') close();
  });
  return overlay;
}

let _delPendingClient = null;
let _delPendingMode = 'soft';

async function openDeleteConfirmModal(client, opts) {
  if (!_delConfirmOverlay) _delConfirmOverlay = buildDeleteConfirmModal();
  _delPendingClient = client;
  _delPendingMode = opts.mode === 'hard' ? 'hard' : 'soft';
  const isHard = _delPendingMode === 'hard';

  const eyebrow = _delConfirmOverlay.querySelector('#wrcDelEyebrow');
  const title   = _delConfirmOverlay.querySelector('#wrcDelTitle');
  const sub     = _delConfirmOverlay.querySelector('#wrcDelSub');
  const blast   = _delConfirmOverlay.querySelector('#wrcDelBlast');
  const errEl   = _delConfirmOverlay.querySelector('#wrcDelErr');
  const hardWrap = _delConfirmOverlay.querySelector('#wrcDelHardCheckWrap');
  const hardCheck = _delConfirmOverlay.querySelector('#wrcDelHardCheck');
  const confirmBtn = _delConfirmOverlay.querySelector('#wrcDelConfirm');

  errEl.classList.add('hidden');
  errEl.textContent = '';

  if (isHard) {
    eyebrow.textContent = 'Permanent delete';
    title.textContent = `Permanently delete ${client.name}?`;
    sub.innerHTML = `This <strong>cannot be undone</strong>. The client row, all their proposals link, messages, attachments, engagement events, substitutions, redesign requests, nurture sends, and referral edges will be erased. The underlying <code>auth.users</code> row stays.`;
    hardWrap.classList.remove('hidden');
    hardCheck.checked = false;
    confirmBtn.textContent = 'Permanently delete';
    confirmBtn.classList.add('wrc-del-confirm-danger');
    confirmBtn.disabled = true; // requires checkbox
  } else {
    eyebrow.textContent = 'Delete client';
    title.textContent = `Move ${client.name} to trash?`;
    sub.innerHTML = `Soft-deletes the client. They disappear from this list and from the war room, but everything is recoverable from <strong>Show deleted</strong>.`;
    hardWrap.classList.add('hidden');
    hardCheck.checked = false;
    confirmBtn.textContent = 'Delete';
    confirmBtn.classList.remove('wrc-del-confirm-danger');
    confirmBtn.disabled = false;
  }

  // Wire confirm + hard checkbox each time (overwriting prior listeners by
  // cloning is overkill here; we replace via fresh handlers stored on the
  // node properties, no anonymous duplicates).
  confirmBtn.onclick = () => submitDeleteConfirm();
  hardCheck.onchange = () => {
    confirmBtn.disabled = !hardCheck.checked;
  };

  _delConfirmOverlay.style.display = 'flex';

  // Fetch blast radius (async)
  blast.textContent = 'Counting dependent records…';
  const dep = await getClientDependents(client.id);
  if (!dep || dep.error) {
    blast.innerHTML = `<span class="wrc-del-blast-err">Could not count dependents${dep?.error ? ': ' + escapeHtml(dep.error) : ''}.</span>`;
    return;
  }
  blast.innerHTML = renderBlastRadius(dep, isHard);
}

function renderBlastRadius(dep, isHard) {
  const items = [
    ['proposals',     dep.proposals,     'proposal link'],
    ['messages',      dep.messages,      'message'],
    ['events',        dep.events,        'engagement event'],
    ['substitutions', dep.substitutions, 'substitution'],
    ['redesigns',     dep.redesigns,     'redesign request'],
    ['nurture_sends', dep.nurture_sends, 'nurture send'],
    ['referrals',     dep.referrals,     'referral'],
  ];
  const lines = items
    .filter(([, count]) => count > 0)
    .map(([, count, noun]) => `<li><strong>${count}</strong> ${noun}${count === 1 ? '' : 's'}</li>`);

  if (lines.length === 0) {
    return `<div class="wrc-del-blast-clean">No dependent records — clean delete.</div>`;
  }

  const verb = isHard ? 'will be erased' : 'stay attached (recoverable)';
  return `
    <div class="wrc-del-blast-head">${verb}:</div>
    <ul class="wrc-del-blast-list">${lines.join('')}</ul>
  `;
}

function closeDeleteConfirmModal() {
  if (_delConfirmOverlay) _delConfirmOverlay.style.display = 'none';
  _delPendingClient = null;
}

async function submitDeleteConfirm() {
  if (!_delPendingClient) return;
  const client = _delPendingClient;
  const isHard = _delPendingMode === 'hard';
  const confirmBtn = _delConfirmOverlay.querySelector('#wrcDelConfirm');
  const errEl = _delConfirmOverlay.querySelector('#wrcDelErr');
  errEl.classList.add('hidden');

  confirmBtn.disabled = true;
  confirmBtn.textContent = isHard ? 'Erasing…' : 'Deleting…';

  const { data, error } = await supabase.rpc('delete_client', {
    p_client_id: client.id,
    p_hard: isHard,
  });

  if (error) {
    errEl.textContent = 'Server error: ' + error.message;
    errEl.classList.remove('hidden');
    confirmBtn.disabled = false;
    confirmBtn.textContent = isHard ? 'Permanently delete' : 'Delete';
    return;
  }
  if (!data || data.ok === false) {
    errEl.textContent = (data && data.error) || 'Could not delete this client.';
    errEl.classList.remove('hidden');
    confirmBtn.disabled = false;
    confirmBtn.textContent = isHard ? 'Permanently delete' : 'Delete';
    return;
  }

  ctx.dependentsCache.delete(client.id);
  closeDeleteConfirmModal();
  showStatus('success',
    isHard
      ? `Permanently deleted ${client.name}.`
      : `Moved ${client.name} to trash. Toggle "Show deleted" to recover.`);

  await loadClients();
  await loadEngagement();
  render();
}

async function handleRestoreClient(client) {
  if (!confirm(`Restore ${client.name}? They will reappear in the active client list.`)) return;
  const { data, error } = await supabase.rpc('restore_client', { p_client_id: client.id });
  if (error) {
    showStatus('error', 'Could not restore: ' + error.message);
    return;
  }
  if (!data || data.ok === false) {
    showStatus('error', (data && data.error) || 'Could not restore this client.');
    return;
  }
  ctx.dependentsCache.delete(client.id);
  showStatus('success', `Restored ${client.name}.`);
  await loadClients();
  await loadEngagement();
  render();
}

// 14C.4: styles for the show-deleted toggle, per-row buttons, and confirm modal.
function ensureDeleteUiStyles() {
  if (document.getElementById('wrc-del-styles')) return;
  const style = document.createElement('style');
  style.id = 'wrc-del-styles';
  style.textContent = `
    /* Toolbar toggle */
    .wrc-show-deleted {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; color: var(--muted, #666);
      cursor: pointer; user-select: none;
      margin: 0 8px;
    }
    .wrc-show-deleted input { accent-color: #9c7440; cursor: pointer; }
    .wrc-show-deleted:hover { color: #353535; }

    /* In deleted-mode: tint the cards so the trash bin is visually distinct */
    body.wrc-deleted-mode .client-card {
      background: #fbfaf5;
      border-left: 3px solid #d4cfc0;
    }
    .wrc-deleted-tag {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 10px; color: #888;
      background: #f0eee5;
      padding: 2px 8px; border-radius: 999px;
      margin-right: 4px;
    }

    /* Per-row buttons */
    .wrc-row-btn {
      flex-shrink: 0;
      background: transparent;
      border: 1px solid transparent;
      color: #888;
      font: inherit; font-size: 13px;
      padding: 4px 8px; border-radius: 6px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
      margin-left: 4px;
    }
    .wrc-trash-btn:hover {
      background: #fbe6e6; color: #b91c1c; border-color: #f0caca;
    }
    .wrc-restore-btn {
      color: #9c7440; font-size: 12px;
      border-color: #d4cfc0;
      background: #fff;
    }
    .wrc-restore-btn:hover {
      background: #f1e7d3; color: #7d5c31; border-color: #9c7440;
    }
    .wrc-hard-delete-btn:hover {
      background: #b91c1c; color: #fff; border-color: #b91c1c;
    }

    /* Confirm modal */
    .wrc-del-overlay {
      position: fixed; inset: 0; z-index: 1280;
      background: rgba(26, 31, 46, 0.55);
      display: none; align-items: flex-start; justify-content: center;
      padding: 56px 20px 20px; overflow-y: auto;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .wrc-del-modal {
      background: #fff; border-radius: 14px;
      max-width: 540px; width: 100%;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);
      color: #353535; overflow: hidden;
      display: flex; flex-direction: column; position: relative;
    }
    .wrc-del-close {
      position: absolute; top: 14px; right: 14px;
      width: 32px; height: 32px;
      background: transparent; border: 0; cursor: pointer;
      font-size: 18px; color: #888;
      border-radius: 6px;
    }
    .wrc-del-close:hover { background: #f4f4ef; color: #353535; }
    .wrc-del-head { padding: 22px 28px 14px; border-bottom: 1px solid #e8e6dd; }
    .wrc-del-eyebrow {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px; letter-spacing: 0.18em;
      color: #b91c1c; text-transform: uppercase;
      margin-bottom: 6px; font-weight: 600;
    }
    .wrc-del-title {
      font-size: 18px; font-weight: 600;
      letter-spacing: -0.01em; margin: 0 0 6px;
      line-height: 1.35;
    }
    .wrc-del-sub {
      font-size: 13px; color: #555; line-height: 1.55;
    }
    .wrc-del-sub code {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 12px; background: #f4f4ef;
      padding: 1px 5px; border-radius: 4px;
    }
    .wrc-del-body { padding: 16px 28px; }
    .wrc-del-error {
      background: #fbeeee; color: #b91c1c;
      border-left: 3px solid #b91c1c;
      padding: 10px 14px; border-radius: 6px;
      font-size: 13px; line-height: 1.5; margin-bottom: 12px;
    }
    .wrc-del-error.hidden { display: none; }
    .wrc-del-blast {
      background: #faf8f3; border-radius: 8px;
      padding: 12px 14px;
      font-size: 13px; color: #353535;
      margin-bottom: 12px;
    }
    .wrc-del-blast-head {
      font-weight: 600; margin-bottom: 6px;
      color: #555; font-size: 12px;
      text-transform: uppercase; letter-spacing: 0.04em;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
    }
    .wrc-del-blast-list {
      margin: 0; padding-left: 20px;
    }
    .wrc-del-blast-list li {
      padding: 2px 0; font-size: 13px;
    }
    .wrc-del-blast-clean {
      color: #7d5c31; font-style: italic;
    }
    .wrc-del-blast-err { color: #b91c1c; }
    .wrc-del-hardcheck {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px;
      background: #fbeeee;
      border-left: 3px solid #b91c1c;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px; line-height: 1.5;
    }
    .wrc-del-hardcheck.hidden { display: none; }
    .wrc-del-hardcheck input {
      margin-top: 3px; accent-color: #b91c1c; flex-shrink: 0;
    }
    .wrc-del-foot {
      padding: 14px 28px;
      border-top: 1px solid #e8e6dd;
      display: flex; justify-content: flex-end; gap: 10px;
      background: #faf8f3;
    }
    /* Reuse wrace-btn classes already defined in admin-client.js's
       ensureEditModalStyles for cancel/save styling. The hard-delete
       variant flips primary green to red. */
    .wrace-btn {
      font: inherit; font-size: 14px; font-weight: 600;
      padding: 9px 18px; border-radius: 8px;
      border: 1px solid transparent; cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s, opacity 0.15s;
    }
    .wrace-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .wrace-cancel { background: #fff; color: #353535; border-color: #d4cfc0; }
    .wrace-cancel:hover:not(:disabled) { background: #f4f4ef; border-color: #888; }
    .wrace-save { background: #9c7440; color: #fff; box-shadow: 0 4px 12px rgba(93, 126, 105, 0.22); }
    .wrace-save:hover:not(:disabled) { background: #7d5c31; transform: translateY(-1px); }
    .wrc-del-confirm-danger {
      background: #b91c1c; box-shadow: 0 4px 12px rgba(185, 28, 28, 0.22);
    }
    .wrc-del-confirm-danger:hover:not(:disabled) {
      background: #8a1414;
    }
  `;
  document.head.appendChild(style);
}

// ── Event wiring (per-card, after render) ──────────────────────────────────
// (legacy wireCardHandlers is defined above with the 14C.4 handlers)

// ── Add Client ─────────────────────────────────────────────────────────────
async function handleAddClient() {
  const name = newName.value.trim();
  const email = newEmail.value.trim().toLowerCase();
  const phone = newPhone.value.trim();
  const address = newAddress.value.trim();
  const notes = newNotes.value.trim();

  if (!name) return showStatus('error', 'Name is required.');
  if (!email || !email.includes('@')) return showStatus('error', 'Valid email is required.');

  saveClientBtn.disabled = true;

  const { error } = await supabase
    .from('clients')
    .insert({
      name, email, phone: phone || null,
      address: address || null,
      notes: notes || null,
      created_by: ctx.admin.id,
    });

  saveClientBtn.disabled = false;

  if (error) {
    if (error.code === '23505') {
      return showStatus('error', `A client with email "${email}" already exists.`);
    }
    return showStatus('error', `Could not save: ${error.message}`);
  }

  addForm.classList.remove('visible');
  clearAddForm();
  showStatus('success', `Added ${name}. Click their row to open their page.`);
  await loadClients();
  await loadEngagement();
  render();
}

function clearAddForm() {
  newName.value = '';
  newEmail.value = '';
  newPhone.value = '';
  newAddress.value = '';
  newNotes.value = '';
}

// ── Utils ──────────────────────────────────────────────────────────────────
function showStatus(type, msg) {
  statusBox.className = `status visible ${type}`;
  statusBox.textContent = msg;
  statusBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (type === 'success') {
    setTimeout(() => {
      if (statusBox.textContent === msg) {
        statusBox.className = 'status';
        statusBox.textContent = '';
      }
    }, 5000);
  }
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}
