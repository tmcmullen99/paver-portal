/**
 * BPB Sprint 6 — /api/admin-inbox
 * Designer Inbox aggregation endpoint.
 *
 * GET → returns the JSONB blob from public.admin_inbox_state() RPC. The RPC
 * runs SECURITY DEFINER (bypasses RLS) and is GRANTed only to service_role,
 * so this endpoint is the only public-facing way to read it.
 *
 * Returns one combined payload — no need for the client to make 7 parallel
 * REST calls.
 *
 * Auth: NONE at the API layer (matches the pattern of other /api/admin-*
 * endpoints). The /admin/ tree should be locked down at the network layer
 * via Cloudflare Access if you want hard auth.
 *
 * Env vars (Cloudflare Pages):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('admin-inbox: SUPABASE config missing');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  try {
    const resp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/rpc/admin_inbox_state`,
      {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('admin_inbox_state RPC failed:', resp.status, errText);
      return jsonResponse({ error: 'Database query failed', detail: errText }, 500);
    }

    const data = await resp.json();
    return jsonResponse(data);
  } catch (e) {
    console.error('admin-inbox handler error:', e);
    return jsonResponse({ error: 'Internal error', detail: String(e) }, 500);
  }
}
