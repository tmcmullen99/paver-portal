// ═══════════════════════════════════════════════════════════════════════════
// /api/outreach-scrape — quota-matched prospect acquisition.
//
// Called daily by pg_cron (x-cron-secret) or manually from the operator
// console (master JWT). Pulls landscaping/hardscaping companies from the
// Google Places API for the current city in the rotation, keeps only ones
// whose profile or website mentions pavers, enriches an email address from
// the website, and inserts up to daily_scrape_quota NEW prospects.
//
// Scrape only what you'll send — data cost tracks campaign size exactly.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_PLACES_API_KEY
// ═══════════════════════════════════════════════════════════════════════════

const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const svcKey = (env) => env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;

async function authorized(request, env, headers) {
  // path 1: cron secret
  const secret = request.headers.get('x-cron-secret');
  if (secret) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/outreach_config?id=eq.1&select=cron_secret`, { headers });
    const rows = r.ok ? await r.json() : [];
    return rows[0] && rows[0].cron_secret === secret;
  }
  // path 2: founding-master JWT (console button)
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const u = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: svcKey(env) },
  });
  if (!u.ok) return false;
  const user = await u.json();
  const p = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role,is_active,company_id`, { headers });
  const prof = (p.ok ? await p.json() : [])[0];
  return prof && prof.is_active && prof.role === 'master'
    && prof.company_id === '00000000-0000-0000-0000-000000000001';
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SKIP_EMAIL = /(example\.|sentry|wixpress|\.png|\.jpg|\.gif|godaddy|schema\.org|yourdomain)/i;

async function findEmail(website) {
  if (!website) return null;
  const pages = [website, website.replace(/\/$/, '') + '/contact', website.replace(/\/$/, '') + '/contact-us'];
  for (const url of pages) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaverPortalBot/1.0)' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) continue;
      const html = (await r.text()).slice(0, 400000);
      const found = (html.match(EMAIL_RE) || []).filter(e => !SKIP_EMAIL.test(e));
      if (found.length) {
        // prefer info@/office@/hello@/contact@ over random ones
        const pref = found.find(e => /^(info|office|hello|contact|sales|estimates?)@/i.test(e));
        return (pref || found[0]).toLowerCase();
      }
    } catch (_) { /* next page */ }
  }
  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.SUPABASE_URL || !svcKey(env)) return json({ error: 'Server misconfigured' }, 500);
  if (!env.GOOGLE_PLACES_API_KEY) return json({ error: 'GOOGLE_PLACES_API_KEY not set' }, 500);

  const headers = {
    apikey: svcKey(env),
    Authorization: `Bearer ${svcKey(env)}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  if (!(await authorized(request, env, headers))) return json({ error: 'Unauthorized' }, 401);

  // config + rotation
  const cfgR = await fetch(`${env.SUPABASE_URL}/rest/v1/outreach_config?id=eq.1`, { headers });
  const cfg = (await cfgR.json())[0];
  if (!cfg) return json({ error: 'No config' }, 500);
  if (!cfg.scraping_enabled && !request.headers.get('Authorization')) {
    return json({ ok: true, skipped: 'scraping_enabled = false' });
  }

  const cities = cfg.target_cities || [];
  if (!cities.length) return json({ error: 'No target cities' }, 500);
  const target = cities[cfg.rotation_index % cities.length];
  const quota = Math.max(1, Math.min(50, cfg.daily_scrape_quota || 10));

  // Places Text Search — two queries to widen the paver net
  const queries = [
    `paver installation ${target.city} ${target.state}`,
    `hardscaping contractor ${target.city} ${target.state}`,
  ];
  const seen = new Map();
  for (const q of queries) {
    try {
      const r = await fetch(
        `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&key=${env.GOOGLE_PLACES_API_KEY}`);
      const out = await r.json();
      for (const place of out.results || []) {
        if (!seen.has(place.place_id)) seen.set(place.place_id, place);
      }
    } catch (err) { console.error('places search failed', q, err.message); }
  }
  if (!seen.size) return json({ ok: true, city: target, added: 0, note: 'no places results' });

  // which are already in the base?
  const ids = Array.from(seen.keys());
  const exR = await fetch(
    `${env.SUPABASE_URL}/rest/v1/prospects?place_id=in.(${ids.map(i => `"${i}"`).join(',')})&select=place_id`, { headers });
  const existing = new Set((exR.ok ? await exR.json() : []).map(r => r.place_id));

  const fresh = Array.from(seen.values()).filter(p => !existing.has(p.place_id));
  const added = [];

  for (const place of fresh) {
    if (added.length >= quota) break;
    try {
      // details: website + phone
      const dR = await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=website,formatted_phone_number,name&key=${env.GOOGLE_PLACES_API_KEY}`);
      const det = (await dR.json()).result || {};
      const website = det.website || null;

      // paver relevance: name/profile text, else website content
      let paver = /paver|hardscap/i.test(`${place.name} ${(place.types || []).join(' ')}`);
      let email = null;
      if (website) {
        try {
          const wr = await fetch(website, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaverPortalBot/1.0)' },
            signal: AbortSignal.timeout(6000),
          });
          if (wr.ok) {
            const html = (await wr.text()).slice(0, 400000);
            if (!paver) paver = /paver/i.test(html);
            const found = (html.match(EMAIL_RE) || []).filter(e => !SKIP_EMAIL.test(e));
            const pref = found.find(e => /^(info|office|hello|contact|sales|estimates?)@/i.test(e));
            email = (pref || found[0] || '').toLowerCase() || null;
          }
        } catch (_) {}
        if (!email) email = await findEmail(website);
      }
      if (!paver) continue; // pavers-specific per campaign spec

      const ins = await fetch(`${env.SUPABASE_URL}/rest/v1/prospects`, {
        method: 'POST', headers,
        body: JSON.stringify({
          place_id: place.place_id,
          company_name: det.name || place.name,
          city: target.city, state: target.state,
          phone: det.formatted_phone_number || null,
          website, email,
          paver_mention: true,
          status: email ? 'new' : 'dead',       // no email = can't drip; parked
          notes: email ? null : 'no email found on site',
        }),
      });
      if (ins.ok) added.push({ name: det.name || place.name, email: email || '(none)' });
    } catch (err) { console.error('enrich failed', place.name, err.message); }
  }

  // advance the rotation
  await fetch(`${env.SUPABASE_URL}/rest/v1/outreach_config?id=eq.1`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ rotation_index: (cfg.rotation_index + 1) % cities.length, updated_at: new Date().toISOString() }),
  });

  console.log(`outreach-scrape: ${target.city}, ${target.state} → +${added.length}`);
  return json({ ok: true, city: target, candidates: fresh.length, added: added.length, prospects: added });
}
