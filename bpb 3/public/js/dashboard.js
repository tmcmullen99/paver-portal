// Sprint 6.4 + Sprint 7 — Designer Dashboard (Pipeline Command Center)
//
// Sprint 7 addition: + New proposal now goes through a client-first modal.
// Either pick an existing client (search by name/email/address) or create a
// new one. Both paths atomically:
//   1. (new client only) Insert into clients
//   2. Insert into proposals with client_name/email/phone/address copied
//   3. Insert into client_proposals link
//   4. Redirect to /editor?id=...
//
// SPRINT 1 (Decouple): this page has ONE data scope for EVERYONE —
// proposals where owner_user_id = current user. No role branches, no
// master bypass, no "Switch account" button. Masters use this page the
// same way designers do (their own pipeline + proposal creation); the
// company-wide view lives exclusively in /admin/. The only role-aware
// element left is a nav LINK to /admin/ shown to masters — a link, not
// data, so nothing can leak.

import { supabase } from './supabase-client.js';
import { applyBranding } from './branding.js';
import { getProposalEngagementBulk, formatRelativeTime } from './engagement-utils.js';

const banner = document.getElementById('ddBanner');
const userName = document.getElementById('ddUserName');
const signoutBtn = document.getElementById('ddSignoutBtn');
const newBtn = document.getElementById('ddNewBtn');
const navReports = document.getElementById('ddNavReports');
const navDesigns = document.getElementById('ddNavDesigns');
const statRow = document.getElementById('ddStatRow');
const funnelStages = document.getElementById('ddFunnelStages');
const stageTitle = document.getElementById('ddStageTitle');
const stageMeta = document.getElementById('ddStageMeta');
const stageCards = document.getElementById('ddStageCards');

let currentProfile = null;
let allProposals = [];
let classifiedDeals = [];
let activeStage = 'engaged';

// Sprint 7 modal state
let clientsCache = null;
let modalState = { open: false, mode: 'existing', selectedClientId: null };

const STAGES = [
  { key: 'draft',   label: 'Draft' },
  { key: 'sent',    label: 'Sent' },
  { key: 'viewed',  label: 'Viewed' },
  { key: 'engaged', label: 'Engaged' },
  { key: 'signed',  label: 'Signed' },
];

(async function bootstrap() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    // Staff sign-in lives at /login.html (the /account/ signin page is
    // the homeowner-client flow — sending staff there was part of the
    // pre-Sprint-1 cross-pollination).
    window.location.replace('/login.html?redirect=%2Fdashboard');
    return;
  }

  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('id, role, display_name, email, is_active')
    .eq('id', session.user.id)
    .maybeSingle();

  if (profErr || !profile) {
    showError('Could not load your profile: ' + (profErr ? profErr.message : 'no profile found'));
    return;
  }
  if (!profile.is_active) {
    showError('Your account is inactive. Contact your admin.');
    return;
  }

  currentProfile = profile;
  renderUserChrome(profile);
  ensureModalStyles();
  attachEventListeners();
  await loadAndRender();
})();

function renderUserChrome(profile) {
  const name = profile.display_name || profile.email || 'You';
  userName.textContent = name;
  applyBranding({ pageTitle: 'Pipeline' });

  // Masters get a link to the admin console in the sidebar. This is the
  // ONLY role-conditional element on the page, and it's pure navigation —
  // it renders no data. The link is hidden in the HTML by default and
  // revealed here, so a designer never sees it even for a frame.
  if (profile.role === 'master') {
    const adminLink = document.getElementById('ddNavAdmin');
    if (adminLink) adminLink.hidden = false;
  }
}

function attachEventListeners() {
  signoutBtn.addEventListener('click', async () => {
    try { await supabase.auth.signOut(); } catch (_) {}
    window.location.replace('/login.html');
  });

  newBtn.addEventListener('click', openNewProposalModal);

  funnelStages.querySelectorAll('.dd-fs').forEach(btn => {
    btn.addEventListener('click', () => setActiveStage(btn.dataset.stage));
  });

  navReports.addEventListener('click', () => {
    alert('Reports view is coming in a future sprint. For now use Engagement (live activity per proposal) or Pipeline (current funnel).');
  });
  navDesigns.addEventListener('click', () => {
    alert('Designs gallery is coming in a future sprint. It will show 3D renderings and material selections from past completed projects.');
  });
}

