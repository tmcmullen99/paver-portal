// ═══════════════════════════════════════════════════════════════════════════
// Material picker + catalog image backfill
//
// Changes in Sprint 3 Part A (2026-04-22):
//   • Image preference order flipped from `primary_image_url → swatch_url`
//     to `swatch_url → primary_image_url → image_url → placeholder` across
//     all three rendering paths: the product-grid representative image, the
//     variant modal, and the selected-materials tray.
//   • Previously primary_image_url won, which meant Catalina Grana Sepia,
//     Shaded Gray, etc. all showed the same generic product hero even after
//     per-color swatches were uploaded via the new Material Swatches admin
//     page.
//   • This mirrors the same change made to publish.js in Sprint 3 so the
//     editor picker and the published proposal render colors identically.
//   • No behavior change for materials that lack a swatch_url — they still
//     fall through to primary_image_url (Sprint 2A category-level hero) and
//     then to the legacy image_url slot.
//
// Sprint 1.5 backfill flow preserved unchanged: a "Match images from bid
// PDF" button opens a modal with a click-through review flow (idle →
// analyzing → review → done). Writes land on belgard_materials.
// primary_image_url (or swatch_url) or third_party_materials.primary_image_url
// (or image_url), depending on Tim's target-field selection. ONLY writes if
// the selected field is currently NULL.
//
// ═══ Phase 3B.1 (2026-04-28) — Unified materials table reads ═══════════════
// Reads now go to the unified `materials` table instead of the legacy
// belgard_materials + third_party_materials. Writes dual-write to keep the
// two source tables in sync (legacy code paths + the editor picker stay
// consistent until the future cleanup phase drops the source tables).
//   • loadCatalog: materials WHERE manufacturer='Belgard'
//   • loadThirdParty: materials WHERE manufacturer != 'Belgard'
//   • loadSelected: embed via the new material_id FK, shim into s.belgard /
//     s.third_party so render code is byte-identical
//   • addBelgardMaterial / addThirdPartyMaterial: dual-write material_id
//     alongside the legacy FK column
//   • tpSaveCustom (custom material insert): dual-write to both tables with
//     the same client-generated UUID
//   • approveMatch (image backfill): mirror the URL update into materials
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';

const APPLICATION_AREAS = [
  'Driveway', 'Patio', 'Pool deck', 'Walkway', 'Accent path',
  'Wall', 'Border', 'Coping', 'Fire feature', 'Step', 'Other'
];

// Vision-match constraints mirrored from /api/vision-match.js
const VISION_MAX_IMAGES_PER_BATCH = 20;
const HIGH_CONFIDENCE_THRESHOLD = 0.85;

// Target-field options per catalog source. First entry is the default.
const BELGARD_TARGET_FIELDS = [
  { key: 'primary_image_url', label: 'Primary product photo' },
  { key: 'swatch_url',        label: 'Color swatch' }
];
const THIRDPARTY_TARGET_FIELDS = [
  { key: 'primary_image_url', label: 'Primary product photo' },
  { key: 'image_url',         label: 'Image URL' }
];

const ctx = {
  proposalId: null,
  container: null,
  onSave: null,
  catalog: [],
  products: {},
  categories: [],
  thirdParty: [],
  selected: [],
  bidAssets: [],
  filters: { search: '', category: null },
  backfill: null
};

