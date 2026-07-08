// ═══════════════════════════════════════════════════════════════════════════
// POST /api/nurture-send  —  Sprint 14C.1
//
// The nurture send worker. Reads 'would_send' rows from nurture_sends,
// renders merge fields + markdown body, wraps in a branded email shell,
// posts to Resend, and updates the row to 'sent' or 'failed'.
//
// Triggered by:
//   1. pg_cron 'nurture-send-batch' at 23:05 UTC daily (5 min after the
//      'nurture-daily-run' enqueue cron).
//   2. (Sprint 14C.2) War Room "Send Now" button — passes { client_id }
//      to bypass the 4pm gate for that client only.
//
// Authenticated via X-Cron-Secret header (must match env.CRON_SECRET) —
// same pattern as /api/notification-digest.
//
// TEST MODE behavior (nurture_config.test_mode = true):
//   - All emails redirected to nurture_config.test_redirect_email
//   - Subject prefixed with [TEST → real recipient: client@email]
//   - Body has a yellow banner at top showing the real recipient
//   - Row still marked 'sent' so we can verify the queue → send loop
//
// Body (optional):
//   { client_id: "uuid" }  — only process that client's would_send rows
//                            (used by War Room Send Now in 14C.2)
//   { dry_run: true }      — render and return previews without sending
// ═══════════════════════════════════════════════════════════════════════════

