// ═══════════════════════════════════════════════════════════════════════════
// POST /api/track-events
//
// Ingest endpoint for proposal-tracker.js batched events. Validates each
// event against an allowlist, writes via service role (bypasses RLS),
// returns 204 on success.
//
// Phase 5F.1: after a successful insert, kicks off a background task via
// ctx.waitUntil that scans the batch for "first views" — events from a
// (proposal_id, session_id) pair that has no prior events in the table.
// For each first view, looks up the proposal owner, checks their
// notification prefs, and sends a Resend email if conditions are met.
// All notification work happens after the 204 response, so the tracker
// stays fast.
//
// Environment variables (set in CF Pages → Settings → Environment variables):
//   SUPABASE_URL                 — same as used by /functions/p/[slug].js
//   SUPABASE_SERVICE_ROLE_KEY    — required so writes can bypass RLS
//   RESEND_API_KEY               — for outbound notification emails
//   RESEND_FROM                  — optional, defaults to tim@mcmullen.properties
//
// Rate limiting: deferred. Volume is currently low. When justified, configure
// CF Rate Limiting rules at the platform level — free, edge-enforced, tunable
// from the dashboard, and doesn't require code changes here.
// ═══════════════════════════════════════════════════════════════════════════

const VALID_EVENT_TYPES = new Set([
  'page_view',
  'section_view',
  'bid_section_click',
  'swap_modal_open',
  'swap_save',
  'referral_share_click',
  'sign_in_cta_click',
  'quality_tab_click',
  'accept_proposal_click',
]);

const MAX_BATCH_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Phase 5F: notification rate-limit window. One first_view email per
// (proposal, recipient) per hour, no matter how many sessions or refreshes.
const FIRST_VIEW_RATE_LIMIT_MS = 60 * 60 * 1000;
const PUBLIC_BASE_URL = 'https://portal-baysidepavers.com';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonError(500, 'Server misconfigured — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Invalid JSON');
  }

  const events = Array.isArray(body && body.events) ? body.events : [];
  if (events.length === 0) {
    return new Response(null, { status: 204 });
  }
  if (events.length > MAX_BATCH_SIZE) {
    return jsonError(400, `Batch too large (max ${MAX_BATCH_SIZE} events)`);
  }

  const rows = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e !== 'object') {
      return jsonError(400, `Event ${i}: not an object`);
    }
    if (!VALID_EVENT_TYPES.has(e.event_type)) {
      return jsonError(400, `Event ${i}: unknown event_type "${String(e.event_type)}"`);
    }
    if (typeof e.session_id !== 'string' || !UUID_RE.test(e.session_id)) {
      return jsonError(400, `Event ${i}: invalid session_id`);
    }

    rows.push({
      event_type: e.event_type,
      proposal_id: validUuidOrNull(e.proposal_id),
      published_proposal_id: validUuidOrNull(e.published_proposal_id),
      slug: typeof e.slug === 'string' ? e.slug.slice(0, 200) : null,
      session_id: e.session_id,
      client_id: validUuidOrNull(e.client_id),
      occurred_at: parseTimestamp(e.occurred_at),
      viewport_w: clampInt(e.viewport_w, 0, 100000),
      viewport_h: clampInt(e.viewport_h, 0, 100000),
      user_agent: trimString(e.user_agent, 500),
      referrer: trimString(e.referrer, 500),
      payload: (e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload))
        ? e.payload
        : {},
    });
  }

  const url = `${env.SUPABASE_URL}/rest/v1/proposal_events`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
  } catch (err) {
    return jsonError(502, 'Could not reach database: ' + (err.message || String(err)));
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error('Supabase insert failed:', resp.status, detail);
    return jsonError(502, `Database returned ${resp.status}`);
  }

  // Phase 5F.1: kick off first-view detection AFTER the response sends.
  // ctx.waitUntil keeps the worker alive long enough to finish even though
  // the client has already received the 204. Failures here log to console
  // but never affect the tracker's success status.
  if (env.RESEND_API_KEY) {
    context.waitUntil(detectFirstViewsAndNotify(rows, env).catch((err) => {
      console.error('[5F.1] first-view detection failed:', err);
    }));
  }

  return new Response(null, { status: 204 });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// ─── Phase 5F.1: first-view detection + notification ─────────────────────