// ───────────────────────────────────────────────────────────────────────────
// Public entry point
// ───────────────────────────────────────────────────────────────────────────
export async function initMaterials({ proposalId, container, onSave }) {
  Object.assign(ctx, {
    proposalId, container, onSave,
    filters: { search: '', category: null },
    backfill: null
  });
  container.innerHTML = `<div class="mp-loading">Loading materials…</div>`;

  try {
    await Promise.all([
      loadCatalog(), loadCategories(), loadSelected(),
      loadThirdParty(), loadBidAssets()
    ]);
    groupProducts();
    render();
  } catch (err) {
    container.innerHTML = `<div class="section-header"><h2>Materials</h2></div>
      <div class="error-box">Could not load catalog: ${escapeHtml(err.message)}</div>`;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Data loading
// ───────────────────────────────────────────────────────────────────────────
// SPRINT 8B — Onboarding wizard step 2 stores which manufacturer catalogs
// this company sells from (company_settings.enabled_manufacturers;
// null = everything). The editor honors it here. A company's own custom
// products (company_id set) are ALWAYS shown regardless of the list.
let _mfgPrefs; // undefined = not loaded, null = all enabled
async function loadManufacturerPrefs() {
  if (_mfgPrefs !== undefined) return _mfgPrefs;
  try {
    const { data } = await supabase
      .from('company_settings')
      .select('enabled_manufacturers')
      .not('company_id', 'is', null)
      .limit(1)
      .maybeSingle();
    _mfgPrefs = (data && Array.isArray(data.enabled_manufacturers) && data.enabled_manufacturers.length)
      ? data.enabled_manufacturers
      : null;
  } catch (_) { _mfgPrefs = null; }
  return _mfgPrefs;
}
function applyMfgPrefs(rows, prefs) {
  if (!prefs) return rows;
  return rows.filter(r => r.company_id != null || prefs.includes(r.manufacturer));
}

async function loadCatalog() {
  // Phase 3B.1 — read from the unified materials table filtered to Belgard.
  // Replaces the prior direct read from belgard_materials. The materials
  // table is a strict superset (UUIDs preserved), so every field the
  // grouping/rendering code uses (product_name, collection, category_id,
  // swatch_url, primary_image_url, color, size_spec, cut_sheet_url,
  // spec_pdf_url) is present on each row.
  const prefs = await loadManufacturerPrefs();
  if (prefs && !prefs.includes('Belgard')) { ctx.catalog = []; return; }
  const { data, error } = await supabase
    .from('materials')
    .select('*')
    .eq('manufacturer', 'Belgard')
    .order('product_name', { ascending: true });
  if (error) throw new Error(`materials (Belgard): ${error.message}`);
  ctx.catalog = applyMfgPrefs(data || [], prefs);
}

async function loadCategories() {
  const { data, error } = await supabase
    .from('belgard_categories')
    .select('*')
    .order('display_order', { ascending: true });
  if (error) throw new Error(`belgard_categories: ${error.message}`);
  ctx.categories = data || [];
}

async function loadSelected() {
  // Phase 3B.1 — embed via the unified materials table (FK material_id),
  // not the legacy belgard_material_id / third_party_material_id FKs.
  // shimSelectedRow() turns the unified material into the prior
  // s.belgard / s.third_party shape so render code below is byte-identical.
  const { data, error } = await supabase
    .from('proposal_materials')
    .select(`
      *,
      material:material_id (id, manufacturer, product_name, color, size_spec,
        primary_image_url, swatch_url, cut_sheet_url, spec_pdf_url,
        category, catalog_url)
    `)
    .eq('proposal_id', ctx.proposalId)
    .order('display_order', { ascending: true, nullsFirst: false });
  if (error) throw new Error(`proposal_materials: ${error.message}`);

  ctx.selected = (data || []).map(s => shimSelectedRow(s));
}

// Shim — turn { material: {...} } from the unified-table embed into the
// prior { belgard: {...} } or { third_party: {...} } shape based on
// material_source. All render code keeps using s.belgard / s.third_party.
function shimSelectedRow(s) {
  if (!s) return s;
  const m = s.material || null;
  if (s.material_source === 'belgard') {
    s.belgard = m;
    s.third_party = null;
  } else {
    s.third_party = m;
    s.belgard = null;
  }
  delete s.material;
  return s;
}

async function loadThirdParty() {
  // Phase 3B.1 — read from the unified materials table excluding Belgard.
  // Replaces the prior direct read from third_party_materials. Note: the
  // unified schema doesn't have the legacy image_url column — that data
  // was COALESCEd into primary_image_url during migration. Render code
  // checks `tp.primary_image_url || tp.image_url`, so missing image_url
  // is harmless (falls through to null).
  const { data, error } = await supabase
    .from('materials')
    .select('*')
    .neq('manufacturer', 'Belgard')
    .order('manufacturer', { ascending: true });
  if (error) throw new Error(`materials (third-party): ${error.message}`);
  ctx.thirdParty = applyMfgPrefs(data || [], await loadManufacturerPrefs());
}

async function loadBidAssets() {
  const { data, error } = await supabase
    .from('proposal_images')
    .select('id, storage_path, thumbnail_path, width, height, source_page')
    .eq('proposal_id', ctx.proposalId)
    .eq('extraction_source', 'bid_pdf_extract')
    .order('source_page', { ascending: true, nullsFirst: true });
  if (error) {
    console.warn('Could not load bid assets:', error.message);
    ctx.bidAssets = [];
    return;
  }
  ctx.bidAssets = data || [];
}

// ───────────────────────────────────────────────────────────────────────────
// Grouping catalog rows by product_name
// ───────────────────────────────────────────────────────────────────────────
function groupProducts() {
  ctx.products = {};
  for (const m of ctx.catalog) {
    const key = m.product_name || '(unnamed)';
    if (!ctx.products[key]) {
      ctx.products[key] = {
        product_name: key,
        collection: m.collection || '',
        category_id: m.category_id,
        representative_image: getImage(m),
        variants: []
      };
    } else if (!ctx.products[key].representative_image) {
      ctx.products[key].representative_image = getImage(m);
    }
    ctx.products[key].variants.push(m);
  }
}

// Sprint 3 Part A refinement: split the image-lookup logic between the
// product grid and the variant modal.
//
//  • Product grid card image (getImage): prefers the landscape/application
//    shot (primary_image_url) because grid cards are for browsing — an
//    evocative "what does this look like in a yard" image is more useful
//    at that level than a bare color chip. Falls through to swatch_url
//    only if no landscape shot exists.
//
//  • Variant modal / selected tray (variantImage, hydratedMaterialImage):
//    prefer swatch_url because once you've drilled into a product, true
//    color accuracy matters more than mood. Scandina Gray should look
//    like Scandina Gray, not like the product's default beauty shot.
function getImage(m) {
  return m.primary_image_url || m.swatch_url || m.image_url || null;
}

function variantImage(v) {
  return v.swatch_url || v.primary_image_url || v.image_url || null;
}

// Third-party material image lookup — no swatch_url column on that table,
// so the chain is primary_image_url → image_url only.
function thirdPartyImage(tp) {
  return tp.primary_image_url || tp.image_url || null;
}

// Unified resolver for proposal_materials hydrated rows. Handles both
// Belgard (has swatch_url) and third-party (doesn't) sources.
function hydratedMaterialImage(data, source) {
  if (!data) return null;
  if (source === 'belgard') {
    return data.swatch_url || data.primary_image_url || data.image_url || null;
  }
  return data.primary_image_url || data.image_url || null;
}

// ───────────────────────────────────────────────────────────────────────────
// Filtering
// ───────────────────────────────────────────────────────────────────────────
function filteredProducts() {
  return Object.values(ctx.products)
    .filter(p => {
      if (ctx.filters.category && p.category_id !== ctx.filters.category) return false;
      if (ctx.filters.search) {
        const s = ctx.filters.search.toLowerCase();
        const inName = p.product_name.toLowerCase().includes(s);
        const inCollection = (p.collection || '').toLowerCase().includes(s);
        const inVariant = p.variants.some(v =>
          (v.color || '').toLowerCase().includes(s) ||
          (v.size_spec || '').toLowerCase().includes(s)
        );
        if (!inName && !inCollection && !inVariant) return false;
      }
      return true;
    })
    .sort((a, b) => a.product_name.localeCompare(b.product_name));
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering
// ───────────────────────────────────────────────────────────────────────────
function render() {
  ctx.container.innerHTML = `
    ${renderBackfillStyles()}
    <div class="section-header">
      <span class="eyebrow">Section 03</span>
      <h2>Materials</h2>
      <p class="section-sub">Pick Belgard products from the catalog and add Trex, Tru-Scapes, or custom third-party materials. Selections save immediately.</p>
    </div>
    ${renderBackfillBanner()}
    ${renderToolbar()}
    ${renderSelectedTray()}
    ${renderProductGrid()}
    ${renderThirdPartyCta()}
    <div id="mpModal" class="mp-modal-backdrop" role="dialog" aria-modal="true" style="display:none;"></div>
  `;
  attachEvents();
}

function renderBackfillStyles() {
  return `
    <style>
      .bf-banner {
        margin: 0 0 20px;
        padding: 14px 18px;
        background: linear-gradient(135deg, #f1e7d3, #faf8f3);
        border: 1px solid #c9d3cb;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }
      .bf-banner-text { font-size: 14px; color: #353535; line-height: 1.4; }
      .bf-banner-text strong { color: #7d5c31; font-weight: 700; }
      .bf-banner-btn {
        background: #9c7440;
        color: #fff;
        border: none;
        padding: 9px 16px;
        border-radius: 6px;
        font-weight: 600;
        font-size: 13px;
        cursor: pointer;
        white-space: nowrap;
      }
      .bf-banner-btn:hover { background: #7d5c31; }

      .bf-modal { max-width: 760px; }
      .bf-modal-header { padding: 24px 28px 16px; border-bottom: 1px solid #e5e5e5; }
      .bf-modal-header h3 { margin: 0 0 6px; font-size: 20px; color: #33281c; }
      .bf-modal-sub { color: #666; font-size: 14px; }

      .bf-phase-body { padding: 24px 28px; }

      .bf-idle-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 14px;
        margin: 18px 0 20px;
      }
      .bf-stat {
        background: #faf8f3;
        padding: 16px 14px;
        border-radius: 8px;
        text-align: center;
      }
      .bf-stat-num { font-size: 28px; font-weight: 700; color: #7d5c31; }
      .bf-stat-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; }

      .bf-idle-cost {
        text-align: center;
        color: #666;
        font-size: 13px;
        margin-bottom: 20px;
      }
      .bf-run-btn {
        display: block;
        width: 100%;
        padding: 14px;
        background: #9c7440;
        color: #fff;
        border: none;
        border-radius: 6px;
        font-weight: 600;
        font-size: 15px;
        cursor: pointer;
      }
      .bf-run-btn:hover { background: #7d5c31; }
      .bf-run-btn:disabled { background: #999; cursor: not-allowed; }

      .bf-analyzing {
        text-align: center;
        padding: 40px 20px;
      }
      .bf-analyzing-spinner {
        width: 40px; height: 40px;
        border: 3px solid #e5e5e5;
        border-top-color: #9c7440;
        border-radius: 50%;
        animation: bfspin 0.8s linear infinite;
        margin: 0 auto 16px;
      }
      @keyframes bfspin { to { transform: rotate(360deg); } }

      .bf-review-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 28px;
        background: #faf8f3;
        border-bottom: 1px solid #e5e5e5;
        font-size: 13px;
      }
      .bf-bulk-btns { display: flex; gap: 8px; }
      .bf-bulk-btn {
        padding: 6px 12px;
        background: #fff;
        border: 1px solid #c9d3cb;
        border-radius: 5px;
        font-size: 12px;
        cursor: pointer;
        font-weight: 600;
      }
      .bf-bulk-btn:hover { background: #f1e7d3; }

      .bf-review-list { padding: 0 28px 20px; max-height: 60vh; overflow-y: auto; }

      .bf-match-row {
        display: grid;
        grid-template-columns: 90px 1fr;
        gap: 16px;
        padding: 16px 0;
        border-bottom: 1px solid #eee;
      }
      .bf-match-row:last-child { border-bottom: none; }
      .bf-match-row.is-approved { opacity: 0.5; }
      .bf-match-row.is-rejected { opacity: 0.3; }

      .bf-match-thumb {
        width: 90px; height: 68px;
        border-radius: 6px;
        background: #faf8f3;
        overflow: hidden;
        position: relative;
      }
      .bf-match-thumb img {
        width: 100%; height: 100%;
        object-fit: cover;
        display: block;
      }
      .bf-match-page-badge {
        position: absolute;
        top: 4px; right: 4px;
        background: rgba(0,0,0,0.6);
        color: #fff;
        font-size: 9px;
        padding: 2px 5px;
        border-radius: 3px;
        font-weight: 600;
      }

      .bf-match-body { display: flex; flex-direction: column; gap: 8px; }
      .bf-match-material { font-size: 15px; font-weight: 600; color: #33281c; }
      .bf-match-meta {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 12px;
        color: #666;
        flex-wrap: wrap;
      }
      .bf-confidence-pill {
        padding: 2px 8px;
        border-radius: 10px;
        font-weight: 700;
        font-size: 11px;
      }
      .bf-confidence-pill.high { background: #d4e4d8; color: #2d5a3a; }
      .bf-confidence-pill.med  { background: #fff3d4; color: #7a5a10; }
      .bf-confidence-pill.low  { background: #f4d4d4; color: #7a2020; }

      .bf-asset-type-pill {
        padding: 2px 8px;
        border-radius: 10px;
        background: #f0f0f0;
        color: #555;
        font-size: 11px;
        font-weight: 600;
      }
      .bf-match-reasoning { font-size: 13px; color: #555; font-style: italic; line-height: 1.4; }

      .bf-match-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .bf-target-select {
        padding: 6px 8px;
        border: 1px solid #c9d3cb;
        border-radius: 5px;
        font-size: 12px;
        background: #fff;
      }
      .bf-target-select:disabled { background: #f5f5f5; color: #999; }

      .bf-approve-btn, .bf-reject-btn {
        padding: 6px 14px;
        border: none;
        border-radius: 5px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .bf-approve-btn { background: #9c7440; color: #fff; }
      .bf-approve-btn:hover { background: #7d5c31; }
      .bf-approve-btn:disabled { background: #999; cursor: default; }
      .bf-reject-btn { background: #fff; color: #888; border: 1px solid #ddd; }
      .bf-reject-btn:hover { background: #f5f5f5; }

      .bf-match-status { font-size: 12px; font-weight: 600; }
      .bf-match-status.ok { color: #7d5c31; }
      .bf-match-status.err { color: #b04040; }

      .bf-non-matches {
        margin: 12px 28px 20px;
        padding: 10px 14px;
        background: #faf8f3;
        border-radius: 6px;
        font-size: 13px;
      }
      .bf-non-matches summary { cursor: pointer; font-weight: 600; color: #666; }
      .bf-non-matches[open] summary { margin-bottom: 8px; }
      .bf-non-matches-list { font-size: 12px; color: #888; line-height: 1.6; }

      .bf-done {
        text-align: center;
        padding: 40px 20px;
      }
      .bf-done-icon { font-size: 48px; color: #9c7440; margin-bottom: 12px; }
      .bf-done-summary {
        color: #666;
        font-size: 14px;
        margin-bottom: 20px;
        line-height: 1.5;
      }

      .bf-error-box {
        margin: 12px 28px;
        padding: 12px 14px;
        background: #fbeaea;
        border: 1px solid #e8c0c0;
        border-radius: 6px;
        color: #7a2020;
        font-size: 13px;
        line-height: 1.4;
      }
    </style>
  `;
}

function renderBackfillBanner() {
  if (ctx.bidAssets.length === 0) return '';
  if (ctx.selected.length === 0) return '';

  return `
    <div class="bf-banner">
      <div class="bf-banner-text">
        <strong>${ctx.bidAssets.length} image${ctx.bidAssets.length === 1 ? '' : 's'}</strong>
        were extracted from the bid PDF.
        Claude can analyze them and suggest catalog matches for your
        <strong>${ctx.selected.length} selected material${ctx.selected.length === 1 ? '' : 's'}</strong>.
      </div>
      <button class="bf-banner-btn" id="bfOpen">
        Match catalog images →
      </button>
    </div>
  `;
}

function renderToolbar() {
  const chips = [
    `<button class="mp-chip${!ctx.filters.category ? ' active' : ''}" data-category="">All</button>`,
    ...ctx.categories.map(c => {
      const active = ctx.filters.category === c.id ? ' active' : '';
      return `<button class="mp-chip${active}" data-category="${escapeHtml(c.id)}">${escapeHtml(c.name)}</button>`;
    })
  ].join('');

  return `
    <div class="mp-toolbar">
      <input type="text" id="mpSearch" class="mp-search" placeholder="Search catalog by product, color, or size…" value="${escapeHtml(ctx.filters.search)}" autocomplete="off">
      <div class="mp-chips">${chips}</div>
    </div>
  `;
}

function renderSelectedTray() {
  if (ctx.selected.length === 0) {
    return `<div class="mp-selected-empty"><span class="eyebrow">Selected</span><span class="mp-selected-empty-text">None yet — pick from the catalog below.</span></div>`;
  }

  const items = ctx.selected.map(s => {
    const data = s.belgard || s.third_party || {};
    const isBelgard = s.material_source === 'belgard';
    const displayName = isBelgard
      ? `${data.product_name || '(unknown)'} · ${data.color || ''}${data.size_spec ? ' · ' + data.size_spec : ''}`
      : `${data.manufacturer || ''} · ${data.product_name || ''}`;

    const areaOpts = APPLICATION_AREAS.map(a =>
      `<option value="${a}"${s.application_area === a ? ' selected' : ''}>${a}</option>`
    ).join('');

    const img = hydratedMaterialImage(data, s.material_source);
    const imgEl = img
      ? `<img src="${escapeHtml(img)}" alt="" class="mp-selected-thumb">`
      : `<div class="mp-selected-thumb mp-placeholder-thumb">${escapeHtml((data.product_name || '??').slice(0, 2).toUpperCase())}</div>`;

    return `
      <div class="mp-selected-item" data-id="${s.id}">
        ${imgEl}
        <div class="mp-selected-body">
          <div class="mp-selected-name">${escapeHtml(displayName)}</div>
          <div class="mp-selected-source">${isBelgard ? 'Belgard' : 'Third-party'}</div>
        </div>
        <select class="mp-selected-area" data-id="${s.id}" aria-label="Application area">
          <option value="">(application area)</option>
          ${areaOpts}
        </select>
        <button class="mp-selected-remove" data-id="${s.id}" aria-label="Remove material">×</button>
      </div>
    `;
  }).join('');

  return `
    <div class="mp-selected-tray">
      <div class="mp-selected-header">
        <span class="eyebrow">Selected · ${ctx.selected.length}</span>
      </div>
      <div class="mp-selected-list">${items}</div>
    </div>
  `;
}

function renderProductGrid() {
  const products = filteredProducts();
  if (products.length === 0) {
    return `<div class="mp-empty">No products match these filters.</div>`;
  }

  const total = Object.keys(ctx.products).length;
  const cards = products.map(p => {
    const selectedCount = p.variants.filter(v =>
      ctx.selected.some(s => s.belgard_material_id === v.id)
    ).length;

    const img = p.representative_image
      ? `<img src="${escapeHtml(p.representative_image)}" alt="${escapeHtml(p.product_name)}" loading="lazy">`
      : `<div class="mp-product-placeholder">${escapeHtml(p.product_name.slice(0, 3).toUpperCase())}</div>`;

    const countBadge = selectedCount > 0
      ? `<span class="mp-product-selected-badge">${selectedCount} added</span>`
      : '';

    return `
      <button class="mp-product-card" data-product="${escapeHtml(p.product_name)}">
        <div class="mp-product-image">${img}${countBadge}</div>
        <div class="mp-product-body">
          <div class="mp-product-name">${escapeHtml(p.product_name)}</div>
          <div class="mp-product-meta">${escapeHtml(p.collection || '—')} · ${p.variants.length} variant${p.variants.length === 1 ? '' : 's'}</div>
        </div>
      </button>
    `;
  }).join('');

  return `
    <div class="mp-grid-meta"><span>${products.length} of ${total} products</span></div>
    <div class="mp-product-grid">${cards}</div>
  `;
}

function renderThirdPartyCta() {
  return `
    <div class="mp-third-party-cta">
      <button id="mpAddThirdParty" class="btn">+ Add third-party material</button>
      <span class="hint">Trex Transcend Lineage, Tru-Scapes, or custom</span>
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Event wiring
// ───────────────────────────────────────────────────────────────────────────
function attachEvents() {
  const c = ctx.container;

  const searchEl = c.querySelector('#mpSearch');
  if (searchEl) {
    let debounce;
    searchEl.addEventListener('input', (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        ctx.filters.search = e.target.value;
        rerenderGrid();
      }, 180);
    });
  }

  c.querySelectorAll('.mp-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      ctx.filters.category = chip.dataset.category || null;
      render();
    });
  });

  c.querySelectorAll('.mp-product-card').forEach(card => {
    card.addEventListener('click', () => openProductModal(card.dataset.product));
  });

  c.querySelectorAll('.mp-selected-area').forEach(sel => {
    sel.addEventListener('change', async () => {
      await updateApplicationArea(sel.dataset.id, sel.value || null);
    });
  });

  c.querySelectorAll('.mp-selected-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this material from the proposal?')) return;
      await removeMaterial(btn.dataset.id);
    });
  });

  c.querySelector('#mpAddThirdParty')?.addEventListener('click', openThirdPartyModal);
  c.querySelector('#bfOpen')?.addEventListener('click', openBackfillModal);
}

function rerenderGrid() {
  const c = ctx.container;
  const gridMeta = c.querySelector('.mp-grid-meta');
  const grid = c.querySelector('.mp-product-grid');
  const empty = c.querySelector('.mp-empty');
  const newGridHtml = renderProductGrid();
  if (grid) grid.outerHTML = newGridHtml;
  else if (empty) empty.outerHTML = newGridHtml;
  if (gridMeta) gridMeta.remove();
  c.querySelectorAll('.mp-product-card').forEach(card => {
    card.addEventListener('click', () => openProductModal(card.dataset.product));
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Product modal — shows variants when a product card is clicked
// ───────────────────────────────────────────────────────────────────────────
function openProductModal(productName) {
  const product = ctx.products[productName];
  if (!product) return;
  const modal = ctx.container.querySelector('#mpModal');

  const variants = product.variants.slice().sort((a, b) => {
    const ca = (a.color || '').localeCompare(b.color || '');
    if (ca !== 0) return ca;
    return (a.size_spec || '').localeCompare(b.size_spec || '');
  });

  const variantsHtml = variants.map(v => {
    const alreadySelected = ctx.selected.some(s => s.belgard_material_id === v.id);
    const img = variantImage(v);
    const imgEl = img
      ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">`
      : `<div class="mp-variant-placeholder">${escapeHtml((v.color || '??').slice(0, 2))}</div>`;

    const cutSheet = v.cut_sheet_url || v.spec_pdf_url;
    const cutSheetLink = cutSheet
      ? `<a href="${escapeHtml(cutSheet)}" target="_blank" rel="noopener" class="mp-variant-spec">Cut-sheet ↗</a>`
      : '';

    return `
      <div class="mp-variant ${alreadySelected ? 'added' : ''}">
        <div class="mp-variant-img">${imgEl}</div>
        <div class="mp-variant-body">
          <div class="mp-variant-color">${escapeHtml(v.color || 'Default')}</div>
          ${v.size_spec ? `<div class="mp-variant-size">${escapeHtml(v.size_spec)}</div>` : ''}
          ${cutSheetLink}
        </div>
        <button class="mp-variant-add ${alreadySelected ? 'is-added' : ''}" data-belgard-id="${escapeHtml(v.id)}" ${alreadySelected ? 'disabled' : ''}>
          ${alreadySelected ? '✓ Added' : '+ Add'}
        </button>
      </div>
    `;
  }).join('');

  modal.innerHTML = `
    <div class="mp-modal" role="document">
      <button class="mp-modal-close" aria-label="Close">×</button>
      <div class="mp-modal-header">
        <span class="eyebrow">${escapeHtml(product.collection || 'Belgard')}</span>
        <h3>${escapeHtml(product.product_name)}</h3>
        <p class="mp-modal-sub">${variants.length} variant${variants.length === 1 ? '' : 's'} available</p>
      </div>
      <div class="mp-variant-grid">${variantsHtml}</div>
    </div>
  `;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  modal.querySelector('.mp-modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  modal.querySelectorAll('.mp-variant-add').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = 'Adding…';
      const ok = await addBelgardMaterial(btn.dataset.belgardId);
      if (ok) openProductModal(productName);
      else {
        btn.disabled = false;
        btn.textContent = '+ Add';
      }
    });
  });
}

