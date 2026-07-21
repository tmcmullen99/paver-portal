// ═══════════════════════════════════════════════════════════════════════════
// admin-client.js — Sprint 14C.2 + 14C.3 + War Room Level A
//
// War Room layout for one client at /admin/client.html?id=<client_uuid>.
// Optional URL params: &mode=outreach&bucket=<drafted|never_opened|ghosted|manual>
//
// Sprint 14C.2 (shipped): Nurture panel — phase + last sent + next queued +
// status pill, inline Pause/Skip/Send Now actions, history modal.
//
// Sprint 14C.3 additions:
//   - Edit individual: pencil on next-queued card opens a modal with subject /
//     body / recipient_email pre-filled (from rendered_* if present, else
//     template default). Save calls nurture_edit_queued RPC.
//   - Send Now ad-hoc: replaces the simple confirm with a template-picker
//     modal listing all is_active=true templates from nurture_templates
//     (RLS allows designer reads). Pre-selects the next queued's template
//     when present. Confirm calls nurture_send_adhoc RPC.
//
// War Room Level A additions:
//   - Role-aware back link: master sees "← All clients", designer sees
//     "← Pipeline" (linking /admin/pipeline.html).
//   - "+ New proposal" header button → /dashboard new tab.
//   - Per-proposal-card controls: Edit button → /editor?id=X new tab,
//     Status dropdown writing client_proposals.status, Mark sent button
//     when sent_at is null, Discount toggle pill flipping
//     proposals.show_signing_discount, inline pencil-rename for project
//     address writing proposals.address.
//   - Engagement panel REPLACES Recent Events: live pulse + total event
//     count, mini timeline of last 8 events with relative timestamps, and
//     a "View full timeline →" expand modal with up to 50 events.
//   - Substitutions panel: count badge of pending proposal_substitutions
//     (status submitted|reviewed) + "Review →" link to
//     /admin/substitutions.html?client_id=X.
//   - Redesigns panel: count badge of pending proposal_redesign_requests
//     (status submitted|reviewed) + "Review →" link to
//     /admin/client-redesigns.html?client_id=X.
//   - Side rail final order: Active Proposals → Engagement → Nurture →
//     Substitutions → Redesigns → Quick Stats → Notes.
//
// Bug fix riding along: loadRecentEvents was selecting created_at/metadata
// from proposal_events, but the actual columns are occurred_at/payload.
// describeEvent's map was also using event types (proposal_view,
// material_swap_submit, sign_intent…) that don't match the check
// constraint. Both fixed against the real schema.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireDesigner, sendMagicLink } from '/js/auth-util.js';
import { getProposalEngagementBulk, formatRelativeTime } from '/js/engagement-utils.js';

const DISCOUNT_WINDOW_MS = 48 * 60 * 60 * 1000;

const ATTACHMENT_BUCKET = 'client-messages';
const MAX_FILE_SIZE = 26214400;
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const SIGNED_URL_TTL = 3600;
const REALTIME_ATTACHMENT_DELAY = 250;

// 14C.2: how long to wait after Send Now before re-polling nurture state.
// The worker is fire-and-forget via pg_net; rows usually transition to
// 'sent' within 1–2s, but a Resend slowdown could take longer.
const SEND_NOW_REFRESH_DELAY = 3500;

const FALLBACK_SUGGESTIONS_REPLY = [
  "Happy to schedule a quick call to walk you through it — what's a good time?",
  "Great question — let me look into that and get back to you shortly.",
  "I can put together a quick comparison if that would help.",
];
const FALLBACK_SUGGESTIONS_OUTREACH = [
  "Hey, just circling back on your project — is now still a good time to chat about next steps?",
  "Wanted to check in and see if any questions have come up since we last connected.",
  "If it'd help, I can hop on a quick 15-min call to walk through the proposal together.",
];

const PHASE_LABELS = {
  pre_consult: 'Pre-consult',
  design_in_progress: 'Design in progress',
  post_review: 'Post-review',
  cooling: 'Cooling',
  dead: 'Dead',
};

// Level A: client_proposals.status check constraint allows these six values.
// Handoff originally listed "cancelled / lost" too, but the DB constraint
// rejects them (would 23514). Widen the constraint first if you want them.
const PROPOSAL_STATUS_OPTIONS = ['draft', 'sent', 'viewed', 'signed', 'in_progress', 'complete'];
const PROPOSAL_STATUS_LABELS = {
  draft:       'Draft',
  sent:        'Sent',
  viewed:      'Viewed',
  signed:      'Signed',
  in_progress: 'In progress',
  complete:    'Complete',
};

// Level A: proposal_substitutions and proposal_redesign_requests both use
// 'submitted' as the initial state and 'reviewed' as designer-acknowledged-
// but-not-yet-actioned. Either qualifies as "pending designer action" for
// the war-room badge. The 'pending' value mentioned in the handoff is not
// in the DB check constraint for either table.
const SUB_PENDING_STATUSES = ['submitted', 'reviewed'];
const REDESIGN_PENDING_STATUSES = ['submitted', 'reviewed'];

// Level A: how many recent events to load for the Engagement panel. The
// inline timeline shows 8; the "View full timeline →" modal shows all of
// these. 50 is enough for any active homeowner short of weeks of intense
// engagement; if a client exceeds it the modal can paginate later.
const ENGAGEMENT_EVENTS_LIMIT = 50;

const _params = new URLSearchParams(window.location.search);
const _outreachMode = _params.get('mode') === 'outreach';
const _validBuckets = ['drafted', 'never_opened', 'ghosted', 'manual'];
const _bucketParam = _params.get('bucket');
const _outreachBucket = _validBuckets.includes(_bucketParam) ? _bucketParam : 'manual';

const ctx = {
  outreachMode: _outreachMode,
  outreachBucket: _outreachBucket,
  lastSuggestionUsed: null,
  viewer: null,
  client: null,
  clientProposals: [],
  engagement: new Map(),
  events: [],
  messages: [],
  attachmentsByMessageId: new Map(),
  signedUrlCache: new Map(),
  queuedFiles: [],
  profileCache: new Map(),
  channel: null,
  suggestions: null,
  suggestionsLoading: false,
  // 14C.2 nurture state
  nurture: null,           // result of nurture_get_war_room_state RPC, or null on fail
  nurtureLoading: true,
  nurtureUi: { showPauseOptions: false },
  // Level A state
  subsCount: 0,            // # of pending proposal_substitutions for this client
  redesignsCount: 0,       // # of pending proposal_redesign_requests for this client
  proposalUi: new Map(),   // proposal_id → { editingAddress: bool, savingStatus: bool, ... }
  // 14C.3 state (lazy)
  activeTemplates: null,   // populated on first picker open
};

// ─── Bootstrap ─────────────────────────────────────────────────────────────
(async function init() {
  const auth = await requireDesigner();
  if (!auth) return;
  ctx.viewer = { ...auth.user, role: auth.profile.role };

  const clientId = _params.get('id');
  if (!clientId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    showFatal('Missing or invalid client ID. Returning to client list…');
    setTimeout(() => { window.location.href = '/admin/clients'; }, 1600);
    return;
  }
  ctx.profileCache.set(ctx.viewer.id, ctx.viewer);

  ensureEditModalStyles();
  ensureAttachmentStyles();
  ensureNurtureStyles();
  ensureLevelAStyles();
  await loadAll(clientId);
  if (!ctx.client) {
    showFatal('Could not load this client. They may not exist, or you may not have access.');
    return;
  }
  // 14C.4: refuse to render the war room for a soft-deleted client.
  // Surface a Restore affordance when the viewer is allowed (master, or
  // designer-as-creator); otherwise show the message and a Back link.
  if (ctx.client.deleted_at) {
    renderDeletedClientScreen();
    return;
  }
  render();
  hydrateSignedUrls(document.getElementById('wrMessages'));
  loadSuggestions();
  subscribeRealtime();
})();

// 14C.4: rendered in place of the war room when ctx.client.deleted_at is set.
// Master + creator-designer get a Restore button; other designers see only
// the message + back link.
function renderDeletedClientScreen() {
  const c = ctx.client;
  const isMaster = ctx.viewer.role === 'master';
  const isCreator = c.created_by === ctx.viewer.id;
  const canRestore = isMaster || isCreator;
  const deletedWhen = formatDate(c.deleted_at);
  const backHref = isMaster ? '/admin/clients' : '/admin/pipeline.html';
  const backLabel = isMaster ? '← All clients' : '← Pipeline';

  document.getElementById('wrCrumbName').textContent = c.name || '(deleted client)';
  document.title = `${c.name || 'Deleted client'} · Admin · Paver Portal Proposal Builder`;

  const restoreBtnHtml = canRestore
    ? `<button type="button" class="wr-action-btn primary" id="wrDeletedRestoreBtn">↺ Restore client</button>`
    : '';

  document.getElementById('wrContent').innerHTML = `
    <div class="wr-card" style="padding: 40px 32px;">
      <a class="wr-back-link" href="${escapeAttr(backHref)}" style="padding: 0 0 12px;">${escapeHtml(backLabel)}</a>
      <div style="text-align: center; padding: 40px 20px;">
        <div style="font-size: 56px; line-height: 1; margin-bottom: 16px;">🗑</div>
        <div style="font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; letter-spacing: 0.18em; color: #b91c1c; text-transform: uppercase; font-weight: 600; margin-bottom: 8px;">
          Deleted client
        </div>
        <h2 style="font-size: 22px; font-weight: 600; margin: 0 0 10px;">
          ${escapeHtml(c.name || '(unnamed client)')} was moved to trash
        </h2>
        <div style="font-size: 14px; color: #666; line-height: 1.55; max-width: 480px; margin: 0 auto 24px;">
          Soft-deleted on ${escapeHtml(deletedWhen)}. The war room is hidden until they're restored. ${canRestore ? 'You can restore them now or view all trashed clients.' : 'Only the creator or a master can restore them.'}
        </div>
        <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
          ${restoreBtnHtml}
          <a class="wr-action-btn" href="/admin/clients">All clients</a>
          ${isMaster ? `<a class="wr-action-btn" href="/admin/clients" id="wrDeletedShowTrashLink">View trash</a>` : ''}
        </div>
      </div>
    </div>
  `;

  // Update shell crumb if present
  const shellBack = document.getElementById('wrCrumbBack');
  if (shellBack) {
    shellBack.setAttribute('href', backHref);
    shellBack.textContent = backLabel;
  }

  if (canRestore) {
    document.getElementById('wrDeletedRestoreBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('wrDeletedRestoreBtn');
      btn.disabled = true;
      btn.textContent = 'Restoring…';
      const { data, error } = await supabase.rpc('restore_client', { p_client_id: c.id });
      if (error || !data || data.ok === false) {
        alert('Could not restore: ' + (error?.message || data?.error || 'unknown error'));
        btn.disabled = false;
        btn.textContent = '↺ Restore client';
        return;
      }
      window.location.reload();
    });
  }
}

async function loadAll(clientId) {
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select(`
      id, name, email, phone, address, notes, user_id, created_at, created_by,
      deleted_at,
      referral_credit_cents, referral_credit_used_cents, refer_code,
      client_proposals (
        id, status, sent_at, first_viewed_at, signed_at, created_at,
        has_used_free_revision, design_retainer_interest_at,
        proposal:proposals!proposal_id (
          id, address, project_address, project_city, owner_user_id,
          show_signing_discount, bid_total_amount,
          published_proposals (id, slug, published_at, is_canonical)
        )
      )
    `)
    .eq('id', clientId)
    .maybeSingle();

  if (clientErr || !client) {
    console.error('[admin-client] load failed:', clientErr);
    return;
  }
  ctx.client = client;
  ctx.clientProposals = client.client_proposals || [];

  // Sprint 14C.8: order proposals so the most recent is index 0. "Most
  // recent" = highest sent_at (null last, since drafts haven't been
  // sent yet), tiebroken by created_at. This drives both:
  //   • the BID VALUE hot stat (uses [0] only, not the sum)
  //   • the Active Proposals stack (first card is "Current", rest are
  //     visually demoted as archive)
  ctx.clientProposals.sort((a, b) => {
    if (a.sent_at && !b.sent_at) return -1;
    if (!a.sent_at && b.sent_at) return 1;
    const aTime = new Date(a.sent_at || a.created_at || 0).getTime();
    const bTime = new Date(b.sent_at || b.created_at || 0).getTime();
    return bTime - aTime;
  });

  const proposalIds = ctx.clientProposals.map(cp => cp.proposal?.id).filter(Boolean);

  await Promise.all([
    loadEngagement(proposalIds),
    loadRecentEvents(proposalIds),
    loadMessages(client.id),
    loadNurture(client.id),
    loadSubstitutionsCount(proposalIds),
    loadRedesignsCount(proposalIds),
  ]);
}

async function loadEngagement(proposalIds) {
  if (proposalIds.length === 0) { ctx.engagement = new Map(); return; }
  ctx.engagement = await getProposalEngagementBulk(proposalIds);
}

async function loadRecentEvents(proposalIds) {
  if (proposalIds.length === 0) { ctx.events = []; return; }
  // Schema fix: proposal_events uses occurred_at + payload, NOT created_at +
  // metadata. Limit bumped from 12 to ENGAGEMENT_EVENTS_LIMIT so the
  // "View full timeline →" modal has data without a second round trip.
  const { data, error } = await supabase
    .from('proposal_events')
    .select('id, proposal_id, event_type, occurred_at, payload')
    .in('proposal_id', proposalIds)
    .order('occurred_at', { ascending: false })
    .limit(ENGAGEMENT_EVENTS_LIMIT);
  if (error) {
    console.error('[admin-client] events load failed:', error);
    ctx.events = [];
    return;
  }
  ctx.events = data || [];
}

// Level A: count pending substitutions across all proposals for this
// client. RLS designer_select_assigned_subs already covers the read for
// designers; master sees all. Uses head:true to avoid pulling rows.
async function loadSubstitutionsCount(proposalIds) {
  if (proposalIds.length === 0) { ctx.subsCount = 0; return; }
  const { count, error } = await supabase
    .from('proposal_substitutions')
    .select('id', { count: 'exact', head: true })
    .in('proposal_id', proposalIds)
    .in('status', SUB_PENDING_STATUSES);
  if (error) {
    console.warn('[admin-client] subs count failed:', error);
    ctx.subsCount = 0;
    return;
  }
  ctx.subsCount = count || 0;
}

// Level A: count pending redesigns across all proposals for this client.
// Designer-or-master RLS handles access.
async function loadRedesignsCount(proposalIds) {
  if (proposalIds.length === 0) { ctx.redesignsCount = 0; return; }
  const { count, error } = await supabase
    .from('proposal_redesign_requests')
    .select('id', { count: 'exact', head: true })
    .in('proposal_id', proposalIds)
    .in('status', REDESIGN_PENDING_STATUSES);
  if (error) {
    console.warn('[admin-client] redesigns count failed:', error);
    ctx.redesignsCount = 0;
    return;
  }
  ctx.redesignsCount = count || 0;
}

// 14C.3: lazy-load all active templates for the Send Now picker. Cached
// on ctx after first call. RLS allows designer SELECT on nurture_templates.
async function loadActiveTemplates() {
  if (ctx.activeTemplates) return ctx.activeTemplates;
  const { data, error } = await supabase
    .from('nurture_templates')
    .select('id, phase, day_offset, subject, project_type_filter')
    .eq('is_active', true)
    .order('phase', { ascending: true })
    .order('day_offset', { ascending: true });
  if (error) {
    console.warn('[admin-client] templates load failed:', error);
    return [];
  }
  ctx.activeTemplates = data || [];
  return ctx.activeTemplates;
}

