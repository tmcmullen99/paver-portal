/**
 * BPB Phase 1 — /api/sign-intent
 *
 * Handles the "Lock in your project" modal submission from the public
 * homeowner proposal page (/p/<slug>). Inserts the signature intent into
 * Supabase, emails Tim with an actionable HTML notification, and opens
 * a JobNimbus contact tagged "Contract Pending" so Tim can send the
 * contract for e-signature in one click.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const proposal_id    = clamp(body.proposal_id, 36);
  const slug           = clamp(body.slug, 200);
  const viewer_name    = clamp(body.viewer_name, 120);
  const viewer_email   = clamp(body.viewer_email, 200);
  const viewer_phone   = clamp(body.viewer_phone, 40);
  const viewer_message = clamp(body.viewer_message, 2000);
  const referrer       = clamp(body.referrer, 500);

  if (!UUID_RE.test(proposal_id)) {
    return jsonResponse({ error: 'proposal_id missing or invalid' }, 400);
  }
  if (!viewer_name) {
    return jsonResponse({ error: 'Name is required' }, 400);
  }
  if (!EMAIL_RE.test(viewer_email)) {
    return jsonResponse({ error: 'Valid email is required' }, 400);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('sign-intent: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
    return jsonResponse(
      { error: 'Server is misconfigured. Please call Tim directly.' },
      500
    );
  }

  const sbHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Prefer: 'return=representation',
  };

  const clientIp  = request.headers.get('CF-Connecting-IP') || '';
  const userAgent = request.headers.get('User-Agent') || '';

  const insertResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/signature_intents`,
    {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        proposal_id,
        published_slug:  slug || null,
        viewer_name,
        viewer_email,
        viewer_phone:    viewer_phone   || null,
        viewer_message:  viewer_message || null,
        user_agent:      userAgent      || null,
        client_ip:       clientIp       || null,
        referrer:        referrer       || null,
      }),
    }
  );

  if (!insertResp.ok) {
    const errBody = await insertResp.text();
    console.error('signature_intents insert failed:', insertResp.status, errBody);
    return jsonResponse(
      { error: 'Could not save your request. Please call Tim directly at the number on the proposal.' },
      500
    );
  }

  const inserted = await insertResp.json();
  const intentId = (inserted && inserted[0] && inserted[0].id) || null;

  let propRow = {};
  try {
    const propResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/proposals?id=eq.${encodeURIComponent(proposal_id)}&select=project_address,project_city,bid_total_amount`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (propResp.ok) {
      const rows = await propResp.json();
      if (rows && rows[0]) propRow = rows[0];
    }
  } catch (e) {
    console.error('proposal lookup failed (non-fatal):', e);
  }

  const addressStr = propRow.project_address
    ? propRow.project_address + (propRow.project_city ? `, ${propRow.project_city}` : '')
    : '(address unknown)';
  const totalStr = propRow.bid_total_amount
    ? '$' + Number(propRow.bid_total_amount).toLocaleString('en-US')
    : '—';
  const proposalUrl = slug
    ? `https://portal-baysidepavers.com/p/${slug}`
    : null;
  const jnSearchUrl = `https://app.jobnimbus.com/people?search=${encodeURIComponent(viewer_email)}`;

  let emailOk = false;
  if (env.RESEND_API_KEY && env.RESEND_FROM_EMAIL) {
    const notifyEmail = env.SIGN_INTENT_NOTIFY_EMAIL || 'tim@mcmullen.properties';
    const subject = `🔒 ${viewer_name} wants to lock in ${addressStr}${totalStr !== '—' ? ` · ${totalStr}` : ''}`;

    const textLines = [
      `${viewer_name} just clicked "Lock in your project" on a Paver Portal proposal page.`,
      '',
      `Property:   ${addressStr}`,
      `Bid total:  ${totalStr}`,
      proposalUrl ? `Proposal:   ${proposalUrl}` : null,
      `JobNimbus:  ${jnSearchUrl}`,
      '',
      'Contact:',
      `  Name:  ${viewer_name}`,
      `  Email: ${viewer_email}`,
      viewer_phone ? `  Phone: ${viewer_phone}` : null,
      '',
      viewer_message ? `Their message:\n  ${viewer_message}` : '(no message provided)',
      '',
      `intent_id: ${intentId || '(unknown)'}`,
    ].filter(Boolean);
    const text = textLines.join('\n');

    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#0e1218;background:#fff;">
  <div style="border-bottom:3px solid #9c7440;padding-bottom:14px;margin-bottom:22px;">
    <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#9c7440;font-weight:700;margin-bottom:6px;">CONTRACT SIGNATURE REQUEST · PAVER PORTAL PORTAL</div>
    <h1 style="font-size:22px;margin:0;color:#0e1218;line-height:1.25;font-weight:600;">${esc(viewer_name)} is ready to sign.</h1>
  </div>

  <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:22px;border-collapse:collapse;">
    <tr><td style="padding:8px 0;color:#666;font-size:13px;width:120px;">Property</td>
        <td style="padding:8px 0;text-align:right;font-weight:600;font-size:14px;">${esc(addressStr)}</td></tr>
    ${totalStr !== '—' ? `<tr><td style="padding:8px 0;color:#666;font-size:13px;">Bid total</td>
        <td style="padding:8px 0;text-align:right;font-weight:700;color:#9c7440;font-size:18px;">${esc(totalStr)}</td></tr>` : ''}
    <tr><td style="padding:8px 0;color:#666;font-size:13px;">Email</td>
        <td style="padding:8px 0;text-align:right;"><a href="mailto:${esc(viewer_email)}" style="color:#9c7440;text-decoration:none;">${esc(viewer_email)}</a></td></tr>
    ${viewer_phone ? `<tr><td style="padding:8px 0;color:#666;font-size:13px;">Phone</td>
        <td style="padding:8px 0;text-align:right;"><a href="tel:${esc(viewer_phone)}" style="color:#9c7440;text-decoration:none;">${esc(viewer_phone)}</a></td></tr>` : ''}
  </table>

  ${viewer_message ? `
    <div style="background:#faf8f3;border-left:3px solid #b78b3a;padding:14px 16px;margin-bottom:24px;border-radius:4px;">
      <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#b78b3a;font-weight:700;margin-bottom:6px;">CLIENT NOTE</div>
      <div style="font-size:14px;color:#0e1218;line-height:1.55;">${esc(viewer_message)}</div>
    </div>` : ''}

  <div style="margin:28px 0 22px;">
    <a href="${jnSearchUrl}" style="display:inline-block;background:#9c7440;color:#fff;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:600;font-size:14px;margin-right:8px;margin-bottom:8px;">📋 Open in JobNimbus →</a>
    ${proposalUrl ? `<a href="${proposalUrl}" style="display:inline-block;background:#fff;color:#0e1218;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:600;font-size:14px;border:1px solid #ddd;margin-bottom:8px;">View proposal</a>` : ''}
  </div>

  <div style="background:#f7f8f5;border-radius:8px;padding:16px 18px;margin-bottom:24px;font-size:13px;color:#4a5450;line-height:1.55;">
    <strong style="color:#0e1218;">Next step</strong> — open JobNimbus, locate <strong>${esc(viewer_name)}</strong> (the contact has been tagged "Contract Pending"), and send the contract for e-signature. Reply directly to this email and it'll go straight to ${esc(viewer_email)}.
  </div>

  <div style="border-top:1px solid #eee;padding-top:14px;color:#999;font-size:11px;line-height:1.5;">
    Signature intent ID: <code style="background:#f5f5f5;padding:2px 6px;border-radius:3px;font-family:monospace;">${intentId ? intentId.slice(0, 8) : '(unknown)'}</code> · Marked notified in Paver Portal Portal.
  </div>
</div>`.trim();

    try {
      const resendResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from:     env.RESEND_FROM_EMAIL,
          to:       [notifyEmail],
          reply_to: viewer_email,
          subject,
          text,
          html,
        }),
      });
      if (resendResp.ok) {
        emailOk = true;
      } else {
        const errText = await resendResp.text();
        console.error('Resend email failed:', resendResp.status, errText);
      }
    } catch (e) {
      console.error('Email notification crashed (non-fatal):', e);
    }
  } else {
    console.log('sign-intent: Resend not fully configured (need RESEND_API_KEY + RESEND_FROM_EMAIL), skipping email.');
  }

  let jnOk = false;
  if (env.JOBNIMBUS_API_KEY) {
    try {
      const nameParts = viewer_name.trim().split(/\s+/);
      const first_name = nameParts.shift() || '';
      const last_name  = nameParts.join(' ') || '';
      const description = [
        `Paver Portal Portal — Contract signature requested`,
        ``,
        `Property:  ${addressStr}`,
        totalStr !== '—' ? `Bid total: ${totalStr}` : null,
        proposalUrl ? `Proposal:  ${proposalUrl}` : null,
        ``,
        `Signature intent: ${intentId || '(unknown)'}`,
        viewer_message ? `\nClient note: ${viewer_message}` : null,
      ].filter(Boolean).join('\n');

      const jnResp = await fetch('https://app.jobnimbus.com/api1/contacts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.JOBNIMBUS_API_KEY}`,
          'Content-Type': 'application/json',
          Accept:         'application/json',
        },
        body: JSON.stringify({
          first_name,
          last_name,
          email:         viewer_email,
          mobile_phone:  viewer_phone || '',
          address_line1: propRow.project_address || '',
          city:          propRow.project_city || '',
          description,
          status_name:   'Contract Pending',
          tags:          'Paver Portal Portal, Contract Pending',
        }),
      });
      if (jnResp.ok) {
        jnOk = true;
      } else {
        const errText = await jnResp.text();
        console.error('JobNimbus contact upsert failed:', jnResp.status, errText);
      }
    } catch (e) {
      console.error('JobNimbus call crashed (non-fatal):', e);
    }
  } else {
    console.log('sign-intent: JOBNIMBUS_API_KEY missing, skipping JN contact upsert.');
  }

  if ((emailOk || jnOk) && intentId) {
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/signature_intents?id=eq.${encodeURIComponent(intentId)}`,
      {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({ notified_at: new Date().toISOString() }),
      }
    ).catch((e) => console.error('notified_at PATCH failed:', e));
  }

  return jsonResponse({
    ok: true,
    intent_id: intentId,
    email_sent: emailOk,
    jobnimbus_contact: jnOk,
  });
}
