// ═══════════════════════════════════════════════════════════════════════════
// /api/outreach-track — the measurement layer.
//   ?a=open&s={send_id}          → 1x1 pixel, stamps opened_at
//   ?a=click&s={send_id}&to=URL  → stamps clicked_at, flips prospect to
//                                  'clicked', 302 to destination
//   ?a=unsub&s={send_id}         → prospect → 'unsubscribed', friendly page
// No auth (these arrive from prospects' inboxes); send ids are UUIDs.
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ═══════════════════════════════════════════════════════════════════════════

const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
const svcKey = (env) => env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('a');
  const sendId = url.searchParams.get('s');

  const pixel = () => new Response(PIXEL, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' } });

  if (!env.SUPABASE_URL || !svcKey(env) || !UUID_RE.test(sendId || '')) {
    return action === 'open' ? pixel() : Response.redirect('https://paverportal.com/', 302);
  }

  const headers = {
    apikey: svcKey(env), Authorization: `Bearer ${svcKey(env)}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
  };
  const now = new Date().toISOString();

  const sendR = await fetch(
    `${env.SUPABASE_URL}/rest/v1/outreach_sends?id=eq.${sendId}&select=id,prospect_id,opened_at,clicked_at`, { headers });
  const send = (sendR.ok ? await sendR.json() : [])[0];

  if (action === 'open') {
    if (send && !send.opened_at) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/outreach_sends?id=eq.${sendId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ opened_at: now }),
      });
    }
    return pixel();
  }

  if (action === 'click') {
    let dest = url.searchParams.get('to') || 'https://paverportal.com/';
    try {
      const d = new URL(dest);
      if (!/^https?:$/.test(d.protocol)) dest = 'https://paverportal.com/';
    } catch (_) { dest = 'https://paverportal.com/'; }
    if (send) {
      await Promise.all([
        fetch(`${env.SUPABASE_URL}/rest/v1/outreach_sends?id=eq.${sendId}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ clicked_at: send.clicked_at || now, opened_at: send.opened_at || now }),
        }),
        fetch(`${env.SUPABASE_URL}/rest/v1/prospects?id=eq.${send.prospect_id}&status=in.(new,in_sequence,completed)`, {
          method: 'PATCH', headers, body: JSON.stringify({ status: 'clicked', updated_at: now }),
        }),
      ]);
    }
    return Response.redirect(dest, 302);
  }

  if (action === 'unsub') {
    if (send) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/prospects?id=eq.${send.prospect_id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ status: 'unsubscribed', next_send_at: null, updated_at: now }),
      });
    }
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed</title></head>
       <body style="font-family:Arial,sans-serif;background:#faf6ee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
       <div style="background:#fff;border:1px solid #e5e0d6;border-radius:14px;padding:34px;max-width:420px;text-align:center;">
       <h2 style="color:#33281c;margin:0 0 8px;">You're unsubscribed ✓</h2>
       <p style="color:#6f6a60;font-size:14px;">No more emails from Paver Portal. If you ever want a look anyway — <a href="https://paverportal.com" style="color:#7d5c31;">paverportal.com</a>. Good selling out there.</p>
       </div></body></html>`,
      { headers: { 'Content-Type': 'text/html' } });
  }

  return Response.redirect('https://paverportal.com/', 302);
}
