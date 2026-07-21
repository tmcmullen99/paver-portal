// ═══════════════════════════════════════════════════════════════════════════
// BPB Phase 2B + 2C — Supabase client + auth gate + team modal entry
//
// Drop-in replacement for the prior 5-line supabase-client.js. Same
// `import { supabase } from './supabase-client.js'` works everywhere
// it did before; this module adds a side-effect auth gate on import so
// every admin page (editor.html, site-map.html, etc.) automatically:
//
//   1. Checks for a Supabase session in localStorage (sync, fast).
//   2. If no session → redirects to /login.html?redirect=<here>.
//   3. If session exists → injects a small "logged in as X · Sign out"
//      pill in the top-right of the page (works on any admin page that
//      imports this module, no per-page wiring required).
//   4. Validates the session async via supabase.auth.getSession() in the
//      background; if invalidated, redirects to login.
//   5. [SPRINT 1 — Decouple] The master-only "Team" button was REMOVED
//      from this shared pill. Team management lives at /admin/designers.html
//      (master-only). Shared designer-app pages now render identically for
//      every staff role — no role-conditional UI outside /admin/.
//   6. [SPRINT 1 — Decouple] Auth-state hardening: on SIGNED_OUT the page
//      immediately redirects to /login.html, so a sign-out in another tab
//      (or mid-flow) can never leave stale chrome from the previous
//      account on screen.
//
// Public proposal pages at /p/{slug} are static HTML snapshots rendered
// by the CF Pages function and do NOT import this module — they remain
// fully public, no login required.
//
// Login page (/login.html) imports this module too (to get the supabase
// client for sign-in calls), so the gate explicitly skips itself when
// running on the login page.
//
// Phase 5B P2: the floating auth pill is suppressed on pages that use
// the shared admin shell (admin-shell.css/js), since the shell renders
// its own role badge + sign-out in the sticky topbar. Two overlapping
// auth widgets looked broken. The pill still renders on dashboard.html,
// editor.html, site-map.html, and any other page that doesn't adopt
// the shell — those still need the floating pill.
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://gfgbypcnxkschnfsitfb.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Ko4LNw2VjhZVFmwJ-i2qtA_XeGgBcew';
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // for magic-link + recovery redirects
  },
});

// ─── Auth gate ───────────────────────────────────────────────────────────────
// The gate runs as a side effect of importing this module. It uses a
// synchronous localStorage check first to avoid a flash of the editor UI
// for unauthenticated visitors, then validates async.

const PROJECT_REF = 'gfgbypcnxkschnfsitfb';
const STORAGE_KEY = 'sb-' + PROJECT_REF + '-auth-token';

// Pages that skip the gate. Login page imports this module to use the
// supabase client for sign-in but obviously must not redirect to itself.
const PUBLIC_ADMIN_PATHS = ['/login.html', '/login', '/auth/callback'];

function isPublicAdminPath() {
  const p = window.location.pathname;
  return PUBLIC_ADMIN_PATHS.some(pp => p === pp || p.startsWith(pp + '/'));
}

function hasLocalSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.access_token) return false;
    if (parsed.expires_at && Number(parsed.expires_at) * 1000 < Date.now()) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function redirectToLogin() {
  const here = window.location.pathname + window.location.search + window.location.hash;
  const next = encodeURIComponent(here);
  // replace() so the unauth page doesn't get added to history
  window.location.replace('/login.html?redirect=' + next);
}

if (!isPublicAdminPath()) {
  if (!hasLocalSession()) {
    redirectToLogin();
  } else {
    // Async validation — covers the case where localStorage has a stale
    // token but the server has revoked the session. Doesn't block render
    // because if the token is forged or stale, RLS will return empty
    // results from queries anyway (queries fail closed), so there's no
    // security risk from the brief race.
    supabase.auth.getSession().then(({ data, error }) => {
      if (error || !data || !data.session) redirectToLogin();
    }).catch(() => redirectToLogin());

    // Inject the auth pill once DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectAuthPill);
    } else {
      injectAuthPill();
    }
  }

  // SPRINT 1 hardening: if the session ends for ANY reason (sign-out in
  // this tab, sign-out in another tab, token revocation), bounce to the
  // login page immediately. This is what prevents the "previous account's
  // chrome still on screen" state that made account switching feel like
  // data was bleeding between roles.
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      window.location.replace('/login.html');
    }
  });
}

