// Materials catalog for /account/v2/ — searchable, tabbed, with rich detail modal
// Mounts into #v2-materials-mount

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL  = 'https://gfgbypcnxkschnfsitfb.supabase.co';
const SUPABASE_ANON = 'sb_publishable_Ko4LNw2VjhZVFmwJ-i2qtA_XeGgBcew';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const CATEGORIES = [
  { slug: 'all',           label: 'All' },
  { slug: 'pavers',        label: 'Pavers' },
  { slug: 'porcelain',     label: 'Porcelain' },
  { slug: 'walls',         label: 'Walls' },
  { slug: 'fire-features', label: 'Fire features' },
  { slug: 'decking',       label: 'Decking' },
  { slug: 'lighting',      label: 'Lighting' },
  { slug: 'accessories',   label: 'Accessories' },
  { slug: 'other',         label: 'Other' },
];

// Cross-section diagram per material category (static assets in /account/diagrams/)
const CATEGORY_DIAGRAMS = {
  'pavers':        { src: '/account/diagrams/paver-cross-section.svg',         alt: 'Cross-section of an interlocking paver installation' },
  'porcelain':     { src: '/account/diagrams/paver-cross-section.svg',         alt: 'Cross-section of a paver installation (porcelain pavers use the same base)' },
  'walls':         { src: '/account/diagrams/retaining-wall-cross-section.svg', alt: 'Cross-section of a segmental retaining wall' },
  'fire-features': { src: '/account/diagrams/fire-pit-cross-section.svg',       alt: 'Cross-section of a gas fire pit' },
  'decking':       { src: '/account/diagrams/pool-deck-cross-section.svg',      alt: 'Cross-section of a paver pool deck' },
  'turf':          { src: '/account/diagrams/turf-cross-section.svg',           alt: 'Cross-section of an artificial turf lawn' },
  'lighting':      { src: '/account/diagrams/lighting-system-diagram.svg',      alt: 'Diagram of a low-voltage landscape lighting system' },
};

let MATERIALS = [];
let MANUFACTURERS = [];
let INSTALL_GUIDES = [];
let activeCat = 'all';
let searchTerm = '';
let mountEl = null;

