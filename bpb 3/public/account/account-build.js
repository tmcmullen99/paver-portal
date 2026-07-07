// account-build.js · Sprint 29.1
// Project-type-tabbed guides under "How we build".
// Merges catalogs + spec_sheets under "Browse products" with distinct badges.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL  = 'https://gfgbypcnxkschnfsitfb.supabase.co';
const SUPABASE_ANON = 'sb_publishable_Ko4LNw2VjhZVFmwJ-i2qtA_XeGgBcew';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const ACUITY_URL = 'https://baysidepaversfreeconsultation.as.me/';

const PROJECT_TYPES = [
  { slug: 'pavers',        label: 'Pavers',          lede: 'Paver patios, walkways, and garden paths — the most common Bayside project. Built to ICPI standards with polymeric jointing sand, your choice of pattern, and a base graded for your soil and climate.' },
  { slug: 'driveway',      label: 'Driveways',       lede: 'Driveways carry your car day in, day out. The base depth (8" vs 4" for patios), bond pattern (herringbone for shear strength), and edge restraints all matter more here than anywhere else.' },
  { slug: 'pool_deck',     label: 'Pool decks',      lede: 'Pool decks are a different animal — slip resistance, surface temperature, and how the coping meets the deck all need solving. Porcelain has become the go-to for new builds; pavers are still the workhorse for retrofits.' },
  { slug: 'walls',         label: 'Retaining walls', lede: 'Retaining walls are engineered structures, not stacked stones. A leveling pad of compacted aggregate, drainage backfill, and geosynthetic reinforcement (where soil and height demand it) is what keeps them straight for decades.' },
  { slug: 'turf',          label: 'Turf',            lede: 'Synthetic turf installs over a free-draining base with proper sub-grade compaction and infill brushing. Shade tolerance, drainage, and pet-specific systems all factor into product selection.' },
  { slug: 'drainage',      label: 'Drainage',        lede: 'Drainage gets engineered into every project from day one — sub-surface pipe where the design needs it, surface grading sloped at least 2% away from structures, and proper outlets so water actually leaves. Also a standalone fix when an existing yard floods.' },
  { slug: 'fire_features', label: 'Fire features',   lede: 'Fire pits, fire walls, and outdoor fireplaces. Bases are built like retaining walls; gas runs go through licensed plumbers; finish caps are mortared in to last.' },
  { slug: 'lighting',      label: 'Lighting',        lede: 'Low-voltage LED path lighting and accent fixtures. Transformer-driven, weatherproof connections, and proper voltage drop calculations across long runs — so lights at the end of a path are as bright as the ones at the start.' },
];

// Cross-section diagram per project type (static assets in /account/diagrams/)
const PROJECT_DIAGRAMS = {
  pavers:        { src: '/account/diagrams/paver-cross-section.svg',         alt: 'Cross-section of an interlocking paver installation' },
  driveway:      { src: '/account/diagrams/driveway-cross-section.svg',       alt: 'Cross-section of a paver driveway and its deeper base' },
  pool_deck:     { src: '/account/diagrams/pool-deck-cross-section.svg',      alt: 'Cross-section of a paver pool deck with coping and deck drain' },
  walls:         { src: '/account/diagrams/retaining-wall-cross-section.svg', alt: 'Cross-section of a segmental retaining wall' },
  turf:          { src: '/account/diagrams/turf-cross-section.svg',           alt: 'Cross-section of an artificial turf lawn' },
  drainage:      { src: '/account/diagrams/french-drain-cross-section.svg',   alt: 'Cross-section of a French drain' },
  fire_features: { src: '/account/diagrams/fire-pit-cross-section.svg',       alt: 'Cross-section of a gas fire pit' },
  lighting:      { src: '/account/diagrams/lighting-system-diagram.svg',      alt: 'Diagram of a low-voltage landscape lighting system' },
};

let GUIDES_CACHE = [];
let STEPS_CACHE = [];
let MFR_CACHE = [];
let currentTab = 'pavers';

