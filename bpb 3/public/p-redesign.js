// ═══════════════════════════════════════════════════════════════════════════
// /p-redesign.js — Phase 6 + Sprint 14C.11 + Phase 16 (unified customize editor)
//
// Loaded by p-customize.js when the customize feature is enabled (authenticated
// homeowner of this proposal). Adds THREE entry points to the proposal page:
//
//   1. "Resize · swap · price" — Phase 16 unified inline editor. Combines
//      polygon-vertex drag (geometry), material swap (visual + estimated $),
//      and live $ readout per region. Single "Send to designer" submits both
//      kinds of change in parallel to /api/submit-redesign AND
//      /api/submit-substitutions. THIS IS THE PITCH-PAGE MOAT EXPERIENCE.
//
//   2. "Suggest changes" — original markup overlay (draw / photo / note).
//      Unchanged from Sprint 14C.13 — kept as fallback for asks that aren't
//      pure geometry or material swap.
//
//   3. "Print for markup" — @media print rules. Unchanged from 14C.13.
//
// Phase 16 details:
//   - On overlay open, refetch /api/proposal-customize-data to populate
//     reshape.swapCandidates (kept self-contained — p-customize.js needs no
//     changes to support this module).
//   - SVG <pattern> per region, filled with the active material's swatch
//     image (same technique as the pitch-bayside moat demo).
//   - Pricing derived from DOM: read the .bpc-bid-reader-row elements
//     p-customize.js created, fuzzy-match section names → region names,
//     compute baseline $/sqft per region, scale linearly with sqft delta.
//     Final pricing is always the designer's call — UI labels it "Estimate".
//   - Material swap updates the polygon pattern fill + the price readout;
//     when submitted, the changes flow to /api/submit-substitutions and
//     show up in the designer's queue as a normal substitution request.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (window.__bpcRedesignLoaded) return;
  window.__bpcRedesignLoaded = true;

  const API_REDESIGN      = '/api/submit-redesign';
  const API_SUBSTITUTIONS = '/api/submit-substitutions';
  const API_CUSTOMIZE     = '/api/proposal-customize-data';

  // Region color palette — mirrors publish.js REGION_LEGEND_COLORS so the
  // colors the homeowner sees on the proposal page match what they see
  // in the unified editor. Keep both lists in sync if either changes.
  const RESHAPE_PALETTE = [
    '#9c7440', '#3b82f6', '#f59e0b', '#a855f7', '#ec4899',
    '#14b8a6', '#f97316', '#06b6d4', '#84cc16', '#ef4444',
  ];

  // ── Drawing state (Suggest-changes overlay, unchanged) ───────────────
  const draw = {
    strokes: [],
    currentColor: '#dc2626',
    currentStroke: null,
    isDrawing: false,
  };

  // ── Reshape state (Phase 16 — extended with materials + pricing) ─────
  //
  // regions[i] shape:
  //   {
  //     id, name, color,
  //     original_polygon, modified_polygon,             ← Sprint 14C.11
  //     original_area_sqft, original_area_lnft,         ← Sprint 14C.11
  //     // Phase 16:
  //     current_material:           { product_name, color, swatch_url, category, manufacturer } | null,
  //     proposal_region_material_id: uuid | null,
  //     pending_material:           same shape as current_material | null,
  //     pending_material_id:        uuid | null,
  //     original_subtotal:          number,   // from DOM section subtotal (0 if no match)
  //     unit_price_sqft:            number,   // original_subtotal / original_area_sqft (fallback: project avg)
  //   }
  const reshape = {
    regions: [],
    swapCandidates: {},      // category → [{ id, product_name, color, manufacturer, swatch_url }, ...]
    selectedIdx: 0,
    isDragging: false,
    dragRegionIdx: -1,
    dragVertexIdx: -1,
    backdropW: 0,
    backdropH: 0,
    backdropUrl: '',
    projectTotal: 0,         // original project total (from .bpc-bid-total-amount or summed)
    projectOrigSqft: 0,      // sum of original sqft across all regions
    customizeFetched: false, // becomes true after the async hydration completes
    customizeFailed: false,  // becomes true if hydration errors out (graceful degrade)
  };

  let pickedPhoto = null;

  // Original overlay refs (Suggest-changes)
  let overlayEl = null;
  let svgEl = null;
  let canvasBgEl = null;
  let toolbarEl = null;
  let photoPreviewEl = null;
  let noteTextareaEl = null;
  let submitBtnEl = null;
  let submitStatusEl = null;
  let printNotesAreaEl = null;

  // Reshape overlay refs (Phase 16 — added picker, price readout, defs)
  let reshapeOverlayEl       = null;
  let reshapeStageSvgEl      = null;
  let reshapeBackdropEl      = null;
  let reshapeRegionsGEl      = null;
  let reshapeHandlesGEl      = null;
  let reshapeDefsEl          = null;   // <defs> holds one <pattern> per region for material fills
  let reshapeReadoutEl       = null;
  let reshapeNoteEl          = null;
  let reshapeSubmitBtnEl     = null;
  let reshapeStatusEl        = null;
  let reshapeMaterialPickerEl = null;
  let reshapePriceTotalEl    = null;

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

  function fmtMoney(n) {
    if (!Number.isFinite(n)) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function getSiteMapInfo() {
    const svgEl = document.querySelector('.pub-drawing-overlay-svg');
    if (!svgEl) return null;
    let width = 0, height = 0;
    const vb = svgEl.getAttribute('viewBox');
    if (vb) {
      const parts = vb.split(/\s+/).map(Number);
      if (parts.length === 4) { width = parts[2]; height = parts[3]; }
    }
    const imgEl = document.querySelector('.pub-drawing-overlay-img');
    let url = '';
    if (imgEl) {
      url = imgEl.src || imgEl.getAttribute('src') || '';
      width  = parseFloat(imgEl.getAttribute('width'))  || width;
      height = parseFloat(imgEl.getAttribute('height')) || height;
    }
    return { url, width, height, svgEl };
  }

  // ── Styles ────────────────────────────────────────────────────────────
  const STYLES = `
    /* Floating CTA */
    .bpc-redesign-fab {
      position: fixed;
      bottom: 18px; right: 18px;
      z-index: 1500;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: stretch;
      pointer-events: auto;
    }
    .bpc-redesign-fab-btn,
    .bpc-redesign-fab-btn--secondary,
    .bpc-redesign-fab-btn--reshape {
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
    }
    .bpc-redesign-fab-btn--reshape {
      background: #9c7440;
      color: #fff;
    }
    .bpc-redesign-fab-btn--reshape:hover { background: #7d5c31; }
    .bpc-redesign-fab-btn {
      background: #dad7c5;
      color: #353535;
    }
    .bpc-redesign-fab-btn:hover { background: #cdc7ae; }
    .bpc-redesign-fab-btn--secondary {
      background: #fff;
      color: #9c7440;
      border: 1px solid #d8d2bf;
    }
    .bpc-redesign-fab-btn--secondary:hover { background: #faf8f3; }
    .bpc-redesign-fab-btn:active,
    .bpc-redesign-fab-btn--secondary:active,
    .bpc-redesign-fab-btn--reshape:active { transform: scale(0.97); }

    /* Suggest-changes overlay (unchanged) */
    .bpc-redesign-overlay {
      position: fixed; inset: 0;
      background: rgba(20, 22, 24, 0.92);
      z-index: 3000;
      display: flex;
      flex-direction: column;
      animation: bpcrFadeIn 0.16s ease;
    }
    @keyframes bpcrFadeIn { from { opacity: 0; } to { opacity: 1; } }
    .bpc-redesign-overlay-header {
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
    .bpc-redesign-overlay-header h2 {
      margin: 0;
      font-family: 'Onest', sans-serif;
      font-size: 16px;
      font-weight: 600;
    }
    .bpc-redesign-overlay-close {
      background: transparent;
      border: none;
      color: #fff;
      font-size: 20px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      line-height: 1;
    }
    .bpc-redesign-overlay-close:hover { background: rgba(255,255,255,0.12); }
    .bpc-redesign-overlay-body {
      flex: 1;
      overflow: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    .bpc-redesign-canvas-wrap {
      position: relative;
      max-width: 100%;
      max-height: calc(100vh - 280px);
      background: #fff;
      box-shadow: 0 4px 24px rgba(0,0,0,0.25);
      border-radius: 8px;
      overflow: hidden;
      touch-action: none;
    }
    .bpc-redesign-canvas-bg {
      display: block;
      max-width: 100%;
      max-height: calc(100vh - 280px);
      pointer-events: none;
      user-select: none;
    }
    .bpc-redesign-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      cursor: crosshair;
      touch-action: none;
    }
    .bpc-redesign-toolbar {
      flex-shrink: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 10px 14px;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.18);
    }
    .bpc-redesign-tool {
      width: 32px; height: 32px;
      border-radius: 6px;
      border: 1.5px solid transparent;
      background: #f4f4ef;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      transition: background 0.12s, border-color 0.12s;
      padding: 0;
    }
    .bpc-redesign-tool:hover { background: #e7e3d6; }
    .bpc-redesign-tool--active { border-color: #353535; background: #fff; }
    .bpc-redesign-color-swatch {
      width: 16px; height: 16px;
      border-radius: 50%;
      display: block;
    }
    .bpc-redesign-toolbar-divider {
      width: 1px;
      height: 22px;
      background: #d8d2bf;
      margin: 0 4px;
    }
    .bpc-redesign-tool-text {
      padding: 0 12px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      color: #353535;
      background: #f4f4ef;
      border: 1px solid transparent;
      border-radius: 6px;
      height: 32px;
      cursor: pointer;
      white-space: nowrap;
    }
    .bpc-redesign-tool-text:hover { background: #e7e3d6; }
    .bpc-redesign-photo-input { display: none; }
    .bpc-redesign-photo-preview {
      position: relative;
      max-width: 280px;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #fff;
      box-shadow: 0 4px 14px rgba(0,0,0,0.3);
    }
    .bpc-redesign-photo-preview img {
      display: block;
      max-width: 100%;
      max-height: 200px;
    }
    .bpc-redesign-photo-preview-clear {
      position: absolute;
      top: 6px; right: 6px;
      background: rgba(53, 53, 53, 0.85);
      color: #fff;
      border: none;
      width: 24px; height: 24px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
    }
    .bpc-redesign-overlay-footer {
      flex-shrink: 0;
      padding: 12px 16px;
      background: #fff;
      display: flex;
      flex-direction: column;
      gap: 10px;
      border-top: 1px solid #e4e4df;
    }
    .bpc-redesign-footer-row {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .bpc-redesign-note {
      flex: 1;
      min-height: 60px;
      max-height: 120px;
      padding: 8px 10px;
      border: 1px solid #d8d2bf;
      border-radius: 6px;
      font-family: inherit;
      font-size: 13px;
      resize: vertical;
      box-sizing: border-box;
    }
    .bpc-redesign-note:focus {
      outline: none;
      border-color: #9c7440;
      box-shadow: 0 0 0 3px rgba(93,126,105,0.16);
    }
    .bpc-redesign-submit-btn {
      flex-shrink: 0;
      background: #9c7440;
      color: #fff;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      align-self: stretch;
      min-width: 140px;
    }
    .bpc-redesign-submit-btn:hover:not(:disabled) { background: #7d5c31; }
    .bpc-redesign-submit-btn:disabled {
      background: #a8b5ac;
      cursor: not-allowed;
    }
    .bpc-redesign-submit-status {
      font-size: 12px;
      color: #888;
    }
    .bpc-redesign-submit-status--error { color: #b85450; }
    .bpc-redesign-submit-status--success { color: #9c7440; font-weight: 600; }

    /* Print rules (unchanged from 14C.13) */
    .bpc-redesign-print-notes { display: none; }
    @media print {
      body.bpc-redesign-printing > *:not(.pub-drawing):not(.bpc-redesign-print-notes):not(script):not(style) {
        display: none !important;
      }
      body.bpc-redesign-printing .bpc-twocol {
        display: block !important;
        grid-template-columns: 1fr !important;
      }
      body.bpc-redesign-printing .bpc-twocol-right,
      body.bpc-redesign-printing .bpc-detail-card,
      body.bpc-redesign-printing .pub-site-plan-materials,
      body.bpc-redesign-printing .pub-region-legend-actions,
      body.bpc-redesign-printing .bpc-tray,
      body.bpc-redesign-printing .bpc-redesign-fab,
      body.bpc-redesign-printing .bpc-redesign-overlay,
      body.bpc-redesign-printing .bpc-reshape-overlay {
        display: none !important;
      }
      body.bpc-redesign-printing .pub-drawing,
      body.bpc-redesign-printing .pub-drawing-inner,
      body.bpc-redesign-printing .pub-site-plan-map,
      body.bpc-redesign-printing .pub-drawing-frame,
      body.bpc-redesign-printing .pub-drawing-overlay-wrap,
      body.bpc-redesign-printing .pub-drawing-overlay-img,
      body.bpc-redesign-printing .pub-drawing-overlay-svg,
      body.bpc-redesign-printing .pub-drawing-region,
      body.bpc-redesign-printing .pub-region-legend,
      body.bpc-redesign-printing .pub-region-legend-row,
      body.bpc-redesign-printing .pub-region-legend-dot,
      body.bpc-redesign-printing .pub-region-legend-text,
      body.bpc-redesign-printing .pub-region-legend-name,
      body.bpc-redesign-printing .pub-region-legend-meta {
        display: revert !important;
      }
      body.bpc-redesign-printing .pub-drawing-overlay-svg,
      body.bpc-redesign-printing .pub-drawing-region,
      body.bpc-redesign-printing .pub-region-legend-dot {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      body.bpc-redesign-printing .bpc-redesign-print-notes {
        display: block !important;
        margin: 24px;
        border-top: 1px solid #888;
        padding-top: 16px;
      }
      body.bpc-redesign-printing .bpc-redesign-print-notes h3 {
        font-family: 'Onest', sans-serif;
        font-size: 16px;
        font-weight: 600;
        margin: 0 0 12px;
        color: #353535;
      }
      body.bpc-redesign-printing .bpc-redesign-print-notes-lines {
        height: 4in;
        background: repeating-linear-gradient(
          to bottom,
          transparent 0,
          transparent 23px,
          #d4d0c2 23px,
          #d4d0c2 24px
        );
      }
      @page { margin: 0.5in; }
    }

    /* ════════════════════════════════════════════════════════════════
       Reshape overlay (Sprint 14C.11 + Phase 16)
       ════════════════════════════════════════════════════════════════ */
    .bpc-reshape-overlay {
      position: fixed; inset: 0;
      background: rgba(20, 22, 24, 0.94);
      z-index: 3000;
      display: flex;
      flex-direction: column;
      animation: bpcrFadeIn 0.16s ease;
    }
    .bpc-reshape-header {
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
    .bpc-reshape-header h2 {
      margin: 0;
      font-family: 'Onest', sans-serif;
      font-size: 16px;
      font-weight: 600;
    }
    .bpc-reshape-header-sub {
      font-size: 12px;
      color: #c8c5b3;
      margin-top: 2px;
    }
    .bpc-reshape-close {
      background: transparent;
      border: none;
      color: #fff;
      font-size: 20px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      line-height: 1;
    }
    .bpc-reshape-close:hover { background: rgba(255,255,255,0.12); }

    .bpc-reshape-body {
      flex: 1;
      overflow: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }

    .bpc-reshape-hint {
      max-width: 680px;
      width: 100%;
      background: #faf8f3;
      border: 1px solid #dad7c5;
      border-left: 3px solid #9c7440;
      border-radius: 6px;
      padding: 7px 12px;
      font-size: 12px;
      color: #353535;
      line-height: 1.4;
      text-align: center;
    }
    .bpc-reshape-hint strong { color: #1f2125; font-weight: 600; }

    .bpc-reshape-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      max-width: 100%;
      justify-content: center;
    }
    .bpc-reshape-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px 6px 8px;
      border-radius: 999px;
      background: #fff;
      border: 1.5px solid transparent;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      color: #353535;
      cursor: pointer;
      opacity: 0.72;
      transition: opacity 0.12s, border-color 0.12s, transform 0.08s;
    }
    .bpc-reshape-chip:hover { opacity: 0.92; }
    .bpc-reshape-chip:active { transform: scale(0.97); }
    .bpc-reshape-chip--active {
      opacity: 1;
      border-color: #353535;
    }
    .bpc-reshape-chip-dot {
      width: 14px; height: 14px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .bpc-reshape-chip-pending {
      display: inline-block;
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #b78b3a;
      margin-left: 2px;
    }

    /* Phase 16 — material picker for the selected region */
    .bpc-reshape-mat-picker {
      max-width: 760px;
      width: 100%;
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.18);
      padding: 12px 14px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .bpc-reshape-mat-current {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-bottom: 10px;
      border-bottom: 1px solid #f1efe6;
    }
    .bpc-reshape-mat-current-thumb {
      width: 44px; height: 44px;
      border-radius: 6px;
      background-size: cover;
      background-position: center;
      flex-shrink: 0;
      background-color: #f4f1e8;
      border: 1px solid #eae6d6;
    }
    .bpc-reshape-mat-current-info { flex: 1; min-width: 0; }
    .bpc-reshape-mat-current-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 9px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #9c7440;
      font-weight: 700;
      margin-bottom: 3px;
    }
    .bpc-reshape-mat-current-name {
      font-weight: 600;
      font-size: 14px;
      color: #353535;
      line-height: 1.2;
    }
    .bpc-reshape-mat-current-meta {
      font-size: 12px;
      color: #777;
      margin-top: 2px;
    }
    .bpc-reshape-mat-pending-arrow {
      display: inline-block;
      margin-left: 8px;
      padding: 2px 8px;
      background: rgba(183,139,58,0.14);
      color: #b78b3a;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      border-radius: 999px;
      text-transform: uppercase;
    }
    .bpc-reshape-mat-cands-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 9px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #888;
      font-weight: 700;
    }
    .bpc-reshape-mat-cands {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
      gap: 8px;
    }
    .bpc-reshape-mat-swatch {
      background: #fff;
      border: 2px solid rgba(0,0,0,0.07);
      border-radius: 8px;
      padding: 6px;
      cursor: pointer;
      transition: all 0.12s;
      display: flex;
      gap: 8px;
      align-items: center;
      text-align: left;
      font-family: inherit;
    }
    .bpc-reshape-mat-swatch:hover {
      border-color: rgba(93,126,105,0.4);
      transform: translateY(-1px);
    }
    .bpc-reshape-mat-swatch--active {
      border-color: #9c7440;
      background: #f4f8f5;
      box-shadow: 0 2px 8px rgba(93,126,105,0.18);
    }
    .bpc-reshape-mat-swatch--current { opacity: 0.55; pointer-events: none; }
    .bpc-reshape-mat-swatch-img {
      width: 36px; height: 36px;
      border-radius: 5px;
      background-size: cover;
      background-position: center;
      flex-shrink: 0;
      background-color: #f4f1e8;
      border: 1px solid #eae6d6;
    }
    .bpc-reshape-mat-swatch-info { flex: 1; min-width: 0; }
    .bpc-reshape-mat-swatch-name {
      font-size: 11.5px;
      font-weight: 600;
      color: #353535;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .bpc-reshape-mat-swatch-color {
      font-size: 10.5px;
      color: #888;
      margin-top: 1px;
    }
    .bpc-reshape-mat-undo {
      background: transparent;
      border: 1px solid #9c7440;
      color: #9c7440;
      padding: 4px 10px;
      border-radius: 999px;
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .bpc-reshape-mat-undo:hover { background: #f0f4f1; }
    .bpc-reshape-mat-empty,
    .bpc-reshape-mat-loading {
      font-size: 12px;
      color: #999;
      padding: 6px 0;
      text-align: center;
    }

    .bpc-reshape-stage-wrap {
      position: relative;
      max-width: 100%;
      max-height: calc(100vh - 460px);
      background: #fff;
      box-shadow: 0 4px 24px rgba(0,0,0,0.28);
      border-radius: 8px;
      overflow: hidden;
      display: inline-block;
      line-height: 0;
    }
    .bpc-reshape-stage-bg {
      display: block;
      max-width: 100%;
      max-height: calc(100vh - 460px);
      pointer-events: none;
      user-select: none;
      -webkit-user-select: none;
    }
    .bpc-reshape-stage-svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      cursor: default;
    }
    .bpc-reshape-region-poly {
      cursor: pointer;
      transition: opacity 0.12s, stroke-width 0.12s;
    }
    .bpc-reshape-vertex-handle {
      cursor: grab;
      transition: r 0.08s;
    }
    .bpc-reshape-vertex-handle--dragging { cursor: grabbing; }

    /* Phase 16 — region readout now includes price column */
    .bpc-reshape-readout {
      max-width: 760px;
      width: 100%;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.18);
      overflow: hidden;
    }
    .bpc-reshape-readout-row {
      display: grid;
      grid-template-columns: auto 1fr auto auto;
      gap: 10px;
      align-items: center;
      padding: 10px 14px;
      border-bottom: 1px solid #f1efe6;
      font-size: 13px;
    }
    .bpc-reshape-readout-row:last-child { border-bottom: none; }
    .bpc-reshape-readout-row.is-selected { background: #faf8f3; }
    .bpc-reshape-readout-dot {
      width: 14px; height: 14px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .bpc-reshape-readout-name {
      font-weight: 600;
      color: #1f2125;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bpc-reshape-readout-meta {
      font-size: 11px;
      color: #70726f;
      margin-top: 2px;
    }
    .bpc-reshape-readout-delta {
      font-size: 12px;
      font-weight: 600;
      color: #70726f;
      font-variant-numeric: tabular-nums;
      text-align: right;
      min-width: 48px;
    }
    .bpc-reshape-readout-delta.is-up   { color: #2e7d4f; }
    .bpc-reshape-readout-delta.is-down { color: #b85450; }
    .bpc-reshape-readout-price {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      font-weight: 700;
      color: #b78b3a;
      font-variant-numeric: tabular-nums;
      text-align: right;
      min-width: 78px;
    }
    .bpc-reshape-readout-price-empty { color: #ccc; font-weight: 500; }
    .bpc-reshape-readout-row-actions {
      grid-column: 1 / -1;
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      padding-top: 4px;
    }
    .bpc-reshape-readout-reset {
      background: transparent;
      border: 1px solid #e4e4df;
      color: #58595b;
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      padding: 4px 10px;
      border-radius: 999px;
      cursor: pointer;
    }
    .bpc-reshape-readout-reset:hover { background: #faf8f3; border-color: #58595b; }
    .bpc-reshape-readout-reset:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      background: transparent;
    }
    /* Phase 16 — project-total footer row */
    .bpc-reshape-readout-total {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 12px 14px;
      background: #faf8f3;
      border-top: 2px solid #9c7440;
      font-size: 13px;
    }
    .bpc-reshape-readout-total-label {
      color: #353535;
      font-weight: 600;
    }
    .bpc-reshape-readout-total-label small {
      display: block;
      font-size: 10px;
      font-weight: 500;
      color: #888;
      margin-top: 2px;
      letter-spacing: 0.04em;
    }
    .bpc-reshape-readout-total-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 20px;
      font-weight: 700;
      color: #b78b3a;
      font-variant-numeric: tabular-nums;
    }
    .bpc-reshape-readout-total-value-baseline {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      font-weight: 500;
      color: #888;
      margin-left: 8px;
      text-decoration: line-through;
    }

    .bpc-reshape-toolbar-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
    }
    .bpc-reshape-tool-text {
      padding: 0 14px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      color: #353535;
      background: #f4f4ef;
      border: 1px solid transparent;
      border-radius: 6px;
      height: 32px;
      cursor: pointer;
      white-space: nowrap;
    }
    .bpc-reshape-tool-text:hover { background: #e7e3d6; }
    .bpc-reshape-tool-text:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      background: #f4f4ef;
    }

    .bpc-reshape-footer {
      flex-shrink: 0;
      padding: 12px 16px;
      background: #fff;
      display: flex;
      flex-direction: column;
      gap: 10px;
      border-top: 1px solid #e4e4df;
    }
    .bpc-reshape-footer-row {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .bpc-reshape-note {
      flex: 1;
      min-height: 60px;
      max-height: 120px;
      padding: 8px 10px;
      border: 1px solid #d8d2bf;
      border-radius: 6px;
      font-family: inherit;
      font-size: 13px;
      resize: vertical;
      box-sizing: border-box;
    }
    .bpc-reshape-note:focus {
      outline: none;
      border-color: #9c7440;
      box-shadow: 0 0 0 3px rgba(93,126,105,0.16);
    }
    .bpc-reshape-submit-btn {
      flex-shrink: 0;
      background: #9c7440;
      color: #fff;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      align-self: stretch;
      min-width: 140px;
    }
    .bpc-reshape-submit-btn:hover:not(:disabled) { background: #7d5c31; }
    .bpc-reshape-submit-btn:disabled {
      background: #a8b5ac;
      cursor: not-allowed;
    }
    .bpc-reshape-status {
      font-size: 12px;
      color: #888;
    }
    .bpc-reshape-status--error { color: #b85450; }
    .bpc-reshape-status--success { color: #9c7440; font-weight: 600; }
  `;

  function injectStyles() {
    if (document.getElementById('bpc-redesign-styles')) return;
    const el = document.createElement('style');
    el.id = 'bpc-redesign-styles';
    el.textContent = STYLES;
    document.head.appendChild(el);
  }

  // ── Floating CTA ──────────────────────────────────────────────────────
  function renderFab() {
    if (document.getElementById('bpcRedesignFab')) return;
    const fab = document.createElement('div');
    fab.id = 'bpcRedesignFab';
    fab.className = 'bpc-redesign-fab';
    // Phase 16 — primary action is now the unified editor. Order matters:
    // the most-actionable button sits at the top of the stack closest to
    // the thumb, the markup fallback sits below, print fallback at the
    // bottom.
    fab.innerHTML =
      '<button type="button" class="bpc-redesign-fab-btn--reshape" data-action="reshape">✥ Resize · swap · price</button>' +
      '<button type="button" class="bpc-redesign-fab-btn" data-action="suggest">✏️ Suggest other changes</button>' +
      '<button type="button" class="bpc-redesign-fab-btn--secondary" data-action="print">🖨 Print for markup</button>';
    document.body.appendChild(fab);
    fab.querySelector('[data-action="reshape"]').addEventListener('click', openReshapeOverlay);
    fab.querySelector('[data-action="suggest"]').addEventListener('click', openOverlay);
    fab.querySelector('[data-action="print"]').addEventListener('click', handlePrint);
  }

  // ── Print mode (unchanged) ────────────────────────────────────────────
  function ensurePrintNotesArea() {
    if (document.getElementById('bpcRedesignPrintNotes')) return;
    const notes = document.createElement('div');
    notes.id = 'bpcRedesignPrintNotes';
    notes.className = 'bpc-redesign-print-notes';
    notes.innerHTML =
      '<h3>Notes &amp; markup space</h3>' +
      '<div class="bpc-redesign-print-notes-lines"></div>';
    document.body.appendChild(notes);
    printNotesAreaEl = notes;
  }

  function handlePrint() {
    ensurePrintNotesArea();
    const drawingSection = document.querySelector('.pub-drawing');
    if (drawingSection && drawingSection.scrollIntoView) {
      try {
        drawingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (_) {
        drawingSection.scrollIntoView(true);
      }
    }
    document.body.classList.add('bpc-redesign-printing');
    setTimeout(() => {
      window.print();
      setTimeout(() => document.body.classList.remove('bpc-redesign-printing'), 800);
    }, 350);
  }

  // ════════════════════════════════════════════════════════════════════
  // SUGGEST-CHANGES OVERLAY (drawing/photo/note) — unchanged from 14C.13
  // ════════════════════════════════════════════════════════════════════
  function openOverlay() {
    if (overlayEl) return;
    const info = getSiteMapInfo();
    if (!info || !info.url) {
      alert('Could not find your site map. Please refresh and try again.');
      return;
    }
    draw.strokes = [];
    draw.currentColor = '#dc2626';
    draw.currentStroke = null;
    draw.isDrawing = false;
    pickedPhoto = null;

    overlayEl = document.createElement('div');
    overlayEl.className = 'bpc-redesign-overlay';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');
    overlayEl.innerHTML = renderOverlayHtml(info);
    document.body.appendChild(overlayEl);

    canvasBgEl = overlayEl.querySelector('.bpc-redesign-canvas-bg');
    svgEl = overlayEl.querySelector('.bpc-redesign-canvas');
    toolbarEl = overlayEl.querySelector('.bpc-redesign-toolbar');
    photoPreviewEl = overlayEl.querySelector('.bpc-redesign-photo-preview');
    noteTextareaEl = overlayEl.querySelector('.bpc-redesign-note');
    submitBtnEl = overlayEl.querySelector('.bpc-redesign-submit-btn');
    submitStatusEl = overlayEl.querySelector('.bpc-redesign-submit-status');

    const w = info.width || 1000;
    const h = info.height || 750;
    svgEl.setAttribute('viewBox', '0 0 ' + w + ' ' + h);

    overlayEl.querySelector('.bpc-redesign-overlay-close').addEventListener('click', closeOverlay);
    document.addEventListener('keydown', onEscClose);

    toolbarEl.querySelectorAll('[data-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        draw.currentColor = btn.getAttribute('data-color');
        toolbarEl.querySelectorAll('[data-color]').forEach((b) =>
          b.classList.toggle('bpc-redesign-tool--active', b === btn));
      });
    });
    toolbarEl.querySelector('[data-action="undo"]').addEventListener('click', undoStroke);
    toolbarEl.querySelector('[data-action="clear"]').addEventListener('click', clearStrokes);
    const photoInput = toolbarEl.querySelector('.bpc-redesign-photo-input');
    toolbarEl.querySelector('[data-action="pickphoto"]').addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', onPhotoPicked);

    photoPreviewEl.querySelector('.bpc-redesign-photo-preview-clear').addEventListener('click', clearPhoto);

    submitBtnEl.addEventListener('click', submitRedesign);
    noteTextareaEl.addEventListener('input', updateSubmitButton);

    svgEl.addEventListener('pointerdown', onPointerDown);
    svgEl.addEventListener('pointermove', onPointerMove);
    svgEl.addEventListener('pointerup', onPointerUp);
    svgEl.addEventListener('pointerleave', onPointerUp);

    updateSubmitButton();
  }

  function renderOverlayHtml(info) {
    return (
      '<div class="bpc-redesign-overlay-header">' +
        '<h2>Suggest other changes</h2>' +
        '<button type="button" class="bpc-redesign-overlay-close" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="bpc-redesign-overlay-body">' +
        '<div class="bpc-redesign-canvas-wrap">' +
          '<img class="bpc-redesign-canvas-bg" src="' + escapeHtml(info.url) + '" alt="Site map">' +
          '<svg class="bpc-redesign-canvas" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none"></svg>' +
        '</div>' +
        '<div class="bpc-redesign-toolbar">' +
          '<button type="button" class="bpc-redesign-tool bpc-redesign-tool--active" data-color="#dc2626" title="Red"><span class="bpc-redesign-color-swatch" style="background:#dc2626"></span></button>' +
          '<button type="button" class="bpc-redesign-tool" data-color="#1d4ed8" title="Blue"><span class="bpc-redesign-color-swatch" style="background:#1d4ed8"></span></button>' +
          '<button type="button" class="bpc-redesign-tool" data-color="#15803d" title="Green"><span class="bpc-redesign-color-swatch" style="background:#15803d"></span></button>' +
          '<div class="bpc-redesign-toolbar-divider"></div>' +
          '<button type="button" class="bpc-redesign-tool-text" data-action="undo">↶ Undo</button>' +
          '<button type="button" class="bpc-redesign-tool-text" data-action="clear">Clear</button>' +
          '<div class="bpc-redesign-toolbar-divider"></div>' +
          '<button type="button" class="bpc-redesign-tool-text" data-action="pickphoto">📷 Or attach photo of paper markup</button>' +
          '<input type="file" class="bpc-redesign-photo-input" accept="image/jpeg,image/png,image/heic,image/heif,image/webp">' +
        '</div>' +
        '<div class="bpc-redesign-photo-preview" hidden>' +
          '<img alt="Photo preview">' +
          '<button type="button" class="bpc-redesign-photo-preview-clear" aria-label="Remove photo">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="bpc-redesign-overlay-footer">' +
        '<div class="bpc-redesign-footer-row">' +
          '<textarea class="bpc-redesign-note" placeholder="Add a note for your designer (optional). Tell them what you\'d like to change."></textarea>' +
          '<button type="button" class="bpc-redesign-submit-btn" disabled>Send to designer</button>' +
        '</div>' +
        '<div class="bpc-redesign-submit-status"></div>' +
      '</div>'
    );
  }

  function closeOverlay() {
    if (!overlayEl) return;
    const hasWork = draw.strokes.length > 0 || pickedPhoto || (noteTextareaEl && noteTextareaEl.value.trim());
    if (hasWork && !confirm('Discard your design change request?')) return;
    overlayEl.remove();
    overlayEl = null;
    document.removeEventListener('keydown', onEscClose);
    if (pickedPhoto && pickedPhoto.previewUrl) URL.revokeObjectURL(pickedPhoto.previewUrl);
    pickedPhoto = null;
    draw.strokes = [];
    draw.currentStroke = null;
  }
  function onEscClose(e) { if (e.key === 'Escape') closeOverlay(); }

  function svgPointFromEvent(e) {
    const rect = svgEl.getBoundingClientRect();
    const vb = svgEl.viewBox.baseVal;
    const x = ((e.clientX - rect.left) / rect.width) * vb.width;
    const y = ((e.clientY - rect.top) / rect.height) * vb.height;
    return { x: Math.round(x), y: Math.round(y) };
  }
  function onPointerDown(e) {
    if (pickedPhoto) { alert('You\'ve attached a photo. Remove it first to draw on the site map.'); return; }
    e.preventDefault();
    if (svgEl.setPointerCapture) { try { svgEl.setPointerCapture(e.pointerId); } catch (_) {} }
    draw.isDrawing = true;
    const p = svgPointFromEvent(e);
    draw.currentStroke = { color: draw.currentColor, points: [p] };
    draw.strokes.push(draw.currentStroke);
    redrawStrokes();
    updateSubmitButton();
  }
  function onPointerMove(e) {
    if (!draw.isDrawing || !draw.currentStroke) return;
    e.preventDefault();
    const p = svgPointFromEvent(e);
    const prev = draw.currentStroke.points[draw.currentStroke.points.length - 1];
    const dx = p.x - prev.x, dy = p.y - prev.y;
    if (dx * dx + dy * dy < 4) return;
    draw.currentStroke.points.push(p);
    redrawStrokes();
  }
  function onPointerUp(e) {
    if (!draw.isDrawing) return;
    draw.isDrawing = false;
    if (draw.currentStroke && draw.currentStroke.points.length < 2) draw.strokes.pop();
    draw.currentStroke = null;
    redrawStrokes();
  }
  function redrawStrokes() {
    if (!svgEl) return;
    const vb = svgEl.viewBox.baseVal;
    const strokeWidth = Math.max(2, Math.round(vb.width / 200));
    const parts = draw.strokes.map((s) => {
      if (s.points.length < 2) return '';
      const d = s.points.map(p => p.x + ',' + p.y).join(' ');
      return '<polyline points="' + d + '" stroke="' + s.color + '" fill="none" stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-linejoin="round"/>';
    }).join('');
    svgEl.innerHTML = parts;
  }
  function undoStroke() {
    if (draw.strokes.length === 0) return;
    draw.strokes.pop(); redrawStrokes(); updateSubmitButton();
  }
  function clearStrokes() {
    if (draw.strokes.length === 0) return;
    if (!confirm('Clear all your drawing?')) return;
    draw.strokes = []; draw.currentStroke = null; redrawStrokes(); updateSubmitButton();
  }
  async function onPhotoPicked(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { alert('Photo too large (>15MB). Try a smaller one.'); return; }
    if (draw.strokes.length > 0) {
      if (!confirm('Replace your digital drawing with this photo?')) return;
      draw.strokes = []; redrawStrokes();
    }
    submitStatusEl.textContent = 'Processing photo…';
    try {
      const resized = await resizeAndConvertToJpeg(file, 1800);
      if (pickedPhoto && pickedPhoto.previewUrl) URL.revokeObjectURL(pickedPhoto.previewUrl);
      const previewUrl = URL.createObjectURL(resized);
      pickedPhoto = { blob: resized, previewUrl };
      photoPreviewEl.querySelector('img').src = previewUrl;
      photoPreviewEl.hidden = false;
      submitStatusEl.textContent = '';
      updateSubmitButton();
    } catch (err) {
      submitStatusEl.textContent = 'Could not process photo: ' + (err && err.message || 'unknown');
      submitStatusEl.classList.add('bpc-redesign-submit-status--error');
    }
  }
  async function resizeAndConvertToJpeg(file, maxEdge) {
    const bitmap = await createImageBitmap(file);
    const ratio = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * ratio);
    const h = Math.round(bitmap.height * ratio);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close && bitmap.close();
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob); else reject(new Error('Could not encode image'));
      }, 'image/jpeg', 0.85);
    });
  }
  function clearPhoto() {
    if (pickedPhoto && pickedPhoto.previewUrl) URL.revokeObjectURL(pickedPhoto.previewUrl);
    pickedPhoto = null;
    photoPreviewEl.hidden = true;
    photoPreviewEl.querySelector('img').src = '';
    updateSubmitButton();
  }
  function updateSubmitButton() {
    if (!submitBtnEl) return;
    const hasContent = draw.strokes.length > 0 || pickedPhoto || (noteTextareaEl && noteTextareaEl.value.trim().length > 0);
    submitBtnEl.disabled = !hasContent;
    if (submitStatusEl && submitStatusEl.classList.contains('bpc-redesign-submit-status--error')) {
      if (hasContent) {
        submitStatusEl.textContent = '';
        submitStatusEl.classList.remove('bpc-redesign-submit-status--error');
      }
    }
  }
  async function submitRedesign() {
    const slug = getSlugFromPath();
    const token = getAuthToken();
    if (!slug || !token) {
      submitStatusEl.textContent = 'You need to be signed in to submit. Refresh and try again.';
      submitStatusEl.classList.add('bpc-redesign-submit-status--error');
      return;
    }
    submitBtnEl.disabled = true;
    submitBtnEl.textContent = 'Sending…';
    submitStatusEl.textContent = '';
    submitStatusEl.classList.remove('bpc-redesign-submit-status--error', 'bpc-redesign-submit-status--success');
    try {
      const info = getSiteMapInfo();
      const fd = new FormData();
      fd.append('slug', slug);
      const note = (noteTextareaEl.value || '').trim();
      if (note) fd.append('homeowner_note', note);
      if (info && info.url) fd.append('site_map_url', info.url);
      if (info && info.width) fd.append('site_map_width', String(info.width));
      if (info && info.height) fd.append('site_map_height', String(info.height));
      if (draw.strokes.length > 0) fd.append('markup_svg', serializeStrokesToSvg(info));
      if (pickedPhoto && pickedPhoto.blob) fd.append('photo', pickedPhoto.blob, 'markup.jpg');
      const resp = await fetch(API_REDESIGN, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: fd,
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        submitStatusEl.textContent = 'Could not send: ' + (result.error || ('HTTP ' + resp.status));
        submitStatusEl.classList.add('bpc-redesign-submit-status--error');
        submitBtnEl.disabled = false;
        submitBtnEl.textContent = 'Send to designer';
        return;
      }
      submitBtnEl.textContent = 'Sent ✓';
      submitStatusEl.textContent = result.email_sent
        ? 'Sent to your designer. They\'ll review and follow up.'
        : 'Submitted. Your designer will see this in the queue.';
      submitStatusEl.classList.add('bpc-redesign-submit-status--success');
      setTimeout(() => {
        draw.strokes = [];
        if (pickedPhoto && pickedPhoto.previewUrl) URL.revokeObjectURL(pickedPhoto.previewUrl);
        pickedPhoto = null;
        if (noteTextareaEl) noteTextareaEl.value = '';
        closeOverlay();
      }, 2500);
    } catch (err) {
      submitStatusEl.textContent = 'Network error: ' + (err && err.message || 'unknown');
      submitStatusEl.classList.add('bpc-redesign-submit-status--error');
      submitBtnEl.disabled = false;
      submitBtnEl.textContent = 'Send to designer';
    }
  }
  function serializeStrokesToSvg(info) {
    const w = (info && info.width) || 1000;
    const h = (info && info.height) || 750;
    const strokeWidth = Math.max(2, Math.round(w / 200));
    const polylines = draw.strokes
      .filter(s => s.points.length >= 2)
      .map((s) => {
        const d = s.points.map(p => p.x + ',' + p.y).join(' ');
        return '<polyline points="' + d + '" stroke="' + s.color + '" fill="none" stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-linejoin="round"/>';
      }).join('');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '">' + polylines + '</svg>';
  }

  // ════════════════════════════════════════════════════════════════════
  // RESHAPE OVERLAY — Phase 16 unified editor
  // (polygon geometry + material swap + live $ readout)
  // ════════════════════════════════════════════════════════════════════

  function parseAreaFromMetaText(text) {
    if (!text) return { sqft: 0, lnft: 0 };
    const sqftMatch = text.match(/([\d,]+(?:\.\d+)?)\s*sqft/i);
    const lnftMatch = text.match(/([\d,]+(?:\.\d+)?)\s*lnft/i);
    const sqft = sqftMatch ? parseFloat(sqftMatch[1].replace(/,/g, '')) : 0;
    const lnft = lnftMatch ? parseFloat(lnftMatch[1].replace(/,/g, '')) : 0;
    return { sqft: Number.isFinite(sqft) ? sqft : 0, lnft: Number.isFinite(lnft) ? lnft : 0 };
  }

  function parsePolygonPoints(svgPoints, W, H) {
    if (!svgPoints || !W || !H) return [];
    return svgPoints.trim().split(/\s+/).map((pair) => {
      const [xs, ys] = pair.split(',');
      const x = parseFloat(xs), y = parseFloat(ys);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x: x / W, y: y / H };
    }).filter(Boolean);
  }

  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  function readPublishedRegionsFromDom() {
    const svg = document.querySelector('.pub-drawing-overlay-svg');
    if (!svg) return null;
    const vbAttr = svg.getAttribute('viewBox');
    if (!vbAttr) return null;
    const [, , vbW, vbH] = vbAttr.split(/\s+/).map(Number);
    if (!Number.isFinite(vbW) || !Number.isFinite(vbH) || vbW <= 0 || vbH <= 0) return null;
    const imageEl = document.querySelector('.pub-drawing-overlay-img');
    const backdropUrl = imageEl ? (imageEl.src || imageEl.getAttribute('src') || '') : '';

    const regions = [];
    svg.querySelectorAll('polygon[data-region-id]').forEach((poly, idx) => {
      const id = poly.getAttribute('data-region-id');
      if (!id) return;
      const ariaSelf = poly.getAttribute('aria-label');
      const ariaAnchor = poly.parentNode && poly.parentNode.getAttribute
        ? poly.parentNode.getAttribute('aria-label') : null;
      const name = ariaSelf || ariaAnchor || ('Region ' + (idx + 1));
      const polygon = parsePolygonPoints(poly.getAttribute('points'), vbW, vbH);
      if (polygon.length < 3) return;
      const legendRow = document.querySelector(
        '.pub-region-legend-row[data-region-id="' + cssEscape(id) + '"]'
      );
      const metaText = legendRow
        ? (legendRow.querySelector('.pub-region-legend-meta')
            ? legendRow.querySelector('.pub-region-legend-meta').textContent : '')
        : '';
      const { sqft, lnft } = parseAreaFromMetaText(metaText);
      regions.push({
        id, name,
        color: RESHAPE_PALETTE[idx % RESHAPE_PALETTE.length],
        original_polygon: polygon.map(p => ({ x: p.x, y: p.y })),
        modified_polygon: polygon.map(p => ({ x: p.x, y: p.y })),
        original_area_sqft: sqft,
        original_area_lnft: lnft,
        // Phase 16 fields — populated async after customize-data fetch
        current_material: null,
        proposal_region_material_id: null,
        pending_material: null,
        pending_material_id: null,
        original_subtotal: 0,
        unit_price_sqft: 0,
      });
    });
    return { regions, backdropW: vbW, backdropH: vbH, backdropUrl };
  }

  function shoelaceArea(polygon) {
    if (!polygon || polygon.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  }
  function shoelacePerimeter(polygon) {
    if (!polygon || polygon.length < 2) return 0;
    let perim = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      perim += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return perim;
  }
  function computeModifiedSqft(region) {
    const origArea = shoelaceArea(region.original_polygon);
    if (origArea < 1e-9) return region.original_area_sqft || 0;
    const newArea = shoelaceArea(region.modified_polygon);
    return Math.round((region.original_area_sqft || 0) * (newArea / origArea));
  }
  function computeModifiedLnft(region) {
    const origPerim = shoelacePerimeter(region.original_polygon);
    if (origPerim < 1e-9) return region.original_area_lnft || 0;
    const newPerim = shoelacePerimeter(region.modified_polygon);
    return Math.round((region.original_area_lnft || 0) * (newPerim / origPerim));
  }
  function regionWasModified(region) {
    const a = region.original_polygon, b = region.modified_polygon;
    if (!a || !b || a.length !== b.length) return true;
    const EPS = 1e-4;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i].x - b[i].x) > EPS) return true;
      if (Math.abs(a[i].y - b[i].y) > EPS) return true;
    }
    return false;
  }
  function regionMaterialChanged(region) {
    return !!region.pending_material_id;
  }
  function regionHasAnyChange(region) {
    return regionWasModified(region) || regionMaterialChanged(region);
  }

  // Phase 16 — compute baseline pricing from p-customize.js's bid reader.
  // Strategy: fuzzy-match section names (from .bpc-bid-reader-row-name) to
  // region names. If matched, region's section subtotal becomes its
  // baseline; $/sqft = subtotal / original_sqft. Unmatched regions fall
  // back to project_total / total_sqft (uniform average).
  function computeBaselinePricing(regions) {
    const out = {
      projectTotal: 0,
      projectOrigSqft: 0,
      projectAvgPerSqft: 0,
    };
    // Sum total sqft across regions (used for fallback uniform pricing)
    out.projectOrigSqft = regions.reduce((s, r) => s + (r.original_area_sqft || 0), 0);

    // Read project total — first from bid reader's total card, then fall
    // back to summing visible scope-item amounts.
    const totalEl = document.querySelector('.bpc-bid-total-amount');
    if (totalEl) {
      const n = parseFloat((totalEl.textContent || '').replace(/[^0-9.\-]/g, ''));
      if (Number.isFinite(n) && n > 0) out.projectTotal = n;
    }
    if (out.projectTotal === 0) {
      // Bid reader hasn't run yet (or proposal has no scope) — sum any
      // visible scope-item amounts as best-effort.
      let sum = 0;
      document.querySelectorAll('.pub-scope-item-amount, .bpc-bid-reader-row-amount').forEach((el) => {
        const n = parseFloat((el.textContent || '').replace(/[^0-9.\-]/g, ''));
        if (Number.isFinite(n)) sum += n;
      });
      out.projectTotal = sum;
    }
    if (out.projectOrigSqft > 0) {
      out.projectAvgPerSqft = out.projectTotal / out.projectOrigSqft;
    }

    // Build a list of bid-reader rows we can match against
    const rows = Array.from(document.querySelectorAll('.bpc-bid-reader-row'));
    const norm = (s) => String(s || '').toLowerCase()
      .replace(/[\u2014\u2013\u2018\u2019.,:;!?]/g, '')
      .replace(/\s+/g, ' ').trim();

    regions.forEach((r) => {
      const regNorm = norm(r.name);
      if (!regNorm) {
        r.unit_price_sqft = out.projectAvgPerSqft;
        return;
      }
      // Find first row whose normalized name contains the region name
      // (or vice versa, since sections often have longer descriptive titles).
      let matchedRow = null;
      for (const row of rows) {
        const nameEl = row.querySelector('.bpc-bid-reader-row-name');
        if (!nameEl) continue;
        const rowNorm = norm(nameEl.textContent);
        if (!rowNorm) continue;
        if (rowNorm.includes(regNorm) || regNorm.includes(rowNorm)) {
          matchedRow = row;
          break;
        }
      }
      if (matchedRow) {
        const amtEl = matchedRow.querySelector('.bpc-bid-reader-row-amount');
        const amt = amtEl ? parseFloat((amtEl.textContent || '').replace(/[^0-9.\-]/g, '')) : 0;
        if (Number.isFinite(amt) && amt > 0) {
          r.original_subtotal = amt;
          if (r.original_area_sqft > 0) {
            r.unit_price_sqft = amt / r.original_area_sqft;
            return;
          }
        }
      }
      // Fallback — uniform project average per sqft
      r.original_subtotal = (r.original_area_sqft || 0) * out.projectAvgPerSqft;
      r.unit_price_sqft = out.projectAvgPerSqft;
    });

    return out;
  }

  // Per-region estimated total at current geometry. Material swap does
  // NOT adjust per-region $ today (material unit costs aren't in the
  // catalog — see Phase 2 note at top). The estimate is geometry-driven.
  function computeRegionEstimate(region) {
    const sqft = computeModifiedSqft(region);
    if (region.unit_price_sqft > 0) return sqft * region.unit_price_sqft;
    return region.original_subtotal || 0;
  }

  function computeProjectEstimate() {
    return reshape.regions.reduce((s, r) => s + computeRegionEstimate(r), 0);
  }

  // ── Open / close ─────────────────────────────────────────────────────
  function openReshapeOverlay() {
    if (reshapeOverlayEl) return;
    const info = getSiteMapInfo();
    const data = readPublishedRegionsFromDom();
    if (!info || !info.url || !data || data.regions.length === 0) {
      alert(
        'Could not find any regions to edit. ' +
        'Please refresh the page or use "Suggest changes" to send a markup or photo instead.'
      );
      return;
    }

    reshape.regions = data.regions;
    reshape.swapCandidates = {};
    reshape.selectedIdx = 0;
    reshape.isDragging = false;
    reshape.dragRegionIdx = -1;
    reshape.dragVertexIdx = -1;
    reshape.backdropW = data.backdropW;
    reshape.backdropH = data.backdropH;
    reshape.backdropUrl = info.url || data.backdropUrl;
    reshape.customizeFetched = false;
    reshape.customizeFailed = false;

    // Phase 16 — compute pricing baseline from DOM (synchronous, no API needed)
    const pricing = computeBaselinePricing(reshape.regions);
    reshape.projectTotal = pricing.projectTotal;
    reshape.projectOrigSqft = pricing.projectOrigSqft;

    // Build overlay DOM up front so geometry editing works immediately
    reshapeOverlayEl = document.createElement('div');
    reshapeOverlayEl.className = 'bpc-reshape-overlay';
    reshapeOverlayEl.setAttribute('role', 'dialog');
    reshapeOverlayEl.setAttribute('aria-modal', 'true');
    reshapeOverlayEl.innerHTML = renderReshapeOverlayHtml();
    document.body.appendChild(reshapeOverlayEl);

    const stageWrap    = reshapeOverlayEl.querySelector('.bpc-reshape-stage-wrap');
    reshapeStageSvgEl  = stageWrap.querySelector('.bpc-reshape-stage-svg');
    reshapeBackdropEl  = stageWrap.querySelector('.bpc-reshape-stage-bg');
    reshapeDefsEl      = reshapeStageSvgEl.querySelector('defs');
    reshapeRegionsGEl  = reshapeStageSvgEl.querySelector('.bpc-reshape-regions-g');
    reshapeHandlesGEl  = reshapeStageSvgEl.querySelector('.bpc-reshape-handles-g');
    reshapeReadoutEl   = reshapeOverlayEl.querySelector('.bpc-reshape-readout');
    reshapeMaterialPickerEl = reshapeOverlayEl.querySelector('.bpc-reshape-mat-picker');
    reshapeNoteEl      = reshapeOverlayEl.querySelector('.bpc-reshape-note');
    reshapeSubmitBtnEl = reshapeOverlayEl.querySelector('.bpc-reshape-submit-btn');
    reshapeStatusEl    = reshapeOverlayEl.querySelector('.bpc-reshape-status');

    reshapeBackdropEl.src = reshape.backdropUrl;
    reshapeStageSvgEl.setAttribute('viewBox', '0 0 ' + reshape.backdropW + ' ' + reshape.backdropH);

    reshapeOverlayEl.querySelector('.bpc-reshape-close').addEventListener('click', closeReshapeOverlay);
    document.addEventListener('keydown', onReshapeEscClose);

    reshapeOverlayEl.querySelector('.bpc-reshape-chips').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-region-idx]');
      if (!btn) return;
      const idx = parseInt(btn.getAttribute('data-region-idx'), 10);
      if (Number.isFinite(idx)) selectReshapeRegion(idx);
    });

    reshapeOverlayEl.querySelector('[data-action="reset-region"]').addEventListener('click', () => {
      resetReshapeRegion(reshape.selectedIdx);
    });
    reshapeOverlayEl.querySelector('[data-action="reset-all"]').addEventListener('click', resetAllReshape);

    reshapeSubmitBtnEl.addEventListener('click', submitReshape);
    reshapeNoteEl.addEventListener('input', updateReshapeSubmitButton);

    redrawReshapeStage();
    updateReshapeReadout();
    renderMaterialPicker();
    updateReshapeSubmitButton();

    // Phase 16 — fetch materials data in the background. Overlay is
    // already open and geometry editing is fully functional; materials
    // populate when fetch resolves. If it fails, picker shows a
    // friendly "geometry only" message.
    fetchCustomizeAndHydrate();
  }

  function renderReshapeOverlayHtml() {
    const chips = reshape.regions.map((r, i) =>
      '<button type="button" class="bpc-reshape-chip ' + (i === 0 ? 'bpc-reshape-chip--active' : '') + '"' +
        ' data-region-idx="' + i + '">' +
        '<span class="bpc-reshape-chip-dot" style="background:' + r.color + ';"></span>' +
        escapeHtml(r.name) +
      '</button>'
    ).join('');

    return (
      '<div class="bpc-reshape-header">' +
        '<div>' +
          '<h2>Resize · swap · price</h2>' +
          '<div class="bpc-reshape-header-sub">Drag the dots to reshape · tap a swatch to swap material · estimate updates live.</div>' +
        '</div>' +
        '<button type="button" class="bpc-reshape-close" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="bpc-reshape-body">' +
        '<div class="bpc-reshape-hint">' +
          '<strong>Tip:</strong> Pick an area, drag a dot to resize, tap a swatch to swap material, then <em>Send to designer</em> when you\'re happy.' +
        '</div>' +
        '<div class="bpc-reshape-chips">' + chips + '</div>' +
        '<div class="bpc-reshape-mat-picker">' +
          '<div class="bpc-reshape-mat-loading">Loading materials…</div>' +
        '</div>' +
        '<div class="bpc-reshape-stage-wrap">' +
          '<img class="bpc-reshape-stage-bg" alt="Site map">' +
          '<svg class="bpc-reshape-stage-svg" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">' +
            '<defs></defs>' +
            '<g class="bpc-reshape-regions-g"></g>' +
            '<g class="bpc-reshape-handles-g"></g>' +
          '</svg>' +
        '</div>' +
        '<div class="bpc-reshape-toolbar-row">' +
          '<button type="button" class="bpc-reshape-tool-text" data-action="reset-region">↺ Reset this area</button>' +
          '<button type="button" class="bpc-reshape-tool-text" data-action="reset-all">↺↺ Reset all</button>' +
        '</div>' +
        '<div class="bpc-reshape-readout"></div>' +
      '</div>' +
      '<div class="bpc-reshape-footer">' +
        '<div class="bpc-reshape-footer-row">' +
          '<textarea class="bpc-reshape-note" placeholder="Optional note for your designer (e.g., \'Bigger patio for a 6-person dining table, swap Origins 12 for Catalina Grana\')."></textarea>' +
          '<button type="button" class="bpc-reshape-submit-btn" disabled>Send to designer</button>' +
        '</div>' +
        '<div class="bpc-reshape-status"></div>' +
      '</div>'
    );
  }

  function closeReshapeOverlay() {
    if (!reshapeOverlayEl) return;
    const hasChanges = reshape.regions.some(regionHasAnyChange)
      || (reshapeNoteEl && reshapeNoteEl.value.trim());
    if (hasChanges && !confirm('Discard your changes?')) return;
    reshapeOverlayEl.remove();
    reshapeOverlayEl       = null;
    reshapeStageSvgEl      = null;
    reshapeBackdropEl      = null;
    reshapeDefsEl          = null;
    reshapeRegionsGEl      = null;
    reshapeHandlesGEl      = null;
    reshapeReadoutEl       = null;
    reshapeMaterialPickerEl = null;
    reshapeNoteEl          = null;
    reshapeSubmitBtnEl     = null;
    reshapeStatusEl        = null;
    reshape.regions = [];
    reshape.swapCandidates = {};
    reshape.isDragging = false;
    document.removeEventListener('keydown', onReshapeEscClose);
  }

  function onReshapeEscClose(e) { if (e.key === 'Escape') closeReshapeOverlay(); }

  // ── Phase 16 — async customize-data hydration ────────────────────────
  async function fetchCustomizeAndHydrate() {
    const slug = getSlugFromPath();
    const token = getAuthToken();
    if (!slug || !token) {
      reshape.customizeFailed = true;
      renderMaterialPicker();
      return;
    }
    try {
      const r = await fetch(API_CUSTOMIZE + '?slug=' + encodeURIComponent(slug), {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      if (!reshapeOverlayEl) return; // overlay was closed before fetch resolved

      // Map region_id → first proposal_region_material row (display_order=0)
      const rmByRegion = new Map();
      (data.region_materials || []).forEach((rm) => {
        if (!rmByRegion.has(rm.region_id)) rmByRegion.set(rm.region_id, rm);
      });
      reshape.regions.forEach((r) => {
        const rm = rmByRegion.get(r.id);
        if (rm) {
          r.current_material = rm.current;
          r.proposal_region_material_id = rm.id;
        }
      });
      reshape.swapCandidates = data.swap_candidates_by_category || {};
      reshape.customizeFetched = true;

      redrawReshapeStage();          // re-render polygons with material patterns
      renderMaterialPicker();         // populate the picker
      updateReshapeReadout();         // refresh prices (no change but harmless)
    } catch (e) {
      reshape.customizeFailed = true;
      renderMaterialPicker();
    }
  }

  // ── Selection ────────────────────────────────────────────────────────
  function selectReshapeRegion(idx) {
    if (idx < 0 || idx >= reshape.regions.length) return;
    reshape.selectedIdx = idx;
    reshapeOverlayEl.querySelectorAll('.bpc-reshape-chip').forEach((chip) => {
      const i = parseInt(chip.getAttribute('data-region-idx'), 10);
      chip.classList.toggle('bpc-reshape-chip--active', i === idx);
    });
    redrawReshapeStage();
    updateReshapeReadout();
    renderMaterialPicker();
  }

  // ── Phase 16 — material picker rendering ─────────────────────────────
  function renderMaterialPicker() {
    if (!reshapeMaterialPickerEl) return;
    const region = reshape.regions[reshape.selectedIdx];
    if (!region) {
      reshapeMaterialPickerEl.innerHTML = '';
      return;
    }
    if (reshape.customizeFailed) {
      reshapeMaterialPickerEl.innerHTML = '<div class="bpc-reshape-mat-empty">Materials unavailable — geometry-only mode. Submit will still send shape changes to your designer.</div>';
      return;
    }
    if (!reshape.customizeFetched) {
      reshapeMaterialPickerEl.innerHTML = '<div class="bpc-reshape-mat-loading">Loading materials…</div>';
      return;
    }
    if (!region.current_material) {
      reshapeMaterialPickerEl.innerHTML = '<div class="bpc-reshape-mat-empty">No swappable material assigned to <strong>' + escapeHtml(region.name) + '</strong>.</div>';
      return;
    }

    const cm = region.current_material;
    const category = cm.category;
    const cands = (category && reshape.swapCandidates[category]) || [];
    const currentMatId = cm.material_id;

    const currentSwatch = cm.swatch_url
      ? 'background-image:url(\'' + escapeHtml(cm.swatch_url) + '\');'
      : '';
    const pendingPill = region.pending_material
      ? '<span class="bpc-reshape-mat-pending-arrow">→ ' + escapeHtml(region.pending_material.product_name || 'New') + (region.pending_material.color ? ' / ' + escapeHtml(region.pending_material.color) : '') + ' pending</span>'
      : '';
    const undoBtn = region.pending_material
      ? '<button type="button" class="bpc-reshape-mat-undo" data-action="undo-material">Undo swap</button>'
      : '';

    const candsHtml = cands.length === 0
      ? '<div class="bpc-reshape-mat-empty">No alternatives in the catalog yet for this category.</div>'
      : '<div class="bpc-reshape-mat-cands">' + cands.map((c) => {
          const isCurrent = c.id === currentMatId;
          const isPending = region.pending_material_id === c.id;
          const cls = 'bpc-reshape-mat-swatch'
            + (isCurrent ? ' bpc-reshape-mat-swatch--current' : '')
            + (isPending ? ' bpc-reshape-mat-swatch--active' : '');
          const img = c.swatch_url
            ? 'background-image:url(\'' + escapeHtml(c.swatch_url) + '\');'
            : '';
          return '<button type="button" class="' + cls + '" data-mat-id="' + escapeHtml(c.id) + '">' +
            '<span class="bpc-reshape-mat-swatch-img" style="' + img + '"></span>' +
            '<span class="bpc-reshape-mat-swatch-info">' +
              '<span class="bpc-reshape-mat-swatch-name">' + escapeHtml(c.product_name || 'Material') + '</span>' +
              (c.color ? '<span class="bpc-reshape-mat-swatch-color">' + escapeHtml(c.color) + '</span>' : '') +
            '</span>' +
          '</button>';
        }).join('') + '</div>';

    reshapeMaterialPickerEl.innerHTML =
      '<div class="bpc-reshape-mat-current">' +
        '<span class="bpc-reshape-mat-current-thumb" style="' + currentSwatch + '"></span>' +
        '<div class="bpc-reshape-mat-current-info">' +
          '<div class="bpc-reshape-mat-current-label">' + escapeHtml(region.name) + ' · currently</div>' +
          '<div class="bpc-reshape-mat-current-name">' + escapeHtml(cm.product_name || 'Material') +
            (cm.color ? ' <span style="color:#888;font-weight:500;"> · ' + escapeHtml(cm.color) + '</span>' : '') +
            pendingPill +
          '</div>' +
          (cm.manufacturer ? '<div class="bpc-reshape-mat-current-meta">' + escapeHtml(cm.manufacturer) + '</div>' : '') +
        '</div>' +
        undoBtn +
      '</div>' +
      '<div class="bpc-reshape-mat-cands-label">Swap to:</div>' +
      candsHtml;

    // Wire candidate clicks
    reshapeMaterialPickerEl.querySelectorAll('.bpc-reshape-mat-swatch:not(.bpc-reshape-mat-swatch--current)').forEach((btn) => {
      btn.addEventListener('click', () => {
        const matId = btn.getAttribute('data-mat-id');
        applyMaterialSwap(reshape.selectedIdx, matId);
      });
    });
    // Wire undo
    const undo = reshapeMaterialPickerEl.querySelector('[data-action="undo-material"]');
    if (undo) {
      undo.addEventListener('click', () => clearMaterialSwap(reshape.selectedIdx));
    }
  }

  function applyMaterialSwap(regionIdx, matId) {
    const region = reshape.regions[regionIdx];
    if (!region || !region.current_material) return;
    const category = region.current_material.category;
    const cands = (category && reshape.swapCandidates[category]) || [];
    const target = cands.find((c) => c.id === matId);
    if (!target) return;
    // No-op if user tapped the same material that's already pending or
    // tapped the current material (current is pointer-events:none anyway).
    if (region.pending_material_id === matId) return;
    region.pending_material = target;
    region.pending_material_id = matId;
    redrawReshapeStage();   // repaint polygon with new pattern
    renderMaterialPicker(); // refresh swatch active state + undo button
    updateReshapeReadout(); // refresh pending indicator on the region row
    updateReshapeSubmitButton();
  }

  function clearMaterialSwap(regionIdx) {
    const region = reshape.regions[regionIdx];
    if (!region) return;
    region.pending_material = null;
    region.pending_material_id = null;
    redrawReshapeStage();
    renderMaterialPicker();
    updateReshapeReadout();
    updateReshapeSubmitButton();
  }

  // ── Stage rendering (Phase 16 — adds material pattern fills) ──────────
  function redrawReshapeStage() {
    if (!reshapeRegionsGEl || !reshapeHandlesGEl || !reshapeDefsEl) return;
    const W = reshape.backdropW;
    const H = reshape.backdropH;

    // Build <defs> with one <pattern> per region whose effective material
    // (pending if set, else current) has a swatch_url. Pattern tile size
    // is ~6% of backdrop width — small enough to read as a paver pattern,
    // big enough to be recognizable.
    const patternSize = Math.max(32, Math.round(W * 0.055));
    let defsHtml = '';
    reshape.regions.forEach((r, idx) => {
      const effective = r.pending_material || r.current_material;
      if (!effective || !effective.swatch_url) return;
      defsHtml +=
        '<pattern id="bpc-reshape-mat-' + idx + '"' +
          ' patternUnits="userSpaceOnUse" width="' + patternSize + '" height="' + patternSize + '">' +
          '<image href="' + escapeHtml(effective.swatch_url) + '"' +
            ' x="0" y="0" width="' + patternSize + '" height="' + patternSize + '"' +
            ' preserveAspectRatio="xMidYMid slice"/>' +
        '</pattern>';
    });
    reshapeDefsEl.innerHTML = defsHtml;

    // Polygons
    let polysHtml = '';
    reshape.regions.forEach((r, idx) => {
      const points = r.modified_polygon
        .map(p => (p.x * W).toFixed(1) + ',' + (p.y * H).toFixed(1))
        .join(' ');
      const isSel = idx === reshape.selectedIdx;
      const sw = isSel ? Math.max(3, Math.round(W * 0.0026)) : Math.max(2, Math.round(W * 0.0016));
      const effective = r.pending_material || r.current_material;
      const hasPattern = !!(effective && effective.swatch_url);
      // Fill: material pattern at ~0.85 opacity for selected, ~0.55 for
      // others. If no pattern available (catalog not loaded yet or no
      // material assigned), fall back to translucent region color.
      const fill = hasPattern ? 'url(#bpc-reshape-mat-' + idx + ')' : r.color;
      const fillOp = hasPattern
        ? (isSel ? '0.88' : '0.55')
        : (isSel ? '0.32' : '0.18');
      polysHtml +=
        '<polygon class="bpc-reshape-region-poly"' +
          ' points="' + points + '"' +
          ' fill="' + fill + '" fill-opacity="' + fillOp + '"' +
          ' stroke="' + r.color + '" stroke-width="' + sw + '"' +
          ' stroke-linejoin="round"' +
          ' data-region-idx="' + idx + '"' +
          '/>';
    });
    reshapeRegionsGEl.innerHTML = polysHtml;

    reshapeRegionsGEl.querySelectorAll('polygon').forEach((poly) => {
      poly.addEventListener('pointerdown', (e) => {
        if (reshape.isDragging) return;
        const idx = parseInt(poly.getAttribute('data-region-idx'), 10);
        if (Number.isFinite(idx) && idx !== reshape.selectedIdx) {
          selectReshapeRegion(idx);
        }
      });
    });

    // Vertex handles on the selected region only
    const sel = reshape.regions[reshape.selectedIdx];
    if (!sel) { reshapeHandlesGEl.innerHTML = ''; return; }
    const touchish = matchMedia && matchMedia('(pointer: coarse)').matches;
    const handleR = touchish
      ? Math.max(20, Math.round(W * 0.022))
      : Math.max(12, Math.round(W * 0.014));
    let handlesHtml = '';
    sel.modified_polygon.forEach((p, vIdx) => {
      const cx = (p.x * W).toFixed(1);
      const cy = (p.y * H).toFixed(1);
      handlesHtml +=
        '<circle class="bpc-reshape-vertex-handle"' +
          ' cx="' + cx + '" cy="' + cy + '" r="' + handleR + '"' +
          ' fill="#fff" stroke="' + sel.color + '" stroke-width="' + Math.max(2, Math.round(W * 0.0022)) + '"' +
          ' data-vertex-idx="' + vIdx + '"' +
          '/>';
    });
    reshapeHandlesGEl.innerHTML = handlesHtml;
    reshapeHandlesGEl.querySelectorAll('circle').forEach((handle) => {
      handle.addEventListener('pointerdown', onVertexPointerDown);
    });
  }

  // ── Readout (Phase 16 — adds per-region $ + project-total footer) ─────
  function updateReshapeReadout() {
    if (!reshapeReadoutEl) return;
    const rows = reshape.regions.map((r, idx) => {
      const newSqft = computeModifiedSqft(r);
      const newLnft = computeModifiedLnft(r);
      const dSqft = newSqft - (r.original_area_sqft || 0);
      const dPctSqft = (r.original_area_sqft || 0) > 0
        ? Math.round((dSqft / r.original_area_sqft) * 100) : 0;
      const cls = dSqft > 0 ? 'is-up' : (dSqft < 0 ? 'is-down' : '');
      const isSel = idx === reshape.selectedIdx;
      const isModified = regionHasAnyChange(r);

      const sqftMeta = (r.original_area_sqft || 0) > 0
        ? Number(r.original_area_sqft).toLocaleString('en-US') + ' sqft → ' + newSqft.toLocaleString('en-US') + ' sqft'
        : 'No square footage';
      const lnftMeta = (r.original_area_lnft || 0) > 0
        ? Number(r.original_area_lnft).toLocaleString('en-US') + ' lnft → ' + newLnft.toLocaleString('en-US') + ' lnft'
        : '';
      const matPending = r.pending_material
        ? '<span style="color:#b78b3a;font-weight:600;"> · material swap pending</span>'
        : '';
      const deltaLabel = (r.original_area_sqft || 0) > 0
        ? (dSqft > 0 ? '+' : '') + dPctSqft + '%'
        : '—';
      const estimate = computeRegionEstimate(r);
      const priceHtml = estimate > 0
        ? '<div class="bpc-reshape-readout-price">' + fmtMoney(estimate) + '</div>'
        : '<div class="bpc-reshape-readout-price bpc-reshape-readout-price-empty">—</div>';

      return (
        '<div class="bpc-reshape-readout-row ' + (isSel ? 'is-selected' : '') + '" data-region-idx="' + idx + '">' +
          '<span class="bpc-reshape-readout-dot" style="background:' + r.color + ';"></span>' +
          '<div>' +
            '<div class="bpc-reshape-readout-name">' + escapeHtml(r.name) + '</div>' +
            '<div class="bpc-reshape-readout-meta">' + escapeHtml(sqftMeta) + (lnftMeta ? ' · ' + escapeHtml(lnftMeta) : '') + matPending + '</div>' +
          '</div>' +
          '<span class="bpc-reshape-readout-delta ' + cls + '">' + deltaLabel + '</span>' +
          priceHtml +
          '<div class="bpc-reshape-readout-row-actions">' +
            '<button type="button" class="bpc-reshape-readout-reset" data-region-idx="' + idx + '"' +
              (isModified ? '' : ' disabled') + '>Reset</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    const projectEstimate = computeProjectEstimate();
    const baseline = reshape.projectTotal;
    const totalHtml = projectEstimate > 0
      ? '<div class="bpc-reshape-readout-total">' +
          '<div class="bpc-reshape-readout-total-label">Estimated project total<small>Final pricing confirmed by your designer</small></div>' +
          '<div>' +
            '<span class="bpc-reshape-readout-total-value">' + fmtMoney(projectEstimate) + '</span>' +
            (baseline > 0 && Math.abs(projectEstimate - baseline) > 50
              ? '<span class="bpc-reshape-readout-total-value-baseline">' + fmtMoney(baseline) + '</span>'
              : '') +
          '</div>' +
        '</div>'
      : '';

    reshapeReadoutEl.innerHTML = rows + totalHtml;

    reshapeReadoutEl.querySelectorAll('.bpc-reshape-readout-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const idx = parseInt(row.getAttribute('data-region-idx'), 10);
        if (Number.isFinite(idx)) selectReshapeRegion(idx);
      });
    });
    reshapeReadoutEl.querySelectorAll('.bpc-reshape-readout-reset').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-region-idx'), 10);
        if (Number.isFinite(idx)) resetReshapeRegion(idx);
      });
    });
  }

  // ── Vertex drag (unchanged from 14C.15) ──────────────────────────────
  function svgPointFromEventReshape(e) {
    const rect = reshapeStageSvgEl.getBoundingClientRect();
    const W = reshape.backdropW, H = reshape.backdropH;
    const localX = e.clientX - rect.left, localY = e.clientY - rect.top;
    return {
      x: Math.max(0, Math.min(W, (localX / rect.width) * W)),
      y: Math.max(0, Math.min(H, (localY / rect.height) * H)),
    };
  }
  function onVertexPointerDown(e) {
    const handle = e.currentTarget;
    const vIdx = parseInt(handle.getAttribute('data-vertex-idx'), 10);
    if (!Number.isFinite(vIdx)) return;
    e.preventDefault(); e.stopPropagation();
    if (handle.setPointerCapture) { try { handle.setPointerCapture(e.pointerId); } catch (_) {} }
    handle.classList.add('bpc-reshape-vertex-handle--dragging');
    reshape.isDragging = true;
    reshape.dragRegionIdx = reshape.selectedIdx;
    reshape.dragVertexIdx = vIdx;
    handle.addEventListener('pointermove', onVertexPointerMove);
    handle.addEventListener('pointerup', onVertexPointerUp);
    handle.addEventListener('pointercancel', onVertexPointerUp);
    handle.addEventListener('lostpointercapture', onVertexPointerUp);
  }
  function onVertexPointerMove(e) {
    if (!reshape.isDragging) return;
    e.preventDefault();
    const region = reshape.regions[reshape.dragRegionIdx];
    if (!region) return;
    const px = svgPointFromEventReshape(e);
    const W = reshape.backdropW, H = reshape.backdropH;
    region.modified_polygon[reshape.dragVertexIdx] = {
      x: Math.max(0, Math.min(1, px.x / W)),
      y: Math.max(0, Math.min(1, px.y / H)),
    };
    const polyEl = reshapeRegionsGEl.querySelector(
      'polygon[data-region-idx="' + reshape.dragRegionIdx + '"]'
    );
    if (polyEl) {
      const points = region.modified_polygon
        .map(p => (p.x * W).toFixed(1) + ',' + (p.y * H).toFixed(1)).join(' ');
      polyEl.setAttribute('points', points);
    }
    const handle = e.currentTarget;
    handle.setAttribute('cx', (region.modified_polygon[reshape.dragVertexIdx].x * W).toFixed(1));
    handle.setAttribute('cy', (region.modified_polygon[reshape.dragVertexIdx].y * H).toFixed(1));
    updateReshapeReadout();
  }
  function onVertexPointerUp(e) {
    if (!reshape.isDragging) return;
    reshape.isDragging = false;
    const handle = e.currentTarget;
    if (handle && handle.classList) handle.classList.remove('bpc-reshape-vertex-handle--dragging');
    if (handle && handle.releasePointerCapture) { try { handle.releasePointerCapture(e.pointerId); } catch (_) {} }
    if (handle) {
      handle.removeEventListener('pointermove', onVertexPointerMove);
      handle.removeEventListener('pointerup', onVertexPointerUp);
      handle.removeEventListener('pointercancel', onVertexPointerUp);
      handle.removeEventListener('lostpointercapture', onVertexPointerUp);
    }
    reshape.dragRegionIdx = -1; reshape.dragVertexIdx = -1;
    updateReshapeSubmitButton();
  }

  // ── Reset ────────────────────────────────────────────────────────────
  function resetReshapeRegion(idx) {
    const r = reshape.regions[idx];
    if (!r) return;
    if (!regionHasAnyChange(r)) return;
    r.modified_polygon = r.original_polygon.map(p => ({ x: p.x, y: p.y }));
    r.pending_material = null;
    r.pending_material_id = null;
    redrawReshapeStage();
    updateReshapeReadout();
    renderMaterialPicker();
    updateReshapeSubmitButton();
  }
  function resetAllReshape() {
    const anyChanged = reshape.regions.some(regionHasAnyChange);
    if (!anyChanged) return;
    if (!confirm('Reset all areas and material swaps?')) return;
    reshape.regions.forEach((r) => {
      r.modified_polygon = r.original_polygon.map(p => ({ x: p.x, y: p.y }));
      r.pending_material = null;
      r.pending_material_id = null;
    });
    redrawReshapeStage();
    updateReshapeReadout();
    renderMaterialPicker();
    updateReshapeSubmitButton();
  }

  // ── Submit (Phase 16 — parallel POSTs to redesign + substitutions) ───
  function updateReshapeSubmitButton() {
    if (!reshapeSubmitBtnEl) return;
    const anyChanged = reshape.regions.some(regionHasAnyChange);
    reshapeSubmitBtnEl.disabled = !anyChanged;
    if (reshapeStatusEl && reshapeStatusEl.classList.contains('bpc-reshape-status--error')) {
      if (anyChanged) {
        reshapeStatusEl.textContent = '';
        reshapeStatusEl.classList.remove('bpc-reshape-status--error');
      }
    }
  }

  async function submitReshape() {
    const slug = getSlugFromPath();
    const token = getAuthToken();
    if (!slug || !token) {
      reshapeStatusEl.textContent = 'You need to be signed in to submit. Refresh and try again.';
      reshapeStatusEl.classList.add('bpc-reshape-status--error');
      return;
    }

    const note = (reshapeNoteEl.value || '').trim();

    // Partition pending changes
    const modifiedRegions = reshape.regions
      .filter(regionWasModified)
      .map((r) => ({
        region_id: r.id,
        region_name: r.name,
        color: r.color,
        original_polygon: r.original_polygon,
        modified_polygon: r.modified_polygon,
        original_area_sqft: r.original_area_sqft || 0,
        modified_area_sqft: computeModifiedSqft(r),
        original_area_lnft: r.original_area_lnft || 0,
        modified_area_lnft: computeModifiedLnft(r),
      }));

    const materialChanges = reshape.regions
      .filter(regionMaterialChanged)
      .filter((r) => r.proposal_region_material_id)
      .map((r) => ({
        proposal_region_material_id: r.proposal_region_material_id,
        replacement_material_id: r.pending_material_id,
      }));

    if (modifiedRegions.length === 0 && materialChanges.length === 0) {
      reshapeStatusEl.textContent = 'Drag a vertex or tap a material swatch to make a change first.';
      reshapeStatusEl.classList.add('bpc-reshape-status--error');
      return;
    }

    reshapeSubmitBtnEl.disabled = true;
    reshapeSubmitBtnEl.textContent = 'Sending…';
    reshapeStatusEl.textContent = '';
    reshapeStatusEl.classList.remove('bpc-reshape-status--error', 'bpc-reshape-status--success');

    // Build the two parallel submissions. Either or both may be skipped
    // if there's nothing in that category.
    const tasks = [];
    if (modifiedRegions.length > 0) {
      const fd = new FormData();
      fd.append('slug', slug);
      fd.append('modified_polygons', JSON.stringify(modifiedRegions));
      if (note) fd.append('homeowner_note', note);
      if (reshape.backdropUrl) fd.append('site_map_url', reshape.backdropUrl);
      if (reshape.backdropW) fd.append('site_map_width', String(reshape.backdropW));
      if (reshape.backdropH) fd.append('site_map_height', String(reshape.backdropH));
      tasks.push(
        fetch(API_REDESIGN, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token },
          body: fd,
        }).then(async (r) => ({
          kind: 'redesign',
          ok: r.ok,
          status: r.status,
          json: await r.json().catch(() => ({})),
        }))
      );
    }
    if (materialChanges.length > 0) {
      tasks.push(
        fetch(API_SUBSTITUTIONS, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
          },
          body: JSON.stringify({
            slug,
            homeowner_note: note || null,
            items: materialChanges,
          }),
        }).then(async (r) => ({
          kind: 'substitutions',
          ok: r.ok,
          status: r.status,
          json: await r.json().catch(() => ({})),
        }))
      );
    }

    try {
      const results = await Promise.all(tasks);
      const failures = results.filter((r) => !r.ok);
      if (failures.length > 0) {
        const msgs = failures.map((f) =>
          (f.kind === 'redesign' ? 'Shape changes: ' : 'Material swaps: ') +
          (f.json && f.json.error ? f.json.error : ('HTTP ' + f.status))
        );
        reshapeStatusEl.textContent = 'Some changes failed — ' + msgs.join(' · ');
        reshapeStatusEl.classList.add('bpc-reshape-status--error');
        reshapeSubmitBtnEl.disabled = false;
        reshapeSubmitBtnEl.textContent = 'Send to designer';
        return;
      }

      // Build a friendly success message
      const parts = [];
      if (modifiedRegions.length > 0) parts.push(modifiedRegions.length + ' shape change' + (modifiedRegions.length === 1 ? '' : 's'));
      if (materialChanges.length > 0) parts.push(materialChanges.length + ' material swap' + (materialChanges.length === 1 ? '' : 's'));
      const emailSent = results.some((r) => r.json && r.json.email_sent);
      reshapeSubmitBtnEl.textContent = 'Sent ✓';
      reshapeStatusEl.textContent =
        parts.join(' + ') + ' submitted' +
        (emailSent ? ' — your designer has been emailed.' : ' to your designer\'s queue.');
      reshapeStatusEl.classList.add('bpc-reshape-status--success');

      // Auto-close. Pre-clear so confirm() doesn't fire.
      setTimeout(() => {
        reshape.regions.forEach((r) => {
          r.modified_polygon = r.original_polygon.map(p => ({ x: p.x, y: p.y }));
          r.pending_material = null;
          r.pending_material_id = null;
        });
        if (reshapeNoteEl) reshapeNoteEl.value = '';
        closeReshapeOverlay();
      }, 2500);

    } catch (err) {
      reshapeStatusEl.textContent = 'Network error: ' + (err && err.message || 'unknown');
      reshapeStatusEl.classList.add('bpc-reshape-status--error');
      reshapeSubmitBtnEl.disabled = false;
      reshapeSubmitBtnEl.textContent = 'Send to designer';
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    renderFab();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
