// ═══════════════════════════════════════════════════════════════════════════
// /api/outreach-send — the daily drip.
//
// Called by pg_cron (x-cron-secret) or the console. Picks prospects due for
// their next step (new prospects start at step 1; each step schedules the
// next by delay_days), renders merge fields, sends via Resend, and logs to
// outreach_sends with an open pixel + tracked CTA links.
//
// SAFETY: sending_enabled=false by default — nothing sends until the
// outbound domain is configured and the flag is flipped in the console.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
// ═══════════════════════════════════════════════════════════════════════════

const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const svcKey = (env) => env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;

async function authorized(request, env, headers) {
  const secret = request.headers.get('x-cron-secret');
  if (secret) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/outreach_config?id=eq.1&select=cron_secret`, { headers });
    const rows = r.ok ? await r.json() : [];
    return rows[0] && rows[0].cron_secret === secret;
  }
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const u = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: auth, apikey: svcKey(env) } });
  if (!u.ok) return false;
  const user = await u.json();
  const p = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role,is_active,company_id`, { headers });
  const prof = (p.ok ? await p.json() : [])[0];
  return prof && prof.is_active && prof.role === 'master'
    && prof.company_id === '00000000-0000-0000-0000-000000000001';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(step, prospect, cfg, sendId) {
  const base = 'https://paverportal.com';
  const track = (dest) =>
    `${base}/api/outreach-track?a=click&s=${sendId}&to=${encodeURIComponent(dest)}`;
  const bookingLink = track(cfg.booking_url || base + '/#team');
  const ctaLink = track(base + '/?utm_source=outreach&utm_campaign=drip&utm_content=step' + step.step);
  const unsub = `${base}/api/outreach-track?a=unsub&s=${sendId}`;
  const firstName = ''; // Places gives company names, not people — greet by company
  const greetName = firstName || 'there';

  let text = step.body_text
    .replaceAll('{{first_name}}', greetName)
    .replaceAll('{{company_name}}', prospect.company_name)
    .replaceAll('{{from_name}}', cfg.from_name)
    .replaceAll('{{booking_link}}', bookingLink)
    .replaceAll('{{cta_link}}', ctaLink)
    .replaceAll('{{unsub_footer}}',
      `--\n${cfg.postal_address}\nUnsubscribe: ${unsub}`);

  // light HTML wrapper: paragraphs + real links + open pixel
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#23282f;max-width:560px;">'
    + text.split('\n\n').map(p => {
        const withLinks = esc(p).replace(/(https?:\/\/[^\s<]+)/g, (m) => `<a href="${m}" style="color:#7d5c31;">${m.includes('outreach-track?a=unsub') ? 'Unsubscribe' : m.includes('a=click') ? (m.includes('booking') || m === esc(bookingLink) ? 'Grab 15 minutes here' : 'paverportal.com') : m}</a>`);
        return `<p>${withLinks.replace(/\n/g, '<br>')}</p>`;
      }).join('')
    + `<img src="${base}/api/outreach-track?a=open&s=${sendId}" width="1" height="1" alt="" style="display:none;">`
    + '</div>';

  return { text, html, subject: step.subject };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.SUPABASE_URL || !svcKey(env)) return json({ error: 'Server misconfigured' }, 500);

  const headers = {
    apikey: svcKey(env), Authorization: `Bearer ${svcKey(env)}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
  };
  if (!(await authorized(request, env, headers))) return json({ error: 'Unauthorized' }, 401);

  const cfg = (await (await fetch(`${env.SUPABASE_URL}/rest/v1/outreach_config?id=eq.1`, { headers })).json())[0];
  if (!cfg) return json({ error: 'No config' }, 500);
  if (!cfg.sending_enabled) return json({ ok: true, skipped: 'sending_enabled = false' });
  if (!env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY not set' }, 500);

  const steps = await (await fetch(`${env.SUPABASE_URL}/rest/v1/outreach_steps?order=step`, { headers })).json();
  const maxStep = Math.max(...steps.map(s => s.step));
  const quota = Math.max(1, Math.min(200, cfg.daily_send_quota || 60));
  const now = new Date().toISOString();

  // due = brand-new prospects (step 0) + in-sequence ones whose next_send_at passed
  const dueR = await fetch(
    `${env.SUPABASE_URL}/rest/v1/prospects` +
    `?or=(and(status.eq.new,email.not.is.null),and(status.in.(in_sequence,clicked),next_send_at.lte.${encodeURIComponent(now)}))` +
    `&order=created_at.asc&limit=${quota}`, { headers });
  const due = dueR.ok ? await dueR.json() : [];
  if (!due.length) return json({ ok: true, sent: 0, note: 'nothing due' });

  let sent = 0, failed = 0;
  for (const p of due) {
    const nextStepNum = (p.sequence_step || 0) + 1;
    const step = steps.find(s => s.step === nextStepNum);
    if (!step) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/prospects?id=eq.${p.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ status: 'completed', updated_at: now }),
      });
      continue;
    }

    // pre-create the send row so tracking links carry its id
    const sr = await fetch(`${env.SUPABASE_URL}/rest/v1/outreach_sends`, {
      method: 'POST', headers,
      body: JSON.stringify({ prospect_id: p.id, step: step.step }),
    });
    const sendRow = (sr.ok ? await sr.json() : [])[0];
    if (!sendRow) { failed++; continue; }

    const { text, html, subject } = render(step, p, cfg, sendRow.id);

    const mail = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${cfg.from_name} <${cfg.from_email}>`,
        to: [p.email],
        subject, text, html,
        headers: { 'List-Unsubscribe': `<https://paverportal.com/api/outreach-track?a=unsub&s=${sendRow.id}>` },
      }),
    });

    if (mail.ok) {
      const out = await mail.json();
      sent++;
      const delayNext = steps.find(s => s.step === step.step + 1);
      const nextAt = delayNext
        ? new Date(Date.now() + (delayNext.delay_days - step.delay_days) * 86400000).toISOString()
        : null;
      await Promise.all([
        fetch(`${env.SUPABASE_URL}/rest/v1/outreach_sends?id=eq.${sendRow.id}`, {
          method: 'PATCH', headers, body: JSON.stringify({ message_id: out.id || null }),
        }),
        fetch(`${env.SUPABASE_URL}/rest/v1/prospects?id=eq.${p.id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({
            status: step.step >= maxStep ? 'completed' : (p.status === 'clicked' ? 'clicked' : 'in_sequence'),
            sequence_step: step.step,
            next_send_at: nextAt,
            updated_at: now,
          }),
        }),
      ]);
    } else {
      failed++;
      const errTxt = await mail.text();
      console.error('resend failed for', p.email, errTxt.slice(0, 200));
      await fetch(`${env.SUPABASE_URL}/rest/v1/outreach_sends?id=eq.${sendRow.id}`, { method: 'DELETE', headers });
    }
  }

  console.log(`outreach-send: sent ${sent}, failed ${failed}, due ${due.length}`);
  return json({ ok: true, sent, failed, due: due.length });
}
