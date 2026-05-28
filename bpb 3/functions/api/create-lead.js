// POST /api/create-lead { name, email, phone?, address?, notes?, project_type?, project_type_friendly? }
// Master/designer-gated. Orchestrates: client insert → mint invite link →
// queue welcome+portal email → schedule 3-day in-portal nurture.

export async function onRequestPost({ request, env }) {
  // ── 1. Authenticate caller ────────────────────────────────────────────
  const authHeader = request.headers.get('authorization') || '';
  if (!/^Bearer\s+/i.test(authHeader)) return j({ error: 'unauthorized' }, 401);
  const jwt = authHeader.replace(/^Bearer\s+/i, '');

  // (Role check happens inside the create_lead RPC — no need to repeat here.)

  // ── 2. Body ────────────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); } catch { return j({ error: 'invalid_json' }, 400); }
  const { name, email, phone, address, notes, project_type, project_type_friendly } = body || {};

  // ── 3. create_lead RPC (insert + schedule nurture) ─────────────────────
  const createResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/create_lead`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_name: name,
      p_email: email,
      p_phone: phone || null,
      p_address: address || null,
      p_notes: notes || null,
      p_project_type: project_type || null,
      p_project_type_friendly: project_type_friendly || null,
    }),
  });
  if (!createResp.ok) {
    const detail = await createResp.text();
    return j({ error: 'create_failed', detail }, 500);
  }
  const createData = await createResp.json();
  const created = Array.isArray(createData) ? createData[0] : createData;
  if (created?.error) return j(created, 400);
  const clientId = created?.client_id;
  if (!clientId) return j({ error: 'no_client_id' }, 500);

  // ── 4. Mint Supabase Auth invite link ──────────────────────────────────
  const redirectTo = `${env.PUBLIC_BASE_URL || 'https://portal-baysidepavers.com'}/portal/welcome`;
  const linkResp = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { ...svc(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'invite',
      email: (email || '').toLowerCase().trim(),
      options: { redirect_to: redirectTo },
    }),
  });
  if (!linkResp.ok) {
    const detail = await linkResp.text();
    return j({ ok: true, client_id: clientId, warning: 'invite_failed', detail }, 200);
  }
  const linkData = await linkResp.json();
  const actionLink = linkData?.action_link || linkData?.properties?.action_link;
  if (!actionLink) return j({ ok: true, client_id: clientId, warning: 'no_link_returned' }, 200);

  // ── 5. Queue the welcome+portal email ──────────────────────────────────
  const qResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/queue_portal_access_invite`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_client_id: clientId, p_set_password_link: actionLink }),
  });
  if (!qResp.ok) {
    const detail = await qResp.text();
    return j({ ok: true, client_id: clientId, warning: 'email_queue_failed', detail }, 200);
  }
  const qData = await qResp.json();
  const queued = Array.isArray(qData) ? qData[0] : qData;
  if (queued?.error) return j({ ok: true, client_id: clientId, warning: queued.error }, 200);

  return j({ ok: true, client_id: clientId, queue_id: queued?.queue_id });
}

function svc(env) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
}
function j(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
