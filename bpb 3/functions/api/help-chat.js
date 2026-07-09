/**
 * BPB — /api/send-chat-message  (SPRINT 1.5B security rewrite)
 *
 * Staff chat-send with auto-email fallback.
 *
 * SECURITY (what changed in 1.5B):
 *   • The old version trusted sender_user_id and sender_role from the
 *     request body and required NO authentication — anyone could post a
 *     message into any client thread as "master". Now:
 *   • The Cloudflare middleware admits only active master/designer JWTs.
 *   • This endpoint derives the sender's identity ENTIRELY from the
 *     validated JWT — sender_user_id and sender_role in the body are
 *     ignored.
 *   • Designers may only message clients they own: clients they created,
 *     or clients linked (via client_proposals) to a proposal they own.
 *     Masters may message any client.
 *
 * Behavior
 *   1. ALWAYS inserts a row into client_messages.
 *   2. If clients.account_setup_at IS NULL (the client has never signed in),
 *      ALSO fires a Resend email with the message body + a magic-link CTA.
 *
 * Body (JSON)
 *   {
 *     client_id: uuid  (required) — target client
 *     body:      text  (required, max 5000 chars)
 *   }
 *
 * Env vars (Cloudflare Pages)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, RESEND_FROM_EMAIL
 *
 * Response
 *   { ok, message_id, email_sent, client_has_account, fallback_path }
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
// SPRINT 2B: brand identity comes from company_settings (single row) so
// white-labeling never requires touching this function again. These are
// last-resort fallbacks only.
const FALLBACK_PORTAL_BASE = 'https://portal-baysidepavers.com';
const FALLBACK_REPLY_TO = 'tim@mcmullen.properties';

async function loadCompanySettings(env, companyId) {
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  const fields = 'select=company_name,portal_base_url,reply_to_email,from_email_name';
  try {
    // STAGE 4: emails carry the CLIENT's company branding.
    if (companyId) {
      const resp = await fetch(
        `${env.SUPABASE_URL}/rest/v1/company_settings?company_id=eq.${encodeURIComponent(companyId)}&${fields}&limit=1`,
        { headers }
      );
      if (resp.ok) {
        const rows = await resp.json();
        if (rows && rows[0]) return rows[0];
      }
    }
    const fallback = await fetch(`${env.SUPABASE_URL}/rest/v1/company_settings?id=eq.1&${fields}&limit=1`, { headers });
    if (fallback.ok) {
      const rows = await fallback.json();
      if (rows && rows[0]) return rows[0];
    }
  } catch (e) {
    console.error('company_settings load failed (using fallbacks):', e);
  }
  return {};
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const client_id   = clamp(body.client_id, 36);
  const messageBody = clamp(body.body, 5000);

  if (!UUID_RE.test(client_id)) return jsonResponse({ error: 'client_id is required and must be a UUID' }, 400);
  if (!messageBody)             return jsonResponse({ error: 'body is required' }, 400);

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('send-chat-message: SUPABASE config missing');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  // ──────────────────────────────────────────────────────────────────
  // 0. Identify the sender from the validated JWT. The middleware has
  //    already confirmed this is an active master or designer; here we
  //    resolve WHO they are and enforce client ownership for designers.
  //    sender_user_id / sender_role from the request body are IGNORED.
  // ──────────────────────────────────────────────────────────────────
  const sender = await resolveSender(request, env);
  if (!sender.ok) return jsonResponse({ error: sender.error }, sender.status);
  const sender_user_id = sender.userId;
  const sender_role    = sender.role;            // 'master' | 'designer'

  if (sender_role === 'designer') {
    const owns = await designerOwnsClient(env, sender_user_id, client_id);
    if (!owns) {
      return jsonResponse({ error: 'Forbidden — this client is not assigned to you' }, 403);
    }
  } else {
    // Master: company boundary (Stage 3 multi-tenancy)
    const sameCompany = await clientInCompany(env, client_id, sender.companyId);
    if (!sameCompany) {
      return jsonResponse({ error: 'Forbidden — this client is not in your workspace' }, 403);
    }
  }



  const sbHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Prefer: 'return=representation',
  };

  // ──────────────────────────────────────────────────────────────────
  // 1. Look up the client (need name, email, account_setup_at, user_id)
  // ──────────────────────────────────────────────────────────────────
  const clientResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(client_id)}&deleted_at=is.null&select=id,name,email,account_setup_at,user_id,company_id`,
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

  // STAGE 4: branding follows the client's company
  const settings = await loadCompanySettings(env, client.company_id);

  // ──────────────────────────────────────────────────────────────────
  // 2. Insert the chat message (service role bypasses RLS)
  // ──────────────────────────────────────────────────────────────────
  const msgResp = await fetch(`${env.SUPABASE_URL}/rest/v1/client_messages`, {
    method: 'POST',
    headers: sbHeaders,
    body: JSON.stringify({
      client_id,
      sender_user_id,
      sender_role,
      body: messageBody,
    }),
  });

  if (!msgResp.ok) {
    const errText = await msgResp.text();
    console.error('client_messages insert failed:', msgResp.status, errText);
    return jsonResponse({ error: 'Could not save message', detail: errText }, 500);
  }

  const inserted = await msgResp.json();
  const message_id = (inserted && inserted[0] && inserted[0].id) || null;

  // ──────────────────────────────────────────────────────────────────
  // 3. Email fallback for clients who haven't activated their account
  // ──────────────────────────────────────────────────────────────────
  let email_sent = false;
  let fallback_path = 'none';

  if (!client.account_setup_at) {
    fallback_path = 'email';
    if (env.RESEND_API_KEY && env.RESEND_FROM_EMAIL) {
      try {
        const magicLink = await generateMagicLink(env, client, settings);
        if (magicLink) {
          email_sent = await sendChatMessageEmail(env, client, messageBody, magicLink, sender, settings);
        }
      } catch (e) {
        console.error('Chat email fallback failed (non-fatal):', e);
      }
    } else {
      console.log('send-chat-message: Resend not fully configured, email skipped.');
    }
  }

  return jsonResponse({
    ok: true,
    message_id,
    email_sent,
    client_has_account: !!client.account_setup_at,
    fallback_path,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// SPRINT 1.5B — sender resolution + designer ownership enforcement
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolves the caller's identity from the Bearer token. The middleware
 * already validated the token maps to an active staff profile; this
 * re-resolves so the endpoint never trusts client-supplied identity.
 * Returns { ok, userId, role, displayName, email } or { ok:false, ... }.
 */