async function loadAndRender() {
  banner.innerHTML = '';

  // SPRINT 1: unconditional owner scope. There is deliberately no role
  // branch here — if a master wants the company-wide pipeline, that view
  // lives at /admin/pipeline.html. Keeping this page single-scope is what
  // makes designer-side data leaks structurally impossible.
  const q = supabase
    .from('proposals')
    .select('id, client_name, project_address, project_city, project_label, status, bid_total_amount, owner_user_id, updated_at, created_at')
    .eq('owner_user_id', currentProfile.id)
    .order('updated_at', { ascending: false });

  const { data: proposals, error } = await q;
  if (error) {
    showError('Could not load proposals: ' + error.message);
    return;
  }

  allProposals = proposals || [];

  if (allProposals.length === 0) {
    renderEmptyDashboard();
    return;
  }

  const proposalIds = allProposals.map(p => p.id);

  const [engagementMap, pubMap, subMap, redesignMap] = await Promise.all([
    getProposalEngagementBulk(proposalIds),
    fetchPublishedMap(proposalIds),
    fetchPendingSubstitutions(proposalIds),
    fetchPendingRedesigns(proposalIds),
  ]);

  classifiedDeals = allProposals.map(p => {
    const eng = engagementMap.get(p.id);
    const totalEvents = eng ? eng.totalEvents : 0;
    const lastViewMs = eng && eng.lastView ? new Date(eng.lastView).getTime() : 0;
    const hasPub = pubMap.has(p.id);
    const pendingSub = subMap.has(p.id);
    const pendingRedesign = redesignMap.has(p.id);

    let stage;
    if (p.status === 'signed' || p.status === 'completed') stage = 'signed';
    else if (p.status === 'archived') stage = null;
    else if (pendingSub || pendingRedesign || totalEvents >= 4) stage = 'engaged';
    else if (totalEvents > 0) stage = 'viewed';
    else if (hasPub) stage = 'sent';
    else stage = 'draft';

    return {
      proposal: p,
      stage,
      engagement: eng || { totalEvents: 0, lastView: null, isLive: false },
      pendingSub,
      pendingRedesign,
      lastActivityMs: lastViewMs,
    };
  }).filter(d => d.stage !== null);

  renderStats();
  renderFunnel();
  renderStageCards();
}

function renderStats() {
  const open = classifiedDeals.filter(d => d.stage !== 'signed').reduce((sum, d) => sum + Number(d.proposal.bid_total_amount || 0), 0);
  const closed = classifiedDeals.filter(d => d.stage === 'signed').reduce((sum, d) => sum + Number(d.proposal.bid_total_amount || 0), 0);
  const signedCount = classifiedDeals.filter(d => d.stage === 'signed').length;
  const totalCount = classifiedDeals.length;
  const winRate = totalCount > 0 ? Math.round((signedCount / totalCount) * 100) : 0;
  const activeCount = classifiedDeals.filter(d => d.stage !== 'signed').length;

  statRow.innerHTML = `
    <div class="dd-stat-card"><div class="dd-stat-label">Open value</div><div class="dd-stat-value">${formatUSD(open)}</div><div class="dd-stat-detail">${activeCount} active deal${activeCount === 1 ? '' : 's'}</div></div>
    <div class="dd-stat-card"><div class="dd-stat-label">Closed total</div><div class="dd-stat-value">${formatUSD(closed)}</div><div class="dd-stat-detail">${signedCount} signed deal${signedCount === 1 ? '' : 's'}</div></div>
    <div class="dd-stat-card"><div class="dd-stat-label">Win rate</div><div class="dd-stat-value">${winRate}%</div><div class="dd-stat-detail">${signedCount} of ${totalCount} total</div></div>
    <div class="dd-stat-card"><div class="dd-stat-label">Active deals</div><div class="dd-stat-value">${activeCount}</div><div class="dd-stat-detail">${totalCount - activeCount} closed</div></div>
  `;
}

function renderFunnel() {
  const counts = { draft: 0, sent: 0, viewed: 0, engaged: 0, signed: 0 };
  const amounts = { draft: 0, sent: 0, viewed: 0, engaged: 0, signed: 0 };

  for (const d of classifiedDeals) {
    counts[d.stage]++;
    amounts[d.stage] += Number(d.proposal.bid_total_amount || 0);
  }

  STAGES.forEach(s => {
    const btn = funnelStages.querySelector(`.dd-fs[data-stage="${s.key}"]`);
    if (!btn) return;
    btn.querySelector('.dd-fs-count').textContent = counts[s.key];
    btn.querySelector('.dd-fs-amount').textContent = amounts[s.key] > 0 ? formatUSD(amounts[s.key]) : '$0';
    btn.classList.toggle('active', s.key === activeStage);
  });
}