async function loadMessages(clientId) {
  const { data, error } = await supabase
    .from('client_messages')
    .select('id, sender_user_id, sender_role, body, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[admin-client] messages load failed:', error);
    ctx.messages = [];
    return;
  }
  ctx.messages = data || [];

  const staffSenderIds = [...new Set(
    ctx.messages
      .filter(m => m.sender_role === 'designer' || m.sender_role === 'master')
      .map(m => m.sender_user_id)
      .filter(Boolean)
  )];
  const uncached = staffSenderIds.filter(id => !ctx.profileCache.has(id));
  if (uncached.length > 0) {
    const { data: profs } = await supabase
      .from('profiles')
      .select('id, display_name, email, role')
      .in('id', uncached);
    for (const p of (profs || [])) ctx.profileCache.set(p.id, p);
  }

  await loadAttachments(ctx.messages.map(m => m.id));
}

async function loadAttachments(messageIds) {
  ctx.attachmentsByMessageId = new Map();
  if (!messageIds || messageIds.length === 0) return;
  const { data, error } = await supabase
    .from('client_message_attachments')
    .select('id, message_id, storage_path, file_name, mime_type, size_bytes')
    .in('message_id', messageIds);
  if (error) {
    console.error('[admin-client] attachments load failed:', error);
    return;
  }
  for (const att of (data || [])) {
    if (!ctx.attachmentsByMessageId.has(att.message_id)) {
      ctx.attachmentsByMessageId.set(att.message_id, []);
    }
    ctx.attachmentsByMessageId.get(att.message_id).push(att);
  }
}

// 14C.2: nurture state via SECURITY DEFINER RPC
async function loadNurture(clientId) {
  ctx.nurtureLoading = true;
  const { data, error } = await supabase.rpc('nurture_get_war_room_state', {
    p_client_id: clientId,
  });
  if (error) {
    console.warn('[admin-client] nurture state load failed:', error);
    ctx.nurture = null;
  } else {
    ctx.nurture = data || null;
  }
  ctx.nurtureLoading = false;
}

async function reloadNurture() {
  await loadNurture(ctx.client.id);
  rerenderNurturePanel();
}

function rerenderNurturePanel() {
  const el = document.getElementById('wrNurturePanel');
  if (!el) return;
  el.innerHTML = renderNurturePanelInner();
  wireNurtureHandlers();
}

// Level A: re-render only the proposal-cards list inside Active Proposals.
// Used after status / mark-sent / discount / address writes so we don't
// blow away scroll position or the chat composer focus.
function rerenderProposalCards() {
  const wrap = document.querySelector('[data-wr-proposal-cards]');
  if (!wrap) return;
  wrap.innerHTML = renderProposalCards();
  wireProposalCardHandlers();
}

// Level A: re-render the Substitutions and Redesigns side panels after a
// count refresh. Cheap; called after a re-fetch.
function rerenderSidePanels() {
  const subsEl = document.getElementById('wrSubsPanel');
  if (subsEl) subsEl.innerHTML = renderSubstitutionsPanel();
  const reEl = document.getElementById('wrRedesignsPanel');
  if (reEl) reEl.innerHTML = renderRedesignsPanel();
}

function rerenderEngagementPanel() {
  const el = document.getElementById('wrEngagementPanel');
  if (!el) return;
  el.innerHTML = renderEngagementPanelInner();
  wireEngagementHandlers();
}

// ─── Render ────────────────────────────────────────────────────────────────
function render() {
  document.getElementById('wrCrumbName').textContent = ctx.client.name || '(unnamed)';
  document.title = `${ctx.client.name || 'Client'} · Admin · Paver Portal Proposal Builder`;

  const c = ctx.client;
  const initials = (c.name || '?').split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase();

  const aggEng = aggregateEngagement();
  const totalEvents = aggEng?.totalEvents || 0;
  const isLive = aggEng?.isLive || false;
  const totalDevices = aggEng?.totalDevices || 0;

  // Sprint 14C.8: BID VALUE hot stat now reflects ONLY the most recent
  // proposal (index 0 after the sort above). Previously this summed
  // every proposal, which inflated the headline (a $50K Sent + $62K
  // Draft showed as $112K, even though $112K isn't the price the
  // homeowner sees). Stacked older proposals still appear in the Active
  // Proposals side rail with their own per-card bid lines.
  const currentProposal = ctx.clientProposals[0]?.proposal;
  const currentBid = Number(currentProposal?.bid_total_amount || 0);
  const bidLabel = currentBid > 0 ? formatBidShort(currentBid) : '—';

  const activeDiscount = soonestActiveDiscount();
  const discountLabel = activeDiscount
    ? formatDiscountRemaining(activeDiscount.remainingMs)
    : '—';

  const outreachBannerHtml = ctx.outreachMode ? renderOutreachBanner() : '';

  // Level A: role-aware back link. Master goes back to /admin/clients (the
  // full alphabetical list). Designer goes to /admin/pipeline.html (their
  // active-pipeline view). The shell may already render a breadcrumb back
  // link via <a id="wrCrumbBack"> elsewhere; we update that in place if it
  // exists, otherwise our top-of-card link is the fallback.
  const isMaster = ctx.viewer.role === 'master';
  const backHref = isMaster ? '/admin/clients' : '/admin/pipeline.html';
  const backLabel = isMaster ? '← All clients' : '← Pipeline';

  const mainHtml = `
    <div class="wr-card">
      <a class="wr-back-link" id="wrBackLink" href="${escapeAttr(backHref)}">${escapeHtml(backLabel)}</a>
      ${outreachBannerHtml}
      <div class="wr-header">
        <div class="wr-avatar">${escapeHtml(initials)}</div>
        <div class="wr-header-info">
          <div class="wr-header-name">${escapeHtml(c.name || '(unnamed client)')}</div>
          <div class="wr-header-meta">
            ${c.email ? `<span>📧 <a href="mailto:${escapeAttr(c.email)}">${escapeHtml(c.email)}</a></span>` : ''}
            ${c.phone ? `<span>📞 <a href="tel:${escapeAttr(c.phone)}">${escapeHtml(c.phone)}</a></span>` : ''}
            ${c.address ? `<span>📍 ${escapeHtml(c.address)}</span>` : ''}
          </div>
        </div>
        <div class="wr-header-actions">
          <button class="wr-action-btn" id="wrSendLinkBtn">${c.user_id ? 'Resend login' : 'Send login link'}</button>
          <a class="wr-action-btn primary" id="wrNewProposalBtn" href="/dashboard" target="_blank" rel="noopener">+ New proposal</a>
          <button class="wr-action-btn" id="wrEditBtn">Edit</button>
        </div>
      </div>

      <div class="wr-hot-stats">
        <div class="wr-hot-stat">
          <div class="wr-hot-stat-num ${isLive ? 'live' : ''}">${totalEvents}</div>
          <div class="wr-hot-stat-label">events</div>
        </div>
        <div class="wr-hot-stat">
          <div class="wr-hot-stat-num">${totalDevices || '—'}</div>
          <div class="wr-hot-stat-label">devices</div>
        </div>
        <div class="wr-hot-stat">
          <div class="wr-hot-stat-num">${escapeHtml(bidLabel)}</div>
          <div class="wr-hot-stat-label">bid value</div>
        </div>
        <div class="wr-hot-stat">
          <div class="wr-hot-stat-num discount">${escapeHtml(discountLabel)}</div>
          <div class="wr-hot-stat-label">discount left</div>
        </div>
      </div>

      <div class="wr-body">
        <div class="wr-chat-area">
          ${renderContextStrip(aggEng, activeDiscount)}

          <div class="wr-messages" id="wrMessages">
            ${renderMessages()}
          </div>

          <div class="wr-suggestions" id="wrSuggestionsBox">
            ${renderSuggestions()}
          </div>

          <div class="wr-file-queue" id="wrFileQueue" style="display:none;"></div>

          <div class="wr-composer">
            <button type="button" class="wr-attach-btn" id="wrAttachBtn" title="Attach images or PDFs (25 MB max)">📎</button>
            <input type="file" id="wrFileInput" multiple
              accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
              style="display:none;">
            <textarea id="wrComposer" rows="2"
              placeholder="${ctx.outreachMode ? 'Outreach to' : 'Reply to'} ${escapeHtml(c.name || 'the client')} — Enter to send, Shift+Enter for new line"></textarea>
            <button id="wrSendBtn">Send</button>
          </div>
        </div>

        <aside class="wr-side">
          <div class="wr-side-section">
            <h4>Active Proposals</h4>
            <div data-wr-proposal-cards>${renderProposalCards()}</div>
          </div>
          <div class="wr-side-section">
            <h4>Engagement</h4>
            <div id="wrEngagementPanel">${renderEngagementPanelInner()}</div>
          </div>
          <div class="wr-side-section">
            <h4>Nurture</h4>
            <div class="wr-nurture-panel" id="wrNurturePanel">${renderNurturePanelInner()}</div>
          </div>
          <div class="wr-side-section">
            <h4>Substitutions</h4>
            <div id="wrSubsPanel">${renderSubstitutionsPanel()}</div>
          </div>
          <div class="wr-side-section">
            <h4>Redesigns</h4>
            <div id="wrRedesignsPanel">${renderRedesignsPanel()}</div>
          </div>
          <div class="wr-side-section">
            <h4>Quick Stats</h4>
            ${renderQuickStats()}
          </div>
          <div class="wr-side-section">
            <h4>Notes</h4>
            ${renderNotes()}
          </div>
        </aside>
      </div>
    </div>
  `;

  document.getElementById('wrContent').innerHTML = mainHtml;

  // If the shell renders its own back link (id wrCrumbBack), update it in
  // place to match our role-aware target. Harmless if absent.
  const shellBack = document.getElementById('wrCrumbBack');
  if (shellBack) {
    shellBack.setAttribute('href', backHref);
    shellBack.textContent = backLabel;
  }
  scrollMessagesToBottom();
  wireHandlers();
}

function renderOutreachBanner() {
  const meta = {
    drafted:      { label: 'Drafted, not sent', icon: '📝' },
    never_opened: { label: 'Sent, never opened', icon: '📬' },
    ghosted:      { label: 'Engaged then ghosted', icon: '👻' },
    manual:       { label: 'Manual outreach', icon: '👋' },
  }[ctx.outreachBucket] || { label: 'Outreach', icon: '👋' };

  return `
    <div class="wr-outreach-banner">
      <span class="wr-outreach-icon">${meta.icon}</span>
      <div class="wr-outreach-text">
        <strong>Outreach mode</strong> · ${escapeHtml(meta.label)} — suggested replies are tuned to re-engage this client.
      </div>
      <a class="wr-outreach-back" href="/admin/outreach.html">← Back to outreach</a>
    </div>
  `;
}

function aggregateEngagement() {
  let totalEvents = 0;
  let lastViewMs = 0;
  let isLive = false;
  let totalDevices = 0;
  for (const cp of ctx.clientProposals) {
    const propId = cp.proposal?.id;
    if (!propId) continue;
    const eng = ctx.engagement.get(propId);
    if (!eng) continue;
    totalEvents += eng.totalEvents || 0;
    if (eng.isLive) isLive = true;
    if (eng.lastView) {
      const t = new Date(eng.lastView).getTime();
      if (t > lastViewMs) lastViewMs = t;
    }
    totalDevices += eng.sessions || 0;
  }
  if (totalEvents === 0 && !isLive) return null;
  return { totalEvents, lastViewMs, isLive, totalDevices };
}

function soonestActiveDiscount() {
  let best = null;
  for (const cp of ctx.clientProposals) {
    const p = cp.proposal;
    if (!p || p.show_signing_discount === false) continue;
    const pubs = Array.isArray(p.published_proposals) ? p.published_proposals : [];
    const canonical = pubs.find(pp => pp.is_canonical) || pubs[0];
    if (!canonical || !canonical.published_at) continue;
    const elapsed = Date.now() - new Date(canonical.published_at).getTime();
    const remaining = DISCOUNT_WINDOW_MS - elapsed;
    if (remaining <= 0) continue;
    if (!best || remaining < best.remainingMs) {
      best = { proposalId: p.id, remainingMs: remaining };
    }
  }
  return best;
}

function renderContextStrip(aggEng, activeDiscount) {
  const pills = [];

  if (aggEng?.isLive) {
    pills.push('<span class="wr-context-pill">🔥 Active right now</span>');
  } else if (aggEng?.lastViewMs > 0) {
    const since = formatRelativeTime(new Date(aggEng.lastViewMs).toISOString());
    pills.push(`<span class="wr-context-pill muted">👀 Last seen ${escapeHtml(since)}</span>`);
  }

  const anyUsedFree = ctx.clientProposals.some(cp => cp.has_used_free_revision);
  const anyInterest = ctx.clientProposals.some(cp => cp.design_retainer_interest_at);
  if (anyInterest) {
    pills.push('<span class="wr-context-pill amber">💼 Design Retainer interest</span>');
  } else if (anyUsedFree) {
    pills.push('<span class="wr-context-pill muted">✓ Free revision used</span>');
  } else if (ctx.clientProposals.length > 0) {
    pills.push('<span class="wr-context-pill muted">↻ Free revision available</span>');
  }

  if (activeDiscount) {
    pills.push(`<span class="wr-context-pill amber">🕒 ${escapeHtml(formatDiscountRemaining(activeDiscount.remainingMs))} until 5% expires</span>`);
  }

  if (!ctx.client.user_id) {
    pills.push('<span class="wr-context-pill gray">📨 Login link not yet used</span>');
  }

  if (pills.length === 0) {
    return '<div class="wr-context-strip"><span class="wr-context-pill gray">No active signals yet</span></div>';
  }
  return `<div class="wr-context-strip">${pills.join('')}</div>`;
}

function renderMessages() {
  if (ctx.messages.length === 0) {
    return `
      <div class="wr-empty">
        <div class="wr-empty-icon">💬</div>
        <div class="wr-empty-title">No messages yet</div>
        <div class="wr-empty-sub">Start the conversation with ${escapeHtml(ctx.client.name || 'the client')}.</div>
      </div>
    `;
  }
  return ctx.messages.map(renderOneMessage).join('');
}

function renderOneMessage(message) {
  const isOutbound = message.sender_user_id === ctx.viewer.id;
  const senderName = getSenderName(message);
  const rolePill =
    message.sender_role === 'master'    ? '<span class="wr-msg-pill master">Master</span>'    :
    message.sender_role === 'designer'  ? '<span class="wr-msg-pill designer">Designer</span>' :
                                          '<span class="wr-msg-pill homeowner">Homeowner</span>';
  const time = formatMessageTime(message.created_at);
  const bodyHtml = message.body ? escapeHtml(message.body).replace(/\n/g, '<br>') : '';

  const atts = ctx.attachmentsByMessageId.get(message.id) || [];
  const attsHtml = atts.length > 0 ? renderAttachments(atts) : '';

  return `
    <div class="wr-msg ${isOutbound ? 'wr-msg-out' : 'wr-msg-in'}" data-message-id="${escapeAttr(message.id)}">
      <div class="wr-msg-meta">
        <span class="wr-msg-sender">${escapeHtml(senderName)}</span>
        ${rolePill}
        <span class="wr-msg-time">${escapeHtml(time)}</span>
      </div>
      ${bodyHtml ? `<div class="wr-msg-body">${bodyHtml}</div>` : ''}
      ${attsHtml}
    </div>
  `;
}

function renderAttachments(attachments) {
  const html = attachments.map(att => {
    if (att.mime_type.startsWith('image/')) {
      return `
        <div class="wr-msg-attachment-img"
             data-storage-path="${escapeAttr(att.storage_path)}"
             data-file-name="${escapeAttr(att.file_name)}">
          <div class="wr-msg-attachment-loading">Loading…</div>
        </div>
      `;
    }
    return `
      <div class="wr-msg-attachment-pdf"
           data-storage-path="${escapeAttr(att.storage_path)}"
           data-file-name="${escapeAttr(att.file_name)}">
        <span class="wr-msg-attachment-pdf-icon">📄</span>
        <div class="wr-msg-attachment-pdf-info">
          <div class="wr-msg-attachment-pdf-name">${escapeHtml(att.file_name)}</div>
          <div class="wr-msg-attachment-pdf-meta">${escapeHtml(formatFileSize(att.size_bytes))} · PDF</div>
        </div>
        <a class="wr-msg-attachment-pdf-download" target="_blank" rel="noopener" download="${escapeAttr(att.file_name)}">Open</a>
      </div>
    `;
  }).join('');
  return `<div class="wr-msg-attachments">${html}</div>`;
}