async function resolveSender(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { ok: false, status: 401, error: 'Unauthorized — missing bearer token' };

  const userResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userResp.ok) return { ok: false, status: 401, error: 'Unauthorized — invalid session' };
  const user = await userResp.json();
  if (!user || !user.id) return { ok: false, status: 401, error: 'Unauthorized — invalid session' };

  const profResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role,is_active,display_name,email,company_id&limit=1`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!profResp.ok) return { ok: false, status: 500, error: 'Profile lookup failed' };
  const rows = await profResp.json();
  const profile = Array.isArray(rows) ? rows[0] : null;
  if (!profile || profile.is_active === false || !['master', 'designer'].includes(profile.role)) {
    return { ok: false, status: 403, error: 'Forbidden — staff access required' };
  }

  return {
    ok: true,
    userId: user.id,
    role: profile.role,
    companyId: profile.company_id || null,
    displayName: profile.display_name || null,
    email: profile.email || user.email || null,
  };
}

/**
 * STAGE 3: masters may only message clients inside their own company.
 */
async function clientInCompany(env, clientId, companyId) {
  if (!companyId) return false;
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&company_id=eq.${encodeURIComponent(companyId)}&select=id&limit=1`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!resp.ok) return false;
  const rows = await resp.json();
  return !!(rows && rows[0]);
}

/**
 * A designer owns a client when they created the client OR the client is
 * linked (via client_proposals) to a proposal the designer owns.
 */
async function designerOwnsClient(env, designerId, clientId) {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  const createdResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&created_by=eq.${encodeURIComponent(designerId)}&select=id&limit=1`,
    { headers }
  );
  if (createdResp.ok) {
    const rows = await createdResp.json();
    if (rows && rows[0]) return true;
  }

  const linkResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/client_proposals?client_id=eq.${encodeURIComponent(clientId)}&select=proposal_id,proposals!inner(owner_user_id)&proposals.owner_user_id=eq.${encodeURIComponent(designerId)}&limit=1`,
    { headers }
  );
  if (linkResp.ok) {
    const rows = await linkResp.json();
    if (rows && rows[0]) return true;
  }

  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// Magic-link generation
