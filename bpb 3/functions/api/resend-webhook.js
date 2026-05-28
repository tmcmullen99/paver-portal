// ═══════════════════════════════════════════════════════════════════════════
// POST /api/resend-webhook — Resend event ingestion (opens, clicks, bounces)
//
// Verifies the Svix signature on each Resend event, then records it via the
// record_email_event RPC (stamps engagement cols on notification_queue +
// appends to email_events).
//
// Auth: Svix signature headers verified against env.RESEND_WEBHOOK_SECRET.
// ═══════════════════════════════════════════════════════════════════════════

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  if (!env.RESEND_WEBHOOK_SECRET) return json(500, { error: 'RESEND_WEBHOOK_SECRET not configured' });
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Supabase env missing' });

  const payload       = await request.text();
  const svixId        = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  const svixSignature = request.headers.get('svix-signature');
  if (!svixId || !svixTimestamp || !svixSignature) return json(400, { error: 'Missing svix headers' });

  const ageSec = Math.abs(Date.now() / 1000 - Number(svixTimestamp));
  if (Number.isFinite(ageSec) && ageSec > 300) return json(400, { error: 'Stale timestamp' });

  const verified = await verifySvix(env.RESEND_WEBHOOK_SECRET, svixId, svixTimestamp, payload, svixSignature);
  if (!verified) return json(400, { error: 'Invalid signature' });

  let evt;
  try { evt = JSON.parse(payload); } catch { return json(400, { error: 'Bad JSON' }); }

  const type = evt.type;
  const data = evt.data || {};
  const messageId = data.email_id;
  if (!messageId) return json(200, { ok: true, skipped: 'no email_id' });

  let occurredAt = evt.created_at || new Date().toISOString();
  let linkUrl = null, userAgent = null, ip = null;
  if (type === 'email.clicked' && data.click) {
    occurredAt = data.click.timestamp || occurredAt;
    linkUrl    = data.click.link      || null;
    userAgent  = data.click.userAgent || null;
    ip         = data.click.ipAddress || null;
  } else if (type === 'email.opened' && data.open) {
    occurredAt = data.open.timestamp || occurredAt;
    userAgent  = data.open.userAgent || null;
    ip         = data.open.ipAddress || null;
  }

  const rpcResp = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/record_email_event', {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_message_id:  messageId,
      p_event_type:  type,
      p_occurred_at: occurredAt,
      p_link_url:    linkUrl,
      p_user_agent:  userAgent,
      p_ip:          ip,
      p_raw:         evt,
    }),
  });

  if (!rpcResp.ok) {
    const txt = await rpcResp.text();
    return json(500, { error: 'record_email_event failed', detail: txt.slice(0, 240) });
  }
  return json(200, { ok: true, type, message_id: messageId });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, svix-id, svix-timestamp, svix-signature',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// ─── Svix signature verification via Web Crypto (no npm deps) ───
async function verifySvix(secret, id, timestamp, payload, sigHeader) {
  const keyB64   = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const keyBytes = base64ToBytes(keyB64);
  const key = await crypto.subtle.importKey('raw', keyBytes,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = id + '.' + timestamp + '.' + payload;
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const expected = bytesToBase64(new Uint8Array(sigBuf));
  return sigHeader.split(' ').some((p) => {
    const i = p.indexOf(',');
    return (i >= 0 ? p.slice(i + 1) : p) === expected;
  });
}
function base64ToBytes(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes) {
  let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