function renderStageCards() {
  const stageDeals = classifiedDeals.filter(d => d.stage === activeStage).sort(sortDealsForStage);
  const stageDef = STAGES.find(s => s.key === activeStage);
  stageTitle.textContent = stageDef ? stageDef.label : activeStage;

  const totalAmount = stageDeals.reduce((s, d) => s + Number(d.proposal.bid_total_amount || 0), 0);
  const sortDescription = activeStage === 'engaged' || activeStage === 'viewed'
    ? 'sorted by engagement heat'
    : activeStage === 'signed'
      ? 'sorted by amount'
      : 'sorted by last update';
  stageMeta.textContent = `${stageDeals.length} deal${stageDeals.length === 1 ? '' : 's'} · ${formatUSD(totalAmount)} total · ${sortDescription}`;

  if (stageDeals.length === 0) {
    stageCards.innerHTML = `<div class="dd-stage-empty">${emptyMessageFor(activeStage)}</div>`;
    return;
  }

  stageCards.innerHTML = `<div class="dd-stage-cards">${stageDeals.map(renderDealCard).join('')}</div>`;
  stageCards.querySelectorAll('.dd-deal').forEach(el => {
    const id = el.dataset.proposalId;
    el.addEventListener('click', () => { window.location.href = `/editor?id=${id}`; });
  });
}

function renderDealCard(deal) {
  const p = deal.proposal;
  const displayName = p.client_name || p.project_label || p.project_address || 'Untitled draft';
  const addressBits = [p.project_address, p.project_city].filter(Boolean);
  const addressLine = addressBits.length ? addressBits.join(', ') : '';
  const amount = formatUSD(Number(p.bid_total_amount || 0));
  const eng = deal.engagement;

  let engClass = 'none';
  let engText = 'No views yet';
  if (eng.isLive) { engClass = 'hot'; engText = `🔥 viewing now`; }
  else if (eng.totalEvents >= 8) { engClass = 'hot'; engText = `🔥 ${eng.totalEvents} views`; }
  else if (eng.totalEvents >= 1) {
    engClass = eng.totalEvents >= 4 ? 'warm' : 'cold';
    engText = `${eng.totalEvents} view${eng.totalEvents === 1 ? '' : 's'}`;
  }

  let recency = '';
  if (deal.lastActivityMs > 0) recency = 'last view ' + formatRelativeTime(eng.lastView);
  else if (deal.stage === 'draft') recency = 'not yet sent';
  else if (deal.stage === 'sent') recency = 'sent · no views';

  const pills = [];
  if (deal.pendingSub) pills.push('<span class="dd-deal-pill sub">Sub pending</span>');
  if (deal.pendingRedesign) pills.push('<span class="dd-deal-pill redesign">Redesign pending</span>');

  const isHot = deal.stage === 'engaged' && (eng.totalEvents >= 8 || eng.isLive);
  const hotClass = isHot ? ' hot' : '';

  return `
    <button class="dd-deal${hotClass}" data-proposal-id="${escapeAttr(p.id)}">
      <div class="dd-deal-name">${escapeHtml(displayName)}</div>
      <div class="dd-deal-addr">${escapeHtml(addressLine || '—')}</div>
      <div class="dd-deal-mid">
        <div class="dd-deal-amount">${amount}</div>
        <div class="dd-deal-engagement ${engClass}">${engText}</div>
      </div>
      <div class="dd-deal-meta">
        ${pills.join('')}
        ${recency ? `<span>${escapeHtml(recency)}</span>` : ''}
      </div>
    </button>
  `;
}

function sortDealsForStage(a, b) {
  if (activeStage === 'engaged' || activeStage === 'viewed') {
    if (b.engagement.totalEvents !== a.engagement.totalEvents) return b.engagement.totalEvents - a.engagement.totalEvents;
    return b.lastActivityMs - a.lastActivityMs;
  }
  if (activeStage === 'signed') return Number(b.proposal.bid_total_amount || 0) - Number(a.proposal.bid_total_amount || 0);
  const aUpdated = new Date(a.proposal.updated_at || a.proposal.created_at).getTime();
  const bUpdated = new Date(b.proposal.updated_at || b.proposal.created_at).getTime();
  return bUpdated - aUpdated;
}

function emptyMessageFor(stage) {
  switch (stage) {
    case 'draft':   return 'No drafts. Click <strong>+ New proposal</strong> in the sidebar to start one.';
    case 'sent':    return 'No proposals sitting in <em>sent</em>. Sent proposals show up here once published, before the homeowner views them.';
    case 'viewed':  return 'No proposals in <em>viewed</em>. Once a homeowner views a sent proposal but engages lightly (1–3 views), they show up here.';
    case 'engaged': return 'No engaged deals yet. Deals show up here when the homeowner views the page 4+ times, submits a substitution, or requests a redesign.';
    case 'signed':  return 'No signed deals yet.';
    default:        return 'No deals in this stage.';
  }
}