function getSenderName(message) {
  if (message.sender_role === 'homeowner') return ctx.client.name || 'Homeowner';
  const profile = ctx.profileCache.get(message.sender_user_id);
  return profile?.display_name || profile?.email || 'Designer';
}

// ─── Smart-reply suggestions ──────────────────────────────────────────────
function renderSuggestions() {
  const labelText = ctx.outreachMode ? 'Outreach drafts' : 'Suggested replies';
  const headerHtml = `
    <div class="wr-suggestions-label">
      <span>⚡ ${escapeHtml(labelText)}</span>
      <button type="button" class="wr-suggestions-refresh" id="wrSuggestionsRefresh"
        title="Regenerate suggestions" ${ctx.suggestionsLoading ? 'disabled' : ''}>↻</button>
    </div>
  `;

  if (ctx.suggestionsLoading) {
    const subText = ctx.outreachMode ? 'Drafting outreach options…' : 'Reading the conversation…';
    return headerHtml + `
      <div class="wr-suggestions-loading">
        <span class="wr-suggestions-spinner"></span>
        ${escapeHtml(subText)}
      </div>
    `;
  }

  const fallback = ctx.outreachMode ? FALLBACK_SUGGESTIONS_OUTREACH : FALLBACK_SUGGESTIONS_REPLY;
  const list = (ctx.suggestions && ctx.suggestions.length > 0) ? ctx.suggestions : fallback;
  const chips = list.map(text => `
    <button type="button" class="wr-suggestion-chip">${escapeHtml(text)}</button>
  `).join('');

  return headerHtml + chips;
}

async function loadSuggestions() {
  if (ctx.suggestionsLoading) return;
  ctx.suggestionsLoading = true;
  rerenderSuggestions();

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      ctx.suggestions = ctx.outreachMode ? FALLBACK_SUGGESTIONS_OUTREACH : FALLBACK_SUGGESTIONS_REPLY;
      return;
    }

    const resp = await fetch('/api/suggest-replies', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
      },
      body: JSON.stringify({
        client_id: ctx.client.id,
        mode: ctx.outreachMode ? 'outreach' : 'reply',
        bucket: ctx.outreachMode ? ctx.outreachBucket : null,
      }),
    });
    const data = await resp.json().catch(() => ({}));

    if (data?.suggestions && Array.isArray(data.suggestions) && data.suggestions.length >= 3) {
      ctx.suggestions = data.suggestions.slice(0, 3);
    } else {
      ctx.suggestions = ctx.outreachMode ? FALLBACK_SUGGESTIONS_OUTREACH : FALLBACK_SUGGESTIONS_REPLY;
      if (!data?.ok) {
        console.warn('[admin-client] suggest-replies returned non-ok:', data?.error);
      }
    }
  } catch (err) {
    console.warn('[admin-client] suggest-replies fetch failed:', err);
    ctx.suggestions = ctx.outreachMode ? FALLBACK_SUGGESTIONS_OUTREACH : FALLBACK_SUGGESTIONS_REPLY;
  } finally {
    ctx.suggestionsLoading = false;
    rerenderSuggestions();
  }
}

function rerenderSuggestions() {
  const box = document.getElementById('wrSuggestionsBox');
  if (!box) return;
  box.innerHTML = renderSuggestions();
  wireSuggestionHandlers();
}

function wireSuggestionHandlers() {
  const refreshBtn = document.getElementById('wrSuggestionsRefresh');
  refreshBtn?.addEventListener('click', () => {
    if (!ctx.suggestionsLoading) loadSuggestions();
  });

  const box = document.getElementById('wrSuggestionsBox');
  if (!box) return;
  box.querySelectorAll('.wr-suggestion-chip').forEach((chip, idx) => {
    chip.addEventListener('click', () => {
      const composer = document.getElementById('wrComposer');
      if (!composer) return;
      const text = chip.textContent.trim();
      composer.value = text;
      composer.focus();
      composer.setSelectionRange(composer.value.length, composer.value.length);
      ctx.lastSuggestionUsed = { index: idx, text };
    });
  });
}

function renderProposalCards() {
  if (ctx.clientProposals.length === 0) {
    return '<div class="wr-empty-side">No proposals assigned yet.</div>';
  }
  // Sprint 14C.8: index-aware rendering. ctx.clientProposals is already
  // sorted most-recent-first (sent_at desc nulls last, then created_at
  // desc). Index 0 is the "Current" bid; remaining are demoted to
  // "Previous" with reduced visual weight so the eye lands on what's
  // active. We also slot a small "PREVIOUS BIDS" divider before the
  // first archive card when there are 2+ proposals, so the stack reads
  // as a clear hierarchy rather than a flat list.
  return ctx.clientProposals.map((cp, idx) => {
    const p = cp.proposal;
    if (!p) return '';
    const isCurrent = idx === 0;
    const isArchive = !isCurrent;

    const eng = ctx.engagement.get(p.id);
    const slug = getLatestSlug(p);
    const bid = Number(p.bid_total_amount || 0);
    const bidLabel = bid > 0 ? formatBidFull(bid) : '';
    const sentDate = cp.sent_at ? formatDate(cp.sent_at) : null;
    const ui = ctx.proposalUi.get(p.id) || {};
    const editingAddr = !!ui.editingAddress;
    const discountOn = p.show_signing_discount !== false;

    let engLine = '';
    if (eng && eng.totalEvents > 0) {
      const recency = eng.isLive ? 'active right now' : `last ${formatRelativeTime(eng.lastView)}`;
      engLine = `
        <div class="wr-proposal-card-eng">
          ${eng.isLive ? '<span class="wr-pulse-dot"></span>' : ''}
          <span>${eng.totalEvents} events · ${escapeHtml(recency)}</span>
        </div>
      `;
    } else {
      engLine = '<div class="wr-proposal-card-eng" style="color: var(--muted);">Not viewed yet</div>';
    }

    // Address row: display mode shows text + pencil; edit mode shows input + save/cancel
    const displayAddr = getDisplayAddress(p);
    const addrHtml = editingAddr
      ? `
        <div class="wr-paddr-edit">
          <input type="text" class="wr-paddr-input" data-proposal-id="${escapeAttr(p.id)}" value="${escapeAttr(displayAddr)}" placeholder="Project address">
          <button type="button" class="wr-mini-btn primary" data-pcard-action="save-addr" data-proposal-id="${escapeAttr(p.id)}">Save</button>
          <button type="button" class="wr-mini-btn cancel" data-pcard-action="cancel-addr" data-proposal-id="${escapeAttr(p.id)}">Cancel</button>
        </div>
      `
      : `
        <div class="wr-proposal-card-addr">
          <span class="wr-paddr-label">${escapeHtml(displayAddr)}</span>
          <button type="button" class="wr-paddr-pencil" data-pcard-action="edit-addr" data-proposal-id="${escapeAttr(p.id)}" title="Rename project address" aria-label="Rename project address">✏️</button>
        </div>
      `;

    // Status dropdown (writes client_proposals.status)
    const statusOptionsHtml = PROPOSAL_STATUS_OPTIONS.map(s =>
      `<option value="${escapeAttr(s)}" ${s === cp.status ? 'selected' : ''}>${escapeHtml(PROPOSAL_STATUS_LABELS[s])}</option>`
    ).join('');

    // Mark-sent button (only when sent_at is null)
    const markSentHtml = cp.sent_at
      ? ''
      : `<button type="button" class="wr-mini-btn" data-pcard-action="mark-sent" data-cp-id="${escapeAttr(cp.id)}" title="Mark this proposal as sent (sets sent_at = now())">Mark sent</button>`;

    // Discount toggle pill (flips proposals.show_signing_discount)
    const discountTitle = discountOn
      ? 'Signing discount visible. Click to hide. (Republish proposal for change to take effect on the public page.)'
      : 'Signing discount hidden. Click to show. (Republish proposal for change to take effect on the public page.)';
    const discountPillHtml = `
      <button type="button" class="wr-discount-pill ${discountOn ? 'on' : 'off'}" data-pcard-action="toggle-discount" data-proposal-id="${escapeAttr(p.id)}" title="${escapeAttr(discountTitle)}">
        ${discountOn ? '🏷️ Discount on' : '⭕ Discount off'}
      </button>
    `;

    // Sprint 14C.8: "Current bid" eyebrow on the first card; small
    // "PREVIOUS BIDS" divider before the first archive card.
    const eyebrowHtml = isCurrent
      ? `<div class="wr-pcard-eyebrow"><span class="wr-pcard-eyebrow-dot"></span>Current bid</div>`
      : '';
    const dividerHtml = (idx === 1)
      ? `<div class="wr-pcard-divider">Previous bids</div>`
      : '';

    const cardModifier = isCurrent ? 'wr-proposal-card--current' : 'wr-proposal-card--archive';

    return `
      ${dividerHtml}
      <div class="wr-proposal-card ${cardModifier}" data-proposal-id="${escapeAttr(p.id)}">
        ${eyebrowHtml}
        ${addrHtml}
        <div class="wr-proposal-card-meta">
          ${bidLabel ? `${bidLabel}${sentDate ? ' · Sent ' + escapeHtml(sentDate) : ''}` : (sentDate ? 'Sent ' + escapeHtml(sentDate) : 'Draft')}
        </div>
        ${engLine}
        <div class="wr-proposal-card-controls">
          <select class="wr-paddr-status" data-pcard-action="status" data-cp-id="${escapeAttr(cp.id)}" data-proposal-id="${escapeAttr(p.id)}" aria-label="Proposal status">
            ${statusOptionsHtml}
          </select>
          ${markSentHtml}
          ${discountPillHtml}
        </div>
        <div class="wr-proposal-card-actions">
          ${slug ? `<a class="wr-mini-btn" href="/p/${escapeAttr(slug)}" target="_blank" rel="noopener">View</a>` : ''}
          <a class="wr-mini-btn" href="/editor?id=${escapeAttr(p.id)}" target="_blank" rel="noopener" title="Open this proposal in the editor (new tab)">Edit</a>
          <a class="wr-mini-btn" href="/admin/engagement.html?id=${escapeAttr(p.id)}">Engagement →</a>
        </div>
      </div>
    `;
  }).join('');
}

function renderQuickStats() {
  const c = ctx.client;
  const rows = [];
  rows.push(['Login', c.user_id ? 'Logged in' : 'Not yet']);
  rows.push(['Client since', formatDate(c.created_at)]);
  if (c.referral_credit_cents > 0) {
    rows.push(['Referral credit', `$${(c.referral_credit_cents / 100).toFixed(0)} earned`]);
  }
  return rows.map(([label, value]) =>
    `<div class="wr-detail-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`
  ).join('');
}

function renderNotes() {
  const notes = ctx.client.notes || '';
  if (!notes.trim()) {
    return '<div class="wr-empty-side">No notes yet. Click <strong>Edit</strong> to add some.</div>';
  }
  return `<div class="wr-notes-display">${escapeHtml(notes).replace(/\n/g, '<br>')}</div>`;
}

