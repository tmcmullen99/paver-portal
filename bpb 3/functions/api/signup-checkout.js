// ═══════════════════════════════════════════════════════════════════════════
// /api/signup-checkout — SPRINT 6B (self-serve signup, step 1 of 2)
//
// POST { company_name, owner_name, email, password }
//   1. Validates input; derives a unique slug from the company name.
//   2. Creates the Supabase auth user (email pre-confirmed — payment is the
//      verification gate) via the admin API.
//   3. Creates a Stripe Checkout Session (subscription, 14-day trial) with
//      everything the webhook needs in metadata.
//   4. Returns { url } — the client redirects to Stripe.
//
// Provisioning happens ONLY in /api/stripe-webhook after
// checkout.session.completed, so an abandoned checkout leaves just an
// unprovisioned auth user (harmless; their profile stays inactive).
//
// PLANS:
//   individual → STRIPE_PRICE_INDIVIDUAL ($49/mo), 10-day trial,
//                3-proposal trial cap enforced in the database
//   team       → STRIPE_PRICE_TEAM ($249/mo base), no trial (onboarding-led);
//                $19/designer seats attach to the subscription when the
//                owner invites designers (post-launch wiring)
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY),
//      STRIPE_SECRET_KEY, STRIPE_PRICE_INDIVIDUAL, STRIPE_PRICE_TEAM,
//      PUBLIC_BASE_URL (optional)
// ═══════════════════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });
const svcKey = (env) => env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'company';
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.STRIPE_SECRET_KEY || (!env.STRIPE_PRICE_INDIVIDUAL && !env.STRIPE_PRICE_ID)) {
    return json({ error: 'Signup is not configured yet (Stripe keys missing).' }, 500);
  }
  if (!env.SUPABASE_URL || !svcKey(env)) return json({ error: 'Server misconfigured' }, 500);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }

  const plan = body.plan === 'team' ? 'team' : 'individual';
  const companyName = String(body.company_name || '').trim();
  const ownerName   = String(body.owner_name || '').trim();
  const email       = String(body.email || '').trim().toLowerCase();
  const password    = String(body.password || '');

  if (companyName.length < 2)  return json({ error: 'Company name is required.' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'A valid email is required.' }, 400);
  if (password.length < 8)     return json({ error: 'Password must be at least 8 characters.' }, 400);

  const headers = {
    apikey: svcKey(env),
    Authorization: `Bearer ${svcKey(env)}`,
    'Content-Type': 'application/json',
  };

  // ── Unique slug ──
  let slug = slugify(companyName);
  try {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/companies?slug=like.${encodeURIComponent(slug + '%')}&select=slug`,
      { headers }
    );
    if (r.ok) {
      const taken = new Set((await r.json()).map(c => c.slug));
      if (taken.has(slug)) {
        let i = 2;
        while (taken.has(`${slug}-${i}`) && i < 100) i++;
        slug = `${slug}-${i}`;
      }
    }
  } catch (_) { /* collision would surface at provisioning; acceptable */ }

  // ── Create the auth user (pre-confirmed; payment is the gate) ──
  let userId = null;
  {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: ownerName || null, signup_company: companyName },
      }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (out && (out.msg || out.message || out.error_description || '')) + '';
      if (/already|exists|registered/i.test(msg)) {
        return json({ error: 'That email already has an account. Sign in instead, or use a different email.' }, 409);
      }
      console.error('signup-checkout: createUser failed', r.status, msg);
      return json({ error: 'Could not create your account. Please try again.' }, 502);
    }
    userId = out.id || (out.user && out.user.id);
    if (!userId) return json({ error: 'Could not create your account. Please try again.' }, 502);
  }

  // ── Stripe Checkout Session ──
  const base = env.PUBLIC_BASE_URL || new URL(request.url).origin;
  const priceId = plan === 'team'
    ? (env.STRIPE_PRICE_TEAM || env.STRIPE_PRICE_ID)
    : (env.STRIPE_PRICE_INDIVIDUAL || env.STRIPE_PRICE_ID);
  const form = new URLSearchParams({
    mode: 'subscription',
    customer_email: email,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    success_url: `${base}/welcome-owner.html?paid=1`,
    cancel_url: `${base}/signup.html?canceled=1&plan=${plan}`,
    'metadata[user_id]': userId,
    'metadata[company_name]': companyName,
    'metadata[slug]': slug,
    'metadata[owner_name]': ownerName,
    'metadata[email]': email,
    'metadata[plan]': plan,
    'subscription_data[metadata][user_id]': userId,
    allow_promotion_codes: 'true',
  });
  // Individual: 10-day free trial (3-proposal cap enforced in the DB).
  // Team: paid from day one; onboarding call replaces the trial.
  if (plan === 'individual') {
    form.set('subscription_data[trial_period_days]', '10');
  }

  const sResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const session = await sResp.json().catch(() => ({}));
  if (!sResp.ok || !session.url) {
    console.error('signup-checkout: stripe session failed', sResp.status, session && session.error && session.error.message);
    return json({ error: 'Could not start checkout. Please try again.' }, 502);
  }

  return json({ ok: true, url: session.url });
}
