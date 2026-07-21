// ═══════════════════════════════════════════════════════════════════════════
// /admin/admin-engagement.js — Phase 5D.1 + 5D.4
//
// Per-proposal engagement view. Loads from URL ?id=<proposal_uuid>, fetches
// the proposal metadata + full engagement summary + per-session breakdown +
// recent event timeline, and refreshes every 30 seconds for live presence.
//
// RLS already restricts SELECT on proposal_events to designer/master so
// direct supabase queries from the client are safe.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireDesigner } from '/js/auth-util.js';
import {
  getProposalEngagement,
  getProposalSessions,
  getProposalRecentEvents,
  formatRelativeTime,
  deviceIcon,
  deviceLabel,
} from '/js/engagement-utils.js';

const REFRESH_MS = 30_000;
const TIMELINE_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const params = new URLSearchParams(window.location.search);
const proposalId = params.get('id');
const content = document.getElementById('engagementContent');

let proposal = null;
let refreshTimer = null;

// ─── Bootstrap ──────────────────────────────────────────────────────────
(async function init() {
  if (!await requireDesigner()) return;

  if (!proposalId) {
    showError(
      'Missing proposal ID',
      'This page expects ?id=<uuid> in the URL. Open it from the Clients page or the dashboard.'
    );
    return;
  }
  if (!UUID_RE.test(proposalId)) {
    showError('Invalid proposal ID', 'The id parameter is not a valid UUID.');
    return;
  }

  await loadProposalMeta();
  if (!proposal) return; // showError already rendered

  await renderAll();

  // Auto-refresh for live presence + recent activity. Pause when the tab
  // isn't visible to avoid wasted queries.
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') renderAll();
  }, REFRESH_MS);
})();

async function loadProposalMeta() {
  // Pull a few fields useful in the header (address, slug, published date).
  // Note: the proposal table uses both `address` and `project_address`; pick
  // whichever is non-null. published_proposals is a 1:N child; latest first.
  const { data, error } = await supabase
    .from('proposals')
    .select(`id, address, project_address, project_city, status, created_at,
             published_proposals(id, slug, published_at)`)
    .eq('id', proposalId)
    .maybeSingle();

  if (error) {
    showError('Could not load proposal', error.message);
    return;
  }
  if (!data) {
    showError('Proposal not found', `No proposal exists with id ${proposalId}.`);
    return;
  }
  proposal = data;
}

// ─── Render ─────────────────────────────────────────────────────────────
async function renderAll() {
  if (!proposal) return;

  // Run the three queries in parallel — they share an index but distinct
  // SQL so concurrency is a small win.
  const [summary, sessions, events] = await Promise.all([
    getProposalEngagement(proposal.id),
    getProposalSessions(proposal.id),
    getProposalRecentEvents(proposal.id, TIMELINE_LIMIT),
  ]);

  content.innerHTML = `
    ${renderHeader(proposal)}
    ${renderRefreshRow()}
    ${renderPresence(summary)}
    ${renderStats(summary)}
    ${renderSplit(summary)}
    ${renderSessions(sessions)}
    ${renderTimeline(events)}
  `;

  // Wire up refresh button after innerHTML
  const refreshBtn = document.getElementById('engRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', renderAll);
}

function renderHeader(p) {
  const address = p.address || p.project_address || 'Untitled proposal';
  const slug = pickLatestSlug(p.published_proposals);
  const slugLink = slug
    ? `<a href="/p/${escapeAttr(slug)}" target="_blank" rel="noopener">/p/${escapeHtml(slug)} ↗</a>`
    : '<span class="eng-mono">Not published yet</span>';
  const eventsLink = `<a href="/admin/events.html">View raw event stream →</a>`;
  return `
    <div class="ash-intro">
      <div class="ash-eyebrow">Analytics · Engagement</div>
      <h1 class="ash-title">${escapeHtml(address)}</h1>
      <div class="eng-header-meta">
        ${slugLink}
        ${eventsLink}
      </div>
    </div>
  `;
}