// Level A: Engagement panel replaces "Recent Events". Shows live pulse +
// total event count in the header, mini timeline of last 8 events with
// relative timestamps, and a "View full timeline →" link that opens a
// modal with up to ENGAGEMENT_EVENTS_LIMIT events.
function renderEngagementPanelInner() {
  const aggEng = aggregateEngagement();
  const totalEvents = aggEng?.totalEvents || 0;
  const isLive = aggEng?.isLive || false;
  const lastViewMs = aggEng?.lastViewMs || 0;

  if (totalEvents === 0 && ctx.events.length === 0) {
    return '<div class="wr-empty-side">No proposal activity yet.</div>';
  }

  const recencyHtml = lastViewMs > 0
    ? `<span class="wr-eng-recency">Last ${escapeHtml(formatRelativeTime(new Date(lastViewMs).toISOString()))}</span>`
    : '';

  const headerHtml = `
    <div class="wr-eng-head">
      <div class="wr-eng-count">
        ${isLive ? '<span class="wr-pulse-dot"></span>' : ''}
        <strong>${totalEvents}</strong> event${totalEvents === 1 ? '' : 's'}
        ${isLive ? '<span class="wr-eng-live-tag">live now</span>' : ''}
      </div>
      ${recencyHtml}
    </div>
  `;

  const recent = ctx.events.slice(0, 8);
  let timelineHtml;
  if (recent.length === 0) {
    timelineHtml = '<div class="wr-empty-side" style="padding:6px 0;">Aggregate set, but event log empty.</div>';
  } else {
    timelineHtml = `
      <div class="wr-eng-timeline">
        ${recent.map(e => {
          const time = formatRelativeShort(e.occurred_at);
          const desc = describeEvent(e);
          return `
            <div class="wr-eng-row">
              <span class="wr-eng-time">${escapeHtml(time)}</span>
              <span class="wr-eng-body">${escapeHtml(desc)}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  const expandHtml = ctx.events.length > 8
    ? `<button type="button" class="wr-eng-expand" id="wrEngExpandBtn">View full timeline →</button>`
    : '';

  return headerHtml + timelineHtml + expandHtml;
}

// Level A: Substitutions side panel. Shows pending count + Review link to
// the standalone designer page where actual swap acceptance happens.
function renderSubstitutionsPanel() {
  const count = ctx.subsCount || 0;
  const reviewHref = `/admin/substitutions.html?client_id=${escapeAttr(ctx.client.id)}`;
  if (count === 0) {
    return `
      <div class="wr-side-row">
        <span class="wr-side-row-label">No pending substitutions.</span>
        <a class="wr-side-mini-link" href="${reviewHref}">View all →</a>
      </div>
    `;
  }
  return `
    <div class="wr-side-row">
      <span class="wr-side-badge amber">${count} pending</span>
      <a class="wr-side-mini-link primary" href="${reviewHref}">Review →</a>
    </div>
  `;
}

// Level A: Redesigns side panel. Mirrors the Substitutions panel layout.
function renderRedesignsPanel() {
  const count = ctx.redesignsCount || 0;
  const reviewHref = `/admin/client-redesigns.html?client_id=${escapeAttr(ctx.client.id)}`;
  if (count === 0) {
    return `
      <div class="wr-side-row">
        <span class="wr-side-row-label">No pending redesigns.</span>
        <a class="wr-side-mini-link" href="${reviewHref}">View all →</a>
      </div>
    `;
  }
  return `
    <div class="wr-side-row">
      <span class="wr-side-badge amber">${count} pending</span>
      <a class="wr-side-mini-link primary" href="${reviewHref}">Review →</a>
    </div>
  `;
}

// Level A bug fix: the previous map used event types (proposal_view,
// material_swap_submit, sign_intent…) that don't appear in the
// proposal_events.event_type CHECK constraint. The constraint allows:
//   page_view / section_view / bid_section_click / swap_modal_open /
//   swap_save / referral_share_click / sign_in_cta_click /
//   quality_tab_click / accept_proposal_click
// Updated to match the real values so events render readable copy.
function describeEvent(e) {
  const proposal = ctx.clientProposals.find(cp => cp.proposal?.id === e.proposal_id)?.proposal;
  const addr = proposal ? getDisplayAddress(proposal) : 'a proposal';
  const map = {
    page_view:            `Viewed ${addr}`,
    section_view:         `Browsed scope on ${addr}`,
    bid_section_click:    `Clicked into bid section on ${addr}`,
    swap_modal_open:      `Opened material swap on ${addr}`,
    swap_save:            `Saved a material swap on ${addr}`,
    referral_share_click: `Tapped referral share on ${addr}`,
    sign_in_cta_click:    `Tapped Sign-in CTA on ${addr}`,
    quality_tab_click:    `Opened Quality tab on ${addr}`,
    accept_proposal_click:`Tapped Accept Proposal on ${addr} 🎉`,
  };
  return map[e.event_type] || `Event: ${e.event_type}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 14C.2 Nurture panel — render + actions + history modal
// ═══════════════════════════════════════════════════════════════════════════

function renderNurturePanelInner() {
  if (ctx.nurtureLoading) {
    return '<div class="wr-empty-side">Loading nurture state…</div>';
  }
  const n = ctx.nurture;
  if (!n) {
    return '<div class="wr-empty-side">Could not load nurture state.</div>';
  }

  const isOptedOut = !!n.opted_out_at;
  const isPaused = n.paused_until && new Date(n.paused_until) > new Date();
  const isEnrolled = !!n.phase;

  // Status pill
  let statusPill;
  if (isOptedOut)      statusPill = '<span class="wr-nur-pill optout">Opted out</span>';
  else if (isPaused)   statusPill = '<span class="wr-nur-pill paused">Paused</span>';
  else if (isEnrolled) statusPill = '<span class="wr-nur-pill active">Active</span>';
  else                 statusPill = '<span class="wr-nur-pill gray">Not enrolled</span>';

  // Body
  let bodyHtml = '';
  if (isOptedOut) {
    const since = formatRelativeShort(n.opted_out_at);
    bodyHtml = `
      <div class="wr-nur-state">
        <div class="wr-nur-row"><span>Opted out</span><span>${escapeHtml(since)} ago</span></div>
        <div class="wr-nur-note">No further nurture emails will fire automatically. Master can clear via SQL if a homeowner reverses course.</div>
      </div>
    `;
  } else if (!isEnrolled) {
    bodyHtml = `<div class="wr-empty-side">Not in the nurture sequence yet. Add via <a href="/admin/nurture-clients.html">Nurture clients</a>.</div>`;
  } else {
    const phaseLabel = PHASE_LABELS[n.phase] || n.phase;
    const daysIn = n.phase_entered_at ? daysSince(n.phase_entered_at) : null;
    const phaseLine = daysIn !== null
      ? `${escapeHtml(phaseLabel)} (${daysIn} day${daysIn === 1 ? '' : 's'})`
      : escapeHtml(phaseLabel);

    const pauseLine = isPaused
      ? `<div class="wr-nur-row paused-row"><span>Paused until</span><span>${escapeHtml(formatDate(n.paused_until))}</span></div>`
      : '';

    const lastSentHtml = renderLastSentBlock(n.last_sent);
    const nextQueuedHtml = renderNextQueuedBlock(n.next_queued);

    bodyHtml = `
      <div class="wr-nur-state">
        <div class="wr-nur-row"><span>Phase</span><span>${phaseLine}</span></div>
        ${pauseLine}
      </div>
      ${lastSentHtml}
      ${nextQueuedHtml}
    `;
  }

  // Action buttons
  let actionsHtml = '';
  if (!isOptedOut && isEnrolled) {
    actionsHtml = ctx.nurtureUi.showPauseOptions
      ? renderPauseOptions(isPaused)
      : renderNurtureActionButtons(isPaused, n.next_queued);
  }

  // History link (always available if any rows ever existed for this client —
  // we don't know without a separate count, so just always show it; the modal
  // will show "no history" if empty)
  const historyHtml = `
    <button type="button" class="wr-nur-history-link" id="wrNurHistoryBtn">View nurture history →</button>
  `;

  return `
    <div class="wr-nur-head">
      <span class="wr-nur-title">Sequence</span>
      ${statusPill}
    </div>
    ${bodyHtml}
    ${actionsHtml}
    ${historyHtml}
  `;
}

function renderLastSentBlock(lastSent) {
  if (!lastSent) {
    return `<div class="wr-nur-card-empty">No emails sent yet.</div>`;
  }
  const subject = lastSent.rendered_subject || lastSent.template_subject || '(no subject)';
  const when = lastSent.sent_at
    ? `${formatRelativeShort(lastSent.sent_at)} ago`
    : '—';
  return `
    <div class="wr-nur-card">
      <div class="wr-nur-card-label">✓ Last sent · ${escapeHtml(when)}</div>
      <div class="wr-nur-card-subject">${escapeHtml(subject)}</div>
    </div>
  `;
}

function renderNextQueuedBlock(nextQueued) {
  if (!nextQueued) {
    return `<div class="wr-nur-card-empty">No upcoming sends queued.</div>`;
  }
  const subject = nextQueued.template_subject || '(no subject)';
  // The cron fires at 23:00 UTC (queue) + 23:05 UTC (send). For simplicity,
  // describe next send as "next 4pm PT cron run" — exact timezone math gets
  // messy across DST and isn't worth the precision.
  // 14C.3: Edit pencil opens a modal with subject/body/recipient_email
  // pre-filled from rendered_* (if previously edited) or template defaults.
  return `
    <div class="wr-nur-card queued">
      <div class="wr-nur-card-head">
        <div class="wr-nur-card-label">⏱ Next · 4pm PT cron run</div>
        <button type="button" class="wr-nur-edit-btn" data-nur-action="edit-queued" title="Edit subject, body, or recipient before this sends">✏️ Edit</button>
      </div>
      <div class="wr-nur-card-subject">${escapeHtml(subject)}</div>
    </div>
  `;
}

function renderNurtureActionButtons(isPaused, nextQueued) {
  const hasQueued = !!nextQueued;
  const pauseLabel = isPaused ? 'Unpause' : 'Pause ▾';
  const pauseAction = isPaused ? 'unpause' : 'open-pause';

  return `
    <div class="wr-nur-actions">
      <button type="button" class="wr-mini-btn" data-nur-action="${pauseAction}">${escapeHtml(pauseLabel)}</button>
      <button type="button" class="wr-mini-btn" data-nur-action="skip" ${hasQueued ? '' : 'disabled'} title="${hasQueued ? 'Skip the next queued email' : 'Nothing queued to skip'}">Skip next</button>
      <button type="button" class="wr-mini-btn primary" data-nur-action="send-now" ${hasQueued ? '' : 'disabled'} title="${hasQueued ? 'Send the next queued email now (test mode redirects apply)' : 'Nothing queued to send'}">Send now</button>
    </div>
  `;
}

function renderPauseOptions(isPaused) {
  // Shown when designer has clicked "Pause" — replaces the main action row.
  return `
    <div class="wr-nur-pause-options">
      <button type="button" class="wr-mini-btn" data-nur-action="pause-1w">1 week</button>
      <button type="button" class="wr-mini-btn" data-nur-action="pause-1m">1 month</button>
      <button type="button" class="wr-mini-btn" data-nur-action="pause-indef">Indefinitely</button>
      <button type="button" class="wr-mini-btn cancel" data-nur-action="pause-cancel">Cancel</button>
    </div>
  `;
}

function wireNurtureHandlers() {
  document.querySelectorAll('[data-nur-action]').forEach(btn => {
    btn.addEventListener('click', onNurtureActionClick);
  });
  const histBtn = document.getElementById('wrNurHistoryBtn');
  histBtn?.addEventListener('click', openHistoryModal);
}

async function onNurtureActionClick(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.nurAction;

  switch (action) {
    case 'open-pause':
      ctx.nurtureUi.showPauseOptions = true;
      rerenderNurturePanel();
      return;
    case 'pause-cancel':
      ctx.nurtureUi.showPauseOptions = false;
      rerenderNurturePanel();
      return;
    case 'pause-1w':
      await applyPause(daysFromNow(7));
      return;
    case 'pause-1m':
      await applyPause(daysFromNow(30));
      return;
    case 'pause-indef':
      await applyPause(daysFromNow(365 * 10));
      return;
    case 'unpause':
      await applyPause(null);
      return;
    case 'skip':
      await applySkip();
      return;
    case 'send-now':
      // 14C.3: open the template picker instead of the simple confirm.
      // Pre-selects the next-queued template if one is queued.
      await openSendNowPickerModal();
      return;
    case 'edit-queued':
      // 14C.3: open the edit-individual modal for the next queued send.
      await openEditQueuedModal();
      return;
  }
}

async function applyPause(untilDate) {
  const isoOrNull = untilDate instanceof Date ? untilDate.toISOString() : null;
  const { data, error } = await supabase.rpc('nurture_pause_client', {
    p_client_id: ctx.client.id,
    p_until: isoOrNull,
  });
  if (error) {
    alert('Could not update pause: ' + error.message);
    return;
  }
  ctx.nurtureUi.showPauseOptions = false;
  await reloadNurture();
}

async function applySkip() {
  const subject = ctx.nurture?.next_queued?.template_subject || 'the next queued email';
  if (!confirm(`Skip "${subject}"?\n\nIt will be marked as skipped and won't send. The sequence continues normally on the next match.`)) {
    return;
  }
  const { data, error } = await supabase.rpc('nurture_skip_next', {
    p_client_id: ctx.client.id,
  });
  if (error) {
    alert('Could not skip: ' + error.message);
    return;
  }
  if (data && data.skipped === false) {
    alert('Nothing queued to skip — the panel may be stale. Refreshing.');
  }
  await reloadNurture();
}

// 14C.3: replaces the simple "are you sure?" send-now confirm with a
// template-picker modal, then calls nurture_send_adhoc(client_id,
// template_id) on confirm. The picker pre-selects the next queued
// template if one is queued; otherwise no default selection.
async function applySendAdhoc(templateId) {
  if (!templateId) return;

  // Find the picker confirm button to optimistically disable it.
  const confirmBtn = _sendNowPickerOverlay?.querySelector('#wrSnpConfirm');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Sending…';
  }

  const { data, error } = await supabase.rpc('nurture_send_adhoc', {
    p_client_id: ctx.client.id,
    p_template_id: templateId,
  });
  if (error) {
    alert('Could not send: ' + error.message);
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Send now';
    }
    return;
  }
  if (data && data.sent === false) {
    alert('Could not send: ' + (data.reason || 'unknown reason'));
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Send now';
    }
    return;
  }

  closeSendNowPickerModal();

  // Worker is async (pg_net + Resend ~1–2s). Wait, then reload so the row
  // transitions from queued to sent.
  setTimeout(() => { reloadNurture(); }, SEND_NOW_REFRESH_DELAY);
}

// ─── 14C.3 Send Now picker modal ──────────────────────────────────────────
let _sendNowPickerOverlay = null;

async function openSendNowPickerModal() {
  if (!_sendNowPickerOverlay) _sendNowPickerOverlay = buildSendNowPickerModal();
  const listEl = _sendNowPickerOverlay.querySelector('#wrSnpList');
  const confirmBtn = _sendNowPickerOverlay.querySelector('#wrSnpConfirm');
  listEl.innerHTML = '<div class="wr-empty-side" style="padding:30px 0;">Loading templates…</div>';
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Send now';
  _sendNowPickerOverlay.style.display = 'flex';

  const templates = await loadActiveTemplates();
  if (!templates || templates.length === 0) {
    listEl.innerHTML = '<div class="wr-empty-side" style="padding:30px 0;">No active templates. Activate one in <a href="/admin/nurture-templates.html">Nurture templates</a> first.</div>';
    return;
  }

  const preselected = ctx.nurture?.next_queued?.template_id || null;
  listEl.innerHTML = templates.map(t => {
    const phase = PHASE_LABELS[t.phase] || t.phase;
    const filterLabel = t.project_type_filter ? ` · ${escapeHtml(t.project_type_filter)} only` : '';
    const isSelected = t.id === preselected;
    return `
      <label class="wr-snp-row ${isSelected ? 'selected' : ''}">
        <input type="radio" name="wrSnpTpl" value="${escapeAttr(t.id)}" ${isSelected ? 'checked' : ''}>
        <div class="wr-snp-row-info">
          <div class="wr-snp-row-subject">${escapeHtml(t.subject || '(no subject)')}</div>
          <div class="wr-snp-row-meta">${escapeHtml(phase)} · day ${t.day_offset}${filterLabel}</div>
        </div>
      </label>
    `;
  }).join('');

  confirmBtn.disabled = !preselected;

  listEl.querySelectorAll('input[name="wrSnpTpl"]').forEach(input => {
    input.addEventListener('change', () => {
      // visual selected state
      listEl.querySelectorAll('.wr-snp-row').forEach(r => r.classList.remove('selected'));
      input.closest('.wr-snp-row')?.classList.add('selected');
      confirmBtn.disabled = false;
    });
  });
}

function buildSendNowPickerModal() {
  const overlay = document.createElement('div');
  overlay.className = 'wr-snp-overlay';
  overlay.innerHTML = `
    <div class="wr-snp-modal" role="dialog" aria-modal="true" aria-labelledby="wrSnpTitle">
      <button type="button" class="wr-snp-close" aria-label="Close">×</button>
      <div class="wr-snp-head">
        <div class="wr-snp-eyebrow">Send now</div>
        <h2 id="wrSnpTitle" class="wr-snp-title">Pick a template to send to ${escapeHtml(ctx.client?.name || 'this client')}</h2>
        <div class="wr-snp-sub">Bypasses the 4pm cron. Test mode redirects still apply if test mode is ON.</div>
      </div>
      <div class="wr-snp-body" id="wrSnpList"></div>
      <div class="wr-snp-foot">
        <button type="button" class="wrace-btn wrace-cancel" id="wrSnpCancel">Cancel</button>
        <button type="button" class="wrace-btn wrace-save" id="wrSnpConfirm" disabled>Send now</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSendNowPickerModal(); });
  overlay.querySelector('.wr-snp-close').addEventListener('click', closeSendNowPickerModal);
  overlay.querySelector('#wrSnpCancel').addEventListener('click', closeSendNowPickerModal);
  overlay.querySelector('#wrSnpConfirm').addEventListener('click', () => {
    const checked = overlay.querySelector('input[name="wrSnpTpl"]:checked');
    if (!checked) return;
    applySendAdhoc(checked.value);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _sendNowPickerOverlay && _sendNowPickerOverlay.style.display !== 'none') {
      closeSendNowPickerModal();
    }
  });
  return overlay;
}

function closeSendNowPickerModal() {
  if (_sendNowPickerOverlay) _sendNowPickerOverlay.style.display = 'none';
}

// ─── 14C.3 Edit queued send modal ─────────────────────────────────────────
let _editQueuedOverlay = null;
let _editQueuedRowId = null;

async function openEditQueuedModal() {
  // Fetch the next queued row plus its template (for fallback subject/body).
  const { data: row, error } = await supabase
    .from('nurture_sends')
    .select('id, template_id, rendered_subject, rendered_body, recipient_override_email, scheduled_for, nurture_templates(subject, body_md)')
    .eq('client_id', ctx.client.id)
    .eq('status', 'would_send')
    .order('scheduled_for', { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    alert('Could not load queued send: ' + error.message);
    return;
  }
  if (!row) {
    alert('No queued email to edit.');
    return;
  }

  if (!_editQueuedOverlay) _editQueuedOverlay = buildEditQueuedModal();

  const tmpl = row.nurture_templates || {};
  const initialSubject = row.rendered_subject ?? tmpl.subject ?? '';
  const initialBody    = row.rendered_body    ?? tmpl.body_md ?? '';
  const initialEmail   = row.recipient_override_email ?? ctx.client.email ?? '';

  _editQueuedRowId = row.id;
  _editQueuedOverlay.querySelector('#wrEqSubject').value = initialSubject;
  _editQueuedOverlay.querySelector('#wrEqBody').value    = initialBody;
  _editQueuedOverlay.querySelector('#wrEqEmail').value   = initialEmail;

  const err = _editQueuedOverlay.querySelector('#wrEqErr');
  err.classList.add('hidden');
  err.textContent = '';

  const saveBtn = _editQueuedOverlay.querySelector('#wrEqSave');
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save edits';

  _editQueuedOverlay.style.display = 'flex';
  setTimeout(() => _editQueuedOverlay.querySelector('#wrEqSubject').focus(), 50);
}

function buildEditQueuedModal() {
  const overlay = document.createElement('div');
  overlay.className = 'wr-eq-overlay';
  overlay.innerHTML = `
    <div class="wr-eq-modal" role="dialog" aria-modal="true" aria-labelledby="wrEqTitle">
      <button type="button" class="wr-eq-close" aria-label="Close">×</button>
      <div class="wr-eq-head">
        <div class="wr-eq-eyebrow">Edit queued nurture email</div>
        <h2 id="wrEqTitle" class="wr-eq-title">Override before next send</h2>
        <div class="wr-eq-sub">Saves to nurture_sends.rendered_subject / rendered_body / recipient_override_email. Worker will use these verbatim instead of the template.</div>
      </div>
      <div class="wr-eq-body">
        <div class="wr-eq-error hidden" id="wrEqErr"></div>
        <div class="wr-eq-field">
          <label>Subject</label>
          <input type="text" id="wrEqSubject" autocomplete="off">
        </div>
        <div class="wr-eq-field">
          <label>Recipient email <span style="text-transform:none; font-weight:400; color:#aaa;">(blank = use the client's email)</span></label>
          <input type="email" id="wrEqEmail" autocomplete="off">
        </div>
        <div class="wr-eq-field">
          <label>Body (markdown)</label>
          <textarea id="wrEqBody" rows="14" autocomplete="off"></textarea>
        </div>
      </div>
      <div class="wr-eq-foot">
        <button type="button" class="wrace-btn wrace-cancel" id="wrEqCancel">Cancel</button>
        <button type="button" class="wrace-btn wrace-save" id="wrEqSave">Save edits</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEditQueuedModal(); });
  overlay.querySelector('.wr-eq-close').addEventListener('click', closeEditQueuedModal);
  overlay.querySelector('#wrEqCancel').addEventListener('click', closeEditQueuedModal);
  overlay.querySelector('#wrEqSave').addEventListener('click', submitEditQueued);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _editQueuedOverlay && _editQueuedOverlay.style.display !== 'none') {
      closeEditQueuedModal();
    }
  });
  return overlay;
}

