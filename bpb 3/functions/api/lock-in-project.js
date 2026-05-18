// ═══════════════════════════════════════════════════════════════════════════
// /api/lock-in-project — Phase 1
//
// POST handler for the "Lock in your project" modal on the homeowner public
// proposal page (/p/<slug>). Captures the signature intent, emails Tim with
// full deal context + a one-click JobNimbus search link, opens a JobNimbus
// contact (best-effort), and marks notified_at on the intent so the admin
// dashboard knows Tim has been notified.
//
// Body (JSON):
//   { proposal_id, published_slug?, viewer_name, viewer_email,
//     viewer_phone?, viewer_message?, user_agent?, referrer? }
//
// Env vars (Cloudflare Pages):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, JOBNIMBUS_API_KEY
// ═══════════════════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const TIM_EMAIL = 'tim@mcmullen.properties';
const FROM_ADDRESS = 'Bayside Portal <tim@mcmullen.properties>';

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const proposal_id = body.proposal_id;
    const published_slug = body.published_slug || body.slug || null;
    const viewer_name = (body.viewer_name || '').trim();
    const viewer_email = (body.viewer_email || '').trim().toLowerCase();
    const viewer_phone = (body.viewer_phone || '').trim() || null;
    const viewer_message = (body.viewer_message || body.message || '').trim() || null;

    if (!proposal_id || !viewer_name || !viewer_email) {
      return json({ error: 'Missing name, email, or proposal_id' }, 400);
    }

    const clientIp = request.headers.get('CF-Connecting-IP') || null;
    const userAgent = body.user_agent || request.headers.get('User-Agent') || null;

    // ── 1. Insert signature_intent (service role bypasses RLS) ───────────
    const intent = await supabaseInsert(env, 'signature_intents', {
      proposal_id,
      published_slug,
      viewer_name,
      viewer_email,
      viewer_phone,
      viewer_message,
      user_agent: userAgent,
      client_ip: clientIp,
      referrer: body.referrer || null,
      status: 'pending',
    });
    if (intent.error) {
      console.error('Insert signature_intent failed:', intent.error);
      return json({ error: 'Could not record your request' }, 500);
    }

    // ── 2. Look up proposal context for the email ────────────────────────
    const proposal = await supabaseSelectOne(env, 'proposals', {
      select: 'id,project_address,bid_total_amount',
      filter: `id=eq.${proposal_id}`,
    });

    // ── 3. Email Tim via Resend (best-effort) ────────────────────────────
    const emailResult = await emailDesigner(env, intent.data, proposal.data);

    // ── 4. JobNimbus contact (best-effort, non-blocking) ─────────────────
    const jnResult = await upsertJobNimbusContact(env, intent.data, proposal.data);

    // ── 5. Mark notified_at if either notification path succeeded ────────
    if (emailResult.ok || jnResult.ok) {
      await supabasePatch(env, `signature_intents?id=eq.${intent.data.id}`, {
        notified_at: new Date().toISOString(),
        status: 'notified',
      });
    }

    return json({
      ok: true,
      message: 'Tim has been notified and will reach out within 24 hours to coordinate your contract.',
      intent_id: intent.data.id,
      email_sent: emailResult.ok,
      jobnimbus_contact: jnResult.ok,
    });
  } catch (err) {
    console.error('lock-in-project handler error:', err);
    return json(
      { error: 'Something went wrong. Please email tim@mcmullen.properties directly.' },
      500
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function supabaseHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function supabaseInsert(env, table, row) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: supabaseHeaders(env, { Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!resp.ok) return { error: await resp.text() };
  const data = await resp.json();
  return { data: Array.isArray(data) ? data[0] : data };
}

async function supabaseSelectOne(env, table, { select, filter }) {
  const params = new URLSearchParams();
  if (select) params.set('select', select);
  if (filter) {
    const [k, v] = filter.split('=');
    params.set(k, v);
  }
  params.set('limit', '1');
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: supabaseHeaders(env),
  });
  if (!resp.ok) return { error: await resp.text() };
  const data = await resp.json();
  return { data: Array.isArray(data) ? data[0] : data };
}

async function supabasePatch(env, path, fields) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: supabaseHeaders(env),
    body: JSON.stringify(fields),
  });
  return { ok: resp.ok };
}

