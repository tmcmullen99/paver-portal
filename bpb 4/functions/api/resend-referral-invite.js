// ═══════════════════════════════════════════════════════════════════════════
// /api/resend-referral-invite  —  Phase 4.0c Round 3
//
// Homeowner-callable endpoint. Re-fires the original invite email for an
// existing referral that the friend hasn't acted on yet.
//
// Steps:
//   1. Verify caller's JWT and resolve to a clients row (homeowner).
//   2. Look up the referral by id; verify caller owns it (referrer match).
//   3. Validate status === 'sent' (only stuck invites can be resent — once
//      they've scheduled or completed, resend doesn't make sense).
//   4. Rate-limit: refuse if invite_sent_at was within the last 24h. The
//      UI also hides the button in that window, but the server is the
//      source of truth.
//   5. Update invite_sent_at = now() so the dashboard reflects the bump.
//   6. Re-send the invite email via Resend with the same template and
//      scheduling_token (token doesn't change — same referral row). The
//      personal_note stored at first-send time is re-included so the
//      reminder preserves the homeowner's voice.
//
// Design note: this duplicates buildInviteHtml/Text from
// send-referral-invite.js because Pages Functions don't share a module
// system across files cheaply. Per Karpathy "simplicity first," copy-paste
// is preferred over a shared utility for two callsites.
//
// Phase 4 closeout (R3): hardcoded PUBLIC_BASE_URL replaces the previous
// `new URL(request.url).origin` derivation. Emails always need to point
// at the real production domain regardless of which origin the function
// was invoked through (preview deploys, *.pages.dev, etc).
// ═══════════════════════════════════════════════════════════════════════════