function closeEditQueuedModal() {
  if (_editQueuedOverlay) _editQueuedOverlay.style.display = 'none';
  _editQueuedRowId = null;
}

async function submitEditQueued() {
  if (!_editQueuedRowId) return;
  const subject = _editQueuedOverlay.querySelector('#wrEqSubject').value.trim();
  const body    = _editQueuedOverlay.querySelector('#wrEqBody').value;
  const email   = _editQueuedOverlay.querySelector('#wrEqEmail').value.trim();
  const err     = _editQueuedOverlay.querySelector('#wrEqErr');
  err.classList.add('hidden');

  if (!subject) {
    err.textContent = 'Subject is required.';
    err.classList.remove('hidden');
    return;
  }
  if (email && !email.includes('@')) {
    err.textContent = 'Recipient email looks invalid.';
    err.classList.remove('hidden');
    return;
  }

  const saveBtn = _editQueuedOverlay.querySelector('#wrEqSave');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase.rpc('nurture_edit_queued', {
    p_send_id: _editQueuedRowId,
    p_subject: subject,
    p_body: body,
    p_recipient_email: email || null,
  });

  if (error) {
    err.textContent = 'Could not save: ' + error.message;
    err.classList.remove('hidden');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save edits';
    return;
  }

  closeEditQueuedModal();
  await reloadNurture();
}

// ─── Engagement full-log modal ────────────────────────────────────────────
let _engagementLogOverlay = null;

function openEngagementFullLogModal() {
  if (!_engagementLogOverlay) _engagementLogOverlay = buildEngagementLogModal();
  const list = _engagementLogOverlay.querySelector('#wrEngLogList');
  if (ctx.events.length === 0) {
    list.innerHTML = '<div class="wr-empty-side" style="padding:30px 0;">No events logged yet.</div>';
  } else {
    list.innerHTML = ctx.events.map(e => {
      const time = formatRelativeShort(e.occurred_at);
      const date = formatDate(e.occurred_at);
      const desc = describeEvent(e);
      return `
        <div class="wr-eng-log-row">
          <div class="wr-eng-log-time">
            <span class="wr-eng-log-rel">${escapeHtml(time)}</span>
            <span class="wr-eng-log-abs">${escapeHtml(date)}</span>
          </div>
          <span class="wr-eng-log-body">${escapeHtml(desc)}</span>
        </div>
      `;
    }).join('');
  }
  _engagementLogOverlay.style.display = 'flex';
}

function buildEngagementLogModal() {
  const overlay = document.createElement('div');
  overlay.className = 'wr-eng-log-overlay';
  overlay.innerHTML = `
    <div class="wr-eng-log-modal" role="dialog" aria-modal="true">
      <button type="button" class="wr-eng-log-close" aria-label="Close">×</button>
      <div class="wr-eng-log-head">
        <div class="wr-eng-log-eyebrow">Engagement timeline</div>
        <h2 class="wr-eng-log-title">All events for ${escapeHtml(ctx.client?.name || 'this client')}</h2>
        <div class="wr-eng-log-sub">Showing the most recent ${ENGAGEMENT_EVENTS_LIMIT} proposal_events across all assigned proposals.</div>
      </div>
      <div class="wr-eng-log-body" id="wrEngLogList"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { overlay.style.display = 'none'; };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.wr-eng-log-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') close();
  });
  return overlay;
}

function wireEngagementHandlers() {
  const expandBtn = document.getElementById('wrEngExpandBtn');
  expandBtn?.addEventListener('click', openEngagementFullLogModal);
}

// ─── Proposal-card handlers (Level A) ─────────────────────────────────────
function wireProposalCardHandlers() {
  document.querySelectorAll('[data-pcard-action]').forEach(el => {
    const action = el.dataset.pcardAction;
    if (action === 'status') {
      el.addEventListener('change', onProposalStatusChange);
    } else {
      el.addEventListener('click', onProposalCardClick);
    }
  });
  // Enter-to-save on the address input
  document.querySelectorAll('.wr-paddr-input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const proposalId = input.dataset.proposalId;
        savePoposalAddress(proposalId, input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const proposalId = input.dataset.proposalId;
        cancelProposalAddressEdit(proposalId);
      }
    });
    setTimeout(() => input.focus(), 30);
  });
}

async function onProposalCardClick(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.pcardAction;
  const proposalId = btn.dataset.proposalId;
  const cpId = btn.dataset.cpId;

  switch (action) {
    case 'edit-addr':
      setProposalUi(proposalId, { editingAddress: true });
      rerenderProposalCards();
      return;
    case 'cancel-addr':
      cancelProposalAddressEdit(proposalId);
      return;
    case 'save-addr': {
      const input = document.querySelector(`.wr-paddr-input[data-proposal-id="${CSS.escape(proposalId)}"]`);
      if (!input) return;
      await savePoposalAddress(proposalId, input.value);
      return;
    }
    case 'mark-sent':
      await markProposalSent(cpId);
      return;
    case 'toggle-discount':
      await toggleProposalDiscount(proposalId);
      return;
  }
}

async function onProposalStatusChange(e) {
  const sel = e.currentTarget;
  const cpId = sel.dataset.cpId;
  const newStatus = sel.value;
  if (!cpId || !newStatus) return;

  sel.disabled = true;
  const { error } = await supabase
    .from('client_proposals')
    .update({ status: newStatus })
    .eq('id', cpId);
  sel.disabled = false;

  if (error) {
    alert('Could not update status: ' + error.message);
    // Revert local select to whatever the cp.status was
    const cp = ctx.clientProposals.find(x => x.id === cpId);
    if (cp) sel.value = cp.status;
    return;
  }
  // Update local state so subsequent re-renders are correct
  const cp = ctx.clientProposals.find(x => x.id === cpId);
  if (cp) cp.status = newStatus;
}

async function markProposalSent(cpId) {
  if (!cpId) return;
  const cp = ctx.clientProposals.find(x => x.id === cpId);
  if (!cp) return;
  if (cp.sent_at) return; // already sent — button shouldn't have rendered
  const nowIso = new Date().toISOString();
  // If status is still draft, also bump it to sent (matches the natural flow)
  const updates = { sent_at: nowIso };
  if (cp.status === 'draft') updates.status = 'sent';

  const { error } = await supabase
    .from('client_proposals')
    .update(updates)
    .eq('id', cpId);
  if (error) {
    alert('Could not mark as sent: ' + error.message);
    return;
  }
  cp.sent_at = nowIso;
  if (updates.status) cp.status = updates.status;
  rerenderProposalCards();
}

async function toggleProposalDiscount(proposalId) {
  if (!proposalId) return;
  const cp = ctx.clientProposals.find(x => x.proposal?.id === proposalId);
  const p = cp?.proposal;
  if (!p) return;
  const next = !(p.show_signing_discount !== false); // flip with NULL-treated-as-true semantics
  const { error } = await supabase
    .from('proposals')
    .update({ show_signing_discount: next })
    .eq('id', proposalId);
  if (error) {
    alert('Could not toggle discount: ' + error.message);
    return;
  }
  p.show_signing_discount = next;
  rerenderProposalCards();
  // Discount-left hot stat may change; re-render the whole shell so the
  // top stat row stays in sync. Cheap; preserves chat scroll because we
  // don't touch the messages container content.
  render();
  hydrateSignedUrls(document.getElementById('wrMessages'));
}

async function savePoposalAddress(proposalId, value) {
  if (!proposalId) return;
  const trimmed = (value || '').trim();
  if (!trimmed) {
    alert('Address cannot be empty.');
    return;
  }
  const { error } = await supabase
    .from('proposals')
    .update({ address: trimmed })
    .eq('id', proposalId);
  if (error) {
    alert('Could not save address: ' + error.message);
    return;
  }
  const cp = ctx.clientProposals.find(x => x.proposal?.id === proposalId);
  if (cp?.proposal) cp.proposal.address = trimmed;
  setProposalUi(proposalId, { editingAddress: false });
  rerenderProposalCards();
}

function cancelProposalAddressEdit(proposalId) {
  setProposalUi(proposalId, { editingAddress: false });
  rerenderProposalCards();
}

function setProposalUi(proposalId, patch) {
  const prev = ctx.proposalUi.get(proposalId) || {};
  ctx.proposalUi.set(proposalId, { ...prev, ...patch });
}

// Legacy applySendNow retained as no-op so any external callers don't error.
// All UI paths now route through applySendAdhoc via openSendNowPickerModal.
async function applySendNow() {
  await openSendNowPickerModal();
}

// ─── History modal ───────────────────────────────────────────────────────
let _nurHistoryOverlay = null;

async function openHistoryModal() {
  if (!_nurHistoryOverlay) _nurHistoryOverlay = buildHistoryModal();
  _nurHistoryOverlay.querySelector('#wrNurHistList').innerHTML =
    '<div class="wr-empty-side" style="padding:30px 0;">Loading…</div>';
  _nurHistoryOverlay.style.display = 'flex';

  const { data, error } = await supabase.rpc('nurture_get_history', {
    p_client_id: ctx.client.id,
    p_limit: 100,
  });
  const listEl = _nurHistoryOverlay.querySelector('#wrNurHistList');

  if (error) {
    listEl.innerHTML = `<div class="wr-empty-side" style="padding:30px 0;color:var(--danger);">Could not load history: ${escapeHtml(error.message)}</div>`;
    return;
  }
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) {
    listEl.innerHTML = '<div class="wr-empty-side" style="padding:30px 0;">No nurture activity yet.</div>';
    return;
  }
  listEl.innerHTML = rows.map(renderHistoryRow).join('');

  // Wire body-toggle for sent rows with rendered_body
  listEl.querySelectorAll('[data-nur-toggle-body]').forEach(btn => {
    btn.addEventListener('click', () => {
      const rowEl = btn.closest('.wr-nur-hist-row');
      const bodyEl = rowEl.querySelector('.wr-nur-hist-body');
      if (!bodyEl) return;
      const open = bodyEl.style.display === 'block';
      bodyEl.style.display = open ? 'none' : 'block';
      btn.textContent = open ? 'Show body ▾' : 'Hide body ▴';
    });
  });
}

function renderHistoryRow(r) {
  const subject = r.rendered_subject || r.template_subject || '(no subject)';
  const phaseLabel = PHASE_LABELS[r.phase] || r.phase || 'unknown';
  const dateIso = r.sent_at || r.created_at;
  const dateLabel = dateIso ? formatDate(dateIso) : '—';
  const phaseDay = `${escapeHtml(phaseLabel)} · day ${r.day_offset}`;

  let pillClass = 'gray';
  let pillLabel = r.status;
  if (r.status === 'sent')         { pillClass = 'sent';    pillLabel = '✓ Sent'; }
  else if (r.status === 'skipped') { pillClass = 'skipped'; pillLabel = '⏭ Skipped'; }
  else if (r.status === 'failed')  { pillClass = 'failed';  pillLabel = '⚠ Failed'; }
  else if (r.status === 'bounced') { pillClass = 'failed';  pillLabel = '↩ Bounced'; }
  else if (r.status === 'would_send') { pillClass = 'queued'; pillLabel = '⏱ Queued'; }

  let extraHtml = '';
  if (r.skip_reason) {
    extraHtml += `<div class="wr-nur-hist-extra">Reason: ${escapeHtml(r.skip_reason)}</div>`;
  }
  if (r.error_message) {
    extraHtml += `<div class="wr-nur-hist-extra error">Error: ${escapeHtml(r.error_message)}</div>`;
  }

  let bodyToggleHtml = '';
  let bodyHtml = '';
  if (r.status === 'sent' && r.rendered_body) {
    bodyToggleHtml = `<button type="button" class="wr-nur-hist-body-btn" data-nur-toggle-body>Show body ▾</button>`;
    bodyHtml = `<div class="wr-nur-hist-body">${escapeHtml(r.rendered_body).replace(/\n/g, '<br>')}</div>`;
  }

  return `
    <div class="wr-nur-hist-row">
      <div class="wr-nur-hist-meta">
        <span class="wr-nur-hist-pill ${pillClass}">${escapeHtml(pillLabel)}</span>
        <span class="wr-nur-hist-date">${escapeHtml(dateLabel)}</span>
        <span class="wr-nur-hist-phase">${phaseDay}</span>
      </div>
      <div class="wr-nur-hist-subject">${escapeHtml(subject)}</div>
      ${extraHtml}
      ${bodyToggleHtml}
      ${bodyHtml}
    </div>
  `;
}

function buildHistoryModal() {
  const overlay = document.createElement('div');
  overlay.className = 'wr-nur-hist-overlay';
  overlay.innerHTML = `
    <div class="wr-nur-hist-modal" role="dialog" aria-modal="true">
      <button type="button" class="wr-nur-hist-close" aria-label="Close">×</button>
      <div class="wr-nur-hist-head">
        <div class="wr-nur-hist-eyebrow">Nurture history</div>
        <h2 class="wr-nur-hist-title">All emails for ${escapeHtml(ctx.client.name || 'this client')}</h2>
      </div>
      <div class="wr-nur-hist-body-scroll" id="wrNurHistList"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { overlay.style.display = 'none'; };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.wr-nur-hist-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') close();
  });

  return overlay;
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function daysSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

// ─── Send + realtime ──────────────────────────────────────────────────────
function wireHandlers() {
  const sendBtn = document.getElementById('wrSendBtn');
  const composer = document.getElementById('wrComposer');
  const sendLinkBtn = document.getElementById('wrSendLinkBtn');
  const editBtn = document.getElementById('wrEditBtn');
  const attachBtn = document.getElementById('wrAttachBtn');
  const fileInput = document.getElementById('wrFileInput');

  sendBtn?.addEventListener('click', handleSend);
  composer?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  sendLinkBtn?.addEventListener('click', handleSendLoginLink);
  editBtn?.addEventListener('click', () => openEditModal(ctx.client));
  attachBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', handleFileSelect);
  wireSuggestionHandlers();
  wireNurtureHandlers();
  wireProposalCardHandlers();
  wireEngagementHandlers();
  setTimeout(() => composer?.focus(), 80);
}

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
    ctx.queuedFiles.push({
      id: crypto.randomUUID(),
      file,
      error,
    });
  }
  renderFileQueue();
}