function renderRefreshRow() {
  return `
    <div class="eng-refresh-row">
      <span>Auto-refreshes every 30s when tab is visible.</span>
      <button class="eng-refresh-btn" id="engRefreshBtn" type="button">Refresh now</button>
    </div>
  `;
}

function renderPresence(s) {
  if (s.totalEvents === 0) {
    return `
      <div class="eng-presence is-empty">
        <span class="eng-presence-dot"></span>
        No views yet — share the link to start tracking.
      </div>
    `;
  }
  if (s.isLive) {
    return `
      <div class="eng-presence is-live">
        <span class="eng-presence-dot"></span>
        👁 Active right now
      </div>
    `;
  }
  const lastT = new Date(s.lastView).getTime();
  const ageMs = Date.now() - lastT;
  const isRecent = ageMs < 24 * 60 * 60 * 1000;
  return `
    <div class="eng-presence ${isRecent ? 'is-recent' : 'is-stale'}">
      <span class="eng-presence-dot"></span>
      Last activity ${formatRelativeTime(s.lastView)}
    </div>
  `;
}

function renderStats(s) {
  if (s.totalEvents === 0) {
    return `
      <div class="eng-stats">
        ${statCard('0', 'Sessions', null, true)}
        ${statCard('0', 'Total events', null, true)}
        ${statCard('—', 'First view', null, true)}
        ${statCard('—', 'Last view', null, true)}
      </div>
    `;
  }
  return `
    <div class="eng-stats">
      ${statCard(s.sessions, 'Sessions', s.sessions === 1 ? 'one device' : 'distinct devices')}
      ${statCard(s.totalEvents, 'Total events', null)}
      ${statCard(formatRelativeTime(s.firstView), 'First view', s.firstView ? formatExactDate(s.firstView) : null)}
      ${statCard(formatRelativeTime(s.lastView), 'Last view', s.lastView ? formatExactDate(s.lastView) : null)}
    </div>
  `;
}

function statCard(num, label, sub, isEmpty) {
  return `
    <div class="eng-stat">
      <div class="eng-stat-num ${isEmpty ? 'is-empty' : ''}">${escapeHtml(String(num))}</div>
      <div class="eng-stat-label">${escapeHtml(label)}</div>
      ${sub ? `<div class="eng-stat-sub">${escapeHtml(sub)}</div>` : ''}
    </div>
  `;
}

function renderSplit(s) {
  if (s.totalEvents === 0) return '';
  const totalDeviced = s.mobileEvents + s.desktopEvents;
  if (totalDeviced === 0) return ''; // events but no viewport data — show nothing rather than misleading 100%
  const mobilePct = s.mobilePercent;
  const desktopPct = 100 - mobilePct;
  return `
    <div class="eng-split">
      <div class="eng-split-header">
        <span class="eng-split-title">Device split</span>
        <span class="eng-split-meta">${totalDeviced} sized event${totalDeviced === 1 ? '' : 's'}</span>
      </div>
      <div class="eng-split-bar">
        ${mobilePct > 0 ? `<div class="eng-split-mobile" style="width:${mobilePct}%"></div>` : ''}
        ${desktopPct > 0 ? `<div class="eng-split-desktop" style="width:${desktopPct}%"></div>` : ''}
      </div>
      <div class="eng-split-legend">
        <span><span class="eng-split-legend-swatch" style="background:#2b4a73"></span>Mobile ${s.mobileEvents} (${mobilePct}%)</span>
        <span><span class="eng-split-legend-swatch" style="background:#9c7440"></span>Desktop ${s.desktopEvents} (${desktopPct}%)</span>
      </div>
    </div>
  `;
}