(async function init() {
  const howWeBuild = document.getElementById('how-we-build');
  if (!howWeBuild) return;
  injectStyles();
  const oldIv = howWeBuild.querySelector('.ho-iv-section');
  if (oldIv) oldIv.remove();
  const section = document.createElement('div');
  section.className = 'ho-pt-section';
  section.innerHTML = `
    <div class="ho-pt-head">
      <h3>Detailed guides by project type</h3>
      <p>Each project type has its own build process, products, and warranty considerations. Pick the one that matches yours.</p>
    </div>
    <div class="ho-pt-tabs" id="ho-pt-tabs"></div>
    <div class="ho-pt-body" id="ho-pt-body">
      <div class="ho-pt-loading">Loading project guides…</div>
    </div>
  `;
  howWeBuild.appendChild(section);
  await Promise.all([loadGuides(), loadSteps(), loadWarranties()]);
  renderTabs();
  renderBody();
})();

function injectStyles() {
  if (document.getElementById('ho-pt-styles')) return;
  const style = document.createElement('style');
  style.id = 'ho-pt-styles';
  style.textContent = `
    .ho-pt-section { margin-top: 22px; }
    .ho-pt-head { margin-bottom: 16px; }
    .ho-pt-head h3 { font-size: 15px; font-weight: 600; color: var(--bp-text); margin-bottom: 6px; }
    .ho-pt-head p { font-size: 13px; color: var(--bp-muted); line-height: 1.55; max-width: 580px; }
    .ho-pt-tabs {
      display: flex; gap: 6px; flex-wrap: wrap;
      margin-bottom: 14px; padding-bottom: 14px;
      border-bottom: 1px solid var(--bp-border);
    }
    .ho-pt-tab {
      flex-shrink: 0;
      background: transparent;
      border: 1px solid var(--bp-border);
      padding: 8px 14px;
      border-radius: 999px;
      font-family: inherit; font-size: 12px; font-weight: 600;
      color: var(--bp-muted);
      cursor: pointer;
      display: inline-flex; align-items: center; gap: 8px;
      transition: background .15s, color .15s, border-color .15s;
      white-space: nowrap;
    }
    .ho-pt-tab:hover {
      color: var(--bp-text);
      background: var(--bp-cream);
      border-color: var(--bp-green);
    }
    .ho-pt-tab.is-active {
      background: var(--bp-green); color: #fff;
      border-color: var(--bp-green);
    }
    .ho-pt-tab-count {
      background: rgba(0,0,0,0.06);
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 10px; font-weight: 700;
      letter-spacing: 0.02em;
    }
    .ho-pt-tab.is-active .ho-pt-tab-count {
      background: rgba(255,255,255,0.22); color: #fff;
    }
    .ho-pt-tab-count.empty {
      background: var(--bp-cream); color: var(--bp-muted);
    }
    .ho-pt-body {
      background: #fff;
      border: 1px solid var(--bp-border);
      border-radius: 12px;
      padding: 22px 24px 24px;
      min-height: 200px;
    }
    .ho-pt-lede {
      font-size: 14px;
      line-height: 1.65;
      color: var(--bp-charcoal);
      margin-bottom: 20px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--bp-border);
    }
    .ho-pt-diagram { width: 100%; height: auto; display: block; border: 1px solid var(--bp-border); border-radius: 12px; background: var(--bp-cream); }
    .ho-pt-steps-intro { font-size: 13px; color: var(--bp-muted); line-height: 1.6; margin-bottom: 12px; }
    .ho-pt-steps { display: flex; flex-direction: column; gap: 8px; }
    .ho-pt-step { border: 1px solid var(--bp-border); border-radius: 8px; overflow: hidden; }
    .ho-pt-step[open] { border-color: var(--bp-green); }
    .ho-pt-step-head { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 10px; padding: 11px 14px; user-select: none; }
    .ho-pt-step-head::-webkit-details-marker { display: none; }
    .ho-pt-step-num { font-size: 11px; font-weight: 700; color: var(--bp-green); font-family: monospace; }
    .ho-pt-step-title { font-size: 13px; font-weight: 600; color: var(--bp-text); flex: 1; }
    .ho-pt-step-arrow { color: var(--bp-muted); font-size: 16px; transition: transform .2s; }
    .ho-pt-step[open] .ho-pt-step-arrow { transform: rotate(90deg); }
    .ho-pt-step-detail { padding: 0 14px 14px; }
    .ho-pt-step-detail p { font-size: 13px; color: var(--bp-charcoal); line-height: 1.6; margin: 0 0 8px; }
    .ho-pt-step-bullets { margin: 0; padding-left: 18px; }
    .ho-pt-step-bullets li { font-size: 12.5px; color: var(--bp-muted); line-height: 1.5; margin-bottom: 3px; }
    .ho-pt-step-source { font-size: 12px; color: var(--bp-muted); margin: 10px 0 0; }
    .ho-pt-step-source a { color: var(--bp-green); text-decoration: none; }
    .ho-pt-tab:focus-visible, .ho-pt-step-head:focus-visible, .ho-pt-card:focus-visible { outline: 2px solid var(--bp-green); outline-offset: 2px; border-radius: 6px; }
    @media (prefers-reduced-motion: reduce) { .ho-pt-step-arrow, .ho-pt-tab, .ho-pt-card { transition: none !important; } }
    .ho-pt-warranty { display: flex; flex-direction: column; gap: 8px; }
    .ho-pt-warranty-item { border: 1px solid var(--bp-border); border-radius: 8px; padding: 12px 14px; background: #fff; }
    .ho-pt-warranty-primary { border-color: var(--bp-green); background: var(--bp-cream); }
    .ho-pt-warranty-name { font-weight: 600; font-size: 13px; color: var(--bp-text); margin-bottom: 4px; }
    .ho-pt-warranty-item p { margin: 0 0 6px; font-size: 13px; color: var(--bp-charcoal); line-height: 1.55; }
    .ho-pt-warranty-item a { font-size: 12px; color: var(--bp-green); text-decoration: none; }
    .ho-pt-sub { margin-bottom: 22px; }
    .ho-pt-sub:last-child { margin-bottom: 0; }
    .ho-pt-sub h4 {
      font-size: 10px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-weight: 700;
      color: var(--bp-charcoal);
      margin-bottom: 10px;
    }
    .ho-pt-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 10px;
    }
    .ho-pt-card {
      display: block;
      background: #fff;
      border: 1px solid var(--bp-border);
      border-radius: 8px;
      overflow: hidden;
      text-decoration: none;
      color: inherit;
      transition: border-color .15s, transform .15s, box-shadow .15s;
    }
    .ho-pt-card:hover {
      border-color: var(--bp-green);
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(93,126,105,0.10);
    }
    .ho-pt-card-thumb {
      position: relative;
      aspect-ratio: 16/9;
      background: #000;
      overflow: hidden;
    }
    .ho-pt-card-thumb img {
      width: 100%; height: 100%;
      object-fit: cover; display: block;
    }
    .ho-pt-card-thumb.pdf {
      background: var(--bp-tan);
      display: flex; align-items: center; justify-content: center;
      color: var(--bp-charcoal);
      font-size: 13px; font-weight: 700;
      letter-spacing: 0.1em;
    }
    .ho-pt-card-thumb.catalog {
      background: var(--bp-green-soft);
      display: flex; align-items: center; justify-content: center;
      color: var(--bp-green-dk);
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 8px;
      text-align: center;
      line-height: 1.2;
    }
    .ho-pt-card-thumb.spec {
      background: linear-gradient(135deg, var(--bp-green-soft) 0%, var(--bp-cream) 100%);
      display: flex; align-items: center; justify-content: center;
      color: var(--bp-green-dk);
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 8px;
      text-align: center;
      line-height: 1.2;
    }
    .ho-pt-card-play {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: rgba(255,255,255,0.94);
      font-size: 22px;
      text-shadow: 0 2px 8px rgba(0,0,0,0.55);
      pointer-events: none;
    }
    .ho-pt-card-label { padding: 8px 10px 10px; }
    .ho-pt-card-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--bp-text);
      line-height: 1.3;
      margin-bottom: 2px;
    }
    .ho-pt-card-kind {
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--bp-muted);
      font-weight: 700;
    }
    .ho-pt-empty {
      background: var(--bp-cream);
      border: 1px dashed var(--bp-border);
      border-radius: 10px;
      padding: 24px;
      text-align: center;
      color: var(--bp-muted);
      font-size: 13px;
      line-height: 1.6;
    }
    .ho-pt-empty p { margin-bottom: 10px; }
    .ho-pt-empty p:last-child { margin-bottom: 14px; }
    .ho-pt-empty-cta {
      display: inline-flex; align-items: center; gap: 6px;
      background: var(--bp-green); color: #fff;
      padding: 10px 20px;
      border-radius: 999px;
      font-size: 12px; font-weight: 600;
      text-decoration: none;
      transition: background .15s;
    }
    .ho-pt-empty-cta:hover { background: var(--bp-green-dk); }
    .ho-pt-loading {
      text-align: center;
      padding: 40px 20px;
      color: var(--bp-muted);
      font-size: 13px;
    }
    @media (max-width: 480px) {
      .ho-pt-grid { grid-template-columns: repeat(2, 1fr); }
      .ho-pt-body { padding: 18px 16px 20px; }
    }
  `;
  document.head.appendChild(style);
}