//
// "First view" = an event whose (proposal_id, session_id) has no PRIOR
// events in proposal_events outside this batch. We check by counting
// matching rows older than the earliest occurred_at in the batch. If
// count == 0, this session is brand new on this proposal.
//
// For each unique first-view, we:
//   1. Look up proposals.owner_user_id → profiles.email + notification_prefs
//   2. Check pref.first_view is true
//   3. Check quiet hours (skip if currently in quiet window)
//   4. Check rate limit (no prior 'sent' first_view email for this
//      proposal+recipient in the last hour)
//   5. Send via Resend
//   6. Log to notification_log with status (sent/skipped_*/failed)
async function detectFirstViewsAndNotify(rows, env) {
  // Group rows by (proposal_id, session_id) to find unique session-on-proposal
  // pairs in this batch — one first-view check per pair, not per event.
  const pairs = new Map();
  for (const r of rows) {
    if (!r.proposal_id || !r.session_id) continue;
    const key = r.proposal_id + '|' + r.session_id;
    if (!pairs.has(key)) {
      pairs.set(key, {
        proposal_id: r.proposal_id,
        session_id: r.session_id,
        slug: r.slug,
        viewport_w: r.viewport_w,
        occurred_at: r.occurred_at,
      });
    } else {
      const existing = pairs.get(key);
      if (r.occurred_at < existing.occurred_at) existing.occurred_at = r.occurred_at;
    }
  }
  if (pairs.size === 0) return;

  const sb = (path, init) =>
    fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
      ...init,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        ...((init && init.headers) || {}),
      },
    });

  for (const pair of pairs.values()) {
    try {
      // Count events for this (proposal, session) BEFORE this batch's earliest
      // timestamp. If zero, this batch contains the very first event from
      // this device on this proposal.
      const countResp = await sb(
        'proposal_events?proposal_id=eq.' + encodeURIComponent(pair.proposal_id) +
        '&session_id=eq.' + encodeURIComponent(pair.session_id) +
        '&occurred_at=lt.' + encodeURIComponent(pair.occurred_at) +
        '&select=id&limit=1',
        { headers: { Prefer: 'count=exact' } }
      );
      // PostgREST returns Content-Range like "0-0/N" for HEAD-style counts.
      // We use limit=1 so the body is at most one row; the count is in
      // the Content-Range header.
      let priorCount = 0;
      const range = countResp.headers.get('content-range') || '';
      const m = range.match(/\/(\d+)$/);
      if (m) priorCount = parseInt(m[1], 10);
      if (priorCount > 0) continue; // not a first view, skip

      // Look up the proposal owner's email + prefs
      const propResp = await sb(
        'proposals?id=eq.' + encodeURIComponent(pair.proposal_id) +
        '&select=id,address,project_address,owner_user_id'
      );
      if (!propResp.ok) continue;
      const propRows = await propResp.json();
      const proposal = propRows && propRows[0];
      if (!proposal || !proposal.owner_user_id) continue;

      const profResp = await sb(
        'profiles?id=eq.' + encodeURIComponent(proposal.owner_user_id) +
        '&select=id,email,display_name,is_active,notification_prefs'
      );
      if (!profResp.ok) continue;
      const profRows = await profResp.json();
      const profile = profRows && profRows[0];
      if (!profile || !profile.is_active || !profile.email) continue;

      const prefs = profile.notification_prefs || {};
      const recipient = profile.email;

      // Pref check
      if (prefs.first_view === false) {
        await logNotification(sb, {
          kind: 'first_view',
          recipient_email: recipient,
          proposal_id: pair.proposal_id,
          session_id: pair.session_id,
          status: 'skipped_pref_off',
        });
        continue;
      }

      // Quiet hours check (Tim's tz, America/Los_Angeles)
      if (prefs.quiet_hours_enabled && inQuietHours(prefs.quiet_hours_start, prefs.quiet_hours_end)) {
        await logNotification(sb, {
          kind: 'first_view',
          recipient_email: recipient,
          proposal_id: pair.proposal_id,
          session_id: pair.session_id,
          status: 'skipped_quiet_hours',
        });
        continue;
      }

      // Rate-limit check: any 'sent' first_view email for this
      // (proposal, recipient) in the last hour blocks a new send.
      const cutoff = new Date(Date.now() - FIRST_VIEW_RATE_LIMIT_MS).toISOString();
      const rateResp = await sb(
        'notification_log' +
        '?proposal_id=eq.' + encodeURIComponent(pair.proposal_id) +
        '&recipient_email=eq.' + encodeURIComponent(recipient) +
        '&kind=eq.first_view' +
        '&status=eq.sent' +
        '&sent_at=gte.' + encodeURIComponent(cutoff) +
        '&select=id&limit=1'
      );
      if (rateResp.ok) {
        const rateRows = await rateResp.json();
        if (rateRows && rateRows.length > 0) {
          await logNotification(sb, {
            kind: 'first_view',
            recipient_email: recipient,
            proposal_id: pair.proposal_id,
            session_id: pair.session_id,
            status: 'skipped_rate_limit',
          });
          continue;
        }
      }

      // Send the email
      const sendResult = await sendFirstViewEmail(env, {
        recipient,
        recipientName: profile.display_name || '',
        proposalId: pair.proposal_id,
        slug: pair.slug,
        address: proposal.address || proposal.project_address || 'Untitled proposal',
        sessionId: pair.session_id,
        viewportW: pair.viewport_w,
        occurredAt: pair.occurred_at,
      });

      await logNotification(sb, {
        kind: 'first_view',
        recipient_email: recipient,
        proposal_id: pair.proposal_id,
        session_id: pair.session_id,
        status: sendResult.ok ? 'sent' : 'failed',
        error_message: sendResult.error || null,
        payload: { viewport_w: pair.viewport_w, slug: pair.slug },
      });
    } catch (err) {
      console.error('[5F.1] pair processing failed:', err);
    }
  }
}

