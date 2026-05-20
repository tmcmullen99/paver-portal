/**
 * BPB Sprint 12B — /api/admin-client-notes
 *
 * Saves designer notes for one client. Updates clients.notes + clients.updated_at.
 *
 * POST body: { client_id (uuid), notes (string, max 50000 chars) }
 * Returns:   { success: true, client_id, notes, updated_at }
 *
 * Notes can be empty string (clears existing notes). Validates UUID + length.
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTES_LEN = 50000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('admin-client-notes: SUPABASE config missing');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const clientId = (body.client_id || '').trim();
  if (!UUID_RE.test(clientId)) {
    return jsonResponse({ error: 'client_id is required and must be a UUID' }, 400);
  }

  // notes can be empty string (clears notes) or null. Coerce to string.
  let notes = body.notes;
  if (notes === undefined || notes === null) notes = '';
  if (typeof notes !== 'string') {
    return jsonResponse({ error: 'notes must be a string' }, 400);
  }
  if (notes.length > MAX_NOTES_LEN) {
    return jsonResponse({ error: `notes too long (max ${MAX_NOTES_LEN} chars)` }, 400);
  }

  // Convert empty string to null in the column for cleanliness
  const notesValue = notes.trim() === '' ? null : notes;

  try {
    const resp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&deleted_at=is.null&select=id,notes,updated_at`,
      {
        method: 'PATCH',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify({
          notes: notesValue,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('clients PATCH failed:', resp.status, errText);
      return jsonResponse({ error: 'Database update failed', detail: errText }, 500);
    }

    const rows = await resp.json();
    if (!rows || rows.length === 0) {
      return jsonResponse({ error: 'Client not found' }, 404);
    }

    const updated = rows[0];
    return jsonResponse({
      success: true,
      client_id: updated.id,
      notes: updated.notes,
      updated_at: updated.updated_at,
    });
  } catch (e) {
    console.error('admin-client-notes handler error:', e);
    return jsonResponse({ error: 'Internal error', detail: String(e) }, 500);
  }
}
