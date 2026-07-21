// ═══════════════════════════════════════════════════════════════════════════
// /api/proxy-pdf — Phase 3B.2 Session 2
//
// CORS-safe PDF fetcher for browser-side pdfjs rendering. The browser
// can't fetch the Belgard PCG directly (belgard.com doesn't set CORS
// headers), so this Function fetches it server-side and re-streams it.
//
// Supabase Storage URLs (uploaded PDFs) DO support CORS, so browser
// could fetch those directly — but for consistency we route everything
// through this proxy. Browser code only needs to know how to call
// /api/proxy-pdf?id=<uuid>.
//
// Security: only PDFs that have been registered in catalog_pdfs are
// fetchable. The catalog_pdf_id parameter is validated and the row's
// pdf_url is the only thing we actually fetch. This prevents abuse as
// an open proxy.
//
// Auth: caller must be master, matching catalog_pdfs RLS.
//
// Request:
//   GET /api/proxy-pdf?id=<catalog_pdf_uuid>
//   Authorization: Bearer <user_access_token>
//
// Response:
//   200 application/pdf  (binary PDF body, with CORS headers)
//   400 / 401 / 403 / 404 / 502 with JSON error
// ═══════════════════════════════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FETCH_TIMEOUT_MS = 30000;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export async function onRequestGet({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });

  try {
    const SUPABASE_URL = env.SUPABASE_URL;
    const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { error: 'Server not configured (missing Supabase env vars)' });
    }

    // ─── Auth ──────────────────────────────────────────────────────────────
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return json(401, { error: 'Missing auth token' });

    const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'Authorization': 'Bearer ' + token, 'apikey': SERVICE_ROLE },
    });
    if (!userResp.ok) return json(401, { error: 'Invalid auth token' });
    const callerUser = await userResp.json();
    if (!callerUser || !callerUser.id) {
      return json(401, { error: 'Invalid auth token (no user)' });
    }

    // ─── Authz: master only ────────────────────────────────────────────────
    const profileResp = await fetch(
      SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(callerUser.id) +
      '&select=role,is_active',
      { headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE } }
    );
    if (!profileResp.ok) return json(403, { error: 'Could not look up caller profile' });
    const profiles = await profileResp.json();
    const profile = Array.isArray(profiles) && profiles[0];
    if (!profile || !profile.is_active || profile.role !== 'master') {
      return json(403, { error: 'Master role required' });
    }

    // ─── Validate input ────────────────────────────────────────────────────
    const url = new URL(request.url);
    const catalogPdfId = (url.searchParams.get('id') || '').trim().toLowerCase();
    if (!UUID_RE.test(catalogPdfId)) {
      return json(400, { error: 'Missing or invalid id parameter (must be a UUID)' });
    }

    // ─── Look up the registered catalog PDF ────────────────────────────────
    const pdfResp = await fetch(
      SUPABASE_URL + '/rest/v1/catalog_pdfs?id=eq.' + encodeURIComponent(catalogPdfId) +
      '&select=id,manufacturer,pdf_name,pdf_url',
      { headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE } }
    );
    if (!pdfResp.ok) return json(500, { error: 'Could not look up catalog PDF' });
    const pdfs = await pdfResp.json();
    if (!Array.isArray(pdfs) || pdfs.length === 0) {
      return json(404, { error: 'Catalog PDF not registered' });
    }
    const pdf = pdfs[0];

    // ─── Fetch the actual PDF ──────────────────────────────────────────────
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(pdf.pdf_url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Paver PortalProposalBuilder/1.0 (+https://bayside-proposals.pages.dev)',
          'Accept': 'application/pdf',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      return json(502, {
        error: 'Could not fetch PDF: ' + (err.message || 'network error'),
        url: pdf.pdf_url,
      });
    }
    clearTimeout(timer);

    if (!upstream.ok) {
      return json(502, {
        error: `Upstream returned ${upstream.status} ${upstream.statusText}`,
        url: pdf.pdf_url,
      });
    }

    // Stream back with CORS + caching. PDFs rarely change so cache aggressively.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${pdf.pdf_name.replace(/[^A-Za-z0-9 .-]+/g, '_')}.pdf"`,
        'Cache-Control': 'private, max-age=3600',
        ...CORS_HEADERS,
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: (err && err.message) || 'Unexpected server error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
