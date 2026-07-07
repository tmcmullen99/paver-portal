// ═══════════════════════════════════════════════════════════════════════════
// branding.js — SPRINT 2B (white-label runtime branding)
//
// Reads the single company_settings row and applies it to the page, so the
// product's identity (company name, product name, logo, tagline, emails)
// is DATA, not code. Re-branding for a new hardscaping company — or a new
// product name — is a one-row database update, no redeploy.
//
// Usage on any page:
//
//   import { applyBranding, getBranding } from '/js/branding.js';
//   applyBranding({ pageTitle: 'Pipeline' });   // fire-and-forget is fine
//
// Markup hooks (all optional — only what exists gets touched):
//   <img  data-brand="logo">        → src + alt set; hidden if no logo_url
//   <span data-brand="company">     → company_name
//   <span data-brand="product">     → product_name
//   <span data-brand="tagline">     → tagline (hidden if none)
//
// If pageTitle is passed, document.title becomes
//   "{pageTitle} · {company_name} {product_name}"
//
// Reads are anon-allowed by RLS ("Anyone reads branding"), so this works
// on pre-auth pages like /login.html too. A sessionStorage cache keeps it
// to one network hit per tab session; DEFAULTS below guarantee the page
// still renders sensibly if the fetch fails.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';

const CACHE_KEY = 'bpb-branding-v1';

const DEFAULTS = {
  company_name: 'Bayside Pavers',
  product_name: 'Proposal Builder',
  tagline: null,
  logo_url: null,
  primary_color: '#5d7e69',
  support_email: null,
  reply_to_email: null,
  from_email_name: null,
  portal_base_url: window.location.origin,
};

let _inflight = null;

export async function getBranding() {
  // Session cache first
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) { /* ignore */ }

  // De-dupe concurrent callers on the same page
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const { data, error } = await supabase
        .from('company_settings')
        .select('company_name, product_name, tagline, logo_url, primary_color, support_email, reply_to_email, from_email_name, portal_base_url')
        .eq('id', 1)
        .maybeSingle();
      if (error || !data) return { ...DEFAULTS };
      const merged = { ...DEFAULTS, ...stripNulls(data) };
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(merged)); } catch (_) {}
      return merged;
    } catch (_) {
      return { ...DEFAULTS };
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

function stripNulls(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] != null && obj[k] !== '') out[k] = obj[k];
  }
  return out;
}

/**
 * Applies branding to the current document.
 * @param {object} opts
 * @param {string} [opts.pageTitle] — page-specific title prefix
 */
export async function applyBranding(opts = {}) {
  const b = await getBranding();

  const run = () => {
    document.querySelectorAll('[data-brand="company"]').forEach(el => { el.textContent = b.company_name; });
    document.querySelectorAll('[data-brand="product"]').forEach(el => { el.textContent = b.product_name; });
    document.querySelectorAll('[data-brand="tagline"]').forEach(el => {
      if (b.tagline) el.textContent = b.tagline; else el.style.display = 'none';
    });
    document.querySelectorAll('img[data-brand="logo"]').forEach(img => {
      if (b.logo_url) {
        img.src = b.logo_url;
        img.alt = b.company_name;
        img.style.display = '';
      } else {
        img.style.display = 'none';
      }
    });
    if (opts.pageTitle) {
      document.title = `${opts.pageTitle} · ${b.company_name} ${b.product_name}`;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }

  return b;
}

/**
 * Call after the master edits company_settings so the next page load
 * refetches instead of serving the stale cached identity.
 */
export function clearBrandingCache() {
  try { sessionStorage.removeItem(CACHE_KEY); } catch (_) {}
}
