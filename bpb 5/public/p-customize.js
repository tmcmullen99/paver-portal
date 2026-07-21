// ═══════════════════════════════════════════════════════════════════════════
// /p-customize.js — Phase 4.1 Sprint B2 (revision 7) + 6.2 + 6.4A
//
// B2-r7: Move install-guide visuals from bid sections to Quality Standards.
//
// Bid sections become clean (no install footer). The Quality Standards
// section is transformed into a tab stage:
//   - Existing horizontal-scroll rail becomes a single-card stage
//   - New tab strip above lets reader pick a category directly
//   - Matched cards (paver / turf / wall) get an SVG cross-section +
//     Local Guy vs. Paver Portal comparison alongside the existing prose
//   - Unmatched cards (porcelain, accessories, fire, lighting) keep
//     their original prose-only layout
//   - Prev/next nav + page dots below
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const API_DATA = '/api/proposal-customize-data';
  const API_SUBMIT = '/api/submit-substitutions';

  const customize = {
    enabled: false,
    data: null,
    pending: new Map(),
    submitted: false,
  };

  let _bidReader = null;

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

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function scrollToHref(href) {
    if (!href || href.charAt(0) !== '#') return false;
    const target = document.querySelector(href);
    if (!target) return false;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }

  function navigateToSection(href) {
    if (!href || href.charAt(0) !== '#') return;
    const id = href.slice(1);
    if (_bidReader && _bidReader.select(id)) {
      const readerEl = _bidReader.root;
      const rect = readerEl.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.5 || rect.bottom < 0) {
        readerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    scrollToHref(href);
  }

  function normalizeMatch(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[\u2014\u2013\u2018\u2019]/g, '').trim();
  }
  function findApiMaterial(regionId, domMaterial) {
    if (!customize.enabled || !customize.data) return null;
    const candidates = customize.data.region_materials.filter((rm) => rm.region_id === regionId);
    const targetName = normalizeMatch(domMaterial.name);
    const targetColor = normalizeMatch(domMaterial.color);
    return candidates.find((rm) => {
      const apiName = normalizeMatch(rm.current.product_name);
      const apiColor = normalizeMatch(rm.current.color);
      return apiName === targetName && (targetColor ? apiColor === targetColor : true);
    }) || null;
  }

  function extractRegions() {
    const regions = [];
    document.querySelectorAll('.pub-region-legend-row').forEach((row) => {
      const id = row.getAttribute('data-region-id');
      if (!id) return;
      const dot = row.querySelector('.pub-region-legend-dot');
      const color = (dot && dot.style && dot.style.background) || '#9c7440';
      const nameEl = row.querySelector('.pub-region-legend-name');
      const metaEl = row.querySelector('.pub-region-legend-meta');
      regions.push({
        id,
        name: (nameEl ? nameEl.textContent : '').trim(),
        meta: (metaEl ? metaEl.textContent : '').trim(),
        color,
        sectionHref: row.getAttribute('href') || '',
      });
    });
    return regions;
  }

  function extractRegionMaterials(materialsGrid) {
    const map = new Map();
    materialsGrid.querySelectorAll('.pub-material-card').forEach((card) => {
      const regionIdsAttr = card.getAttribute('data-region-ids') || '';
      const regionIds = regionIdsAttr.split(',').map(s => s.trim()).filter(Boolean);
      if (regionIds.length === 0) return;

      const img = card.querySelector('img');
      const typeEl = card.querySelector('.pub-material-card-type');
      const nameEl = card.querySelector('.pub-material-card-name');
      const colorEl = card.querySelector('.pub-material-card-color');

      const material = {
        type:  ((typeEl  ? typeEl.textContent  : '') || '').trim(),
        name:  ((nameEl  ? nameEl.textContent  : '') || '').trim(),
        color: ((colorEl ? colorEl.textContent : '') || '').trim(),
        imgSrc: img ? img.getAttribute('src') : '',
      };
      regionIds.forEach((rid) => {
        if (!map.has(rid)) map.set(rid, []);
        map.get(rid).push(material);
      });
    });
    return map;
  }

  // ───────────────────────────────────────────────────────────────────────
  // INSTALL VISUALS (B2-r7 — used by Quality Standards transform)
  // ───────────────────────────────────────────────────────────────────────

  const SVG_PAVER = `<svg viewBox="0 0 280 220" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:auto;"><defs><pattern id="bpc-pat-h1" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#9c7440" stroke-width="0.6" opacity="0.5"/></pattern></defs><g fill="none" stroke="#353535" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M 18 195 L 165 195 L 168 198 L 18 198 Z" fill="#e8dfc8" opacity="0.6"/><path d="M 18 195 L 165 195"/><path d="M 22 192 L 26 195 M 35 192 L 39 195 M 50 193 L 54 196 M 70 192 L 74 195 M 92 193 L 96 196 M 115 192 L 119 195 M 140 193 L 144 196" stroke-width="0.7"/><text x="178" y="200" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">1. Native soil</text><path d="M 18 178 L 165 178 L 165 192 L 18 192 Z" fill="#d4cfb8" opacity="0.5"/><path d="M 18 178 L 165 178"/><path d="M 18 185 L 165 185" stroke-dasharray="2,2" stroke-width="0.6"/><text x="178" y="187" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">2. Geo-tech fabric</text><path d="M 18 158 L 165 158 L 165 178 L 18 178 Z" fill="url(#bpc-pat-h1)" opacity="0.4"/><path d="M 18 158 L 165 158"/><circle cx="32" cy="167" r="2"/><circle cx="48" cy="171" r="2.3"/><circle cx="64" cy="166" r="1.7"/><circle cx="82" cy="170" r="2.1"/><circle cx="100" cy="166" r="1.8"/><circle cx="120" cy="171" r="2.4"/><circle cx="142" cy="167" r="2"/><circle cx="156" cy="171" r="1.7"/><text x="178" y="172" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">3. Base material</text><path d="M 18 148 L 165 148 L 165 158 L 18 158 Z"/><path d="M 18 153 L 165 153" stroke-width="0.7"/><path d="M 30 148 L 30 158 M 50 148 L 50 158 M 70 148 L 70 158 M 90 148 L 90 158 M 110 148 L 110 158 M 130 148 L 130 158 M 150 148 L 150 158" stroke-width="0.6"/><text x="178" y="155" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">4. Geo grid</text><path d="M 18 128 L 165 128 L 165 148 L 18 148 Z" fill="url(#bpc-pat-h1)" opacity="0.4"/><path d="M 18 128 L 165 128"/><circle cx="32" cy="137" r="2"/><circle cx="48" cy="141" r="2.3"/><circle cx="64" cy="136" r="1.7"/><circle cx="82" cy="140" r="2.1"/><circle cx="100" cy="136" r="1.8"/><circle cx="120" cy="141" r="2.4"/><circle cx="142" cy="137" r="2"/><circle cx="156" cy="141" r="1.7"/><text x="178" y="142" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">5. Base material</text><path d="M 18 118 L 165 118 L 165 128 L 18 128 Z" fill="#f4e8c8" opacity="0.6"/><path d="M 18 118 L 165 118"/><text x="178" y="125" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">6. Bedding sand</text><path d="M 18 95 L 165 95 L 165 118 L 18 118 Z" fill="#a8a59a" opacity="0.5"/><path d="M 18 95 L 165 95"/><path d="M 42 95 L 42 118 M 70 95 L 70 118 M 100 95 L 100 118 M 130 95 L 130 118" stroke-width="0.8"/><path d="M 18 106 L 42 106 M 56 106 L 100 106 M 116 106 L 165 106" stroke-width="0.6"/><text x="178" y="110" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">7. Pavers</text><text x="178" y="92" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">8. Polymeric sand</text><line x1="172" y1="89" x2="100" y2="98" stroke-width="0.7"/></g></svg>`;

  const SVG_TURF = `<svg viewBox="0 0 280 220" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:auto;"><g fill="none" stroke="#353535" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M 18 188 L 165 188 L 168 192 L 18 192 Z" fill="#a89b7e" opacity="0.55"/><path d="M 18 188 L 165 188"/><path d="M 26 184 L 30 188 M 50 185 L 54 188 M 78 184 L 82 188 M 105 185 L 109 188 M 132 184 L 136 188 M 156 185 L 160 188" stroke-width="0.7"/><text x="178" y="192" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">Existing subgrade</text><path d="M 18 158 L 165 158 L 165 188 L 18 188 Z" fill="#bfb198" opacity="0.45"/><path d="M 18 158 L 165 158"/><circle cx="30" cy="170" r="2.3"/><circle cx="48" cy="175" r="1.9"/><circle cx="64" cy="168" r="2.2"/><circle cx="84" cy="174" r="2"/><circle cx="105" cy="170" r="2.5"/><circle cx="124" cy="175" r="1.8"/><circle cx="142" cy="168" r="2.1"/><circle cx="158" cy="174" r="1.9"/><circle cx="38" cy="180" r="1.6"/><circle cx="74" cy="182" r="2"/><circle cx="116" cy="180" r="1.8"/><circle cx="150" cy="183" r="1.7"/><text x="178" y="175" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">3" compacted base rock</text><path d="M 18 148 L 165 148 L 165 158 L 18 158 Z" fill="#3d3530" opacity="0.4"/><path d="M 18 148 L 165 148"/><path d="M 18 153 L 165 153" stroke-dasharray="3,2" stroke-width="0.6"/><text x="178" y="156" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">Weed barrier</text><path d="M 18 110 L 30 110 L 30 158 L 18 158 Z" fill="#8e8b85" opacity="0.5"/><path d="M 18 110 L 30 110 L 30 158"/><path d="M 22 118 L 26 122 M 22 130 L 26 134 M 22 142 L 26 146" stroke-width="0.6"/><text x="178" y="142" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">Edge restraint</text><line x1="172" y1="139" x2="36" y2="125" stroke-width="0.6"/><path d="M 30 138 L 165 138 L 165 148 L 30 148 Z" fill="#c8b896" opacity="0.5"/><path d="M 30 138 L 165 138"/><path d="M 38 142 L 42 144 M 56 142 L 60 144 M 76 142 L 80 144 M 96 142 L 100 144 M 116 142 L 120 144 M 136 142 L 140 144 M 156 142 L 160 144" stroke-width="0.6"/><text x="178" y="123" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">Infill</text><text x="178" y="135" font-family="Caveat, cursive" font-size="9" fill="#888" stroke="none">(anti-microbial)</text><line x1="172" y1="120" x2="100" y2="138" stroke-width="0.6"/><path d="M 30 110 L 165 110 L 165 138 L 30 138 Z"/><path d="M 30 110 L 165 110"/><path d="M 36 138 L 35 124 M 42 138 L 43 122 M 48 138 L 47 126 M 54 138 L 55 121 M 60 138 L 60 125 M 66 138 L 65 123 M 72 138 L 73 126 M 78 138 L 78 122 M 84 138 L 83 125 M 90 138 L 91 123 M 96 138 L 96 126 M 102 138 L 101 122 M 108 138 L 109 124 M 114 138 L 114 121 M 120 138 L 119 125 M 126 138 L 127 123 M 132 138 L 132 126 M 138 138 L 137 122 M 144 138 L 145 124 M 150 138 L 150 121 M 156 138 L 155 126 M 162 138 L 162 124" stroke-width="0.7"/><text x="178" y="105" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">Turf</text><line x1="172" y1="103" x2="100" y2="115" stroke-width="0.6"/></g></svg>`;

  const SVG_WALL = `<svg viewBox="0 0 280 220" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:auto;"><defs><pattern id="bpc-pat-soil" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#a89b7e" stroke-width="0.7" opacity="0.6"/></pattern></defs><g fill="none" stroke="#353535" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M 130 32 L 230 32 L 230 198 L 130 198 Z" fill="url(#bpc-pat-soil)" opacity="0.7"/><text x="200" y="50" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none" text-anchor="middle">Retained soil</text><path d="M 60 32 L 134 32 L 134 44 L 60 44 Z" fill="#bfb198" opacity="0.5"/><path d="M 60 32 L 134 32 L 134 44 L 60 44 Z"/><text x="38" y="38" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none" text-anchor="end">Wall cap</text><line x1="40" y1="36" x2="58" y2="38" stroke-width="0.6"/><g><path d="M 70 44 L 130 44 L 130 64 L 70 64 Z" fill="#bfb198" opacity="0.4"/><path d="M 70 44 L 130 44 L 130 64 L 70 64 Z"/><path d="M 70 64 L 130 64 L 130 84 L 70 84 Z"/><path d="M 70 84 L 130 84 L 130 104 L 70 104 Z"/><path d="M 70 104 L 130 104 L 130 124 L 70 124 Z"/><path d="M 70 124 L 130 124 L 130 144 L 70 144 Z"/><path d="M 70 144 L 130 144 L 130 164 L 70 164 Z"/><path d="M 100 44 L 100 64 M 85 64 L 85 84 M 115 64 L 115 84 M 100 84 L 100 104 M 85 104 L 85 124 M 115 104 L 115 124 M 100 124 L 100 144 M 85 144 L 85 164 M 115 144 L 115 164" stroke-width="0.5"/></g><text x="38" y="102" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none" text-anchor="end">Blocks</text><line x1="40" y1="100" x2="68" y2="100" stroke-width="0.6"/><path d="M 130 44 L 158 44 L 158 168 L 130 168 Z" fill="#d4cfb8" opacity="0.5"/><path d="M 130 44 L 158 44 L 158 168 L 130 168 Z"/><circle cx="138" cy="58" r="1.5"/><circle cx="148" cy="64" r="1.7"/><circle cx="142" cy="74" r="1.4"/><circle cx="152" cy="82" r="1.6"/><circle cx="138" cy="92" r="1.5"/><circle cx="148" cy="100" r="1.7"/><circle cx="142" cy="112" r="1.4"/><circle cx="152" cy="120" r="1.6"/><circle cx="138" cy="130" r="1.5"/><circle cx="148" cy="140" r="1.7"/><circle cx="142" cy="152" r="1.4"/><circle cx="152" cy="160" r="1.6"/><text x="38" y="125" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none" text-anchor="end">Wall rock</text><line x1="40" y1="123" x2="135" y2="118" stroke-width="0.6"/><path d="M 130 80 L 215 80" stroke-dasharray="3,2" stroke-width="0.8"/><path d="M 130 130 L 215 130" stroke-dasharray="3,2" stroke-width="0.8"/><text x="246" y="83" font-family="Caveat, cursive" font-size="10" fill="#353535" stroke="none">Reinforcement</text><text x="246" y="93" font-family="Caveat, cursive" font-size="10" fill="#353535" stroke="none">grid</text><path d="M 130 145 L 215 145" stroke-dasharray="3,2" stroke-width="0.8"/><line x1="130" y1="142" x2="130" y2="148"/><line x1="215" y1="142" x2="215" y2="148"/><text x="170" y="158" font-family="Caveat, cursive" font-size="10" fill="#353535" stroke="none" text-anchor="middle">Geo-grid length</text><path d="M 0 168 L 280 168 L 280 200 L 0 200 Z" fill="url(#bpc-pat-soil)" opacity="0.7"/><path d="M 0 168 L 280 168"/><circle cx="148" cy="180" r="5"/><circle cx="148" cy="180" r="2"/><text x="200" y="185" font-family="Caveat, cursive" font-size="11" fill="#353535" stroke="none">Toe drain</text><line x1="195" y1="183" x2="155" y2="181" stroke-width="0.6"/></g></svg>`;

  const INSTALL_KIND_COPY = {
    paver: {
      svg: SVG_PAVER,
      compare: [
        ['Geo-tech fabric',         '✕',     '✓'],
        ['Geo-grid (load support)', '✕',     '✓'],
        ['Two compacted base lifts', '~',    '✓'],
        ['Polymeric sand seal',     'Sand',  '✓'],
        ['ICPI certified install',  '✕',     '✓'],
        ['25-yr craftsmanship',     '—',     '✓'],
      ],
      badges: ['ICPI CERTIFIED', '25-YR WARRANTY', 'LIFETIME MATERIAL'],
    },
    turf: {
      svg: SVG_TURF,
      compare: [
        ['3" compacted base rock',  '~',     '✓'],
        ['Weed barrier',            '✕',     '✓'],
        ['Hard edge restraint',     'Stake', '✓'],
        ['Anti-microbial infill',   '✕',     '✓'],
        ['Proper drainage',         '✕',     '✓'],
      ],
      badges: ['25-YR WARRANTY', 'ANTI-MICROBIAL INFILL', 'PROPER DRAINAGE'],
    },
    wall: {
      svg: SVG_WALL,
      compare: [
        ['Toe drain',              '✕',  '✓'],
        ['Wall rock (drainage)',   '✕',  '✓'],
        ['Geo-grid into soil',     '✕',  '✓'],
        ['Reinforcement grid',     '✕',  '✓'],
        ['Engineered design',      '~',  '✓'],
        ['$1M insurance bond',     '✕',  '✓'],
      ],
      badges: ['ICPI CERTIFIED', '$1M INSURANCE BOND', 'PERMIT-READY'],
    },
  };

  function detectInstallKindFromTitle(title) {
    const t = (title || '').toLowerCase();
    if (/wall|retaining/.test(t)) return 'wall';
    if (/paver|porcelain/.test(t)) return 'paver';
    if (/turf|grass|sod|lawn/.test(t)) return 'turf';
    return null;
  }

  function makeTabLabel(title) {
    let t = String(title || '').replace(/&amp;/g, '&').trim();
    t = t.replace(/\s+(Installation|Construction|Assembly)\s*$/i, '');
    t = t.replace(/^Landscape & Hardscape\s+/i, '');
    return t;
  }

  function buildVisualHtml(kind) {
    const c = INSTALL_KIND_COPY[kind];
    if (!c) return '';
    const compareRowsHtml = c.compare.map(([label, lg, bp]) => {
      const lgClass = lg === '✕' ? 'bpc-cmp-x' : (lg === '✓' ? 'bpc-cmp-check' : 'bpc-cmp-meh');
      return `
        <div class="bpc-cmp-row">
          <span class="bpc-cmp-label">${escapeHtml(label)}</span>
          <span class="bpc-cmp-cell ${lgClass}">${escapeHtml(lg)}</span>
          <span class="bpc-cmp-cell bpc-cmp-check">${escapeHtml(bp)}</span>
        </div>
      `;
    }).join('');
    const badgesHtml = c.badges.map(b =>
      `<span class="bpc-install-badge">${escapeHtml(b)}</span>`
    ).join('');
    return `
      <div class="bpc-prep-svg">${c.svg}</div>
      <div class="bpc-prep-cmp">
        <div class="bpc-cmp-header">
          <span class="bpc-cmp-label-h"></span>
          <span class="bpc-cmp-cell-h">Local guy</span>
          <span class="bpc-cmp-cell-h bpc-cmp-cell-h--us">Paver Portal</span>
        </div>
        ${compareRowsHtml}
      </div>
      <div class="bpc-prep-badges">${badgesHtml}</div>
    `;
  }

  function enhanceCard(card, kind) {
    const titleEl = card.querySelector('.pub-prep-card-title');
    if (!titleEl) return false;

    const visual = document.createElement('div');
    visual.className = 'bpc-prep-visual';
    visual.innerHTML = buildVisualHtml(kind);

    const prose = document.createElement('div');
    prose.className = 'bpc-prep-prose';
    let next = titleEl.nextElementSibling;
    while (next) {
      const after = next.nextElementSibling;
      prose.appendChild(next);
      next = after;
    }

    const grid = document.createElement('div');
    grid.className = 'bpc-prep-grid';
    grid.appendChild(visual);
    grid.appendChild(prose);

    card.appendChild(grid);
    card.classList.add('bpc-prep-card--enhanced');
    return true;
  }

  function transformQualityStandards() {
    const railWrap = document.querySelector('.pub-prep-rail-wrap');
    if (!railWrap) return null;
    const rail = railWrap.querySelector('.pub-prep-rail');
    if (!rail) return null;
    const cards = Array.from(rail.querySelectorAll(':scope > .pub-prep-card'));
    if (cards.length === 0) return null;

    railWrap.querySelectorAll('.pub-prep-rail-arrow').forEach((b) => {
      b.style.display = 'none';
    });

    const tabs = cards.map((card, idx) => {
      const titleEl = card.querySelector('.pub-prep-card-title');
      const title = titleEl ? (titleEl.textContent || '').trim() : `Category ${idx + 1}`;
      const kind = detectInstallKindFromTitle(title);
      if (kind) enhanceCard(card, kind);
      return { card, title, label: makeTabLabel(title), kind, idx };
    });

    cards.forEach((c, i) => {
      if (i !== 0) c.classList.add('bpc-prep-card--hidden');
    });

    const tabBar = document.createElement('div');
    tabBar.className = 'bpc-prep-tabs';
    tabs.forEach(({ label, idx }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bpc-prep-tab' + (idx === 0 ? ' bpc-prep-tab--active' : '');
      btn.setAttribute('data-idx', String(idx));
      btn.textContent = label;
      tabBar.appendChild(btn);
    });
    railWrap.parentNode.insertBefore(tabBar, railWrap);

    const nav = document.createElement('div');
    nav.className = 'bpc-prep-nav';
    nav.innerHTML = `
      <button type="button" class="bpc-prep-nav-btn bpc-prep-nav-btn--prev" aria-label="Previous category">‹ Prev</button>
      <div class="bpc-prep-nav-dots">${tabs.map((_, i) =>
        `<button type="button" class="bpc-prep-nav-dot${i === 0 ? ' bpc-prep-nav-dot--active' : ''}" data-idx="${i}" aria-label="Category ${i + 1}"></button>`
      ).join('')}</div>
      <button type="button" class="bpc-prep-nav-btn bpc-prep-nav-btn--next" aria-label="Next category">Next ›</button>
    `;
    if (railWrap.nextSibling) {
      railWrap.parentNode.insertBefore(nav, railWrap.nextSibling);
    } else {
      railWrap.parentNode.appendChild(nav);
    }

    let currentIdx = 0;
    function selectTab(newIdx) {
      const clamped = Math.max(0, Math.min(tabs.length - 1, newIdx));
      if (clamped === currentIdx) return;
      currentIdx = clamped;
      cards.forEach((c, i) => c.classList.toggle('bpc-prep-card--hidden', i !== currentIdx));
      tabBar.querySelectorAll('.bpc-prep-tab').forEach((b, i) =>
        b.classList.toggle('bpc-prep-tab--active', i === currentIdx));
      nav.querySelectorAll('.bpc-prep-nav-dot').forEach((d, i) =>
        d.classList.toggle('bpc-prep-nav-dot--active', i === currentIdx));
      const activeBtn = tabBar.querySelectorAll('.bpc-prep-tab')[currentIdx];
      if (activeBtn) activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }

    tabBar.querySelectorAll('.bpc-prep-tab').forEach((b) => {
      b.addEventListener('click', () => selectTab(parseInt(b.getAttribute('data-idx'), 10)));
    });
    nav.querySelector('.bpc-prep-nav-btn--prev').addEventListener('click', () => selectTab(currentIdx - 1));
    nav.querySelector('.bpc-prep-nav-btn--next').addEventListener('click', () => selectTab(currentIdx + 1));
    nav.querySelectorAll('.bpc-prep-nav-dot').forEach((d) => {
      d.addEventListener('click', () => selectTab(parseInt(d.getAttribute('data-idx'), 10)));
    });

    return { selectTab, tabs };
  }

  const STYLES = `
    .bpc-twocol {
      display: grid;
      grid-template-columns: minmax(0, 1.7fr) minmax(300px, 380px);
      gap: 28px;
      align-items: start;
      margin: 12px 0 24px;
    }
    @media (max-width: 900px) {
      .bpc-twocol { grid-template-columns: 1fr; gap: 20px; }
      .bpc-detail-card { position: static !important; }
    }
    .bpc-twocol-left, .bpc-twocol-right { min-width: 0; }

    .bpc-detail-card {
      position: sticky;
      top: 16px;
      background: #ffffff;
      border: 1px solid #e7e3d6;
      border-radius: 10px;
      padding: 22px 22px 16px;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 1px 3px rgba(53, 53, 53, 0.04);
      max-height: calc(100vh - 32px);
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .bpc-detail-card-body { flex: 1; }

    .bpc-card-eyebrow {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.14em;
      color: #9c7440;
      text-transform: uppercase;
      margin: 0 0 6px;
    }
    .bpc-card-title {
      font-size: 21px;
      font-weight: 700;
      color: #353535;
      line-height: 1.2;
      margin: 0 0 4px;
    }
    .bpc-card-meta {
      font-size: 13px;
      color: #777;
      margin: 0 0 16px;
    }
    .bpc-card-prompt {
      font-size: 13px;
      color: #58595b;
      line-height: 1.5;
      margin: 8px 0 14px;
    }

    .bpc-card-back {
      background: transparent;
      border: none;
      color: #9c7440;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      cursor: pointer;
      padding: 0;
      margin: 0 0 12px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .bpc-card-back:hover { color: #7d5c31; }

    .bpc-overview-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .bpc-overview-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid #efece4;
      background: #fff;
      font-family: inherit;
      font-size: inherit;
      color: inherit;
      width: 100%;
      text-align: left;
      transition: background 0.15s, border-color 0.15s;
    }
    .bpc-overview-row:hover {
      background: #faf8f3;
      border-color: #d8d2bf;
    }
    .bpc-overview-dot {
      width: 12px; height: 12px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .bpc-overview-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .bpc-overview-name {
      font-weight: 600;
      font-size: 14px;
      color: #353535;
      line-height: 1.2;
    }
    .bpc-overview-meta {
      font-size: 12px;
      color: #888;
      margin-top: 2px;
    }
    .bpc-overview-arrow { color: #aaa; font-size: 14px; flex-shrink: 0; }

    .bpc-detail-mats {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin: 14px 0;
    }
    .bpc-detail-mat {
      display: flex;
      gap: 12px;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid #efece4;
      background: #fdfcf8;
      align-items: center;
    }
    .bpc-detail-mat--pending {
      border-color: #9c7440;
      background: #f0f4f1;
      border-width: 2px;
    }
    .bpc-detail-mat-thumb {
      width: 56px; height: 56px;
      object-fit: cover;
      border-radius: 6px;
      flex-shrink: 0;
      background: #f4f1e8;
      border: 1px solid #eae6d6;
    }
    .bpc-detail-mat-body { flex: 1; min-width: 0; }
    .bpc-detail-mat-type {
      font-size: 10px;
      letter-spacing: 0.1em;
      font-weight: 700;
      color: #999;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .bpc-detail-mat-name {
      font-weight: 600;
      font-size: 14px;
      color: #353535;
      line-height: 1.2;
    }
    .bpc-detail-mat-color {
      font-size: 12px;
      color: #777;
      margin-top: 2px;
    }
    .bpc-detail-mat-pending-arrow {
      color: #9c7440;
      font-size: 12px;
      font-weight: 700;
      margin-top: 4px;
    }
    .bpc-detail-mat-pending-name {
      font-weight: 700;
      font-size: 13px;
      color: #9c7440;
      line-height: 1.2;
    }
    .bpc-detail-mat-actions {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex-shrink: 0;
    }
    .bpc-swap-btn {
      background: #9c7440;
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 6px 12px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
    }
    .bpc-swap-btn:hover { background: #7d5c31; }
    .bpc-swap-btn--undo {
      background: transparent;
      color: #9c7440;
      border: 1px solid #9c7440;
      font-size: 11px;
      padding: 4px 10px;
    }
    .bpc-swap-btn--undo:hover { background: #f0f4f1; }

    .bpc-detail-empty {
      padding: 16px 0;
      font-size: 13px;
      color: #999;
      text-align: center;
    }

    .bpc-card-section-link {
      display: block;
      text-align: center;
      width: 100%;
      padding: 12px 16px;
      margin-top: 14px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      color: #9c7440;
      background: #fff;
      border: 1.5px solid #9c7440;
      border-radius: 6px;
      cursor: pointer;
      letter-spacing: 0.02em;
      transition: background 0.15s, color 0.15s;
    }
    .bpc-card-section-link:hover { background: #9c7440; color: #fff; }

    .bpc-tray {
      flex-shrink: 0;
      margin: 16px -22px -16px;
      padding: 14px 22px;
      background: #f4f4ef;
      border-top: 1px solid #e7e3d6;
      border-radius: 0 0 10px 10px;
    }
    .bpc-tray-count {
      font-size: 12px;
      font-weight: 600;
      color: #9c7440;
      letter-spacing: 0.04em;
      margin-bottom: 6px;
    }
    .bpc-tray-cta {
      width: 100%;
      background: #9c7440;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 12px 16px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .bpc-tray-cta:hover { background: #7d5c31; }
    .bpc-tray-cta:disabled { background: #a8b5ac; cursor: not-allowed; }

    .bpc-modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(53, 53, 53, 0.4);
      display: flex; align-items: center; justify-content: center;
      z-index: 2000;
      animation: bpcFadeIn 0.18s ease;
    }
    @keyframes bpcFadeIn { from { opacity: 0; } to { opacity: 1; } }
    .bpc-modal {
      background: #fff;
      border-radius: 12px;
      width: 540px; max-width: 92vw;
      max-height: 88vh;
      display: flex; flex-direction: column;
      overflow: hidden;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      animation: bpcModalIn 0.22s ease;
    }
    @keyframes bpcModalIn { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .bpc-modal-header {
      padding: 20px 24px;
      border-bottom: 1px solid #efece4;
      display: flex; align-items: center; justify-content: space-between;
    }
    .bpc-modal-title { margin: 0; font-size: 18px; font-weight: 700; color: #353535; }
    .bpc-modal-close {
      background: transparent; border: none; cursor: pointer;
      width: 28px; height: 28px;
      font-size: 20px; color: #888;
      border-radius: 4px;
    }
    .bpc-modal-close:hover { background: #f4f4ef; color: #353535; }
    .bpc-modal-body { padding: 20px 24px; overflow-y: auto; flex: 1; }
    .bpc-modal-footer {
      padding: 14px 24px;
      border-top: 1px solid #efece4;
      background: #faf8f3;
      display: flex; justify-content: flex-end; gap: 10px;
    }

    .bpc-cand-current {
      background: #fdfcf8;
      border: 1px solid #efece4;
      border-radius: 8px;
      padding: 12px;
      display: flex; gap: 12px; align-items: center;
      margin-bottom: 18px;
    }
    .bpc-cand-current-thumb {
      width: 50px; height: 50px;
      border-radius: 6px;
      object-fit: cover;
      flex-shrink: 0;
      background: #f4f1e8; border: 1px solid #eae6d6;
    }
    .bpc-cand-current-text { flex: 1; min-width: 0; }
    .bpc-cand-current-label {
      font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
      color: #999; font-weight: 700; margin-bottom: 2px;
    }
    .bpc-cand-current-name { font-size: 14px; font-weight: 600; color: #353535; }
    .bpc-cand-current-color { font-size: 12px; color: #777; }

    .bpc-cand-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 10px;
    }
    .bpc-cand {
      border: 1.5px solid #efece4;
      border-radius: 8px;
      padding: 8px;
      cursor: pointer;
      background: #fff;
      text-align: left;
      font-family: inherit;
      transition: border-color 0.15s, transform 0.05s;
    }
    .bpc-cand:hover { border-color: #9c7440; transform: translateY(-1px); }
    .bpc-cand--selected { border-color: #9c7440; background: #f0f4f1; }
    .bpc-cand--current { opacity: 0.4; pointer-events: none; }
    .bpc-cand-thumb {
      width: 100%; aspect-ratio: 1;
      object-fit: cover;
      border-radius: 4px;
      background: #f4f1e8;
      margin-bottom: 6px;
    }
    .bpc-cand-thumb-empty {
      width: 100%; aspect-ratio: 1;
      background: linear-gradient(135deg, #f4f1e8, #eae6d6);
      border-radius: 4px;
      margin-bottom: 6px;
    }
    .bpc-cand-name {
      font-size: 12px; font-weight: 600; color: #353535;
      line-height: 1.2;
      overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .bpc-cand-color { font-size: 11px; color: #888; margin-top: 2px; }
    .bpc-cand-current-pill {
      display: inline-block;
      background: #9c7440; color: #fff;
      font-size: 9px; font-weight: 700;
      padding: 2px 6px; border-radius: 8px;
      letter-spacing: 0.05em;
      margin-top: 4px;
    }

    .bpc-modal-textarea {
      width: 100%;
      padding: 12px;
      border: 1px solid #d4d0c2;
      border-radius: 6px;
      font-family: inherit;
      font-size: 14px;
      resize: vertical;
      min-height: 80px;
      box-sizing: border-box;
    }
    .bpc-modal-textarea:focus {
      outline: none;
      border-color: #9c7440;
      box-shadow: 0 0 0 3px rgba(93, 126, 105, 0.16);
    }

    .bpc-btn {
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      padding: 10px 20px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      transition: background 0.15s;
    }
    .bpc-btn--primary { background: #9c7440; color: #fff; }
    .bpc-btn--primary:hover { background: #7d5c31; }
    .bpc-btn--primary:disabled { background: #a8b5ac; cursor: not-allowed; }
    .bpc-btn--ghost { background: transparent; color: #353535; border: 1px solid #d4d0c2; }
    .bpc-btn--ghost:hover { background: #f4f4ef; }

    .bpc-summary-list {
      list-style: none;
      padding: 0;
      margin: 0 0 16px;
    }
    .bpc-summary-item {
      padding: 10px 0;
      border-bottom: 1px solid #efece4;
      font-size: 13px;
      color: #353535;
      line-height: 1.5;
    }
    .bpc-summary-item:last-child { border-bottom: none; }
    .bpc-summary-region {
      font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
      color: #9c7440; font-weight: 700; margin-bottom: 2px;
    }
    .bpc-summary-from { color: #999; text-decoration: line-through; }
    .bpc-summary-arrow { color: #9c7440; margin: 0 6px; }

    .bpc-success {
      text-align: center;
      padding: 24px 12px;
    }
    .bpc-success-icon {
      width: 48px; height: 48px;
      border-radius: 50%;
      background: #9c7440;
      color: #fff;
      font-size: 24px;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 12px;
    }
    .bpc-success h3 { margin: 0 0 6px; font-size: 18px; color: #353535; }
    .bpc-success p { margin: 0 0 18px; color: #58595b; font-size: 13px; line-height: 1.5; }

    .pub-site-plan-materials.bpc-hidden { display: none !important; }
    .pub-region-legend.bpc-tight {
      margin-top: 4px !important;
      padding-top: 16px !important;
    }

    body .pub-scope-item {
      padding: 36px 0;
    }
    body .pub-scope-item:first-child {
      padding-top: 4px;
    }
    body .pub-scope-item-header {
      margin-bottom: 16px;
    }
    body .pub-scope-item-name {
      font-size: 22px;
      letter-spacing: -0.012em;
    }
    body .pub-scope-item-amount {
      font-size: 19px;
    }
    body .pub-line-item {
      padding: 12px 0;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 10px;
    }
    body .pub-line-item:first-child {
      padding-top: 2px;
    }
    body .pub-line-item-type {
      display: inline-block;
      flex-shrink: 0;
      margin-bottom: 0;
      padding: 2px 8px;
      background: #f1e7d3;
      color: #7d5c31;
      font-size: 9.5px;
      letter-spacing: 0.16em;
      border-radius: 3px;
      font-weight: 700;
      line-height: 1.5;
      align-self: center;
    }
    body .pub-line-item-body {
      flex: 1;
      min-width: 200px;
      font-size: 14.5px;
      line-height: 1.5;
      max-width: 78ch;
    }
    body .pub-scope-total {
      margin-top: 8px;
      padding: 28px 0 12px;
    }
    body .pub-scope-total-amount {
      font-size: 28px;
    }

    .bpc-bid-reader {
      display: grid;
      grid-template-columns: minmax(0, 280px) minmax(0, 1fr);
      gap: 0;
      border: 1px solid #e7e3d6;
      border-radius: 12px;
      background: #fff;
      margin: 24px 0;
      overflow: hidden;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    @media (max-width: 760px) {
      .bpc-bid-reader { grid-template-columns: 1fr; }
      .bpc-bid-reader-list { border-right: none !important; border-bottom: 1px solid #e7e3d6; max-height: 360px; }
    }
    .bpc-bid-reader-list {
      border-right: 1px solid #e7e3d6;
      background: #faf8f3;
      max-height: 720px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .bpc-bid-reader-total-card {
      padding: 18px 20px 16px;
      border-bottom: 1px solid #e7e3d6;
      background: #fff;
    }
    .bpc-bid-total-eyebrow {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.16em;
      color: #9c7440;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .bpc-bid-total-amount {
      font-size: 26px;
      font-weight: 700;
      color: #353535;
      letter-spacing: -0.02em;
      line-height: 1.05;
    }
    .bpc-bid-total-meta {
      font-size: 12px;
      color: #888;
      margin-top: 4px;
    }
    .bpc-bid-total-breakdown {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px dashed #e7e3d6;
      font-size: 12px;
      color: #58595b;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .bpc-bid-total-breakdown-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    .bpc-bid-total-breakdown-row span:last-child {
      color: #353535;
      font-weight: 500;
    }
    .bpc-bid-total-breakdown-row--credit span:last-child {
      color: #9c7440;
    }

    .bpc-bid-reader-rows {
      flex: 1;
      padding: 6px 0;
      overflow-y: auto;
    }
    .bpc-bid-reader-row {
      display: block;
      width: 100%;
      text-align: left;
      background: transparent;
      border: none;
      border-left: 3px solid transparent;
      padding: 11px 16px 11px 13px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.12s, border-color 0.12s;
    }
    .bpc-bid-reader-row:hover {
      background: #f4f1e8;
    }
    .bpc-bid-reader-row.bpc-active {
      background: #fff;
      border-left-color: #9c7440;
    }
    .bpc-bid-reader-row-eyebrow {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.1em;
      color: #999;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .bpc-bid-reader-row.bpc-active .bpc-bid-reader-row-eyebrow {
      color: #9c7440;
    }
    .bpc-bid-reader-row-name {
      font-size: 13.5px;
      font-weight: 500;
      color: #353535;
      line-height: 1.3;
      margin-bottom: 2px;
    }
    .bpc-bid-reader-row-amount {
      font-size: 12px;
      font-weight: 500;
      color: #58595b;
      font-variant-numeric: tabular-nums;
    }

    .bpc-bid-reader-pane {
      padding: 28px 32px;
      overflow-y: auto;
      max-height: 720px;
    }
    @media (max-width: 760px) {
      .bpc-bid-reader-pane { padding: 22px 18px; max-height: none; }
    }
    .bpc-bid-reader-pane > .pub-scope-item {
      padding: 0 !important;
      border-top: none !important;
    }
    .bpc-bid-reader-pane > .pub-scope-item.bpc-hidden-section {
      display: none !important;
    }
    .bpc-bid-reader-empty {
      padding: 24px 0;
      text-align: center;
      color: #999;
      font-size: 13px;
    }

    /* ─── Quality Standards: tab stage (B2-r7) ─── */

    body .pub-prep-rail-wrap { padding: 0 !important; }
    body .pub-prep-rail {
      display: block !important;
      overflow: visible !important;
      grid-auto-flow: row !important;
      grid-template-columns: none !important;
      scroll-snap-type: none !important;
      gap: 0 !important;
      padding: 0 !important;
    }
    body .pub-prep-card {
      min-width: 0 !important;
      flex-shrink: 1 !important;
      max-width: none !important;
      width: 100% !important;
      scroll-snap-align: none !important;
    }
    .bpc-prep-card--hidden { display: none !important; }

    .bpc-prep-tabs {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      white-space: nowrap;
      padding: 4px 4px 14px;
      margin: 8px 0 0;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
    }
    .bpc-prep-tabs::-webkit-scrollbar { display: none; }
    .bpc-prep-tab {
      padding: 9px 16px;
      border: 1px solid #d8d2bf;
      background: #fff;
      color: #58595b;
      border-radius: 999px;
      font-family: 'Onest', -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }
    .bpc-prep-tab:hover { background: #f4f1e8; }
    .bpc-prep-tab--active {
      background: #9c7440;
      color: #fff;
      border-color: #9c7440;
    }
    .bpc-prep-tab--active:hover { background: #7d5c31; }

    .bpc-prep-grid {
      display: grid;
      grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.1fr);
      gap: 26px;
      margin-top: 16px;
      align-items: start;
    }
    @media (max-width: 900px) {
      .bpc-prep-grid {
        grid-template-columns: 1fr;
        gap: 20px;
      }
    }
    .bpc-prep-visual {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .bpc-prep-svg {
      background: #faf8f3;
      border: 1px solid #efece4;
      border-radius: 8px;
      padding: 12px;
    }
    .bpc-prep-cmp {
      background: #fff;
      border: 1px solid #efece4;
      border-radius: 8px;
      padding: 12px 14px;
    }
    .bpc-prep-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .bpc-install-badge {
      background: #f1e7d3;
      color: #7d5c31;
      font-size: 10px;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 4px;
      letter-spacing: 0.06em;
    }
    .bpc-prep-prose {
      min-width: 0;
    }

    .bpc-cmp-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 56px 56px;
      gap: 6px;
      padding: 0 0 6px;
      border-bottom: 1px solid #d8d2bf;
      margin-bottom: 4px;
    }
    .bpc-cmp-label-h, .bpc-cmp-cell-h {
      font-size: 9.5px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-weight: 700;
      color: #999;
      text-align: center;
    }
    .bpc-cmp-label-h { text-align: left; }
    .bpc-cmp-cell-h--us { color: #9c7440; }
    .bpc-cmp-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 56px 56px;
      gap: 6px;
      padding: 7px 0;
      border-bottom: 1px solid #efece4;
      align-items: center;
    }
    .bpc-cmp-row:last-child { border-bottom: none; }
    .bpc-cmp-label {
      font-size: 12.5px;
      color: #353535;
    }
    .bpc-cmp-cell {
      font-size: 13px;
      text-align: center;
      font-weight: 600;
    }
    .bpc-cmp-x { color: #b85450; }
    .bpc-cmp-meh { color: #999; font-size: 11px; font-weight: 500; }
    .bpc-cmp-check { color: #9c7440; font-weight: 700; }

    .bpc-prep-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 18px 0 4px;
      max-width: 720px;
      margin: 0 auto;
    }
    .bpc-prep-nav-btn {
      background: transparent;
      border: 1px solid #d8d2bf;
      color: #58595b;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
      padding: 8px 14px;
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    .bpc-prep-nav-btn:hover { background: #f4f1e8; border-color: #9c7440; color: #9c7440; }
    .bpc-prep-nav-dots {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .bpc-prep-nav-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      border: none;
      background: #d8d2bf;
      cursor: pointer;
      padding: 0;
      transition: background 0.12s, transform 0.12s;
    }
    .bpc-prep-nav-dot:hover { background: #a8b5ac; }
    .bpc-prep-nav-dot--active {
      background: #9c7440;
      transform: scale(1.3);
    }
  `;

  function injectStyles() {
    if (document.getElementById('bpc-twocol-styles')) return;
    const el = document.createElement('style');
    el.id = 'bpc-twocol-styles';
    el.textContent = STYLES;
    document.head.appendChild(el);
  }

  function renderOverview(card, regions, regionMap) {
    const matNames = new Set();
    regions.forEach(r => (regionMap.get(r.id) || []).forEach(m => matNames.add(m.name)));

    const customizableNote = customize.enabled
      ? '<p class="bpc-card-prompt" style="background:#f0f4f1;border-left:3px solid #9c7440;padding:10px 12px;border-radius:4px;"><strong style="color:#9c7440;">You can customize this proposal.</strong> Tap any section below or any colored area on the plan to swap materials. We\'ll let your designer know.</p>'
      : '<p class="bpc-card-prompt">Tap any highlighted area on the plan to see what\'s planned for that section, or pick from the list below.</p>';

    card.innerHTML = `
      <div class="bpc-detail-card-body">
        <div class="bpc-card-eyebrow">Your project</div>
        <div class="bpc-card-title">${regions.length} section${regions.length === 1 ? '' : 's'}, ${matNames.size} material${matNames.size === 1 ? '' : 's'}</div>
        ${customizableNote}
        <div class="bpc-overview-list">
          ${regions.map(r => `
            <button type="button" class="bpc-overview-row" data-region-id="${escapeHtml(r.id)}">
              <span class="bpc-overview-dot" style="background:${escapeHtml(r.color)};"></span>
              <span class="bpc-overview-text">
                <span class="bpc-overview-name">${escapeHtml(r.name)}</span>
                ${r.meta ? `<span class="bpc-overview-meta">${escapeHtml(r.meta)}</span>` : ''}
              </span>
              <span class="bpc-overview-arrow">→</span>
            </button>
          `).join('')}
        </div>
      </div>
      ${renderTrayHtml()}
    `;
    card.querySelectorAll('.bpc-overview-row').forEach((row) => {
      row.addEventListener('click', () => {
        const rid = row.getAttribute('data-region-id');
        renderRegionDetail(card, rid, regions, regionMap);
      });
    });
    wireTrayClicks(card);
  }

  function renderRegionDetail(card, regionId, regions, regionMap) {
    const region = regions.find(r => r.id === regionId);
    if (!region) return;
    const mats = regionMap.get(regionId) || [];

    const matsHtml = mats.length === 0
      ? `<div class="bpc-detail-empty">No customizable materials assigned to this section yet.</div>`
      : mats.map((m, idx) => renderMaterialRowHtml(regionId, m, idx)).join('');

    card.innerHTML = `
      <div class="bpc-detail-card-body">
        <button type="button" class="bpc-card-back">← Overview</button>
        <div class="bpc-card-eyebrow" style="color:${escapeHtml(region.color)};">Section</div>
        <div class="bpc-card-title">${escapeHtml(region.name)}</div>
        ${region.meta ? `<div class="bpc-card-meta">${escapeHtml(region.meta)}</div>` : ''}
        <div class="bpc-detail-mats">${matsHtml}</div>
        ${region.sectionHref ? `<button type="button" class="bpc-card-section-link" data-href="${escapeHtml(region.sectionHref)}">See detailed section bid →</button>` : ''}
      </div>
      ${renderTrayHtml()}
    `;
    card.querySelector('.bpc-card-back').addEventListener('click', () => {
      renderOverview(card, regions, regionMap);
    });
    const sectionBtn = card.querySelector('.bpc-card-section-link');
    if (sectionBtn) {
      sectionBtn.addEventListener('click', () => navigateToSection(sectionBtn.getAttribute('data-href')));
    }
    wireMaterialRowClicks(card, regionId, regions, regionMap);
    wireTrayClicks(card);
  }

  function renderMaterialRowHtml(regionId, m, idx) {
    const apiMat = customize.enabled ? findApiMaterial(regionId, m) : null;
    const pending = apiMat ? customize.pending.get(apiMat.id) : null;

    const thumbHtml = m.imgSrc
      ? `<img class="bpc-detail-mat-thumb" src="${escapeHtml(m.imgSrc)}" alt="">`
      : `<div class="bpc-detail-mat-thumb"></div>`;

    let rightHtml = '';
    if (customize.enabled && apiMat) {
      if (pending) {
        rightHtml = `
          <div class="bpc-detail-mat-actions">
            <button type="button" class="bpc-swap-btn bpc-swap-btn--undo" data-undo-region-material-id="${escapeHtml(apiMat.id)}">Undo</button>
            <button type="button" class="bpc-swap-btn" data-region-material-id="${escapeHtml(apiMat.id)}" data-region-id="${escapeHtml(regionId)}" data-mat-idx="${idx}">Change</button>
          </div>
        `;
      } else {
        rightHtml = `
          <div class="bpc-detail-mat-actions">
            <button type="button" class="bpc-swap-btn" data-region-material-id="${escapeHtml(apiMat.id)}" data-region-id="${escapeHtml(regionId)}" data-mat-idx="${idx}">Swap →</button>
          </div>
        `;
      }
    }

    let bodyHtml = `
      ${m.type  ? `<div class="bpc-detail-mat-type">${escapeHtml(m.type)}</div>`   : ''}
      <div class="bpc-detail-mat-name">${escapeHtml(m.name)}</div>
      ${m.color ? `<div class="bpc-detail-mat-color">${escapeHtml(m.color)}</div>` : ''}
    `;
    if (pending) {
      const replacementName = pending.replacement_material.product_name +
        (pending.replacement_material.color ? ' / ' + pending.replacement_material.color : '');
      bodyHtml += `
        <div class="bpc-detail-mat-pending-arrow">↓ swapping to</div>
        <div class="bpc-detail-mat-pending-name">${escapeHtml(replacementName)}</div>
      `;
    }

    return `
      <div class="bpc-detail-mat${pending ? ' bpc-detail-mat--pending' : ''}">
        ${thumbHtml}
        <div class="bpc-detail-mat-body">${bodyHtml}</div>
        ${rightHtml}
      </div>
    `;
  }

  function wireMaterialRowClicks(card, regionId, regions, regionMap) {
    card.querySelectorAll('button.bpc-swap-btn[data-region-material-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rmId = btn.getAttribute('data-region-material-id');
        openSwapModal(rmId, () => renderRegionDetail(card, regionId, regions, regionMap));
      });
    });
    card.querySelectorAll('button.bpc-swap-btn--undo').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rmId = btn.getAttribute('data-undo-region-material-id');
        customize.pending.delete(rmId);
        renderRegionDetail(card, regionId, regions, regionMap);
      });
    });
  }

  function renderTrayHtml() {
    if (!customize.enabled) return '';
    const count = customize.pending.size;
    if (count === 0) return '';
    return `
      <div class="bpc-tray">
        <div class="bpc-tray-count">${count} pending change${count === 1 ? '' : 's'}</div>
        <button type="button" class="bpc-tray-cta">Save & notify designer</button>
      </div>
    `;
  }
  function wireTrayClicks(card) {
    const cta = card.querySelector('.bpc-tray-cta');
    if (cta) cta.addEventListener('click', () => openSubmitModal(card));
  }

  function openSwapModal(rmId, onAfter) {
    const rm = customize.data.region_materials.find((r) => r.id === rmId);
    if (!rm) return;
    const category = rm.current.category;
    const candidates = (customize.data.swap_candidates_by_category[category] || []);

    const currentMatId = rm.current.material_id;
    const candHtml = candidates.length === 0
      ? `<div class="bpc-detail-empty">No alternatives available in the catalog yet for this category.</div>`
      : `<div class="bpc-cand-grid">` + candidates.map((c) => {
          const isCurrent = c.id === currentMatId;
          const thumb = c.swatch_url
            ? `<img class="bpc-cand-thumb" src="${escapeHtml(c.swatch_url)}" alt="">`
            : `<div class="bpc-cand-thumb-empty"></div>`;
          return `
            <button type="button" class="bpc-cand${isCurrent ? ' bpc-cand--current' : ''}" data-mat-id="${escapeHtml(c.id)}">
              ${thumb}
              <div class="bpc-cand-name">${escapeHtml(c.product_name || 'Material')}</div>
              ${c.color ? `<div class="bpc-cand-color">${escapeHtml(c.color)}</div>` : ''}
              ${isCurrent ? `<div class="bpc-cand-current-pill">Current</div>` : ''}
            </button>
          `;
        }).join('') + `</div>`;

    const currentName = (rm.current.product_name || 'Material') + (rm.current.color ? ' / ' + rm.current.color : '');
    const currentThumb = rm.current.swatch_url
      ? `<img class="bpc-cand-current-thumb" src="${escapeHtml(rm.current.swatch_url)}" alt="">`
      : `<div class="bpc-cand-current-thumb"></div>`;

    const modal = buildModal({
      title: 'Swap material in ' + (rm.region_name || 'this section'),
      bodyHtml: `
        <div class="bpc-cand-current">
          ${currentThumb}
          <div class="bpc-cand-current-text">
            <div class="bpc-cand-current-label">Currently</div>
            <div class="bpc-cand-current-name">${escapeHtml(currentName)}</div>
            ${rm.current.manufacturer ? `<div class="bpc-cand-current-color">${escapeHtml(rm.current.manufacturer)}</div>` : ''}
          </div>
        </div>
        <div style="font-size:13px;color:#58595b;margin-bottom:10px;">Choose an alternative:</div>
        ${candHtml}
      `,
      footerHtml: `
        <button type="button" class="bpc-btn bpc-btn--ghost" data-action="cancel">Cancel</button>
        <button type="button" class="bpc-btn bpc-btn--primary" data-action="confirm" disabled>Confirm swap</button>
      `,
    });

    let selectedId = null;
    modal.querySelectorAll('.bpc-cand:not(.bpc-cand--current)').forEach((b) => {
      b.addEventListener('click', () => {
        modal.querySelectorAll('.bpc-cand').forEach((c) => c.classList.remove('bpc-cand--selected'));
        b.classList.add('bpc-cand--selected');
        selectedId = b.getAttribute('data-mat-id');
        modal.querySelector('[data-action="confirm"]').disabled = false;
      });
    });
    modal.querySelector('[data-action="cancel"]').addEventListener('click', closeModal);
    modal.querySelector('[data-action="confirm"]').addEventListener('click', () => {
      if (!selectedId) return;
      const replacementMat = candidates.find((c) => c.id === selectedId);
      customize.pending.set(rmId, {
        replacement_material_id: selectedId,
        replacement_material: replacementMat,
        original: rm.current,
      });
      closeModal();
      onAfter && onAfter();
    });
  }

  function openSubmitModal(card) {
    const items = Array.from(customize.pending.entries()).map(([rmId, p]) => {
      const rm = customize.data.region_materials.find((r) => r.id === rmId);
      return { rm, p };
    });

    const summaryHtml = items.map(({ rm, p }) => {
      const fromLabel = (rm.current.product_name || 'Material') + (rm.current.color ? ' / ' + rm.current.color : '');
      const toLabel = (p.replacement_material.product_name || 'Material') + (p.replacement_material.color ? ' / ' + p.replacement_material.color : '');
      return `
        <li class="bpc-summary-item">
          <div class="bpc-summary-region">${escapeHtml(rm.region_name)}</div>
          <span class="bpc-summary-from">${escapeHtml(fromLabel)}</span>
          <span class="bpc-summary-arrow">→</span>
          <strong>${escapeHtml(toLabel)}</strong>
        </li>
      `;
    }).join('');

    const modal = buildModal({
      title: 'Send these changes to your designer?',
      bodyHtml: `
        <ul class="bpc-summary-list">${summaryHtml}</ul>
        <label style="display:block;font-size:12px;font-weight:600;color:#9c7440;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px;">Add a note (optional)</label>
        <textarea class="bpc-modal-textarea" placeholder="Anything you want your designer to know about these choices?"></textarea>
        <p style="font-size:12px;color:#999;line-height:1.5;margin-top:12px;">Your designer will review these choices, update pricing if needed, and get back to you.</p>
      `,
      footerHtml: `
        <button type="button" class="bpc-btn bpc-btn--ghost" data-action="cancel">Keep editing</button>
        <button type="button" class="bpc-btn bpc-btn--primary" data-action="submit">Send to designer</button>
      `,
    });

    modal.querySelector('[data-action="cancel"]').addEventListener('click', closeModal);
    modal.querySelector('[data-action="submit"]').addEventListener('click', async () => {
      const note = modal.querySelector('.bpc-modal-textarea').value.trim();
      const submitBtn = modal.querySelector('[data-action="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      const slug = getSlugFromPath();
      const token = getAuthToken();
      try {
        const r = await fetch(API_SUBMIT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({
            slug,
            homeowner_note: note || null,
            items: items.map(({ rm, p }) => ({
              proposal_region_material_id: rm.id,
              replacement_material_id: p.replacement_material_id,
            })),
          }),
        });
        const result = await r.json().catch(() => ({}));
        if (!r.ok) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send to designer';
          alert('Could not send: ' + (result.error || ('HTTP ' + r.status)));
          return;
        }
        customize.submitted = true;
        showSuccessState(modal, items.length, result.email_sent);
        customize.pending.clear();
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send to designer';
        alert('Network error: ' + (err && err.message));
      }
    });
  }

  function showSuccessState(modal, itemCount, emailSent) {
    const body = modal.querySelector('.bpc-modal-body');
    const footer = modal.querySelector('.bpc-modal-footer');
    body.innerHTML = `
      <div class="bpc-success">
        <div class="bpc-success-icon">✓</div>
        <h3>Sent to your designer</h3>
        <p>
          ${itemCount} change${itemCount === 1 ? '' : 's'} submitted${emailSent ? ' and your designer has been emailed.' : '.'}
          They\'ll review and reach out with any pricing updates.
        </p>
      </div>
    `;
    footer.innerHTML = `<button type="button" class="bpc-btn bpc-btn--primary" data-action="done">Done</button>`;
    footer.querySelector('[data-action="done"]').addEventListener('click', () => {
      closeModal();
      const card = document.querySelector('.bpc-detail-card');
      if (card && customize._lastRender) customize._lastRender();
    });
  }

  let activeModal = null;
  function buildModal({ title, bodyHtml, footerHtml }) {
    closeModal();
    const backdrop = document.createElement('div');
    backdrop.className = 'bpc-modal-backdrop';
    backdrop.innerHTML = `
      <div class="bpc-modal" role="dialog" aria-modal="true">
        <div class="bpc-modal-header">
          <h2 class="bpc-modal-title">${escapeHtml(title)}</h2>
          <button type="button" class="bpc-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="bpc-modal-body">${bodyHtml}</div>
        <div class="bpc-modal-footer">${footerHtml}</div>
      </div>
    `;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    backdrop.querySelector('.bpc-modal-close').addEventListener('click', closeModal);
    document.body.appendChild(backdrop);
    activeModal = backdrop;
    document.addEventListener('keydown', escCloseModal);
    return backdrop.querySelector('.bpc-modal');
  }
  function closeModal() {
    if (activeModal) { activeModal.remove(); activeModal = null; }
    document.removeEventListener('keydown', escCloseModal);
  }
  function escCloseModal(e) { if (e.key === 'Escape') closeModal(); }

  function transformLayout(inner, siteMapEl, legendEl, regions, regionMap) {
    const twocol = document.createElement('div');
    twocol.className = 'bpc-twocol';

    const left  = document.createElement('div'); left.className  = 'bpc-twocol-left';
    const right = document.createElement('div'); right.className = 'bpc-twocol-right';
    twocol.appendChild(left);
    twocol.appendChild(right);
    left.appendChild(siteMapEl);

    const card = document.createElement('div');
    card.className = 'bpc-detail-card';
    right.appendChild(card);

    if (legendEl && legendEl.parentNode === inner) {
      inner.insertBefore(twocol, legendEl);
      legendEl.classList.add('bpc-tight');
    } else {
      inner.appendChild(twocol);
    }

    const materialsSection = inner.querySelector('.pub-site-plan-materials');
    if (materialsSection) materialsSection.classList.add('bpc-hidden');

    customize._lastRender = () => renderOverview(card, regions, regionMap);
    customize._lastRender();

    document.querySelectorAll('polygon.pub-drawing-region:not(.pub-drawing-region--static)').forEach((poly) => {
      const regionId = poly.getAttribute('data-region-id');
      const anchor = poly.closest('a');
      if (!anchor || !regionId) return;
      anchor.addEventListener('click', (e) => {
        e.preventDefault();
        renderRegionDetail(card, regionId, regions, regionMap);
        customize._lastRender = () => renderRegionDetail(card, regionId, regions, regionMap);
        const href = anchor.getAttribute('href');
        if (href) navigateToSection(href);
      });
    });

    document.querySelectorAll('.pub-region-legend-row').forEach((row) => {
      const regionId = row.getAttribute('data-region-id');
      if (!regionId) return;
      row.addEventListener('click', (e) => {
        e.preventDefault();
        renderRegionDetail(card, regionId, regions, regionMap);
        customize._lastRender = () => renderRegionDetail(card, regionId, regions, regionMap);
      });
    });
  }

  function transformBidSection() {
    const scopeList = document.querySelector('.pub-scope-list');
    if (!scopeList) return null;

    const items = Array.from(scopeList.querySelectorAll(':scope > .pub-scope-item'));
    if (items.length === 0) return null;

    const scopeTotal = scopeList.parentElement
      ? scopeList.parentElement.querySelector('.pub-scope-total')
      : null;

    let finalTotalAmount = '';
    let subtotalAmount = '';
    let creditAmount = '';

    if (scopeTotal) {
      const amountEls = scopeTotal.querySelectorAll('.pub-scope-total-amount');
      if (amountEls.length > 0) {
        finalTotalAmount = (amountEls[amountEls.length - 1].textContent || '').trim();
      }
      const allText = (scopeTotal.parentElement
        ? scopeTotal.parentElement.textContent
        : scopeTotal.textContent) || '';
      const subMatch = allText.match(/Estimate subtotal[\s\S]{0,30}?(\$[\d,]+(?:\.\d+)?)/i);
      const credMatch = allText.match(/Credit[\s\S]{0,30}?(\(?\$[\d,]+(?:\.\d+)?\)?)/i);
      if (subMatch) subtotalAmount = subMatch[1];
      if (credMatch) creditAmount = credMatch[1];
    }

    if (!finalTotalAmount) {
      let sum = 0;
      let valid = true;
      items.forEach((item) => {
        const amtEl = item.querySelector('.pub-scope-item-amount');
        if (!amtEl) { valid = false; return; }
        const num = parseFloat((amtEl.textContent || '').replace(/[^0-9.\-]/g, ''));
        if (isNaN(num)) { valid = false; return; }
        sum += num;
      });
      if (valid) {
        finalTotalAmount = '$' + sum.toLocaleString('en-US', { maximumFractionDigits: 0 });
      }
    }

    const reader = document.createElement('div');
    reader.className = 'bpc-bid-reader';

    const listEl = document.createElement('div');
    listEl.className = 'bpc-bid-reader-list';

    const totalCard = document.createElement('div');
    totalCard.className = 'bpc-bid-reader-total-card';
    let breakdownHtml = '';
    if (subtotalAmount || creditAmount) {
      breakdownHtml = '<div class="bpc-bid-total-breakdown">';
      if (subtotalAmount) {
        breakdownHtml += `<div class="bpc-bid-total-breakdown-row"><span>Subtotal</span><span>${escapeHtml(subtotalAmount)}</span></div>`;
      }
      if (creditAmount) {
        breakdownHtml += `<div class="bpc-bid-total-breakdown-row bpc-bid-total-breakdown-row--credit"><span>Credit</span><span>${escapeHtml(creditAmount)}</span></div>`;
      }
      breakdownHtml += '</div>';
    }
    totalCard.innerHTML = `
      <div class="bpc-bid-total-eyebrow">Project total</div>
      <div class="bpc-bid-total-amount">${escapeHtml(finalTotalAmount || '')}</div>
      <div class="bpc-bid-total-meta">${items.length} section${items.length === 1 ? '' : 's'}</div>
      ${breakdownHtml}
    `;
    listEl.appendChild(totalCard);

    const rowsWrap = document.createElement('div');
    rowsWrap.className = 'bpc-bid-reader-rows';

    const sections = items.map((item, idx) => {
      const id = item.getAttribute('id') || ('bpc-section-' + idx);
      if (!item.getAttribute('id')) item.setAttribute('id', id);
      const eyebrowEl = item.querySelector('.pub-scope-item-eyebrow');
      const nameEl = item.querySelector('.pub-scope-item-name');
      const amountEl = item.querySelector('.pub-scope-item-amount');
      const eyebrow = eyebrowEl ? (eyebrowEl.textContent || '').trim() : ('Section ' + String(idx + 1).padStart(2, '0'));
      const name = nameEl ? (nameEl.textContent || '').trim() : 'Section';
      const amount = amountEl ? (amountEl.textContent || '').trim() : '';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bpc-bid-reader-row';
      btn.setAttribute('data-target', id);
      btn.innerHTML = `
        <div class="bpc-bid-reader-row-eyebrow">${escapeHtml(eyebrow)}</div>
        <div class="bpc-bid-reader-row-name">${escapeHtml(name)}</div>
        ${amount ? `<div class="bpc-bid-reader-row-amount">${escapeHtml(amount)}</div>` : ''}
      `;
      rowsWrap.appendChild(btn);

      return { id, btn, item };
    });
    listEl.appendChild(rowsWrap);

    const paneEl = document.createElement('div');
    paneEl.className = 'bpc-bid-reader-pane';
    sections.forEach(({ item }) => {
      paneEl.appendChild(item);
      item.classList.add('bpc-hidden-section');
    });

    reader.appendChild(listEl);
    reader.appendChild(paneEl);

    scopeList.parentNode.insertBefore(reader, scopeList);
    scopeList.remove();
    if (scopeTotal && scopeTotal.parentNode) {
      const parent = scopeTotal.parentElement;
      scopeTotal.remove();
      if (parent) {
        parent.querySelectorAll('.pub-scope-summary-row').forEach(el => el.remove());
      }
    }

    function select(id) {
      const target = sections.find(s => s.id === id);
      if (!target) return false;
      sections.forEach(s => {
        s.item.classList.add('bpc-hidden-section');
        s.btn.classList.remove('bpc-active');
      });
      target.item.classList.remove('bpc-hidden-section');
      target.btn.classList.add('bpc-active');
      paneEl.scrollTop = 0;
      target.btn.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
      return true;
    }

    sections.forEach((s) => {
      s.btn.addEventListener('click', () => select(s.id));
    });

    if (sections.length > 0) select(sections[0].id);

    return { root: reader, select };
  }

  async function init() {
    const inner = document.querySelector('.pub-drawing-inner');
    if (!inner) return;
    const siteMapEl = inner.querySelector('.pub-site-plan-map');
    if (!siteMapEl) return;
    const materialsGrid = inner.querySelector('.pub-materials-grid');
    if (!materialsGrid) return;
    const legendEl = inner.querySelector('.pub-region-legend');

    const regions = extractRegions();
    if (regions.length === 0) return;
    const regionMap = extractRegionMaterials(materialsGrid);

    injectStyles();

    const token = getAuthToken();
    const slug = getSlugFromPath();
    if (token && slug) {
      try {
        const r = await fetch(API_DATA + '?slug=' + encodeURIComponent(slug), {
          headers: { Authorization: 'Bearer ' + token },
        });
        if (r.ok) {
          customize.data = await r.json();
          customize.enabled = true;
          // Sprint 14C.14 — cache-busting query string. Cloudflare Pages
          // caches static JS aggressively (browser disk cache + edge), which
          // means after a fix is committed and deployed, users keep loading
          // the OLD module from cache until they hard-refresh. During active
          // dev iteration that's painful; using Date.now() as a version
          // forces a unique URL per page load so each visit gets the latest
          // module. Tradeoff: no cross-page caching benefit, but these
          // modules only load on /p/<slug> pages so the bandwidth cost is
          // minimal. Once the homeowner-redesign feature stabilizes we can
          // switch this to a per-deploy version stamp.
          const _bpcModuleCacheBuster = Date.now();
          // Phase 6.2: when customize is enabled (authenticated homeowner),
          // load the redesign module — adds the floating CTA + drawing overlay.
          if (!document.getElementById('bpc-redesign-module')) {
            const s = document.createElement('script');
            s.id = 'bpc-redesign-module';
            s.src = '/p-redesign.js?v=' + _bpcModuleCacheBuster;
            document.head.appendChild(s);
          }
          // Phase 6.4A: load the budget exploration module.
          if (!document.getElementById('bpc-budget-module')) {
            const s = document.createElement('script');
            s.id = 'bpc-budget-module';
            s.src = '/p-budget.js?v=' + _bpcModuleCacheBuster;
            document.head.appendChild(s);
          }
        }
      } catch (e) {}
    }

    transformLayout(inner, siteMapEl, legendEl, regions, regionMap);
    _bidReader = transformBidSection();
    transformQualityStandards();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
