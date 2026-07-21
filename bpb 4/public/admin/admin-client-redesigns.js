// ═══════════════════════════════════════════════════════════════════════════
// /admin/admin-client-redesigns.js — Phase 6 Sprint 2 + Sprint 14C.11
//
// Designer view for client redesign requests. Each submission shows one
// or more of:
//   - Site map (snapshotted at submit time) with the client's SVG markup
//     overlaid    (markup_svg modality)
//   - Uploaded photo of paper markup    (photo_url modality)
//   - Region reshape diff: dual SVG overlays (gray dashed = original,
//     solid color = requested) + per-region delta table  (modified_polygons
//     modality, sprint 14C.11)
//   - Plain text note    (homeowner_note modality)
//
// Plus the homeowner's optional text note, designer's optional response,
// and actions: Mark addressed / Mark reviewed / Reject (with reason).
//
// State machine:
//   submitted → reviewed → addressed
//   submitted → rejected
//   submitted → addressed (skip reviewed)
//   any pending → superseded (auto-fired by submit endpoint when client
//                              submits a fresh redesign for same proposal)
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireDesigner } from '/js/auth-util.js';

const ctx = {
  userId: null,
  submissions: [],
  filter: 'pending',
  expandedIds: new Set(),
};

const els = {
  content: document.getElementById('rdContent'),
  status: document.getElementById('rdStatus'),
  filter: document.getElementById('rdFilter'),
  refreshBtn: document.getElementById('rdRefreshBtn'),
  statPending: document.getElementById('rdStatPending'),
  statReviewedToday: document.getElementById('rdStatReviewedToday'),
  statAddressedWeek: document.getElementById('rdStatAddressedWeek'),
  statTotal: document.getElementById('rdStatTotal'),
};

(async function init() {
  const auth = await requireDesigner();
  if (!auth) return;
  ctx.userId = auth.user.id;

  els.filter.addEventListener('change', (e) => {
    ctx.filter = e.target.value;
    render();
  });
  els.refreshBtn.addEventListener('click', () => reloadAll());

  await reloadAll();
})();

async function reloadAll() {
  await Promise.all([loadStats(), loadSubmissions()]);
  render();
}

async function loadStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [pending, reviewedToday, addressedWeek, total] = await Promise.all([
    supabase.from('proposal_redesign_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'submitted'),
    supabase.from('proposal_redesign_requests')
      .select('id', { count: 'exact', head: true })
      .gte('reviewed_at', todayStart.toISOString())
      .neq('status', 'submitted'),
    supabase.from('proposal_redesign_requests')
      .select('id', { count: 'exact', head: true })
      .gte('reviewed_at', weekAgo.toISOString())
      .eq('status', 'addressed'),
    supabase.from('proposal_redesign_requests')
      .select('id', { count: 'exact', head: true }),
  ]);

  els.statPending.textContent = formatCount(pending.count);
  els.statReviewedToday.textContent = formatCount(reviewedToday.count);
  els.statAddressedWeek.textContent = formatCount(addressedWeek.count);
  els.statTotal.textContent = formatCount(total.count);
}

