// ═══════════════════════════════════════════════════════════════════════════
// POST /api/notification-digest  —  Phase 5F.2

//
// Triggered daily by pg_cron at 16:00 UTC (8am PST / 9am PDT). Authenticated
// via the X-Cron-Secret header (must match env.CRON_SECRET).
//
// Aggregates yesterday's proposal_events activity per designer:
//   - For each active designer with daily_digest=true and proposals they own
//   - Find proposal_events from the last 24h on those proposals
//   - Group by proposal: distinct sessions, total events, first/last seen
//   - If at least one proposal has activity → send digest email
//   - If no activity for this designer → skip silently (no "no activity" email)
//
// Logs every send attempt to notification_log with kind='daily_digest'.
//
// Body (optional, mostly for manual testing):
//   { dry_run: true }  — compute the digest but don't send or log
//   { lookback_hours: N }  — override default 24h window for testing
// ═══════════════════════════════════════════════════════════════════════════

const PUBLIC_BASE_URL = 'https://portal-baysidepavers.com';
const DEFAULT_LOOKBACK_HOURS = 24;

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  // ─── Auth: shared secret in header ───────────────────────────────────
  const expectedSecret = env.CRON_SECRET;
  if (!expectedSecret) {
    return json(500, { error: 'CRON_SECRET not configured' });
  }
  const providedSecret = request.headers.get('x-cron-secret') || '';
  if (providedSecret !== expectedSecret) {
    return json(401, { error: 'Invalid cron secret' });
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Server misconfigured — Supabase env missing' });
  }
  if (!env.RESEND_API_KEY) {
    return json(500, { error: 'RESEND_API_KEY not configured' });
  }

  // ─── Body (optional) ─────────────────────────────────────────────────
  let body = {};
  try { body = await request.json(); } catch {}
  const dryRun = !!body.dry_run;
  const lookbackHours = (typeof body.lookback_hours === 'number' && body.lookback_hours > 0)
    ? Math.min(body.lookback_hours, 168) // cap at one week for safety
    : DEFAULT_LOOKBACK_HOURS;

  const sb = (path, init) =>
    fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
      ...init,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        ...((init && init.headers) || {}),
      },
    });

  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  // ─── 1. Active designers with daily_digest=true ─────────────────────
  const profilesResp = await sb(
    'profiles?is_active=eq.true&select=id,email,display_name,role,notification_prefs'
  );
  if (!profilesResp.ok) {
    return json(502, { error: 'Could not load profiles' });
  }
  const profiles = (await profilesResp.json()).filter((p) => {
    const prefs = p.notification_prefs || {};
    return prefs.daily_digest !== false && p.email;
  });

  if (profiles.length === 0) {
    return json(200, { ok: true, processed: 0, sent: 0, skipped: 0 });
  }

  // ─── 2. For each designer, build their digest ───────────────────────
  const results = { processed: 0, sent: 0, skipped: 0, failed: 0, dry_run: dryRun };

  for (const profile of profiles) {
    results.processed++;
    try {
      // Find proposals owned by this designer
      const propResp = await sb(
        'proposals?owner_user_id=eq.' + encodeURIComponent(profile.id) +
        '&select=id,address,project_address'
      );
      if (!propResp.ok) {
        results.failed++;
        continue;
      }
      const proposals = await propResp.json();
      if (proposals.length === 0) {
        results.skipped++;
        continue;
      }

      // Pull all events on those proposals in the lookback window
      const idList = proposals.map((p) => '"' + p.id + '"').join(',');
      const eventsResp = await sb(
        'proposal_events?proposal_id=in.(' + idList + ')' +
        '&occurred_at=gte.' + encodeURIComponent(cutoff) +
        '&select=proposal_id,session_id,event_type,occurred_at,viewport_w' +
        '&order=occurred_at.asc'
      );
      if (!eventsResp.ok) {
        results.failed++;
        continue;
      }
      const events = await eventsResp.json();
      if (events.length === 0) {
        // Silent on no-activity days. No email, no log entry.
        results.skipped++;
        continue;
      }

      // Aggregate per-proposal
      const perProp = new Map();
      for (const p of proposals) {
        perProp.set(p.id, {
          id: p.id,
          address: p.address || p.project_address || 'Untitled proposal',
          totalEvents: 0,
          sessions: new Set(),
          firstSeen: null,
          lastSeen: null,
          mobileEvents: 0,
          desktopEvents: 0,
        });
      }
      for (const e of events) {
        const acc = perProp.get(e.proposal_id);
        if (!acc) continue;
        acc.totalEvents++;
        if (e.session_id) acc.sessions.add(e.session_id);
        if (!acc.firstSeen || e.occurred_at < acc.firstSeen) acc.firstSeen = e.occurred_at;
        if (!acc.lastSeen || e.occurred_at > acc.lastSeen) acc.lastSeen = e.occurred_at;
        if (typeof e.viewport_w === 'number' && e.viewport_w > 0) {
          if (e.viewport_w < 768) acc.mobileEvents++;
          else acc.desktopEvents++;
        }
      }

      // Filter to proposals with activity, sort by lastSeen desc
      const active = Array.from(perProp.values())
        .filter((x) => x.totalEvents > 0)
        .map((x) => ({
          ...x,
          sessions: x.sessions.size,
        }))
        .sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));

      if (active.length === 0) {
        results.skipped++;
        continue;
      }

      // ─── 3. Send the digest ──────────────────────────────────────────
      const totalSessions = active.reduce((s, p) => s + p.sessions, 0);
      const totalEvents = active.reduce((s, p) => s + p.totalEvents, 0);
      const subject = active.length === 1
        ? `Yesterday: ${active[0].sessions} session${active[0].sessions === 1 ? '' : 's'} on ${active[0].address}`
        : `Yesterday: ${totalEvents} events across ${active.length} proposals`;

      if (dryRun) {
        results.sent++;
        continue;
      }

      const RESEND_FROM = env.RESEND_FROM || 'Tim McMullen <tim@mcmullen.properties>';
      const sendResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: RESEND_FROM,
          to: [profile.email],
          subject,
          html: buildDigestHtml({
            recipientName: profile.display_name || '',
            lookbackHours,
            totalSessions,
            totalEvents,
            proposals: active,
          }),
          text: buildDigestText({
            lookbackHours,
            totalSessions,
            totalEvents,
            proposals: active,
          }),
        }),
      });

      const ok = sendResp.ok;
      const errMsg = ok ? null : ('Resend ' + sendResp.status + ': ' + (await sendResp.text()).slice(0, 240));

      // Log once per recipient per digest run
      await sb('notification_log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          kind: 'daily_digest',
          recipient_email: profile.email,
          proposal_id: null,
          status: ok ? 'sent' : 'failed',
          error_message: errMsg,
          payload: {
            proposal_count: active.length,
            total_events: totalEvents,
            total_sessions: totalSessions,
            lookback_hours: lookbackHours,
          },
        }),
      }).catch(() => {});

      if (ok) results.sent++;
      else results.failed++;
    } catch (err) {
      console.error('[5F.2] digest failed for ' + profile.email + ':', err);
      results.failed++;
    }
  }

  return json(200, { ok: true, ...results });
}

