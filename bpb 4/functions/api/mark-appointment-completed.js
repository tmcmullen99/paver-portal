// ═══════════════════════════════════════════════════════════════════════════
// /api/mark-appointment-completed  —  Phase 4.0c Round 2+
//
// Authenticated endpoint (designer or master JWT required). Called from
// /admin/clients.html when a designer marks a referral's design appointment
// as complete. Drives the $500 credit award atomically via the
// award_referral_credit() RPC, then emails the referrer.
//
// Steps:
//   1. Validate request body has a UUID referral_id.
//   2. Verify caller's JWT via /auth/v1/user; reject if missing/expired.
//   3. Look up caller's profile; reject if not active OR not designer/master.
//   4. Load the referral; if caller is designer (not master), confirm
//      clients.created_by on the referrer matches the caller's user_id.
//   5. Invoke RPC award_referral_credit (atomic — locks rows, idempotent on
//      already-completed, cap-aware).
//   6. If RPC awarded credit, send the referrer a notification email.
//   7. Return RPC result + email status.
//
// Auth pattern: caller's JWT is verified, then SERVICE_ROLE is used for the
// data work because the RPC is granted only to service_role and the writes
// (clients.referral_credit_cents, referrals.status) bypass homeowner RLS.
// ═══════════════════════════════════════════════════════════════════════════

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const SUPABASE_URL   = env.SUPABASE_URL;
    const SERVICE_ROLE   = env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND_API_KEY = env.RESEND_API_KEY;
    const RESEND_FROM    = env.RESEND_FROM || 'Tim McMullen <tim@mcmullen.properties>';

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { error: 'Server not configured' });
    }

    // ─── 1. Validate input ───────────────────────────────────────────────
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json(400, { error: 'Invalid JSON body' });
    }
    const referralId = String(body.referral_id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(referralId)) {
      return json(400, { error: 'Invalid referral_id (must be a UUID)' });
    }

    // ─── 2. Verify caller's JWT ──────────────────────────────────────────
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return json(401, { error: 'Missing or malformed Authorization header' });
    }
    const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'apikey': SERVICE_ROLE,
        'Authorization': authHeader,
      },
    });
    if (!userResp.ok) {
      return json(401, { error: 'Invalid or expired session' });
    }
    const user = await userResp.json();
    const callerUserId = user && user.id;
    if (!callerUserId) {
      return json(401, { error: 'Could not resolve caller identity' });
    }

    // ─── 3. Look up caller's profile (role + active flag) ───────────────
    const profileResp = await fetch(
      SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(callerUserId) +
      '&select=id,role,is_active,display_name',
      {
        headers: {
          'apikey': SERVICE_ROLE,
          'Authorization': 'Bearer ' + SERVICE_ROLE,
        },
      }
    );
    if (!profileResp.ok) {
      return json(502, { error: 'Could not look up caller profile' });
    }
    const profileRows = await profileResp.json();
    const caller = Array.isArray(profileRows) && profileRows[0];
    if (!caller || !caller.is_active) {
      return json(403, { error: 'Account is not active' });
    }
    const isMaster   = caller.role === 'master';
    const isDesigner = caller.role === 'designer';
    if (!isMaster && !isDesigner) {
      return json(403, { error: 'Only designers and masters can mark appointments complete' });
    }

    // ─── 4. Ownership check (skip for master) ───────────────────────────
    const referralResp = await fetch(
      SUPABASE_URL + '/rest/v1/referrals?id=eq.' + encodeURIComponent(referralId) +
      '&select=id,referrer_client_id,status',
      {
        headers: {
          'apikey': SERVICE_ROLE,
          'Authorization': 'Bearer ' + SERVICE_ROLE,
        },
      }
    );
    if (!referralResp.ok) {
      return json(502, { error: 'Could not look up referral' });
    }
    const referralRows = await referralResp.json();
    const referral = Array.isArray(referralRows) && referralRows[0];
    if (!referral) {
      return json(404, { error: 'Referral not found' });
    }

    if (!isMaster) {
      const referrerResp = await fetch(
        SUPABASE_URL + '/rest/v1/clients?id=eq.' + encodeURIComponent(referral.referrer_client_id) +
        '&select=id,created_by',
        {
          headers: {
            'apikey': SERVICE_ROLE,
            'Authorization': 'Bearer ' + SERVICE_ROLE,
          },
        }
      );
      if (!referrerResp.ok) {
        return json(502, { error: 'Could not verify referral ownership' });
      }
      const referrerRows = await referrerResp.json();
      const referrer = Array.isArray(referrerRows) && referrerRows[0];
      if (!referrer || referrer.created_by !== callerUserId) {
        return json(403, { error: 'You can only mark appointments for your own referrals' });
      }
    }

    // ─── 5. Invoke the RPC ───────────────────────────────────────────────
    const rpcResp = await fetch(SUPABASE_URL + '/rest/v1/rpc/award_referral_credit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE,
        'Authorization': 'Bearer ' + SERVICE_ROLE,
      },
      body: JSON.stringify({ p_referral_id: referralId }),
    });
    if (!rpcResp.ok) {
      const errText = await rpcResp.text();
      return json(502, { error: 'RPC call failed: ' + errText.slice(0, 240) });
    }
    const rpcResult = await rpcResp.json();

    // RPC may return structured errors as JSON body (not HTTP errors).
    if (rpcResult && rpcResult.error) {
      const status = rpcResult.error === 'already_completed' ? 409 :
                     rpcResult.error === 'not_found'         ? 404 :
                     400;
      return json(status, rpcResult);
    }

    // ─── 6. Send referrer credit-award email (best-effort) ──────────────
    let emailSent  = false;
    let emailError = null;

    if (RESEND_API_KEY && rpcResult.referrer_email) {
      try {
        const subject = rpcResult.credit_awarded
          ? 'Your $500 Paver Portal referral credit just landed'
          : 'Thanks for the referral — appointment complete';
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + RESEND_API_KEY,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            from:    RESEND_FROM,
            to:      [rpcResult.referrer_email],
            subject,
            html:    buildReferrerCreditHtml(rpcResult),
            text:    buildReferrerCreditText(rpcResult),
          }),
        });
        emailSent = r.ok;
        if (!r.ok) emailError = 'Resend error: ' + (await r.text()).slice(0, 240);
      } catch (err) {
        emailError = 'Email send error: ' + ((err && err.message) || 'unknown');
      }
    } else if (!RESEND_API_KEY) {
      emailError = 'RESEND_API_KEY not configured';
    }

    return json(200, Object.assign({}, rpcResult, {
      email_sent:  emailSent,
      email_error: emailError,
    }));

  } catch (err) {
    return json(500, { error: (err && err.message) || 'Unexpected server error' });
  }
}

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
// Referrer credit-award email
// ───────────────────────────────────────────────────────────────────────────