function closeModal() {
  const modal = ctx.container.querySelector('#mpModal');
  if (!modal) return;
  modal.style.display = 'none';
  modal.innerHTML = '';
  document.body.style.overflow = '';
  ctx.backfill = null;
}

// ───────────────────────────────────────────────────────────────────────────
// Third-party modal
// ───────────────────────────────────────────────────────────────────────────
function openThirdPartyModal() {
  const modal = ctx.container.querySelector('#mpModal');

  const cards = ctx.thirdParty.map(tp => {
    const alreadySelected = ctx.selected.some(s => s.third_party_material_id === tp.id);
    const img = thirdPartyImage(tp);
    const imgEl = img
      ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">`
      : `<div class="mp-variant-placeholder">${escapeHtml(tp.manufacturer.slice(0, 2))}</div>`;

    return `
      <div class="mp-tp-card ${alreadySelected ? 'added' : ''}">
        <div class="mp-tp-img">${imgEl}</div>
        <div class="mp-tp-body">
          <div class="mp-tp-mfr">${escapeHtml(tp.manufacturer)}</div>
          <div class="mp-tp-name">${escapeHtml(tp.product_name)}</div>
          <div class="mp-tp-category"><span class="mp-pill">${escapeHtml(tp.category)}</span></div>
        </div>
        <button class="mp-tp-add ${alreadySelected ? 'is-added' : ''}" data-tp-id="${escapeHtml(tp.id)}" ${alreadySelected ? 'disabled' : ''}>
          ${alreadySelected ? '✓ Added' : '+ Add'}
        </button>
      </div>
    `;
  }).join('');

  modal.innerHTML = `
    <div class="mp-modal" role="document">
      <button class="mp-modal-close" aria-label="Close">×</button>
      <div class="mp-modal-header">
        <span class="eyebrow">Third-party</span>
        <h3>Add non-Belgard material</h3>
        <p class="mp-modal-sub">Trex, Tru-Scapes, or enter a custom material below.</p>
      </div>
      <div class="mp-tp-list">${cards}</div>
      <details class="mp-tp-custom">
        <summary>+ Add a new custom material</summary>
        <div class="mp-tp-form">
          <div class="field-row">
            <div class="field"><label>Manufacturer</label><input type="text" id="tpMfr" placeholder="e.g. Lutron"></div>
            <div class="field"><label>Category</label>
              <select id="tpCat">
                <option value="decking">Decking</option>
                <option value="lighting" selected>Lighting</option>
                <option value="fencing">Fencing</option>
                <option value="furniture">Furniture</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <div class="field"><label>Product name</label><input type="text" id="tpName" placeholder="e.g. Caséta Smart Dimmer"></div>
          <div class="field"><label>Description (optional)</label><input type="text" id="tpDesc"></div>
          <div class="field"><label>Catalog or cut-sheet URL (optional)</label><input type="text" id="tpCatalog" placeholder="https://…"></div>
          <div class="field"><label>Image URL (optional)</label><input type="text" id="tpImage" placeholder="https://…"></div>
          <button class="btn primary" id="tpSaveCustom">Save and add to proposal</button>
          <div id="tpCustomError" class="error-box" style="display:none;"></div>
        </div>
      </details>
    </div>
  `;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  modal.querySelector('.mp-modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  modal.querySelectorAll('.mp-tp-add').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Adding…';
      const ok = await addThirdPartyMaterial(btn.dataset.tpId);
      if (ok) openThirdPartyModal();
      else {
        btn.disabled = false;
        btn.textContent = '+ Add';
      }
    });
  });

  modal.querySelector('#tpSaveCustom')?.addEventListener('click', async () => {
    const errBox = modal.querySelector('#tpCustomError');
    errBox.style.display = 'none';

    const mfr = modal.querySelector('#tpMfr').value.trim();
    const name = modal.querySelector('#tpName').value.trim();
    const cat = modal.querySelector('#tpCat').value;
    const desc = modal.querySelector('#tpDesc').value.trim() || null;
    const catalog = modal.querySelector('#tpCatalog').value.trim() || null;
    const image = modal.querySelector('#tpImage').value.trim() || null;

    if (!mfr || !name) {
      errBox.textContent = 'Manufacturer and product name are required.';
      errBox.style.display = 'block';
      return;
    }

    // Phase 3B.1 — dual-write the new custom material to BOTH the legacy
    // third_party_materials table (so any code path still reading from it
    // sees the row) AND the unified materials table (the new picker source
    // of truth). Same UUID stamped client-side so both rows reference the
    // same material; subsequent addThirdPartyMaterial() then writes
    // proposal_materials with that UUID in both FK columns.
    const newId = (crypto.randomUUID && crypto.randomUUID()) ||
                  ('id-' + Math.random().toString(36).slice(2));

    const [legacyRes, unifiedRes] = await Promise.all([
      supabase.from('third_party_materials').insert({
        id: newId, manufacturer: mfr, product_name: name, category: cat,
        description: desc, catalog_url: catalog, image_url: image
      }),
      supabase.from('materials').insert({
        id: newId, manufacturer: mfr, product_name: name, category: cat,
        description: desc, catalog_url: catalog, primary_image_url: image
      })
    ]);

    if (legacyRes.error || unifiedRes.error) {
      const msg = (legacyRes.error && legacyRes.error.message) ||
                  (unifiedRes.error && unifiedRes.error.message) ||
                  'Unknown error';
      errBox.textContent = 'Could not save: ' + msg;
      errBox.style.display = 'block';
      return;
    }

    // Push the unified-shape row into ctx.thirdParty so the picker grid
    // sees the new entry without a full reload. (loadThirdParty reads
    // from materials, so this row mirrors what the next reload would show.)
    ctx.thirdParty.push({
      id: newId, manufacturer: mfr, product_name: name, category: cat,
      description: desc, catalog_url: catalog, primary_image_url: image
    });
    const ok = await addThirdPartyMaterial(newId);
    if (ok) openThirdPartyModal();
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Backfill modal — Sprint 1.5 core workflow (unchanged from Sprint 1.5)
// ───────────────────────────────────────────────────────────────────────────
function openBackfillModal() {
  const materialsPayload = ctx.selected.map(s => {
    const isBelgard = s.material_source === 'belgard';
    const data = isBelgard ? (s.belgard || {}) : (s.third_party || {});
    const catalogId = isBelgard ? s.belgard_material_id : s.third_party_material_id;
    return {
      source: s.material_source,
      catalog_id: catalogId,
      manufacturer: isBelgard ? 'Belgard' : (data.manufacturer || ''),
      product_name: data.product_name || '',
      color: isBelgard ? (data.color || null) : null,
      size_spec: isBelgard ? (data.size_spec || null) : null,
      application_area: s.application_area || null,
      existing: {
        primary_image_url: data.primary_image_url || null,
        swatch_url: isBelgard ? (data.swatch_url || null) : null,
        image_url: !isBelgard ? (data.image_url || null) : null
      }
    };
  });

  const imagesPayload = ctx.bidAssets.map(a => ({
    id: a.id,
    url: publicStorageUrl(a.storage_path),
    thumbUrl: publicStorageUrl(a.thumbnail_path || a.storage_path),
    source_page: a.source_page
  }));

  const materialsMissingImages = materialsPayload.filter(m =>
    !m.existing.primary_image_url &&
    !m.existing.swatch_url &&
    !m.existing.image_url
  ).length;

  ctx.backfill = {
    phase: 'idle',
    materials: materialsPayload,
    images: imagesPayload,
    matches: [],
    decisions: {},
    materialsMissingImages,
    error: null
  };

  renderBackfillModal();
}

function renderBackfillModal() {
  const modal = ctx.container.querySelector('#mpModal');
  const bf = ctx.backfill;
  if (!modal || !bf) return;

  modal.innerHTML = `
    <div class="mp-modal bf-modal" role="document">
      <button class="mp-modal-close" aria-label="Close">×</button>
      <div class="bf-modal-header">
        <span class="eyebrow">Catalog image backfill</span>
        <h3>Match bid PDF images to catalog materials</h3>
        <p class="bf-modal-sub">Approved matches write to the shared catalog and enrich all future proposals using that material.</p>
      </div>
      ${bf.error ? `<div class="bf-error-box">${escapeHtml(bf.error)}</div>` : ''}
      ${renderBackfillPhase()}
    </div>
  `;

  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  modal.querySelector('.mp-modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  attachBackfillEvents();
}

function renderBackfillPhase() {
  const bf = ctx.backfill;
  switch (bf.phase) {
    case 'idle': return renderBackfillIdle();
    case 'analyzing': return renderBackfillAnalyzing();
    case 'review': return renderBackfillReview();
    case 'done': return renderBackfillDone();
    default: return '';
  }
}

function renderBackfillIdle() {
  const bf = ctx.backfill;
  const batchesNeeded = Math.ceil(bf.images.length / VISION_MAX_IMAGES_PER_BATCH);
  const estCost = (batchesNeeded * 0.12).toFixed(2);

  return `
    <div class="bf-phase-body">
      <div class="bf-idle-stats">
        <div class="bf-stat">
          <div class="bf-stat-num">${bf.images.length}</div>
          <div class="bf-stat-label">Bid PDF images</div>
        </div>
        <div class="bf-stat">
          <div class="bf-stat-num">${bf.materials.length}</div>
          <div class="bf-stat-label">Selected materials</div>
        </div>
        <div class="bf-stat">
          <div class="bf-stat-num">${bf.materialsMissingImages}</div>
          <div class="bf-stat-label">Missing images</div>
        </div>
      </div>

      <div class="bf-idle-cost">
        Claude Vision will analyze each image against the materials list.
        ${batchesNeeded > 1 ? `Will run in ${batchesNeeded} batches of ${VISION_MAX_IMAGES_PER_BATCH}.` : ''}
        Estimated cost: ~$${estCost}
      </div>

      <button class="bf-run-btn" id="bfRun">
        Suggest matches with Claude →
      </button>
    </div>
  `;
}

function renderBackfillAnalyzing() {
  const bf = ctx.backfill;
  const batchesTotal = Math.ceil(bf.images.length / VISION_MAX_IMAGES_PER_BATCH);
  const progressText = bf.progress
    ? `Batch ${bf.progress.current} of ${batchesTotal}… (${bf.progress.done} of ${bf.images.length} images analyzed)`
    : `Analyzing ${bf.images.length} image${bf.images.length === 1 ? '' : 's'} against ${bf.materials.length} material${bf.materials.length === 1 ? '' : 's'}…`;

  return `
    <div class="bf-analyzing">
      <div class="bf-analyzing-spinner"></div>
      <div>${escapeHtml(progressText)}</div>
      <div style="font-size:12px; color:#888; margin-top:8px;">This typically takes 10-30 seconds.</div>
    </div>
  `;
}

function renderBackfillReview() {
  const bf = ctx.backfill;
  const validMatches = bf.matches.filter(m => m.is_match);
  const nonMatches = bf.matches.filter(m => !m.is_match);

  const approved = Object.values(bf.decisions).filter(d => d.status === 'approved').length;
  const rejected = Object.values(bf.decisions).filter(d => d.status === 'rejected').length;
  const pending = validMatches.length - approved - rejected;

  if (validMatches.length === 0) {
    return `
      <div class="bf-phase-body">
        <div style="text-align:center; padding: 30px 10px; color: #666;">
          <div style="font-size:32px; margin-bottom:8px;">🤷</div>
          <div style="font-weight:600; margin-bottom:6px;">No catalog matches found</div>
          <div style="font-size:13px; line-height:1.5;">
            Claude analyzed ${bf.images.length} image${bf.images.length === 1 ? '' : 's'} but
            couldn't confidently match any to your selected materials. This is normal when
            the PDF contains mostly logos, scene renderings, or property-specific photos.
          </div>
        </div>
        <button class="bf-run-btn" id="bfClose" style="background:#888;">Close</button>
      </div>
    `;
  }

  const rows = validMatches
    .sort((a, b) => b.confidence - a.confidence)
    .map(m => renderMatchRow(m))
    .join('');

  const nonMatchSummary = nonMatches.length > 0 ? `
    <details class="bf-non-matches">
      <summary>${nonMatches.length} image${nonMatches.length === 1 ? '' : 's'} skipped (not usable catalog assets)</summary>
      <div class="bf-non-matches-list">
        ${nonMatches.map(m => {
          const img = bf.images[m.image_index];
          const pageTag = img?.source_page ? ` (p.${img.source_page})` : '';
          return `• ${escapeHtml(m.asset_type || 'non_material')}${pageTag}: ${escapeHtml(m.reasoning || '')}`;
        }).join('<br>')}
      </div>
    </details>
  ` : '';

  return `
    <div class="bf-review-header">
      <div>
        <strong>${validMatches.length}</strong> match${validMatches.length === 1 ? '' : 'es'} ·
        <span style="color:#7d5c31;">${approved} approved</span> ·
        <span style="color:#888;">${rejected} rejected</span> ·
        <span>${pending} pending</span>
      </div>
      <div class="bf-bulk-btns">
        <button class="bf-bulk-btn" id="bfApproveHigh">Approve all ≥ ${Math.round(HIGH_CONFIDENCE_THRESHOLD * 100)}%</button>
      </div>
    </div>
    <div class="bf-review-list" id="bfReviewList">${rows}</div>
    ${nonMatchSummary}
    ${pending === 0 ? `
      <div style="padding: 16px 28px; border-top: 1px solid #e5e5e5; text-align: right;">
        <button class="bf-bulk-btn" id="bfFinish" style="background:#9c7440; color:#fff; border-color:#9c7440;">
          Finish
        </button>
      </div>
    ` : ''}
  `;
}

function renderMatchRow(match) {
  const bf = ctx.backfill;
  const img = bf.images[match.image_index];
  const mat = bf.materials[match.material_index];
  if (!img || !mat) return '';

  const decision = bf.decisions[img.id] || { status: 'pending' };
  const statusClass = decision.status === 'approved' ? 'is-approved'
                   : decision.status === 'rejected' ? 'is-rejected' : '';

  const confidencePct = Math.round(match.confidence * 100);
  const confClass = match.confidence >= HIGH_CONFIDENCE_THRESHOLD ? 'high'
                  : match.confidence >= 0.6 ? 'med' : 'low';

  const materialName = `${mat.manufacturer} ${mat.product_name}`
    + (mat.color ? ` · ${mat.color}` : '')
    + (mat.size_spec ? ` (${mat.size_spec})` : '');

  const targetFields = mat.source === 'belgard' ? BELGARD_TARGET_FIELDS : THIRDPARTY_TARGET_FIELDS;
  const defaultTarget = match.asset_type === 'color_swatch' && mat.source === 'belgard'
    ? 'swatch_url'
    : 'primary_image_url';

  const targetOptions = targetFields.map(f => {
    const populated = !!mat.existing[f.key];
    return `<option value="${f.key}" ${populated ? 'disabled' : ''} ${f.key === defaultTarget && !populated ? 'selected' : ''}>
      ${f.label}${populated ? ' (already set)' : ''}
    </option>`;
  }).join('');

  const allFull = targetFields.every(f => !!mat.existing[f.key]);

  const pageTag = img.source_page ? `<span class="bf-match-page-badge">p.${img.source_page}</span>` : '';

  let actionHtml;
  if (allFull && decision.status === 'pending') {
    actionHtml = `<span class="bf-match-status err">Catalog full for this material</span>`;
  } else if (decision.status === 'approved') {
    actionHtml = `<span class="bf-match-status ok">✓ Written to ${escapeHtml(decision.targetField || 'catalog')}</span>`;
  } else if (decision.status === 'rejected') {
    actionHtml = `<span class="bf-match-status">✗ Rejected</span>`;
  } else if (decision.status === 'error') {
    actionHtml = `<span class="bf-match-status err">${escapeHtml(decision.error || 'Write failed')}</span>
                  <button class="bf-approve-btn" data-action="approve" data-image-id="${escapeHtml(img.id)}">Retry</button>`;
  } else {
    actionHtml = `
      <select class="bf-target-select" data-image-id="${escapeHtml(img.id)}" ${allFull ? 'disabled' : ''}>
        ${targetOptions}
      </select>
      <button class="bf-approve-btn" data-action="approve" data-image-id="${escapeHtml(img.id)}" ${allFull ? 'disabled' : ''}>Approve</button>
      <button class="bf-reject-btn" data-action="reject" data-image-id="${escapeHtml(img.id)}">Reject</button>
    `;
  }

  return `
    <div class="bf-match-row ${statusClass}" data-image-id="${escapeHtml(img.id)}">
      <div class="bf-match-thumb">
        <a href="${escapeHtml(img.url)}" target="_blank" rel="noopener">
          <img src="${escapeHtml(img.thumbUrl)}" alt="">
        </a>
        ${pageTag}
      </div>
      <div class="bf-match-body">
        <div class="bf-match-material">${escapeHtml(materialName)}</div>
        <div class="bf-match-meta">
          <span class="bf-confidence-pill ${confClass}">${confidencePct}% match</span>
          <span class="bf-asset-type-pill">${escapeHtml(match.asset_type || 'match')}</span>
        </div>
        <div class="bf-match-reasoning">${escapeHtml(match.reasoning || '')}</div>
        <div class="bf-match-actions">${actionHtml}</div>
      </div>
    </div>
  `;
}

function renderBackfillDone() {
  const bf = ctx.backfill;
  const approved = Object.values(bf.decisions).filter(d => d.status === 'approved').length;
  const rejected = Object.values(bf.decisions).filter(d => d.status === 'rejected').length;

  return `
    <div class="bf-phase-body">
      <div class="bf-done">
        <div class="bf-done-icon">✓</div>
        <div style="font-size:18px; font-weight:600; color:#33281c; margin-bottom:8px;">
          Backfill complete
        </div>
        <div class="bf-done-summary">
          ${approved} material${approved === 1 ? '' : 's'} enriched · ${rejected} rejected<br>
          The catalog is updated. Next time you select these materials on any proposal,
          the images will be there automatically.
        </div>
        <button class="bf-run-btn" id="bfClose" style="background:#9c7440;">Close</button>
      </div>
    </div>
  `;
}

function attachBackfillEvents() {
  const modal = ctx.container.querySelector('#mpModal');
  if (!modal) return;

  modal.querySelector('#bfRun')?.addEventListener('click', runVisionMatch);
  modal.querySelector('#bfClose')?.addEventListener('click', closeModal);
  modal.querySelector('#bfFinish')?.addEventListener('click', () => {
    ctx.backfill.phase = 'done';
    renderBackfillModal();
  });

  modal.querySelector('#bfApproveHigh')?.addEventListener('click', approveAllHighConfidence);

  modal.querySelectorAll('[data-action="approve"]').forEach(btn => {
    btn.addEventListener('click', () => approveMatch(btn.dataset.imageId));
  });
  modal.querySelectorAll('[data-action="reject"]').forEach(btn => {
    btn.addEventListener('click', () => rejectMatch(btn.dataset.imageId));
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Vision matching
// ───────────────────────────────────────────────────────────────────────────
async function runVisionMatch() {
  const bf = ctx.backfill;
  if (!bf) return;

  bf.phase = 'analyzing';
  bf.error = null;
  bf.progress = null;
  renderBackfillModal();

  const batches = [];
  for (let i = 0; i < bf.images.length; i += VISION_MAX_IMAGES_PER_BATCH) {
    batches.push({
      images: bf.images.slice(i, i + VISION_MAX_IMAGES_PER_BATCH),
      offset: i
    });
  }

  const allMatches = [];
  let done = 0;

  try {
    for (let bi = 0; bi < batches.length; bi++) {
      bf.progress = { current: bi + 1, total: batches.length, done };
      renderBackfillModal();

      const batch = batches[bi];
      const payload = {
        images: batch.images.map(img => ({ id: img.id, url: img.url })),
        materials: bf.materials.map(m => ({
          source: m.source,
          catalog_id: m.catalog_id,
          manufacturer: m.manufacturer,
          product_name: m.product_name,
          color: m.color,
          size_spec: m.size_spec,
          application_area: m.application_area
        }))
      };

      const res = await fetch('/api/vision-match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json().catch(() => null);

      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }

      for (const m of (json.matches || [])) {
        allMatches.push({
          ...m,
          image_index: m.image_index + batch.offset
        });
      }

      done += batch.images.length;
    }
  } catch (err) {
    bf.phase = 'idle';
    bf.error = `Vision matching failed: ${err.message}`;
    renderBackfillModal();
    return;
  }

  bf.matches = allMatches;
  bf.decisions = {};
  bf.phase = 'review';
  bf.progress = null;
  renderBackfillModal();
}

// ───────────────────────────────────────────────────────────────────────────
// Approve / reject match decisions
// ───────────────────────────────────────────────────────────────────────────
async function approveMatch(imageId) {
  const bf = ctx.backfill;
  if (!bf) return;

  const match = bf.matches.find(m => {
    const img = bf.images[m.image_index];
    return img && img.id === imageId && m.is_match;
  });
  if (!match) return;

  const img = bf.images[match.image_index];
  const mat = bf.materials[match.material_index];
  if (!img || !mat) return;

  const modal = ctx.container.querySelector('#mpModal');
  const select = modal?.querySelector(`.bf-target-select[data-image-id="${imageId}"]`);
  const targetField = select?.value || 'primary_image_url';

  const tableName = mat.source === 'belgard' ? 'belgard_materials' : 'third_party_materials';

  bf.decisions[imageId] = { status: 'approving', targetField };
  renderBackfillModal();

  try {
    const { data: current, error: readErr } = await supabase
      .from(tableName)
      .select(`id, ${targetField}`)
      .eq('id', mat.catalog_id)
      .single();

    if (readErr) throw new Error(`Read failed: ${readErr.message}`);

    if (current[targetField]) {
      bf.decisions[imageId] = {
        status: 'error',
        error: `${targetField} already set in catalog`,
        targetField
      };
      renderBackfillModal();
      return;
    }

    const { error: writeErr } = await supabase
      .from(tableName)
      .update({ [targetField]: img.url })
      .eq('id', mat.catalog_id);

    if (writeErr) throw new Error(`Write failed: ${writeErr.message}`);

    // Phase 3B.1 — also mirror the change into the unified materials
    // table so the picker reflects the new image immediately on next
    // load. Map the legacy third_party_materials.image_url field onto
    // materials.primary_image_url since the unified schema doesn't have
    // a separate image_url column. Failure here is non-fatal — the
    // source-table write already succeeded, so the picker will catch up
    // on the next page load via the materials read.
    let materialsField = targetField;
    if (mat.source === 'third_party' && targetField === 'image_url') {
      materialsField = 'primary_image_url';
    }
    const { error: matWriteErr } = await supabase
      .from('materials')
      .update({ [materialsField]: img.url })
      .eq('id', mat.catalog_id);
    if (matWriteErr) {
      console.warn('Could not mirror to materials:', matWriteErr.message);
    }

    applyCatalogUpdate(mat.source, mat.catalog_id, targetField, img.url);

    bf.decisions[imageId] = { status: 'approved', targetField };
    mat.existing[targetField] = img.url;

    renderBackfillModal();
    ctx.onSave?.();
  } catch (err) {
    bf.decisions[imageId] = {
      status: 'error',
      error: err.message,
      targetField
    };
    renderBackfillModal();
  }
}

function rejectMatch(imageId) {
  const bf = ctx.backfill;
  if (!bf) return;
  bf.decisions[imageId] = { status: 'rejected' };
  renderBackfillModal();
}

async function approveAllHighConfidence() {
  const bf = ctx.backfill;
  if (!bf) return;

  const pending = bf.matches.filter(m => {
    if (!m.is_match) return false;
    if (m.confidence < HIGH_CONFIDENCE_THRESHOLD) return false;
    const img = bf.images[m.image_index];
    if (!img) return false;
    const decision = bf.decisions[img.id];
    return !decision || decision.status === 'pending';
  });

  for (const m of pending) {
    const img = bf.images[m.image_index];
    if (img) {
      await approveMatch(img.id);
    }
  }
}

function applyCatalogUpdate(source, catalogId, targetField, url) {
  if (source === 'belgard') {
    const row = ctx.catalog.find(c => c.id === catalogId);
    if (row) row[targetField] = url;
  } else {
    const row = ctx.thirdParty.find(t => t.id === catalogId);
    if (row) row[targetField] = url;
  }

  for (const sel of ctx.selected) {
    if (source === 'belgard' && sel.belgard_material_id === catalogId && sel.belgard) {
      sel.belgard[targetField] = url;
    }
    if (source === 'third_party' && sel.third_party_material_id === catalogId && sel.third_party) {
      sel.third_party[targetField] = url;
    }
  }

  if (source === 'belgard') groupProducts();
}

// ───────────────────────────────────────────────────────────────────────────
// Write actions (Supabase mutations) — selecting/removing materials
// ───────────────────────────────────────────────────────────────────────────
async function addBelgardMaterial(belgardMaterialId) {
  // Phase 3B.1 — dual-write material_id alongside the legacy
  // belgard_material_id so reads from either FK resolve cleanly. Read
  // back via the unified materials embed and shim into s.belgard so
  // the rest of the render code is byte-identical.
  const { data, error } = await supabase
    .from('proposal_materials')
    .insert({
      proposal_id: ctx.proposalId,
      material_source: 'belgard',
      belgard_material_id: belgardMaterialId,
      material_id: belgardMaterialId,
      display_order: ctx.selected.length
    })
    .select(`
      *,
      material:material_id (id, manufacturer, product_name, color, size_spec,
        primary_image_url, swatch_url, cut_sheet_url, spec_pdf_url,
        category, catalog_url)
    `)
    .single();

  if (error) { alert('Failed to add material: ' + error.message); return false; }
  ctx.selected.push(shimSelectedRow(data));
  render();
  ctx.onSave?.();
  return true;
}

async function addThirdPartyMaterial(thirdPartyId) {
  // Phase 3B.1 — same dual-write pattern as addBelgardMaterial: write
  // both legacy third_party_material_id and the unified material_id.
  const { data, error } = await supabase
    .from('proposal_materials')
    .insert({
      proposal_id: ctx.proposalId,
      material_source: 'third_party',
      third_party_material_id: thirdPartyId,
      material_id: thirdPartyId,
      display_order: ctx.selected.length
    })
    .select(`
      *,
      material:material_id (id, manufacturer, product_name, color, size_spec,
        primary_image_url, swatch_url, cut_sheet_url, spec_pdf_url,
        category, catalog_url)
    `)
    .single();

  if (error) { alert('Failed to add third-party material: ' + error.message); return false; }
  ctx.selected.push(shimSelectedRow(data));
  render();
  ctx.onSave?.();
  return true;
}

async function removeMaterial(proposalMaterialId) {
  const { error } = await supabase.from('proposal_materials').delete().eq('id', proposalMaterialId);
  if (error) { alert('Failed to remove material: ' + error.message); return; }
  ctx.selected = ctx.selected.filter(s => s.id !== proposalMaterialId);
  render();
  ctx.onSave?.();
}

async function updateApplicationArea(proposalMaterialId, area) {
  const { error } = await supabase
    .from('proposal_materials')
    .update({ application_area: area })
    .eq('id', proposalMaterialId);
  if (error) { alert('Failed to update area: ' + error.message); return; }
  const item = ctx.selected.find(s => s.id === proposalMaterialId);
  if (item) item.application_area = area;
  ctx.onSave?.();
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function publicStorageUrl(storagePath) {
  if (!storagePath) return '';
  const { data } = supabase.storage.from('proposal-photos').getPublicUrl(storagePath);
  return data?.publicUrl || '';
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