// CORS — not needed in production (only pg_cron calls), but kept for ad-hoc curl testing.
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Cron-Secret',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// ─── Email body ──────────────────────────────────────────────────────
function buildDigestHtml({ recipientName, lookbackHours, totalSessions, totalEvents, proposals }) {
  const greeting = recipientName ? 'Hi ' + escapeHtml(recipientName) + ',' : 'Hi,';
  const window = lookbackHours === 24 ? 'yesterday' : ('the last ' + lookbackHours + ' hours');

  const rowsHtml = proposals.map((p) => {
    const deviced = p.mobileEvents + p.desktopEvents;
    const mobilePct = deviced > 0 ? Math.round((p.mobileEvents / deviced) * 100) : 0;
    const splitLabel = deviced > 0
      ? (p.mobileEvents > 0 && p.desktopEvents > 0
          ? mobilePct + '% mobile · ' + (100 - mobilePct) + '% desktop'
          : (p.mobileEvents > 0 ? '100% mobile' : '100% desktop'))
      : '';
    const engagementUrl = PUBLIC_BASE_URL + '/admin/engagement.html?id=' + encodeURIComponent(p.id);
    return (
      '<tr><td style="padding:0 0 14px;">' +
      '<div style="background:#fff;border:1px solid #e7e3d6;border-radius:8px;padding:14px 18px;">' +
      '<div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;">' +
      '<a href="' + escapeHtml(engagementUrl) + '" style="font-weight:600;color:#1f2125;text-decoration:none;font-size:15px;">' + escapeHtml(p.address) + ' →</a>' +
      '<span style="font-family:SF Mono,Menlo,monospace;color:#888;font-size:12px;white-space:nowrap;">' + p.totalEvents + ' event' + (p.totalEvents === 1 ? '' : 's') + '</span>' +
      '</div>' +
      '<div style="font-size:12px;color:#666;margin-top:6px;line-height:1.5;">' +
      p.sessions + ' session' + (p.sessions === 1 ? '' : 's') +
      (splitLabel ? ' · ' + splitLabel : '') +
      '</div>' +
      '</div>' +
      '</td></tr>'
    );
  }).join('');

  return '<!DOCTYPE html>\n' +
'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Daily engagement digest</title></head>' +
'<body style="margin:0;padding:0;background:#f7f7f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f2125;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f7f4;padding:32px 20px;">' +
'<tr><td align="center">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
'<tr><td style="background:#9c7440;padding:24px 32px;">' +
'<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#dad7c5;font-weight:600;margin-bottom:4px;">Daily digest</div>' +
'<h1 style="margin:0;color:#fff;font-size:20px;font-weight:600;letter-spacing:-0.01em;">' + totalEvents + ' event' + (totalEvents === 1 ? '' : 's') + ' across ' + proposals.length + ' proposal' + (proposals.length === 1 ? '' : 's') + '</h1>' +
'</td></tr>' +
'<tr><td style="padding:24px 32px 16px;">' +
'<p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#353535;">' + greeting + '</p>' +
'<p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#58595b;">Here\'s what homeowners did with your proposals ' + escapeHtml(window) + ':</p>' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:8px;">' +
rowsHtml +
'</table>' +
'<p style="margin:18px 0 0;font-size:11px;line-height:1.5;color:#a0a09c;">' +
'Daily digests are silent on days with no activity. Manage preferences at <a href="' + escapeHtml(PUBLIC_BASE_URL) + '/admin/notifications.html" style="color:#a0a09c;">' + escapeHtml(PUBLIC_BASE_URL) + '/admin/notifications.html</a>' +
'</p>' +
'</td></tr>' +
'<tr><td style="padding:18px 32px;background:#f7f7f4;border-top:1px solid #e4e4df;text-align:center;">' +
'<p style="margin:0;font-size:11px;color:#70726f;">Paver Portal Proposal Builder · Engagement intelligence</p>' +
'</td></tr>' +
'</table></td></tr></table></body></html>';
}

function buildDigestText({ lookbackHours, totalSessions, totalEvents, proposals }) {
  const window = lookbackHours === 24 ? 'YESTERDAY' : 'LAST ' + lookbackHours + 'H';
  const lines = [
    window + ' · ' + totalEvents + ' events across ' + proposals.length + ' proposal' + (proposals.length === 1 ? '' : 's'),
    '',
  ];
  for (const p of proposals) {
    lines.push(p.address);
    lines.push('  ' + p.totalEvents + ' events · ' + p.sessions + ' session' + (p.sessions === 1 ? '' : 's'));
    lines.push('  ' + PUBLIC_BASE_URL + '/admin/engagement.html?id=' + p.id);
    lines.push('');
  }
  lines.push('Manage preferences: ' + PUBLIC_BASE_URL + '/admin/notifications.html');
  return lines.join('\n');
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