// ── Styles ───────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('vm-styles')) return;
  const css = document.createElement('style');
  css.id = 'vm-styles';
  css.textContent = `
    .vm-toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 18px; }
    .vm-search-wrap { flex: 1; min-width: 220px; position: relative; }
    .vm-search-wrap::before {
      content: '🔍'; position: absolute; left: 14px; top: 50%;
      transform: translateY(-50%); font-size: 13px; opacity: 0.5;
      pointer-events: none;
    }
    .vm-search {
      width: 100%;
      padding: 11px 14px 11px 38px;
      border: 1px solid var(--bp-border);
      border-radius: 999px;
      background: #fff;
      font-family: inherit; font-size: 13px;
      color: var(--bp-text);
      transition: border-color .15s, box-shadow .15s;
    }
    .vm-search:focus { outline: none; border-color: var(--bp-green); box-shadow: 0 0 0 3px rgba(93,126,105,.12); }
    .vm-count { font-size: 12px; color: var(--bp-muted); margin-left: auto; }
    .vm-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--bp-border); }
    .vm-tab {
      padding: 7px 14px;
      border-radius: 999px;
      background: #fff;
      border: 1px solid var(--bp-border);
      color: var(--bp-charcoal);
      font-family: inherit; font-size: 12px; font-weight: 500;
      cursor: pointer;
      transition: background .15s, border-color .15s, color .15s;
    }
    .vm-tab:hover { border-color: var(--bp-green); color: var(--bp-green-dk); }
    .vm-tab.is-active { background: var(--bp-green); border-color: var(--bp-green); color: #fff; font-weight: 600; }
    .vm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
    .vm-card {
      background: #fff;
      border: 1px solid var(--bp-border);
      border-radius: 12px;
      overflow: hidden;
      cursor: pointer;
      transition: border-color .15s, transform .15s, box-shadow .15s;
      display: flex; flex-direction: column;
    }
    .vm-card:hover { border-color: var(--bp-green); transform: translateY(-2px); box-shadow: 0 8px 20px rgba(93,126,105,.10); }
    .vm-card-img { aspect-ratio: 4/3; width: 100%; background: var(--bp-cream); position: relative; overflow: hidden; }
    .vm-card-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .vm-card-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--bp-muted); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
    .vm-card-body { padding: 12px 14px 14px; }
    .vm-card-mfr { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--bp-green-dk); font-weight: 700; margin-bottom: 4px; }
    .vm-card-name { font-size: 13px; font-weight: 600; color: var(--bp-text); line-height: 1.3; margin-bottom: 3px; }
    .vm-card-meta { font-size: 11px; color: var(--bp-muted); }
    .vm-empty { grid-column: 1 / -1; text-align: center; padding: 48px 24px; color: var(--bp-muted); font-size: 13px; background: #fff; border: 1px dashed var(--bp-border); border-radius: 12px; }
    .vm-loading { padding: 36px; text-align: center; color: var(--bp-muted); font-size: 13px; }

    /* Modal */
    .vm-modal {
      position: fixed; inset: 0;
      background: rgba(20, 24, 22, 0.55);
      display: none; align-items: flex-start; justify-content: center;
      z-index: 1000; padding: 32px 16px;
      overflow-y: auto;
    }
    .vm-modal.is-open { display: flex; }
    .vm-modal-dialog {
      background: #fff;
      border-radius: 14px;
      max-width: 720px;
      width: 100%;
      overflow: hidden;
      box-shadow: 0 24px 64px rgba(0,0,0,.32);
      position: relative;
      margin: auto;
    }
    .vm-modal-hero { position: relative; aspect-ratio: 16/9; background: var(--bp-cream); overflow: hidden; }
    .vm-modal-hero img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .vm-modal-hero-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--bp-muted); font-size: 14px; letter-spacing: 0.1em; }
    .vm-modal-close {
      position: absolute; top: 14px; right: 14px;
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(255,255,255,.92); border: none;
      cursor: pointer; font-size: 18px;
      display: flex; align-items: center; justify-content: center;
      color: var(--bp-charcoal); font-weight: 700;
      transition: background .15s;
    }
    .vm-modal-close:hover { background: #fff; }
    .vm-modal-body { padding: 24px 28px 28px; }
    .vm-modal-mfr { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--bp-green-dk); font-weight: 700; margin-bottom: 6px; }
    .vm-modal-name { font-size: 22px; font-weight: 600; color: var(--bp-text); letter-spacing: -0.012em; margin-bottom: 10px; line-height: 1.25; }
    .vm-modal-meta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--bp-muted); margin-bottom: 16px; }
    .vm-modal-desc { font-size: 14px; color: var(--bp-charcoal); line-height: 1.6; margin-bottom: 18px; }
    .vm-modal-section { margin-top: 22px; }
    .vm-modal-section-title { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--bp-muted); font-weight: 700; margin-bottom: 10px; }
    .vm-modal-diagram { margin: 0; border: 1px solid var(--bp-border); border-radius: 10px; overflow: hidden; background: var(--bp-cream); }
    .vm-modal-diagram img { display: block; width: 100%; height: auto; }

    .vm-warranty-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 540px) { .vm-warranty-grid { grid-template-columns: 1fr; } }
    .vm-warranty {
      background: var(--bp-cream);
      border-radius: 10px;
      padding: 14px 16px;
      border: 1px solid var(--bp-border);
    }
    .vm-warranty-label { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--bp-green-dk); font-weight: 700; margin-bottom: 6px; }
    .vm-warranty-text { font-size: 13px; line-height: 1.5; color: var(--bp-charcoal); margin-bottom: 8px; }
    .vm-warranty-link { font-size: 12px; font-weight: 600; color: var(--bp-green-dk); text-decoration: none; }
    .vm-warranty-link:hover { text-decoration: underline; }

    .vm-guides-list { display: grid; gap: 8px; }
    .vm-guide {
      display: flex; align-items: center; gap: 10px;
      padding: 11px 14px;
      background: var(--bp-cream);
      border-radius: 8px;
      border: 1px solid transparent;
      text-decoration: none;
      transition: border-color .15s, background .15s;
    }
    .vm-guide:hover { border-color: var(--bp-green); background: #fff; text-decoration: none; }
    .vm-guide-icon { font-size: 18px; flex-shrink: 0; }
    .vm-guide-info { flex: 1; min-width: 0; }
    .vm-guide-title { font-size: 13px; font-weight: 600; color: var(--bp-text); line-height: 1.3; }
    .vm-guide-meta { font-size: 11px; color: var(--bp-muted); margin-top: 2px; }
    .vm-guide-arrow { color: var(--bp-muted); flex-shrink: 0; }

    .vm-cta-row {
      margin-top: 20px;
      padding-top: 18px;
      border-top: 1px solid var(--bp-border);
      display: flex; gap: 10px; flex-wrap: wrap;
    }
    .vm-cta-btn {
      padding: 10px 16px;
      border-radius: 8px;
      background: var(--bp-green);
      color: #fff;
      text-decoration: none;
      font-size: 12px; font-weight: 600;
      transition: background .15s;
      display: inline-flex; align-items: center; gap: 6px;
      border: none; cursor: pointer; font-family: inherit;
    }
    .vm-cta-btn:hover { background: var(--bp-green-dk); text-decoration: none; }
    .vm-cta-btn.ghost { background: #fff; color: var(--bp-charcoal); border: 1px solid var(--bp-border); }
    .vm-cta-btn.ghost:hover { background: var(--bp-cream); border-color: var(--bp-green); color: var(--bp-green-dk); }
  `;
  document.head.appendChild(css);
}