async function loadGuides() {
  try {
    const { data, error } = await supabase
      .from('install_guides')
      .select('id, kind, content_type, video_id, url, title, description, category, manufacturer, project_types, thumbnail_url, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    GUIDES_CACHE = data || [];
  } catch (err) {
    console.warn('[account-build loadGuides]', err);
    GUIDES_CACHE = [];
  }
}

async function loadSteps() {
  try {
    const { data, error } = await supabase
      .from('installation_steps')
      .select('project_type, step_order, title, body_md, bullets, source_url, source_page')
      .eq('is_active', true)
      .order('step_order', { ascending: true });
    if (error) throw error;
    STEPS_CACHE = data || [];
  } catch (err) {
    console.warn('[account-build loadSteps]', err);
    STEPS_CACHE = [];
  }
}

async function loadWarranties() {
  try {
    const { data, error } = await supabase
      .from('manufacturer_info')
      .select('name, display_name, warranty_summary, warranty_url')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    MFR_CACHE = data || [];
  } catch (err) {
    console.warn('[account-build loadWarranties]', err);
    MFR_CACHE = [];
  }
}

function countGuidesForType(slug) {
  return GUIDES_CACHE.filter(g =>
    Array.isArray(g.project_types) && g.project_types.includes(slug)
  ).length;
}
function getGuidesForType(slug) {
  return GUIDES_CACHE.filter(g =>
    Array.isArray(g.project_types) && g.project_types.includes(slug)
  );
}
function getStepsForType(slug) {
  return STEPS_CACHE
    .filter(s => s.project_type === slug)
    .sort((a, b) => (a.step_order || 0) - (b.step_order || 0));
}

const STEP_SOURCE_LABELS = [
  { match: 'belgard.com',     label: 'Belgard Product Installation Guide' },
  { match: 'msisurfaces.com', label: 'MSI Evergrass Installation Guide' },
];

function stepSourceCitation(steps) {
  const withSrc = (steps || []).find(s => s.source_url);
  if (!withSrc) return '';
  let label = 'Manufacturer installation guide';
  for (const s of STEP_SOURCE_LABELS) {
    if (withSrc.source_url.includes(s.match)) { label = s.label; break; }
  }
  const page = withSrc.source_page ? ` (p. ${withSrc.source_page})` : '';
  return `<p class="ho-pt-step-source">Source: <a href="${escapeAttr(withSrc.source_url)}" target="_blank" rel="noopener">${escapeHtml(label + page)}</a></p>`;
}

function renderStepsSection(slug) {
  const steps = getStepsForType(slug);
  if (!steps.length) return '';
  const intro = steps.find(s => s.step_order === 0);
  const body = steps.filter(s => s.step_order > 0);
  const items = body.map(s => {
    const bullets = Array.isArray(s.bullets) && s.bullets.length
      ? `<ul class="ho-pt-step-bullets">${s.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
      : '';
    return `<details class="ho-pt-step">
      <summary class="ho-pt-step-head">
        <span class="ho-pt-step-num">${String(s.step_order).padStart(2, '0')}</span>
        <span class="ho-pt-step-title">${escapeHtml(s.title || '')}</span>
        <span class="ho-pt-step-arrow">›</span>
      </summary>
      <div class="ho-pt-step-detail">
        ${s.body_md ? `<p>${escapeHtml(s.body_md)}</p>` : ''}
        ${bullets}
      </div>
    </details>`;
  }).join('');
  return `<div class="ho-pt-sub">
    <h4>Step-by-step build</h4>
    ${intro && intro.body_md ? `<p class="ho-pt-steps-intro">${escapeHtml(intro.body_md)}</p>` : ''}
    <div class="ho-pt-steps">${items}</div>
    ${stepSourceCitation(steps)}
  </div>`;
}

function renderWarrantySection(slug) {
  if (!MFR_CACHE.length) return '';
  const bayside = MFR_CACHE.find(m => (m.name || '').toLowerCase() === 'bayside' && m.warranty_summary);
  const present = new Set(
    getGuidesForType(slug).map(g => (g.manufacturer || '').toLowerCase().trim()).filter(Boolean)
  );
  const mfrs = MFR_CACHE.filter(m => {
    if (!m.warranty_summary) return false;
    const nm = (m.name || '').toLowerCase().trim();
    const dn = (m.display_name || '').toLowerCase().trim();
    if (nm === 'bayside') return false;
    return present.has(nm) || present.has(dn) ||
      [...present].some(p => (nm && (p.includes(nm) || nm.includes(p))) ||
                             (dn && (p.includes(dn) || dn.includes(p))));
  });
  if (!bayside && !mfrs.length) return '';
  const card = (name, summary, url, primary) =>
    `<div class="ho-pt-warranty-item${primary ? ' ho-pt-warranty-primary' : ''}">
      <div class="ho-pt-warranty-name">${escapeHtml(name)}</div>
      <p>${escapeHtml(summary)}</p>
      ${url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">View warranty</a>` : ''}
    </div>`;
  const baysideHtml = bayside
    ? card('Bayside Pavers — workmanship', bayside.warranty_summary, bayside.warranty_url, true) : '';
  const mfrHtml = mfrs.map(m =>
    card(`${m.display_name || m.name} — materials`, m.warranty_summary, m.warranty_url, false)).join('');
  return `<div class="ho-pt-sub">
    <h4>What protects it</h4>
    <div class="ho-pt-warranty">${baysideHtml}${mfrHtml}</div>
  </div>`;
}

function renderTabs() {
  const tabsEl = document.getElementById('ho-pt-tabs');
  if (!tabsEl) return;
  tabsEl.innerHTML = PROJECT_TYPES.map(t => {
    const count = countGuidesForType(t.slug);
    const isActive = t.slug === currentTab;
    return `<button type="button" class="ho-pt-tab ${isActive ? 'is-active' : ''}" data-slug="${escapeAttr(t.slug)}">
      ${escapeHtml(t.label)}
      <span class="ho-pt-tab-count ${count === 0 ? 'empty' : ''}">${count}</span>
    </button>`;
  }).join('');
  tabsEl.querySelectorAll('[data-slug]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset.slug;
      if (slug === currentTab) return;
      currentTab = slug;
      renderTabs();
      renderBody();
    });
  });
}

function renderBody() {
  const bodyEl = document.getElementById('ho-pt-body');
  if (!bodyEl) return;
  const type = PROJECT_TYPES.find(t => t.slug === currentTab);
  if (!type) { bodyEl.innerHTML = ''; return; }

  const guides = getGuidesForType(type.slug);
  const videos = guides.filter(g => g.video_id);
  const installGuides = guides.filter(g => g.content_type === 'install_guide');
  // Sprint 29.1 · merge catalogs + spec_sheets under "Browse products"
  const products = guides.filter(g => g.content_type === 'catalog' || g.content_type === 'spec_sheet');

  const ledeHtml = `<p class="ho-pt-lede">${escapeHtml(type.lede)}</p>`;
  const dgm = PROJECT_DIAGRAMS[type.slug];
  const diagramHtml = dgm
    ? `<div class="ho-pt-sub"><h4>How it's built</h4><img class="ho-pt-diagram" src="${escapeAttr(dgm.src)}" alt="${escapeAttr(dgm.alt)}" loading="lazy"></div>`
    : '';
  const stepsHtml = renderStepsSection(type.slug);
  const warrantyHtml = renderWarrantySection(type.slug);

  if (guides.length === 0) {
    bodyEl.innerHTML = `
      ${ledeHtml}
      ${diagramHtml}
      ${stepsHtml}
      ${warrantyHtml}
      <div class="ho-pt-empty">
        <p>Detailed ${escapeHtml(type.label.toLowerCase())} content is coming soon.</p>
        <p>Schedule a design appointment to walk through your specific project with our team.</p>
        <a class="ho-pt-empty-cta" href="${ACUITY_URL}" target="_blank" rel="noopener">📅 Schedule a free design appointment</a>
      </div>`;
    return;
  }

  let html = ledeHtml + diagramHtml + stepsHtml + warrantyHtml;
  if (videos.length > 0) {
    html += `
      <div class="ho-pt-sub">
        <h4>Watch how we build</h4>
        <div class="ho-pt-grid">${videos.map(renderVideoCard).join('')}</div>
      </div>`;
  }
  if (installGuides.length > 0) {
    html += `
      <div class="ho-pt-sub">
        <h4>Detailed installation guides</h4>
        <div class="ho-pt-grid">${installGuides.map(renderPdfCard).join('')}</div>
      </div>`;
  }
  if (products.length > 0) {
    html += `
      <div class="ho-pt-sub">
        <h4>Browse products &amp; specs</h4>
        <div class="ho-pt-grid">${products.map(renderProductCard).join('')}</div>
      </div>`;
  }
  bodyEl.innerHTML = html;
}

function renderVideoCard(g) {
  const title = g.title || (g.manufacturer ? `${g.manufacturer} installation` : 'Installation video');
  const thumb = g.thumbnail_url || `https://i.ytimg.com/vi/${g.video_id}/hqdefault.jpg`;
  return `<a class="ho-pt-card" href="https://www.youtube.com/watch?v=${escapeAttr(g.video_id)}" target="_blank" rel="noopener">
    <div class="ho-pt-card-thumb">
      <img src="${escapeAttr(thumb)}" alt="" loading="lazy">
      <div class="ho-pt-card-play">▶</div>
    </div>
    <div class="ho-pt-card-label">
      <div class="ho-pt-card-title">${escapeHtml(title)}</div>
      <div class="ho-pt-card-kind">Video</div>
    </div>
  </a>`;
}

function renderPdfCard(g) {
  const title = g.title || 'Installation guide';
  return `<a class="ho-pt-card" href="${escapeAttr(g.url || '#')}" target="_blank" rel="noopener">
    <div class="ho-pt-card-thumb pdf"><span>PDF</span></div>
    <div class="ho-pt-card-label">
      <div class="ho-pt-card-title">${escapeHtml(title)}</div>
      <div class="ho-pt-card-kind">Install guide</div>
    </div>
  </a>`;
}

// Sprint 29.1 · merged card renderer for both catalogs and spec_sheets
function renderProductCard(g) {
  const title = g.title || (g.manufacturer ? `${g.manufacturer} product` : 'Product');
  const isSpec = g.content_type === 'spec_sheet';
  const isPdf  = g.kind === 'pdf';
  const kindLabel = isSpec
    ? (isPdf ? 'Cut sheet' : 'Product page')
    : 'Catalog';
  let thumbClass, thumbContent;
  if (isPdf) {
    thumbClass = 'pdf';
    thumbContent = isSpec ? 'CUTSHEET' : 'CATALOG';
  } else {
    thumbClass = isSpec ? 'spec' : 'catalog';
    thumbContent = escapeHtml(g.manufacturer || 'Product');
  }
  return `<a class="ho-pt-card" href="${escapeAttr(g.url || '#')}" target="_blank" rel="noopener">
    <div class="ho-pt-card-thumb ${thumbClass}">${thumbContent}</div>
    <div class="ho-pt-card-label">
      <div class="ho-pt-card-title">${escapeHtml(title)}</div>
      <div class="ho-pt-card-kind">${kindLabel}</div>
    </div>
  </a>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
