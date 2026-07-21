// ═══════════════════════════════════════════════════════════════════════════
// /admin/admin-shell.js — Sprint 7
//
// The master admin shell. Renders:
//   1. The role badge + email in the topbar (existing)
//   2. The LEFT-SIDE NAVIGATION (new — was a top tab strip pre-Sprint-7)
//   3. The landing-page tile grid (existing, only on /admin/ root)
//   4. A mobile hamburger toggle injected into the topbar
//   5. Live notification dots on sidebar items, polled from /api/admin-inbox
//
// Sprint 7 changes from 14B:
//   • TABS unchanged in shape — 3 new entries added (Inbox, Material prices,
//     Resend invite) for tools shipped in Sprints 5/6.
//   • renderTabs() → renderSidebar() — vertical layout, grouped, with
//     section headers (using existing GROUPS metadata) instead of a single
//     flat strip.
//   • Hamburger button injected dynamically into the topbar — preserves all
//     existing admin-page HTML, no per-page edits needed.
//   • Background polling of /api/admin-inbox every 60 seconds paints
//     notification dots on Inbox, Substitutions, Redesigns, Clients, and
//     Resend invite sidebar items.
//
// Adding a future admin tool:
//   1. Add an entry to TABS below.
//   2. Done. The item appears for users with the right role, gets a sidebar
//      slot in the right group, and gets a tile on the landing grid.
//
// To add notification-dot wiring for a new item:
//   1. Give the TAB entry a `notifKey` matching an admin_inbox_state()
//      category name (e.g. 'pending_substitutions').
//   2. The dot count will populate automatically.
// ═══════════════════════════════════════════════════════════════════════════

import { requireDesigner, signOut } from '/js/auth-util.js';