function renderSessions(sessions) {
  if (!sessions || sessions.length === 0) return '';
  const rows = sessions.map(renderSessionRow).join('');
  return `
    <h2 class="eng-section-h">Sessions (${sessions.length})</h2>
    <p class="eng-section-sub">One row per device. "First seen" and "last seen" span the entire history of that device on this proposal.</p>
    <div class="eng-table-wrap">
      <table class="eng-table">
        <thead>
          <tr>
            <th style="width: 60px;">Device</th>
            <th>Session ID</th>
            <th>Viewport</th>
            <th>First seen</th>
            <th>Last seen</th>
            <th style="text-align:right;">Events</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderSessionRow(s) {
  const viewport = (s.viewport_w && s.viewport_h)
    ? `${s.viewport_w}×${s.viewport_h}`
    : '—';
  return `
    <tr>
      <td><span class="eng-device" title="${escapeAttr(deviceLabel(s.viewport_w))}">${deviceIcon(s.viewport_w)}</span></td>
      <td><span class="eng-mono-id" title="${escapeAttr(s.session_id)}">${escapeHtml(s.session_id.slice(0, 8))}…</span></td>
      <td><span class="eng-mono">${escapeHtml(viewport)}</span></td>
      <td><span class="eng-mono">${escapeHtml(formatRelativeTime(s.first_seen))}</span></td>
      <td><span class="eng-mono">${escapeHtml(formatRelativeTime(s.last_seen))}</span></td>
      <td style="text-align:right;"><strong>${s.event_count}</strong></td>
    </tr>
  `;
}

function renderTimeline(events) {
  if (!events || events.length === 0) return '';
  const KNOWN_TYPES = new Set([
    'page_view', 'section_view', 'swap_modal_open', 'swap_save',
    'accept_proposal_click',
  ]);
  const rows = events.map(e => {
    const typeClass = KNOWN_TYPES.has(e.event_type)
      ? 'eng-event-type-' + e.event_type
      : 'eng-event-type-other';
    const payloadStr = e.payload && Object.keys(e.payload).length > 0
      ? JSON.stringify(e.payload)
      : '';
    const payloadDisplay = payloadStr.length > 80
      ? payloadStr.slice(0, 80) + '…'
      : payloadStr;
    const sessionShort = e.session_id ? e.session_id.slice(0, 8) + '…' : '—';
    return `
      <div class="eng-event-row">
        <span class="eng-event-time">${escapeHtml(formatRelativeTime(e.occurred_at))}</span>
        <span class="eng-event-type ${typeClass}">${escapeHtml(e.event_type)}</span>
        <span class="eng-event-payload">${escapeHtml(payloadDisplay)}</span>
        <span class="eng-mono-id" title="${escapeAttr(e.session_id || '')}">${escapeHtml(sessionShort)}</span>
      </div>
    `;
  }).join('');
  return `
    <h2 class="eng-section-h" style="margin-top:28px;">Recent activity (${events.length})</h2>
    <p class="eng-section-sub">Most recent first. Showing up to ${TIMELINE_LIMIT} events.</p>
    <div class="eng-event-list">${rows}</div>
  `;
}

// ─── Helpers ────────────────────────────────────────────────────────────
function pickLatestSlug(pubs) {
  if (!Array.isArray(pubs) || pubs.length === 0) return null;
  // Sort by published_at desc; first wins.
  const sorted = [...pubs].sort((a, b) => {
    const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
    const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
    return tb - ta;
  });
  return sorted[0] && sorted[0].slug ? sorted[0].slug : null;
}

function formatExactDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function showError(title, detail) {
  content.innerHTML = `
    <div class="eng-error">
      <div class="eng-error-title">${escapeHtml(title)}</div>
      <div>${escapeHtml(detail)}</div>
      <div style="margin-top:14px; font-size:13px;">
        <a href="/admin/clients.html" style="color:inherit; text-decoration:underline;">Back to Clients</a>
        &nbsp;·&nbsp;
        <a href="/admin/events.html" style="color:inherit; text-decoration:underline;">View raw event stream</a>
      </div>
    </div>
  `;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