function setActiveStage(stage) {
  activeStage = stage;
  funnelStages.querySelectorAll('.dd-fs').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.stage === stage);
  });
  renderStageCards();
}

function renderEmptyDashboard() {
  // Single-scope page: everyone gets the same welcome state.
  const isDesigner = true;

  statRow.innerHTML = `
    <div class="dd-stat-card"><div class="dd-stat-label">Open value</div><div class="dd-stat-value">$0</div><div class="dd-stat-detail">0 active deals</div></div>
    <div class="dd-stat-card"><div class="dd-stat-label">Closed total</div><div class="dd-stat-value">$0</div><div class="dd-stat-detail">0 signed deals</div></div>
    <div class="dd-stat-card"><div class="dd-stat-label">Win rate</div><div class="dd-stat-value">—</div><div class="dd-stat-detail">no deals yet</div></div>
    <div class="dd-stat-card"><div class="dd-stat-label">Active deals</div><div class="dd-stat-value">0</div><div class="dd-stat-detail">—</div></div>
  `;

  STAGES.forEach(s => {
    const btn = funnelStages.querySelector(`.dd-fs[data-stage="${s.key}"]`);
    if (btn) {
      btn.querySelector('.dd-fs-count').textContent = '0';
      btn.querySelector('.dd-fs-amount').textContent = '$0';
    }
  });

  stageTitle.textContent = isDesigner ? 'Welcome' : 'No proposals';
  stageMeta.textContent = '';
  stageCards.innerHTML = `
    <div class="dd-stage-empty">
      <div style="font-size: 32px; margin-bottom: 12px; opacity: 0.4;">📐</div>
      <div style="font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 8px;">
        ${isDesigner ? "You don't have any proposals yet" : 'No proposals in the system yet'}
      </div>
      <div style="margin-bottom: 18px; max-width: 420px; margin-left: auto; margin-right: auto; line-height: 1.6;">
        ${isDesigner
          ? "Click <strong>+ New proposal</strong> in the sidebar to start your first one."
          : "Once designers create proposals, they'll all show up here for you to oversee."}
      </div>
      ${isDesigner ? '<button class="btn primary" id="ddEmptyNewBtn">Create your first proposal →</button>' : ''}
    </div>
  `;
  const emptyBtn = document.getElementById('ddEmptyNewBtn');
  if (emptyBtn) emptyBtn.addEventListener('click', openNewProposalModal);
}

async function fetchPublishedMap(proposalIds) {
  const map = new Map();
  if (proposalIds.length === 0) return map;
  const { data, error } = await supabase
    .from('published_proposals')
    .select('proposal_id')
    .in('proposal_id', proposalIds);
  if (error) { console.warn('[dashboard] published_proposals fetch failed:', error); return map; }
  (data || []).forEach(row => map.set(row.proposal_id, true));
  return map;
}

async function fetchPendingSubstitutions(proposalIds) {
  const map = new Map();
  if (proposalIds.length === 0) return map;
  const { data, error } = await supabase
    .from('proposal_substitutions')
    .select('proposal_id')
    .in('proposal_id', proposalIds)
    .eq('status', 'submitted');
  if (error) { console.warn('[dashboard] proposal_substitutions fetch failed:', error); return map; }
  (data || []).forEach(row => map.set(row.proposal_id, true));
  return map;
}