// ─── Auth pill (logged-in user indicator + Sign out button) ─────────────────
async function injectAuthPill() {
  if (document.getElementById('bpb-auth-pill')) return;

  // Phase 5B P2: skip the floating pill on pages that use the shared
  // admin shell. The shell already shows role + email + sign-out in its
  // sticky topbar (.ash-topbar / #ashRoleBadge / #ashSignOutBtn), and
  // two overlapping auth widgets looked broken. Non-admin-shell pages
  // (dashboard, editor, site-map, etc.) still get the pill.
  if (document.querySelector('.ash-topbar')) return;

  // Get user info
  let user = null;
  try {
    const r = await supabase.auth.getUser();
    user = r.data && r.data.user;
  } catch (_) { /* fall through */ }
  if (!user) return;

  // Get profile (display name + role). Best effort — if it fails (RLS
  // blocks for some reason during transition), fall back to email.
  let profile = null;
  try {
    const r = await supabase
      .from('profiles')
      .select('display_name, role')
      .eq('id', user.id)
      .maybeSingle();
    profile = r.data;
  } catch (_) { /* fall through */ }

  const name = (profile && profile.display_name) || user.email || 'Signed in';
  const role = (profile && profile.role) || '';

  // Build pill (uses inline <style> so it's self-contained and doesn't
  // require any host-page CSS hooks).
  const pill = document.createElement('div');
  pill.id = 'bpb-auth-pill';
  pill.innerHTML =
    '<style>' +
    '#bpb-auth-pill {' +
    '  position: fixed; top: 14px; right: 14px; z-index: 9999;' +
    '  background: #fff; border: 1px solid #e5e5e5;' +
    '  border-radius: 999px; padding: 6px 6px 6px 16px;' +
    "  font: 500 12px/1.2 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;" +
    '  color: #33281c;' +
    '  display: inline-flex; align-items: center; gap: 12px;' +
    '  box-shadow: 0 4px 14px rgba(0,0,0,0.08);' +
    '  max-width: calc(100vw - 28px);' +
    '}' +
    '#bpb-auth-pill .bpb-auth-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }' +
    '#bpb-auth-pill .bpb-auth-role {' +
    "  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;" +
    '  font-size: 9px; letter-spacing: 0.18em;' +
    '  color: #9c7440; text-transform: uppercase; font-weight: 600;' +
    '}' +
    '#bpb-auth-pill .bpb-auth-logout {' +
    '  background: #f5f5f5; border: none;' +
    '  border-radius: 999px; padding: 5px 12px;' +
    '  font: inherit; font-weight: 600; font-size: 11px;' +
    '  color: #353535; cursor: pointer;' +
    '  transition: background 0.15s, color 0.15s;' +
    '}' +
    '#bpb-auth-pill .bpb-auth-logout:hover { background: #33281c; color: #fff; }' +
    '@media (max-width: 540px) {' +
    '  #bpb-auth-pill { padding: 5px 5px 5px 12px; gap: 8px; font-size: 11px; }' +
    '  #bpb-auth-pill .bpb-auth-name { max-width: 120px; }' +
    '}' +
    '</style>' +
    '<span class="bpb-auth-name"></span>' +
    (role ? '<span class="bpb-auth-role"></span>' : '') +
    '<button type="button" class="bpb-auth-logout">Sign out</button>';

  // Set text content (safe vs HTML injection)
  pill.querySelector('.bpb-auth-name').textContent = name;
  if (role) pill.querySelector('.bpb-auth-role').textContent = role;

  document.body.appendChild(pill);

  // NOTE (Sprint 1): the master-only Team button that used to render here
  // was removed. Team management is at /admin/designers.html. Shared pages
  // now have zero role-conditional interactive UI.

  pill.querySelector('.bpb-auth-logout').addEventListener('click', async () => {
    try { await supabase.auth.signOut(); } catch (_) {}
    window.location.replace('/login.html');
  });
}
