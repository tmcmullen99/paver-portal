// ═══════════════════════════════════════════════════════════════════════════
// /api/refer-signup — Phase 1
//
// Anonymous public endpoint hit by /refer.html when a friend-of-a-client
// submits the "Book my free consultation" form. Validates the refer_code,
// creates a referrals row (status='sent'), and emails Tim with the lead
// details. Returns a prefilled Acuity booking URL the page redirects to.
//
// Body (JSON):
//   { refer_code, referred_name, referred_email, referred_phone?, notes? }
// ═══════════════════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TIM_EMAIL = 'tim@mcmullen.properties';
const FROM_ADDRESS = 'Paver Portal Portal <tim@mcmullen.properties>';
const ACUITY_URL = 'https://baysidepaversfreeconsultation.as.me/';

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

// GET: validate a refer_code and return the referrer's first name
// (used by /refer.html to display "Elisa thinks you'd love Paver Portal")
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim();
  if (!code) return json({ error: 'Missing code' }, 400);

  const referrer = await lookupReferrer(env, code);
  if (!referrer) return json({ error: 'Invalid referral code' }, 404);

  const firstName = (referrer.name || '').split(/\s+/)[0] || 'Someone';
  return json({ ok: true, referrer_first_name: firstName, refer_code: code });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const refer_code = (body.refer_code || '').trim();
    const referred_name = (body.referred_name || '').trim();
    const referred_email = (body.referred_email || '').trim().toLowerCase();
    const referred_phone = (body.referred_phone || '').trim() || null;
    const notes = (body.notes || '').trim() || null;

    if (!refer_code || !referred_name || !referred_email) {
      return json({ error: 'Missing required fields' }, 400);
    }

    const referrer = await lookupReferrer(env, refer_code);
    if (!referrer) return json({ error: 'Invalid referral code' }, 404);

    // Insert referrals row
    const insertResp = await fetch(`${env.SUPABASE_URL}/rest/v1/referrals`, {
      method: 'POST',
      headers: supabaseHeaders(env, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        referrer_client_id: referrer.id,
        referred_name,
        referred_email,
        referred_phone,
        notes,
        status: 'sent',
      }),
    });
    if (!insertResp.ok) {
      console.error('Referral insert failed:', await insertResp.text());
      return json({ error: 'Could not record your referral. Please try again.' }, 500);
    }
    const arr = await insertResp.json();
    const referral = arr[0];

    // Email Tim (best-effort)
    await emailReferralLead(env, referrer, referral);

    // Build the Acuity prefill URL
    const nameParts = referred_name.split(/\s+/);
    const bookingUrl = new URL(ACUITY_URL);
    bookingUrl.searchParams.set('firstName', nameParts[0] || '');
    bookingUrl.searchParams.set('lastName', nameParts.slice(1).join(' ') || '');
    bookingUrl.searchParams.set('email', referred_email);
    if (referred_phone) bookingUrl.searchParams.set('phone', referred_phone);

    return json({
      ok: true,
      message: 'Tim has been notified. Click below to book your free design consultation.',
      booking_url: bookingUrl.toString(),
      referral_id: referral.id,
    });
  } catch (err) {
    console.error('refer-signup error:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function lookupReferrer(env, code) {
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/clients?refer_code=eq.${encodeURIComponent(code)}&select=id,name,email&limit=1`,
    { headers: supabaseHeaders(env) }
  );
  if (!resp.ok) return null;
  const rows = await resp.json();
  return rows[0] || null;
}

function supabaseHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function emailReferralLead(env, referrer, referral) {
  if (!env.RESEND_API_KEY) return;
  const subject = `🎁 New referral: ${referral.referred_name} (from ${referrer.name})`;
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#0e1218;">
  <div style="border-bottom:3px solid #9c7440;padding-bottom:14px;margin-bottom:22px;">
    <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#9c7440;font-weight:700;margin-bottom:6px;">NEW REFERRAL LEAD · PAVER PORTAL PORTAL</div>
    <h1 style="font-size:22px;margin:0;color:#0e1218;line-height:1.25;font-weight:600;">${esc(referrer.name)} just referred someone new.</h1>
  </div>

  <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:22px;">
    <tr><td style="padding:8px 0;color:#666;font-size:13px;width:120px;">Name</td>
        <td style="padding:8px 0;text-align:right;font-weight:600;">${esc(referral.referred_name)}</td></tr>
    <tr><td style="padding:8px 0;color:#666;font-size:13px;">Email</td>
        <td style="padding:8px 0;text-align:right;"><a href="mailto:${esc(referral.referred_email)}" style="color:#9c7440;text-decoration:none;">${esc(referral.referred_email)}</a></td></tr>
    ${referral.referred_phone ? `<tr><td style="padding:8px 0;color:#666;font-size:13px;">Phone</td>
        <td style="padding:8px 0;text-align:right;"><a href="tel:${esc(referral.referred_phone)}" style="color:#9c7440;text-decoration:none;">${esc(referral.referred_phone)}</a></td></tr>` : ''}
    ${referral.notes ? `<tr><td style="padding:8px 0;color:#666;font-size:13px;vertical-align:top;">Notes</td>
        <td style="padding:8px 0;text-align:right;font-size:13px;">${esc(referral.notes)}</td></tr>` : ''}
  </table>

  <div style="background:#fffbe6;border-left:3px solid #b78b3a;padding:14px 16px;border-radius:4px;color:#7a5a10;font-size:13px;line-height:1.55;">
    <strong>$500 credit pending</strong> for ${esc(referrer.name)}. Mark this referral's <code style="background:rgba(122,90,16,0.12);padding:2px 6px;border-radius:3px;">credit_awarded_at = now()</code> in the Substitutions / Redesigns admin (or Supabase directly) once the design appointment is on the calendar — the credit will auto-apply.
  </div>

  <p style="margin-top:24px;font-size:11px;color:#999;">Referral ID: <code style="background:#f5f5f5;padding:2px 6px;border-radius:3px;">${referral.id.slice(0,8)}</code></p>
</div>`.trim();

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [TIM_EMAIL],
        reply_to: referral.referred_email,
        subject,
        html,
      }),
    });
  } catch (e) {
    console.error('Resend exception (referral lead):', e);
  }
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
