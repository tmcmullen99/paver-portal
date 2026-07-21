// ═══════════════════════════════════════════════════════════════════════════
// /p-budget.js — Phase 6 Sprint 4A (homeowner budget exploration)
//
// Loaded by p-customize.js when the customize feature is enabled (i.e., the
// caller is the authenticated homeowner of this proposal). Adds a floating
// CTA "💰 Adjust budget" that opens a fullscreen overlay where the homeowner
// can:
//
//   1. See the current bid summary (total, total sqft, blended $/sqft)
//   2. Set a target budget (slider + number input)
//   3. Lock specific regions (kept at full size)
//   4. See live per-region scope reduction (sqft × $/sqft = estimated cost)
//   5. Send the resulting scope variation to the designer for accurate pricing
//
// Output: structured homeowner_note submitted to /api/submit-redesign.
// Reuses the entire Sprint 2 redesign infrastructure — no new endpoint,
// no new table. The designer's existing /admin/client-redesigns.html queue
// surfaces it like any other redesign request, with the structured note
// readable as plain text.
//
// Data sourcing:
//   - Regions read from the DOM (.pub-region-legend-row), area parsed from
//     the meta text via regex. Regions without parseable sqft are excluded
//     from budget math (e.g., linear-foot-only regions).
//   - Bid total read from .bpc-bid-total-amount (post-customize transform)
//     or .pub-scope-total-amount (pre-transform) — whichever is present.
//
// Pricing model (Sprint 4A): blended $/sqft = bid_total / total_sqft applied
// uniformly to all regions. Disclaimer is prominent in the UI: final pricing
// is determined by the designer based on the revised scope.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (window.__bpcBudgetLoaded) return;
  window.__bpcBudgetLoaded = true;

  const API_REDESIGN = '/api/submit-redesign';

  const state = {
    regions: [],          // [{id, name, color, area_sqft, sectionHref}]
    totalSqft: 0,
    bidTotal: 0,
    blendedPerSqft: 0,
    lockedRegionIds: new Set(),
    targetBudget: 0,
  };

  // DOM refs (built lazily on first overlay open)
  let overlayEl = null;
  let regionListEl = null;
  let summaryEl = null;
  let budgetInputEl = null;
  let budgetSliderEl = null;
  let warningEl = null;
  let submitBtnEl = null;
  let submitStatusEl = null;

  // ── Helpers ──────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function getAuthToken() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
          const v = localStorage.getItem(k);
          if (!v) continue;
          const parsed = JSON.parse(v);
          if (parsed && parsed.access_token) return parsed.access_token;
        }
      }
    } catch (e) {}
    return null;
  }

  function getSlugFromPath() {
    const m = window.location.pathname.match(/^\/p\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function formatMoney(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function parseSqft(text) {
    if (!text) return 0;
    const m = String(text).match(/(\d[\d,]*(?:\.\d+)?)\s*sq\s*ft/i);
    if (!m) return 0;
    const num = parseFloat(m[1].replace(/,/g, ''));
    return isNaN(num) ? 0 : num;
  }

  function getSiteMapInfo() {
    const svg = document.querySelector('.pub-site-plan-map');
    if (!svg) return { url: '', width: 0, height: 0 };
    const imageEl = svg.querySelector('image');
    let url = '';
    let width = 0, height = 0;
    if (imageEl) {
      url = imageEl.getAttribute('href') || imageEl.getAttribute('xlink:href') || '';
      width = parseFloat(imageEl.getAttribute('width')) || 0;
      height = parseFloat(imageEl.getAttribute('height')) || 0;
    }
    if (!width || !height) {
      const vb = svg.getAttribute('viewBox');
      if (vb) {
        const parts = vb.split(/\s+/).map(Number);
        if (parts.length === 4) { width = parts[2]; height = parts[3]; }
      }
    }
    return { url, width, height };
  }

  // ── Data loading from DOM ────────────────────────────────────────────
  function loadRegions() {
    const regions = [];
    document.querySelectorAll('.pub-region-legend-row').forEach((row) => {
      const id = row.getAttribute('data-region-id');
      if (!id) return;
      const dot = row.querySelector('.pub-region-legend-dot');
      const color = (dot && dot.style && dot.style.background) || '#9c7440';
      const nameEl = row.querySelector('.pub-region-legend-name');
      const metaEl = row.querySelector('.pub-region-legend-meta');
      const name = (nameEl ? nameEl.textContent : '').trim();
      const meta = (metaEl ? metaEl.textContent : '').trim();
      const area_sqft = parseSqft(meta);
      if (area_sqft <= 0) return; // Skip non-sqft regions (linear feet, etc.)
      regions.push({
        id,
        name,
        color,
        area_sqft,
        sectionHref: row.getAttribute('href') || '',
      });
    });
    return regions;
  }

  function getTotalBid() {
    let el = document.querySelector('.bpc-bid-total-amount');
    if (!el) el = document.querySelector('.pub-scope-total-amount');
    if (!el) {
      // Last resort: any element with "total" semantic
      const candidates = document.querySelectorAll('.pub-cover-bid-total, .pub-bid-total');
      el = candidates[candidates.length - 1];
    }
    if (!el) return 0;
    const text = el.textContent || '';
    const num = parseFloat(text.replace(/[^0-9.\-]/g, ''));
    return isNaN(num) ? 0 : num;
  }

  // ── Reduction math ───────────────────────────────────────────────────
  function computeReduction(targetBudget, lockedIds) {
    const regions = state.regions;
    const blended = state.blendedPerSqft;
    const totalSqft = state.totalSqft;

    const lockedSqft = regions
      .filter((r) => lockedIds.has(r.id))
      .reduce((s, r) => s + r.area_sqft, 0);
    const flexibleSqft = totalSqft - lockedSqft;
    const lockedCost = lockedSqft * blended;
    const targetFlexibleCost = targetBudget - lockedCost;

    let warning = null;
    let reductionFactor = 1;

    if (flexibleSqft === 0) {
      // All regions locked. Target must equal locked cost or it's not viable.
      if (Math.abs(lockedCost - targetBudget) > 1) {
        warning = 'All regions are locked. Unlock at least one to scale to the target budget.';
      }
    } else if (targetFlexibleCost <= 0) {
      warning = 'Locked regions alone cost ' + formatMoney(lockedCost) +
        '. To hit ' + formatMoney(targetBudget) + ', unlock more regions or raise your budget target.';
      reductionFactor = 0;
    } else {
      reductionFactor = targetFlexibleCost / (flexibleSqft * blended);
      if (reductionFactor < 0.1) {
        warning = 'This budget would shrink flexible regions by more than 90%. Consider locking fewer regions or raising the target.';
      }
      if (reductionFactor > 1) {
        // Target higher than current — clamp at 100%
        reductionFactor = 1;
      }
    }

    const rows = regions.map((r) => {
      const isLocked = lockedIds.has(r.id);
      const newSqft = isLocked
        ? r.area_sqft
        : Math.max(0, Math.round(r.area_sqft * reductionFactor));
      const newCost = newSqft * blended;
      return {
        ...r,
        isLocked,
        newSqft,
        newCost,
        sqftDelta: newSqft - r.area_sqft,
      };
    });

    const estimatedTotal = rows.reduce((s, r) => s + r.newCost, 0);

    return { rows, estimatedTotal, warning, reductionFactor };
  }

  // ── Styles ────────────────────────────────────────────────────────────
  const STYLES = `
    /* Floating CTA — sits ABOVE the redesign FAB.
       Sprint 14C.14 — bumped from bottom:130px to bottom:178px because the
       redesign FAB grew from 2 buttons (Suggest changes + Print for markup)
       to 3 buttons (Suggest changes + Reshape my areas + Print for markup)
       in Sprint 14C.11, extending the redesign stack from ~95px tall to
       ~140px tall. The old 130px clearance was no longer enough; this
       Adjust budget pill was overlapping the top of "Suggest changes". */
    .bpc-budget-fab {
      position: fixed;
      bottom: 178px;
      right: 18px;
      z-index: 1500;
      pointer-events: auto;
    }
    .bpc-budget-fab-btn {
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.01em;
      padding: 11px 18px;
      border-radius: 24px;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(53, 53, 53, 0.18);
      transition: transform 0.08s, background 0.12s;
      white-space: nowrap;
      background: #353535;
      color: #fff;
    }
    .bpc-budget-fab-btn:hover { background: #4a4a4a; }
    .bpc-budget-fab-btn:active { transform: scale(0.97); }

    /* Overlay */
    .bpc-budget-overlay {
      position: fixed; inset: 0;
      background: rgba(20, 22, 24, 0.92);
      z-index: 3000;
      display: flex;
      flex-direction: column;
      animation: bpcbFadeIn 0.16s ease;
    }
    @keyframes bpcbFadeIn { from { opacity: 0; } to { opacity: 1; } }

    .bpc-budget-overlay-header {
      flex-shrink: 0;
      padding: 14px 20px;
      background: #353535;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid #2a2a2a;
    }
    .bpc-budget-overlay-header h2 {
      margin: 0;
      font-family: 'Onest', sans-serif;
      font-size: 16px;
      font-weight: 600;
    }
    .bpc-budget-overlay-close {
      background: transparent;
      border: none;
      color: #fff;
      font-size: 20px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      line-height: 1;
    }
    .bpc-budget-overlay-close:hover { background: rgba(255,255,255,0.12); }

    .bpc-budget-overlay-body {
      flex: 1;
      overflow-y: auto;
      padding: 20px 16px;
    }

    .bpc-budget-card {
      max-width: 720px;
      margin: 0 auto 16px;
      background: #fff;
      border-radius: 10px;
      padding: 18px 22px;
      box-shadow: 0 4px 18px rgba(0,0,0,0.18);
    }
    .bpc-budget-card-eyebrow {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.14em;
      color: #9c7440;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .bpc-budget-card-title {
      font-size: 16px;
      font-weight: 600;
      color: #353535;
      margin: 0 0 4px;
    }
    .bpc-budget-card-meta {
      font-size: 13px;
      color: #777;
      margin: 0;
    }

    /* Current bid summary */
    .bpc-budget-bid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin-top: 12px;
    }
    .bpc-budget-bid-stat {
      text-align: center;
      padding: 10px 6px;
      background: #faf8f3;
      border-radius: 6px;
    }
    .bpc-budget-bid-stat-num {
      font-size: 18px;
      font-weight: 700;
      color: #353535;
      line-height: 1.2;
    }
    .bpc-budget-bid-stat-label {
      font-size: 10px;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 600;
      margin-top: 4px;
    }

    /* Budget input section */
    .bpc-budget-input-row {
      display: flex;
      gap: 14px;
      align-items: center;
      margin-top: 14px;
    }
    .bpc-budget-slider {
      flex: 1;
      -webkit-appearance: none;
      appearance: none;
      height: 6px;
      background: linear-gradient(to right, #9c7440 0%, #9c7440 var(--pct, 50%), #d8d2bf var(--pct, 50%), #d8d2bf 100%);
      border-radius: 3px;
      outline: none;
    }
    .bpc-budget-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 22px;
      height: 22px;
      background: #9c7440;
      border: 3px solid #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      border-radius: 50%;
      cursor: pointer;
    }
    .bpc-budget-slider::-moz-range-thumb {
      width: 22px;
      height: 22px;
      background: #9c7440;
      border: 3px solid #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      border-radius: 50%;
      cursor: pointer;
    }
    .bpc-budget-input-wrap {
      position: relative;
      flex-shrink: 0;
      width: 140px;
    }
    .bpc-budget-input-wrap::before {
      content: '$';
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: #58595b;
      font-weight: 600;
      font-size: 15px;
      pointer-events: none;
    }
    .bpc-budget-input {
      width: 100%;
      padding: 10px 12px 10px 24px;
      border: 1.5px solid #d8d2bf;
      border-radius: 6px;
      font-family: 'Onest', sans-serif;
      font-size: 15px;
      font-weight: 600;
      color: #353535;
      box-sizing: border-box;
    }
    .bpc-budget-input:focus {
      outline: none;
      border-color: #9c7440;
      box-shadow: 0 0 0 3px rgba(93,126,105,0.18);
    }

    /* Region list */
    .bpc-budget-regions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 14px;
    }
    .bpc-budget-region {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 14px;
      align-items: center;
      padding: 12px 14px;
      background: #faf8f3;
      border: 1px solid transparent;
      border-radius: 8px;
      transition: background 0.15s, border-color 0.15s;
    }
    .bpc-budget-region.is-locked {
      background: #f0f4f1;
      border-color: #9c7440;
    }
    .bpc-budget-region-toggle {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      border: 1.5px solid #d8d2bf;
      background: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      transition: background 0.12s, border-color 0.12s;
      padding: 0;
      flex-shrink: 0;
    }
    .bpc-budget-region-toggle:hover { background: #f4f1e8; }
    .bpc-budget-region.is-locked .bpc-budget-region-toggle {
      background: #9c7440;
      border-color: #9c7440;
      color: #fff;
    }
    .bpc-budget-region-info { min-width: 0; }
    .bpc-budget-region-name {
      font-weight: 600;
      font-size: 14px;
      color: #353535;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .bpc-budget-region-color-dot {
      width: 10px; height: 10px;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .bpc-budget-region-status {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 3px;
    }
    .bpc-budget-region-status.is-locked {
      background: #9c7440;
      color: #fff;
    }
    .bpc-budget-region-status.is-reduced {
      background: #fff4d4;
      color: #7a5a10;
    }
    .bpc-budget-region-detail {
      margin-top: 4px;
      font-size: 12px;
      color: #58595b;
      font-family: 'JetBrains Mono', SF Mono, monospace;
    }
    .bpc-budget-region-arrow {
      color: #9c7440;
      margin: 0 4px;
      font-weight: 700;
    }
    .bpc-budget-region-cost {
      text-align: right;
      flex-shrink: 0;
    }
    .bpc-budget-region-cost-old {
      font-size: 11px;
      color: #999;
      text-decoration: line-through;
    }
    .bpc-budget-region-cost-new {
      font-size: 14px;
      font-weight: 700;
      color: #353535;
      font-family: 'JetBrains Mono', SF Mono, monospace;
    }

    /* Summary block */
    .bpc-budget-summary {
      max-width: 720px;
      margin: 0 auto 14px;
      background: #353535;
      color: #fff;
      border-radius: 10px;
      padding: 18px 22px;
    }
    .bpc-budget-summary-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 4px 0;
      font-size: 14px;
    }
    .bpc-budget-summary-row.is-final {
      border-top: 1px solid #555;
      margin-top: 8px;
      padding-top: 12px;
      font-size: 18px;
      font-weight: 700;
    }
    .bpc-budget-summary-label {
      color: #ccc;
    }
    .bpc-budget-summary-value {
      font-family: 'JetBrains Mono', SF Mono, monospace;
      font-weight: 600;
    }
    .bpc-budget-summary-savings {
      color: #a3d9a4;
      font-weight: 700;
    }

    /* Warning */
    .bpc-budget-warning {
      max-width: 720px;
      margin: 0 auto 14px;
      background: #fff4d4;
      border: 1px solid #f3d97a;
      color: #7a5a10;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.5;
      display: none;
    }
    .bpc-budget-warning.is-visible { display: block; }

    /* Disclaimer */
    .bpc-budget-disclaimer {
      max-width: 720px;
      margin: 0 auto 14px;
      background: #faf8f3;
      border-left: 3px solid #9c7440;
      padding: 12px 16px;
      border-radius: 0 6px 6px 0;
      font-size: 12px;
      line-height: 1.55;
      color: #58595b;
    }
    .bpc-budget-disclaimer strong { color: #353535; }

    /* Footer */
    .bpc-budget-overlay-footer {
      flex-shrink: 0;
      background: #fff;
      padding: 14px 20px;
      border-top: 1px solid #e7e3d6;
      display: flex;
      gap: 12px;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
    }
    .bpc-budget-status {
      font-size: 12px;
      color: #888;
      flex: 1;
      min-width: 0;
    }
    .bpc-budget-status.is-error { color: #b85450; }
    .bpc-budget-status.is-success { color: #9c7440; font-weight: 600; }
    .bpc-budget-actions {
      display: flex;
      gap: 10px;
    }
    .bpc-budget-btn {
      padding: 11px 22px;
      font-family: 'Onest', sans-serif;
      font-size: 14px;
      font-weight: 600;
      border-radius: 6px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .bpc-budget-btn--ghost {
      background: #fff;
      color: #353535;
      border-color: #d8d2bf;
    }
    .bpc-budget-btn--ghost:hover { border-color: #353535; }
    .bpc-budget-btn--primary {
      background: #9c7440;
      color: #fff;
    }
    .bpc-budget-btn--primary:hover:not(:disabled) { background: #7d5c31; }
    .bpc-budget-btn--primary:disabled {
      background: #a8b5ac;
      cursor: not-allowed;
    }

    /* Empty state */
    .bpc-budget-empty {
      max-width: 540px;
      margin: 60px auto;
      background: #fff;
      border-radius: 10px;
      padding: 40px 28px;
      text-align: center;
      box-shadow: 0 4px 18px rgba(0,0,0,0.18);
    }
    .bpc-budget-empty h3 { margin: 0 0 8px; font-size: 18px; color: #353535; }
    .bpc-budget-empty p { margin: 0; color: #58595b; font-size: 14px; line-height: 1.55; }

    @media (max-width: 600px) {
      .bpc-budget-bid { grid-template-columns: 1fr; }
      .bpc-budget-input-row { flex-direction: column; align-items: stretch; }
      .bpc-budget-input-wrap { width: 100%; }
      .bpc-budget-region {
        grid-template-columns: auto 1fr;
        grid-template-rows: auto auto;
      }
      .bpc-budget-region-cost {
        grid-column: 1 / -1;
        text-align: left;
        padding-top: 6px;
        border-top: 1px dashed #e7e3d6;
        margin-top: 4px;
      }
    }
  `;

  function injectStyles() {
    if (document.getElementById('bpc-budget-styles')) return;
    const el = document.createElement('style');
    el.id = 'bpc-budget-styles';
    el.textContent = STYLES;
    document.head.appendChild(el);
  }

  // ── FAB ──────────────────────────────────────────────────────────────
  function renderFab() {
    if (document.getElementById('bpcBudgetFab')) return;
    const fab = document.createElement('div');
    fab.id = 'bpcBudgetFab';
    fab.className = 'bpc-budget-fab';
    fab.innerHTML = '<button type="button" class="bpc-budget-fab-btn" data-action="open">💰 Adjust budget</button>';
    document.body.appendChild(fab);
    fab.querySelector('[data-action="open"]').addEventListener('click', openOverlay);
  }

  // ── Overlay ──────────────────────────────────────────────────────────
  function openOverlay() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.className = 'bpc-budget-overlay';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');

    if (state.regions.length === 0 || state.bidTotal === 0) {
      overlayEl.innerHTML = renderEmptyHtml();
      document.body.appendChild(overlayEl);
      overlayEl.querySelector('.bpc-budget-overlay-close').addEventListener('click', closeOverlay);
      document.addEventListener('keydown', onEscClose);
      return;
    }

    // Default state: 80% of original budget, no regions locked
    state.targetBudget = Math.round(state.bidTotal * 0.8);
    state.lockedRegionIds.clear();

    overlayEl.innerHTML = renderOverlayHtml();
    document.body.appendChild(overlayEl);

    // Wire references
    regionListEl = overlayEl.querySelector('.bpc-budget-regions');
    summaryEl = overlayEl.querySelector('.bpc-budget-summary');
    budgetInputEl = overlayEl.querySelector('.bpc-budget-input');
    budgetSliderEl = overlayEl.querySelector('.bpc-budget-slider');
    warningEl = overlayEl.querySelector('.bpc-budget-warning');
    submitBtnEl = overlayEl.querySelector('.bpc-budget-btn--primary');
    submitStatusEl = overlayEl.querySelector('.bpc-budget-status');

    // Initial slider/input values
    const minBudget = Math.round(state.bidTotal * 0.5);
    const maxBudget = Math.round(state.bidTotal);
    budgetSliderEl.min = minBudget;
    budgetSliderEl.max = maxBudget;
    budgetSliderEl.step = 500;
    budgetSliderEl.value = state.targetBudget;
    budgetInputEl.value = state.targetBudget;
    updateSliderFill();

    // Wire handlers
    overlayEl.querySelector('.bpc-budget-overlay-close').addEventListener('click', closeOverlay);
    overlayEl.querySelector('[data-action="cancel"]').addEventListener('click', closeOverlay);
    document.addEventListener('keydown', onEscClose);

    budgetSliderEl.addEventListener('input', () => {
      state.targetBudget = parseInt(budgetSliderEl.value, 10);
      budgetInputEl.value = state.targetBudget;
      updateSliderFill();
      renderRegions();
    });
    budgetInputEl.addEventListener('input', () => {
      let val = parseInt(budgetInputEl.value.replace(/[^0-9]/g, ''), 10);
      if (isNaN(val)) val = state.targetBudget;
      val = Math.max(minBudget, Math.min(maxBudget * 1.5, val)); // allow slight overshoot
      state.targetBudget = val;
      if (val <= maxBudget) {
        budgetSliderEl.value = val;
        updateSliderFill();
      }
      renderRegions();
    });
    budgetInputEl.addEventListener('blur', () => {
      // Snap input value back to bounds
      let val = state.targetBudget;
      val = Math.max(minBudget, Math.min(maxBudget, val));
      state.targetBudget = val;
      budgetInputEl.value = val;
      budgetSliderEl.value = val;
      updateSliderFill();
      renderRegions();
    });

    submitBtnEl.addEventListener('click', submitToDesigner);

    renderRegions();
  }

  function renderEmptyHtml() {
    return (
      '<div class="bpc-budget-overlay-header">' +
        '<h2>Adjust your budget</h2>' +
        '<button type="button" class="bpc-budget-overlay-close" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="bpc-budget-overlay-body">' +
        '<div class="bpc-budget-empty">' +
          '<h3>Budget tool unavailable</h3>' +
          '<p>This proposal doesn\'t have the data needed for budget exploration yet — likely missing region square-footage. ' +
          'Please reach out to your designer if you\'d like to discuss budget options.</p>' +
        '</div>' +
      '</div>'
    );
  }

  function renderOverlayHtml() {
    const totalSqftDisplay = state.totalSqft.toLocaleString();
    const blendedDisplay = formatMoney(state.blendedPerSqft);

    return (
      '<div class="bpc-budget-overlay-header">' +
        '<h2>Adjust your budget</h2>' +
        '<button type="button" class="bpc-budget-overlay-close" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="bpc-budget-overlay-body">' +

        // Current bid card
        '<div class="bpc-budget-card">' +
          '<div class="bpc-budget-card-eyebrow">Your current proposal</div>' +
          '<h3 class="bpc-budget-card-title">' + formatMoney(state.bidTotal) + ' &middot; ' + totalSqftDisplay + ' sqft</h3>' +
          '<p class="bpc-budget-card-meta">Average pricing across all materials and labor.</p>' +
          '<div class="bpc-budget-bid">' +
            '<div class="bpc-budget-bid-stat">' +
              '<div class="bpc-budget-bid-stat-num">' + formatMoney(state.bidTotal) + '</div>' +
              '<div class="bpc-budget-bid-stat-label">Total</div>' +
            '</div>' +
            '<div class="bpc-budget-bid-stat">' +
              '<div class="bpc-budget-bid-stat-num">' + totalSqftDisplay + '</div>' +
              '<div class="bpc-budget-bid-stat-label">Total sqft</div>' +
            '</div>' +
            '<div class="bpc-budget-bid-stat">' +
              '<div class="bpc-budget-bid-stat-num">' + blendedDisplay + '</div>' +
              '<div class="bpc-budget-bid-stat-label">Per sqft (avg)</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Budget input card
        '<div class="bpc-budget-card">' +
          '<div class="bpc-budget-card-eyebrow">What can you spend?</div>' +
          '<h3 class="bpc-budget-card-title">Set your target budget</h3>' +
          '<p class="bpc-budget-card-meta">Drag the slider or type a number. We\'ll show you what scope fits.</p>' +
          '<div class="bpc-budget-input-row">' +
            '<input type="range" class="bpc-budget-slider" min="0" max="100" step="1" value="80">' +
            '<div class="bpc-budget-input-wrap">' +
              '<input type="text" class="bpc-budget-input" inputmode="numeric">' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Region list card
        '<div class="bpc-budget-card">' +
          '<div class="bpc-budget-card-eyebrow">Customize</div>' +
          '<h3 class="bpc-budget-card-title">Lock regions to keep their full size</h3>' +
          '<p class="bpc-budget-card-meta">Tap the lock to keep a region at its current size. Unlocked regions scale proportionally to fit your budget.</p>' +
          '<div class="bpc-budget-regions"></div>' +
        '</div>' +

        // Warning (hidden by default)
        '<div class="bpc-budget-warning"></div>' +

        // Summary block
        '<div class="bpc-budget-summary"></div>' +

        // Disclaimer
        '<div class="bpc-budget-disclaimer">' +
          '<strong>These numbers are estimates.</strong> They use average per-square-foot pricing across your whole project — actual reductions vary by material and prep work. ' +
          '<strong>Your designer will provide accurate pricing</strong> based on the revised scope you send.' +
        '</div>' +

      '</div>' +

      '<div class="bpc-budget-overlay-footer">' +
        '<div class="bpc-budget-status"></div>' +
        '<div class="bpc-budget-actions">' +
          '<button type="button" class="bpc-budget-btn bpc-budget-btn--ghost" data-action="cancel">Cancel</button>' +
          '<button type="button" class="bpc-budget-btn bpc-budget-btn--primary">Send to designer</button>' +
        '</div>' +
      '</div>'
    );
  }

  function updateSliderFill() {
    if (!budgetSliderEl) return;
    const min = parseFloat(budgetSliderEl.min) || 0;
    const max = parseFloat(budgetSliderEl.max) || 1;
    const val = parseFloat(budgetSliderEl.value) || 0;
    const pct = ((val - min) / (max - min)) * 100;
    budgetSliderEl.style.setProperty('--pct', pct + '%');
  }

  function renderRegions() {
    if (!regionListEl) return;
    const result = computeReduction(state.targetBudget, state.lockedRegionIds);

    // Render region rows
    regionListEl.innerHTML = result.rows.map((r) => {
      const isLocked = r.isLocked;
      const isReduced = !isLocked && r.newSqft < r.area_sqft;
      const statusBadge = isLocked
        ? '<span class="bpc-budget-region-status is-locked">Locked</span>'
        : (isReduced
          ? '<span class="bpc-budget-region-status is-reduced">Reduced</span>'
          : '');

      const detailHtml = isLocked
        ? r.area_sqft.toLocaleString() + ' sqft (no change)'
        : (isReduced
          ? r.area_sqft.toLocaleString() + ' sqft <span class="bpc-budget-region-arrow">→</span> ' + r.newSqft.toLocaleString() + ' sqft'
          : r.area_sqft.toLocaleString() + ' sqft');

      const costHtml = isLocked || !isReduced
        ? '<div class="bpc-budget-region-cost-new">' + formatMoney(r.newCost) + '</div>'
        : '<div class="bpc-budget-region-cost-old">' + formatMoney(r.area_sqft * state.blendedPerSqft) + '</div>' +
          '<div class="bpc-budget-region-cost-new">' + formatMoney(r.newCost) + '</div>';

      const lockIcon = isLocked ? '🔒' : '🔓';

      return (
        '<div class="bpc-budget-region' + (isLocked ? ' is-locked' : '') + '" data-region-id="' + escapeHtml(r.id) + '">' +
          '<button type="button" class="bpc-budget-region-toggle" data-toggle-id="' + escapeHtml(r.id) + '" aria-label="' + (isLocked ? 'Unlock' : 'Lock') + '">' + lockIcon + '</button>' +
          '<div class="bpc-budget-region-info">' +
            '<div class="bpc-budget-region-name">' +
              '<span class="bpc-budget-region-color-dot" style="background:' + escapeHtml(r.color) + ';"></span>' +
              escapeHtml(r.name) +
              statusBadge +
            '</div>' +
            '<div class="bpc-budget-region-detail">' + detailHtml + '</div>' +
          '</div>' +
          '<div class="bpc-budget-region-cost">' + costHtml + '</div>' +
        '</div>'
      );
    }).join('');

    // Wire lock toggles
    regionListEl.querySelectorAll('[data-toggle-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-toggle-id');
        if (state.lockedRegionIds.has(id)) state.lockedRegionIds.delete(id);
        else state.lockedRegionIds.add(id);
        renderRegions();
      });
    });

    // Render summary
    const savings = state.bidTotal - result.estimatedTotal;
    const savingsPct = state.bidTotal > 0 ? ((savings / state.bidTotal) * 100).toFixed(0) : 0;
    summaryEl.innerHTML =
      '<div class="bpc-budget-summary-row">' +
        '<span class="bpc-budget-summary-label">Original total</span>' +
        '<span class="bpc-budget-summary-value">' + formatMoney(state.bidTotal) + '</span>' +
      '</div>' +
      '<div class="bpc-budget-summary-row">' +
        '<span class="bpc-budget-summary-label">Estimated savings</span>' +
        '<span class="bpc-budget-summary-value bpc-budget-summary-savings">−' + formatMoney(Math.max(0, savings)) + (savings > 0 ? ' (' + savingsPct + '%)' : '') + '</span>' +
      '</div>' +
      '<div class="bpc-budget-summary-row is-final">' +
        '<span class="bpc-budget-summary-label">Estimated total at this scope</span>' +
        '<span class="bpc-budget-summary-value">' + formatMoney(result.estimatedTotal) + '</span>' +
      '</div>';

    // Warning
    if (result.warning) {
      warningEl.textContent = result.warning;
      warningEl.classList.add('is-visible');
    } else {
      warningEl.classList.remove('is-visible');
    }

    // Submit button enabled only when scope is meaningfully different from original
    const meaningfulChange = Math.abs(state.bidTotal - result.estimatedTotal) > state.bidTotal * 0.02;
    submitBtnEl.disabled = !meaningfulChange || result.reductionFactor === 0;
  }

  function closeOverlay() {
    if (!overlayEl) return;
    overlayEl.remove();
    overlayEl = null;
    document.removeEventListener('keydown', onEscClose);
  }

  function onEscClose(e) { if (e.key === 'Escape') closeOverlay(); }

  // ── Note builder ─────────────────────────────────────────────────────
  function buildBudgetNote(rows, estimatedTotal) {
    const lockedRows = rows.filter((r) => r.isLocked);
    const reducedRows = rows.filter((r) => !r.isLocked && r.newSqft < r.area_sqft);
    const sameRows = rows.filter((r) => !r.isLocked && r.newSqft >= r.area_sqft);

    const lines = [];
    lines.push('🎯 BUDGET EXPLORATION REQUEST');
    lines.push('');
    lines.push('Original bid: ' + formatMoney(state.bidTotal) + ' (' + state.totalSqft.toLocaleString() + ' sqft, ~' + formatMoney(state.blendedPerSqft) + '/sqft blended)');
    lines.push('Target budget: ' + formatMoney(state.targetBudget));
    lines.push('Estimated total at revised scope: ' + formatMoney(estimatedTotal));
    const savings = state.bidTotal - estimatedTotal;
    if (savings > 0) {
      const pct = ((savings / state.bidTotal) * 100).toFixed(0);
      lines.push('Estimated savings: ' + formatMoney(savings) + ' (' + pct + '%)');
    }
    lines.push('');

    if (lockedRows.length > 0) {
      lines.push('🔒 LOCKED (kept at full size):');
      lockedRows.forEach((r) => {
        lines.push('  • ' + r.name + ': ' + r.area_sqft.toLocaleString() + ' sqft (~' + formatMoney(r.area_sqft * state.blendedPerSqft) + ')');
      });
      lines.push('');
    }

    if (reducedRows.length > 0) {
      lines.push('📐 SCALED DOWN:');
      reducedRows.forEach((r) => {
        lines.push('  • ' + r.name + ': ' + r.area_sqft.toLocaleString() + ' sqft → ' + r.newSqft.toLocaleString() + ' sqft (~' + formatMoney(r.area_sqft * state.blendedPerSqft) + ' → ~' + formatMoney(r.newCost) + ')');
      });
      lines.push('');
    }

    if (sameRows.length > 0) {
      lines.push('— UNCHANGED:');
      sameRows.forEach((r) => {
        lines.push('  • ' + r.name + ': ' + r.area_sqft.toLocaleString() + ' sqft');
      });
      lines.push('');
    }

    lines.push('IMPORTANT: These numbers are estimates based on average per-sqft pricing.');
    lines.push('Final pricing to be determined by designer based on revised scope.');

    return lines.join('\n');
  }

  // ── Submit ───────────────────────────────────────────────────────────
  async function submitToDesigner() {
    const slug = getSlugFromPath();
    const token = getAuthToken();
    if (!slug || !token) {
      showStatus('error', 'You need to be signed in to submit. Refresh and try again.');
      return;
    }

    const result = computeReduction(state.targetBudget, state.lockedRegionIds);
    if (result.reductionFactor === 0) {
      showStatus('error', 'Adjust your budget or unlock some regions first.');
      return;
    }

    submitBtnEl.disabled = true;
    submitBtnEl.textContent = 'Sending…';
    showStatus('info', '');

    try {
      const note = buildBudgetNote(result.rows, result.estimatedTotal);
      const info = getSiteMapInfo();

      const fd = new FormData();
      fd.append('slug', slug);
      fd.append('homeowner_note', note);
      if (info.url) fd.append('site_map_url', info.url);
      if (info.width) fd.append('site_map_width', String(info.width));
      if (info.height) fd.append('site_map_height', String(info.height));

      const resp = await fetch(API_REDESIGN, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: fd,
      });
      const apiResult = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        showStatus('error', 'Could not send: ' + (apiResult.error || ('HTTP ' + resp.status)));
        submitBtnEl.disabled = false;
        submitBtnEl.textContent = 'Send to designer';
        return;
      }

      submitBtnEl.textContent = 'Sent ✓';
      showStatus('success', apiResult.email_sent
        ? 'Sent to your designer. They\'ll review and follow up with revised pricing.'
        : 'Submitted. Your designer will see this in the queue.');

      setTimeout(() => closeOverlay(), 2500);

    } catch (err) {
      showStatus('error', 'Network error: ' + ((err && err.message) || 'unknown'));
      submitBtnEl.disabled = false;
      submitBtnEl.textContent = 'Send to designer';
    }
  }

  function showStatus(type, msg) {
    if (!submitStatusEl) return;
    submitStatusEl.textContent = msg;
    submitStatusEl.className = 'bpc-budget-status' + (type !== 'info' ? ' is-' + type : '');
  }

  // ── Init ─────────────────────────────────────────────────────────────
  function init() {
    state.regions = loadRegions();
    state.totalSqft = state.regions.reduce((s, r) => s + r.area_sqft, 0);
    state.bidTotal = getTotalBid();
    state.blendedPerSqft = state.totalSqft > 0 ? state.bidTotal / state.totalSqft : 0;

    // Don't render the FAB if there's nothing to budget against.
    if (state.regions.length === 0 || state.bidTotal === 0 || state.blendedPerSqft === 0) {
      console.warn('[p-budget] Not enough data to enable budget tool', {
        regions: state.regions.length,
        bidTotal: state.bidTotal,
        blendedPerSqft: state.blendedPerSqft,
      });
      return;
    }

    injectStyles();
    renderFab();
  }

  // p-customize.js may transform the DOM after its own init runs, including
  // moving region legend rows and the bid total. Wait briefly to let it
  // settle before we read.
  function deferredInit() {
    // First pass: try immediately
    const initialRegions = loadRegions();
    const initialTotal = getTotalBid();
    if (initialRegions.length > 0 && initialTotal > 0) {
      init();
      return;
    }
    // Second pass: wait for p-customize transforms
    setTimeout(() => {
      const r = loadRegions();
      const t = getTotalBid();
      if (r.length > 0 && t > 0) {
        init();
      } else {
        console.warn('[p-budget] regions/total still unavailable after delay');
      }
    }, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', deferredInit);
  } else {
    deferredInit();
  }
})();
