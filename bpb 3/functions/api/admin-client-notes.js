/**
 * BPB Sprint 12B + 13 + 14 — /api/admin-client-notes
 *
 * Saves designer notes on a client. Two modes:
 *
 *   REPLACE  body: { client_id, notes,  created_by? }
 *            Sets clients.notes = notes (or null if empty).
 *
 *   APPEND   body: { client_id, append, created_by? }
 *            Prepends a timestamped entry to clients.notes.
 *            Used by the quick-add modal on Inbox/Today/Conversations.
 *
 * Every save inserts a snapshot row into client_notes_history with:
 *   action = 'edit' | 'append' | 'clear'
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
const MAX_NOTES_LEN  = 50000;
const MAX_APPEND_LEN = 5000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function formatStamp(d) {
  // 2026-05-20 · 8:42pm (Pacific). Worker is UTC by default; offset for Tim's TZ.
  const dt = new Date(d);
  const ymd = dt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // 2026-05-20
  const hm  = dt.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles',
  }).toLowerCase().replace(/\s+/g, '');
  return `${ymd} · ${hm}`;
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

  const clientId  = (body.client_id || '').trim();
  const createdBy = (body.created_by || '').trim() || null;
  if (!UUID_RE.test(clientId)) {
    return jsonResponse({ error: 'client_id is required and must be a UUID' }, 400);
  }
  if (createdBy && !UUID_RE.test(createdBy)) {
    return jsonResponse({ error: 'created_by must be a UUID if provided' }, 400);
  }

  const hasAppend  = typeof body.append === 'string' && body.append.trim().length > 0;
  const hasReplace = 'notes' in body;
  if (hasAppend && hasReplace) {
    return jsonResponse({ error: 'Provide either notes (replace) or append (prepend), not both' }, 400);
  }
  if (!hasAppend && !hasReplace) {
    return jsonResponse({ error: 'Provide notes (replace) or append (prepend)' }, 400);
  }

  // Length checks
  if (hasReplace && typeof body.notes !== 'string') {
    return jsonResponse({ error: 'notes must be a string' }, 400);
  }
  if (hasReplace && body.notes.length > MAX_NOTES_LEN) {
    return jsonResponse({ error: `notes too long (max ${MAX_NOTES_LEN} chars)` }, 400);
  }
  if (hasAppend && body.append.length > MAX_APPEND_LEN) {
    return jsonResponse({ error: `append entry too long (max ${MAX_APPEND_LEN} chars)` }, 400);
  }

  try {
    // ── 1. Look up existing notes if appending
    let existingNotes = null;
    if (hasAppend) {
      const lookupResp = await fetch(
        `${env.SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&deleted_at=is.null&select=notes`,
        {
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      if (!lookupResp.ok) {
        const errText = await lookupResp.text();
        console.error('Notes lookup failed:', lookupResp.status, errText);
        return jsonResponse({ error: 'Database lookup failed', detail: errText }, 500);
      }
      const rows = await lookupResp.json();
      if (!rows || rows.length === 0) {
        return jsonResponse({ error: 'Client not found' }, 404);
      }
      existingNotes = rows[0].notes || '';
    }

    // ── 2. Compute the new notes value + action
    let nextValue;
    let action;
    if (hasAppend) {
      const stamp = formatStamp(Date.now());
      const newEntry = `${stamp}\n${body.append.trim()}`;
      nextValue = existingNotes.trim()
        ? `${newEntry}\n\n${existingNotes}`
        : newEntry;
      if (nextValue.length > MAX_NOTES_LEN) {
        // Truncate to fit — keep newest, drop oldest tail
        nextValue = nextValue.slice(0, MAX_NOTES_LEN - 200) + '\n\n…(older notes truncated to fit storage limit)';
      }
      action = 'append';
    } else {
      const trimmed = body.notes.trim();
      nextValue = trimmed === '' ? null : body.notes;
      action = trimmed === '' ? 'clear' : 'edit';
    }

    // ── 3. UPDATE clients.notes
    const updateResp = await fetch(
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
          notes: nextValue,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!updateResp.ok) {
      const errText = await updateResp.text();
      console.error('clients PATCH failed:', updateResp.status, errText);
      return jsonResponse({ error: 'Database update failed', detail: errText }, 500);
    }
    const updatedRows = await updateResp.json();
    if (!updatedRows || updatedRows.length === 0) {
      return jsonResponse({ error: 'Client not found' }, 404);
    }
    const updated = updatedRows[0];

    // ── 4. Log to history (non-blocking — we don't fail the user if logging fails)
    try {
      const historyBody = action === 'append' ? body.append.trim() : (nextValue || '');
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/client_notes_history`,
        {
          method: 'POST',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({
            client_id:  clientId,
            body:       historyBody,
            action,
            created_by: createdBy,
          }),
        }
      );
    } catch (logErr) {
      console.error('notes history log failed (non-fatal):', logErr);
    }

    return jsonResponse({
      success:    true,
      client_id:  updated.id,
      notes:      updated.notes,
      updated_at: updated.updated_at,
      action,
    });
  } catch (e) {
    console.error('admin-client-notes handler error:', e);
    return jsonResponse({ error: 'Internal error', detail: String(e) }, 500);
  }
}
