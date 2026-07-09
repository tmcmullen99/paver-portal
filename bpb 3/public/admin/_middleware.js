// ═══════════════════════════════════════════════════════════════════════════
// functions/api/_middleware.js — SPRINT 1.5A (API security)
//
// Cloudflare Pages middleware. Runs BEFORE every function under /api/*.
//
// WHY THIS EXISTS: several admin endpoints (admin-conversations, admin-inbox,
// admin-today, admin-client, admin-conversation-thread) were deployed with
// "no API-layer auth" — they used the service-role key server-side and
// returned company-wide client data to ANY caller, authenticated or not.
// send-chat-message additionally let any caller post messages into any
// client thread as "master"/"designer". This middleware closes all of that
// with one file: every gated path now requires a valid Supabase JWT
// belonging to an ACTIVE MASTER profile.
//
// GATED (master JWT required):
//   • Any path starting with /api/admin-   (except /api/admin-daily-digest,
//     which keeps its own x-bayside-cron-secret so scheduled digests
//     continue to work)
//   • /api/send-chat-message               (staff-side message sending)
//
// NOT GATED (pass straight through, unchanged behavior):
//   • Everything else under /api/ — public proposal data, client-portal
//     endpoints, webhooks (resend-webhook), analytics (track-events), the
//     already-self-authenticating endpoints (suggest-replies, send-follow-up,
//     admin-jot's own validation stays as a second layer), etc.
//
// CLIENT SIDE: /js/auth-util.js (Sprint 1.5A version) transparently attaches
// Authorization: Bearer <session token> to any same-origin request hitting
// the gated paths, so no per-page changes were needed.
//
// ENV VARS (already configured for existing functions):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (or legacy name SUPABASE_SERVICE_KEY)
// ═══════════════════════════════════════════════════════════════════════════

// The founding company's UUID — the legacy /admin/ console + its APIs are
// operator tooling and remain locked to it. New tenants (Stage 3+) live in
// the designer app with owner powers enforced by company-scoped RLS.
const FOUNDING_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-bayside-cron-secret',
  'Cache-Control': 'no-store',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || null;
}

/**
 * Does this request path require a staff JWT, and at what level?
 * Returns: 'master' | 'staff' | null
 *   'master' — active master profile required
 *   'staff'  — active master OR designer required (the endpoint itself
 *              enforces finer-grained ownership, e.g. send-chat-message
 *              verifies the designer owns the target client)
 */
function gateLevelFor(pathname) {
  // Cron-secret-protected digest keeps its own auth — exempt so scheduled
  // sends don't break. (It never returns data to the caller beyond a
  // status blob, and it validates x-bayside-cron-secret itself.)
  if (pathname === '/api/admin-daily-digest') return null;

  if (pathname.startsWith('/api/admin-')) return 'master';
  // SPRINT 1.5B: designers send chat to their own clients through this
  // endpoint too. Middleware admits active staff; the endpoint verifies
  // the designer actually owns the client before inserting/emailing.
  if (pathname === '/api/send-chat-message') return 'staff';
  // SPRINT 4: the knowledge-base chat burns Anthropic tokens — staff only.
  if (pathname === '/api/help-chat') return 'staff';
  return null;
}

/**
 * Validates the caller: Bearer token must map to a real Supabase user
 * whose profiles row is active with an allowed role.
 *   level 'master' → role must be 'master'
 *   level 'staff'  → role must be 'master' or 'designer'
 * Returns { ok:true, userId, role } or { ok:false, status, error }.
 */
async function validateStaff(request, env, level) {
  const key = serviceKey(env);
  if (!env.SUPABASE_URL || !key) {
    // Fail CLOSED — a misconfigured gate must never become an open gate.
    console.error('[api middleware] SUPABASE_URL / service key missing');
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return { ok: false, status: 401, error: 'Unauthorized — missing bearer token' };
  }

  // 1) Resolve the token to a user via Supabase Auth.
  let userId = null;
  try {
    const resp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      return { ok: false, status: 401, error: 'Unauthorized — invalid or expired session' };
    }
    const user = await resp.json();
    userId = user && user.id;
    if (!userId) {
      return { ok: false, status: 401, error: 'Unauthorized — invalid session' };
    }
  } catch (e) {
    console.error('[api middleware] auth lookup failed:', e);
    return { ok: false, status: 500, error: 'Auth service unreachable' };
  }

  // 2) Load the profile with the service key (bypasses RLS reliably) and
  //    require an active master. After the Sprint 1 decouple, the /admin/
  //    surface — and therefore its APIs — is master-only.
  try {
    const resp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role,is_active,company_id&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!resp.ok) {
      const detail = await resp.text();
      console.error('[api middleware] profile lookup failed:', resp.status, detail);
      return { ok: false, status: 500, error: 'Profile lookup failed' };
    }
    const rows = await resp.json();
    const profile = Array.isArray(rows) ? rows[0] : null;
    const roleOk = profile && (
      level === 'staff'
        ? (profile.role === 'master' || profile.role === 'designer')
        : profile.role === 'master'
    );
    if (!profile || profile.is_active === false || !roleOk) {
      const need = level === 'staff' ? 'staff' : 'master';
      return { ok: false, status: 403, error: `Forbidden — ${need} access required` };
    }
    // STAGE 3 (multi-tenancy): the legacy admin APIs query with the service
    // role and are company-blind, so they stay locked to the founding
    // company until each is made tenant-aware. Other tenants' owners use
    // the designer app, where company-scoped RLS does the isolation.
    if (level === 'master' && profile.company_id !== FOUNDING_COMPANY_ID) {
      return { ok: false, status: 403, error: 'The admin console is not available for your workspace' };
    }
    // SPRINT 7: suspended workspaces lose API access for staff.
    if (profile.company_id) {
      try {
        const cResp = await fetch(
          `${env.SUPABASE_URL}/rest/v1/companies?id=eq.${encodeURIComponent(profile.company_id)}&select=status&limit=1`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (cResp.ok) {
          const cRows = await cResp.json();
          if (cRows && cRows[0] && cRows[0].status === 'suspended') {
            return { ok: false, status: 403, error: 'Workspace suspended — update billing to restore access' };
          }
        }
      } catch (_) { /* fail open on status lookup; RLS still protects data */ }
    }
    return { ok: true, userId, role: profile.role, companyId: profile.company_id };
  } catch (e) {
    console.error('[api middleware] profile lookup error:', e);
    return { ok: false, status: 500, error: 'Profile lookup failed' };
  }
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const pathname = new URL(request.url).pathname;

  // CORS preflights carry no auth headers by design — always let them
  // through so browsers can complete the preflight, then the real request
  // gets validated.
  if (request.method === 'OPTIONS') return next();

  const level = gateLevelFor(pathname);
  if (!level) return next();

  const result = await validateStaff(request, env, level);
  if (!result.ok) {
    return jsonResponse({ error: result.error }, result.status);
  }

  return next();
}