const TABS = [
  // ── Landing ─────────────────────────────────────────────────────────────
  {
    id: 'overview',
    label: 'Overview',
    href: '/admin/',
    role: 'designer',
    group: 'main',
    icon: '⌂',
    description: 'Quick access to every admin tool you have permission for.',
    hideFromLanding: true,
  },

  // ── Operations — daily client work ──────────────────────────────────────
  {
    id: 'today',
    label: 'Today',
    href: '/admin/today.html',
    role: 'designer',
    group: 'operations',
    icon: '☀️',
    description: 'Daily dashboard — today\'s KPIs vs yesterday, this week\'s revenue picture, active pipeline value, the threads waiting on your reply, and which proposals are getting viewed right now.',
  },
  {
    id: 'inbox',
    label: 'Inbox',
    href: '/admin/inbox.html',
    role: 'designer',
    group: 'operations',
    icon: '📥',
    description: 'Unified view of everything needing attention right now: lock-ins, unread messages, pending substitutions and redesigns, cold deals, and clients pending account activation.',
    notifKey: '__inbox_total',
  },
  {
    id: 'conversations',
    label: 'Conversations',
    href: '/admin/conversations.html',
    role: 'designer',
    group: 'operations',
    icon: '💬',
    description: 'Unified chat across every client thread. Reply inline. Replies to clients who haven\'t set up their account auto-email them with a magic-link sign-in.',
    notifKey: 'unread_inbound',
  },
  {
    id: 'pipeline',
    label: 'Pipeline',
    href: '/admin/pipeline.html',
    role: 'designer',
    group: 'operations',
    icon: '◉',
    description: 'Every proposal in one place. Computed funnel stage, last activity, pending substitutions and redesigns, with quick links into every other admin view.',
  },
  {
    id: 'nurture',
    label: 'Nurture',
    href: '/admin/nurture-clients.html',
    role: 'designer',
    group: 'operations',
    icon: '🌱',
    description: 'Track every client through the nurture phase pipeline. Auto-transitions on consultation, publish, and signing. Manual override for paused or opted-out clients.',
  },
  {
    id: 'nurture-templates',
    label: 'Nurture templates',
    href: '/admin/nurture-templates.html',
    role: 'master',
    group: 'operations',
    icon: '✉',
    description: 'Author the email content sent at each phase + day-offset of the nurture sequence. Markdown body with merge fields, project-type filtering, day-offset scheduling. Master-only — controls outbound messaging across all designers.',
  },
  {
    id: 'outreach',
    label: 'Outreach',
    href: '/admin/outreach.html',
    role: 'designer',
    group: 'operations',
    icon: '📨',
    description: 'Cold lead pipeline. Drafted-not-sent, sent-never-opened, and engaged-then-ghosted clients. AI-drafted re-engagement messages.',
  },
  {
    id: 'clients',
    label: 'Clients',
    href: '/admin/clients.html',
    role: 'designer',
    group: 'operations',
    icon: '👤',
    description: 'Add, edit, and invite homeowner clients. Assign proposals, manage referrals, send login links.',
    notifKey: 'clients_pending_activation',
  },
  {
    id: 'resend-invite',
    label: 'Resend invite',
    href: '/admin/resend-invite.html',
    role: 'designer',
    group: 'operations',
    icon: '🔓',
    description: 'Send a fresh Paver Portal magic-link invite to any client by email or UUID. Lifeline for clients who never set up their account — kills Yorktown-style silent failures.',
    notifKey: 'clients_pending_activation',
  },
  {
    id: 'substitutions',
    label: 'Substitutions',
    href: '/admin/substitutions.html',
    role: 'designer',
    group: 'operations',
    icon: '↺',
    description: 'Review homeowner material swap requests submitted from published proposals. Approve, reject, or mark applied.',
    notifKey: 'pending_substitutions',
  },
  {
    id: 'client-redesigns',
    label: 'Redesigns',
    href: '/admin/client-redesigns.html',
    role: 'designer',
    group: 'operations',
    icon: '✏',
    description: 'Review client design change requests — markups, photos of paper markup, and notes for changes beyond material swaps.',
    notifKey: 'pending_redesigns',
  },
  {
    id: 'create-homeowner',
    label: 'Create homeowner',
    href: '/admin/create-homeowner-account.html',
    role: 'designer',
    group: 'operations',
    icon: '+',
    description: 'Provision a homeowner account at the design appointment so the client can log in immediately.',
  },
  {
    id: 'site-map',
    label: 'Site map',
    href: '/admin/site-map.html',
    role: 'designer',
    group: 'operations',
    icon: '⊞',
    description: 'Edit interactive site-map regions and material assignments for a published proposal.',
  },

  // ── Catalog ─────────────────────────────────────────────────────────────
  {
    id: 'materials',
    label: 'Materials',
    href: '/admin/materials.html',
    role: 'designer',
    group: 'catalog',
    icon: '◧',
    description: 'Browse, edit, or add materials in the central catalog. Used for swap candidates on every proposal.',
  },
  {
    id: 'material-prices',
    label: 'Material prices',
    href: '/admin/material-prices.html',
    role: 'designer',
    group: 'catalog',
    icon: '$',
    description: 'Set per-square-foot or per-unit prices for materials so the inline editor and homeowner-facing redesigns can show real numbers.',
  },
  {
    id: 'swatches-bulk',
    label: 'Swatches (bulk)',
    href: '/admin/material-swatches-bulk.html',
    role: 'designer',
    group: 'catalog',
    icon: '▣',
    description: 'Drop many swatches at once. Auto-matches to materials by filename.',
  },
  {
    id: 'swatches-single',
    label: 'Swatches (per material)',
    href: '/admin/material-swatches.html',
    role: 'designer',
    group: 'catalog',
    icon: '▢',
    description: 'Upload or replace the swatch on one specific material variant.',
  },
  {
    id: 'catalog-pdfs',
    label: 'Catalog PDFs',
    href: '/admin/catalog-pdfs.html',
    role: 'designer',
    group: 'catalog',
    icon: '⎙',
    description: 'Manage manufacturer install PDFs and link them to catalog categories.',
  },
  {
    id: 'material-images',
    label: 'Material images (Belgard)',
    href: '/admin/material-images.html',
    role: 'master',
    group: 'catalog',
    icon: '🖼',
    description: 'Scrape Belgard product pages for primary images. Master-only — alters catalog imagery in bulk.',
  },
  {
    id: 'belgard-sync',
    label: 'Belgard sync',
    href: '/admin/belgard-sync.html',
    role: 'master',
    group: 'catalog',
    icon: '⟳',
    description: 'Refresh the Belgard materials catalog from the manufacturer. Master-only — high blast radius.',
  },

  // ── Team ────────────────────────────────────────────────────────────────
  {
    id: 'designers',
    label: 'Designers',
    href: '/admin/designers.html',
    role: 'master',
    group: 'team',
    icon: '⚒',
    description: 'List, edit, deactivate, and invite designer/master accounts. Promote or demote roles.',
  },

  // ── Analytics ───────────────────────────────────────────────────────────
  {
    id: 'events',
    label: 'Events',
    href: '/admin/events.html',
    role: 'designer',
    group: 'analytics',
    icon: '⚡',
    description: 'Recent homeowner engagement events captured from published proposals. Sanity-check view; dashboards are coming in 5D.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    href: '/admin/notifications.html',
    role: 'designer',
    group: 'analytics',
    icon: '🔔',
    description: 'Get pinged when homeowners view your proposals. Manage first-view emails, daily digest, and quiet hours.',
  },

  // ── Tools & maintenance ────────────────────────────────────────────────
  {
    id: 'install-guide',
    label: 'Install guide',
    href: '/admin/install-guide-parse.html',
    role: 'master',
    group: 'tools',
    icon: '📐',
    description: 'Parse the Paver Portal install-guide PDF into structured sections. Master-only.',
  },
  {
    id: 'jobnimbus',
    label: 'JobNimbus probe',
    href: '/admin/jobnimbus-probe.html',
    role: 'master',
    group: 'tools',
    icon: '◇',
    description: 'Diagnostic console for the JobNimbus API. Master-only.',
  },
  {
    id: 'republish-bulk',
    label: 'Bulk republish',
    href: '/admin/republish-bulk.html',
    role: 'master',
    group: 'tools',
    icon: '↻',
    description: 'Republish published bids to bake new swatches and catalog updates into fresh snapshots.',
  },
];