async function loadSubmissions() {
  const { data, error } = await supabase
    .from('proposal_redesign_requests')
    .select(`
      id, status, markup_svg, photo_url, homeowner_note, designer_response,
      modified_polygons,
      site_map_url_at_submit, site_map_width_at_submit, site_map_height_at_submit,
      reviewed_at, created_at, updated_at, published_proposal_id, proposal_id, client_id,
      proposal:proposals!proposal_id(id, address, project_address, project_city),
      client:clients!client_id(id, name, email, phone),
      reviewer:profiles!reviewed_by(id, display_name, email),
      published:published_proposals!published_proposal_id(id, slug)
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[admin-client-redesigns] load failed:', error);
    showStatus('error', 'Could not load requests: ' + error.message);
    ctx.submissions = [];
    return;
  }
  ctx.submissions = data || [];
}

function render() {
  const visible = filterSubmissions(ctx.submissions, ctx.filter);
  if (visible.length === 0) {
    els.content.innerHTML = renderEmpty(ctx.filter, ctx.submissions.length);
    return;
  }
  els.content.innerHTML = `<div class="rd-list">${visible.map(renderCard).join('')}</div>`;
  wireCardHandlers();
}

function filterSubmissions(list, filter) {
  if (filter === 'pending') {
    return list.filter(s => s.status === 'submitted' || s.status === 'reviewed');
  }
  if (filter === 'resolved') {
    return list.filter(s => s.status === 'addressed' || s.status === 'rejected' || s.status === 'superseded');
  }
  return list;
}

function renderCard(s) {
  const isExpanded = ctx.expandedIds.has(s.id);
  const isUrgent = s.status === 'submitted';
  const proposalAddress = (s.proposal && (s.proposal.address || s.proposal.project_address)) || 'Untitled proposal';
  const clientName = (s.client && s.client.name) || 'Unknown client';
  const submissionType = describeSubmissionType(s);

  return `
    <div class="rd-card ${isExpanded ? 'is-expanded' : ''} ${isUrgent ? 'is-urgent' : ''}" data-rd-id="${escapeAttr(s.id)}">
      <div class="rd-card-header">
        <span class="rd-card-status rd-status-${s.status}">${escapeHtml(s.status)}</span>
        <div class="rd-card-headline">
          <div class="rd-card-client">${escapeHtml(clientName)}</div>
          <div class="rd-card-proposal">${escapeHtml(proposalAddress)}</div>
        </div>
        <div class="rd-card-meta">
          ${escapeHtml(submissionType)}
          <div class="rd-card-time">${escapeHtml(formatRelative(s.created_at))}</div>
        </div>
        <span class="rd-card-chevron">›</span>
      </div>
      <div class="rd-card-body">
        ${renderProposalRow(s)}
        ${renderVisual(s)}
        ${renderHomeownerNote(s)}
        ${renderDesignerResponse(s)}
        ${renderActions(s)}
        ${renderReviewerFooter(s)}
      </div>
    </div>
  `;
}

function describeSubmissionType(s) {
  const parts = [];
  // Sprint 14C.11 — reshape leads when present because it's the most
  // actionable signal (specific sqft deltas to reprice from).
  if (Array.isArray(s.modified_polygons) && s.modified_polygons.length > 0) {
    parts.push('reshape (' + s.modified_polygons.length + ')');
  }
  if (s.markup_svg) parts.push('markup');
  if (s.photo_url) parts.push('photo');
  if (s.homeowner_note && parts.length === 0) parts.push('note');
  return parts.length > 0 ? parts.join(' + ') : 'submission';
}

function renderProposalRow(s) {
  const slug = s.published && s.published.slug;
  const proposalLink = slug
    ? `<a href="/p/${escapeAttr(slug)}" target="_blank" rel="noopener">View proposal /p/${escapeHtml(slug)} ↗</a>`
    : '<span style="color:var(--muted-soft);">No published version</span>';
  const engagementLink = s.proposal && s.proposal.id
    ? `<a href="/admin/engagement.html?id=${escapeAttr(s.proposal.id)}">📊 View engagement</a>`
    : '';
  const siteMapLink = s.proposal && s.proposal.id
    ? `<a href="/admin/site-map.html?proposal_id=${escapeAttr(s.proposal.id)}">⊞ Edit site map</a>`
    : '';
  const clientEmail = s.client && s.client.email
    ? `<span style="font-family:'JetBrains Mono',monospace; color:var(--muted);">${escapeHtml(s.client.email)}</span>`
    : '';
  return `
    <div class="rd-section">
      <div class="rd-meta-row">
        ${proposalLink}
        ${siteMapLink}
        ${engagementLink}
        ${clientEmail}
      </div>
    </div>
  `;
}

function renderVisual(s) {
  // Sprint 14C.11 — reshape can stand alone OR coexist with markup/photo
  // (the server-side hasContent gate is OR, not XOR). Render it first
  // when present since it carries the most actionable info, then fall
  // through to the existing markup/photo/note-only render path.
  const reshapeBlock = renderReshapeDiff(s);

  let primaryBlock;
  if (s.markup_svg && s.site_map_url_at_submit) {
    // Render the snapshotted site map with the markup SVG overlaid
    const w = s.site_map_width_at_submit || 1000;
    const h = s.site_map_height_at_submit || 750;
    primaryBlock = `
      <div class="rd-section">
        <div class="rd-section-h">Digital markup</div>
        <div class="rd-markup-stage" style="aspect-ratio: ${w} / ${h};">
          <img class="rd-markup-bg" src="${escapeAttr(s.site_map_url_at_submit)}" alt="Site map at submission">
          <div class="rd-markup-overlay">${sanitizeMarkupSvg(s.markup_svg)}</div>
        </div>
      </div>
    `;
  } else if (s.photo_url) {
    primaryBlock = `
      <div class="rd-section">
        <div class="rd-section-h">Photo of paper markup</div>
        <div class="rd-photo-frame">
          <a href="${escapeAttr(s.photo_url)}" target="_blank" rel="noopener">
            <img src="${escapeAttr(s.photo_url)}" alt="Paper markup photo">
          </a>
        </div>
        <p style="font-size:12px;color:var(--muted-soft);margin:6px 0 0;">Click to open full-size in a new tab.</p>
      </div>
    `;
  } else if (!reshapeBlock) {
    // Note-only submission — only show this fallback when there's no
    // reshape block, because reshape submissions are visually rich
    // enough to stand on their own without the "no drawing or photo"
    // explainer.
    primaryBlock = `
      <div class="rd-section">
        <div class="rd-section-h">Submission</div>
        <div class="rd-no-visual">No drawing or photo — see the homeowner's note below.</div>
      </div>
    `;
  } else {
    primaryBlock = '';
  }

  return reshapeBlock + primaryBlock;
}

/**
 * Sprint 14C.11 — render the polygon-vertex-drag reshape diff.
 * Returns empty string when modified_polygons is absent or empty.
 *
 * Visual:
 *   - Snapshotted site map backdrop (same image as markup mode uses)
 *   - Per region: dashed gray polygon (original) + solid colored polygon
 *     (requested) overlaid in a single SVG
 *   - Diff table below: region name, sqft original → requested with %
 *     delta, lnft original → requested with % delta
 *
 * Inline styles instead of new .rd-* CSS classes so this ships in the
 * single .js file change without also touching client-redesigns.html.
 */
function renderReshapeDiff(s) {
  if (!Array.isArray(s.modified_polygons) || s.modified_polygons.length === 0) return '';
  const w = s.site_map_width_at_submit || 1000;
  const h = s.site_map_height_at_submit || 750;
  const hasBackdrop = !!s.site_map_url_at_submit;

  // Dual overlays: gray dashed = original, solid colored = requested.
  const overlays = s.modified_polygons.map((mp) => {
    const color = (typeof mp.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(mp.color)) ? mp.color : '#9c7440';
    const origPoints = (mp.original_polygon || []).map(p =>
      ((Number(p.x) || 0) * w).toFixed(1) + ',' + ((Number(p.y) || 0) * h).toFixed(1)
    ).join(' ');
    const modPoints = (mp.modified_polygon || []).map(p =>
      ((Number(p.x) || 0) * w).toFixed(1) + ',' + ((Number(p.y) || 0) * h).toFixed(1)
    ).join(' ');
    if (!origPoints || !modPoints) return '';
    return `
      <polygon points="${escapeAttr(origPoints)}" stroke="#9aa0a6" fill="rgba(154,160,166,0.12)" stroke-width="${Math.max(2, Math.round(w * 0.0018))}" stroke-dasharray="${Math.max(6, Math.round(w * 0.006))},${Math.max(4, Math.round(w * 0.004))}" stroke-linejoin="round"/>
      <polygon points="${escapeAttr(modPoints)}" stroke="${escapeAttr(color)}" fill="${escapeAttr(color)}" fill-opacity="0.32" stroke-width="${Math.max(3, Math.round(w * 0.0026))}" stroke-linejoin="round"/>
    `;
  }).join('');

  // Diff table rows.
  const totalDeltaSqft = s.modified_polygons.reduce((acc, mp) => {
    return acc + ((Number(mp.modified_area_sqft) || 0) - (Number(mp.original_area_sqft) || 0));
  }, 0);
  const totalOrigSqft = s.modified_polygons.reduce((acc, mp) => acc + (Number(mp.original_area_sqft) || 0), 0);
  const totalPctSqft = totalOrigSqft > 0 ? Math.round((totalDeltaSqft / totalOrigSqft) * 100) : 0;

  const rows = s.modified_polygons.map((mp) => {
    const color = (typeof mp.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(mp.color)) ? mp.color : '#9c7440';
    const origSqft = Number(mp.original_area_sqft) || 0;
    const modSqft  = Number(mp.modified_area_sqft) || 0;
    const dSqft    = modSqft - origSqft;
    const dPctSqft = origSqft > 0 ? Math.round((dSqft / origSqft) * 100) : 0;
    const origLnft = Number(mp.original_area_lnft) || 0;
    const modLnft  = Number(mp.modified_area_lnft) || 0;
    const dLnft    = modLnft - origLnft;
    const dPctLnft = origLnft > 0 ? Math.round((dLnft / origLnft) * 100) : 0;
    const sqftColor = dSqft > 0 ? '#2e7d4f' : (dSqft < 0 ? '#b85450' : '#70726f');
    const lnftColor = dLnft > 0 ? '#2e7d4f' : (dLnft < 0 ? '#b85450' : '#70726f');

    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">
          <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${escapeAttr(color)};vertical-align:middle;margin-right:8px;"></span>
          <span style="vertical-align:middle;font-weight:600;">${escapeHtml(mp.region_name || 'Region')}</span>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums;">
          ${origSqft > 0
            ? formatNumber(origSqft) + ' → <strong>' + formatNumber(modSqft) + '</strong> sqft'
            : '<span style="color:#999;">no sqft</span>'}
          ${origSqft > 0
            ? ' <span style="color:' + sqftColor + ';font-weight:600;">(' + (dSqft > 0 ? '+' : '') + dPctSqft + '%)</span>'
            : ''}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums;">
          ${origLnft > 0
            ? formatNumber(origLnft) + ' → <strong>' + formatNumber(modLnft) + '</strong> lnft'
            : '<span style="color:#999;">no lnft</span>'}
          ${origLnft > 0
            ? ' <span style="color:' + lnftColor + ';font-weight:600;">(' + (dLnft > 0 ? '+' : '') + dPctLnft + '%)</span>'
            : ''}
        </td>
      </tr>
    `;
  }).join('');

  const stageInner = hasBackdrop
    ? `
      <img class="rd-markup-bg" src="${escapeAttr(s.site_map_url_at_submit)}" alt="Site map at submission">
      <svg class="rd-markup-overlay" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;">
        ${overlays}
      </svg>
    `
    : `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:auto;background:#f4f4ef;">
        ${overlays}
      </svg>
    `;

  const totalRow = totalOrigSqft > 0
    ? `
      <tr>
        <td colspan="3" style="padding:10px 12px;font-size:12px;color:#58595b;background:#faf8f3;">
          Net change across ${s.modified_polygons.length} ${s.modified_polygons.length === 1 ? 'region' : 'regions'}:
          <strong>${totalDeltaSqft >= 0 ? '+' : ''}${formatNumber(totalDeltaSqft)} sqft</strong>
          (${totalDeltaSqft >= 0 ? '+' : ''}${totalPctSqft}%)
        </td>
      </tr>
    `
    : '';

  return `
    <div class="rd-section">
      <div class="rd-section-h">Region reshape requested · ${s.modified_polygons.length} ${s.modified_polygons.length === 1 ? 'region' : 'regions'}</div>
      <div class="rd-markup-stage" style="aspect-ratio: ${w} / ${h};">${stageInner}</div>
      <p style="font-size:12px;color:#70726f;margin:8px 0 12px;display:flex;gap:18px;flex-wrap:wrap;align-items:center;">
        <span><span style="display:inline-block;width:18px;height:0;border-top:2px dashed #9aa0a6;vertical-align:middle;margin-right:6px;"></span>Original polygon</span>
        <span><span style="display:inline-block;width:18px;height:8px;background:rgba(93,126,105,0.32);border:2px solid #9c7440;vertical-align:middle;margin-right:6px;border-radius:2px;"></span>Requested polygon</span>
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="background:#faf8f3;">
            <th style="text-align:left;padding:10px 12px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#58595b;border-bottom:1px solid #eee;">Region</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#58595b;border-bottom:1px solid #eee;">Square footage</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#58595b;border-bottom:1px solid #eee;">Linear footage</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          ${totalRow}
        </tbody>
      </table>
    </div>
  `;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/**
 * Sanitize the markup_svg the homeowner submitted before injecting.
 * Strip everything except the <svg> root and its <polyline> children with
 * approved attributes. Defensive — even though the API endpoint validates
 * shape, RLS and admin rendering shouldn't blindly trust client-provided SVG.
 */
