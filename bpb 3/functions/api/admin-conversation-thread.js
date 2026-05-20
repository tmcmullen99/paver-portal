/**
 * BPB Sprint 8 — /api/admin-conversation-thread?client_id=<uuid>
 *
 * Returns the JSONB blob from public.admin_conversation_thread(uuid) RPC:
 *   { generated_at, client, latest_proposal, messages: [{id, body, created_at, sender_role, ...}] }
 *
 * Used by the Conversations admin page's right-pane when a thread is opened.
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('admin-conversation-thread: SUPABASE config missing');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  const url = new URL(request.url);
  const clientId = (url.searchParams.get('client_id') || '').trim();
  if (!UUID_RE.test(clientId)) {
    return jsonResponse({ error: 'client_id query param is required and must be a UUID' }, 400);
  }

  try {
    const resp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/rpc/admin_conversation_thread`,
      {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_client_id: clientId }),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('admin_conversation_thread RPC failed:', resp.status, errText);
      return jsonResponse({ error: 'Database query failed', detail: errText }, 500);
    }

    const data = await resp.json();
    if (!data || !data.client) {
      return jsonResponse({ error: 'Client not found' }, 404);
    }
    return jsonResponse(data);
  } catch (e) {
    console.error('admin-conversation-thread handler error:', e);
    return jsonResponse({ error: 'Internal error', detail: String(e) }, 500);
  }
}