// ── Data ─────────────────────────────────────────────────
async function loadData() {
  const [mats, mfrs, guides] = await Promise.all([
    supabase.from('materials').select('id, manufacturer, product_name, collection, color, pattern, size_spec, description, category, primary_image_url, swatch_url, cut_sheet_url, source_pdf_url, catalog_url, applications, features, thickness_mm, installation_guide_id').order('manufacturer').order('product_name'),
    supabase.from('manufacturer_info').select('*'),
    supabase.from('install_guides').select('id, manufacturer, category, title, url, content_type, project_types, description'),
  ]);
  MATERIALS = mats.data || [];
  MANUFACTURERS = mfrs.data || [];
  INSTALL_GUIDES = guides.data || [];
}

function findManufacturer(name) {
  if (!name) return null;
  const lc = name.toLowerCase();
  return MANUFACTURERS.find(m => (m.manufacturer || '').toLowerCase() === lc) || null;
}
function findBayside() {
  return MANUFACTURERS.find(m =>
    (m.manufacturer || '').toLowerCase().includes('bayside')
  ) || null;
}
function filterGuidesForMaterial(m) {
  if (!m) return [];
  const mfrLc = (m.manufacturer || '').toLowerCase();
  const catLc = (m.category || '').toLowerCase();
  return INSTALL_GUIDES.filter(g => {
    const gMfr = (g.manufacturer || '').toLowerCase();
    const gCat = (g.category || '').toLowerCase();
    if (gMfr && gMfr === mfrLc) return true;
    if (gCat && gCat === catLc) return true;
    return false;
  }).slice(0, 8);
}