// Returns true if right now (in America/Los_Angeles) falls in [start, end).
// Handles ranges that wrap midnight (start > end).
function inQuietHours(startHour, endHour) {
  if (typeof startHour !== 'number' || typeof endHour !== 'number') return false;
  // Get current hour in LA tz. Intl.DateTimeFormat is the cheapest reliable way.
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: 'America/Los_Angeles',
  });
  const parts = fmt.formatToParts(new Date());
  const hourPart = parts.find((p) => p.type === 'hour');
  const hour = hourPart ? parseInt(hourPart.value, 10) : new Date().getUTCHours();

  if (startHour === endHour) return false;
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  // Wraps midnight: e.g. 22 → 7 means 22,23,0,1,...,6 are quiet.
  return hour >= startHour || hour < endHour;
}

async function sendFirstViewEmail(env, opts) {
  const RESEND_FROM = env.RESEND_FROM || 'Tim McMullen <tim@mcmullen.properties>';
  const engagementUrl = PUBLIC_BASE_URL + '/admin/engagement.html?id=' + encodeURIComponent(opts.proposalId);
  const proposalUrl = opts.slug ? (PUBLIC_BASE_URL + '/p/' + encodeURIComponent(opts.slug)) : null;

  const isMobile = typeof opts.viewportW === 'number' && opts.viewportW > 0 && opts.viewportW < 768;
  const deviceLabel = isMobile ? 'Mobile' : 'Desktop';
  const sessionShort = opts.sessionId.slice(0, 8);

  const whenLocal = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles',
  }).format(new Date(opts.occurredAt));

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [opts.recipient],
        subject: '👁 ' + opts.address + ' just viewed (' + deviceLabel + ', ' + whenLocal + ')',
        html: buildFirstViewHtml({ ...opts, deviceLabel, sessionShort, whenLocal, engagementUrl, proposalUrl }),
        text: buildFirstViewText({ ...opts, deviceLabel, sessionShort, whenLocal, engagementUrl, proposalUrl }),
      }),
    });
    if (r.ok) return { ok: true };
    const errText = await r.text().catch(() => '');
    return { ok: false, error: 'Resend ' + r.status + ': ' + errText.slice(0, 240) };
  } catch (err) {
    return { ok: false, error: 'fetch failed: ' + ((err && err.message) || String(err)) };
  }
}