function sanitizeMarkupSvg(rawSvg) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawSvg, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) return '';
    const viewBox = svg.getAttribute('viewBox') || '';
    const polylines = Array.from(doc.querySelectorAll('polyline')).map((pl) => {
      const points = pl.getAttribute('points') || '';
      const stroke = pl.getAttribute('stroke') || '#dc2626';
      const sw = pl.getAttribute('stroke-width') || '4';
      // Validate: stroke must be a hex color, points must be digits/comma/space
      if (!/^#[0-9a-f]{3,8}$/i.test(stroke)) return '';
      if (!/^[\d.,\s-]+$/.test(points)) return '';
      if (!/^[\d.]+$/.test(sw)) return '';
      return `<polyline points="${escapeAttr(points)}" stroke="${escapeAttr(stroke)}" fill="none" stroke-width="${escapeAttr(sw)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).filter(Boolean).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${escapeAttr(viewBox)}" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;">${polylines}</svg>`;
  } catch (e) {
    return '<div class="rd-no-visual">Could not render markup.</div>';
  }
}

function renderHomeownerNote(s) {
  if (!s.homeowner_note) return '';
  return `
    <div class="rd-section">
      <div class="rd-section-h">Homeowner note</div>
      <div class="rd-note-block">${escapeHtml(s.homeowner_note)}</div>
    </div>
  `;
}

function renderDesignerResponse(s) {
  if (!s.designer_response) return '';
  return `
    <div class="rd-section">
      <div class="rd-section-h">Your response</div>
      <div class="rd-note-block is-response">${escapeHtml(s.designer_response)}</div>
    </div>
  `;
}

function renderActions(s) {
  if (s.status !== 'submitted' && s.status !== 'reviewed') return '';
  const reviewBtn = s.status === 'submitted'
    ? `<button class="rd-action-btn rd-action-review" data-action="review" data-rd-id="${escapeAttr(s.id)}">Mark reviewed</button>`
    : '';
  return `
    <div class="rd-actions">
      <button class="rd-action-btn rd-action-address" data-action="address" data-rd-id="${escapeAttr(s.id)}">Mark addressed</button>
      ${reviewBtn}
      <button class="rd-action-btn rd-action-reject" data-action="reject" data-rd-id="${escapeAttr(s.id)}">Reject</button>
    </div>
  `;
}

function renderReviewerFooter(s) {
  if (s.status === 'submitted') return '';
  const reviewer = s.reviewer;
  const reviewerName = (reviewer && (reviewer.display_name || reviewer.email)) || 'a designer';
  const when = s.reviewed_at ? formatExact(s.reviewed_at) : '';
  return `
    <div class="rd-reviewed-footer">
      Marked <strong>${escapeHtml(s.status)}</strong> by ${escapeHtml(reviewerName)}${when ? ' on ' + escapeHtml(when) : ''}
    </div>
  `;
}

function renderEmpty(filter, totalCount) {
  if (totalCount === 0) {
    return `
      <div class="rd-empty">
        <div class="rd-empty-title">No design change requests yet</div>
        <div>When homeowners click "Suggest changes" on their proposal page, their requests will appear here.</div>
      </div>
    `;
  }
  const filterLabel = filter === 'pending' ? 'pending' : (filter === 'resolved' ? 'resolved' : 'matching');
  return `
    <div class="rd-empty">
      <div class="rd-empty-title">No ${filterLabel} requests</div>
      <div>Try a different filter, or check back when new requests arrive.</div>
    </div>
  `;
}

function wireCardHandlers() {
  els.content.querySelectorAll('.rd-card').forEach(card => {
    const rdId = card.dataset.rdId;
    const header = card.querySelector('.rd-card-header');
    header.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      if (ctx.expandedIds.has(rdId)) ctx.expandedIds.delete(rdId);
      else ctx.expandedIds.add(rdId);
      card.classList.toggle('is-expanded');
    });
    card.querySelectorAll('.rd-action-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const submission = ctx.submissions.find(s => s.id === btn.dataset.rdId);
        if (!submission) return;
        if (action === 'address') await handleAddress(submission, btn);
        if (action === 'review')  await handleReview(submission, btn);
        if (action === 'reject')  await handleReject(submission, btn);
      });
    });
  });
}