// ── Rendering ────────────────────────────────────────────
function pickImageUrl(m) {
  const hostBlocked = (u) => /belgard\.com/i.test(u || '');
  const urls = [m.primary_image_url, m.swatch_url].filter(Boolean);
  return urls.find(u => !hostBlocked(u)) || urls[0] || null;
}
function diagramSectionFor(m) {
  const d = CATEGORY_DIAGRAMS[(m.category || '').toLowerCase()];
  if (!d) return '';
  return `
    <div class="vm-modal-section">
      <div class="vm-modal-section-title">How it's built</div>
      <figure class="vm-modal-diagram">
        <img src="${escapeAttr(d.src)}" alt="${escapeAttr(d.alt)}" loading="lazy">
      </figure>
    </div>`;
}
function matchesCat(m) {
  if (activeCat === 'all') return true;
  return (m.category || '').toLowerCase() === activeCat;
}
function matchesSearch(m) {
  if (!searchTerm) return true;
  const q = searchTerm.toLowerCase();
  const hay = [
    m.manufacturer, m.product_name, m.collection, m.color, m.pattern,
    m.description, m.category, m.product_type
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}
function renderShell() {
  const tabsHtml = CATEGORIES.map(c =>
    `<button type="button" class="vm-tab${c.slug === activeCat ? ' is-active' : ''}" data-cat="${c.slug}">${c.label}</button>`
  ).join('');
  mountEl.innerHTML = `
    <div class="vm-toolbar">
      <div class="vm-search-wrap">
        <input class="vm-search" type="search" placeholder="Search by name, color, manufacturer..." aria-label="Search materials" />
      </div>
      <div class="vm-count" id="vm-count"></div>
    </div>
    <div class="vm-tabs">${tabsHtml}</div>
    <div class="vm-grid" id="vm-grid"></div>
  `;
  mountEl.querySelector('.vm-search').addEventListener('input', e => {
    searchTerm = e.target.value.trim();
    renderGrid();
  });
  mountEl.querySelectorAll('.vm-tab').forEach(t => {
    t.addEventListener('click', () => {
      activeCat = t.dataset.cat;
      mountEl.querySelectorAll('.vm-tab').forEach(x => x.classList.toggle('is-active', x.dataset.cat === activeCat));
      renderGrid();
    });
  });
  renderGrid();
}
function renderGrid() {
  const filtered = MATERIALS.filter(m => matchesCat(m) && matchesSearch(m));
  const grid = mountEl.querySelector('#vm-grid');
  const count = mountEl.querySelector('#vm-count');
  count.textContent = `${filtered.length} of ${MATERIALS.length}`;
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="vm-empty">No materials match your search. Try a different term or pick another category.</div>`;
    return;
  }
  grid.innerHTML = filtered.map(renderCard).join('');
  grid.querySelectorAll('[data-mid]').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.mid));
  });
}
function renderCard(m) {
  const img = pickImageUrl(m);
  const imgBlock = img
    ? `<img src="${escapeAttr(img)}" alt="${escapeAttr(m.product_name || 'Material')}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=&quot;vm-card-placeholder&quot;>${escapeAttr((m.manufacturer || 'Material').toUpperCase())}</div>'">`
    : `<div class="vm-card-placeholder">${escapeHtml((m.manufacturer || 'Material').toUpperCase())}</div>`;
  return `
    <article class="vm-card" data-mid="${escapeAttr(m.id)}" role="button" tabindex="0" aria-label="View ${escapeAttr(m.product_name || 'material')}">
      <div class="vm-card-img">${imgBlock}</div>
      <div class="vm-card-body">
        <div class="vm-card-mfr">${escapeHtml(m.manufacturer || '')}</div>
        <div class="vm-card-name">${escapeHtml(m.product_name || '—')}</div>
        <div class="vm-card-meta">${escapeHtml([m.color, m.collection].filter(Boolean).join(' · ') || '')}</div>
      </div>
    </article>`;
}

// ── Modal ────────────────────────────────────────────────
function openModal(mid) {
  const m = MATERIALS.find(x => x.id === mid);
  if (!m) return;
  closeModal();
  const mfr = findManufacturer(m.manufacturer);
  const bayside = findBayside();
  const guides = filterGuidesForMaterial(m);
  const heroImg = pickImageUrl(m);
  const heroBlock = heroImg
    ? `<img src="${escapeAttr(heroImg)}" alt="${escapeAttr(m.product_name || '')}" onerror="this.parentElement.innerHTML='<div class=&quot;vm-modal-hero-placeholder&quot;>${escapeAttr((m.manufacturer || 'Material').toUpperCase())}</div>'">`
    : `<div class="vm-modal-hero-placeholder">${escapeHtml((m.manufacturer || 'Material').toUpperCase())}</div>`;

  const metaBits = [
    m.size_spec && `📏 ${escapeHtml(m.size_spec)}`,
    m.thickness_mm && `${m.thickness_mm}mm thick`,
    m.pattern && escapeHtml(m.pattern),
    m.collection && `${escapeHtml(m.collection)} collection`,
  ].filter(Boolean).join(' · ');

  const warrantyHtml = `
    <div class="vm-modal-section">
      <div class="vm-modal-section-title">Warranty</div>
      <div class="vm-warranty-grid">
        ${mfr && mfr.warranty_summary ? `
          <div class="vm-warranty">
            <div class="vm-warranty-label">${escapeHtml(m.manufacturer || 'Manufacturer')} material</div>
            <div class="vm-warranty-text">${escapeHtml(mfr.warranty_summary)}</div>
            ${mfr.warranty_url ? `<a class="vm-warranty-link" href="${escapeAttr(mfr.warranty_url)}" target="_blank" rel="noopener">View full warranty PDF →</a>` : ''}
          </div>
        ` : `
          <div class="vm-warranty">
            <div class="vm-warranty-label">${escapeHtml(m.manufacturer || 'Manufacturer')} material</div>
            <div class="vm-warranty-text">Manufacturer warranty details available on request.</div>
          </div>
        `}
        ${bayside ? `
          <div class="vm-warranty">
            <div class="vm-warranty-label">Bayside installation</div>
            <div class="vm-warranty-text">${escapeHtml(bayside.warranty_summary || '25-year installation warranty on all Bayside-installed work.')}</div>
            ${bayside.warranty_url ? `<a class="vm-warranty-link" href="${escapeAttr(bayside.warranty_url)}" target="_blank" rel="noopener">View full warranty PDF →</a>` : ''}
          </div>
        ` : ''}
      </div>
    </div>`;

  const guidesHtml = guides.length ? `
    <div class="vm-modal-section">
      <div class="vm-modal-section-title">Install guides &amp; specs</div>
      <div class="vm-guides-list">
        ${guides.map(g => {
          const icon = ({ video: '🎬', install_guide: '📄', catalog: '📚', spec_sheet: '📋', warranty: '🛡️' })[g.content_type] || '📄';
          const label = ({ video: 'Video', install_guide: 'Install guide', catalog: 'Catalog', spec_sheet: 'Cut sheet', warranty: 'Warranty' })[g.content_type] || 'Guide';
          return `
            <a class="vm-guide" href="${escapeAttr(g.url)}" target="_blank" rel="noopener">
              <div class="vm-guide-icon">${icon}</div>
              <div class="vm-guide-info">
                <div class="vm-guide-title">${escapeHtml(g.title || 'Untitled')}</div>
                <div class="vm-guide-meta">${label}${g.manufacturer ? ' · ' + escapeHtml(g.manufacturer) : ''}</div>
              </div>
              <div class="vm-guide-arrow">→</div>
            </a>`;
        }).join('')}
      </div>
    </div>` : '';

  const dialog = document.createElement('div');
  dialog.className = 'vm-modal';
  dialog.innerHTML = `
    <div class="vm-modal-dialog" role="dialog" aria-label="${escapeAttr(m.product_name || 'Material')}">
      <div class="vm-modal-hero">
        ${heroBlock}
        <button class="vm-modal-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="vm-modal-body">
        <div class="vm-modal-mfr">${escapeHtml(m.manufacturer || '')}</div>
        <div class="vm-modal-name">${escapeHtml(m.product_name || '—')}</div>
        ${metaBits ? `<div class="vm-modal-meta">${metaBits}</div>` : ''}
        ${m.description ? `<div class="vm-modal-desc">${escapeHtml(m.description)}</div>` : ''}
        ${m.color || m.collection ? `<div class="vm-modal-meta"><strong style="color:var(--bp-text)">Color:</strong>&nbsp;${escapeHtml(m.color || '—')}${m.collection ? ' &nbsp;·&nbsp; <strong style="color:var(--bp-text)">Collection:</strong>&nbsp;' + escapeHtml(m.collection) : ''}</div>` : ''}
        ${diagramSectionFor(m)}
        ${warrantyHtml}
        ${guidesHtml}
        <div class="vm-cta-row">
          <button class="vm-cta-btn" type="button" data-jump-how="true">📚 See our 5-phase install process</button>
          ${m.cut_sheet_url ? `<a class="vm-cta-btn ghost" href="${escapeAttr(m.cut_sheet_url)}" target="_blank" rel="noopener">📋 Cut sheet</a>` : ''}
          ${m.source_pdf_url ? `<a class="vm-cta-btn ghost" href="${escapeAttr(m.source_pdf_url)}" target="_blank" rel="noopener">📄 Spec page</a>` : ''}
          ${m.catalog_url ? `<a class="vm-cta-btn ghost" href="${escapeAttr(m.catalog_url)}" target="_blank" rel="noopener">📚 Full catalog</a>` : ''}
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  requestAnimationFrame(() => dialog.classList.add('is-open'));
  document.body.style.overflow = 'hidden';

  dialog.querySelector('.vm-modal-close').addEventListener('click', closeModal);
  dialog.addEventListener('click', e => { if (e.target === dialog) closeModal(); });
  dialog.querySelector('[data-jump-how]')?.addEventListener('click', () => {
    closeModal();
    if (window.location.hash !== '#how-we-install') window.location.hash = '#how-we-install';
  });
  document.addEventListener('keydown', escClose);
}
function closeModal() {
  const m = document.querySelector('.vm-modal');
  if (m) m.remove();
  document.body.style.overflow = '';
  document.removeEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }

// ── Util ─────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

// ── Mount ────────────────────────────────────────────────
async function init() {
  mountEl = document.getElementById('v2-materials-mount');
  if (!mountEl) return;
  injectStyles();
  mountEl.innerHTML = '<div class="vm-loading">Loading materials catalog…</div>';
  try {
    await loadData();
    renderShell();
  } catch (e) {
    console.error('[materials]', e);
    mountEl.innerHTML = `<div class="vm-empty">Could not load materials catalog. Please try again later.</div>`;
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