function buildFirstViewHtml({ address, deviceLabel, sessionShort, whenLocal, engagementUrl, proposalUrl }) {
  const proposalLinkRow = proposalUrl
    ? `<p style="margin:6px 0 0;font-size:12px;color:#999;">or jump to the live proposal at <a href="${escapeHtml(proposalUrl)}" style="color:#9c7440;">${escapeHtml(proposalUrl)}</a></p>`
    : '';
  return '<!DOCTYPE html>\n' +
'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Proposal viewed</title></head>' +
'<body style="margin:0;padding:0;background:#f7f7f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f2125;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f7f4;padding:32px 20px;">' +
'<tr><td align="center">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
'<tr><td style="background:#9c7440;padding:24px 32px;">' +
'<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#dad7c5;font-weight:600;margin-bottom:4px;">Proposal viewed</div>' +
'<h1 style="margin:0;color:#fff;font-size:20px;font-weight:600;letter-spacing:-0.01em;">' + escapeHtml(address) + '</h1>' +
'</td></tr>' +
'<tr><td style="padding:24px 32px 8px;">' +
'<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#353535;">A new device just opened this proposal. They\'re likely on the page right now — a quick call could land while they\'re still scrolling.</p>' +
'<div style="background:#faf8f3;border:1px solid #e7e3d6;border-radius:6px;padding:16px;margin:16px 0 22px;font-family:SF Mono,Menlo,monospace;font-size:13px;color:#58595b;line-height:1.7;">' +
'<div><strong style="color:#353535;">Device:</strong> ' + escapeHtml(deviceLabel) + '</div>' +
'<div><strong style="color:#353535;">Session:</strong> ' + escapeHtml(sessionShort) + '…</div>' +
'<div><strong style="color:#353535;">First seen:</strong> ' + escapeHtml(whenLocal) + ' Pacific</div>' +
'</div>' +
'<div style="text-align:center;margin:24px 0 12px;">' +
'<a href="' + escapeHtml(engagementUrl) + '" style="display:inline-block;background:#9c7440;color:#fff;text-decoration:none;padding:12px 28px;border-radius:4px;font-size:14px;font-weight:600;">View live engagement →</a>' +
'</div>' +
proposalLinkRow +
'<p style="margin:18px 0 0;font-size:11px;line-height:1.5;color:#a0a09c;">' +
'You\'ll get one of these per proposal per hour. Manage notification preferences at <a href="' + escapeHtml(PUBLIC_BASE_URL) + '/admin/notifications.html" style="color:#a0a09c;">' + escapeHtml(PUBLIC_BASE_URL) + '/admin/notifications.html</a>' +
'</p>' +
'</td></tr>' +
'<tr><td style="padding:18px 32px;background:#f7f7f4;border-top:1px solid #e4e4df;text-align:center;">' +
'<p style="margin:0;font-size:11px;color:#70726f;">Paver Portal Proposal Builder · Engagement intelligence</p>' +
'</td></tr>' +
'</table></td></tr></table></body></html>';
}

function buildFirstViewText({ address, deviceLabel, sessionShort, whenLocal, engagementUrl, proposalUrl }) {
  const lines = [
    'A new device just opened this proposal: ' + address,
    '',
    'They\'re likely on the page right now — a quick call could land while they\'re still scrolling.',
    '',
    'Device:      ' + deviceLabel,
    'Session:     ' + sessionShort + '…',
    'First seen:  ' + whenLocal + ' Pacific',
    '',
    'View live engagement: ' + engagementUrl,
  ];
  if (proposalUrl) {
    lines.push('Live proposal:        ' + proposalUrl);
  }
  lines.push('');
  lines.push('You\'ll get one of these per proposal per hour.');
  lines.push('Manage preferences: ' + PUBLIC_BASE_URL + '/admin/notifications.html');
  return lines.join('\n');
}

async function logNotification(sb, log) {
  try {
    await sb('notification_log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(log),
    });
  } catch (err) {
    console.error('[5F.1] notification_log insert failed:', err);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Helpers (unchanged) ──────────────────────────────────────────────
function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function validUuidOrNull(v) {
  return (typeof v === 'string' && UUID_RE.test(v)) ? v : null;
}

function trimString(v, maxLen) {
  if (typeof v !== 'string') return null;
  return v.length > maxLen ? v.slice(0, maxLen) : v;
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return Math.floor(n);
}

function parseTimestamp(v) {
  if (!v) return new Date().toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}
