// ═══════════════════════════════════════════════════════════════════════════
// /api/stripe-webhook — SPRINT 6B (self-serve signup, step 2 of 2)
//
// Verifies Stripe signatures (HMAC-SHA256 via Web Crypto — no SDK) and:
//   • checkout.session.completed  → provision_company() + store Stripe ids
//   • customer.subscription.updated → map status (trialing→trial,
//     active→active, past_due→past_due, canceled/unpaid→suspended)
//   • customer.subscription.deleted → suspended
//
// Idempotent: re-delivered checkout events are ignored if the customer is
// already provisioned.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY),
//      STRIPE_WEBHOOK_SECRET
// ═══════════════════════════════════════════════════════════════════════════

const svcKey = (env) => env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
const ok = (b = { received: true }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const err = (msg, s = 400) =>
  new Response(JSON.stringify({ error: msg }), { status: s, headers: { 'Content-Type': 'application/json' } });

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map(kv => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; })
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  // Reject stale events (>10 min) to blunt replay
  if (Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');

  // constant-time-ish compare
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

function mapStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'trialing': return 'trial';
    case 'active':   return 'active';
    case 'past_due': return 'past_due';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired': return 'suspended';
    default: return null; // incomplete / paused → leave as-is
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.STRIPE_WEBHOOK_SECRET) return err('Webhook not configured', 500);
  if (!env.SUPABASE_URL || !svcKey(env)) return err('Server misconfigured', 500);

  const payload = await request.text();
  const valid = await verifyStripeSignature(payload, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return err('Invalid signature', 401);

  let event;
  try { event = JSON.parse(payload); } catch (_) { return err('Invalid payload'); }

  const headers = {
    apikey: svcKey(env),
    Authorization: `Bearer ${svcKey(env)}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const md = s.metadata || {};
      if (!md.user_id || !md.company_name || !md.slug) {
        console.error('stripe-webhook: session missing metadata', s.id);
        return ok({ received: true, note: 'no metadata' });
      }

      // Idempotency: already provisioned for this customer?
      const existing = await fetch(
        `${env.SUPABASE_URL}/rest/v1/companies?stripe_customer_id=eq.${encodeURIComponent(s.customer)}&select=id&limit=1`,
        { headers }
      );
      if (existing.ok && (await existing.json()).length) return ok({ received: true, note: 'already provisioned' });

      // Provision
      const rpc = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/provision_company`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_company_name: md.company_name,
          p_slug: md.slug,
          p_owner_user_id: md.user_id,
          p_owner_email: md.email || s.customer_details?.email || '',
          p_owner_name: md.owner_name || null,
          p_plan: md.plan === 'team' ? 'team' : 'individual',
        }),
      });
      const companyId = await rpc.json().catch(() => null);
      if (!rpc.ok || !companyId) {
        const detail = typeof companyId === 'object' ? JSON.stringify(companyId) : companyId;
        console.error('stripe-webhook: provisioning failed', rpc.status, detail);
        // 500 → Stripe retries; provisioning is idempotent-safe via the check above
        return err('Provisioning failed', 500);
      }

      // Attach Stripe identifiers
      await fetch(`${env.SUPABASE_URL}/rest/v1/companies?id=eq.${encodeURIComponent(companyId)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          stripe_customer_id: s.customer,
          stripe_subscription_id: s.subscription || null,
          // status is set by provision_company (individual→trial,
          // team→active); only the Stripe identifiers attach here.
        }),
      });
      console.log('stripe-webhook: provisioned company', companyId, 'for', md.email);
      return ok({ received: true, provisioned: companyId });
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const status = event.type === 'customer.subscription.deleted' ? 'suspended' : mapStatus(sub.status);
      const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
      if (status || periodEnd) {
        await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/set_company_billing`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            p_customer_id: sub.customer,
            p_subscription_id: sub.id,
            p_status: status,
            p_period_end: periodEnd,
          }),
        });
      }
      return ok();
    }

    return ok({ received: true, ignored: event.type });
  } catch (e) {
    console.error('stripe-webhook error:', e);
    return err('Webhook processing failed', 500);
  }
}