const PUBLIC_BASE_URL = 'https://portal-baysidepavers.com';

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

    // ─── 3. Look up caller's clients row (must be homeowner) ────────────
    const callerResp = await fetch(
      SUPABASE_URL + '/rest/v1/clients?user_id=eq.' + encodeURIComponent(callerUser.id) +
      '&select=id,name,email',
      {
        headers: {
          'apikey': SERVICE_ROLE,
          'Authorization': 'Bearer ' + SERVICE_ROLE,
        },
      }
    );
    if (!callerResp.ok) {
      return json(403, { error: 'Could not look up caller account' });
    }
    const callerRows = await callerResp.json();
    const callerClient = Array.isArray(callerRows) && callerRows[0];
    if (!callerClient) {
      return json(403, { error: 'Only homeowner accounts can resend referrals' });
    }

    // ─── 4. Look up the referral, verify ownership + state ──────────────
    const referralResp = await fetch(
      SUPABASE_URL + '/rest/v1/referrals?id=eq.' + encodeURIComponent(referralId) +
      '&select=id,referrer_client_id,referred_email,referred_name,status,scheduling_token,invite_sent_at,personal_note',
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
    if (referral.referrer_client_id !== callerClient.id) {
      return json(403, { error: 'You can only resend your own referrals' });
    }
    if (referral.status !== 'sent') {
      return json(409, {
        error: "This referral can't be resent — it's already in a later stage.",
        status: referral.status
      });
    }

    // ─── 5. Rate-limit: 24h cooldown ─────────────────────────────────────
    if (referral.invite_sent_at) {
      const lastSent = new Date(referral.invite_sent_at).getTime();
      const elapsed  = Date.now() - lastSent;
      const oneDay   = 24 * 60 * 60 * 1000;
      if (elapsed < oneDay) {
        const hoursLeft = Math.ceil((oneDay - elapsed) / (60 * 60 * 1000));
        return json(429, {
          error: `Please wait ${hoursLeft}h before resending — last invite went out recently.`,
          retry_after_hours: hoursLeft,
        });
      }
    }

    // ─── 6. Bump invite_sent_at ──────────────────────────────────────────
    const patchResp = await fetch(
      SUPABASE_URL + '/rest/v1/referrals?id=eq.' + encodeURIComponent(referral.id),
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SERVICE_ROLE,
          'Authorization': 'Bearer ' + SERVICE_ROLE,
        },
        body: JSON.stringify({ invite_sent_at: new Date().toISOString() }),
      }
    );
    if (!patchResp.ok) {
      const errText = await patchResp.text();
      return json(502, { error: 'Could not update referral: ' + errText.slice(0, 240) });
    }

    // ─── 7. Re-send the invite email via Resend ──────────────────────────
    // Phase 4 closeout (R3): use PUBLIC_BASE_URL constant rather than
    // deriving from request.url so emails always link to the real domain.
    const landingUrl   = PUBLIC_BASE_URL + '/refer/?t=' + encodeURIComponent(referral.scheduling_token);
    const refeeFirst   = (referral.referred_name || '').split(/[\s,&]+/)[0] || 'there';
    const referrerName = callerClient.name || callerClient.email;
    const personalNote = referral.personal_note || null;

    let emailSent  = false;
    let emailError = null;

    if (RESEND_API_KEY) {
      try {
        const emailResp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + RESEND_API_KEY,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            from:    RESEND_FROM,
            to:      [referral.referred_email],
            reply_to: callerClient.email,
            subject: 'Reminder: ' + (referrerName.split(/[\s,&]+/)[0] || 'a friend') +
                     ' wants you to claim your $500 from Paver Portal',
            html:    buildInviteHtml({ referrerName, refeeFirstName: refeeFirst, landingUrl, isResend: true, personalNote }),
            text:    buildInviteText({ referrerName, refeeFirstName: refeeFirst, landingUrl, isResend: true, personalNote }),
          }),
        });
        if (emailResp.ok) {
          emailSent = true;
        } else {
          emailError = 'Resend ' + emailResp.status + ': ' + (await emailResp.text()).slice(0, 240);
        }
      } catch (err) {
        emailError = 'Resend fetch failed: ' + ((err && err.message) || 'unknown');
      }
    } else {
      emailError = 'RESEND_API_KEY not configured';
    }

    return json(200, {
      ok:                true,
      referral_id:       referral.id,
      landing_url:       landingUrl,
      email_sent:        emailSent,
      email_error:       emailError,
    });

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
// Email body — same template as send-referral-invite.js, with a "reminder"
// nudge in the opening line when isResend=true. The personalNote is the
// homeowner's original note stored at first-send time; re-included here so
// the reminder preserves the homeowner's voice rather than reading as a
// cold system nudge.
// ───────────────────────────────────────────────────────────────────────────
function buildInviteHtml({ referrerName, refeeFirstName, landingUrl, isResend, personalNote }) {
  const referrerFirst = (referrerName || '').split(/[\s,&]+/)[0] || 'a Paver Portal customer';
  const opener = isResend
    ? 'Just a quick reminder — ' + escapeHtml(referrerName) + ' referred you to Paver Portal a few days ago, and you have $500 sitting on the table:'
    : escapeHtml(referrerName) + ' just referred you to Paver Portal — they thought you might be interested in what we are designing for their backyard, and they wanted you to have an unfair advantage:';

  const noteBlock = personalNote
    ? '<div style="background:#faf8f3;border-left:4px solid #9c7440;padding:14px 18px;margin:22px 0 24px;border-radius:0 4px 4px 0;font-size:15px;line-height:1.65;color:#353535;font-style:italic;">' +
      escapeHtml(personalNote).replace(/\n/g, '<br>') +
      '<div style="margin-top:10px;font-size:13px;color:#70726f;font-style:normal;">— ' + escapeHtml(referrerFirst) + '</div>' +
      '</div>'
    : '';

  return '<!DOCTYPE html>\n' +
'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Reminder: claim your Paver Portal referral</title></head>' +
'<body style="margin:0;padding:0;background:#f7f7f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f2125;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f7f4;padding:40px 20px;">' +
'<tr><td align="center">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
'<tr><td style="background:#9c7440;padding:32px 40px;text-align:center;">' +
'<h1 style="margin:0;color:#fff;font-size:22px;font-weight:600;letter-spacing:-0.01em;">' +
(isResend ? 'A friendly nudge' : 'A neighborly recommendation') +
'</h1></td></tr>' +
'<tr><td style="padding:36px 40px 12px;">' +
'<p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#1f2125;">Hi ' + escapeHtml(refeeFirstName) + ',</p>' +
'<p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#58595b;">' + opener + '</p>' +
noteBlock +
'<div style="background:#dad7c5;border-radius:6px;padding:18px 22px;margin:20px 0 24px;text-align:center;">' +
'<p style="margin:0 0 4px;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#58595b;font-weight:600;">Your referral perk</p>' +
'<p style="margin:0;font-size:22px;font-weight:600;color:#9c7440;letter-spacing:-0.01em;">$500 off your first project</p>' +
'</div>' +
'<p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#58595b;">' +
'Schedule a free design appointment with our team — no obligation. We will come out, walk your yard, and give you a real proposal. ' + escapeHtml(referrerFirst) + ' gets $500 toward their next project too.' +
'</p>' +
'<div style="text-align:center;margin:32px 0 12px;">' +
'<a href="' + escapeHtml(landingUrl) + '" style="display:inline-block;background:#9c7440;color:#fff;text-decoration:none;padding:14px 32px;border-radius:4px;font-size:15px;font-weight:600;">Claim your $500 &amp; schedule</a>' +
'</div>' +
'<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#a0a09c;text-align:center;">' +
'This invitation was sent because ' + escapeHtml(referrerName) + ' referred you. Reply to this email to reach them directly.' +
'</p>' +
'</td></tr>' +
'<tr><td style="padding:24px 40px;background:#f7f7f4;border-top:1px solid #e4e4df;text-align:center;">' +
'<p style="margin:0;font-size:12px;color:#70726f;">Paver Portal · Creating backyards people love</p>' +
'</td></tr>' +
'</table></td></tr></table></body></html>';
}

function buildInviteText({ referrerName, refeeFirstName, landingUrl, isResend, personalNote }) {
  const referrerFirst = (referrerName || '').split(/[\s,&]+/)[0] || 'A friend';
  const opener = isResend
    ? 'Just a quick reminder — ' + referrerName + ' referred you to Paver Portal a'
    : referrerName + ' just referred you to Paver Portal — they thought you might be';
  const opener2 = isResend
    ? 'few days ago, and you have $500 sitting on the table.'
    : 'interested in what we are designing for their backyard.';

  const lines = [
    'Hi ' + refeeFirstName + ',',
    '',
    opener,
    opener2,
    '',
  ];
  if (personalNote) {
    lines.push('A note from ' + referrerFirst + ':');
    personalNote.split('\n').forEach(l => lines.push('  > ' + l));
    lines.push('');
  }
  lines.push(
    'YOUR REFERRAL PERK: $500 off your first project',
    '',
    'Schedule a free design appointment with our team — no obligation. We will come out,',
    'walk your yard, and give you a real proposal. ' + referrerFirst + ' also gets $500 toward their',
    'next project.',
    '',
    'Claim your $500 and schedule: ' + landingUrl,
    '',
    'This invitation was sent because ' + referrerName + ' referred you.',
    'Reply to this email to reach them directly.',
    '',
    '— Paver Portal · Creating backyards people love'
  );
  return lines.join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