function renderFileQueue() {
  const queueEl = document.getElementById('wrFileQueue');
  if (!queueEl) return;

  if (ctx.queuedFiles.length === 0) {
    queueEl.innerHTML = '';
    queueEl.style.display = 'none';
    return;
  }

  queueEl.style.display = 'flex';
  queueEl.innerHTML = ctx.queuedFiles.map(item => {
    const isImage = item.file.type.startsWith('image/');
    const sizeStr = formatFileSize(item.file.size);
    const errorHtml = item.error ? `<div class="wr-file-chip-error">${escapeHtml(item.error)}</div>` : '';
    return `
      <div class="wr-file-chip ${item.error ? 'has-error' : ''}" data-chip-id="${escapeAttr(item.id)}">
        <span class="wr-file-chip-icon">${isImage ? '🖼' : '📄'}</span>
        <div class="wr-file-chip-info">
          <span class="wr-file-chip-name">${escapeHtml(item.file.name)}</span>
          <span class="wr-file-chip-meta">${escapeHtml(sizeStr)}</span>
          ${errorHtml}
        </div>
        <button type="button" class="wr-file-chip-remove" aria-label="Remove">×</button>
      </div>
    `;
  }).join('');

  queueEl.querySelectorAll('.wr-file-chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const chipId = e.currentTarget.closest('.wr-file-chip').dataset.chipId;
      ctx.queuedFiles = ctx.queuedFiles.filter(f => f.id !== chipId);
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

async function handleSend() {
  const composer = document.getElementById('wrComposer');
  const sendBtn = document.getElementById('wrSendBtn');
  const body = composer.value.trim();

  const validFiles = ctx.queuedFiles.filter(f => !f.error);
  const hasInvalidQueued = ctx.queuedFiles.some(f => f.error);

  if (hasInvalidQueued) {
    alert('Please remove the invalid file(s) from the queue before sending.');
    return;
  }
  if (!body && validFiles.length === 0) return;

  sendBtn.disabled = true;
  const messageUuid = crypto.randomUUID();

  const uploaded = [];
  if (validFiles.length > 0) {
    for (let i = 0; i < validFiles.length; i++) {
      const item = validFiles[i];
      sendBtn.textContent = `Uploading ${i + 1}/${validFiles.length}…`;
      const sanitized = sanitizeFilename(item.file.name);
      const path = `${ctx.client.id}/${messageUuid}/${i}_${sanitized}`;
      const { error: upErr } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .upload(path, item.file, {
          contentType: item.file.type,
          upsert: false,
        });
      if (upErr) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        alert(`Upload failed for "${item.file.name}": ${upErr.message}`);
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

  sendBtn.textContent = 'Sending…';
  const { error: msgErr } = await supabase
    .from('client_messages')
    .insert({
      id: messageUuid,
      client_id: ctx.client.id,
      sender_user_id: ctx.viewer.id,
      sender_role: ctx.viewer.role,
      body: body || null,
    });

  if (msgErr) {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    alert('Could not send: ' + msgErr.message);
    return;
  }

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
      console.error('[admin-client] attachment row insert failed:', attErr);
      alert(`Message sent but attachments failed to register: ${attErr.message}`);
    }
  }

  if (body && (ctx.outreachMode || ctx.lastSuggestionUsed)) {
    const used = ctx.lastSuggestionUsed;
    const wasEdited = used ? body !== used.text : false;
    supabase.from('outreach_send_log').insert({
      client_id: ctx.client.id,
      message_id: messageUuid,
      sent_by_user_id: ctx.viewer.id,
      suggestion_index: used ? used.index : null,
      suggestion_text: used ? used.text : null,
      final_text: body,
      was_edited: wasEdited,
      bucket: ctx.outreachMode ? ctx.outreachBucket : null,
    }).then(({ error }) => {
      if (error) console.warn('[admin-client] outreach_send_log insert failed:', error);
    });
    ctx.lastSuggestionUsed = null;
  }

  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';
  composer.value = '';
  ctx.queuedFiles = [];
  renderFileQueue();

  if (ctx.outreachMode) {
    setTimeout(() => loadSuggestions(), 400);
  }

  composer.focus();
}

async function handleSendLoginLink(e) {
  const btn = e.currentTarget;
  if (!ctx.client.email) {
    alert('No email on file for this client.');
    return;
  }
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Sending…';
  const { error } = await sendMagicLink(ctx.client.email, '/client/dashboard.html');
  if (error) {
    alert('Could not send: ' + error.message);
    btn.disabled = false;
    btn.textContent = original;
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Resend login';
  alert(`Login link sent to ${ctx.client.email}.`);
}

function subscribeRealtime() {
  if (ctx.channel) supabase.removeChannel(ctx.channel);
  const channelName = `client_messages_${ctx.client.id}_${Date.now()}`;
  ctx.channel = supabase
    .channel(channelName)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'client_messages',
      filter: `client_id=eq.${ctx.client.id}`,
    }, async (payload) => {
      const message = payload.new;
      if ((message.sender_role === 'designer' || message.sender_role === 'master')
          && !ctx.profileCache.has(message.sender_user_id)) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, display_name, email, role')
          .eq('id', message.sender_user_id)
          .maybeSingle();
        if (profile) ctx.profileCache.set(profile.id, profile);
      }
      appendMessage(message);

      if (message.sender_role === 'homeowner' && message.sender_user_id !== ctx.viewer.id) {
        setTimeout(() => loadSuggestions(), 400);
      }

      setTimeout(async () => {
        const { data: atts } = await supabase
          .from('client_message_attachments')
          .select('id, message_id, storage_path, file_name, mime_type, size_bytes')
          .eq('message_id', message.id);
        if (atts && atts.length > 0) {
          ctx.attachmentsByMessageId.set(message.id, atts);
          const node = document.querySelector(`.wr-msg[data-message-id="${CSS.escape(message.id)}"]`);
          if (node) {
            const wasNearBottom = isScrolledNearBottom();
            node.outerHTML = renderOneMessage(message);
            const newNode = document.querySelector(`.wr-msg[data-message-id="${CSS.escape(message.id)}"]`);
            if (newNode) hydrateSignedUrls(newNode);
            if (wasNearBottom) scrollMessagesToBottom();
          }
        }
      }, REALTIME_ATTACHMENT_DELAY);
    })
    .subscribe();
}

function appendMessage(message) {
  const messagesEl = document.getElementById('wrMessages');
  if (!messagesEl) return;
  if (messagesEl.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
  const empty = messagesEl.querySelector('.wr-empty');
  if (empty) empty.remove();
  ctx.messages.push(message);
  const wasNearBottom = isScrolledNearBottom();
  messagesEl.insertAdjacentHTML('beforeend', renderOneMessage(message));
  if (wasNearBottom) scrollMessagesToBottom();
}

function isScrolledNearBottom() {
  const m = document.getElementById('wrMessages');
  if (!m) return true;
  return (m.scrollHeight - m.scrollTop - m.clientHeight) < 100;
}
function scrollMessagesToBottom() {
  const m = document.getElementById('wrMessages');
  if (m) m.scrollTop = m.scrollHeight;
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
      const loading = el.querySelector('.wr-msg-attachment-loading');
      if (loading) loading.textContent = 'Could not load file';
      continue;
    }

    if (el.classList.contains('wr-msg-attachment-img')) {
      el.innerHTML = `<img src="${escapeAttr(url)}" alt="${escapeAttr(fileName)}" loading="lazy">`;
      el.style.cursor = 'zoom-in';
      el.addEventListener('click', () => openImageViewer(url, fileName));
    } else if (el.classList.contains('wr-msg-attachment-pdf')) {
      const link = el.querySelector('.wr-msg-attachment-pdf-download');
      if (link) link.href = url;
    }
    el.dataset.hydrated = 'true';
  }
}

async function getCachedSignedUrl(path) {
  const cached = ctx.signedUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.url;

  const { data, error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);

  if (error || !data?.signedUrl) {
    console.error('[admin-client] signed URL failed for', path, error);
    return null;
  }

  ctx.signedUrlCache.set(path, {
    url: data.signedUrl,
    expiresAt: Date.now() + (SIGNED_URL_TTL * 1000),
  });
  return data.signedUrl;
}

function openImageViewer(url, fileName) {
  const overlay = document.createElement('div');
  overlay.className = 'wr-image-viewer';
  overlay.innerHTML = `
    <img src="${escapeAttr(url)}" alt="${escapeAttr(fileName)}">
    <button type="button" class="wr-image-viewer-close" aria-label="Close">×</button>
  `;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onEsc);
  };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('wr-image-viewer-close')) close();
  });
  document.addEventListener('keydown', onEsc);
  document.body.appendChild(overlay);
}

// ═══════════════════════════════════════════════════════════════════════════
// Edit Client modal
// ═══════════════════════════════════════════════════════════════════════════

function ensureEditModalStyles() {
  if (document.getElementById('wrace-modal-styles')) return;
  const style = document.createElement('style');
  style.id = 'wrace-modal-styles';
  style.textContent = `
    .wrace-overlay {
      position: fixed; inset: 0; z-index: 1200;
      background: rgba(26, 31, 46, 0.55);
      display: none; align-items: flex-start; justify-content: center;
      padding: 56px 20px 20px;
      overflow-y: auto;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      animation: wraceFade 0.18s ease-out;
    }
    @keyframes wraceFade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes wraceSlide { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .wrace-modal {
      background: #fff; border-radius: 14px;
      max-width: 540px; width: 100%;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);
      animation: wraceSlide 0.22s ease-out;
      color: #353535; overflow: hidden;
      display: flex; flex-direction: column; position: relative;
    }
    .wrace-head { padding: 22px 28px 16px; border-bottom: 1px solid #e8e6dd; }
    .wrace-eyebrow {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px; letter-spacing: 0.18em;
      color: #9c7440; text-transform: uppercase;
      margin-bottom: 6px; font-weight: 600;
    }
    .wrace-title { font-size: 20px; font-weight: 600; letter-spacing: -0.012em; margin: 0; }
    .wrace-close {
      position: absolute; top: 14px; right: 14px;
      width: 32px; height: 32px;
      background: transparent; border: 0; cursor: pointer;
      font-size: 18px; color: #888;
      border-radius: 6px; transition: background 0.12s, color 0.12s;
    }
    .wrace-close:hover { background: #f4f4ef; color: #353535; }
    .wrace-body { padding: 22px 28px; }
    .wrace-warn {
      background: #fff7e6; color: #7a5a10;
      border-left: 3px solid #c5a050;
      padding: 10px 14px; border-radius: 6px;
      font-size: 12px; line-height: 1.55; margin-bottom: 16px;
    }
    .wrace-error {
      background: #fbeeee; color: #b91c1c;
      border-left: 3px solid #b91c1c;
      padding: 10px 14px; border-radius: 6px;
      font-size: 13px; line-height: 1.5; margin-bottom: 14px;
    }
    .wrace-error.hidden, .wrace-warn.hidden { display: none; }
    .wrace-field { margin-bottom: 14px; }
    .wrace-field label {
      display: block; font-size: 11px; font-weight: 600;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: #888; margin-bottom: 5px;
    }
    .wrace-field input, .wrace-field textarea {
      width: 100%; font-family: inherit; font-size: 14px;
      padding: 9px 12px; border: 1px solid #d4cfc0;
      border-radius: 6px; background: #fff; color: #353535;
      transition: border-color 0.15s, box-shadow 0.15s;
      box-sizing: border-box;
    }
    .wrace-field textarea { min-height: 80px; resize: vertical; }
    .wrace-field input:focus, .wrace-field textarea:focus {
      outline: none; border-color: #9c7440;
      box-shadow: 0 0 0 3px #f1e7d3;
    }
    .wrace-foot {
      padding: 16px 28px; border-top: 1px solid #e8e6dd;
      display: flex; justify-content: flex-end; gap: 10px;
      background: #faf8f3;
    }
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

    .wr-notes-display {
      font-size: 13px; line-height: 1.55;
      color: #353535; white-space: pre-wrap; word-wrap: break-word;
    }
  `;
  document.head.appendChild(style);
}

let _editOverlay = null;