const RESEND_URL = 'https://api.resend.com/emails';

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  // ─── Auth ───────────────────────────────────────────────────────────
  const expectedSecret = env.CRON_SECRET;
  if (!expectedSecret) return json(500, { error: 'CRON_SECRET not configured' });
  const provided = request.headers.get('x-cron-secret') || '';
  if (provided !== expectedSecret) return json(401, { error: 'Invalid cron secret' });

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase env missing' });
  }
  if (!env.RESEND_API_KEY) {
    return json(500, { error: 'RESEND_API_KEY not configured' });
  }

  // ─── Parse optional body ────────────────────────────────────────────
  let body = {};
  try { body = await request.json(); } catch {}
  const filterClientId = (typeof body.client_id === 'string' && body.client_id.length > 0)
    ? body.client_id : null;
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

  // ─── Load nurture_config ────────────────────────────────────────────
  const cfgResp = await sb('nurture_config?id=eq.1&select=*&limit=1');
  if (!cfgResp.ok) return json(502, { error: 'Could not load nurture_config' });
  const cfgRows = await cfgResp.json();
  if (!cfgRows || cfgRows.length === 0) {
    return json(500, { error: 'nurture_config row missing — run 14C.1 migration' });
  }
  const cfg = cfgRows[0];

  // ─── Load 'would_send' rows joined with template + client ──────────
  // Supabase REST embed: nurture_sends → nurture_templates (template_id)
  //                                     → clients (client_id)
  let rowsPath = 'nurture_sends?status=eq.would_send' +
    '&select=' + encodeURIComponent(
      'id,client_id,template_id,phase_at_send,day_offset_at_send,' +
      'template:nurture_templates(id,subject,body_md,phase,day_offset,project_type_filter,is_active),' +
      'client:clients(id,name,email,address,nurture_opted_out_at,nurture_paused_until)'
    ) +
    '&order=created_at.asc';
  if (filterClientId) {
    rowsPath += '&client_id=eq.' + encodeURIComponent(filterClientId);
  }

  const rowsResp = await sb(rowsPath);
  if (!rowsResp.ok) {
    const txt = await rowsResp.text();
    return json(502, { error: 'Could not load would_send rows', detail: txt.slice(0, 240) });
  }
  const rows = await rowsResp.json();

  if (rows.length === 0) {
    return json(200, {
      ok: true,
      test_mode: cfg.test_mode,
      processed: 0, sent: 0, skipped: 0, failed: 0,
      filter_client_id: filterClientId,
    });
  }

  // ─── Process each row ───────────────────────────────────────────────
  const results = {
    ok: true,
    test_mode: cfg.test_mode,
    dry_run: dryRun,
    processed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    filter_client_id: filterClientId,
    items: [],
  };

  for (const row of rows) {
    results.processed++;
    const itemSummary = { row_id: row.id, client_id: row.client_id };

    try {
      const client = row.client;
      const template = row.template;

      // ─── Defensive guards (re-check at send time) ────────────────
      if (!client) {
        await markRowFailed(sb, row.id, 'client row missing');
        results.failed++;
        itemSummary.status = 'failed'; itemSummary.error = 'client missing';
        results.items.push(itemSummary);
        continue;
      }
      if (!template || !template.is_active) {
        await markRowSkipped(sb, row.id, 'template inactive');
        results.skipped++;
        itemSummary.status = 'skipped'; itemSummary.skip_reason = 'template inactive';
        results.items.push(itemSummary);
        continue;
      }
      if (client.nurture_opted_out_at) {
        await markRowSkipped(sb, row.id, 'client opted out');
        results.skipped++;
        itemSummary.status = 'skipped'; itemSummary.skip_reason = 'opted out';
        results.items.push(itemSummary);
        continue;
      }
      if (client.nurture_paused_until && new Date(client.nurture_paused_until) > new Date()) {
        await markRowSkipped(sb, row.id, 'client paused');
        results.skipped++;
        itemSummary.status = 'skipped'; itemSummary.skip_reason = 'paused';
        results.items.push(itemSummary);
        continue;
      }
      if (!client.email) {
        await markRowFailed(sb, row.id, 'client has no email address');
        results.failed++;
        itemSummary.status = 'failed'; itemSummary.error = 'no email';
        results.items.push(itemSummary);
        continue;
      }

      // ─── Render merge fields ─────────────────────────────────────
      const vars = {
        client_first_name: extractFirstName(client.name) || 'there',
        proposal_address: client.address || '',
        designer_name: cfg.default_designer_name || 'Paver Portal',
      };
      const renderedSubject = substituteMergeFields(template.subject || '', vars);
      const renderedBodyMd = substituteMergeFields(template.body_md || '', vars);

      // ─── Build opt-out URL ───────────────────────────────────────
      const unsubToken = await buildUnsubToken(client.id, cfg.unsub_secret);
      const unsubUrl = trimSlash(env.PUBLIC_BASE_URL || 'https://portal-baysidepavers.com')
        + '/u/' + unsubToken;

      // ─── Build email HTML ────────────────────────────────────────
      const isTestMode = !!cfg.test_mode;
      const realRecipient = client.email;
      const recipient = isTestMode ? cfg.test_redirect_email : realRecipient;
      const finalSubject = isTestMode
        ? '[TEST → ' + realRecipient + '] ' + renderedSubject
        : renderedSubject;

      const html = buildEmailHtml({
        bodyMdRendered: renderedBodyMd,
        unsubUrl,
        cfg,
        testBanner: isTestMode ? realRecipient : null,
      });
      const text = buildEmailText({ bodyMdRendered: renderedBodyMd, unsubUrl, cfg });

      if (dryRun) {
        results.items.push({
          ...itemSummary,
          status: 'dry_run',
          recipient,
          subject: finalSubject,
          html_length: html.length,
        });
        continue;
      }

      // ─── Send via Resend ─────────────────────────────────────────
      const fromAddr = (cfg.from_name || 'Paver Portal') + ' <' + cfg.from_email + '>';
      const resendResp = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddr,
          to: [recipient],
          subject: finalSubject,
          html,
          text,
          headers: {
            'List-Unsubscribe': '<' + unsubUrl + '>',
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }),
      });

      if (resendResp.ok) {
        const respBody = await resendResp.json().catch(() => ({}));
        const messageId = respBody.id || null;
        await markRowSent(sb, row.id, {
          rendered_subject: renderedSubject,
          rendered_body: renderedBodyMd,
          resend_message_id: messageId,
        });
        results.sent++;
        itemSummary.status = 'sent';
        itemSummary.recipient = recipient;
        itemSummary.message_id = messageId;
        results.items.push(itemSummary);
      } else {
        const errText = await resendResp.text();
        const errMsg = 'Resend ' + resendResp.status + ': ' + errText.slice(0, 240);
        await markRowFailed(sb, row.id, errMsg);
        results.failed++;
        itemSummary.status = 'failed';
        itemSummary.error = errMsg;
        results.items.push(itemSummary);
      }
    } catch (err) {
      console.error('[nurture-send] row', row.id, 'failed:', err);
      const msg = (err && err.message) ? err.message : String(err);
      await markRowFailed(sb, row.id, msg).catch(() => {});
      results.failed++;
      itemSummary.status = 'failed';
      itemSummary.error = msg;
      results.items.push(itemSummary);
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

// ─── Status updates ──────────────────────────────────────────────────
async function markRowSent(sb, rowId, { rendered_subject, rendered_body, resend_message_id }) {
  return sb('nurture_sends?id=eq.' + encodeURIComponent(rowId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'sent',
      rendered_subject,
      rendered_body,
      resend_message_id,
      sent_at: new Date().toISOString(),
    }),
  });
}

async function markRowSkipped(sb, rowId, reason) {
  return sb('nurture_sends?id=eq.' + encodeURIComponent(rowId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'skipped',
      skip_reason: reason,
    }),
  });
}

async function markRowFailed(sb, rowId, errorMsg) {
  return sb('nurture_sends?id=eq.' + encodeURIComponent(rowId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'failed',
      error_message: (errorMsg || '').slice(0, 500),
    }),
  });
}

