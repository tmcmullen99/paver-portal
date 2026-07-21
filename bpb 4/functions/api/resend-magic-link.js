/**
 * BPB Sprint 5 — /api/resend-magic-link
 * The Silent Failure Killer · Piece 2
 *
 * Standalone "send the magic-link invite to a client" endpoint. Used by the
 * admin Resend Invite tool to manually recover Yorktown-style stalls, and
 * can also be called from anywhere else that needs to re-send an account
 * invite (e.g. cron jobs, automation rules).
 *
 * Body (JSON) — at least ONE identifier required
 *   {
 *     client_id:   uuid    (optional) — preferred, exact match
 *     email:       text    (optional) — fallback lookup
 *     note:        text    (optional, max 800 chars) — short personal note
 *                          to include above the CTA; if omitted, a generic
 *                          friendly intro is used.
 *   }
 *
 * Env vars (Cloudflare Pages)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, RESEND_FROM_EMAIL
 *
 * Response
 *   { ok, client: {id, name, email}, email_sent, magic_link_generated }
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const PORTAL_BASE = 'https://portal-baysidepavers.com';
const TIM_REPLY_TO = 'tim@mcmullen.properties';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function clamp(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max);
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const client_id = clamp(body.client_id, 36);
  const email     = clamp(body.email, 200).toLowerCase();
  const note      = clamp(body.note, 800);

  if (!client_id && !email) {
    return jsonResponse({ error: 'Provide client_id or email' }, 400);
  }
  if (client_id && !UUID_RE.test(client_id)) {
    return jsonResponse({ error: 'client_id must be a valid UUID' }, 400);
  }
  if (email && !EMAIL_RE.test(email)) {
    return jsonResponse({ error: 'email must be a valid address' }, 400);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('resend-magic-link: SUPABASE config missing');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    return jsonResponse(
      { error: 'Resend not configured. Set RESEND_API_KEY + RESEND_FROM_EMAIL env vars.' },
      500
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // 1. Look up the client (prefer client_id when both provided)
  // ──────────────────────────────────────────────────────────────────
  const lookupKey = client_id
    ? `id=eq.${encodeURIComponent(client_id)}`
    : `email=eq.${encodeURIComponent(email)}`;

  const clientResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/clients?${lookupKey}&deleted_at=is.null&select=id,name,email,account_setup_at,user_id`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!clientResp.ok) {
    const errText = await clientResp.text();
    console.error('Client lookup failed:', clientResp.status, errText);
    return jsonResponse({ error: 'Could not look up client' }, 500);
  }
  const clientRows = await clientResp.json();
  if (!clientRows || !clientRows[0]) {
    return jsonResponse({ error: 'Client not found' }, 404);
  }
  const client = clientRows[0];

  // If the client has already activated their account, this is almost certainly
  // a misclick — surface a soft warning instead of silently sending another link.
  if (client.account_setup_at) {
    return jsonResponse({
      ok: false,
      warning: 'This client already has an active account. Magic link not sent.',
      client: { id: client.id, name: client.name, email: client.email, account_setup_at: client.account_setup_at },
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // 2. Generate the magic link
  // ──────────────────────────────────────────────────────────────────
  let magicLink = null;
  try {
    magicLink = await generateMagicLink(env, client);
  } catch (e) {
    console.error('Magic link generation failed:', e);
  }

  if (!magicLink) {
    return jsonResponse({
      ok: false,
      error: 'Could not generate magic link. Check the Cloudflare logs for the underlying Supabase error.',
      client: { id: client.id, name: client.name, email: client.email },
    }, 500);
  }

  // ──────────────────────────────────────────────────────────────────
  // 3. Send the email
  // ──────────────────────────────────────────────────────────────────
  const email_sent = await sendInviteEmail(env, client, magicLink, note);

  return jsonResponse({
    ok: email_sent,
    client: { id: client.id, name: client.name, email: client.email },
    email_sent,
    magic_link_generated: true,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Magic-link generation — same pattern as send-chat-message.js
// ──────────────────────────────────────────────────────────────────────────

async function generateMagicLink(env, client) {
  const redirectTo = `${PORTAL_BASE}/client/dashboard.html`;
  const linkType = client.user_id ? 'magiclink' : 'invite';

  const resp = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: linkType,
      email: client.email,
      options: { redirectTo },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    if (linkType === 'invite' && /already|exists|registered/i.test(errText)) {
      return generateMagicLink(env, { ...client, user_id: 'forced' });
    }
    console.error(`generate_link (${linkType}) failed:`, resp.status, errText);
    return null;
  }

  const data = await resp.json();
  return (data && data.properties && data.properties.action_link) || data.action_link || null;
}

// ──────────────────────────────────────────────────────────────────────────
// Email composition — branded invite/re-invite email
// ──────────────────────────────────────────────────────────────────────────

async function sendInviteEmail(env, client, magicLink, note) {
  const firstName = ((client.name || '').trim().split(/\s+/)[0]) || 'there';
  const subject = `🔓 Your Paver Portal Portal account is ready, ${firstName}`;

  const noteBlock = note
    ? `\n${note}\n`
    : `\nTim from Paver Portal set up a Paver Portal Portal account for you so you can review your proposal, request changes, and lock in your project — all in one place.\n`;

  const text = [
    `Hi ${firstName},`,
    noteBlock,
    `Click the link below to sign in (no password needed):`,
    `${magicLink}`,
    ``,
    `Once you're in you can:`,
    `  • See your proposal in full detail`,
    `  • Request material changes or design tweaks`,
    `  • Lock in your project when you're ready`,
    ``,
    `Questions before signing in? Just reply to this email — Tim will get it directly.`,
    ``,
    `— Paver Portal Portal`,
  ].join('\n');

  const noteHtml = note
    ? `<div style="background:#faf8f3;border-left:3px solid #9c7440;padding:14px 16px;margin-bottom:22px;border-radius:4px;font-size:14px;line-height:1.55;color:#0e1218;">${esc(note).replace(/\r?\n/g, '<br>')}</div>`
    : `<p style="font-size:15px;line-height:1.6;color:#0e1218;margin:0 0 22px;">Tim from Paver Portal set up a Paver Portal Portal account for you so you can review your proposal, request changes, and lock in your project — all in one place.</p>`;

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Inter','Onest',sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#0e1218;background:#fff;">
  <div style="border-bottom:3px solid #9c7440;padding-bottom:14px;margin-bottom:22px;">
    <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#9c7440;font-weight:700;margin-bottom:6px;">YOUR PAVER PORTAL PORTAL ACCOUNT</div>
    <h1 style="font-size:22px;margin:0;color:#0e1218;line-height:1.3;font-weight:600;">Hi ${esc(firstName)} — your account is ready.</h1>
  </div>

  ${noteHtml}

  <div style="margin:24px 0;text-align:center;">
    <a href="${esc(magicLink)}" style="display:inline-block;background:#9c7440;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">Sign in to Paver Portal Portal →</a>
    <div style="font-size:12px;color:#999;margin-top:10px;">No password needed · 2 minutes to set up</div>
  </div>

  <div style="background:#f7f8f5;border-radius:8px;padding:16px 18px;margin:24px 0;font-size:13px;color:#4a5450;line-height:1.6;">
    <strong style="color:#0e1218;display:block;margin-bottom:8px;">Once you're in, you can:</strong>
    • See your proposal in full detail<br>
    • Request material changes or design tweaks<br>
    • Lock in your project when you're ready
  </div>

  <div style="font-size:13px;color:#666;line-height:1.55;margin-bottom:18px;">
    Questions before signing in? Just reply to this email — Tim will get it directly.
  </div>

  <div style="border-top:1px solid #eee;padding-top:14px;color:#999;font-size:11px;line-height:1.5;text-align:center;">
    Paver Portal Portal · McMullen Properties
  </div>
</div>`.trim();

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:     env.RESEND_FROM_EMAIL,
        to:       [client.email],
        reply_to: TIM_REPLY_TO,
        subject,
        text,
        html,
      }),
    });
    if (resp.ok) return true;
    const errText = await resp.text();
    console.error('Resend invite email failed:', resp.status, errText);
    return false;
  } catch (e) {
    console.error('Resend exception (invite):', e);
    return false;
  }
}
