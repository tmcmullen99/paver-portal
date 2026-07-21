// ═══════════════════════════════════════════════════════════════════════════
// /api/create-homeowner-account  —  Phase 6.3A.1 (magic-link auth refactor)
//
// Master- or designer-callable endpoint. Provisions a homeowner Supabase
// Auth user AT THE DESIGN APPOINTMENT (or anytime after) and emails them a
// magic-link invitation that signs them in automatically on first click.
//
// Replaces the previous Phase 4.0a "initial password = street address" flow,
// which was fragile (clients had to know the format, password was effectively
// public) and prone to desync (auth user creation could fail silently after
// the clients row was inserted).
//
// Steps:
//   1. Verify caller's JWT corresponds to an active master OR designer.
//   2. Validate input (name, email, address; phone optional).
//   3. Create Supabase Auth user via admin API WITHOUT a password.
//      email_confirm=true so the magic link works immediately on first click.
//   4. Generate a magic link via /auth/v1/admin/generate_link.
//   5. Insert clients row linking auth.users.id → clients.user_id.
//      must_change_password=false because the new flow handles password setup
//      AFTER login (on /account/welcome.html), not before.
//   6. Send welcome email via Resend (contains the magic-link button).
//
// Browser side (admin/create-homeowner-account.html) sends:
//   POST /api/create-homeowner-account
//   Authorization: Bearer <designer_access_token>
//   { email, name, address, phone? }
//
// Returns:
//   200 { ok, client_id, user_id, email, name, refer_code,
//         welcome_email_sent, welcome_email_error }
//   400 { error }   bad input
//   401 { error }   missing/invalid auth token
//   403 { error }   caller is neither master nor designer
//   409 { error }   email already in use
//   502 { error }   upstream Supabase / Resend error
//   500 { error }   unexpected server error
// ═══════════════════════════════════════════════════════════════════════════

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const SUPABASE_URL    = env.SUPABASE_URL;
    const SERVICE_ROLE    = env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND_API_KEY  = env.RESEND_API_KEY;
    const RESEND_FROM     = env.RESEND_FROM || 'Tim McMullen <tim@mcmullen.properties>';

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { error: 'Server not configured (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)' });
    }

    // ─── 1. Verify caller's JWT ──────────────────────────────────────────
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return json(401, { error: 'Missing auth token' });

    const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'Authorization': 'Bearer ' + token, 'apikey': SERVICE_ROLE },
    });
    if (!userResp.ok) return json(401, { error: 'Invalid auth token' });
    const callerUser = await userResp.json();
    if (!callerUser || !callerUser.id) {
      return json(401, { error: 'Invalid auth token (no user)' });
    }

    // ─── 2. Confirm caller is master or designer (active) ────────────────
    const profileResp = await fetch(
      SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(callerUser.id) +
      '&select=role,is_active,display_name',
      { headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE } }
    );
    if (!profileResp.ok) return json(403, { error: 'Could not look up caller profile' });
    const profiles = await profileResp.json();
    const callerProfile = Array.isArray(profiles) && profiles[0];
    if (!callerProfile || !callerProfile.is_active ||
        (callerProfile.role !== 'master' && callerProfile.role !== 'designer')) {
      return json(403, { error: 'Designer or master access required' });
    }

    // ─── 3. Validate input ────────────────────────────────────────────────
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json(400, { error: 'Invalid JSON body' });
    }

    const email   = String(body.email   || '').trim().toLowerCase();
    const name    = String(body.name    || '').trim();
    const address = String(body.address || '').trim();
    const phoneIn = String(body.phone   || '').trim();
    const phone   = phoneIn || null;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(400, { error: 'Invalid email address' });
    }
    if (!name) return json(400, { error: 'Homeowner name is required' });
    if (name.length > 120) return json(400, { error: 'Homeowner name too long (max 120 chars)' });
    if (!address) return json(400, { error: 'Property street address is required' });

    // ─── 4. Create Supabase Auth user without password ───────────────────
    const adminCreateResp = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE,
        'Authorization': 'Bearer ' + SERVICE_ROLE,
      },
      body: JSON.stringify({
        email,
        email_confirm: true, // Pre-confirm so first magic link works immediately.
        user_metadata: {
          full_name: name,
          account_type: 'homeowner',
        },
      }),
    });

    if (!adminCreateResp.ok) {
      const errText = await adminCreateResp.text();
      if (adminCreateResp.status === 422 ||
          /already.*registered/i.test(errText) ||
          /already.*exists/i.test(errText)) {
        return json(409, { error: 'An account with this email already exists. Use the Resend invite flow to send them a fresh magic link.' });
      }
      return json(502, { error: 'Auth admin API error: ' + errText.slice(0, 240) });
    }

    const adminCreateData = await adminCreateResp.json();
    const newUserId = adminCreateData.id || (adminCreateData.user && adminCreateData.user.id);
    if (!newUserId) {
      return json(502, { error: 'Auth admin API returned no user id' });
    }

    // ─── 5. Generate magic link for first sign-in ────────────────────────
    const origin = new URL(request.url).origin;
    const redirectTo = origin + '/account/welcome.html';

    const linkResp = await fetch(SUPABASE_URL + '/auth/v1/admin/generate_link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE,
        'Authorization': 'Bearer ' + SERVICE_ROLE,
      },
      body: JSON.stringify({
        type: 'magiclink',
        email,
        options: { redirect_to: redirectTo },
      }),
    });

    if (!linkResp.ok) {
      // Roll back the auth user — we can't deliver the link.
      await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + newUserId, {
        method: 'DELETE',
        headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE },
      }).catch(() => {});
      return json(502, { error: 'Magic link generation failed: ' + (await linkResp.text()).slice(0, 240) });
    }

    const linkData = await linkResp.json();
    const magicLink = linkData.action_link || (linkData.properties && linkData.properties.action_link);
    if (!magicLink) {
      await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + newUserId, {
        method: 'DELETE',
        headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE },
      }).catch(() => {});
      return json(502, { error: 'Magic link response missing action_link' });
    }

    // ─── 6. Insert clients row ──────────────────────────────────────────
    const clientInsertResp = await fetch(SUPABASE_URL + '/rest/v1/clients', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE,
        'Authorization': 'Bearer ' + SERVICE_ROLE,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        user_id: newUserId,
        created_by: callerUser.id,
        name,
        email,
        phone,
        address,
        account_setup_at: new Date().toISOString(),
        must_change_password: false, // Password is optional with magic-link flow.
      }),
    });

    if (!clientInsertResp.ok) {
      const errText = await clientInsertResp.text();
      // Best-effort rollback.
      await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + newUserId, {
        method: 'DELETE',
        headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE },
      }).catch(() => {});

      if (/duplicate|unique/i.test(errText)) {
        return json(409, { error: 'A client with this email already exists' });
      }
      return json(502, { error: 'Client row insert failed: ' + errText.slice(0, 240) });
    }

    const clientRows = await clientInsertResp.json();
    const newClient  = Array.isArray(clientRows) ? clientRows[0] : clientRows;

    // ─── 7. Send welcome email via Resend ───────────────────────────────
    let welcomeEmailSent  = false;
    let welcomeEmailError = null;

    if (RESEND_API_KEY) {
      const designerName = (callerProfile.display_name || 'Your designer').trim();
      const emailHtml = buildWelcomeEmailHtml({
        name, designerName, magicLink,
      });
      const emailText = buildWelcomeEmailText({
        name, designerName, magicLink,
      });

      try {
        const emailResp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + RESEND_API_KEY,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            from:    RESEND_FROM,
            to:      [email],
            subject: 'Your Paver Portal proposal portal',
            html:    emailHtml,
            text:    emailText,
          }),
        });
        if (emailResp.ok) {
          welcomeEmailSent = true;
        } else {
          welcomeEmailError = 'Resend API ' + emailResp.status + ': ' + (await emailResp.text()).slice(0, 240);
        }
      } catch (err) {
        welcomeEmailError = 'Resend fetch failed: ' + ((err && err.message) || 'unknown');
      }
    } else {
      welcomeEmailError = 'RESEND_API_KEY env var not configured — account created, please share magic link manually';
    }

    return json(200, {
      ok: true,
      client_id:           newClient.id,
      user_id:             newUserId,
      email,
      name,
      refer_code:          newClient.refer_code,
      welcome_email_sent:  welcomeEmailSent,
      welcome_email_error: welcomeEmailError,
    });

  } catch (err) {
    return json(500, { error: (err && err.message) || 'Unexpected server error' });
  }
}

// CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age':       '86400',
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Welcome email — Paver Portal green + magic-link CTA
// ───────────────────────────────────────────────────────────────────────────
function buildWelcomeEmailHtml({ name, designerName, magicLink }) {
  return '<!DOCTYPE html>\n' +
'<html><head>' +
'<meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Your Paver Portal proposal portal</title>' +
'</head>' +
'<body style="margin:0;padding:0;background:#f7f7f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f2125;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f7f4;padding:40px 20px;">' +
'<tr><td align="center">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
'<tr><td style="padding:32px 40px 16px;text-align:center;">' +
'<img src="https://portal-baysidepavers.com/assets/paver-portal-logo.svg" alt="Paver Portal" style="height:36px;width:auto;">' +
'</td></tr>' +
'<tr><td style="padding:8px 40px 24px;">' +
'<p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#1f2125;">Hi ' + escapeHtml(name) + ',</p>' +
'<p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#58595b;">Thanks for letting me put together a proposal for your property.</p>' +
'<p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#58595b;">I&#39;ve built you a dedicated client portal where you can review everything — the full scope of work, selected materials with manufacturer cut sheets, 3D renderings, and the complete price breakdown. You can come back to it anytime to check details, review updates, or just show your family.</p>' +
'<p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#58595b;">Click below to open your portal — it&#39;ll log you in automatically.</p>' +
'<div style="text-align:center;margin:24px 0 28px;">' +
'<a href="' + escapeHtml(magicLink) + '" style="display:inline-block;background:#9c7440;color:#fff;text-decoration:none;padding:14px 32px;border-radius:4px;font-size:15px;font-weight:600;">Open My Proposal Portal &rarr;</a>' +
'</div>' +
'<div style="background:#f7f7f4;border-radius:6px;padding:18px 22px;margin:0 0 20px;">' +
'<p style="margin:0 0 10px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#58595b;font-weight:600;">What&#39;s inside your portal</p>' +
'<ul style="margin:0;padding:0 0 0 18px;font-size:13px;line-height:1.8;color:#1f2125;">' +
'<li>Complete scope of work with materials and pricing</li>' +
'<li>3D renderings of your finished project</li>' +
'<li>Manufacturer cut sheets for every product</li>' +
'<li>Installation walkthrough videos</li>' +
'</ul>' +
'</div>' +
'<p style="margin:0 0 0;font-size:12px;line-height:1.55;color:#a0a09c;font-style:italic;">This link is good for 7 days. If it expires, just reply to this email and I&#39;ll send you a fresh one.</p>' +
'</td></tr>' +
'<tr><td style="padding:24px 40px;background:#f7f7f4;border-top:1px solid #e4e4df;">' +
'<p style="margin:0 0 4px;font-size:14px;color:#1f2125;">Looking forward to it,</p>' +
'<p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1f2125;">' + escapeHtml(designerName) + '</p>' +
'<p style="margin:0;font-size:13px;color:#70726f;">Paver Portal</p>' +
'<p style="margin:8px 0 0;font-size:12px;color:#a0a09c;">tim@mcmullen.properties</p>' +
'</td></tr>' +
'<tr><td style="padding:14px 40px 18px;background:#f7f7f4;text-align:center;">' +
'<p style="margin:0 0 4px;font-size:11px;color:#a0a09c;">Can&#39;t click the button? Copy and paste this link into your browser:</p>' +
'<p style="margin:0;font-size:11px;color:#a0a09c;word-break:break-all;"><a href="' + escapeHtml(magicLink) + '" style="color:#9c7440;text-decoration:underline;">' + escapeHtml(magicLink) + '</a></p>' +
'</td></tr>' +
'</table>' +
'</td></tr></table>' +
'</body></html>';
}

function buildWelcomeEmailText({ name, designerName, magicLink }) {
  return [
    'Hi ' + name + ',',
    '',
    'Thanks for letting me put together a proposal for your property.',
    '',
    'I\'ve built you a dedicated client portal where you can review everything —',
    'the full scope of work, selected materials with manufacturer cut sheets, 3D',
    'renderings, and the complete price breakdown.',
    '',
    'Click below to open your portal — it\'ll log you in automatically.',
    '',
    magicLink,
    '',
    'What\'s inside your portal:',
    '  - Complete scope of work with materials and pricing',
    '  - 3D renderings of your finished project',
    '  - Manufacturer cut sheets for every product',
    '  - Installation walkthrough videos',
    '',
    'This link is good for 7 days. If it expires, just reply to this email and',
    'I\'ll send you a fresh one.',
    '',
    'Looking forward to it,',
    designerName,
    'Paver Portal',
    'tim@mcmullen.properties',
  ].join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