const GROUPS = [
  { id: 'operations', label: 'Operations',          desc: 'Day-to-day client management.' },
  { id: 'catalog',    label: 'Material catalog',    desc: 'The library of materials, swatches, and install PDFs that powers every proposal.' },
  { id: 'team',       label: 'Team',                desc: 'Staff account management. Master-only.' },
  { id: 'analytics',  label: 'Analytics',           desc: 'Engagement and conversion data from published proposals.' },
  { id: 'tools',      label: 'Tools & maintenance', desc: 'Less-frequent utilities. Most are master-only.' },
];

// Polling interval for notification-dot refresh.
const NOTIF_POLL_INTERVAL_MS = 60000;

(async function init() {
  const auth = await requireDesigner();
  if (!auth) return;

  const { user, profile } = auth;
  const isMaster = profile.role === 'master';

  injectSidebarBackdrop();
  injectHamburger();
  syncTopbarHeight();
  window.addEventListener('resize', syncTopbarHeight);

  renderTopbar(user, profile, isMaster);
  renderSidebar(isMaster);
  renderLanding(profile, isMaster);

  document.getElementById('ashSignOutBtn').addEventListener('click', signOut);

  // Notification dots — best-effort, silent failure
  fetchAndPaintNotifications();
  setInterval(fetchAndPaintNotifications, NOTIF_POLL_INTERVAL_MS);
})();

// ═══════════════════════════════════════════════════════════════════════════
// Sidebar chrome — hamburger, backdrop, dynamic topbar height
// ═══════════════════════════════════════════════════════════════════════════

function injectHamburger() {
  const inner = document.querySelector('.ash-topbar-inner');
  if (!inner || inner.querySelector('.ash-sidebar-toggle')) return;

  const brand = inner.querySelector('.ash-brand');
  if (!brand) return;

  // Create a wrapper for [hamburger + brand] so the existing
  // justify-content: space-between still pushes ash-topbar-right to the edge.
  const leftGroup = document.createElement('div');
  leftGroup.className = 'ash-topbar-left';

  const btn = document.createElement('button');
  btn.className = 'ash-sidebar-toggle';
  btn.id = 'ashSidebarToggle';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Toggle navigation');
  btn.innerHTML = '<span aria-hidden="true">☰</span>';
  btn.addEventListener('click', toggleSidebar);

  leftGroup.appendChild(btn);
  leftGroup.appendChild(brand);
  inner.insertBefore(leftGroup, inner.firstChild);
}

function injectSidebarBackdrop() {
  if (document.querySelector('.ash-sidebar-backdrop')) return;
  const bd = document.createElement('div');
  bd.className = 'ash-sidebar-backdrop';
  bd.addEventListener('click', closeSidebar);
  document.body.appendChild(bd);
}

function toggleSidebar() {
  const sidebar = document.getElementById('ashTabs');
  if (!sidebar) return;
  const open = sidebar.classList.toggle('is-open');
  document.body.classList.toggle('ash-sidebar-open', open);
}