//
// If the client has a Supabase user_id, use type=magiclink. Otherwise use
// type=invite to create the user. If 'invite' is rejected because the user
// already exists in auth.users, recurse once with the user_id forced.
// ──────────────────────────────────────────────────────────────────────────

async function generateMagicLink(env, client, settings = {}) {
  const portalBase = settings.portal_base_url || FALLBACK_PORTAL_BASE;
  const redirectTo = `${portalBase}/client/dashboard.html`;
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
      return generateMagicLink(env, { ...client, user_id: 'forced' }, settings);
    }
    console.error(`generate_link (${linkType}) failed:`, resp.status, errText);
    return null;
  }

  const data = await resp.json();
  return (data && data.properties && data.properties.action_link) || data.action_link || null;
}

// ──────────────────────────────────────────────────────────────────────────
// Email composition — branded chat-message fallback
// ──────────────────────────────────────────────────────────────────────────

async function sendChatMessageEmail(env, client, messageBody, magicLink, sender, settings = {}) {
  const companyName = settings.company_name || 'Paver Portal';
  const portalName  = settings.from_email_name || (companyName + ' Portal');
  const firstName = ((client.name || '').trim().split(/\s+/)[0]) || 'there';
  // SPRINT 1.5B: personalize by actual sender (designer or master) instead
  // of the hardcoded "Tim". Falls back gracefully.
  const senderName = (sender && sender.displayName) || 'your designer';
  const senderFirst = String(senderName).trim().split(/\s+/)[0] || 'Your designer';
  const replyTo = (sender && sender.email) || settings.reply_to_email || FALLBACK_REPLY_TO;
  const subject = `💬 New message from ${senderFirst} · ${companyName}`;

  // Render the message body with line breaks preserved as <br>.
  const messageHtml = esc(messageBody).replace(/\r?\n/g, '<br>');

  const text = [
    `Hi ${firstName},`,
    ``,
    `${senderFirst} from ${companyName} just sent you a message:`,
    ``,
    `  ${messageBody.split('\n').join('\n  ')}`,
    ``,
    `To reply and see your full proposal, sign in to your ${portalName} account:`,
    `${magicLink}`,
    ``,
    `Or just reply to this email — your reply goes straight to ${senderFirst}.`,
    ``,
    `— ${portalName}`,
  ].join('\n');

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Inter','Onest',sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#0e1218;background:#fff;">
  <div style="border-bottom:3px solid #9c7440;padding-bottom:14px;margin-bottom:22px;">
    <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#9c7440;font-weight:700;margin-bottom:6px;">NEW MESSAGE · ${esc(portalName.toUpperCase())}</div>
    <h1 style="font-size:22px;margin:0;color:#0e1218;line-height:1.3;font-weight:600;">Hi ${esc(firstName)} — ${esc(senderFirst)} sent you a note.</h1>
  </div>

  <div style="background:#faf8f3;border-left:3px solid #9c7440;padding:16px 18px;margin-bottom:24px;border-radius:4px;">
    <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#9c7440;font-weight:700;margin-bottom:8px;">FROM ${esc(senderFirst.toUpperCase())}</div>
    <div style="font-size:15px;color:#0e1218;line-height:1.55;">${messageHtml}</div>
  </div>

  <div style="margin:24px 0 16px;text-align:center;">
    <a href="${esc(magicLink)}" style="display:inline-block;background:#9c7440;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">View &amp; reply in ${esc(portalName)} →</a>
  </div>

  <div style="background:#f7f8f5;border-radius:8px;padding:16px 18px;margin:24px 0;font-size:13px;color:#4a5450;line-height:1.55;">
    The button above signs you in automatically — no password needed. Once you're in, you can see all proposal details, request material changes, or lock in the project when you're ready.
    <br><br>
    <strong style="color:#0e1218;">Don't want to log in?</strong> Just reply to this email. Your reply goes directly to ${esc(senderFirst)}.
  </div>

  <div style="border-top:1px solid #eee;padding-top:14px;color:#999;font-size:11px;line-height:1.5;text-align:center;">
    ${esc(portalName)}
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
        reply_to: replyTo,
        subject,
        text,
        html,
      }),
    });
    if (resp.ok) return true;
    const errText = await resp.text();
    console.error('Resend chat-message email failed:', resp.status, errText);
    return false;
  } catch (e) {
    console.error('Resend exception (chat-message):', e);
    return false;
  }
}
