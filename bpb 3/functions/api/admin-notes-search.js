/**
 * BPB Sprint 16 — /api/admin-notes-search
 *
 * Searches client notes (current + history) for a keyword.
 * GET /api/admin-notes-search?q=<term>&limit=30
 *
 * Auth: Supabase JWT in Authorization header, role 'master' or 'designer'.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
    return json({ error: 'SUPABASE config missing' }, 500);
  }

  // ── Auth: validate JWT + check role
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const token = authHeader.slice(7);

  const userResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userResp.ok) return json({ error: 'Invalid session' }, 401);
  const user = await userResp.json();
  if (!user?.id) return json({ error: 'No user' }, 401);

  const profResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  const profs = await profResp.json();
  if (!profs?.[0] || !['master', 'designer'].includes(profs[0].role)) {
    return json({ error: 'Forbidden' }, 403);
  }

  // ── Parse query
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '30', 10), 1), 100);

  if (!q || q.length < 2) {
    return json({ success: true, query: q, total: 0, results: [] });
  }

  // ── Call search RPC via service role
  const rpcResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/rpc/admin_notes_search`,
    {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_query: q, p_limit: limit }),
    }
  );

  if (!rpcResp.ok) {
    const err = await rpcResp.text();
    return json({ error: 'RPC failed', detail: err }, 500);
  }

  const results = await rpcResp.json();
  return json({ success: true, query: q, total: results.length, results });
}