// ─── Email shell ─────────────────────────────────────────────────────
function buildEmailHtml({ bodyMdRendered, unsubUrl, cfg, testBanner }) {
  const businessName = escapeHtml(cfg.business_name || 'Paver Portal');
  const businessAddress = escapeHtml(cfg.business_address || '');
  const businessPhone = escapeHtml(cfg.business_phone || '');
  const unsubSafe = escapeHtml(unsubUrl);
  const bodyHtml = mdToHtml(bodyMdRendered);

  const testBannerHtml = testBanner
    ? '<tr><td style="background:#fff4d4;border-left:3px solid #c5a050;padding:10px 16px;font-size:12px;color:#7a5a10;">' +
      '<strong>TEST MODE</strong> — would have sent to <code style="font-family:SF Mono,Menlo,monospace;">' + escapeHtml(testBanner) + '</code>' +
      '</td></tr>'
    : '';

  return '<!DOCTYPE html>\n' +
'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>' + businessName + '</title></head>' +
'<body style="margin:0;padding:0;background:#faf8f3;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#353535;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#faf8f3;padding:32px 16px;">' +
'<tr><td align="center">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,0,0.06);">' +
testBannerHtml +
'<tr><td style="background:#9c7440;padding:22px 32px;text-align:left;">' +
'<div style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#fff;letter-spacing:-0.01em;">' + businessName + '</div>' +
'</td></tr>' +
'<tr><td style="padding:28px 32px 12px;font-size:15px;line-height:1.6;color:#353535;">' +
bodyHtml +
'</td></tr>' +
'<tr><td style="padding:18px 32px 26px;border-top:1px solid #ece9dd;background:#faf8f3;">' +
'<p style="margin:0 0 8px;font-size:12px;color:#666;line-height:1.5;">' +
businessName + (businessAddress ? ' &middot; ' + businessAddress : '') + (businessPhone ? ' &middot; ' + businessPhone : '') +
'</p>' +
'<p style="margin:0;font-size:11px;color:#888;line-height:1.5;">' +
'You\'re getting this because you\'re working with us on a project. ' +
'<a href="' + unsubSafe + '" style="color:#666;text-decoration:underline;">Unsubscribe</a>' +
'</p>' +
'</td></tr>' +
'</table></td></tr></table></body></html>';
}

function buildEmailText({ bodyMdRendered, unsubUrl, cfg }) {
  // Keep text version as-is; markdown is already plain enough to read.
  const lines = [];
  lines.push(bodyMdRendered.trim());
  lines.push('');
  lines.push('---');
  lines.push((cfg.business_name || 'Paver Portal')
    + (cfg.business_address ? ' · ' + cfg.business_address : '')
    + (cfg.business_phone ? ' · ' + cfg.business_phone : ''));
  lines.push('Unsubscribe: ' + unsubUrl);
  return lines.join('\n');
}

// ─── Tiny markdown renderer ──────────────────────────────────────────
// Handles paragraphs, bullet lists (- or *), numbered lists (1.),
// inline **bold**, *italic*, [link](url), and \n→<br> within paragraphs.
// All output is HTML-escaped before inline replacements.
function mdToHtml(md) {
  if (!md) return '';
  const blocks = md.trim().split(/\n\s*\n/);
  return blocks.map(block => {
    const lines = block.split('\n');
    // Bullet list
    if (lines.every(l => l.trim() === '' || /^\s*[-*]\s+/.test(l))) {
      const items = lines
        .filter(l => l.trim() !== '')
        .map(l => '<li>' + renderInline(l.replace(/^\s*[-*]\s+/, '')) + '</li>')
        .join('');
      return '<ul style="margin:0 0 12px 20px;padding:0;">' + items + '</ul>';
    }
    // Numbered list
    if (lines.every(l => l.trim() === '' || /^\s*\d+\.\s+/.test(l))) {
      const items = lines
        .filter(l => l.trim() !== '')
        .map(l => '<li>' + renderInline(l.replace(/^\s*\d+\.\s+/, '')) + '</li>')
        .join('');
      return '<ol style="margin:0 0 12px 20px;padding:0;">' + items + '</ol>';
    }
    // Default paragraph
    const inner = lines.map(l => renderInline(l)).join('<br>');
    return '<p style="margin:0 0 14px;">' + inner + '</p>';
  }).join('\n');
}

function renderInline(text) {
  // Escape FIRST, then add inline tags. Markdown delimiters survive escaping.
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) =>
      '<a href="' + escapeAttr(u) + '" style="color:#9c7440;">' + t + '</a>');
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

// ─── Helpers ─────────────────────────────────────────────────────────
function extractFirstName(name) {
  if (!name) return '';
  const trimmed = String(name).trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}

function substituteMergeFields(text, vars) {
  if (!text) return '';
  return text
    .replace(/\{\{\s*client_first_name\s*\}\}/g, vars.client_first_name || '')
    .replace(/\{\{\s*proposal_address\s*\}\}/g, vars.proposal_address || '')
    .replace(/\{\{\s*designer_name\s*\}\}/g, vars.designer_name || '');
}

function trimSlash(url) {
  return (url || '').replace(/\/+$/, '');
}

// ─── HMAC-signed unsubscribe token ───────────────────────────────────
// Token format: base64url(client_id + '.' + hex_hmac_sha256(secret, client_id))
async function buildUnsubToken(clientId, secret) {
  const sig = await hmacSha256Hex(secret, clientId);
  return base64UrlEncode(clientId + '.' + sig);
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64UrlEncode(s) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
