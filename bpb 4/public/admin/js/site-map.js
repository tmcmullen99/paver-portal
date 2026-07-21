/**
 * BPB Phase 1A — Site Map Editor (admin JS module)
 *
 * Responsibilities:
 *   - Load backdrop image and existing regions for a proposal
 *   - Polygon drawing: click to add vertex, double-click to close, ESC to cancel
 *   - Polygon editing: click to select, drag vertex to move, right-click vertex to delete
 *   - Side panel: name + sqft + lnft + section + materials per region, "Save All" persists everything
 *
 * Coordinate system:
 *   - Polygon vertices are stored as {x, y} fractions in [0..1] of backdrop dimensions
 *   - The canvas renders at the backdrop's native pixel dimensions
 *   - Mouse events are translated from canvas pixels to fractions before storage
 *
 * Per Principle 2 (simplicity): no zoom, no pan in v1.
 *
 * Phase 1B.3 additions:
 *   - state.materials holds the proposal's materials with embedded catalog rows
 *     (Belgard / third-party) for picker display.
 *   - each region carries a `materials: [{proposal_material_id, display_order}]`
 *     array reflecting proposal_region_materials assignments.
 *   - Each region card shows a togglable pill list of all proposal materials.
 *     Click a pill to add/remove from the region's set; order = pick order.
 *   - Snapshot wiring: pushUndoSnapshot('toggle material') before each pill click
 *     so Cmd+Z reverses one click per stroke.
 *
 * Phase 4.1 Sprint A: McMullen palette → Paver Portal palette for non-region UI.
 *
 * Phase 6.1 (Cam To Plan import) additions — all additive, no existing behavior changed:
 *   - state.scale: { pixelsPerFoot, p1Frac, p2Frac, realDistanceInches, calibratedAt } | null
 *   - state.calibration: in-progress calibration capture (idle | awaiting_p1 | awaiting_p2 | awaiting_distance)
 *   - "Set Scale" header button → enters calibration mode
 *   - Length parser: "60' 10\"", "60'10\"", "60.83'", "729\"", "729 in", "60 ft 10 in" → inches
 *   - Length formatter: inches → "60' 10\"" or "60' 10 1/4\"" (rounded to nearest 1/4")
 *   - Edge labels on closed polygons (when scale set), filtered to edges ≥ 12"
 *   - Auto-compute area_sqft via shoelace on polygon close + vertex-edit commits
 *   - Wizard hints when ?wizard=1 in URL — top-right card guiding upload → calibrate → trace
 *   - Scale persists immediately to /api/site-map-scale on calibration commit
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  proposalId: null,
  backdrop: null,
  backdropImg: null,
  regions: [],
  selectedRegionIdx: -1,
  draftPolygon: null,
  drag: null,
  hoveredVertex: null,
  cursorPx: null,
  polygonDrag: null,
  hoveredEdge: null,
  sections: [],
  materials: [],

  // ── Phase 6.1: scale & calibration ─────────────────────────────────────
  scale: null,        // { pixelsPerFoot, p1Frac, p2Frac, realDistanceInches, calibratedAt } | null
  calibration: null,  // { step:'awaiting_p1'|'awaiting_p2'|'awaiting_distance', p1Frac?, p2Frac? }
  wizard: false,      // true when ?wizard=1 in URL
};

const REGION_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
  '#a855f7', '#f43f5e',
];
function colorForIndex(i) { return REGION_COLORS[i % REGION_COLORS.length]; }

// ---------------------------------------------------------------------------
// Undo / Redo stack (unchanged)
// ---------------------------------------------------------------------------
const UNDO_LIMIT = 50;
const undoStack = { past: [], future: [] };

function cloneRegions() { return JSON.parse(JSON.stringify(state.regions)); }

function pushUndoSnapshot(label) {
  undoStack.past.push({ regions: cloneRegions(), label });
  if (undoStack.past.length > UNDO_LIMIT) undoStack.past.shift();
  undoStack.future = [];
}

function undo() {
  if (undoStack.past.length === 0) { setStatus('Nothing to undo'); return; }
  const currentLabel = undoStack.past[undoStack.past.length - 1].label;
  undoStack.future.push({ regions: cloneRegions(), label: currentLabel });
  const prev = undoStack.past.pop();
  state.regions = prev.regions;
  if (state.selectedRegionIdx >= state.regions.length) state.selectedRegionIdx = -1;
  state.draftPolygon = null;
  state.cursorPx = null;
  state.drag = null;
  state.polygonDrag = null;
  state.hoveredEdge = null;
  refreshSidePanel();
  redraw();
  els.btnSave.disabled = false;
  setStatus(`Undid: ${currentLabel}`);
}

function redo() {
  if (undoStack.future.length === 0) { setStatus('Nothing to redo'); return; }
  const next = undoStack.future.pop();
  undoStack.past.push({ regions: cloneRegions(), label: next.label });
  state.regions = next.regions;
  if (state.selectedRegionIdx >= state.regions.length) state.selectedRegionIdx = -1;
  state.draftPolygon = null;
  state.cursorPx = null;
  state.drag = null;
  state.polygonDrag = null;
  state.hoveredEdge = null;
  refreshSidePanel();
  redraw();
  els.btnSave.disabled = false;
  setStatus(`Redid: ${next.label}`);
}

function resetUndoStack() {
  undoStack.past = [];
  undoStack.future = [];
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const els = {
  canvas: document.getElementById('sm-canvas'),
  canvasInner: document.getElementById('sm-canvas-inner'),
  empty: document.getElementById('sm-empty'),
  status: document.getElementById('sm-status'),
  proposalLabel: document.getElementById('sm-proposal-label'),
  btnUpload: document.getElementById('sm-btn-upload'),
  btnSave: document.getElementById('sm-btn-save'),
  btnAddRegion: document.getElementById('sm-btn-add-region'),
  fileInput: document.getElementById('sm-file-input'),
  sideList: document.getElementById('sm-side-list'),
  regionCount: document.getElementById('sm-region-count'),
  toastWrap: document.getElementById('sm-toast-wrap'),
  modalBackdrop: document.getElementById('sm-modal-backdrop'),
  modalInput: document.getElementById('sm-modal-input'),
  modalOk: document.getElementById('sm-modal-ok'),
  // Phase 6.1
  btnSetScale: document.getElementById('sm-btn-set-scale'),
  scaleIndicator: document.getElementById('sm-scale-indicator'),
  scaleModalBackdrop: document.getElementById('sm-scale-modal-backdrop'),
  scaleModalInput: document.getElementById('sm-scale-modal-input'),
  scaleModalOk: document.getElementById('sm-scale-modal-ok'),
  scaleModalCancel: document.getElementById('sm-scale-modal-cancel'),
  scaleModalError: document.getElementById('sm-scale-modal-error'),
  wizardCard: document.getElementById('sm-wizard-card'),
  wizardStepLabel: document.getElementById('sm-wizard-step-label'),
  wizardTitle: document.getElementById('sm-wizard-title'),
  wizardDesc: document.getElementById('sm-wizard-desc'),
  wizardClose: document.getElementById('sm-wizard-close'),
};
const ctx = els.canvas.getContext('2d');

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
function toast(message, kind = 'info', durationMs = 3000) {
  const el = document.createElement('div');
  el.className = `sm-toast sm-toast-${kind}`;
  el.textContent = message;
  els.toastWrap.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function apiGetRegions(proposalId) {
  const r = await fetch(`/api/site-map-regions?proposal_id=${proposalId}`);
  if (!r.ok) throw new Error(`GET regions failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function apiSaveRegions(proposalId, regions) {
  const cleaned = regions.map(({ _color, ...r }) => r);
  const r = await fetch('/api/site-map-regions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposal_id: proposalId, regions: cleaned }),
  });
  if (!r.ok) throw new Error(`Save failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function apiUploadBackdrop(proposalId, file) {
  const fd = new FormData();
  fd.append('proposal_id', proposalId);
  fd.append('file', file);
  const r = await fetch('/api/site-map-backdrop-upload', { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`Upload failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Phase 6.1
async function apiSaveScale(proposalId, scale) {
  const r = await fetch('/api/site-map-scale', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposal_id: proposalId, scale }),
  });
  if (!r.ok) throw new Error(`Scale save failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Backdrop loading
// ---------------------------------------------------------------------------
function loadBackdropImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed: ' + url));
    img.src = url;
  });
}

async function setBackdrop(backdrop) {
  if (!backdrop || !backdrop.site_plan_backdrop_url) {
    state.backdrop = null;
    state.backdropImg = null;
    els.empty.style.display = 'flex';
    els.canvasInner.style.display = 'none';
    refreshScaleIndicator();
    refreshWizardCard();
    return;
  }
  state.backdrop = {
    url: backdrop.site_plan_backdrop_url,
    width: backdrop.site_plan_backdrop_width,
    height: backdrop.site_plan_backdrop_height,
  };
  state.backdropImg = await loadBackdropImage(state.backdrop.url);
  els.canvas.width = state.backdrop.width;
  els.canvas.height = state.backdrop.height;
  els.empty.style.display = 'none';
  els.canvasInner.style.display = 'block';
  refreshScaleIndicator();
  refreshWizardCard();
  redraw();
}

// ---------------------------------------------------------------------------
// Coordinate translation
// ---------------------------------------------------------------------------
function eventToCanvasPx(e) {
  const rect = els.canvas.getBoundingClientRect();
  const scaleX = els.canvas.width / rect.width;
  const scaleY = els.canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}
function pxToFrac(px) { return { x: px.x / els.canvas.width, y: px.y / els.canvas.height }; }
function fracToPx(frac) { return { x: frac.x * els.canvas.width, y: frac.y * els.canvas.height }; }

// ---------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------
const VERTEX_RADIUS_PX = 8;

function hitTestVertex(px) {
  for (let ri = state.regions.length - 1; ri >= 0; ri--) {
    const r = state.regions[ri];
    for (let vi = 0; vi < r.polygon.length; vi++) {
      const vpx = fracToPx(r.polygon[vi]);
      const dx = vpx.x - px.x, dy = vpx.y - px.y;
      if (dx * dx + dy * dy <= VERTEX_RADIUS_PX * VERTEX_RADIUS_PX) {
        return { regionIdx: ri, vertexIdx: vi };
      }
    }
  }
  return null;
}

function hitTestPolygon(px) {
  for (let ri = state.regions.length - 1; ri >= 0; ri--) {
    if (pointInPolygon(px, state.regions[ri].polygon)) return ri;
  }
  return -1;
}

const EDGE_HIT_TOLERANCE_PX = 8;
function hitTestEdge(px) {
  if (state.selectedRegionIdx === -1) return null;
  const r = state.regions[state.selectedRegionIdx];
  const poly = r.polygon;
  for (let i = 0; i < poly.length; i++) {
    const a = fracToPx(poly[i]);
    const b = fracToPx(poly[(i + 1) % poly.length]);
    const foot = pointOnSegment(px, a, b);
    if (!foot) continue;
    const dx = foot.x - px.x, dy = foot.y - px.y;
    if (dx * dx + dy * dy <= EDGE_HIT_TOLERANCE_PX * EDGE_HIT_TOLERANCE_PX) {
      return { regionIdx: state.selectedRegionIdx, edgeIdx: i, point: pxToFrac(foot) };
    }
  }
  return null;
}

function pointOnSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return null;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * abx, y: a.y + t * aby };
}

function pointInPolygon(px, polygon) {
  const x = px.x, y = px.y;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = fracToPx(polygon[i]);
    const pj = fracToPx(polygon[j]);
    const intersect =
      pi.y > y !== pj.y > y &&
      x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 6.1: Length parsing, formatting, polygon area/perimeter
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a user-entered length string into inches.
 * Supports (in priority order):
 *   "60' 10\""    feet+inches with marks (Cam To Plan native)
 *   "60'10\""     same, no space
 *   "60' 10 3/4\"" feet+inches with fraction
 *   "60'"          feet only with mark
 *   "60.83'"       decimal feet with mark
 *   "60 ft 10 in"  verbose
 *   "60 ft"        verbose feet only
 *   "729\""        inches with mark
 *   "729 in"       inches verbose
 *   "729"          ambiguous (rejected unless quoted/labeled)
 * Returns positive number in inches, or NaN if unparseable.
 */
