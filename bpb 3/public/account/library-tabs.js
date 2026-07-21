// ═══════════════════════════════════════════════════════════════════════════
// bpb 3/public/account/library-tabs.js
// Sprint 35 Phase B — Tabbed Library shared component
//
// Renders the per-project-type library in two contexts:
//
//   Portal mode  — mounted from /account/index.html into the Library pane.
//                  Queries Supabase directly for all data. All 8 tabs are
//                  interactive.
//
//   Proposal mode — injected into /p/<slug> via the Cloudflare Pages
//                  function. Calls get_proposal_quality_context(slug);
//                  detected types are sorted to the front, non-detected
//                  remain visible but greyed-out at the end (capability
//                  signaling).
//
// Public API:
//   mountLibrary(container, options) -> Promise<state>
//     options.mode         : 'portal' | 'proposal'  (required)
//     options.proposalSlug : string                 (required in proposal mode)
//     options.initialTab   : string                 (optional override)
//
// Hash routing: #library/<project_type> preserves selected tab across
// reloads and back-button. Falls back to first detected type or 'pavers'.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

const PROJECT_TYPES = [
  { id: 'pavers',        label: 'Pavers',        icon: 'ti-bricks',
    tagline: 'Interlocking concrete units that outlast slabs by decades when installed right.' },
  { id: 'driveway',      label: 'Driveways',     icon: 'ti-car',
    tagline: 'Engineered to bear the daily weight of cars, trucks, and time.' },
  { id: 'pool_deck',     label: 'Pool decks',    icon: 'ti-swimming',
    tagline: 'Slip-resistant surfaces designed for wet feet and bare ones.' },
  { id: 'walls',         label: 'Walls',         icon: 'ti-wall',
    tagline: 'Retaining and freestanding walls built to engineered standards.' },
  { id: 'turf',          label: 'Turf',          icon: 'ti-plant',
    tagline: 'Synthetic grass on a paver-grade base — 15 years plush, not 2.' },
  { id: 'drainage',      label: 'Drainage',      icon: 'ti-droplet',
    tagline: 'Engineered grade and pipes that move water away from your home.' },
  { id: 'fire_features', label: 'Fire features', icon: 'ti-flame',
    tagline: 'Fire pits and outdoor fireplaces, lined and code-compliant.' },
  { id: 'lighting',      label: 'Lighting',      icon: 'ti-bulb',
    tagline: 'Tru-Scapes low-voltage, color-tunable, placed at the Pre-Walk.' },
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

// Content attribution — Track 3 personalization. Articles are credited to the
// Paver Portal designer who owns the homeowner's account, so the person they're
// already working with shows up as the expert behind the content. Resolved
// per-mount; falls back gracefully if the designer can't be determined.
let CONTENT_AUTHOR = 'Your designer';

async function resolveContentAuthor(options) {
  // A host can pass an explicit name (e.g. a proposal page supplying its designer).
  if (options && options.authorName) {
    return String(options.authorName).trim().split(/\s+/)[0] || 'Your designer';
  }
  // Portal mode: ask the DB for the logged-in homeowner's own designer (first name).
  if (options && options.mode === 'portal') {
    try {
      const { data } = await supabase.rpc('get_account_designer');
      const first = (data || '').trim().split(/\s+/)[0];
      if (first) return first;
    } catch (err) {
      console.warn('[library-tabs] designer lookup failed:', err);
    }
  }
  return 'Your designer';
}

async function resolvePortalProjectTypes() {
  // Detect the logged-in homeowner's own project type(s) from their proposals,
  // so the portal Library leads with what they're actually buying. Returns null
  // to signal "show all types" when nothing can be detected.
  try {
    const { data } = await supabase.rpc('get_account_project_types');
    if (Array.isArray(data) && data.length) {
      const valid = new Set(PROJECT_TYPES.map(t => t.id));
      const filtered = data.filter(t => valid.has(t));
      if (filtered.length) return filtered;
    }
  } catch (err) {
    console.warn('[library-tabs] project-type lookup failed:', err);
  }
  return null;
}

// materials.category uses hyphens; project_types uses underscores. Map.
const CATEGORY_TO_PROJECT_TYPES = {
  'pavers':        ['pavers', 'driveway', 'pool_deck'],
  'porcelain':     ['pool_deck', 'pavers'],
  'walls':         ['walls', 'fire_features'],
  'fire-features': ['fire_features'],
  'decking':       ['pool_deck'],
  'lighting':      ['lighting'],
  'accessories':   ['pavers', 'driveway', 'pool_deck', 'walls', 'fire_features'],
  'other':         [],
};

function categoriesForProjectType(projectType) {
  return Object.entries(CATEGORY_TO_PROJECT_TYPES)
    .filter(([, types]) => types.includes(projectType))
    .map(([cat]) => cat);
}

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

export async function mountLibrary(container, options = {}) {
  if (!container) throw new Error('mountLibrary: container element required');
  if (!options.mode) throw new Error('mountLibrary: options.mode required');

  injectBaseStyles();

  const state = {
    mode: options.mode,
    proposalSlug: options.proposalSlug,
    data: null,
    detectedTypes: [],
    activeTab: null,
    container,
  };

  // Render loading skeleton immediately
  container.innerHTML = `<div class="bpb-library-loading">Loading library…</div>`;

  try {
    state.data = options.mode === 'proposal'
      ? await fetchProposalData(options.proposalSlug)
      : await fetchPortalData();
  } catch (err) {
    console.error('[library-tabs] data fetch failed:', err);
    container.innerHTML = `<div class="bpb-library-error">Couldn't load the library. Please refresh the page.</div>`;
    return null;
  }

  // Portal personalization (Track 3): attribute content to the homeowner's
  // designer and lead with their actual project type(s) — resolved in parallel.
  let portalTypes = null;
  if (options.mode === 'portal') {
    [CONTENT_AUTHOR, portalTypes] = await Promise.all([
      resolveContentAuthor(options),
      resolvePortalProjectTypes(),
    ]);
  } else {
    CONTENT_AUTHOR = await resolveContentAuthor(options);
  }

  state.detectedTypes = options.mode === 'proposal'
    ? (state.data.project_types_detected || [])
    : (portalTypes && portalTypes.length ? portalTypes : PROJECT_TYPES.map(t => t.id));

  const validIds = new Set(PROJECT_TYPES.map(t => t.id));
  let initialTab = readHashTab() || options.initialTab || state.detectedTypes[0] || 'pavers';
  if (!validIds.has(initialTab)) initialTab = state.detectedTypes[0] || 'pavers';
  state.activeTab = initialTab;

  render(state);
  setupHashListener(state);
  return state;
}

// ───────────────────────────────────────────────────────────────────────────
// Data fetching
// ───────────────────────────────────────────────────────────────────────────

async function fetchPortalData() {
  const [baysideRes, manufacturersRes, guidesRes, articlesRes, materialsRes, stepsRes] = await Promise.all([
    supabase.from('manufacturer_info')
      .select('quality_standards, warranty_summary, about')
      .eq('name', 'Paver Portal').single(),
    supabase.from('manufacturer_info')
      .select('name, display_name, warranty_summary, warranty_url, about, sort_order')
      .eq('is_active', true).order('sort_order'),
    supabase.from('install_guides')
      .select('id, kind, video_id, url, title, description, category, manufacturer, thumbnail_url, sort_order')
      .eq('is_active', true).order('sort_order'),
    supabase.from('content_articles')
      .select('id, slug, title, excerpt, hero_image_url, author, published_at, project_types, source_url, is_external, reading_time_min, sort_order')
      .eq('is_active', true).order('sort_order'),
    supabase.from('materials')
      .select('id, name, category, color, swatch_url, manufacturer, line')
      .order('name'),
    supabase.from('installation_steps')
      .select('project_type, step_order, title, body_md, bullets, source_url, source_page')
      .eq('is_active', true).order('step_order'),
  ]);

  return {
    bayside_standards: baysideRes.data || {},
    manufacturers: manufacturersRes.data || [],
    install_guides: guidesRes.data || [],
    content_articles: articlesRes.data || [],
    materials: materialsRes.data || [],
    installation_steps: stepsRes.data || [],
  };
}

async function fetchProposalData(slug) {
  const { data, error } = await supabase.rpc('get_proposal_quality_context', { p_slug: slug });
  if (error) throw error;
  // Proposal RPC doesn't include full materials list — fetch separately for tab grids
  const [materialsRes, stepsRes] = await Promise.all([
    supabase.from('materials')
      .select('id, name, category, color, swatch_url, manufacturer, line')
      .order('name'),
    supabase.from('installation_steps')
      .select('project_type, step_order, title, body_md, bullets, source_url, source_page')
      .eq('is_active', true).order('step_order'),
  ]);
  return {
    ...data,
    materials: materialsRes.data || [],
    installation_steps: stepsRes.data || [],
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Top-level render
// ───────────────────────────────────────────────────────────────────────────

function render(state) {
  state.container.innerHTML = `
    ${state.mode === 'portal' ? renderGlobalSearch() : ''}
    ${renderTabStrip(state)}
    <div id="bpb-library-tab-content" class="bpb-library-tab-content">
      ${renderActiveTab(state)}
    </div>
  `;
  attachTabClickHandlers(state);
  if (state.mode === 'portal') attachSearchHandlers(state);
  attachAccordionHandlers(state);
  attachMaterialClickHandlers(state);
}

function rerenderActiveTab(state) {
  const target = state.container.querySelector('#bpb-library-tab-content');
  if (target) target.innerHTML = renderActiveTab(state);
  attachAccordionHandlers(state);
  attachMaterialClickHandlers(state);
}

// ───────────────────────────────────────────────────────────────────────────
// Tab strip
// ───────────────────────────────────────────────────────────────────────────

function renderTabStrip(state) {
  const detected = new Set(state.detectedTypes);
  // "Your project" markers show whenever detection personalized the strip to a
  // real subset (in either mode). On fallback (all types detected) we show no
  // markers, so we don't end up dotting every tab.
  const personalized = state.detectedTypes.length > 0
    && state.detectedTypes.length < PROJECT_TYPES.length;
  // Detected first (in PROJECT_TYPES order), then non-detected greyed
  const sorted = [
    ...PROJECT_TYPES.filter(t => detected.has(t.id)),
    ...PROJECT_TYPES.filter(t => !detected.has(t.id)),
  ];
  const tabs = sorted.map(type => {
    const isActive = state.activeTab === type.id;
    const isDetected = detected.has(type.id);
    const mark = isDetected && personalized;
    return `
      <button class="bpb-library-tab ${isActive ? 'is-active' : ''} ${isDetected ? '' : 'is-greyed'}"
              data-tab="${type.id}" type="button" role="tab"
              aria-selected="${isActive ? 'true' : 'false'}"
              aria-label="${escapeAttr(type.label + (mark ? ' — your project' : ''))}"
              title="${escapeAttr(type.tagline)}">
        <i class="ti ${type.icon}" aria-hidden="true"></i>
        ${escapeHtml(type.label)}
        ${mark ? '<span class="bpb-library-tab-dot" aria-hidden="true"></span>' : ''}
      </button>
    `;
  }).join('');
  return `<div class="bpb-library-tab-strip" role="tablist">${tabs}</div>`;
}

function attachTabClickHandlers(state) {
  state.container.querySelectorAll('.bpb-library-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const newTab = btn.dataset.tab;
      if (newTab === state.activeTab) return;
      state.activeTab = newTab;
      writeHashTab(newTab);
      state.container.querySelectorAll('.bpb-library-tab').forEach(b => {
        const on = b.dataset.tab === newTab;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      rerenderActiveTab(state);
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Active tab content
// ───────────────────────────────────────────────────────────────────────────

function renderActiveTab(state) {
  const type = PROJECT_TYPES.find(t => t.id === state.activeTab);
  if (!type) return `<p>Unknown tab</p>`;

  const articles = filterArticles(state.data.content_articles || [], type.id);
  const guides = filterGuides(state.data.install_guides || [], type.id);
  const videos = guides.filter(g => g.video_id);
  const docs = guides.filter(g => !g.video_id);
  const materials = filterMaterials(state.data.materials || [], type.id);
  const steps = filterSteps(state.data.installation_steps || [], type.id);

  return [
    renderHero(type, { videos, docs, articles, materials }),
    renderDiagram(type),
    steps.length ? renderInstallSteps(steps) : renderPhases(state.data.bayside_standards),
    renderWarranty(state.data.bayside_standards, state.data.manufacturers || [], materials),
    renderVideosSection(videos),
    renderGuidesSection(docs),
    renderArticlesSection(articles),
    renderMaterialsSection(type, materials),
  ].join('');
}

function filterArticles(articles, projectType) {
  return articles.filter(a => Array.isArray(a.project_types) && a.project_types.includes(projectType));
}

function filterGuides(guides, projectType) {
  const cats = categoriesForProjectType(projectType);
  return guides.filter(g => cats.includes(g.category));
}

function filterMaterials(materials, projectType) {
  const cats = categoriesForProjectType(projectType);
  return materials.filter(m => cats.includes(m.category));
}

function filterSteps(steps, projectType) {
  return steps
    .filter(s => s.project_type === projectType)
    .sort((a, b) => (a.step_order || 0) - (b.step_order || 0));
}

// ───────────────────────────────────────────────────────────────────────────
// Hero
// ───────────────────────────────────────────────────────────────────────────

function renderHero(type, counts) {
  return `
    <div class="bpb-library-hero">
      <i class="ti ${type.icon} bpb-library-hero-icon" aria-hidden="true"></i>
      <div class="bpb-library-hero-text">
        <h2>${escapeHtml(type.label)}</h2>
        <p>${escapeHtml(type.tagline)}</p>
      </div>
      <div class="bpb-library-hero-stats">
        ${statChip(counts.videos.length, counts.videos.length === 1 ? 'video' : 'videos')}
        ${statChip(counts.docs.length, counts.docs.length === 1 ? 'guide' : 'guides')}
        ${statChip(counts.articles.length, counts.articles.length === 1 ? 'article' : 'articles')}
        ${statChip(counts.materials.length, counts.materials.length === 1 ? 'material' : 'materials')}
      </div>
    </div>
  `;
}

function statChip(count, label) {
  return `<span class="bpb-library-stat">${count} ${escapeHtml(label)}</span>`;
}

// ───────────────────────────────────────────────────────────────────────────
// Cross-section diagram
// ───────────────────────────────────────────────────────────────────────────

function renderDiagram(type) {
  const d = PROJECT_DIAGRAMS[type.id];
  if (!d) return '';
  return `
    <section class="bpb-library-section">
      <h3><i class="ti ti-stack-2" aria-hidden="true"></i> How it's built</h3>
      <figure class="bpb-library-diagram">
        <img src="${escapeAttr(d.src)}" alt="${escapeAttr(d.alt)}" loading="lazy">
      </figure>
    </section>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Install steps (per project type)
// ───────────────────────────────────────────────────────────────────────────

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
  return `<p class="bpb-library-step-source">Source: <a href="${escapeAttr(withSrc.source_url)}" target="_blank" rel="noopener">${escapeHtml(label + page)}</a></p>`;
}

function renderInstallSteps(steps) {
  const intro = steps.find(s => s.step_order === 0);
  const body = steps.filter(s => s.step_order > 0);
  const items = body.map(s => {
    const bullets = Array.isArray(s.bullets) && s.bullets.length
      ? `<ul class="bpb-library-step-bullets">${s.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
      : '';
    return `
      <div class="bpb-library-phase">
        <button class="bpb-library-phase-header" type="button" aria-expanded="false">
          <span class="bpb-library-phase-num">${String(s.step_order).padStart(2, '0')}</span>
          <span class="bpb-library-phase-title">${escapeHtml(s.title || '')}</span>
          <i class="ti ti-chevron-down bpb-library-phase-chevron" aria-hidden="true"></i>
        </button>
        <div class="bpb-library-phase-body" hidden>
          ${s.body_md ? `<p>${escapeHtml(s.body_md)}</p>` : ''}
          ${bullets}
        </div>
      </div>
    `;
  }).join('');
  return `
    <section class="bpb-library-section">
      <h3><i class="ti ti-tools" aria-hidden="true"></i> How we install</h3>
      ${intro && intro.body_md ? `<p class="bpb-library-install-intro">${escapeHtml(intro.body_md)}</p>` : ''}
      <div class="bpb-library-phases">${items}</div>
      ${stepSourceCitation(steps)}
    </section>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Phases (5-phase quality standards)
// ───────────────────────────────────────────────────────────────────────────

function renderWarranty(baysideStandards, manufacturers, materials) {
  const bayside = (baysideStandards && baysideStandards.warranty_summary) ? baysideStandards : null;
  const present = new Set(
    (materials || []).map(m => (m.manufacturer || '').toLowerCase().trim()).filter(Boolean)
  );
  const mfrWarranties = (manufacturers || []).filter(mfr => {
    if (!mfr.warranty_summary) return false;
    const nm = (mfr.name || '').toLowerCase().trim();
    const dn = (mfr.display_name || '').toLowerCase().trim();
    if (nm === 'bayside') return false;
    return present.has(nm) || present.has(dn) ||
      [...present].some(p => (nm && (p.includes(nm) || nm.includes(p))) ||
                             (dn && (p.includes(dn) || dn.includes(p))));
  });
  if (!bayside && !mfrWarranties.length) return '';
  const baysideHtml = bayside ? `
      <div class="bpb-library-warranty-item bpb-library-warranty-primary">
        <div class="bpb-library-warranty-name">Workmanship warranty</div>
        <p>${escapeHtml(bayside.warranty_summary)}</p>
        ${bayside.warranty_url ? `<a href="${escapeAttr(bayside.warranty_url)}" target="_blank" rel="noopener">View warranty</a>` : ''}
      </div>` : '';
  const mfrHtml = mfrWarranties.map(mfr => `
      <div class="bpb-library-warranty-item">
        <div class="bpb-library-warranty-name">${escapeHtml(mfr.display_name || mfr.name || '')} — materials</div>
        <p>${escapeHtml(mfr.warranty_summary)}</p>
        ${mfr.warranty_url ? `<a href="${escapeAttr(mfr.warranty_url)}" target="_blank" rel="noopener">View warranty</a>` : ''}
      </div>`).join('');
  return `
    <section class="bpb-library-section">
      <h3><i class="ti ti-shield-check" aria-hidden="true"></i> What protects it</h3>
      <div class="bpb-library-warranty">${baysideHtml}${mfrHtml}</div>
    </section>
  `;
}

function renderPhases(baysideStandards) {
  const phases = (baysideStandards && baysideStandards.quality_standards) || [];
  if (!phases.length) return '';

  const items = phases.map((p, i) => `
    <div class="bpb-library-phase">
      <button class="bpb-library-phase-header" type="button" aria-expanded="false">
        <span class="bpb-library-phase-num">${String(i + 1).padStart(2, '0')}</span>
        <span class="bpb-library-phase-title">${escapeHtml(p.step || '')}</span>
        <span class="bpb-library-phase-detail">${escapeHtml(p.detail || '')}</span>
        <i class="ti ti-chevron-down bpb-library-phase-chevron" aria-hidden="true"></i>
      </button>
      ${p.body ? `<div class="bpb-library-phase-body" hidden>${escapeHtml(p.body)}</div>` : ''}
    </div>
  `).join('');

  return `
    <section class="bpb-library-section">
      <h3><i class="ti ti-tools" aria-hidden="true"></i> How we install</h3>
      <div class="bpb-library-phases">${items}</div>
    </section>
  `;
}

function attachAccordionHandlers(state) {
  state.container.querySelectorAll('.bpb-library-phase-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const body = hdr.nextElementSibling;
      if (!body) return;
      const isOpen = !body.hasAttribute('hidden');
      if (isOpen) { body.setAttribute('hidden', ''); hdr.setAttribute('aria-expanded', 'false'); }
      else        { body.removeAttribute('hidden'); hdr.setAttribute('aria-expanded', 'true'); }
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Videos
// ───────────────────────────────────────────────────────────────────────────

function renderVideosSection(videos) {
  if (!videos.length) return '';
  const cards = videos.map(v => `
    <a class="bpb-library-video-card" href="https://www.youtube.com/watch?v=${escapeAttr(v.video_id)}" target="_blank" rel="noopener">
      <div class="bpb-library-video-thumb">
        ${v.thumbnail_url
          ? `<img src="${escapeAttr(v.thumbnail_url)}" alt="" loading="lazy">`
          : `<i class="ti ti-player-play" aria-hidden="true"></i>`}
      </div>
      <div class="bpb-library-video-title">${escapeHtml(v.title || 'Video')}</div>
    </a>
  `).join('');
  return `
    <section class="bpb-library-section">
      <h3><i class="ti ti-player-play" aria-hidden="true"></i> Videos</h3>
      <div class="bpb-library-video-grid">${cards}</div>
    </section>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Install guides
// ───────────────────────────────────────────────────────────────────────────

function renderGuidesSection(docs) {
  if (!docs.length) return '';
  const items = docs.map(d => `
    <a class="bpb-library-guide-card" href="${escapeAttr(d.url)}" target="_blank" rel="noopener">
      <i class="ti ${d.kind === 'catalog' ? 'ti-book' : 'ti-file-text'}" aria-hidden="true"></i>
      <div class="bpb-library-guide-meta">
        <div class="bpb-library-guide-title">${escapeHtml(d.title || 'Document')}</div>
        ${d.manufacturer ? `<div class="bpb-library-guide-mfr">${escapeHtml(d.manufacturer)}</div>` : ''}
      </div>
      <i class="ti ti-external-link" aria-hidden="true"></i>
    </a>
  `).join('');
  return `
    <section class="bpb-library-section">
      <h3><i class="ti ti-file-text" aria-hidden="true"></i> Install guides &amp; catalogs</h3>
      <div class="bpb-library-guide-list">${items}</div>
    </section>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Expert articles
// ───────────────────────────────────────────────────────────────────────────

function renderArticlesSection(articles) {
  if (!articles.length) return '';
  const cards = articles.map(a => {
    const isExternal = a.is_external && a.source_url;
    const href = isExternal ? a.source_url : `#library/article/${escapeAttr(a.slug)}`;
    return `
      <a class="bpb-library-article-card" href="${escapeAttr(href)}" ${isExternal ? 'target="_blank" rel="noopener"' : ''}>
        <div class="bpb-library-article-title">
          ${escapeHtml(a.title)}
          ${isExternal ? '<i class="ti ti-external-link" aria-hidden="true"></i>' : ''}
        </div>
        ${a.excerpt ? `<div class="bpb-library-article-excerpt">${escapeHtml(a.excerpt)}</div>` : ''}
        <div class="bpb-library-article-meta">
          ${escapeHtml(CONTENT_AUTHOR)}
          ${a.reading_time_min ? ` · ${a.reading_time_min} min read` : ''}
          ${isExternal ? ' · external' : ''}
        </div>
      </a>
    `;
  }).join('');
  return `
    <section class="bpb-library-section">
      <h3><i class="ti ti-book" aria-hidden="true"></i> Expert articles</h3>
      <div class="bpb-library-article-grid">${cards}</div>
    </section>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Materials
// ───────────────────────────────────────────────────────────────────────────

function renderMaterialsSection(type, materials) {
  if (!materials.length) return '';
  const top = materials.slice(0, 12);
  const moreCount = Math.max(0, materials.length - top.length);
  const cards = top.map(m => `
    <a class="bpb-library-material-card" data-material-id="${escapeAttr(m.id)}" href="#material/${escapeAttr(m.id)}">
      <div class="bpb-library-material-thumb">
        ${m.swatch_url ? `<img src="${escapeAttr(m.swatch_url)}" alt="" loading="lazy">` : ''}
      </div>
      <div class="bpb-library-material-name">${escapeHtml(m.name || 'Material')}</div>
      ${m.color ? `<div class="bpb-library-material-color">${escapeHtml(m.color)}</div>` : ''}
    </a>
  `).join('');
  const moreLink = moreCount > 0
    ? `<div class="bpb-library-more">+${moreCount} more — search above to find a specific material</div>`
    : '';
  return `
    <section class="bpb-library-section">
      <h3><i class="ti ti-package" aria-hidden="true"></i> Materials we install</h3>
      <div class="bpb-library-material-grid">${cards}</div>
      ${moreLink}
    </section>
  `;
}

function attachMaterialClickHandlers(state) {
  state.container.querySelectorAll('.bpb-library-material-card').forEach(card => {
    card.addEventListener('click', e => {
      e.preventDefault();
      const id = card.dataset.materialId;
      const material = (state.data.materials || []).find(m => m.id === id);
      if (material) openMaterialModal(state, material);
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Material detail modal
// ───────────────────────────────────────────────────────────────────────────

function openMaterialModal(state, material) {
  const manufacturer = (state.data.manufacturers || []).find(m =>
    (m.name || '').toLowerCase() === (material.manufacturer || '').toLowerCase()
  );
  const baysideWarranty = state.data.bayside_standards && state.data.bayside_standards.warranty_summary;

  const overlay = document.createElement('div');
  overlay.className = 'bpb-library-modal-overlay';
  overlay.innerHTML = `
    <div class="bpb-library-modal" role="dialog" aria-modal="true" aria-label="Material details">
      <button class="bpb-library-modal-close" type="button" aria-label="Close">
        <i class="ti ti-x" aria-hidden="true"></i>
      </button>
      <div class="bpb-library-modal-header">
        ${material.swatch_url ? `<img class="bpb-library-modal-hero" src="${escapeAttr(material.swatch_url)}" alt="">` : ''}
        <div class="bpb-library-modal-title-block">
          <div class="bpb-library-modal-mfr">${escapeHtml(material.manufacturer || '')}</div>
          <h2>${escapeHtml(material.name || 'Material')}</h2>
          ${material.color ? `<div class="bpb-library-modal-color">${escapeHtml(material.color)}</div>` : ''}
        </div>
      </div>
      <div class="bpb-library-modal-warranties">
        ${manufacturer ? `
          <div class="bpb-library-warranty-card">
            <h3>${escapeHtml(manufacturer.display_name || manufacturer.name)} warranty</h3>
            <p>${escapeHtml(manufacturer.warranty_summary || '—')}</p>
            ${manufacturer.warranty_url
              ? `<a href="${escapeAttr(manufacturer.warranty_url)}" target="_blank" rel="noopener">View full warranty →</a>`
              : ''}
          </div>
        ` : ''}
        <div class="bpb-library-warranty-card">
          <h3>Installation warranty</h3>
          <p>${escapeHtml(baysideWarranty || '25-year installation warranty on all Paver Portal-installed work.')}</p>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.bpb-library-modal-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Global search (portal mode only)
// ───────────────────────────────────────────────────────────────────────────

function renderGlobalSearch() {
  return `
    <div class="bpb-library-search">
      <i class="ti ti-search" aria-hidden="true"></i>
      <input type="search" id="bpb-library-search-input"
             placeholder="Search all materials by name, color, or manufacturer..."
             autocomplete="off">
      <div id="bpb-library-search-results" class="bpb-library-search-results" hidden></div>
    </div>
  `;
}

function attachSearchHandlers(state) {
  const input = state.container.querySelector('#bpb-library-search-input');
  const resultsEl = state.container.querySelector('#bpb-library-search-results');
  if (!input || !resultsEl) return;
  let timer = null;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = input.value.trim().toLowerCase();
      if (!q || q.length < 2) { resultsEl.setAttribute('hidden', ''); return; }
      const matches = (state.data.materials || []).filter(m =>
        (m.name || '').toLowerCase().includes(q) ||
        (m.color || '').toLowerCase().includes(q) ||
        (m.manufacturer || '').toLowerCase().includes(q)
      ).slice(0, 8);
      if (!matches.length) {
        resultsEl.innerHTML = `<div class="bpb-library-search-empty">No matches for "${escapeHtml(q)}"</div>`;
      } else {
        resultsEl.innerHTML = matches.map(m => `
          <button class="bpb-library-search-result" type="button" data-material-id="${escapeAttr(m.id)}">
            ${m.swatch_url ? `<img src="${escapeAttr(m.swatch_url)}" alt="" loading="lazy">` : '<i class="ti ti-package" aria-hidden="true"></i>'}
            <div>
              <div class="bpb-library-search-name">${escapeHtml(m.name || 'Material')}</div>
              <div class="bpb-library-search-meta">${escapeHtml([m.manufacturer, m.color, m.category].filter(Boolean).join(' · '))}</div>
            </div>
          </button>
        `).join('');
        resultsEl.querySelectorAll('.bpb-library-search-result').forEach(btn => {
          btn.addEventListener('click', () => {
            const material = (state.data.materials || []).find(m => m.id === btn.dataset.materialId);
            if (!material) return;
            const targetType = (CATEGORY_TO_PROJECT_TYPES[material.category] || ['pavers'])[0];
            if (targetType && targetType !== state.activeTab) {
              state.activeTab = targetType;
              writeHashTab(targetType);
              state.container.querySelectorAll('.bpb-library-tab').forEach(b => {
                b.classList.toggle('is-active', b.dataset.tab === targetType);
              });
              rerenderActiveTab(state);
            }
            resultsEl.setAttribute('hidden', '');
            input.value = '';
            openMaterialModal(state, material);
          });
        });
      }
      resultsEl.removeAttribute('hidden');
    }, 150);
  });

  document.addEventListener('click', e => {
    if (!state.container.contains(e.target)) resultsEl.setAttribute('hidden', '');
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Hash routing
// ───────────────────────────────────────────────────────────────────────────

function readHashTab() {
  const m = (location.hash || '').match(/^#library\/([a-z_]+)/);
  return m ? m[1] : null;
}

function writeHashTab(tab) {
  if (readHashTab() === tab) return;
  const newHash = `#library/${tab}`;
  if (history.replaceState) history.replaceState(null, '', newHash);
  else location.hash = newHash;
}

function setupHashListener(state) {
  window.addEventListener('hashchange', () => {
    const tab = readHashTab();
    if (tab && tab !== state.activeTab && PROJECT_TYPES.some(t => t.id === tab)) {
      state.activeTab = tab;
      state.container.querySelectorAll('.bpb-library-tab').forEach(b => {
        b.classList.toggle('is-active', b.dataset.tab === tab);
      });
      rerenderActiveTab(state);
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Base styles (minimum-viable; full styling lands in index.html rewrite)
// ───────────────────────────────────────────────────────────────────────────

function injectBaseStyles() {
  if (document.getElementById('bpb-library-tabs-styles')) return;
  const style = document.createElement('style');
  style.id = 'bpb-library-tabs-styles';
  style.textContent = `
    .bpb-library-loading,.bpb-library-error{padding:2rem;text-align:center;color:#666;font-size:14px}
    .bpb-library-error{color:#c33}
    .bpb-library-search{position:relative;display:flex;align-items:center;gap:8px;padding:10px 14px;background:#f7f6f0;border-radius:8px;margin-bottom:16px}
    .bpb-library-search input{flex:1;border:none;background:transparent;font-size:15px;outline:none;color:#2a2a26;font-family:inherit}
    .bpb-library-search .ti-search{color:#888;font-size:18px}
    .bpb-library-search-results{position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1px solid #e2dfd2;border-radius:8px;max-height:320px;overflow-y:auto;z-index:50;box-shadow:0 4px 16px rgba(0,0,0,.08)}
    .bpb-library-search-result{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:none;background:transparent;text-align:left;cursor:pointer;font-family:inherit}
    .bpb-library-search-result:hover{background:#f7f6f0}
    .bpb-library-search-result img,.bpb-library-search-result .ti{width:32px;height:32px;border-radius:4px;object-fit:cover;font-size:20px;color:#888;display:flex;align-items:center;justify-content:center}
    .bpb-library-search-name{font-size:14px;font-weight:500;color:#2a2a26}
    .bpb-library-search-meta{font-size:12px;color:#777;margin-top:2px}
    .bpb-library-search-empty{padding:14px;color:#888;font-size:13px;text-align:center}
    .bpb-library-tab-strip{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid #e2dfd2;margin-bottom:20px;padding-bottom:0}
    .bpb-library-tab{display:flex;align-items:center;gap:6px;padding:10px 14px;font-size:13px;color:#666;background:transparent;border:none;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;font-family:inherit}
    .bpb-library-tab:hover{color:#2a2a26}
    .bpb-library-tab.is-active{color:#2a2a26;border-bottom-color:#9c7440;font-weight:500}
    .bpb-library-tab.is-greyed{color:#aaa;opacity:.6}
    .bpb-library-tab .ti{font-size:15px}
    .bpb-library-hero{display:flex;align-items:center;gap:14px;padding:20px;background:#fff;border:1px solid #e2dfd2;border-radius:12px;margin-bottom:16px}
    .bpb-library-hero-icon{font-size:32px;color:#9c7440}
    .bpb-library-hero-text h2{margin:0;font-size:18px;font-weight:500;color:#2a2a26}
    .bpb-library-hero-text p{margin:2px 0 0;font-size:13px;color:#666}
    .bpb-library-hero-stats{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
    .bpb-library-stat{font-size:11px;padding:3px 10px;background:#f7f6f0;border-radius:999px;color:#666}
    .bpb-library-section{margin:20px 0}
    .bpb-library-section h3{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:500;margin:0 0 10px;color:#2a2a26}
    .bpb-library-section h3 .ti{font-size:16px;color:#9c7440}
    .bpb-library-diagram{margin:0;border:1px solid #e2dfd2;border-radius:12px;overflow:hidden;background:#faf8f3}
    .bpb-library-diagram img{display:block;width:100%;height:auto}
    .bpb-library-phases{display:flex;flex-direction:column;gap:6px}
    .bpb-library-phase{border:1px solid #e2dfd2;border-radius:8px;overflow:hidden}
    .bpb-library-phase-header{display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;background:#fff;border:none;text-align:left;cursor:pointer;font-family:inherit}
    .bpb-library-phase-header:hover{background:#fafaf6}
    .bpb-library-phase-num{font-size:12px;color:#9c7440;font-weight:500;font-family:monospace}
    .bpb-library-phase-title{font-size:14px;font-weight:500;color:#2a2a26}
    .bpb-library-phase-detail{font-size:13px;color:#666;flex:1}
    .bpb-library-phase-chevron{margin-left:auto;color:#888}
    .bpb-library-phase-body{padding:12px 14px;background:#fafaf6;font-size:13px;color:#444;line-height:1.6}
    .bpb-library-install-intro{font-size:13px;color:#555;line-height:1.6;margin:0 0 12px}
    .bpb-library-phase-body p{margin:0 0 8px}
    .bpb-library-step-bullets{margin:0;padding-left:18px}
    .bpb-library-step-bullets li{font-size:13px;color:#444;line-height:1.55;margin-bottom:3px}
    .bpb-library-step-source{font-size:12px;color:#777;margin:10px 0 0}
    .bpb-library-step-source a{color:#9c7440;text-decoration:none;border-bottom:1px solid rgba(93,126,105,.35)}
    .bpb-library-warranty{display:flex;flex-direction:column;gap:10px}
    .bpb-library-warranty-item{border:1px solid #e2dfd2;border-radius:10px;padding:12px 14px;background:#fff}
    .bpb-library-warranty-primary{border-color:#9c7440;background:#f3f7f4}
    .bpb-library-warranty-name{font-weight:600;font-size:13px;color:#353535;margin-bottom:4px}
    .bpb-library-warranty-item p{margin:0 0 6px;font-size:13px;color:#555;line-height:1.55}
    .bpb-library-warranty-item a{font-size:12px;color:#9c7440;text-decoration:none;border-bottom:1px solid rgba(93,126,105,.35)}
    .bpb-library-tab-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#9c7440;margin-left:6px;vertical-align:middle}
    .bpb-library-tab:focus-visible,.bpb-library-phase-header:focus-visible,.bpb-library-section a:focus-visible{outline:2px solid #9c7440;outline-offset:2px;border-radius:4px}
    @media (prefers-reduced-motion: reduce){.bpb-library-tab,.bpb-library-phase-chevron{transition:none !important}}
    .bpb-library-video-grid,.bpb-library-material-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
    .bpb-library-video-card,.bpb-library-material-card,.bpb-library-article-card,.bpb-library-guide-card{background:#fff;border:1px solid #e2dfd2;border-radius:8px;padding:10px;text-decoration:none;color:#2a2a26;display:block}
    .bpb-library-video-card:hover,.bpb-library-material-card:hover,.bpb-library-article-card:hover,.bpb-library-guide-card:hover{border-color:#9c7440}
    .bpb-library-video-thumb,.bpb-library-material-thumb{background:#f7f6f0;aspect-ratio:16/9;border-radius:4px;margin-bottom:8px;overflow:hidden;display:flex;align-items:center;justify-content:center}
    .bpb-library-material-thumb{aspect-ratio:1/1}
    .bpb-library-video-thumb img,.bpb-library-material-thumb img{width:100%;height:100%;object-fit:cover}
    .bpb-library-video-title,.bpb-library-material-name{font-size:13px;font-weight:500}
    .bpb-library-material-color{font-size:11px;color:#777;margin-top:2px}
    .bpb-library-guide-list,.bpb-library-article-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}
    .bpb-library-guide-card{display:flex;align-items:center;gap:10px}
    .bpb-library-guide-card .ti:first-child{font-size:20px;color:#9c7440}
    .bpb-library-guide-card .ti-external-link{font-size:14px;color:#888;margin-left:auto}
    .bpb-library-guide-meta{flex:1;min-width:0}
    .bpb-library-guide-title{font-size:13px;font-weight:500}
    .bpb-library-guide-mfr{font-size:11px;color:#777}
    .bpb-library-article-title{font-size:13px;font-weight:500;display:flex;align-items:center;gap:4px;margin-bottom:4px}
    .bpb-library-article-excerpt{font-size:12px;color:#555;line-height:1.5;margin-bottom:6px}
    .bpb-library-article-meta{font-size:11px;color:#888}
    .bpb-library-more{font-size:12px;color:#777;margin-top:10px;text-align:center}
    .bpb-library-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}
    .bpb-library-modal{background:#fff;border-radius:12px;max-width:600px;width:100%;max-height:90vh;overflow-y:auto;position:relative;padding:20px}
    .bpb-library-modal-close{position:absolute;top:12px;right:12px;background:transparent;border:none;font-size:22px;cursor:pointer;color:#666;padding:6px}
    .bpb-library-modal-hero{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:8px;margin-bottom:14px}
    .bpb-library-modal-mfr{font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px}
    .bpb-library-modal h2{margin:0;font-size:20px;font-weight:500}
    .bpb-library-modal-color{font-size:13px;color:#666;margin-top:2px}
    .bpb-library-modal-warranties{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px}
    .bpb-library-warranty-card{padding:12px;background:#f7f6f0;border-radius:8px}
    .bpb-library-warranty-card h3{font-size:13px;font-weight:500;margin:0 0 6px;color:#2a2a26}
    .bpb-library-warranty-card p{font-size:12px;color:#555;margin:0 0 6px;line-height:1.5}
    .bpb-library-warranty-card a{font-size:12px;color:#9c7440;text-decoration:none}
    @media (max-width:520px){.bpb-library-modal-warranties{grid-template-columns:1fr}.bpb-library-hero{flex-direction:column;align-items:flex-start}.bpb-library-hero-stats{margin-left:0}}
  `;
  document.head.appendChild(style);
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
