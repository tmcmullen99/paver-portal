// ═══════════════════════════════════════════════════════════════════════════
// /api/resend-homeowner-invite  —  Phase 6.3A.1
//
// Master- or designer-callable. Sends a fresh magic-link invitation email to
// a homeowner. Two scenarios it handles:
//
//   A) Client record exists, auth user does NOT exist (orphan):
//      → Create the auth user (no password, email_confirm=true)
//      → Backfill clients.user_id with the new auth user id
//      → Generate magic link, send email
//
//   B) Both records exist:
//      → Generate fresh magic link, send email
//      → Optionally clear must_change_password since new flow doesn't use it
//
// Body: { email } OR { client_id }
//
// Returns 200 with {ok, email_sent, magic_link?} on success.
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
      return json(500, { error: 'Server not configured' });
    }

    // Verify caller
    const auth = request.headers.get('authorization') || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!tok) return json(401, { error: 'Missing auth token' });

    const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'Authorization': 'Bearer ' + tok, 'apikey': SERVICE_ROLE },
    });
    if (!userResp.ok) return json(401, { error: 'Invalid auth token' });
    const callerUser = await userResp.json();
    if (!callerUser || !callerUser.id) return json(401, { error: 'Invalid auth token' });

    // Confirm caller is staff
    const profResp = await fetch(
      SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(callerUser.id) +
      '&select=role,is_active,display_name',
      { headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE } }
    );
    const profs = await profResp.json();
    const callerProfile = Array.isArray(profs) && profs[0];
    if (!callerProfile || !callerProfile.is_active ||
        (callerProfile.role !== 'master' && callerProfile.role !== 'designer')) {
      return json(403, { error: 'Designer or master access required' });
    }

    // Parse input
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json(400, { error: 'Invalid JSON body' });

    let lookupQuery;
    if (body.client_id) {
      lookupQuery = 'id=eq.' + encodeURIComponent(body.client_id);
    } else if (body.email) {
      const e = String(body.email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return json(400, { error: 'Invalid email' });
      lookupQuery = 'email=eq.' + encodeURIComponent(e);
    } else {
      return json(400, { error: 'Provide email or client_id' });
    }

    // Look up client record
    const clientResp = await fetch(
      SUPABASE_URL + '/rest/v1/clients?' + lookupQuery + '&select=id,name,email,user_id,must_change_password&limit=1',
      { headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE } }
    );
    const clientRows = await clientResp.json();
    if (!Array.isArray(clientRows) || clientRows.length === 0) {
      return json(404, { error: 'No client record found' });
    }
    const client = clientRows[0];
    const email = String(client.email).trim().toLowerCase();

    // Scenario A: orphan client (no auth user)
    let userId = client.user_id;
    if (!userId) {
      // Check if an auth user happens to exist by this email anyway
      const lookupAuth = await fetch(
        SUPABASE_URL + '/auth/v1/admin/users?filter=email.eq.' + encodeURIComponent(email),
        { headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE } }
      );
      let foundUserId = null;
      if (lookupAuth.ok) {
        const data = await lookupAuth.json();
        const users = (data && data.users) || data || [];
        if (Array.isArray(users) && users.length > 0) foundUserId = users[0].id;
      }

      if (foundUserId) {
        userId = foundUserId;
      } else {
        // Create the auth user
        const createResp = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SERVICE_ROLE,
            'Authorization': 'Bearer ' + SERVICE_ROLE,
          },
          body: JSON.stringify({
            email,
            email_confirm: true,
            user_metadata: { full_name: client.name, account_type: 'homeowner' },
          }),
        });
        if (!createResp.ok) {
          return json(502, { error: 'Auth user create failed: ' + (await createResp.text()).slice(0, 240) });
        }
        const createData = await createResp.json();
        userId = createData.id || (createData.user && createData.user.id);
        if (!userId) return json(502, { error: 'Auth create returned no id' });
      }

      // Backfill clients.user_id
      const updateResp = await fetch(
        SUPABASE_URL + '/rest/v1/clients?id=eq.' + encodeURIComponent(client.id),
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SERVICE_ROLE,
            'Authorization': 'Bearer ' + SERVICE_ROLE,
          },
          body: JSON.stringify({
            user_id: userId,
            must_change_password: false,
            account_setup_at: new Date().toISOString(),
          }),
        }
      );
      if (!updateResp.ok) {
        return json(502, { error: 'Client backfill failed: ' + (await updateResp.text()).slice(0, 240) });
      }
    } else if (client.must_change_password) {
      // Scenario B with cleanup: existing user with old password-required flag
      await fetch(
        SUPABASE_URL + '/rest/v1/clients?id=eq.' + encodeURIComponent(client.id),
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SERVICE_ROLE,
            'Authorization': 'Bearer ' + SERVICE_ROLE,
          },
          body: JSON.stringify({ must_change_password: false }),
        }
      ).catch(() => {});
    }

    // Generate magic link
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
      return json(502, { error: 'Magic link generation failed: ' + (await linkResp.text()).slice(0, 240) });
    }
    const linkData = await linkResp.json();
    const magicLink = linkData.action_link || (linkData.properties && linkData.properties.action_link);
    if (!magicLink) return json(502, { error: 'Missing action_link in response' });

    // Send email (reuse the same template family)
    let emailSent = false;
    let emailError = null;

    if (RESEND_API_KEY) {
      const designerName = (callerProfile.display_name || 'Your designer').trim();
      const emailHtml = buildResendHtml({ name: client.name, designerName, magicLink });
      const emailText = buildResendText({ name: client.name, designerName, magicLink });

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
            subject: 'Fresh link to your Paver Portal proposal portal',
            html:    emailHtml,
            text:    emailText,
          }),
        });
        if (emailResp.ok) emailSent = true;
        else emailError = 'Resend ' + emailResp.status + ': ' + (await emailResp.text()).slice(0, 240);
      } catch (err) {
        emailError = 'Resend fetch failed: ' + ((err && err.message) || 'unknown');
      }
    } else {
      emailError = 'RESEND_API_KEY not configured';
    }

    return json(200, {
      ok: true,
      client_id: client.id,
      user_id: userId,
      email,
      email_sent: emailSent,
      email_error: emailError,
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

function buildResendHtml({ name, designerName, magicLink }) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#f7f7f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f2125;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f7f4;padding:40px 20px;"><tr><td align="center">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
    '<tr><td style="padding:32px 40px 16px;text-align:center;"><img src="https://portal-baysidepavers.com/assets/paver-portal-logo.svg" alt="Paver Portal" style="height:36px;width:auto;"></td></tr>' +
    '<tr><td style="padding:8px 40px 24px;">' +
    '<p style="margin:0 0 18px;font-size:16px;line-height:1.6;">Hi ' + escapeHtml(name) + ',</p>' +
    '<p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#58595b;">Here&#39;s a fresh link to your Paver Portal proposal portal — click below and you&#39;ll be signed in automatically.</p>' +
    '<div style="text-align:center;margin:24px 0 28px;">' +
    '<a href="' + escapeHtml(magicLink) + '" style="display:inline-block;background:#9c7440;color:#fff;text-decoration:none;padding:14px 32px;border-radius:4px;font-size:15px;font-weight:600;">Open My Proposal Portal &rarr;</a>' +
    '</div>' +
    '<p style="margin:0 0 0;font-size:12px;line-height:1.55;color:#a0a09c;font-style:italic;">This link is good for 7 days. Reply to this email if you need another.</p>' +
    '</td></tr>' +
    '<tr><td style="padding:24px 40px;background:#f7f7f4;border-top:1px solid #e4e4df;">' +
    '<p style="margin:0 0 4px;font-size:14px;">Talk soon,</p>' +
    '<p style="margin:0;font-size:14px;font-weight:600;">' + escapeHtml(designerName) + '</p>' +
    '<p style="margin:0;font-size:13px;color:#70726f;">Paver Portal</p>' +
    '</td></tr></table></td></tr></table></body></html>';
}

function buildResendText({ name, designerName, magicLink }) {
  return [
    'Hi ' + name + ',',
    '',
    'Here\'s a fresh link to your Paver Portal proposal portal — click below and',
    'you\'ll be signed in automatically.',
    '',
    magicLink,
    '',
    'This link is good for 7 days. Reply to this email if you need another.',
    '',
    'Talk soon,',
    designerName,
    'Paver Portal',
  ].join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