function buildEditModal() {
  const overlay = document.createElement('div');
  overlay.className = 'wrace-overlay';
  overlay.innerHTML = `
    <div class="wrace-modal" role="dialog" aria-modal="true" aria-labelledby="wraceTitle">
      <button type="button" class="wrace-close" aria-label="Close">×</button>
      <div class="wrace-head">
        <div class="wrace-eyebrow">Edit client</div>
        <h2 id="wraceTitle" class="wrace-title">Update contact details</h2>
      </div>
      <div class="wrace-body">
        <div class="wrace-warn hidden" id="wraceWarn"></div>
        <div class="wrace-error hidden" id="wraceErr"></div>
        <div class="wrace-field">
          <label>Full name</label>
          <input type="text" id="wraceName" autocomplete="off">
        </div>
        <div class="wrace-field">
          <label>Email <span style="text-transform:none; font-weight:400; color:#aaa;">(must be unique)</span></label>
          <input type="email" id="wraceEmail" autocomplete="off">
        </div>
        <div class="wrace-field">
          <label>Phone</label>
          <input type="tel" id="wracePhone" autocomplete="off">
        </div>
        <div class="wrace-field">
          <label>Project address</label>
          <input type="text" id="wraceAddress" autocomplete="off">
        </div>
        <div class="wrace-field">
          <label>Notes (internal)</label>
          <textarea id="wraceNotes" autocomplete="off" placeholder="Anything worth remembering about this client…"></textarea>
        </div>
      </div>
      <div class="wrace-foot">
        <button type="button" class="wrace-btn wrace-cancel" id="wraceCancel">Cancel</button>
        <button type="button" class="wrace-btn wrace-save" id="wraceSave">Save changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEditModal(); });
  overlay.querySelector('.wrace-close').addEventListener('click', closeEditModal);
  overlay.querySelector('#wraceCancel').addEventListener('click', closeEditModal);
  overlay.querySelector('#wraceSave').addEventListener('click', submitEditClient);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _editOverlay && _editOverlay.style.display !== 'none') {
      closeEditModal();
    }
  });

  return overlay;
}

function openEditModal(client) {
  if (!_editOverlay) _editOverlay = buildEditModal();

  _editOverlay.querySelector('#wraceName').value = client.name || '';
  _editOverlay.querySelector('#wraceEmail').value = client.email || '';
  _editOverlay.querySelector('#wracePhone').value = client.phone || '';
  _editOverlay.querySelector('#wraceAddress').value = client.address || '';
  _editOverlay.querySelector('#wraceNotes').value = client.notes || '';

  const warn = _editOverlay.querySelector('#wraceWarn');
  if (client.user_id) {
    warn.innerHTML = `<strong>Heads up:</strong> ${escapeHtml(client.name)} has already signed in. Changing their email here updates contact info but does <em>not</em> change their auth login — they will keep signing in with their previous email.`;
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }

  const err = _editOverlay.querySelector('#wraceErr');
  err.classList.add('hidden');
  err.textContent = '';

  const saveBtn = _editOverlay.querySelector('#wraceSave');
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save changes';

  _editOverlay.style.display = 'flex';
  setTimeout(() => _editOverlay.querySelector('#wraceName').focus(), 50);
}

function closeEditModal() {
  if (_editOverlay) _editOverlay.style.display = 'none';
}

async function submitEditClient() {
  const saveBtn = _editOverlay.querySelector('#wraceSave');
  const err = _editOverlay.querySelector('#wraceErr');
  err.classList.add('hidden');

  const name = _editOverlay.querySelector('#wraceName').value.trim();
  const email = _editOverlay.querySelector('#wraceEmail').value.trim().toLowerCase();
  const phone = _editOverlay.querySelector('#wracePhone').value.trim();
  const address = _editOverlay.querySelector('#wraceAddress').value.trim();
  const notes = _editOverlay.querySelector('#wraceNotes').value.trim();

  if (!name) {
    err.textContent = 'Name is required.';
    err.classList.remove('hidden');
    return;
  }
  if (!email || !email.includes('@')) {
    err.textContent = 'A valid email is required.';
    err.classList.remove('hidden');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase
    .from('clients')
    .update({
      name, email,
      phone: phone || null,
      address: address || null,
      notes: notes || null,
    })
    .eq('id', ctx.client.id);

  if (error) {
    if (error.code === '23505' || (error.message || '').toLowerCase().includes('duplicate')) {
      err.textContent = `Another client already uses the email "${email}". Pick a different one.`;
    } else {
      err.textContent = `Could not update: ${error.message}`;
    }
    err.classList.remove('hidden');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save changes';
    return;
  }

  ctx.client.name = name;
  ctx.client.email = email;
  ctx.client.phone = phone || null;
  ctx.client.address = address || null;
  ctx.client.notes = notes || null;

  closeEditModal();
  render();
  hydrateSignedUrls(document.getElementById('wrMessages'));
}

// ═══════════════════════════════════════════════════════════════════════════
// Attachment + suggestion + outreach-banner styles
// ═══════════════════════════════════════════════════════════════════════════

function ensureAttachmentStyles() {
  if (document.getElementById('wr-attachment-styles')) return;
  const style = document.createElement('style');
  style.id = 'wr-attachment-styles';
  style.textContent = `
    .wr-attach-btn {
      flex-shrink: 0;
      width: 40px; height: 40px;
      background: transparent;
      border: 1px solid var(--border, #e5e5e5);
      border-radius: 8px;
      cursor: pointer;
      font-size: 18px;
      color: var(--charcoal, #353535);
      transition: background 0.12s, border-color 0.12s, color 0.12s;
      display: flex; align-items: center; justify-content: center;
      align-self: flex-end;
    }
    .wr-attach-btn:hover {
      background: #faf8f3;
      border-color: #9c7440;
      color: #7d5c31;
    }

    .wr-file-queue {
      background: #fff;
      border-top: 1px solid var(--border, #e5e5e5);
      padding: 10px 22px;
      display: flex; flex-wrap: wrap; gap: 8px;
    }
    .wr-file-chip {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 8px 10px;
      background: #faf8f3;
      border: 1px solid var(--border, #e5e5e5);
      border-radius: 8px;
      max-width: 320px;
      font-size: 12px;
    }
    .wr-file-chip.has-error {
      background: #fef2f2;
      border-color: #fecaca;
    }
    .wr-file-chip-icon {
      font-size: 16px; flex-shrink: 0;
      margin-top: 1px;
    }
    .wr-file-chip-info {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column; gap: 2px;
    }
    .wr-file-chip-name {
      font-weight: 600;
      color: #353535;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .wr-file-chip-meta {
      font-size: 11px;
      color: #888;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
    }
    .wr-file-chip-error {
      font-size: 11px;
      color: #b91c1c;
      margin-top: 2px;
    }
    .wr-file-chip-remove {
      flex-shrink: 0;
      background: transparent; border: 0;
      color: #888; font-size: 16px;
      cursor: pointer; padding: 0 4px;
      line-height: 1; align-self: flex-start;
    }
    .wr-file-chip-remove:hover { color: #b91c1c; }

    .wr-msg-attachments {
      display: flex; flex-wrap: wrap; gap: 8px;
      margin-top: 6px;
      max-width: 100%;
    }
    .wr-msg-attachment-img {
      width: 120px; height: 120px;
      border-radius: 8px;
      overflow: hidden;
      background: #ece9dd;
      border: 1px solid rgba(0, 0, 0, 0.08);
      transition: transform 0.12s, box-shadow 0.12s;
    }
    .wr-msg-attachment-img:hover {
      transform: scale(1.02);
      box-shadow: 0 6px 14px rgba(0, 0, 0, 0.14);
    }
    .wr-msg-attachment-img img {
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
    }
    .wr-msg-attachment-loading {
      display: flex; align-items: center; justify-content: center;
      width: 100%; height: 100%;
      font-size: 11px;
      color: #888;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
    }
    .wr-msg-attachment-pdf {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      background: #fff;
      border: 1px solid var(--border, #e5e5e5);
      border-radius: 10px;
      max-width: 320px;
      transition: border-color 0.12s;
    }
    .wr-msg-out .wr-msg-attachment-pdf {
      background: rgba(255, 255, 255, 0.94);
      border-color: rgba(255, 255, 255, 0.4);
    }
    .wr-msg-attachment-pdf:hover {
      border-color: #9c7440;
    }
    .wr-msg-attachment-pdf-icon { font-size: 22px; flex-shrink: 0; }
    .wr-msg-attachment-pdf-info {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column; gap: 2px;
    }
    .wr-msg-attachment-pdf-name {
      font-size: 13px; font-weight: 600;
      color: #353535;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .wr-msg-attachment-pdf-meta {
      font-size: 11px;
      color: #888;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
    }
    .wr-msg-attachment-pdf-download {
      background: #9c7440;
      color: #fff;
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      text-decoration: none;
      flex-shrink: 0;
      transition: background 0.12s;
    }
    .wr-msg-attachment-pdf-download:hover { background: #7d5c31; color: #fff; }

    .wr-image-viewer {
      position: fixed; inset: 0;
      z-index: 1300;
      background: rgba(0, 0, 0, 0.88);
      display: flex; align-items: center; justify-content: center;
      cursor: zoom-out;
      animation: wrViewerFade 0.16s ease-out;
    }
    @keyframes wrViewerFade { from { opacity: 0; } to { opacity: 1; } }
    .wr-image-viewer img {
      max-width: 92vw; max-height: 92vh;
      object-fit: contain;
      border-radius: 6px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
    }
    .wr-image-viewer-close {
      position: fixed; top: 20px; right: 24px;
      width: 40px; height: 40px;
      background: rgba(255, 255, 255, 0.16);
      border: 0; color: #fff;
      border-radius: 50%;
      font-size: 22px;
      cursor: pointer;
      line-height: 1;
      transition: background 0.12s;
    }
    .wr-image-viewer-close:hover { background: rgba(255, 255, 255, 0.3); }

    .wr-suggestions-label {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px;
    }
    .wr-suggestions-refresh {
      background: transparent;
      border: 1px solid #e5e5e5;
      color: #888;
      width: 24px; height: 24px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      transition: background 0.12s, color 0.12s, border-color 0.12s, transform 0.4s;
      display: flex; align-items: center; justify-content: center;
      font-family: inherit;
    }
    .wr-suggestions-refresh:hover:not(:disabled) {
      background: #faf8f3;
      border-color: #9c7440;
      color: #7d5c31;
      transform: rotate(180deg);
    }
    .wr-suggestions-refresh:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .wr-suggestions-loading {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 0;
      font-size: 12px;
      color: #888;
      font-style: italic;
    }
    .wr-suggestions-spinner {
      width: 12px; height: 12px;
      border: 2px solid #e5e5e5;
      border-top-color: #9c7440;
      border-radius: 50%;
      animation: wrSugSpin 0.8s linear infinite;
    }
    @keyframes wrSugSpin { to { transform: rotate(360deg); } }

    .wr-outreach-banner {
      display: flex; align-items: center; gap: 12px;
      padding: 14px 24px;
      background: linear-gradient(135deg, #fff7e6 0%, #fffaf0 100%);
      border-bottom: 1px solid #f0e0b8;
      font-size: 13.5px;
      color: #353535;
    }
    .wr-outreach-icon {
      font-size: 22px;
      flex-shrink: 0;
    }
    .wr-outreach-text {
      flex: 1;
      line-height: 1.45;
    }
    .wr-outreach-text strong {
      color: #7a5a10;
    }
    .wr-outreach-back {
      background: #fff;
      border: 1px solid #e5e5e5;
      color: #353535;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
      transition: border-color 0.12s, color 0.12s;
      flex-shrink: 0;
    }
    .wr-outreach-back:hover {
      border-color: #9c7440;
      color: #7d5c31;
    }
  `;
  document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════════════════
// War Room Level A + 14C.3 styles — back link, header buttons, proposal-
// card controls, Engagement panel, Substitutions/Redesigns rows, and the
// three new modals (Send Now picker, Edit queued, Engagement full log).
// ═══════════════════════════════════════════════════════════════════════════

function ensureLevelAStyles() {
  if (document.getElementById('wr-leva-styles')) return;
  const style = document.createElement('style');
  style.id = 'wr-leva-styles';
  style.textContent = `
    /* ─── Back link + +New proposal button ─────────────────────────── */
    .wr-back-link {
      display: inline-flex; align-items: center;
      padding: 14px 24px 0;
      font-size: 12px; font-weight: 600;
      color: #9c7440;
      text-decoration: none;
      letter-spacing: 0.02em;
      transition: color 0.12s;
    }
    .wr-back-link:hover { color: #7d5c31; text-decoration: underline; }
    .wr-action-btn.primary {
      background: #9c7440; color: #fff;
      border-color: #9c7440;
      box-shadow: 0 2px 6px rgba(93, 126, 105, 0.2);
    }
    .wr-action-btn.primary:hover {
      background: #7d5c31; border-color: #7d5c31; color: #fff;
    }

    /* ─── Proposal-card Level A controls ───────────────────────────── */

    /* Sprint 14C.8 — Current vs Previous bid hierarchy.
       Sort puts most-recent at index 0; --current gets a green
       eyebrow + slightly stronger card; --archive gets reduced
       visual weight so the eye reads the stack as a hierarchy
       rather than a flat list. Divider above the first archive
       card explicitly groups them. */
    .wr-pcard-eyebrow {
      display: flex; align-items: center; gap: 6px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 10px; font-weight: 600;
      letter-spacing: 0.14em; text-transform: uppercase;
      color: #9c7440;
      margin-bottom: 8px;
    }
    .wr-pcard-eyebrow-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #9c7440;
      box-shadow: 0 0 0 3px rgba(93, 126, 105, 0.18);
    }
    .wr-pcard-divider {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 10px; font-weight: 600;
      letter-spacing: 0.18em; text-transform: uppercase;
      color: #aaa;
      margin: 14px 0 6px;
      padding-top: 12px;
      border-top: 1px dashed #ddd;
    }
    .wr-proposal-card--current {
      border-left: 3px solid #9c7440;
      box-shadow: 0 2px 10px rgba(93, 126, 105, 0.10);
    }
    .wr-proposal-card--archive {
      opacity: 0.78;
      background: #fbfaf5;
    }
    .wr-proposal-card--archive .wr-paddr-label,
    .wr-proposal-card--archive .wr-proposal-card-meta {
      color: #888;
    }
    .wr-proposal-card--archive:hover {
      opacity: 1;
      background: #fff;
    }
    .wr-proposal-card-addr {
      display: flex; align-items: center; gap: 6px;
      font-size: 13px; font-weight: 600; color: #33281c;
      line-height: 1.35;
    }
    .wr-paddr-label { flex: 1; min-width: 0; word-break: break-word; }
    .wr-paddr-pencil {
      flex-shrink: 0;
      background: transparent; border: 0;
      width: 22px; height: 22px;
      cursor: pointer; opacity: 0.55;
      font-size: 11px; line-height: 1;
      border-radius: 4px;
      transition: opacity 0.12s, background 0.12s;
    }
    .wr-paddr-pencil:hover { opacity: 1; background: #faf8f3; }

    .wr-paddr-edit {
      display: flex; flex-wrap: wrap; gap: 5px;
      align-items: center; margin-bottom: 4px;
    }
    .wr-paddr-input {
      flex: 1 1 100%;
      font: inherit; font-size: 13px; font-weight: 600;
      padding: 6px 8px;
      border: 1px solid #9c7440;
      border-radius: 6px;
      box-shadow: 0 0 0 3px #f1e7d3;
      box-sizing: border-box;
      color: #33281c;
    }
    .wr-paddr-input:focus { outline: none; }

    .wr-proposal-card-controls {
      display: flex; flex-wrap: wrap; gap: 5px; align-items: center;
      margin-top: 6px; padding-top: 6px;
      border-top: 1px solid #ece9dd;
    }
    .wr-paddr-status {
      font: inherit; font-size: 11px;
      padding: 4px 6px;
      border: 1px solid #e5e5e5;
      border-radius: 6px;
      background: #fff; color: #353535;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      letter-spacing: 0.04em;
      cursor: pointer;
      transition: border-color 0.12s;
    }
    .wr-paddr-status:hover { border-color: #9c7440; }
    .wr-paddr-status:focus { outline: none; border-color: #9c7440; box-shadow: 0 0 0 2px #f1e7d3; }

    .wr-discount-pill {
      font: inherit; font-size: 11px; font-weight: 600;
      padding: 4px 9px; border-radius: 999px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
      font-family: inherit;
    }
    .wr-discount-pill.on {
      background: #fff4d4; color: #7a5a10; border-color: #f0e0b8;
    }
    .wr-discount-pill.on:hover { background: #ffe9b5; }
    .wr-discount-pill.off {
      background: #f0f0f0; color: #888; border-color: #e5e5e5;
    }
    .wr-discount-pill.off:hover { background: #e5e5e5; color: #555; }

    .wr-mini-btn.cancel { background: #f4f4ef; color: #666; }
    .wr-mini-btn.cancel:hover { background: #e8e6dd; }
    .wr-mini-btn.primary {
      background: #9c7440; color: #fff; border-color: #9c7440;
    }
    .wr-mini-btn.primary:hover { background: #7d5c31; color: #fff; }

    /* ─── Engagement panel ─────────────────────────────────────────── */
    .wr-eng-head {
      display: flex; justify-content: space-between; align-items: baseline;
      gap: 8px; flex-wrap: wrap;
      padding-bottom: 8px; margin-bottom: 8px;
      border-bottom: 1px solid #ece9dd;
    }
    .wr-eng-count {
      display: flex; align-items: center; gap: 6px;
      font-size: 13px; color: #353535;
    }
    .wr-eng-count strong { font-size: 16px; color: #33281c; font-weight: 700; }
    .wr-eng-live-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 9px; letter-spacing: 0.08em;
      background: #d9534f; color: #fff;
      padding: 2px 6px; border-radius: 999px;
      text-transform: uppercase;
      margin-left: 4px;
    }
    .wr-eng-recency {
      font-size: 11px; color: #888;
      font-family: 'JetBrains Mono', monospace;
    }
    .wr-eng-timeline {
      display: flex; flex-direction: column; gap: 6px;
    }
    .wr-eng-row {
      display: flex; gap: 8px; align-items: baseline;
      font-size: 12.5px; line-height: 1.4;
      padding: 4px 0;
    }
    .wr-eng-time {
      flex-shrink: 0; min-width: 32px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10.5px;
      color: #888; text-align: right;
    }
    .wr-eng-body { color: #353535; }
    .wr-eng-expand {
      display: block; width: 100%;
      background: transparent; border: 0;
      padding: 8px 0 0; margin-top: 6px;
      font-size: 12px; color: #9c7440;
      text-align: left; cursor: pointer;
      font-family: inherit; font-weight: 600;
    }
    .wr-eng-expand:hover { color: #7d5c31; text-decoration: underline; }

    /* ─── Substitutions / Redesigns side rows ──────────────────────── */
    .wr-side-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; padding: 4px 0;
    }
    .wr-side-row-label {
      font-size: 12px; color: #888;
    }
    .wr-side-badge {
      display: inline-block;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px; font-weight: 600;
      padding: 3px 9px; border-radius: 999px;
      letter-spacing: 0.04em;
      background: #f0f0f0; color: #666;
    }
    .wr-side-badge.amber {
      background: #fff4d4; color: #7a5a10;
    }
    .wr-side-mini-link {
      font-size: 12px; color: #888;
      text-decoration: none; font-weight: 500;
      white-space: nowrap;
    }
    .wr-side-mini-link:hover { color: #9c7440; text-decoration: underline; }
    .wr-side-mini-link.primary {
      color: #9c7440; font-weight: 600;
    }
    .wr-side-mini-link.primary:hover { color: #7d5c31; }

    /* ─── Engagement full-log modal ────────────────────────────────── */
    .wr-eng-log-overlay {
      position: fixed; inset: 0; z-index: 1240;
      background: rgba(26, 31, 46, 0.55);
      display: none; align-items: flex-start; justify-content: center;
      padding: 56px 20px 20px; overflow-y: auto;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .wr-eng-log-modal {
      background: #fff; border-radius: 14px;
      max-width: 640px; width: 100%;
      max-height: calc(100vh - 76px);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);
      color: #353535; overflow: hidden;
      display: flex; flex-direction: column; position: relative;
    }
    .wr-eng-log-close {
      position: absolute; top: 14px; right: 14px;
      width: 32px; height: 32px;
      background: transparent; border: 0; cursor: pointer;
      font-size: 18px; color: #888;
      border-radius: 6px;
    }
    .wr-eng-log-close:hover { background: #f4f4ef; color: #353535; }
    .wr-eng-log-head { padding: 22px 28px 16px; border-bottom: 1px solid #e8e6dd; }
    .wr-eng-log-eyebrow {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px; letter-spacing: 0.18em;
      color: #9c7440; text-transform: uppercase;
      margin-bottom: 6px; font-weight: 600;
    }
    .wr-eng-log-title {
      font-size: 18px; font-weight: 600;
      letter-spacing: -0.01em; margin: 0 0 4px;
    }
    .wr-eng-log-sub { font-size: 12px; color: #888; }
    .wr-eng-log-body {
      flex: 1; overflow-y: auto;
      padding: 12px 28px 26px;
    }
    .wr-eng-log-row {
      display: flex; gap: 14px; align-items: baseline;
      padding: 10px 0;
      border-bottom: 1px solid #ece9dd;
      font-size: 13px;
    }
    .wr-eng-log-row:last-child { border-bottom: 0; }
    .wr-eng-log-time {
      flex-shrink: 0;
      display: flex; flex-direction: column;
      min-width: 92px;
    }
    .wr-eng-log-rel {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px; color: #353535; font-weight: 600;
    }
    .wr-eng-log-abs {
      font-size: 10.5px; color: #aaa;
      font-family: 'JetBrains Mono', monospace;
    }
    .wr-eng-log-body { color: #353535; }

    /* ─── Send Now picker modal (14C.3) ────────────────────────────── */
    .wr-snp-overlay {
      position: fixed; inset: 0; z-index: 1260;
      background: rgba(26, 31, 46, 0.55);
      display: none; align-items: flex-start; justify-content: center;
      padding: 56px 20px 20px; overflow-y: auto;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .wr-snp-modal {
      background: #fff; border-radius: 14px;
      max-width: 580px; width: 100%;
      max-height: calc(100vh - 76px);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);
      color: #353535; overflow: hidden;
      display: flex; flex-direction: column; position: relative;
    }
    .wr-snp-close {
      position: absolute; top: 14px; right: 14px;
      width: 32px; height: 32px;
      background: transparent; border: 0; cursor: pointer;
      font-size: 18px; color: #888;
      border-radius: 6px;
    }
    .wr-snp-close:hover { background: #f4f4ef; color: #353535; }
    .wr-snp-head { padding: 22px 28px 14px; border-bottom: 1px solid #e8e6dd; }
    .wr-snp-eyebrow {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px; letter-spacing: 0.18em;
      color: #9c7440; text-transform: uppercase;
      margin-bottom: 6px; font-weight: 600;
    }
    .wr-snp-title {
      font-size: 17px; font-weight: 600;
      letter-spacing: -0.01em; margin: 0 0 6px;
      line-height: 1.35;
    }
    .wr-snp-sub { font-size: 12px; color: #888; line-height: 1.45; }
    .wr-snp-body { flex: 1; overflow-y: auto; padding: 8px 28px; }
    .wr-snp-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 12px;
      border: 1px solid transparent;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    .wr-snp-row:hover { background: #faf8f3; }
    .wr-snp-row.selected {
      background: #f4f8f5;
      border-color: #9c7440;
    }
    .wr-snp-row input[type="radio"] {
      margin-top: 4px; flex-shrink: 0;
      accent-color: #9c7440;
    }
    .wr-snp-row-info { flex: 1; min-width: 0; }
    .wr-snp-row-subject {
      font-size: 13.5px; font-weight: 600;
      color: #33281c; margin-bottom: 3px;
      line-height: 1.35;
    }
    .wr-snp-row-meta {
      font-size: 11px; color: #888;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 0.02em;
    }
    .wr-snp-foot {
      padding: 14px 28px;
      border-top: 1px solid #e8e6dd;
      display: flex; justify-content: flex-end; gap: 10px;
      background: #faf8f3;
    }

    /* ─── Edit queued send modal (14C.3) ───────────────────────────── */
    .wr-eq-overlay {
      position: fixed; inset: 0; z-index: 1265;
      background: rgba(26, 31, 46, 0.55);
      display: none; align-items: flex-start; justify-content: center;
      padding: 40px 20px 20px; overflow-y: auto;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .wr-eq-modal {
      background: #fff; border-radius: 14px;
      max-width: 640px; width: 100%;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);
      color: #353535; overflow: hidden;
      display: flex; flex-direction: column; position: relative;
    }
    .wr-eq-close {
      position: absolute; top: 14px; right: 14px;
      width: 32px; height: 32px;
      background: transparent; border: 0; cursor: pointer;
      font-size: 18px; color: #888;
      border-radius: 6px;
    }
    .wr-eq-close:hover { background: #f4f4ef; color: #353535; }
    .wr-eq-head { padding: 22px 28px 14px; border-bottom: 1px solid #e8e6dd; }
    .wr-eq-eyebrow {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px; letter-spacing: 0.18em;
      color: #9c7440; text-transform: uppercase;
      margin-bottom: 6px; font-weight: 600;
    }
    .wr-eq-title {
      font-size: 18px; font-weight: 600;
      letter-spacing: -0.01em; margin: 0 0 6px;
    }
    .wr-eq-sub { font-size: 12px; color: #888; line-height: 1.5; }
    .wr-eq-body { padding: 18px 28px; }
    .wr-eq-error {
      background: #fbeeee; color: #b91c1c;
      border-left: 3px solid #b91c1c;
      padding: 10px 14px; border-radius: 6px;
      font-size: 13px; line-height: 1.5; margin-bottom: 14px;
    }
    .wr-eq-error.hidden { display: none; }
    .wr-eq-field { margin-bottom: 14px; }
    .wr-eq-field label {
      display: block; font-size: 11px; font-weight: 600;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: #888; margin-bottom: 5px;
    }
    .wr-eq-field input, .wr-eq-field textarea {
      width: 100%; font-family: inherit; font-size: 14px;
      padding: 9px 12px; border: 1px solid #d4cfc0;
      border-radius: 6px; background: #fff; color: #353535;
      transition: border-color 0.15s, box-shadow 0.15s;
      box-sizing: border-box;
    }
    .wr-eq-field textarea {
      min-height: 220px; resize: vertical;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 13px; line-height: 1.55;
    }
    .wr-eq-field input:focus, .wr-eq-field textarea:focus {
      outline: none; border-color: #9c7440;
      box-shadow: 0 0 0 3px #f1e7d3;
    }
    .wr-eq-foot {
      padding: 16px 28px; border-top: 1px solid #e8e6dd;
      display: flex; justify-content: flex-end; gap: 10px;
      background: #faf8f3;
    }

    /* ─── Next-queued nurture card head + edit pencil (14C.3) ──────── */
    .wr-nur-card-head {
      display: flex; justify-content: space-between; align-items: center;
      gap: 6px; margin-bottom: 3px;
    }
    .wr-nur-edit-btn {
      flex-shrink: 0;
      background: transparent; border: 0;
      font-family: inherit; font-size: 11px;
      color: #9c7440; cursor: pointer;
      padding: 2px 6px; border-radius: 4px;
      transition: background 0.12s, color 0.12s;
    }
    .wr-nur-edit-btn:hover {
      background: #f1e7d3; color: #7d5c31;
    }
  `;
  document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════════════════
// 14C.2 Nurture panel + history modal styles
// ═══════════════════════════════════════════════════════════════════════════

function ensureNurtureStyles() {
  if (document.getElementById('wr-nur-styles')) return;
  const style = document.createElement('style');
  style.id = 'wr-nur-styles';
  style.textContent = `
    .wr-nur-head {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 10px;
    }
    .wr-nur-title { font-size: 13px; font-weight: 600; color: #353535; }
    .wr-nur-pill {
      font-size: 10px; font-weight: 600;
      letter-spacing: 0.04em; text-transform: uppercase;
      padding: 3px 9px; border-radius: 999px;
      font-family: 'JetBrains Mono', monospace;
    }
    .wr-nur-pill.active { background: #f1e7d3; color: #7d5c31; }
    .wr-nur-pill.paused { background: #fff4d4; color: #7a5a10; }
    .wr-nur-pill.optout { background: #fbe6e6; color: #8a2a2a; }
    .wr-nur-pill.gray   { background: #f0f0f0; color: #888; }

    .wr-nur-state { margin-bottom: 12px; }
    .wr-nur-row {
      display: flex; justify-content: space-between;
      padding: 6px 0; font-size: 13px;
      border-bottom: 1px solid #ece9dd;
    }
    .wr-nur-row:last-child { border-bottom: 0; }
    .wr-nur-row > span:first-child { color: #666; }
    .wr-nur-row > span:last-child  { color: #353535; font-weight: 500; text-align: right; }
    .wr-nur-row.paused-row > span:last-child { color: #7a5a10; }

    .wr-nur-note {
      font-size: 11px; color: #888; line-height: 1.5;
      margin-top: 6px; font-style: italic;
    }

    .wr-nur-card {
      background: #faf8f3; border-radius: 8px;
      padding: 9px 12px; margin-bottom: 8px;
    }
    .wr-nur-card.queued { background: #f4f8f5; border-left: 3px solid #9c7440; }
    .wr-nur-card-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px; color: #666;
      margin-bottom: 3px; font-weight: 500;
    }
    .wr-nur-card-subject {
      font-size: 13px; font-weight: 500; color: #33281c;
      line-height: 1.35;
      overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .wr-nur-card-empty {
      font-size: 12px; color: #888; font-style: italic;
      padding: 6px 0; margin-bottom: 6px;
    }

    .wr-nur-actions, .wr-nur-pause-options {
      display: flex; gap: 5px; flex-wrap: wrap;
      margin: 10px 0 6px;
    }
    .wr-nur-actions .wr-mini-btn,
    .wr-nur-pause-options .wr-mini-btn {
      flex: 1; min-width: 0;
      text-align: center;
      padding: 7px 6px;
      font-size: 11px;
      transition: border-color 0.12s, background 0.12s, color 0.12s;
    }
    .wr-nur-actions .wr-mini-btn.primary {
      background: #9c7440; color: #fff; border-color: #9c7440;
    }
    .wr-nur-actions .wr-mini-btn.primary:hover:not(:disabled) {
      background: #7d5c31; color: #fff;
    }
    .wr-nur-pause-options .wr-mini-btn.cancel {
      background: #f4f4ef; color: #666;
    }
    .wr-mini-btn:disabled {
      opacity: 0.4; cursor: not-allowed;
    }
    .wr-mini-btn:disabled:hover {
      border-color: #e5e5e5; color: #353535;
    }

    .wr-nur-history-link {
      display: block; width: 100%;
      background: transparent; border: 0;
      padding: 8px 0 0; margin-top: 4px;
      font-size: 12px; color: #9c7440;
      text-align: left; cursor: pointer;
      font-family: inherit; font-weight: 600;
    }
    .wr-nur-history-link:hover { color: #7d5c31; text-decoration: underline; }

    /* History modal */
    .wr-nur-hist-overlay {
      position: fixed; inset: 0; z-index: 1250;
      background: rgba(26, 31, 46, 0.55);
      display: none; align-items: flex-start; justify-content: center;
      padding: 56px 20px 20px; overflow-y: auto;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .wr-nur-hist-modal {
      background: #fff; border-radius: 14px;
      max-width: 720px; width: 100%;
      max-height: calc(100vh - 76px);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);
      color: #353535; overflow: hidden;
      display: flex; flex-direction: column; position: relative;
    }
    .wr-nur-hist-close {
      position: absolute; top: 14px; right: 14px;
      width: 32px; height: 32px;
      background: transparent; border: 0; cursor: pointer;
      font-size: 18px; color: #888;
      border-radius: 6px;
    }
    .wr-nur-hist-close:hover { background: #f4f4ef; color: #353535; }
    .wr-nur-hist-head { padding: 22px 28px 16px; border-bottom: 1px solid #e8e6dd; }
    .wr-nur-hist-eyebrow {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px; letter-spacing: 0.18em;
      color: #9c7440; text-transform: uppercase;
      margin-bottom: 6px; font-weight: 600;
    }
    .wr-nur-hist-title { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
    .wr-nur-hist-body-scroll {
      flex: 1; overflow-y: auto;
      padding: 16px 28px 26px;
    }

    .wr-nur-hist-row {
      padding: 14px 0;
      border-bottom: 1px solid #ece9dd;
    }
    .wr-nur-hist-row:last-child { border-bottom: 0; }
    .wr-nur-hist-meta {
      display: flex; gap: 10px; align-items: center;
      flex-wrap: wrap; margin-bottom: 4px;
    }
    .wr-nur-hist-pill {
      font-size: 10px; font-weight: 600;
      letter-spacing: 0.04em; text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px;
      font-family: 'JetBrains Mono', monospace;
    }
    .wr-nur-hist-pill.sent    { background: #f1e7d3; color: #7d5c31; }
    .wr-nur-hist-pill.skipped { background: #f0f0f0; color: #666; }
    .wr-nur-hist-pill.failed  { background: #fbe6e6; color: #8a2a2a; }
    .wr-nur-hist-pill.queued  { background: #fff4d4; color: #7a5a10; }
    .wr-nur-hist-pill.gray    { background: #f0f0f0; color: #888; }
    .wr-nur-hist-date  { font-size: 12px; color: #888; }
    .wr-nur-hist-phase { font-size: 11px; color: #aaa; font-family: 'JetBrains Mono', monospace; }
    .wr-nur-hist-subject {
      font-size: 14px; font-weight: 600;
      color: #33281c; margin-bottom: 4px;
    }
    .wr-nur-hist-extra {
      font-size: 12px; color: #888; margin-top: 2px;
    }
    .wr-nur-hist-extra.error { color: #b91c1c; }
    .wr-nur-hist-body-btn {
      background: transparent; border: 0; padding: 4px 0;
      font-size: 12px; color: #9c7440; cursor: pointer;
      font-family: inherit; font-weight: 600;
    }
    .wr-nur-hist-body-btn:hover { color: #7d5c31; }
    .wr-nur-hist-body {
      display: none;
      margin-top: 8px; padding: 12px 14px;
      background: #faf8f3; border-radius: 8px;
      font-size: 13px; line-height: 1.55;
      color: #353535; white-space: pre-wrap; word-wrap: break-word;
    }
  `;
  document.head.appendChild(style);
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function showFatal(msg) {
  document.getElementById('wrContent').innerHTML = `<div class="wr-error">${escapeHtml(msg)}</div>`;
}

function getLatestSlug(proposal) {
  const pubs = proposal?.published_proposals;
  if (!Array.isArray(pubs) || pubs.length === 0) return null;
  const sorted = [...pubs].sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));
  return sorted[0]?.slug || null;
}

function getDisplayAddress(proposal) {
  return proposal?.address || proposal?.project_address || 'Untitled proposal';
}

function formatBidShort(amount) {
  if (amount >= 1000) return '$' + Math.round(amount / 1000) + 'K';
  return '$' + amount.toFixed(0);
}
function formatBidFull(amount) {
  return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function formatDiscountRemaining(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatMessageTime(iso) {
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

function formatRelativeShort(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
