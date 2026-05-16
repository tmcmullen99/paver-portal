// ═══════════════════════════════════════════════════════════════════════════
// POST /api/notify-dispatch — Notification dispatch worker (Phase N1)
//
// Pulls 'queued' rows from notification_queue, renders branded email content
// from templates, sends via Resend (with optional CC), updates row status.
//
// Triggered by:
//   1. pg_cron 'notification-dispatch-batch' every 5 min (processes due batch)
//   2. RPC notification_send_now(queue_id) — passes { queue_id } to fire
//      one specific row immediately (War Room "Send now" button)
//
// Auth: X-Cron-Secret header must match env.CRON_SECRET.
//
// Body (optional):
//   { queue_id: "uuid" } — process just this row (used by send_now)
//   { limit: 50 }        — max rows to process this batch (default 100)
//   { dry_run: true }    — render and return previews, don't send
//
// Behavior:
//   - Applies per-user quiet hours (timezone-aware). If recipient is in
//     quiet hours, reschedules the row 1 hour later rather than sending.
//   - Honors notification_queue.cc_emails (auto-populated at queue time
//     with proposal designer for homeowner-recipient rows).
//   - Honors nurture_config.test_mode — when on, ALL recipients (to + cc)
//     are redirected to nurture_config.test_redirect_email and the
//     subject is prefixed with [TEST → real_recipient].
//   - Deep links computed by recipient_type and payload contents.
// ═══════════════════════════════════════════════════════════════════════════

const RESEND_URL = 'https://api.resend.com/emails';
const MAX_BATCH = 100;