async function fetchPendingRedesigns(proposalIds) {
  const map = new Map();
  if (proposalIds.length === 0) return map;
  const { data, error } = await supabase
    .from('proposal_redesign_requests')
    .select('proposal_id')
    .in('proposal_id', proposalIds)
    .eq('status', 'submitted');
  if (error) { console.warn('[dashboard] proposal_redesign_requests fetch failed:', error); return map; }
  (data || []).forEach(row => map.set(row.proposal_id, true));
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
// SPRINT 7 — New Proposal modal
// ═══════════════════════════════════════════════════════════════════════════

function ensureModalStyles() {
  if (document.getElementById('dd-npm-styles')) return;
  const style = document.createElement('style');
  style.id = 'dd-npm-styles';
  style.textContent = `
    .dd-npm-overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(26, 31, 46, 0.55);
      display: none; align-items: flex-start; justify-content: center;
      padding: 56px 20px 20px;
      overflow-y: auto;
      animation: ddNpmFade 0.18s ease-out;
    }
    @keyframes ddNpmFade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes ddNpmSlide { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .dd-npm-modal {
      background: #fff;
      border-radius: 14px;
      max-width: 560px; width: 100%;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);
      animation: ddNpmSlide 0.22s ease-out;
      color: var(--bp-charcoal);
      overflow: hidden;
      display: flex; flex-direction: column;
      max-height: calc(100vh - 80px);
    }
    .dd-npm-head {
      padding: 22px 28px 16px;
      border-bottom: 1px solid var(--rule-soft);
    }
    .dd-npm-eyebrow {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px; letter-spacing: 0.18em;
      color: var(--bp-green); text-transform: uppercase;
      margin-bottom: 6px; font-weight: 600;
    }
    .dd-npm-title { font-size: 20px; font-weight: 600; letter-spacing: -0.012em; margin: 0; }
    .dd-npm-close {
      position: absolute; top: 14px; right: 14px;
      width: 32px; height: 32px;
      background: transparent; border: 0; cursor: pointer;
      font-size: 18px; color: var(--text-muted);
      border-radius: 6px;
      transition: background 0.12s, color 0.12s;
    }
    .dd-npm-close:hover { background: var(--bp-cream-shade); color: var(--text); }
    .dd-npm-tabs {
      display: flex; gap: 4px;
      padding: 0 28px;
      border-bottom: 1px solid var(--rule-soft);
    }
    .dd-npm-tab {
      background: transparent; border: 0;
      padding: 12px 16px;
      font: inherit; font-size: 13px; font-weight: 600;
      color: var(--text-muted); cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color 0.12s, border-color 0.12s;
    }
    .dd-npm-tab:hover { color: var(--text); }
    .dd-npm-tab.active { color: var(--bp-green); border-bottom-color: var(--bp-green); }
    .dd-npm-body {
      padding: 22px 28px;
      overflow-y: auto;
      flex: 1;
    }
    .dd-npm-search-wrap { position: relative; margin-bottom: 12px; }
    .dd-npm-search {
      width: 100%; font-family: inherit;
      font-size: 14px; padding: 10px 14px;
      border: 1px solid var(--rule);
      border-radius: 8px; background: var(--bp-cream);
      color: var(--text);
      transition: border-color 0.15s, background 0.15s;
    }
    .dd-npm-search:focus {
      outline: none; border-color: var(--bp-green);
      background: #fff;
      box-shadow: 0 0 0 3px var(--bp-green-soft);
    }
    .dd-npm-list {
      display: flex; flex-direction: column; gap: 4px;
      max-height: 280px; overflow-y: auto;
      margin-bottom: 18px;
      padding: 2px;
    }
    .dd-npm-list-empty {
      padding: 32px 16px; text-align: center;
      color: var(--text-muted); font-size: 13px;
      background: var(--bp-cream); border: 1px dashed var(--rule);
      border-radius: 8px;
    }
    .dd-npm-client-item {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 10px 12px; border-radius: 8px;
      cursor: pointer; transition: background 0.12s, box-shadow 0.12s;
      background: transparent; border: 1px solid transparent;
      text-align: left; font-family: inherit; width: 100%;
    }
    .dd-npm-client-item:hover { background: var(--bp-cream-shade); }
    .dd-npm-client-item.selected {
      background: var(--bp-green-soft);
      border-color: var(--bp-green);
    }
    .dd-npm-client-info { flex: 1; min-width: 0; }
    .dd-npm-client-name { font-weight: 600; font-size: 14px; color: var(--text); }
    .dd-npm-client-meta {
      font-size: 12px; color: var(--text-muted);
      margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .dd-npm-radio {
      width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid var(--rule);
      flex-shrink: 0; margin-top: 1px;
      transition: border-color 0.12s, background 0.12s;
    }
    .dd-npm-client-item.selected .dd-npm-radio {
      border-color: var(--bp-green);
      background: var(--bp-green);
      box-shadow: inset 0 0 0 2px #fff;
    }

    .dd-npm-field { margin-bottom: 14px; }
    .dd-npm-field label {
      display: block;
      font-size: 11px; font-weight: 600;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 5px;
    }
    .dd-npm-field input {
      width: 100%; font-family: inherit;
      font-size: 14px; padding: 9px 12px;
      border: 1px solid var(--rule);
      border-radius: 6px;
      background: #fff; color: var(--text);
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .dd-npm-field input:focus {
      outline: none; border-color: var(--bp-green);
      box-shadow: 0 0 0 3px var(--bp-green-soft);
    }
    .dd-npm-row { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; }

    .dd-npm-error {
      background: #fbeeee; color: #b91c1c;
      border-left: 3px solid #b91c1c;
      padding: 10px 14px; border-radius: 6px;
      font-size: 13px; line-height: 1.5;
      margin-bottom: 14px;
    }
    .dd-npm-error.hidden { display: none; }
    .dd-npm-info {
      background: var(--bp-green-soft);
      color: var(--bp-green-dark);
      border-left: 3px solid var(--bp-green);
      padding: 10px 14px; border-radius: 6px;
      font-size: 12px; line-height: 1.5;
      margin-bottom: 14px;
    }

    .dd-npm-foot {
      padding: 16px 28px;
      border-top: 1px solid var(--rule-soft);
      display: flex; justify-content: flex-end; gap: 10px;
      background: var(--bp-cream);
    }
    .dd-npm-btn {
      font: inherit; font-size: 14px; font-weight: 600;
      padding: 9px 18px; border-radius: 8px;
      border: 1px solid transparent; cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s, opacity 0.15s;
    }
    .dd-npm-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .dd-npm-cancel {
      background: #fff; color: var(--text);
      border-color: var(--rule);
    }
    .dd-npm-cancel:hover:not(:disabled) { background: var(--bp-cream-shade); border-color: var(--text-muted); }
    .dd-npm-create {
      background: var(--bp-green); color: #fff;
      box-shadow: 0 4px 12px rgba(93, 126, 105, 0.22);
    }
    .dd-npm-create:hover:not(:disabled) { background: var(--bp-green-dark); transform: translateY(-1px); }
  `;
  document.head.appendChild(style);
}

function getOrBuildModal() {
  let overlay = document.getElementById('ddNpmOverlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'ddNpmOverlay';
  overlay.className = 'dd-npm-overlay';
  overlay.innerHTML = `
    <div class="dd-npm-modal" role="dialog" aria-modal="true" aria-labelledby="ddNpmTitle" style="position: relative;">
      <button type="button" class="dd-npm-close" aria-label="Close">×</button>
      <div class="dd-npm-head">
        <div class="dd-npm-eyebrow">New project</div>
        <h2 id="ddNpmTitle" class="dd-npm-title">Who is this proposal for?</h2>
      </div>
      <div class="dd-npm-tabs">
        <button class="dd-npm-tab active" data-mode="existing">Pick existing client</button>
        <button class="dd-npm-tab" data-mode="new">New client</button>
      </div>
      <div class="dd-npm-body" id="ddNpmBody"></div>
      <div class="dd-npm-foot">
        <button type="button" class="dd-npm-btn dd-npm-cancel">Cancel</button>
        <button type="button" class="dd-npm-btn dd-npm-create" id="ddNpmCreateBtn">Create proposal</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Wire up
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeNewProposalModal(); });
  overlay.querySelector('.dd-npm-close').addEventListener('click', closeNewProposalModal);
  overlay.querySelector('.dd-npm-cancel').addEventListener('click', closeNewProposalModal);

  overlay.querySelectorAll('.dd-npm-tab').forEach(tab => {
    tab.addEventListener('click', () => setModalMode(tab.dataset.mode));
  });

  overlay.querySelector('#ddNpmCreateBtn').addEventListener('click', submitNewProposal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalState.open) closeNewProposalModal();
  });

  return overlay;
}

async function openNewProposalModal() {
  const overlay = getOrBuildModal();
  modalState = { open: true, mode: 'existing', selectedClientId: null };
  overlay.style.display = 'flex';

  // Default tab decision: if no clients exist yet, jump straight to the
  // "New client" tab — there's nothing to pick from.
  const clients = await fetchClientsCache();
  if (clients.length === 0) setModalMode('new');
  else setModalMode('existing');
}

function closeNewProposalModal() {
  const overlay = document.getElementById('ddNpmOverlay');
  if (overlay) overlay.style.display = 'none';
  modalState.open = false;
}

function setModalMode(mode) {
  modalState.mode = mode;
  modalState.selectedClientId = null;

  const overlay = document.getElementById('ddNpmOverlay');
  if (!overlay) return;

  overlay.querySelectorAll('.dd-npm-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });

  const body = overlay.querySelector('#ddNpmBody');
  if (mode === 'existing') {
    body.innerHTML = `
      <div class="dd-npm-search-wrap">
        <input type="text" class="dd-npm-search" id="ddNpmSearch" placeholder="Search by name, email, or address…" autocomplete="off">
      </div>
      <div class="dd-npm-list" id="ddNpmList"></div>
      <div class="dd-npm-error hidden" id="ddNpmError"></div>
      <div class="dd-npm-row">
        <div class="dd-npm-field">
          <label>Project address</label>
          <input type="text" id="ddNpmProjAddr" placeholder="Pick a client first…" disabled>
        </div>
        <div class="dd-npm-field">
          <label>City</label>
          <input type="text" id="ddNpmProjCity" placeholder="—" disabled>
        </div>
      </div>
    `;
    overlay.querySelector('#ddNpmSearch').addEventListener('input', renderClientList);
    renderClientList();
  } else {
    body.innerHTML = `
      <div class="dd-npm-info">Creating a new client. Their email must not already exist in your system.</div>
      <div class="dd-npm-error hidden" id="ddNpmError"></div>
      <div class="dd-npm-field">
        <label>Client name</label>
        <input type="text" id="ddNpmName" placeholder="Jane Doe">
      </div>
      <div class="dd-npm-row">
        <div class="dd-npm-field">
          <label>Email</label>
          <input type="email" id="ddNpmEmail" placeholder="jane@example.com">
        </div>
        <div class="dd-npm-field">
          <label>Phone</label>
          <input type="tel" id="ddNpmPhone" placeholder="(415) 555-0100">
        </div>
      </div>
      <div class="dd-npm-row">
        <div class="dd-npm-field">
          <label>Project address</label>
          <input type="text" id="ddNpmProjAddr" placeholder="123 Example Ln">
        </div>
        <div class="dd-npm-field">
          <label>City</label>
          <input type="text" id="ddNpmProjCity" placeholder="Los Altos">
        </div>
      </div>
    `;
    setTimeout(() => {
      const nameEl = document.getElementById('ddNpmName');
      if (nameEl) nameEl.focus();
    }, 50);
  }
}

async function fetchClientsCache() {
  if (clientsCache) return clientsCache;
  const { data, error } = await supabase
    .from('clients')
    .select('id, name, email, phone, address')
    .order('name');
  if (error) {
    console.warn('[dashboard] clients fetch failed:', error);
    return [];
  }
  clientsCache = data || [];
  return clientsCache;
}

function renderClientList() {
  const overlay = document.getElementById('ddNpmOverlay');
  const list = overlay.querySelector('#ddNpmList');
  const search = overlay.querySelector('#ddNpmSearch');
  const q = (search ? search.value : '').trim().toLowerCase();

  const clients = clientsCache || [];
  const filtered = q
    ? clients.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.address || '').toLowerCase().includes(q)
      )
    : clients;

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="dd-npm-list-empty">
        ${q ? 'No clients match "' + escapeHtml(q) + '".' : 'No clients yet. Switch to the New client tab.'}
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map(c => `
    <button class="dd-npm-client-item" data-client-id="${escapeAttr(c.id)}">
      <div class="dd-npm-radio"></div>
      <div class="dd-npm-client-info">
        <div class="dd-npm-client-name">${escapeHtml(c.name || '(unnamed)')}</div>
        <div class="dd-npm-client-meta">
          ${escapeHtml(c.email || '')}${c.address ? ' · ' + escapeHtml(c.address) : ''}
        </div>
      </div>
    </button>
  `).join('');

  list.querySelectorAll('.dd-npm-client-item').forEach(el => {
    el.addEventListener('click', () => pickClient(el.dataset.clientId));
  });
}

function pickClient(clientId) {
  modalState.selectedClientId = clientId;
  const overlay = document.getElementById('ddNpmOverlay');
  overlay.querySelectorAll('.dd-npm-client-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.clientId === clientId);
  });

  const client = (clientsCache || []).find(c => c.id === clientId);
  const projAddr = overlay.querySelector('#ddNpmProjAddr');
  const projCity = overlay.querySelector('#ddNpmProjCity');

  // Try to split client.address into "street, city". If only one piece,
  // put it in addr and leave city blank for the user to fill in.
  if (client && client.address) {
    const parts = client.address.split(',').map(s => s.trim());
    if (parts.length >= 2) {
      projAddr.value = parts[0];
      projCity.value = parts.slice(1).join(', ');
    } else {
      projAddr.value = parts[0] || '';
      projCity.value = '';
    }
  } else {
    projAddr.value = '';
    projCity.value = '';
  }

  projAddr.disabled = false;
  projCity.disabled = false;
  projAddr.placeholder = '123 Example Ln';
  projCity.placeholder = 'Los Altos';
}

async function submitNewProposal() {
  const overlay = document.getElementById('ddNpmOverlay');
  const createBtn = overlay.querySelector('#ddNpmCreateBtn');
  const errEl = overlay.querySelector('#ddNpmError');
  errEl.classList.add('hidden');

  if (modalState.mode === 'existing') {
    if (!modalState.selectedClientId) {
      showModalError('Pick a client to continue.');
      return;
    }
  }

  createBtn.disabled = true;
  const origText = createBtn.textContent;
  createBtn.textContent = 'Creating…';

  try {
    let proposalId;
    if (modalState.mode === 'existing') proposalId = await createWithExistingClient(overlay);
    else proposalId = await createWithNewClient(overlay);

    if (proposalId) window.location.href = `/editor?id=${proposalId}`;
  } catch (e) {
    console.error('[dashboard] submit failed:', e);
    showModalError('Something went wrong: ' + (e.message || e));
    createBtn.disabled = false;
    createBtn.textContent = origText;
  }
}

async function createWithExistingClient(overlay) {
  const client = (clientsCache || []).find(c => c.id === modalState.selectedClientId);
  if (!client) throw new Error('Client not found in cache. Refresh and try again.');

  const projAddr = overlay.querySelector('#ddNpmProjAddr').value.trim();
  const projCity = overlay.querySelector('#ddNpmProjCity').value.trim();

  if (!projAddr) {
    showModalError('Project address is required.');
    return null;
  }

  const payload = {
    status: 'draft',
    proposal_type: 'bid',
    project_state: 'CA',
    client_name: client.name,
    client_email: client.email,
    client_phone: client.phone,
    project_address: projAddr,
    project_city: projCity || null,
    owner_user_id: currentProfile.id,
  };

  const { data: proposal, error } = await supabase
    .from('proposals').insert(payload).select('id').single();
  if (error) throw new Error('Could not create proposal: ' + error.message);

  const { error: linkErr } = await supabase
    .from('client_proposals')
    .insert({ client_id: client.id, proposal_id: proposal.id, status: 'draft' });
  if (linkErr) console.warn('[dashboard] client_proposals link failed:', linkErr);

  return proposal.id;
}

async function createWithNewClient(overlay) {
  const name = overlay.querySelector('#ddNpmName').value.trim();
  const email = overlay.querySelector('#ddNpmEmail').value.trim().toLowerCase();
  const phone = overlay.querySelector('#ddNpmPhone').value.trim();
  const projAddr = overlay.querySelector('#ddNpmProjAddr').value.trim();
  const projCity = overlay.querySelector('#ddNpmProjCity').value.trim();

  if (!name) { showModalError('Client name is required.'); return null; }
  if (!email) { showModalError('Email is required.'); return null; }
  if (!projAddr) { showModalError('Project address is required.'); return null; }

  const fullAddress = projCity ? `${projAddr}, ${projCity}` : projAddr;
  const referCode = 'BPB-' + Math.random().toString(36).substring(2, 10).toUpperCase();

  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .insert({
      name, email, phone: phone || null,
      address: fullAddress,
      created_by: currentProfile.id,
      refer_code: referCode,
    })
    .select('id')
    .single();

  if (clientErr) {
    if (clientErr.message && clientErr.message.toLowerCase().includes('duplicate')) {
      showModalError('A client with this email already exists. Switch to "Pick existing client" and search for them.');
      return null;
    }
    throw new Error('Could not create client: ' + clientErr.message);
  }

  // Invalidate cache so next open includes the new client
  clientsCache = null;

  const { data: proposal, error: propErr } = await supabase
    .from('proposals').insert({
      status: 'draft', proposal_type: 'bid', project_state: 'CA',
      client_name: name, client_email: email, client_phone: phone || null,
      project_address: projAddr,
      project_city: projCity || null,
      owner_user_id: currentProfile.id,
    }).select('id').single();
  if (propErr) throw new Error('Client created, but proposal insert failed: ' + propErr.message);

  const { error: linkErr } = await supabase
    .from('client_proposals')
    .insert({ client_id: client.id, proposal_id: proposal.id, status: 'draft' });
  if (linkErr) console.warn('[dashboard] client_proposals link failed:', linkErr);

  return proposal.id;
}

function showModalError(msg) {
  const overlay = document.getElementById('ddNpmOverlay');
  if (!overlay) return;
  const errEl = overlay.querySelector('#ddNpmError');
  if (errEl) {
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Banners / errors / utilities
// ═══════════════════════════════════════════════════════════════════════════

function showError(msg) {
  banner.innerHTML = `<div class="dd-banner error">${escapeHtml(msg)}</div>`;
}

function formatUSD(value) {
  const n = Number(value) || 0;
  if (n === 0) return '$0';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2) + 'M';
  if (n >= 100_000) return '$' + Math.round(n / 1000) + 'K';
  if (n >= 10_000) return '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) { return escapeHtml(str); }
