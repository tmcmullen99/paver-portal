// POST /api/grant-portal-access  { client_id }
// Master-gated. Mints a Supabase Auth invite (creating the homeowner's auth user)
// and queues the branded portal-access email through queue_portal_access_invite.

export async function onRequestPost({ request, env }) {
  // ── 1. Authenticate caller ────────────────────────────────────────────
  const authHeader = request.headers.get('authorization') || '';
  if (!/^Bearer\s+/i.test(authHeader)) return j({ error: 'unauthorized' }, 401);
  const jwt = authHeader.replace(/^Bearer\s+/i, '');

  const meResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!meResp.ok) return j({ error: 'invalid_token' }, 401);
  const me = await meResp.json();

  const profResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${me.id}&select=role,is_active`,
    { headers: svc(env) }
  );
  const profs = await profResp.json();
  if (!profs?.[0] || profs[0].role !== 'master' || !profs[0].is_active) {
    return j({ error: 'forbidden' }, 403);
  }

  // ── 2. Body ────────────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); } catch { return j({ error: 'invalid_json' }, 400); }
  const clientId = body?.client_id;
  if (!clientId) return j({ error: 'missing_client_id' }, 400);

  // ── 3. Look up client ──────────────────────────────────────────────────
  const cResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}&select=email,name,user_id`,
    { headers: svc(env) }
  );
  const cs = await cResp.json();
  if (!cs?.[0]) return j({ error: 'client_not_found' }, 404);
  const client = cs[0];
  if (!client.email) return j({ error: 'client_email_missing' }, 400);
  if (client.user_id) return j({ error: 'already_has_account' }, 409);

  // ── 4. Mint invite link via Auth admin ─────────────────────────────────
  const redirectTo = `${env.PUBLIC_BASE_URL || 'https://portal-baysidepavers.com'}/portal/welcome`;
  const linkResp = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { ...svc(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'invite',
      email: client.email,
      options: { redirect_to: redirectTo },
    }),
  });
  if (!linkResp.ok) {
    const detail = await linkResp.text();
    return j({ error: 'invite_failed', status: linkResp.status, detail }, 500);
  }
  const linkData = await linkResp.json();
  const actionLink = linkData?.action_link || linkData?.properties?.action_link;
  if (!actionLink) return j({ error: 'no_link_returned' }, 500);

  // ── 5. Queue the branded portal_access email (RPC under caller's JWT) ──
  const rpcResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/queue_portal_access_invite`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_client_id: clientId, p_set_password_link: actionLink }),
  });
  if (!rpcResp.ok) {
    const detail = await rpcResp.text();
    return j({ error: 'queue_failed', status: rpcResp.status, detail }, 500);
  }
  const rpcData = await rpcResp.json();
  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  if (result?.error) return j({ error: result.error }, 400);

  return j({ ok: true, queue_id: result?.queue_id, client: client.name });
}

function svc(env) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
}
function j(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
