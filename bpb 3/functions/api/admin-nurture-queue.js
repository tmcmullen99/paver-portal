/**
 * BPB Sprint 21 — /api/admin-nurture-queue
 *
 * Returns the 7-day (or N-day, capped at 30) nurture forecast.
 * Auth: requires a valid Supabase JWT in Authorization: Bearer <token>.
 *       Caller must have role IN ('master', 'designer').
 *
 * GET /api/admin-nurture-queue?days=7
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

export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'Supabase config missing' }, 500);
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return jsonResponse({ error: 'Unauthorized — missing bearer token' }, 401);

  // Verify JWT + load role via /auth/v1/user
  const userResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userResp.ok) return jsonResponse({ error: 'Unauthorized — invalid token' }, 401);
  const user = await userResp.json();

  // Role check
  const profileResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!profileResp.ok) {
    return jsonResponse({ error: 'Failed to load profile' }, 500);
  }
  const profiles = await profileResp.json();
  const role = profiles?.[0]?.role;
  if (!role || (role !== 'master' && role !== 'designer')) {
    return jsonResponse({ error: 'Forbidden — admin role required' }, 403);
  }

  const url = new URL(request.url);
  let days = parseInt(url.searchParams.get('days') || '7', 10);
  if (!Number.isFinite(days) || days < 1) days = 7;
  if (days > 30) days = 30;

  // Call the RPC with service role
  const rpcResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_nurture_queue_forecast`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_days: days }),
  });

  if (!rpcResp.ok) {
    const detail = await rpcResp.text();
    return jsonResponse({ error: 'Forecast RPC failed', detail }, 500);
  }

  const data = await rpcResp.json();
  return jsonResponse(data);
}