async function handleAddress(submission, btn) {
  const existing = submission.designer_response || '';
  const response = window.prompt(
    'Optional: add a note for the homeowner explaining what you changed.\n' +
    'Example: "Moved the patio 3ft east, added the fire pit on the north corner."\n\n' +
    'Click OK with no text to skip the note.',
    existing
  );
  if (response === null) return;
  await updateStatus(submission.id, 'addressed', response.trim() || null, btn);
}

async function handleReview(submission, btn) {
  if (!confirm('Mark this request as reviewed? You can still mark it addressed or rejected later.')) return;
  await updateStatus(submission.id, 'reviewed', null, btn);
}

async function handleReject(submission, btn) {
  const existing = submission.designer_response || '';
  const response = window.prompt(
    'Required: explain to the homeowner why this change won\'t be made.\n' +
    'They will see this response on their proposal page.',
    existing
  );
  if (response === null) return;
  if (!response.trim()) {
    alert('A reason is required when rejecting a request.');
    return;
  }
  await updateStatus(submission.id, 'rejected', response.trim(), btn);
}

async function updateStatus(id, status, designerResponse, btn) {
  if (btn) {
    btn.disabled = true;
    var originalText = btn.textContent;
    btn.textContent = 'Saving…';
  }
  const update = {
    status,
    reviewed_by: ctx.userId,
    reviewed_at: new Date().toISOString(),
  };
  if (designerResponse !== null && designerResponse !== undefined) {
    update.designer_response = designerResponse;
  }
  const { error } = await supabase
    .from('proposal_redesign_requests')
    .update(update)
    .eq('id', id);
  if (error) {
    showStatus('error', 'Could not update: ' + error.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
    return;
  }
  showStatus('success', `Marked as ${status}.`);
  await reloadAll();
}

function formatCount(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

function formatRelative(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  if (diff < 604_800_000) return Math.floor(diff / 86_400_000) + 'd ago';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatExact(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function showStatus(type, msg) {
  els.status.className = 'rd-status is-' + type;
  els.status.textContent = msg;
  els.status.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (type === 'success') {
    setTimeout(() => {
      if (els.status.textContent === msg) {
        els.status.className = 'rd-status';
        els.status.textContent = '';
      }
    }, 5000);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