function buildReferrerCreditHtml(r) {
  const referrerFirst = (r.referrer_name || '').split(/\s+/)[0] || 'there';
  const refereeName   = r.referred_name || r.referred_email || 'your referral';
  const newBalance    = formatCents(r.new_credit_cents);

  const intro = r.credit_awarded
    ? '<strong>' + escapeHtml(refereeName) + '</strong> just completed their design appointment with Paver Portal, which means your $500 referral credit has been added to your account.'
    : '<strong>' + escapeHtml(refereeName) + '</strong> just completed their design appointment with Paver Portal. Your account is already at the $2,500 referral cap, so no additional credit was added — but thank you for sending them our way.';

  const balanceBlock = '<div style="background:#f7f7f4;border-radius:6px;padding:18px 22px;margin:20px 0;">' +
    '<p style="margin:0 0 6px;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#58595b;font-weight:600;">Your Paver Portal credit balance</p>' +
    '<p style="margin:0;font-size:22px;font-weight:600;color:#1f2125;">' + escapeHtml(newBalance) + '</p>' +
    (r.cap_reached
      ? '<p style="margin:6px 0 0;font-size:11px;color:#58595b;">You\'ve hit the $2,500 cap — share Paver Portal generously, but additional referrals after this won\'t add credit.</p>'
      : '<p style="margin:6px 0 0;font-size:11px;color:#58595b;">Stackable to $2,500 across up to 5 successful referrals.</p>') +
    '</div>';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
'<body style="margin:0;padding:0;background:#f7f7f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f2125;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f7f4;padding:40px 20px;">' +
'<tr><td align="center">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
'<tr><td style="background:#9c7440;padding:28px 40px;text-align:center;">' +
'<h1 style="margin:0;color:#fff;font-size:22px;font-weight:600;letter-spacing:-0.01em;">' +
(r.credit_awarded ? 'Credit added to your account' : 'Thanks for the referral') +
'</h1></td></tr>' +
'<tr><td style="padding:32px 40px 24px;">' +
'<p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hi ' + escapeHtml(referrerFirst) + ',</p>' +
'<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#58595b;">' + intro + '</p>' +
balanceBlock +
'<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#58595b;">Your credit applies to your next Paver Portal project — your designer will pull it off the bid automatically.</p>' +
'</td></tr>' +
'<tr><td style="padding:18px 40px;background:#f7f7f4;border-top:1px solid #e4e4df;text-align:center;">' +
'<p style="margin:0;font-size:11px;color:#70726f;">Paver Portal · Creating backyards people love</p>' +
'</td></tr></table></td></tr></table></body></html>';
}

function buildReferrerCreditText(r) {
  const referrerFirst = (r.referrer_name || '').split(/\s+/)[0] || 'there';
  const refereeName   = r.referred_name || r.referred_email || 'your referral';
  const newBalance    = formatCents(r.new_credit_cents);

  return [
    'Hi ' + referrerFirst + ',',
    '',
    r.credit_awarded
      ? refereeName + ' just completed their design appointment. Your $500 referral credit has been added.'
      : refereeName + ' just completed their design appointment. Your account is already at the $2,500 cap, so no additional credit was added — but thank you for sending them our way.',
    '',
    'Your current Paver Portal credit balance: ' + newBalance,
    r.cap_reached ? '(You\'ve hit the $2,500 cap.)' : '(Stackable to $2,500 across up to 5 referrals.)',
    '',
    'Your credit applies to your next Paver Portal project — your designer will pull it off the bid automatically.',
    '',
    '— Paver Portal',
  ].filter(Boolean).join('\n');
}

function formatCents(cents) {
  const n = Number(cents || 0);
  const dollars = n / 100;
  return '$' + dollars.toFixed(dollars % 1 === 0 ? 0 : 2);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