// Templates keyed by `${notification_kind}:${recipient_type}`.
// Use {{field}} for payload substitutions. Fields not in payload render
// as empty strings — keep templates defensive (e.g. "your" not "{{name}}'s").
const TEMPLATES = {
  // ── Homeowner-facing ──
  'new_proposal:homeowner': {
    subject: 'Your Bayside Pavers proposal is ready',
    body_md: 'Hi {{client_first_name}},\n\nYour proposal for **{{project_address}}** is ready to view. Take your time exploring the materials, layout, and pricing — and if anything sparks a question, message us directly through the proposal page.\n\nProject total: **${{total_amount}}**',
  },
  'proposal_update:homeowner': {
    subject: 'Your Bayside Pavers proposal was updated',
    body_md: 'Hi {{client_first_name}},\n\nWe just published an update to your proposal for **{{project_address}}**. The changes reflect our recent conversation — take a look and let us know what you think.\n\nUpdated total: **${{total_amount}}**',
  },
  'message_received:homeowner': {
    subject: 'New message from your Bayside Pavers designer',
    body_md: 'Hi {{client_first_name}},\n\nYour designer sent you a message:\n\n> {{message_preview}}\n\nReply directly in your proposal portal to keep the conversation in one place.',
  },
  'sign_event:homeowner': {
    subject: 'Signing confirmed — what happens next',
    body_md: 'Hi {{client_first_name}},\n\nThanks for signing your **{{project_address}}** proposal. Here is what to expect:\n\n- A project coordinator will reach out within 1 business day to schedule a site walkthrough\n- We will share installation timing and a final material confirmation\n- Your signing discount has been applied to the final total\n\nWe are genuinely excited to start. Reach out anytime through the portal.',
  },
  'signing_reminder:homeowner': {
    subject: 'Your signing discount expires in {{hours_left}} hours',
    body_md: 'Hi {{client_first_name}},\n\nQuick reminder: the **{{discount_pct}}% signing discount** on your **{{project_address}}** proposal expires in {{hours_left}} hours. If you have questions before signing, message us directly through the proposal — we are here.',
  },
  'substitution_response:homeowner': {
    subject: 'Designer responded to your material request',
    body_md: 'Hi {{client_first_name}},\n\nYour designer responded to your material change request. Open your proposal to see their notes and decide whether to lock in the swap.',
  },
  'redesign_response:homeowner': {
    subject: 'Designer responded to your redesign request',
    body_md: 'Hi {{client_first_name}},\n\nYour designer reviewed your redesign request and posted a response. Open your proposal to see the updated layout and notes.',
  },
  'referral_converted:homeowner': {
    subject: 'Referral credit earned — your friend just signed!',
    body_md: 'Hi {{client_first_name}},\n\n{{referred_name}} just signed their Bayside Pavers proposal — which means you have earned **${{credit_amount}}** in referral credit on your project. We will apply it automatically at final billing.',
  },

  // ── Designer / Master-facing ──
  'message_received:designer': {
    subject: 'New message from {{client_name}}',
    body_md: '**{{client_name}}** sent you a message about their **{{project_address}}** proposal:\n\n> {{message_preview}}\n\nReply in the War Room to keep the conversation in one thread.',
  },
  'message_received:master': {
    subject: 'New message from {{client_name}} (CC)',
    body_md: '**{{client_name}}** just messaged {{designer_name}} about the **{{project_address}}** proposal:\n\n> {{message_preview}}',
  },
  'sign_event:designer': {
    subject: '🎉 {{client_name}} signed — ${{total_amount}}',
    body_md: '**{{client_name}}** just signed their proposal for **{{project_address}}**.\n\nProject total: **${{total_amount}}**\nSigning discount applied: {{discount_pct}}%\n\nTime to kick off the project workflow.',
  },
  'sign_event:master': {
    subject: '{{client_name}} signed — ${{total_amount}}',
    body_md: '**{{client_name}}** signed the **{{project_address}}** proposal owned by {{designer_name}}.\n\nProject total: **${{total_amount}}**',
  },
  'substitution_received:designer': {
    subject: '{{client_name}} requested a material change',
    body_md: '**{{client_name}}** submitted a material substitution request on their **{{project_address}}** proposal.\n\nHomeowner note:\n> {{homeowner_note}}\n\nReview and respond from the War Room.',
  },
  'redesign_received:designer': {
    subject: '{{client_name}} submitted a redesign request',
    body_md: '**{{client_name}}** submitted a redesign request on **{{project_address}}**.\n\nHomeowner note:\n> {{homeowner_note}}\n\nOpen the War Room to view their markup and respond.',
  },
  'first_view:designer': {
    subject: '👀 {{client_name}} opened {{project_address}}',
    body_md: '**{{client_name}}** just opened their proposal for **{{project_address}}** for the first time. Engagement is starting.',
  },

  // ── Test ──
  'test_notification:master': {
    subject: 'Test notification — dispatch worker live',
    body_md: 'This is a test from the new notification dispatch worker.\n\nPayload contents: {{payload_json}}',
  },
  'test_notification:designer': {
    subject: 'Test notification — dispatch worker live',
    body_md: 'This is a test. Payload: {{payload_json}}',
  },
  'test_notification:homeowner': {
    subject: 'Test notification',
    body_md: 'Test message. Payload: {{payload_json}}',
  },
};

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  // ─── Auth ──────────────────────────────────────────────────────────
  if (!env.CRON_SECRET) return json(500, { error: 'CRON_SECRET not configured' });
  if ((request.headers.get('x-cron-secret') || '') !== env.CRON_SECRET) {
    return json(401, { error: 'Invalid cron secret' });
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase env missing' });
  }
  if (!env.RESEND_API_KEY) {
    return json(500, { error: 'RESEND_API_KEY not configured' });
  }

  // ─── Body parse ────────────────────────────────────────────────────
  let body = {};
  try { body = await request.json(); } catch {}
  const filterQueueId = (typeof body.queue_id === 'string' && body.queue_id.length > 0) ? body.queue_id : null;
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || MAX_BATCH, 1), MAX_BATCH);
  const dryRun = !!body.dry_run;

  const sb = (path, init) =>
    fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
      ...init,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        ...((init && init.headers) || {}),
      },
    });

  // ─── Load nurture_config for test mode + from address ──────────────
  const cfgResp = await sb('nurture_config?id=eq.1&select=*&limit=1');
  if (!cfgResp.ok) return json(502, { error: 'Could not load nurture_config' });
  const cfgRows = await cfgResp.json();
  if (!cfgRows || cfgRows.length === 0) {
    return json(500, { error: 'nurture_config row missing' });
  }
  const cfg = cfgRows[0];

  // ─── Load due rows ─────────────────────────────────────────────────
  let rowsPath = 'notification_queue?status=eq.queued';
  if (filterQueueId) {
    rowsPath += '&id=eq.' + encodeURIComponent(filterQueueId);
  } else {
    rowsPath += '&scheduled_for=lte.' + encodeURIComponent(new Date().toISOString());
  }
  rowsPath += '&order=scheduled_for.asc&limit=' + limit;
  rowsPath += '&select=' + encodeURIComponent('id,recipient_user_id,recipient_email,recipient_type,cc_emails,notification_kind,payload,scheduled_for');

  const rowsResp = await sb(rowsPath);
  if (!rowsResp.ok) {
    const txt = await rowsResp.text();
    return json(502, { error: 'Could not load queue', detail: txt.slice(0, 240) });
  }
  const rows = await rowsResp.json();

  if (rows.length === 0) {
    return json(200, { ok: true, test_mode: cfg.test_mode, processed: 0, sent: 0, skipped: 0, failed: 0, rescheduled: 0 });
  }

  // ─── Load preferences for quiet hours ──────────────────────────────
  const userIds = [...new Set(rows.map(r => r.recipient_user_id).filter(Boolean))];
  let prefsMap = {};
  if (userIds.length > 0) {
    const prefsResp = await sb('notification_preferences?user_id=in.(' + userIds.join(',') + ')&select=user_id,quiet_hours_start,quiet_hours_end,timezone');
    if (prefsResp.ok) {
      const prefsRows = await prefsResp.json();
      prefsMap = Object.fromEntries(prefsRows.map(p => [p.user_id, p]));
    }
  }

  const results = {
    ok: true,
    test_mode: cfg.test_mode,
    dry_run: dryRun,
    processed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    rescheduled: 0,
    items: [],
  };

  for (const row of rows) {
    results.processed++;
    const item = { row_id: row.id, kind: row.notification_kind };

    try {
      // ─── Quiet hours check ───────────────────────────────────────
      const userPrefs = prefsMap[row.recipient_user_id];
      if (userPrefs && !filterQueueId && isInQuietHours(new Date(), userPrefs)) {
        const next = nextSendableTime(new Date(), userPrefs);
        await sb('notification_queue?id=eq.' + encodeURIComponent(row.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ scheduled_for: next.toISOString() }),
        });
        results.rescheduled++;
        item.status = 'rescheduled';
        item.next = next.toISOString();
        results.items.push(item);
        continue;
      }

      // ─── Resolve template ────────────────────────────────────────
      const templateKey = row.notification_kind + ':' + row.recipient_type;
      const template = TEMPLATES[templateKey];
      if (!template) {
        await markFailed(sb, row.id, 'No template for ' + templateKey);
        results.failed++;
        item.status = 'failed';
        item.error = 'no template: ' + templateKey;
        results.items.push(item);
        continue;
      }

      // ─── Render content ──────────────────────────────────────────
      const subject = substitute(template.subject, row.payload);
      const bodyMd = substitute(template.body_md, row.payload);
      const deepLink = computeDeepLink(row, env);
      const html = buildEmailHtml({ bodyMdRendered: bodyMd, deepLink, cfg, testBanner: cfg.test_mode ? row.recipient_email : null });
      const text = buildEmailText({ bodyMdRendered: bodyMd, deepLink, cfg });

      if (dryRun) {
        results.items.push({ ...item, status: 'dry_run', recipient: row.recipient_email, cc: row.cc_emails, subject });
        continue;
      }

      // ─── Send via Resend ─────────────────────────────────────────
      const realRecipient = row.recipient_email;
      const realCcs = Array.isArray(row.cc_emails) ? row.cc_emails.filter(e => e && e !== realRecipient) : [];

      const toAddr = cfg.test_mode ? [cfg.test_redirect_email] : [realRecipient];
      const ccAddrs = cfg.test_mode ? [] : realCcs;
      const finalSubject = cfg.test_mode
        ? '[TEST → ' + realRecipient + (realCcs.length ? ' + cc ' + realCcs.join(', ') : '') + '] ' + subject
        : subject;

      const fromAddr = (cfg.from_name || 'Bayside Pavers') + ' <' + cfg.from_email + '>';
      const resendBody = {
        from: fromAddr,
        to: toAddr,
        subject: finalSubject,
        html,
        text,
      };
      if (ccAddrs.length > 0) resendBody.cc = ccAddrs;

      const resendResp = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(resendBody),
      });

      if (resendResp.ok) {
        const respBody = await resendResp.json().catch(() => ({}));
        await sb('notification_queue?id=eq.' + encodeURIComponent(row.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'sent',
            rendered_subject: subject,
            rendered_body_html: html,
            rendered_body_text: text,
            resend_message_id: respBody.id || null,
            sent_at: new Date().toISOString(),
          }),
        });
        results.sent++;
        item.status = 'sent';
        item.recipient = toAddr[0];
        item.cc = ccAddrs;
        item.message_id = respBody.id || null;
        results.items.push(item);
      } else {
        const errText = await resendResp.text();
        const msg = 'Resend ' + resendResp.status + ': ' + errText.slice(0, 240);
        await markFailed(sb, row.id, msg);
        results.failed++;
        item.status = 'failed';
        item.error = msg;
        results.items.push(item);
      }
    } catch (err) {
      console.error('[notify-dispatch] row', row.id, 'failed:', err);
      const msg = err && err.message ? err.message : String(err);
      await markFailed(sb, row.id, msg).catch(() => {});
      results.failed++;
      item.status = 'failed';
      item.error = msg;
      results.items.push(item);
    }
  }

  return json(200, results);
}

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