function parseLengthToInches(input) {
  if (typeof input !== 'string') return NaN;
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return NaN;

  // Helper: parse fractional inch like "10", "10.5", "10 3/4", or "10-3/4"
  function parseInchPart(str) {
    const m = str.trim().match(/^(\d+)(?:[ -](\d+)\/(\d+))?$/);
    if (m) {
      const whole = parseInt(m[1], 10);
      if (m[2] && m[3]) {
        const num = parseInt(m[2], 10);
        const den = parseInt(m[3], 10);
        if (den > 0) return whole + (num / den);
      }
      return whole;
    }
    const f = parseFloat(str);
    return isNaN(f) ? NaN : f;
  }

  // Pattern 1: "60' 10 3/4\"" or "60' 10\"" or "60'10\""
  let m = s.match(/^(-?\d+(?:\.\d+)?)\s*'\s*(\d+(?:[ -]\d+\/\d+)?(?:\.\d+)?)\s*"$/);
  if (m) {
    const ft = parseFloat(m[1]);
    const inches = parseInchPart(m[2]);
    if (!isNaN(ft) && !isNaN(inches)) return ft * 12 + inches;
  }

  // Pattern 2: "60'" or "60.83'"
  m = s.match(/^(-?\d+(?:\.\d+)?)\s*'$/);
  if (m) {
    const ft = parseFloat(m[1]);
    if (!isNaN(ft)) return ft * 12;
  }

  // Pattern 3: "60 ft 10 in" or "60 ft" or "10 in"
  m = s.match(/^(?:(-?\d+(?:\.\d+)?)\s*(?:ft|feet|foot))?\s*(?:(-?\d+(?:[ -]\d+\/\d+)?(?:\.\d+)?)\s*(?:in|inch|inches|"))?$/);
  if (m && (m[1] || m[2])) {
    const ft = m[1] ? parseFloat(m[1]) : 0;
    const inches = m[2] ? parseInchPart(m[2]) : 0;
    if (!isNaN(ft) && !isNaN(inches) && (ft > 0 || inches > 0)) return ft * 12 + inches;
  }

  // Pattern 4: bare inches with mark, "729\""
  m = s.match(/^(-?\d+(?:[ -]\d+\/\d+)?(?:\.\d+)?)\s*"$/);
  if (m) {
    const inches = parseInchPart(m[1]);
    if (!isNaN(inches)) return inches;
  }

  // Pattern 5: "729 in" / "729 inches"
  m = s.match(/^(-?\d+(?:[ -]\d+\/\d+)?(?:\.\d+)?)\s*(?:in|inch|inches)$/);
  if (m) {
    const inches = parseInchPart(m[1]);
    if (!isNaN(inches)) return inches;
  }

  return NaN;
}

/**
 * Format inches as a feet'inches" string, rounded to nearest 1/4 inch.
 * 0     → "0\""
 * 12    → "1' 0\""
 * 730   → "60' 10\""
 * 730.5 → "60' 10 1/2\""
 * 730.25 → "60' 10 1/4\""
 */
function formatInchesToString(inches) {
  if (!Number.isFinite(inches) || inches < 0) return '—';
  // Round to nearest 1/4 inch
  const quartersTotal = Math.round(inches * 4);
  const totalInches = quartersTotal / 4;
  const ft = Math.floor(totalInches / 12);
  const remInches = totalInches - ft * 12;
  const wholeInches = Math.floor(remInches);
  const fracQuarters = Math.round((remInches - wholeInches) * 4);

  let inchPart;
  if (fracQuarters === 0) {
    inchPart = `${wholeInches}"`;
  } else if (fracQuarters === 2) {
    inchPart = `${wholeInches} 1/2"`;
  } else if (fracQuarters === 1) {
    inchPart = `${wholeInches} 1/4"`;
  } else if (fracQuarters === 3) {
    inchPart = `${wholeInches} 3/4"`;
  } else {
    // fracQuarters === 4 means we should have rolled over already, but be safe
    inchPart = `${wholeInches + 1}"`;
  }

  if (ft === 0) return inchPart;
  if (wholeInches === 0 && fracQuarters === 0) return `${ft}'`;
  return `${ft}' ${inchPart}`;
}

/** Distance between two points in canvas pixels. */
function distancePx(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Distance between two fractional points, returned in canvas pixels. */
function distanceFracInPx(p1Frac, p2Frac) {
  return distancePx(fracToPx(p1Frac), fracToPx(p2Frac));
}

/** Edge length in inches, given current scale. NaN if not calibrated. */
function edgeLengthInches(p1Frac, p2Frac) {
  if (!state.scale || !state.scale.pixelsPerFoot) return NaN;
  const px = distanceFracInPx(p1Frac, p2Frac);
  return (px / state.scale.pixelsPerFoot) * 12;
}

/**
 * Polygon area in square feet via shoelace formula in pixel space, then
 * converted by dividing by pixelsPerFoot². Returns NaN if not calibrated.
 */
function polygonAreaSqft(polygonFrac) {
  if (!state.scale || !state.scale.pixelsPerFoot) return NaN;
  if (!Array.isArray(polygonFrac) || polygonFrac.length < 3) return NaN;
  let sumPx = 0;
  for (let i = 0; i < polygonFrac.length; i++) {
    const a = fracToPx(polygonFrac[i]);
    const b = fracToPx(polygonFrac[(i + 1) % polygonFrac.length]);
    sumPx += a.x * b.y - b.x * a.y;
  }
  const areaPxSq = Math.abs(sumPx) / 2;
  const ppf = state.scale.pixelsPerFoot;
  return areaPxSq / (ppf * ppf);
}

/**
 * Polygon perimeter in linear feet. Returns NaN if not calibrated.
 * (Not auto-populated into area_lnft per Sprint 1 scope, but exposed in
 * case the side panel grows a "perimeter hint" UI later.)
 */
function polygonPerimeterFeet(polygonFrac) {
  if (!state.scale || !state.scale.pixelsPerFoot) return NaN;
  if (!Array.isArray(polygonFrac) || polygonFrac.length < 2) return NaN;
  let perimPx = 0;
  for (let i = 0; i < polygonFrac.length; i++) {
    const a = fracToPx(polygonFrac[i]);
    const b = fracToPx(polygonFrac[(i + 1) % polygonFrac.length]);
    perimPx += distancePx(a, b);
  }
  return perimPx / state.scale.pixelsPerFoot;
}

/**
 * Recompute auto-derivable fields on a region when the polygon shape
 * changes. Called from polygon-close, vertex-move-end, vertex-insert,
 * and vertex-delete commit points. Only runs if scale is set.
 *
 * Behavior: always overwrites area_sqft. Tim can manually edit after,
 * and the field stays manual until the next polygon shape change.
 * Per Sprint 1 scope: area_lnft is NOT auto-populated (semantics differ
 * by region type — wall vs surface — and perimeter ≠ wall length).
 */
function recomputeRegionMeasurements(region) {
  if (!state.scale || !state.scale.pixelsPerFoot) return;
  const sqft = polygonAreaSqft(region.polygon);
  if (Number.isFinite(sqft) && sqft >= 0) {
    region.area_sqft = Math.round(sqft * 100) / 100;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function redraw() {
  if (!state.backdropImg) return;
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.drawImage(state.backdropImg, 0, 0, els.canvas.width, els.canvas.height);

  for (let i = 0; i < state.regions.length; i++) {
    drawPolygon(state.regions[i], i, i === state.selectedRegionIdx);
  }

  if (state.hoveredEdge && !state.draftPolygon && !state.drag && !state.polygonDrag && !state.calibration) {
    const px = fracToPx(state.hoveredEdge.point);
    ctx.save();
    ctx.beginPath();
    ctx.arc(px.x, px.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#9c7440';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px.x - 4, px.y);
    ctx.lineTo(px.x + 4, px.y);
    ctx.moveTo(px.x, px.y - 4);
    ctx.lineTo(px.x, px.y + 4);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#9c7440';
    ctx.stroke();
    ctx.restore();
  }

  if (state.draftPolygon && state.draftPolygon.points.length > 0) {
    drawDraft(state.draftPolygon);
  }

  // Phase 6.1: in-progress calibration capture
  if (state.calibration) {
    drawCalibrationPreview();
  }
}

function drawPolygon(region, idx, isSelected) {
  const color = region._color || colorForIndex(idx);
  const pts = region.polygon;
  if (pts.length === 0) return;

  ctx.save();
  ctx.beginPath();
  const start = fracToPx(pts[0]);
  ctx.moveTo(start.x, start.y);
  for (let i = 1; i < pts.length; i++) {
    const p = fracToPx(pts[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();

  ctx.fillStyle = hexToRgba(color, isSelected ? 0.35 : 0.20);
  ctx.fill();
  ctx.lineWidth = isSelected ? 3 : 2;
  ctx.strokeStyle = color;
  ctx.stroke();

  if (isSelected) {
    for (let i = 0; i < pts.length; i++) {
      const p = fracToPx(pts[i]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, VERTEX_RADIUS_PX, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }

  const c = polygonCentroidPx(pts);
  const label = `${idx + 1}. ${region.name || '(unnamed)'}`;
  ctx.font = 'bold 14px DM Sans, sans-serif';
  const metrics = ctx.measureText(label);
  const padding = 6;
  const labelW = metrics.width + padding * 2;
  const labelH = 22;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(c.x - labelW / 2, c.y - labelH / 2, labelW, labelH);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.strokeRect(c.x - labelW / 2, c.y - labelH / 2, labelW, labelH);
  ctx.fillStyle = '#353535';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, c.x, c.y);

  // Phase 6.1: edge length labels when scale is set. Filter to edges ≥ 12"
  // to keep cluttered vertex-cloud polygons (e.g. organic Cam To Plan traces)
  // readable. Always-on default per Sprint 1 decision #3.
  if (state.scale && state.scale.pixelsPerFoot) {
    drawEdgeLabels(pts, color);
  }

  ctx.restore();
}

function drawEdgeLabels(pts, color) {
  if (pts.length < 2) return;
  ctx.font = '600 11px DM Sans, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < pts.length; i++) {
    const a = fracToPx(pts[i]);
    const b = fracToPx(pts[(i + 1) % pts.length]);
    const inches = edgeLengthInches(pts[i], pts[(i + 1) % pts.length]);
    if (!Number.isFinite(inches) || inches < 12) continue; // hide tiny edges

    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const text = formatInchesToString(inches);
    const metrics = ctx.measureText(text);
    const padX = 4, padY = 2;
    const w = metrics.width + padX * 2;
    const h = 14 + padY * 2;

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillRect(mid.x - w / 2, mid.y - h / 2, w, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.strokeRect(mid.x - w / 2, mid.y - h / 2, w, h);
    ctx.fillStyle = '#353535';
    ctx.fillText(text, mid.x, mid.y);
  }
}

function drawDraft(draft) {
  const pts = draft.points;
  ctx.save();

  ctx.beginPath();
  const start = fracToPx(pts[0]);
  ctx.moveTo(start.x, start.y);
  for (let i = 1; i < pts.length; i++) {
    const p = fracToPx(pts[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#dc2626';
  ctx.setLineDash([12, 6]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (state.cursorPx && pts.length > 0) {
    const lastPx = fracToPx(pts[pts.length - 1]);
    ctx.beginPath();
    ctx.moveTo(lastPx.x, lastPx.y);
    ctx.lineTo(state.cursorPx.x, state.cursorPx.y);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(220, 38, 38, 0.6)';
    ctx.setLineDash([8, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (let i = 0; i < pts.length; i++) {
    const p = fracToPx(pts[i]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = i === 0 ? '#9c7440' : '#dc2626';
    ctx.stroke();
  }
  ctx.restore();
}

// Phase 6.1: visualize the calibration in progress
function drawCalibrationPreview() {
  ctx.save();
  if (state.calibration.p1Frac) {
    const p1 = fracToPx(state.calibration.p1Frac);
    ctx.beginPath();
    ctx.arc(p1.x, p1.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#9c7440';
    ctx.stroke();
    ctx.fillStyle = '#9c7440';
    ctx.font = 'bold 12px DM Sans';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('1', p1.x, p1.y);
  }
  if (state.calibration.p2Frac) {
    const p1 = fracToPx(state.calibration.p1Frac);
    const p2 = fracToPx(state.calibration.p2Frac);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#9c7440';
    ctx.setLineDash([10, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(p2.x, p2.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#9c7440';
    ctx.stroke();
    ctx.fillStyle = '#9c7440';
    ctx.font = 'bold 12px DM Sans';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('2', p2.x, p2.y);
  }
  if (state.calibration.p1Frac && !state.calibration.p2Frac && state.cursorPx) {
    const p1 = fracToPx(state.calibration.p1Frac);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(state.cursorPx.x, state.cursorPx.y);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(93, 126, 105, 0.5)';
    ctx.setLineDash([10, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function polygonCentroidPx(pts) {
  let sx = 0, sy = 0;
  for (const p of pts) {
    const px = fracToPx(p);
    sx += px.x; sy += px.y;
  }
  return { x: sx / pts.length, y: sy / pts.length };
}

function hexToRgba(hex, a) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return `rgba(0,0,0,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 6.1: Scale calibration mode
// ═══════════════════════════════════════════════════════════════════════════

function enterCalibrationMode() {
  if (!state.backdropImg) {
    toast('Upload a backdrop image first', 'error');
    return;
  }
  if (state.draftPolygon) {
    toast('Finish drawing the current polygon first (Esc to cancel)', 'error');
    return;
  }
  if (state.scale) {
    if (!confirm('Replace the current calibration?\n\nAll edge lengths and auto-computed areas will use the new scale.')) {
      return;
    }
  }
  state.calibration = { step: 'awaiting_p1', p1Frac: null, p2Frac: null };
  selectRegion(-1);
  setStatus('Tap the FIRST point of a measured distance (e.g. corner of a known edge)');
  document.body.style.cursor = 'crosshair';
  redraw();
}

function exitCalibrationMode() {
  state.calibration = null;
  state.cursorPx = null;
  document.body.style.cursor = '';
  setStatus('Click to start drawing a polygon. Double-click to close.');
  redraw();
}

function openScaleEntryModal() {
  els.scaleModalError.textContent = '';
  els.scaleModalInput.value = '';
  els.scaleModalBackdrop.style.display = 'flex';
  setTimeout(() => els.scaleModalInput.focus(), 50);
}

function closeScaleEntryModal() {
  els.scaleModalBackdrop.style.display = 'none';
}

async function commitCalibration(realDistanceInches) {
  const cal = state.calibration;
  if (!cal || !cal.p1Frac || !cal.p2Frac) return;
  const distPx = distanceFracInPx(cal.p1Frac, cal.p2Frac);
  if (distPx <= 0) {
    toast('Calibration points are at the same location', 'error');
    return;
  }
  const pixelsPerInch = distPx / realDistanceInches;
  const pixelsPerFoot = pixelsPerInch * 12;

  const newScale = {
    pixelsPerFoot,
    p1Frac: cal.p1Frac,
    p2Frac: cal.p2Frac,
    realDistanceInches,
    calibratedAt: new Date().toISOString(),
  };

  // Persist immediately — calibration is one-shot, not iterative, so we
  // save without waiting for the user to click "Save All" on regions.
  try {
    await apiSaveScale(state.proposalId, newScale);
  } catch (err) {
    toast('Could not save scale: ' + err.message, 'error', 6000);
    return;
  }

  state.scale = newScale;
  state.calibration = null;
  document.body.style.cursor = '';

  // Recompute area for any existing closed polygons now that we have scale
  for (const r of state.regions) {
    recomputeRegionMeasurements(r);
  }

  refreshScaleIndicator();
  refreshSidePanel();
  refreshWizardCard();
  redraw();
  toast(`Scale set: ${pixelsPerFoot.toFixed(2)} px/ft`, 'success');
  setStatus(`Scale calibrated. ${formatInchesToString(realDistanceInches)} = ${distPx.toFixed(0)}px.`);
}

function refreshScaleIndicator() {
  if (!els.scaleIndicator) return;
  if (state.scale && state.scale.pixelsPerFoot) {
    const ppf = state.scale.pixelsPerFoot.toFixed(2);
    els.scaleIndicator.textContent = `Scale: ${ppf} px/ft`;
    els.scaleIndicator.classList.add('sm-scale-set');
    els.scaleIndicator.classList.remove('sm-scale-unset');
    els.btnSetScale.textContent = 'Re-calibrate';
  } else {
    els.scaleIndicator.textContent = 'Scale: not set';
    els.scaleIndicator.classList.add('sm-scale-unset');
    els.scaleIndicator.classList.remove('sm-scale-set');
    els.btnSetScale.textContent = 'Set Scale';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 6.1: Wizard hint card
// ═══════════════════════════════════════════════════════════════════════════

let wizardDismissed = false;

function refreshWizardCard() {
  if (!els.wizardCard) return;
  if (!state.wizard || wizardDismissed) {
    els.wizardCard.style.display = 'none';
    return;
  }

  let step, title, desc;
  if (!state.backdrop) {
    step = 'Step 1 of 3';
    title = 'Upload your Cam To Plan screenshot';
    desc = 'Click "Upload Backdrop…" in the header. AirDrop the screenshot from your iPad if needed.';
  } else if (!state.scale) {
    step = 'Step 2 of 3';
    title = 'Calibrate the scale';
    desc = 'Click "Set Scale" then tap the two endpoints of any measured edge from your screenshot. Type the real-world distance (e.g. "60\' 10\\""). All future polygons will measure correctly.';
  } else if (state.regions.length === 0) {
    step = 'Step 3 of 3';
    title = 'Trace the property boundary';
    desc = 'Click on the canvas to add vertices around the perimeter. Double-click the last vertex to close the polygon. Area auto-computes in sqft.';
  } else {
    // All steps complete — auto-hide the card.
    els.wizardCard.style.display = 'none';
    return;
  }

  els.wizardStepLabel.textContent = step;
  els.wizardTitle.textContent = title;
  els.wizardDesc.textContent = desc;
  els.wizardCard.style.display = 'block';
}

// ---------------------------------------------------------------------------
// Mouse / keyboard handlers
// ---------------------------------------------------------------------------

let DRAG_SUPPRESSES_CLICK = false;

els.canvas.addEventListener('mousedown', (e) => {
  if (!state.backdropImg) return;
  if (state.draftPolygon) return;
  if (state.calibration) return; // calibration uses click-to-place, not drag

  const px = eventToCanvasPx(e);

  if (state.selectedRegionIdx !== -1) {
    const hitV = hitTestVertex(px);
    if (hitV && hitV.regionIdx === state.selectedRegionIdx) {
      pushUndoSnapshot('move vertex');
      state.drag = hitV;
      els.canvas.classList.add('sm-cursor-grabbing');
      DRAG_SUPPRESSES_CLICK = true;
      e.preventDefault();
      return;
    }

    const hitE = hitTestEdge(px);
    if (hitE) {
      pushUndoSnapshot('insert vertex');
      const r = state.regions[hitE.regionIdx];
      const insertAt = hitE.edgeIdx + 1;
      r.polygon.splice(insertAt, 0, hitE.point);
      state.drag = { regionIdx: hitE.regionIdx, vertexIdx: insertAt };
      state.hoveredEdge = null;
      els.canvas.classList.add('sm-cursor-grabbing');
      DRAG_SUPPRESSES_CLICK = true;
      els.btnSave.disabled = false;
      // Phase 6.1: vertex insert mutates polygon shape
      recomputeRegionMeasurements(r);
      redraw();
      e.preventDefault();
      return;
    }

    if (pointInPolygon(px, state.regions[state.selectedRegionIdx].polygon)) {
      pushUndoSnapshot('move polygon');
      state.polygonDrag = {
        regionIdx: state.selectedRegionIdx,
        lastFrac: pxToFrac(px),
      };
      els.canvas.classList.add('sm-cursor-grabbing');
      DRAG_SUPPRESSES_CLICK = true;
      e.preventDefault();
      return;
    }
  }
});

els.canvas.addEventListener('mousemove', (e) => {
  if (!state.backdropImg) return;
  const px = eventToCanvasPx(e);

  if (state.calibration) {
    state.cursorPx = px;
    redraw();
    return;
  }

  if (state.drag) {
    const frac = pxToFrac(px);
    const r = state.regions[state.drag.regionIdx];
    r.polygon[state.drag.vertexIdx] = {
      x: Math.max(0, Math.min(1, frac.x)),
      y: Math.max(0, Math.min(1, frac.y)),
    };
    redraw();
    els.btnSave.disabled = false;
    return;
  }

  if (state.polygonDrag) {
    const curFrac = pxToFrac(px);
    const dx = curFrac.x - state.polygonDrag.lastFrac.x;
    const dy = curFrac.y - state.polygonDrag.lastFrac.y;
    const r = state.regions[state.polygonDrag.regionIdx];
    for (const v of r.polygon) {
      v.x = Math.max(0, Math.min(1, v.x + dx));
      v.y = Math.max(0, Math.min(1, v.y + dy));
    }
    state.polygonDrag.lastFrac = curFrac;
    redraw();
    els.btnSave.disabled = false;
    return;
  }

  if (state.draftPolygon) {
    state.cursorPx = px;
    redraw();
    return;
  }

  if (state.selectedRegionIdx !== -1) {
    const hitV = hitTestVertex(px);
    const newHoveredEdge = hitV ? null : hitTestEdge(px);
    const changed =
      (newHoveredEdge === null) !== (state.hoveredEdge === null) ||
      (newHoveredEdge && state.hoveredEdge && newHoveredEdge.edgeIdx !== state.hoveredEdge.edgeIdx);
    state.hoveredEdge = newHoveredEdge;
    if (changed) redraw();
  } else if (state.hoveredEdge) {
    state.hoveredEdge = null;
    redraw();
  }
});

window.addEventListener('mouseup', () => {
  let wasDragging = false;
  let movedRegionIdx = -1;
  if (state.drag) {
    movedRegionIdx = state.drag.regionIdx;
    state.drag = null;
    wasDragging = true;
  }
  if (state.polygonDrag) {
    // Pure translate doesn't change shape — area unchanged. Skip recompute.
    state.polygonDrag = null;
    wasDragging = true;
  }
  if (wasDragging) {
    els.canvas.classList.remove('sm-cursor-grabbing');
    // Phase 6.1: vertex move/insert finalized → polygon shape changed → recompute area
    if (movedRegionIdx >= 0 && movedRegionIdx < state.regions.length) {
      recomputeRegionMeasurements(state.regions[movedRegionIdx]);
      refreshSidePanel();
      redraw();
    }
  }
});

els.canvas.addEventListener('click', (e) => {
  if (!state.backdropImg) return;

  if (DRAG_SUPPRESSES_CLICK) {
    DRAG_SUPPRESSES_CLICK = false;
    return;
  }

  const px = eventToCanvasPx(e);

  // Phase 6.1: calibration takes priority over normal click handling
  if (state.calibration) {
    if (state.calibration.step === 'awaiting_p1') {
      state.calibration.p1Frac = pxToFrac(px);
      state.calibration.step = 'awaiting_p2';
      setStatus('Tap the SECOND point — together they should match a known measurement (e.g. 60\' 10")');
      redraw();
      return;
    }
    if (state.calibration.step === 'awaiting_p2') {
      state.calibration.p2Frac = pxToFrac(px);
      state.calibration.step = 'awaiting_distance';
      setStatus('Now enter the real-world distance between those two points.');
      redraw();
      openScaleEntryModal();
      return;
    }
    return;
  }

  if (state.draftPolygon) {
    state.draftPolygon.points.push(pxToFrac(px));
    redraw();
    return;
  }

  const ri = hitTestPolygon(px);
  if (ri !== -1) {
    selectRegion(ri);
  } else {
    selectRegion(-1);
    state.draftPolygon = { points: [pxToFrac(px)] };
    state.cursorPx = px;
    setStatus('Drawing — click to add vertices, double-click to close, Esc to cancel');
    redraw();
  }
});

els.canvas.addEventListener('dblclick', (e) => {
  if (!state.draftPolygon) return;
  if (state.draftPolygon.points.length >= 2) {
    state.draftPolygon.points.pop();
  }
  if (state.draftPolygon.points.length < 3) {
    toast('Polygon needs at least 3 vertices', 'error');
    state.draftPolygon = null;
    state.cursorPx = null;
    setStatus('Click to start drawing a polygon');
    redraw();
    return;
  }
  pushUndoSnapshot('add polygon');
  const newRegion = {
    name: `Region ${state.regions.length + 1}`,
    polygon: state.draftPolygon.points.slice(),
    area_sqft: null,
    area_lnft: null,
    display_order: state.regions.length,
    materials: [],
    _color: colorForIndex(state.regions.length),
  };
  // Phase 6.1: new polygon → compute area immediately if scale set
  recomputeRegionMeasurements(newRegion);
  state.regions.push(newRegion);
  state.draftPolygon = null;
  state.cursorPx = null;
  selectRegion(state.regions.length - 1);
  setStatus(`Polygon committed. ${state.regions.length} region(s).`);
  refreshSidePanel();
  refreshWizardCard();
  redraw();
  els.btnSave.disabled = false;
});

els.canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (state.selectedRegionIdx === -1) return;
  const px = eventToCanvasPx(e);
  const hit = hitTestVertex(px);
  if (!hit || hit.regionIdx !== state.selectedRegionIdx) return;
  const r = state.regions[hit.regionIdx];
  if (r.polygon.length <= 3) {
    toast('Polygon must have at least 3 vertices — delete the whole region instead', 'error');
    return;
  }
  pushUndoSnapshot('delete vertex');
  r.polygon.splice(hit.vertexIdx, 1);
  // Phase 6.1: vertex delete mutates polygon shape
  recomputeRegionMeasurements(r);
  refreshSidePanel();
  redraw();
  els.btnSave.disabled = false;
});

els.canvas.addEventListener('mouseleave', () => {
  if (state.hoveredEdge) {
    state.hoveredEdge = null;
    redraw();
  }
  if (state.cursorPx && (state.draftPolygon || state.calibration)) {
    state.cursorPx = null;
    redraw();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    if (document.activeElement && (
      document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA'
    )) return;
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (e.key === 'Escape') {
    // Phase 6.1: Esc cancels calibration too
    if (state.calibration) {
      exitCalibrationMode();
      return;
    }
    if (state.draftPolygon) {
      state.draftPolygon = null;
      state.cursorPx = null;
      setStatus('Drawing cancelled');
      redraw();
      return;
    }
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedRegionIdx !== -1) {
    if (document.activeElement && (
      document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA'
    )) return;
    e.preventDefault();
    deleteRegion(state.selectedRegionIdx);
  }
});

function deleteRegion(idx) {
  if (idx < 0 || idx >= state.regions.length) return;
  const r = state.regions[idx];
  if (!confirm(`Delete region "${r.name || 'Region ' + (idx + 1)}"?`)) return;
  pushUndoSnapshot('delete region');
  state.regions.splice(idx, 1);
  if (state.selectedRegionIdx === idx) {
    state.selectedRegionIdx = -1;
  } else if (state.selectedRegionIdx > idx) {
    state.selectedRegionIdx--;
  }
  refreshSidePanel();
  refreshWizardCard();
  redraw();
  els.btnSave.disabled = false;
  setStatus(`Region deleted. ${state.regions.length} region(s).`);
}

// ---------------------------------------------------------------------------
// Material display helpers (unchanged)
// ---------------------------------------------------------------------------
function materialDisplayName(m) {
  if (!m) return 'Material';
  if (m.material_source === 'belgard' && m.belgard_material) {
    return m.belgard_material.product_name || 'Belgard product';
  }
  if (m.material_source === 'third_party' && m.third_party_material) {
    return m.third_party_material.product_name || 'Third-party product';
  }
  return 'Material';
}

function materialMeta(m) {
  if (!m) return '';
  if (m.material_source === 'belgard' && m.belgard_material) {
    const bm = m.belgard_material;
    const parts = [];
    if (bm.color) parts.push(bm.color);
    if (bm.pattern) parts.push(bm.pattern);
    return parts.join(' · ');
  }
  if (m.material_source === 'third_party' && m.third_party_material) {
    const tp = m.third_party_material;
    const parts = [];
    if (tp.manufacturer) parts.push(tp.manufacturer);
    if (tp.color) parts.push(tp.color);
    return parts.join(' · ');
  }
  return '';
}

function materialThumbUrl(m) {
  if (!m) return '';
  if (m.material_source === 'belgard' && m.belgard_material) {
    const bm = m.belgard_material;
    return bm.swatch_url || bm.primary_image_url || bm.image_url || '';
  }
  if (m.material_source === 'third_party' && m.third_party_material) {
    const tp = m.third_party_material;
    return tp.primary_image_url || tp.image_url || '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Side panel (unchanged except for tiny scale-aware area placeholder hint)
// ---------------------------------------------------------------------------
function refreshSidePanel() {
  els.regionCount.textContent = state.regions.length;
  els.sideList.innerHTML = '';
  state.regions.forEach((r, idx) => {
    if (!Array.isArray(r.materials)) r.materials = [];

    const card = document.createElement('div');
    card.className = 'sm-region-card' + (idx === state.selectedRegionIdx ? ' sm-selected' : '');
    card.dataset.idx = idx;

    const sectionOptions = ['<option value="">— No section —</option>']
      .concat(state.sections.map(s =>
        `<option value="${escapeHtml(s.id)}"${r.proposal_section_id === s.id ? ' selected' : ''}>${escapeHtml(s.name)}</option>`
      )).join('');

    let materialsBlock;
    if (state.materials.length === 0) {
      materialsBlock = `<div class="sm-material-pills-empty">No materials in this proposal yet — add them in the editor's Materials section.</div>`;
    } else {
      const selectedOrder = new Map();
      r.materials.forEach((entry, j) => {
        selectedOrder.set(entry.proposal_material_id, j + 1);
      });

      const pills = state.materials.map(m => {
        const isSel = selectedOrder.has(m.id);
        const order = selectedOrder.get(m.id) || '';
        const name = materialDisplayName(m);
        const meta = materialMeta(m);
        const thumb = materialThumbUrl(m);
        const thumbHtml = thumb
          ? `<img src="${escapeHtml(thumb)}" alt="" class="sm-material-pill-thumb">`
          : `<div class="sm-material-pill-thumb-empty">${escapeHtml(name.slice(0, 2).toUpperCase())}</div>`;
        return `
          <button type="button" class="sm-material-pill${isSel ? ' sm-selected' : ''}" data-mat-id="${escapeHtml(m.id)}">
            <span class="sm-material-pill-order">${order}</span>
            ${thumbHtml}
            <span class="sm-material-pill-text">
              <span class="sm-material-pill-name">${escapeHtml(name)}</span>
              ${meta ? `<span class="sm-material-pill-meta">${escapeHtml(meta)}</span>` : ''}
            </span>
          </button>
        `;
      }).join('');
      materialsBlock = `<div class="sm-material-pills">${pills}</div>`;
    }

    // Phase 6.1: when scale is set, show "(auto)" hint next to SQFT label
    const sqftLabel = state.scale ? 'SQFT <span style="color:#9c7440;font-weight:600;">(auto)</span>' : 'SQFT';

    card.innerHTML = `
      <div class="sm-region-card-row">
        <div class="sm-region-swatch" style="background:${r._color || colorForIndex(idx)};"></div>
        <input type="text" class="sm-input-name" placeholder="Region name" value="${escapeHtml(r.name || '')}" />
      </div>
      <div class="sm-region-card-fields">
        <div>
          <label>${sqftLabel}</label>
          <input type="number" class="sm-input-sqft" placeholder="0" min="0" step="0.01" value="${r.area_sqft ?? ''}" />
        </div>
        <div>
          <label>LNFT</label>
          <input type="number" class="sm-input-lnft" placeholder="0" min="0" step="0.01" value="${r.area_lnft ?? ''}" />
        </div>
      </div>
      <div class="sm-region-card-row" style="margin-top:8px;">
        <label style="display:block;width:100%;font-size:11px;font-weight:500;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Section</label>
        <select class="sm-input-section" style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;font-family:inherit;font-size:14px;background:#fff;">
          ${sectionOptions}
        </select>
      </div>
      <div class="sm-region-card-materials-wrap">
        <label>Materials</label>
        ${materialsBlock}
      </div>
      <div class="sm-region-card-actions">
        <button class="sm-btn sm-btn-danger sm-btn-delete">Delete</button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (
        e.target.tagName !== 'INPUT' &&
        e.target.tagName !== 'SELECT' &&
        e.target.tagName !== 'OPTION' &&
        !e.target.classList.contains('sm-btn-delete') &&
        !e.target.closest('.sm-material-pill')
      ) {
        selectRegion(idx);
      }
    });

    const nameInput = card.querySelector('.sm-input-name');
    const sqftInput = card.querySelector('.sm-input-sqft');
    const lnftInput = card.querySelector('.sm-input-lnft');
    const sectionSelect = card.querySelector('.sm-input-section');

    const snapshotOnFocus = (label) => () => pushUndoSnapshot(label);
    nameInput.addEventListener('focus', snapshotOnFocus('rename region'));
    sqftInput.addEventListener('focus', snapshotOnFocus('edit sqft'));
    lnftInput.addEventListener('focus', snapshotOnFocus('edit lnft'));

    nameInput.addEventListener('input', (e) => {
      r.name = e.target.value;
      redraw();
      els.btnSave.disabled = false;
    });
    sqftInput.addEventListener('input', (e) => {
      const v = e.target.value === '' ? null : parseFloat(e.target.value);
      r.area_sqft = isNaN(v) ? null : v;
      els.btnSave.disabled = false;
    });
    lnftInput.addEventListener('input', (e) => {
      const v = e.target.value === '' ? null : parseFloat(e.target.value);
      r.area_lnft = isNaN(v) ? null : v;
      els.btnSave.disabled = false;
    });
    sectionSelect.addEventListener('change', (e) => {
      pushUndoSnapshot('change section');
      r.proposal_section_id = e.target.value || null;
      els.btnSave.disabled = false;
    });

    card.querySelectorAll('.sm-material-pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        const matId = pill.dataset.matId;
        if (!matId) return;
        const existingIdx = r.materials.findIndex(x => x.proposal_material_id === matId);
        pushUndoSnapshot(existingIdx >= 0 ? 'remove material' : 'add material');
        if (existingIdx >= 0) {
          r.materials.splice(existingIdx, 1);
          r.materials.forEach((entry, j) => { entry.display_order = j; });
        } else {
          r.materials.push({
            proposal_material_id: matId,
            display_order: r.materials.length,
          });
        }
        refreshSidePanel();
        els.btnSave.disabled = false;
      });
    });

    card.querySelector('.sm-btn-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Delete region "${r.name}"?`)) return;
      pushUndoSnapshot('delete region');
      state.regions.splice(idx, 1);
      state.regions.forEach((r, i) => { r.display_order = i; r._color = colorForIndex(i); });
      if (state.selectedRegionIdx === idx) state.selectedRegionIdx = -1;
      else if (state.selectedRegionIdx > idx) state.selectedRegionIdx--;
      refreshSidePanel();
      refreshWizardCard();
      redraw();
      els.btnSave.disabled = false;
    });

    els.sideList.appendChild(card);
  });
}

function selectRegion(idx) {
  state.selectedRegionIdx = idx;
  refreshSidePanel();
  redraw();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function setStatus(msg) { els.status.textContent = msg; }

// ---------------------------------------------------------------------------
// Save (unchanged)
// ---------------------------------------------------------------------------
async function saveAll() {
  if (state.draftPolygon) {
    toast('Finish drawing the current polygon first (double-click to close, Esc to cancel)', 'error');
    throw new Error('Draft polygon in progress');
  }
  els.btnSave.disabled = true;
  els.btnSave.textContent = 'Saving…';
  try {
    const result = await apiSaveRegions(state.proposalId, state.regions);
    state.regions = result.regions.map((r, i) => {
      const materials = Array.isArray(r.materials) ? r.materials : [];
      materials.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
      return {
        ...r,
        materials,
        _color: colorForIndex(i),
      };
    });
    refreshSidePanel();
    redraw();
    toast(`Saved. ${result.stats.inserted} new, ${result.stats.updated} updated, ${result.stats.deleted} removed.`, 'success');
  } catch (err) {
    toast('Save failed: ' + err.message, 'error', 6000);
    els.btnSave.disabled = false;
    throw err;
  } finally {
    els.btnSave.textContent = 'Save All';
  }
}

els.btnSave.addEventListener('click', () => { saveAll().catch(() => {}); });
window.saveSiteMap = saveAll;
window.hasUnsavedSiteMapChanges = () => !els.btnSave.disabled;

// ---------------------------------------------------------------------------
// Upload backdrop (unchanged)
// ---------------------------------------------------------------------------
els.btnUpload.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg'].includes(file.type)) {
    toast('File must be PNG or JPEG', 'error');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    toast('File exceeds 10MB', 'error');
    return;
  }
  try {
    toast('Uploading backdrop…', 'info', 2000);
    const result = await apiUploadBackdrop(state.proposalId, file);
    await setBackdrop({
      site_plan_backdrop_url: result.url,
      site_plan_backdrop_width: result.width,
      site_plan_backdrop_height: result.height,
    });
    toast(`Backdrop uploaded (${result.width}×${result.height})`, 'success');
  } catch (err) {
    toast('Upload failed: ' + err.message, 'error', 6000);
  } finally {
    e.target.value = '';
  }
});

// ---------------------------------------------------------------------------
// "+ New polygon" button (unchanged)
// ---------------------------------------------------------------------------
els.btnAddRegion.addEventListener('click', () => {
  if (!state.backdropImg) {
    toast('Upload a backdrop first', 'error');
    return;
  }
  selectRegion(-1);
  state.draftPolygon = { points: [] };
  setStatus('Click on the canvas to add the first vertex');
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 6.1: Set Scale button + scale modal wiring + wizard close
// ═══════════════════════════════════════════════════════════════════════════

if (els.btnSetScale) {
  els.btnSetScale.addEventListener('click', () => enterCalibrationMode());
}

if (els.scaleModalOk) {
  els.scaleModalOk.addEventListener('click', async () => {
    const raw = els.scaleModalInput.value;
    const inches = parseLengthToInches(raw);
    if (!Number.isFinite(inches) || inches <= 0) {
      els.scaleModalError.textContent = 'Could not parse. Try formats like 60\' 10", 60.83\', or 729".';
      return;
    }
    closeScaleEntryModal();
    await commitCalibration(inches);
  });
}
if (els.scaleModalCancel) {
  els.scaleModalCancel.addEventListener('click', () => {
    closeScaleEntryModal();
    exitCalibrationMode();
    setStatus('Calibration cancelled');
  });
}
if (els.scaleModalInput) {
  els.scaleModalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      els.scaleModalOk.click();
    } else if (e.key === 'Escape') {
      els.scaleModalCancel.click();
    }
  });
}
if (els.wizardClose) {
  els.wizardClose.addEventListener('click', () => {
    wizardDismissed = true;
    refreshWizardCard();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  const url = new URL(window.location.href);
  // Phase 6.1: wizard mode flag
  state.wizard = url.searchParams.get('wizard') === '1';

  let proposalId = url.searchParams.get('proposal_id');
  if (!proposalId) {
    proposalId = await promptForProposalId();
    if (!proposalId) return;
    url.searchParams.set('proposal_id', proposalId);
    window.history.replaceState({}, '', url);
  }
  state.proposalId = proposalId;
  els.proposalLabel.textContent = `Proposal: ${proposalId}`;

  try {
    const data = await apiGetRegions(proposalId);
    state.regions = (data.regions || []).map((r, i) => {
      const materials = Array.isArray(r.materials) ? r.materials : [];
      materials.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
      return {
        ...r,
        materials,
        _color: colorForIndex(i),
      };
    });
    state.sections = data.sections || [];
    state.materials = data.materials || [];
    // Phase 6.1: scale persisted on proposals row
    state.scale = data.scale || null;
    await setBackdrop(data.backdrop);
    refreshScaleIndicator();
    refreshSidePanel();
    refreshWizardCard();
    if (state.regions.length > 0) {
      setStatus(`${state.regions.length} region(s) loaded.`);
    }
    resetUndoStack();
  } catch (err) {
    toast('Failed to load: ' + err.message, 'error', 6000);
  }
}

function promptForProposalId() {
  return new Promise((resolve) => {
    els.modalBackdrop.style.display = 'flex';
    els.modalInput.focus();
    const submit = () => {
      const v = els.modalInput.value.trim();
      if (!v) return;
      els.modalBackdrop.style.display = 'none';
      resolve(v);
    };
    els.modalOk.addEventListener('click', submit, { once: true });
    els.modalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    }, { once: true });
  });
}

boot();