// ── Resend email to Tim ─────────────────────────────────────────────────────
async function emailDesigner(env, intent, proposal) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'No Resend key' };

  const address = proposal?.project_address || 'Untitled project';
  const amount = proposal?.bid_total_amount
    ? '$' + Number(proposal.bid_total_amount).toLocaleString('en-US', { maximumFractionDigits: 0 })
    : null;

  const subject =
    '🔒 ' + intent.viewer_name + ' wants to lock in ' + address +
    (amount ? ' · ' + amount : '');

  const proposalUrl = intent.published_slug
    ? `https://portal-baysidepavers.com/p/${intent.published_slug}`
    : `https://portal-baysidepavers.com/admin/pipeline.html`;

  const jnSearchUrl =
    'https://app.jobnimbus.com/people?search=' + encodeURIComponent(intent.viewer_email);

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#0e1218;background:#fff;">
  <div style="border-bottom:3px solid #5d7e69;padding-bottom:14px;margin-bottom:22px;">
    <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#5d7e69;font-weight:700;margin-bottom:6px;">CONTRACT SIGNATURE REQUEST · BAYSIDE PORTAL</div>
    <h1 style="font-size:22px;margin:0;color:#0e1218;line-height:1.25;font-weight:600;">${esc(intent.viewer_name)} is ready to sign.</h1>
  </div>

  <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:22px;border-collapse:collapse;">
    <tr><td style="padding:8px 0;color:#666;font-size:13px;width:120px;">Project</td>
        <td style="padding:8px 0;text-align:right;font-weight:600;font-size:14px;">${esc(address)}</td></tr>
    ${amount ? `<tr><td style="padding:8px 0;color:#666;font-size:13px;">Contract value</td>
        <td style="padding:8px 0;text-align:right;font-weight:700;color:#5d7e69;font-size:18px;">${amount}</td></tr>` : ''}
    <tr><td style="padding:8px 0;color:#666;font-size:13px;">Email</td>
        <td style="padding:8px 0;text-align:right;"><a href="mailto:${esc(intent.viewer_email)}" style="color:#5d7e69;text-decoration:none;">${esc(intent.viewer_email)}</a></td></tr>
    ${intent.viewer_phone ? `<tr><td style="padding:8px 0;color:#666;font-size:13px;">Phone</td>
        <td style="padding:8px 0;text-align:right;"><a href="tel:${esc(intent.viewer_phone)}" style="color:#5d7e69;text-decoration:none;">${esc(intent.viewer_phone)}</a></td></tr>` : ''}
  </table>

  ${intent.viewer_message ? `
    <div style="background:#faf8f3;border-left:3px solid #b78b3a;padding:14px 16px;margin-bottom:24px;border-radius:4px;">
      <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#b78b3a;font-weight:700;margin-bottom:6px;">CLIENT NOTE</div>
      <div style="font-size:14px;color:#0e1218;line-height:1.55;">${esc(intent.viewer_message)}</div>
    </div>` : ''}

  <div style="margin:28px 0 22px;">
    <a href="${jnSearchUrl}" style="display:inline-block;background:#5d7e69;color:#fff;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:600;font-size:14px;margin-right:8px;margin-bottom:8px;">📋 Open in JobNimbus →</a>
    <a href="${proposalUrl}" style="display:inline-block;background:#fff;color:#0e1218;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:600;font-size:14px;border:1px solid #ddd;margin-bottom:8px;">View proposal</a>
  </div>

  <div style="background:#f7f8f5;border-radius:8px;padding:16px 18px;margin-bottom:24px;font-size:13px;color:#4a5450;line-height:1.55;">
    <strong style="color:#0e1218;">Next step</strong> — open JobNimbus, locate <strong>${esc(intent.viewer_name)}</strong>, and send the contract for e-signature. The Portal already has the lead's contact + the proposal record tagged. Reply directly to this email and it'll go to ${esc(intent.viewer_email)}.
  </div>

  <div style="border-top:1px solid #eee;padding-top:14px;color:#999;font-size:11px;line-height:1.5;">
    Signature intent ID: <code style="background:#f5f5f5;padding:2px 6px;border-radius:3px;font-family:monospace;">${intent.id.slice(0, 8)}</code> · Marked notified in Bayside Portal.
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
        from: FROM_ADDRESS,
        to: [TIM_EMAIL],
        reply_to: intent.viewer_email,
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('Resend failed:', err);
      return { ok: false, error: err };
    }
    return { ok: true };
  } catch (e) {
    console.error('Resend exception:', e);
    return { ok: false, error: e.message };
  }
}

// ── JobNimbus contact (best-effort) ────────────────────────────────────────
async function upsertJobNimbusContact(env, intent, proposal) {
  if (!env.JOBNIMBUS_API_KEY) return { ok: false };

  try {
    const parts = intent.viewer_name.trim().split(/\s+/);
    const first_name = parts.shift() || '';
    const last_name = parts.join(' ') || '';

    const description =
      `Bayside Portal — Contract signature requested\n\n` +
      `Project: ${proposal?.project_address || 'Unknown'}\n` +
      (proposal?.bid_total_amount
        ? `Amount: $${Number(proposal.bid_total_amount).toLocaleString('en-US')}\n`
        : '') +
      `Signature intent: ${intent.id}\n` +
      (intent.viewer_message ? `\nClient note: ${intent.viewer_message}\n` : '') +
      `\nView in Portal: https://portal-baysidepavers.com/admin/pipeline.html`;

    const resp = await fetch('https://app.jobnimbus.com/api1/contacts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.JOBNIMBUS_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        first_name,
        last_name,
        email: intent.viewer_email,
        mobile_phone: intent.viewer_phone || '',
        address_line1: proposal?.project_address || '',
        description,
        status_name: 'Contract Pending',
        tags: 'Bayside Portal, Contract Pending',
      }),
    });
    return { ok: resp.ok, status: resp.status };
  } catch (e) {
    console.error('JobNimbus exception:', e);
    return { ok: false, error: e.message };
  }
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