// ─── Helpers ─────────────────────────────────────────────────────────

async function markFailed(sb, rowId, msg) {
  return sb('notification_queue?id=eq.' + encodeURIComponent(rowId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'failed',
      error_message: (msg || '').slice(0, 500),
    }),
  });
}

function substitute(template, payload) {
  if (!template) return '';
  const p = payload || {};
  return template
    .replace(/\{\{\s*payload_json\s*\}\}/g, JSON.stringify(p))
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
      const v = p[key];
      return v == null ? '' : String(v);
    });
}

function computeDeepLink(row, env) {
  const base = (env.PUBLIC_BASE_URL || 'https://portal-baysidepavers.com').replace(/\/+$/, '');
  const p = row.payload || {};

  if (row.recipient_type === 'homeowner') {
    if (p.slug) return base + '/p/' + p.slug;
    return base + '/account';
  }
  // Staff (designer/master) → War Room for this client
  if (p.client_id) return base + '/admin/client?id=' + p.client_id;
  return base + '/admin';
}

function parseTimeStr(timeStr) {
  if (!timeStr) return null;
  const m = String(timeStr).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function getMinutesInTz(date, timezone) {
  // Returns current time-of-day in minutes within the given IANA timezone
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/Los_Angeles',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.format(date).split(':');
    const hour = parseInt(parts[0], 10) % 24;
    const minute = parseInt(parts[1], 10);
    return hour * 60 + minute;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

function isInQuietHours(date, prefs) {
  if (!prefs) return false;
  const startMin = parseTimeStr(prefs.quiet_hours_start);
  const endMin = parseTimeStr(prefs.quiet_hours_end);
  if (startMin === null || endMin === null) return false;

  const currMin = getMinutesInTz(date, prefs.timezone);

  // Wraparound (e.g., 21:00 → 08:00)
  if (startMin > endMin) {
    return currMin >= startMin || currMin < endMin;
  } else {
    return currMin >= startMin && currMin < endMin;
  }
}

function nextSendableTime(date, prefs) {
  // Push forward by 1 hour. The cron retries every 5 min anyway, and quiet
  // hours typically end within a few hours. This avoids complex date math
  // across timezones for an edge optimization.
  const next = new Date(date);
  next.setUTCMinutes(next.getUTCMinutes() + 60);
  return next;
}

function buildEmailHtml({ bodyMdRendered, deepLink, cfg, testBanner }) {
  const businessName = escapeHtml(cfg.business_name || 'Bayside Pavers');
  const businessAddress = escapeHtml(cfg.business_address || '');
  const businessPhone = escapeHtml(cfg.business_phone || '');
  const bodyHtml = mdToHtml(bodyMdRendered);

  const testBannerHtml = testBanner
    ? '<tr><td style="background:#fff4d4;border-left:3px solid #c5a050;padding:10px 16px;font-size:12px;color:#7a5a10;">' +
      '<strong>TEST MODE</strong> — would have sent to <code>' + escapeHtml(testBanner) + '</code>' +
      '</td></tr>'
    : '';

  const buttonHtml = deepLink
    ? '<p style="margin:20px 0 0;"><a href="' + escapeAttr(deepLink) + '" style="display:inline-block;background:#5d7e69;color:#fff;padding:11px 24px;border-radius:6px;text-decoration:none;font-weight:500;font-size:14px;">Open</a></p>'
    : '';

  return '<!DOCTYPE html>\n' +
'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
'<body style="margin:0;padding:0;background:#faf8f3;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#353535;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#faf8f3;padding:32px 16px;">' +
'<tr><td align="center">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,0,0.06);">' +
testBannerHtml +
'<tr><td style="background:#5d7e69;padding:22px 32px;text-align:left;">' +
'<div style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#fff;letter-spacing:-0.01em;">' + businessName + '</div>' +
'</td></tr>' +
'<tr><td style="padding:28px 32px 18px;font-size:15px;line-height:1.6;color:#353535;">' +
bodyHtml +
buttonHtml +
'</td></tr>' +
'<tr><td style="padding:18px 32px 26px;border-top:1px solid #ece9dd;background:#faf8f3;">' +
'<p style="margin:0;font-size:11px;color:#888;line-height:1.5;">' +
businessName + (businessAddress ? ' &middot; ' + businessAddress : '') + (businessPhone ? ' &middot; ' + businessPhone : '') +
'</p>' +
'</td></tr>' +
'</table></td></tr></table></body></html>';
}

function buildEmailText({ bodyMdRendered, deepLink, cfg }) {
  let text = bodyMdRendered.trim() + '\n';
  if (deepLink) text += '\nOpen: ' + deepLink + '\n';
  text += '\n---\n' + (cfg.business_name || 'Bayside Pavers');
  if (cfg.business_address) text += ' · ' + cfg.business_address;
  if (cfg.business_phone) text += ' · ' + cfg.business_phone;
  return text;
}

function mdToHtml(md) {
  if (!md) return '';
  const blocks = md.trim().split(/\n\s*\n/);
  return blocks.map(block => {
    const lines = block.split('\n');
    if (lines.every(l => l.trim() === '' || /^\s*[-*]\s+/.test(l))) {
      const items = lines.filter(l => l.trim()).map(l => '<li>' + renderInline(l.replace(/^\s*[-*]\s+/, '')) + '</li>').join('');
      return '<ul style="margin:0 0 12px 20px;padding:0;">' + items + '</ul>';
    }
    if (lines.every(l => /^>\s/.test(l) || l.trim() === '')) {
      const inner = lines.filter(l => l.trim()).map(l => renderInline(l.replace(/^>\s?/, ''))).join('<br>');
      return '<blockquote style="margin:0 0 14px;padding:8px 14px;border-left:3px solid #5d7e69;background:#f7f5ee;color:#555;font-style:italic;">' + inner + '</blockquote>';
    }
    return '<p style="margin:0 0 14px;">' + lines.map(renderInline).join('<br>') + '</p>';
  }).join('\n');
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => '<a href="' + escapeAttr(u) + '" style="color:#5d7e69;">' + t + '</a>');
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s) { return escapeHtml(s); }