function closeSidebar() {
  const sidebar = document.getElementById('ashTabs');
  if (sidebar) sidebar.classList.remove('is-open');
  document.body.classList.remove('ash-sidebar-open');
}

function syncTopbarHeight() {
  const topbar = document.querySelector('.ash-topbar');
  if (!topbar) return;
  const h = topbar.offsetHeight;
  if (h > 0) {
    document.documentElement.style.setProperty('--ash-topbar-height', h + 'px');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Topbar
// ═══════════════════════════════════════════════════════════════════════════

function renderTopbar(user, profile, isMaster) {
  const badge = document.getElementById('ashRoleBadge');
  if (badge) {
    badge.textContent = isMaster ? 'Master' : 'Designer';
    badge.classList.remove('is-loading');
    badge.classList.add(isMaster ? 'is-master' : 'is-designer');
  }

  const emailEl = document.getElementById('ashUserEmail');
  if (emailEl) emailEl.textContent = profile.email || user.email || '';
}

// ═══════════════════════════════════════════════════════════════════════════
// Sidebar — vertical, grouped by GROUPS metadata
// ═══════════════════════════════════════════════════════════════════════════

function renderSidebar(isMaster) {
  const wrap = document.getElementById('ashTabs');
  if (!wrap) return;

  const visible = TABS.filter(t => isMaster || t.role === 'designer');
  const here = normalizePath(window.location.pathname);
  const activeId = (visible.find(t => normalizePath(t.href) === here) || {}).id;

  const inner = document.createElement('div');
  inner.className = 'ash-tabs-inner';

  // Render the Overview entry first as a top-level item (no group header)
  const overview = visible.find(t => t.group === 'main');
  if (overview) {
    const topSection = document.createElement('div');
    topSection.className = 'ash-sidebar-section';
    topSection.appendChild(renderSidebarItem(overview, activeId));
    inner.appendChild(topSection);
  }

  GROUPS.forEach(g => {
    const itemsInGroup = visible.filter(t => t.group === g.id);
    if (itemsInGroup.length === 0) return;

    const section = document.createElement('div');
    section.className = 'ash-sidebar-section';

    const title = document.createElement('div');
    title.className = 'ash-sidebar-section-title';
    title.textContent = g.label;
    section.appendChild(title);

    itemsInGroup.forEach(t => section.appendChild(renderSidebarItem(t, activeId)));
    inner.appendChild(section);
  });

  wrap.innerHTML = '';
  wrap.appendChild(inner);
}

function renderSidebarItem(t, activeId) {
  const a = document.createElement('a');
  a.className = 'ash-tab' + (t.id === activeId ? ' is-active' : '');
  a.href = t.href;
  a.setAttribute('data-tab-id', t.id);
  a.innerHTML = `
    <span class="ash-tab-icon">${escapeHtml(t.icon || '·')}</span>
    <span class="ash-tab-label">${escapeHtml(t.label)}</span>
    <span class="ash-tab-dot" data-dot aria-hidden="true"></span>
    ${t.role === 'master' ? '<span class="ash-tab-master-flag">M</span>' : ''}
  `;
  // Close mobile sidebar on tap so the user lands on the new page without
  // the sidebar still covering the content.
  a.addEventListener('click', () => {
    if (window.matchMedia('(max-width: 900px)').matches) {
      setTimeout(closeSidebar, 50);
    }
  });
  return a;
}

function normalizePath(p) {
  if (!p) return '';
  let s = p.split('?')[0].split('#')[0];
  if (s === '/admin/index.html') s = '/admin/';
  s = s.replace(/\/index\.html$/, '/');
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// Notification dots — poll /api/admin-inbox, paint counts onto sidebar items
// ═══════════════════════════════════════════════════════════════════════════

async function fetchAndPaintNotifications() {
  try {
    const resp = await fetch('/api/admin-inbox', { cache: 'no-store' });
    if (!resp.ok) {
      // Silent — dots are best-effort; user still has the inbox page itself.
      return;
    }
    const data = await resp.json();
    paintNotifDots(data);
  } catch (e) {
    // Silent fail. The shell continues to work without dots.
  }
}

function paintNotifDots(d) {
  if (!d || typeof d !== 'object') return;

  // Special category: total of all attention-needing items, shown on Inbox.
  const totalAttention =
      (Array.isArray(d.unread_inbound)              ? d.unread_inbound.length              : 0)
    + (Array.isArray(d.pending_substitutions)       ? d.pending_substitutions.length       : 0)
    + (Array.isArray(d.pending_redesigns)           ? d.pending_redesigns.length           : 0)
    + (Array.isArray(d.open_signature_intents)      ? d.open_signature_intents.length      : 0)
    + (Array.isArray(d.clients_pending_activation)  ? d.clients_pending_activation.length  : 0);

  const counts = {
    '__inbox_total':              totalAttention,
    'unread_inbound':             (d.unread_inbound             || []).length,
    'pending_substitutions':      (d.pending_substitutions      || []).length,
    'pending_redesigns':          (d.pending_redesigns          || []).length,
    'open_signature_intents':     (d.open_signature_intents     || []).length,
    'clients_pending_activation': (d.clients_pending_activation || []).length,
    'cold_deals':                 (d.cold_deals                 || []).length,
    'hot_today':                  (d.hot_today                  || []).length,
  };

  // For each TAB entry with a notifKey, paint the dot.
  TABS.forEach(t => {
    if (!t.notifKey) return;
    const el = document.querySelector(`.ash-tab[data-tab-id="${t.id}"]`);
    if (!el) return;
    const dot = el.querySelector('[data-dot]');
    if (!dot) return;

    const n = counts[t.notifKey] || 0;
    if (n > 0) {
      dot.textContent = n > 99 ? '99+' : String(n);
      dot.classList.add('is-visible');
    } else {
      dot.textContent = '';
      dot.classList.remove('is-visible');
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Landing tile grid — only rendered when on /admin/ root
// ═══════════════════════════════════════════════════════════════════════════

function renderLanding(profile, isMaster) {
  const landing = document.getElementById('ashLanding');
  if (!landing) return;

  const here = normalizePath(window.location.pathname);
  if (here !== '/admin/') {
    landing.style.display = 'none';
    return;
  }

  const eyebrow = document.getElementById('ashIntroEyebrow');
  const title   = document.getElementById('ashIntroTitle');
  const lede    = document.getElementById('ashIntroLede');

  const greeting = profile.display_name ? profile.display_name.split(' ')[0] : 'there';
  if (eyebrow) eyebrow.textContent = isMaster ? 'Master · Admin home' : 'Designer · Admin home';
  if (title)   title.textContent   = `Welcome, ${greeting}.`;
  if (lede) {
    lede.textContent = isMaster
      ? 'Everything in BPB. Tools tagged with M are master-only — they affect the catalog, infrastructure, or other designers\' work.'
      : 'Tools you use day-to-day. A few admin utilities aren\'t shown here because they\'re reserved for master access.';
  }

  const groupsWrap = document.getElementById('ashTileGroups');
  if (!groupsWrap) return;
  groupsWrap.innerHTML = '';

  GROUPS.forEach(g => {
    const tabsInGroup = TABS.filter(t =>
      t.group === g.id
      && !t.hideFromLanding
      && (isMaster || t.role === 'designer')
    );
    if (tabsInGroup.length === 0) return;

    const groupEl = document.createElement('section');
    groupEl.className = 'ash-tile-group';
    groupEl.innerHTML = `
      <div class="ash-tile-group-header">
        <h2 class="ash-tile-group-title">${escapeHtml(g.label)}</h2>
        <span class="ash-tile-group-meta">${tabsInGroup.length} tool${tabsInGroup.length === 1 ? '' : 's'}</span>
      </div>
      <div class="ash-tile-grid">
        ${tabsInGroup.map(t => renderTile(t)).join('')}
      </div>
    `;
    groupsWrap.appendChild(groupEl);
  });
}

function renderTile(t) {
  const masterFlag = t.role === 'master'
    ? '<span class="ash-tile-master-flag">Master</span>'
    : '';
  const tileClass = 'ash-tile' + (t.role === 'master' ? ' is-master-only' : '');
  return `
    <a class="${tileClass}" href="${escapeAttr(t.href)}">
      <div class="ash-tile-row">
        <span class="ash-tile-icon">${escapeHtml(t.icon || '·')}</span>
        <span class="ash-tile-label">${escapeHtml(t.label)}</span>
        ${masterFlag}
      </div>
      <div class="ash-tile-desc">${escapeHtml(t.description || '')}</div>
    </a>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(str) { return escapeHtml(str); }
