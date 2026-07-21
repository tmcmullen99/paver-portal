/**
 * BPB Sprint 15 + 22 — /api/admin-daily-digest
 *
 * Sends the morning digest email to tim@mcmullen.properties. Renders the
 * same data as /admin/today.html plus (Sprint 22) nurture awareness:
 *   - Tonight's nurture preview (what'll fire at 23:00 UTC)
 *   - Last 24h nurture activity
 *
 * Auth: requires header `x-bayside-cron-secret` matching env PAVER PORTAL_CRON_SECRET.
 *
 * Query params:
 *   ?dry_run=true  — return the rendered HTML without sending
 *   ?to=<email>    — override recipient (defaults to tim@mcmullen.properties)
 *
 * Env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY, RESEND_FROM_EMAIL
 *   PAVER PORTAL_CRON_SECRET
 *   PORTAL_BASE_URL
 *   DIGEST_RECIPIENT  — optional override (default tim@mcmullen.properties)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-bayside-cron-secret',
  'Cache-Control': 'no-store',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  const provided = request.headers.get('x-bayside-cron-secret');
  if (!env.PAVER PORTAL_CRON_SECRET || provided !== env.PAVER PORTAL_CRON_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'SUPABASE config missing' }, 500);
  }
  if (!env.RESEND_API_KEY) {
    return jsonResponse({ error: 'RESEND_API_KEY missing' }, 500);
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dry_run') === 'true';
  const toOverride = url.searchParams.get('to');
  const recipient = toOverride || env.DIGEST_RECIPIENT || 'tim@mcmullen.properties';
  const baseUrl = (env.PORTAL_BASE_URL || 'https://portal-baysidepavers.com').replace(/\/$/, '');
  const fromEmail = env.RESEND_FROM_EMAIL || 'Paver Portal Portal <tim@mcmullen.properties>';

  const supabaseHeaders = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  // ── 1. Fetch today's state + nurture context in parallel
  const [stateResp, nurtureResp] = await Promise.all([
    fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_today_state`, {
      method: 'POST', headers: supabaseHeaders, body: '{}',
    }),
    fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_nurture_digest_context`, {
      method: 'POST', headers: supabaseHeaders, body: '{}',
    }),
  ]);

  if (!stateResp.ok) {
    return jsonResponse({ error: 'admin_today_state RPC failed', detail: await stateResp.text() }, 500);
  }

  const state = await stateResp.json();
  // Nurture context is additive — fail soft if it errors
  let nurture = null;
  if (nurtureResp.ok) {
    try { nurture = await nurtureResp.json(); } catch { nurture = null; }
  }

  const rendered = renderDigest(state, nurture, baseUrl);

  if (dryRun) {
    return new Response(rendered.html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
    });
  }

  // ── 2. Send via Resend
  try {
    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    fromEmail,
        to:      [recipient],
        subject: rendered.subject,
        html:    rendered.html,
        text:    rendered.text,
      }),
    });

    const resendData = await resendResp.json();
    if (!resendResp.ok) {
      return jsonResponse({
        error: 'Resend send failed',
        detail: resendData.message || `HTTP ${resendResp.status}`,
      }, 500);
    }

    return jsonResponse({
      success:           true,
      recipient,
      subject:           rendered.subject,
      resend_id:         resendData.id,
      needs_reply:       state.needs_reply ? state.needs_reply.length : 0,
      hot_proposals:     state.top_hot_proposals ? state.top_hot_proposals.length : 0,
      nurture_preview:   nurture?.tonight_preview?.length || 0,
      nurture_recent:    nurture?.recent_sends?.length || 0,
    });
  } catch (e) {
    return jsonResponse({ error: 'Internal error', detail: String(e) }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Digest rendering
// ─────────────────────────────────────────────────────────────────────

function renderDigest(state, nurture, baseUrl) {
  const today      = state.today      || {};
  const yesterday  = state.yesterday  || {};
  const thisWeek   = state.this_week  || {};
  const pipeline   = state.pipeline   || {};
  const needsReply = state.needs_reply || [];
  const hotToday   = state.top_hot_proposals || [];

  const nurturePreview = nurture?.tonight_preview || [];
  const nurtureRecent  = nurture?.recent_sends   || [];
  const nurtureTest    = !!nurture?.test_mode;
  const nurtureRedirect = nurture?.test_redirect || null;
  const nurtureRunAt   = nurture?.next_run_at    || null;

  const dayStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

  const subjectAttention = needsReply.length > 0
    ? `${needsReply.length} client${needsReply.length === 1 ? '' : 's'} waiting on you`
    : (today.views > 0
      ? `${today.views} view${today.views === 1 ? '' : 's'} so far today`
      : (nurturePreview.length > 0
        ? `${nurturePreview.length} nurture send${nurturePreview.length === 1 ? '' : 's'} tonight`
        : 'Quiet morning'));

  const subject = `Paver Portal Portal Morning · ${subjectAttention} · ${dayStr}`;

  const html = renderHtml({
    dayStr, today, yesterday, thisWeek, pipeline,
    needsReply, hotToday, baseUrl,
    nurturePreview, nurtureRecent, nurtureTest, nurtureRedirect, nurtureRunAt,
  });
  const text = renderText({
    dayStr, today, yesterday, thisWeek, pipeline,
    needsReply, hotToday, baseUrl,
    nurturePreview, nurtureRecent, nurtureTest, nurtureRedirect,
  });

  return { subject, html, text };
}

function fmtMoney(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (v >= 1000000) return '$' + (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1000)    return '$' + (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function timeAgo(iso) {
  if (!iso) return '—';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60)    return seconds + 's ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)    return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24)      return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days + 'd ago';
}

function fmtPhaseLabel(phase) {
  if (!phase) return '—';
  return String(phase).replace(/_/g, ' ');
}

function truncate(s, max) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function deltaArrow(today, yesterday) {
  if (yesterday === 0 && today === 0) return '';
  const diff = today - yesterday;
  if (diff === 0) return ' <span style="color:#999;">·</span> <span style="color:#999;">flat</span>';
  const sign = diff > 0 ? '+' : '';
  const color = diff > 0 ? '#167d3a' : '#c0392b';
  const arrow = diff > 0 ? '↑' : '↓';
  return ` <span style="color:${color}; font-weight:500;">${arrow} ${sign}${diff}</span>`;
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml({ dayStr, today, yesterday, thisWeek, pipeline, needsReply, hotToday, baseUrl, nurturePreview, nurtureRecent, nurtureTest, nurtureRedirect, nurtureRunAt }) {
  const kpi = (label, n, yest) => `
    <td width="25%" valign="top" style="padding:14px 12px; background:#fff; border:1px solid #e8e8e3; border-radius:8px;">
      <div style="font-size:10px; letter-spacing:0.1em; text-transform:uppercase; color:#999; font-weight:600; margin-bottom:6px;">${esc(label)}</div>
      <div style="font-size:22px; font-weight:700; color:${n === 0 ? '#aaa' : '#33281c'}; line-height:1;">${n}</div>
      <div style="font-size:11px; color:#999; margin-top:4px; font-family:Menlo,Monaco,monospace;">vs ${yest} yesterday${deltaArrow(n, yest)}</div>
    </td>
  `;
  const kpiSpacer = `<td width="10" style="font-size:0; line-height:0;">&nbsp;</td>`;

  const kpis = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:18px;">
      <tr>
        ${kpi('Views',           today.views || 0,             yesterday.views || 0)}
        ${kpiSpacer}
        ${kpi('Lock-ins',        today.new_lockins || 0,       yesterday.new_lockins || 0)}
        ${kpiSpacer}
        ${kpi('Inbound msgs',    today.new_inbound_msgs || 0,  yesterday.new_inbound_msgs || 0)}
        ${kpiSpacer}
        ${kpi('Design req',      (today.new_subs||0)+(today.new_redesigns||0), (yesterday.new_subs||0)+(yesterday.new_redesigns||0))}
      </tr>
    </table>
  `;

  const pipeStrip = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#33281c; color:#fff; border-radius:8px; margin-bottom:22px;">
      <tr>
        <td valign="top" style="padding:16px 18px;">
          <div style="font-size:10px; letter-spacing:0.12em; text-transform:uppercase; color:#aab2c1; font-weight:600; margin-bottom:5px;">Active pipeline</div>
          <div style="font-size:20px; font-weight:600; line-height:1;">${fmtMoney(pipeline.active_value)}</div>
          <div style="font-size:11px; color:#aab2c1; margin-top:3px;">${pipeline.active_proposals || 0} proposal${pipeline.active_proposals === 1 ? '' : 's'}</div>
        </td>
        <td valign="top" style="padding:16px 18px; border-left:1px solid #2c344a;">
          <div style="font-size:10px; letter-spacing:0.12em; text-transform:uppercase; color:#aab2c1; font-weight:600; margin-bottom:5px;">This week locked</div>
          <div style="font-size:20px; font-weight:600; line-height:1;">${fmtMoney(thisWeek.locked_value)}</div>
          <div style="font-size:11px; color:#aab2c1; margin-top:3px;">${thisWeek.lockins || 0} lock-in${thisWeek.lockins === 1 ? '' : 's'}</div>
        </td>
        <td valign="top" style="padding:16px 18px; border-left:1px solid #2c344a;">
          <div style="font-size:10px; letter-spacing:0.12em; text-transform:uppercase; color:#aab2c1; font-weight:600; margin-bottom:5px;">Open lock-ins</div>
          <div style="font-size:20px; font-weight:600; line-height:1;">${pipeline.open_lockins || 0}</div>
          <div style="font-size:11px; color:#aab2c1; margin-top:3px;">Need contract</div>
        </td>
      </tr>
    </table>
  `;

  const needsReplyHtml = needsReply.length === 0
    ? `<p style="color:#999; font-size:14px; font-style:italic; margin:0 0 22px;">All caught up — no inbound waiting.</p>`
    : `
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:22px;">
        ${needsReply.map((it) => `
          <tr><td style="padding-bottom:8px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fff; border:1px solid #e8e8e3; border-radius:8px;">
              <tr><td style="padding:11px 14px;">
                <div style="font-size:14px; color:#33281c; margin-bottom:3px;">
                  <strong>${esc(it.client_name || 'Unknown')}</strong>
                  <span style="color:#999; font-size:12px;">  ·  ${esc(it.client_email || '')}  ·  ${esc(timeAgo(it.last_inbound_at))}</span>
                </div>
                ${it.last_inbound_body ? `<div style="padding:7px 11px; background:#faf8f3; border-left:2px solid #9c7440; border-radius:3px; font-size:13px; color:#353535; margin:4px 0 6px;">${esc(truncate(it.last_inbound_body, 180))}</div>` : ''}
                <a href="${esc(baseUrl)}/admin/conversations.html?client_id=${esc(it.client_id)}" style="display:inline-block; color:#fff; background:#9c7440; padding:6px 12px; border-radius:5px; font-size:12px; font-weight:600; text-decoration:none;">Open thread →</a>
              </td></tr>
            </table>
          </td></tr>
        `).join('')}
      </table>
    `;

  const hotHtml = hotToday.length === 0
    ? `<p style="color:#999; font-size:14px; font-style:italic; margin:0 0 22px;">No proposal activity in the last 24h.</p>`
    : `
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:22px;">
        ${hotToday.map((it) => `
          <tr><td style="padding-bottom:8px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fff; border:1px solid #e8e8e3; border-radius:8px;">
              <tr><td style="padding:11px 14px;">
                <div style="font-size:14px; color:#33281c; margin-bottom:3px;">
                  <strong>${esc(it.project_address || '—')}</strong>
                  ${it.bid_total_amount != null ? `<span style="color:#9c7440; font-weight:600;">  ·  ${fmtMoney(it.bid_total_amount)}</span>` : ''}
                </div>
                <div style="font-size:12px; color:#777; margin-bottom:6px;">
                  <strong style="color:#353535;">${it.views_today}</strong> views
                  · <strong style="color:#353535;">${it.sessions_today}</strong> session${it.sessions_today === 1 ? '' : 's'}
                  · Last view ${timeAgo(it.last_view)}
                </div>
                ${it.slug ? `<a href="${esc(baseUrl)}/p/${esc(it.slug)}" style="display:inline-block; color:#fff; background:#9c7440; padding:6px 12px; border-radius:5px; font-size:12px; font-weight:600; text-decoration:none;">View proposal →</a>` : ''}
              </td></tr>
            </table>
          </td></tr>
        `).join('')}
      </table>
    `;

  // ── Sprint 22: Tonight's nurture preview
  const previewRunStr = nurtureRunAt
    ? new Date(nurtureRunAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    : 'tonight';
  const testBanner = nurtureTest
    ? `<span style="display:inline-block; background:#fef3c7; color:#92400e; padding:1px 7px; border-radius:999px; font-size:10px; letter-spacing:0.06em; text-transform:uppercase; font-weight:600; margin-left:6px;">test mode → ${esc(nurtureRedirect || 'redirect')}</span>`
    : '';
  const nurturePreviewHtml = nurturePreview.length === 0
    ? `<p style="color:#999; font-size:14px; font-style:italic; margin:0 0 22px;">Nothing queued for ${esc(previewRunStr)}.</p>`
    : `
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:22px;">
        ${nurturePreview.map((p) => `
          <tr><td style="padding-bottom:8px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fff; border:1px solid #e8e8e3; border-radius:8px;">
              <tr><td style="padding:11px 14px;">
                <div style="font-size:14px; color:#33281c; margin-bottom:3px;">
                  <strong>${esc(p.client_name || 'Unknown')}</strong>
                  <span style="color:#999; font-size:12px;">  ·  ${esc(p.client_email || '')}</span>
                </div>
                <div style="font-size:12px; color:#777; margin-bottom:6px;">
                  ${esc(p.project_address || '—')}
                  · <span style="display:inline-block; padding:1px 7px; border-radius:999px; font-size:10px; letter-spacing:0.05em; text-transform:uppercase; font-weight:600; background:#eef3ef; color:#9c7440;">${esc(fmtPhaseLabel(p.phase))}</span>
                  · day ${p.day_offset}
                </div>
                <div style="padding:7px 11px; background:#faf8f3; border-left:2px solid #c89346; border-radius:3px; font-size:13px; color:#353535; margin:4px 0 6px;">
                  <strong>Subject:</strong> ${esc(p.template_subject || '')}
                </div>
                <a href="${esc(baseUrl)}/admin/nurture-clients" style="display:inline-block; color:#9c7440; font-size:12px; font-weight:600; text-decoration:underline;">Open in nurture pipeline →</a>
              </td></tr>
            </table>
          </td></tr>
        `).join('')}
      </table>
    `;

  // ── Sprint 22: Recent nurture activity (last 24h) — only show section if any
  const nurtureRecentHtml = nurtureRecent.length === 0
    ? ''
    : `
      <h2 style="margin:0 0 10px; font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#353535; font-weight:700; padding-bottom:6px; border-bottom:1px solid #e8e8e3;">
        Sent in last 24h <span style="display:inline-block; background:#9c7440; color:#fff; padding:1px 7px; border-radius:999px; font-size:11px; margin-left:4px;">${nurtureRecent.length}</span>
      </h2>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:22px;">
        ${nurtureRecent.map((r) => `
          <tr><td style="padding-bottom:8px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fff; border:1px solid #e8e8e3; border-radius:8px;">
              <tr><td style="padding:11px 14px;">
                <div style="font-size:14px; color:#33281c; margin-bottom:3px;">
                  <strong>${esc(r.client_name || 'Unknown')}</strong>
                  <span style="color:#999; font-size:12px;">  ·  ${esc(timeAgo(r.sent_at))}${r.recipient_override_email ? '  ·  redirected to ' + esc(r.recipient_override_email) : ''}</span>
                </div>
                <div style="font-size:12px; color:#777; margin-bottom:4px;">
                  ${esc(r.project_address || '—')}
                  · <span style="display:inline-block; padding:1px 7px; border-radius:999px; font-size:10px; letter-spacing:0.05em; text-transform:uppercase; font-weight:600; background:#eef3ef; color:#9c7440;">${esc(fmtPhaseLabel(r.phase))}</span>
                  · day ${r.day_offset}
                </div>
                <div style="font-size:13px; color:#353535;">${esc(r.rendered_subject || '')}</div>
              </td></tr>
            </table>
          </td></tr>
        `).join('')}
      </table>
    `;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0; padding:0; background:#fafafa; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fafafa;">
    <tr><td align="center" style="padding:24px 16px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="620" style="max-width:620px; background:#fff; border:1px solid #e8e8e3; border-radius:10px;">
        <tr><td style="padding:24px 28px;">

          <div style="font-size:10px; letter-spacing:0.14em; text-transform:uppercase; color:#9c7440; font-weight:700; margin-bottom:5px;">PAVER PORTAL PORTAL · MORNING DIGEST</div>
          <h1 style="margin:0 0 4px; font-size:24px; font-weight:600; color:#33281c; letter-spacing:-0.005em;">${esc(dayStr)}</h1>
          <p style="margin:0 0 20px; font-size:14px; color:#777;">${needsReply.length > 0 ? `${needsReply.length} client${needsReply.length === 1 ? '' : 's'} waiting on you.` : 'You are caught up.'}</p>

          ${kpis}
          ${pipeStrip}

          <h2 style="margin:0 0 10px; font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#353535; font-weight:700; padding-bottom:6px; border-bottom:1px solid #e8e8e3;">
            Awaiting your reply ${needsReply.length > 0 ? `<span style="display:inline-block; background:#c0392b; color:#fff; padding:1px 7px; border-radius:999px; font-size:11px; margin-left:4px;">${needsReply.length}</span>` : ''}
          </h2>
          ${needsReplyHtml}

          <h2 style="margin:0 0 10px; font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#353535; font-weight:700; padding-bottom:6px; border-bottom:1px solid #e8e8e3;">
            Active in the last 24 hours ${hotToday.length > 0 ? `<span style="display:inline-block; background:#9c7440; color:#fff; padding:1px 7px; border-radius:999px; font-size:11px; margin-left:4px;">${hotToday.length}</span>` : ''}
          </h2>
          ${hotHtml}

          <h2 style="margin:0 0 10px; font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#353535; font-weight:700; padding-bottom:6px; border-bottom:1px solid #e8e8e3;">
            Nurture queued for ${esc(previewRunStr)} ${nurturePreview.length > 0 ? `<span style="display:inline-block; background:#c89346; color:#fff; padding:1px 7px; border-radius:999px; font-size:11px; margin-left:4px;">${nurturePreview.length}</span>` : ''}${testBanner}
          </h2>
          ${nurturePreviewHtml}

          ${nurtureRecentHtml}

          <p style="margin:18px 0 0; font-size:12px; color:#999;">
            <a href="${esc(baseUrl)}/admin/today.html" style="color:#9c7440; text-decoration:underline;">Open Today dashboard →</a>
            · <a href="${esc(baseUrl)}/admin/nurture-clients" style="color:#9c7440; text-decoration:underline;">Nurture pipeline →</a>
            · <a href="${esc(baseUrl)}/admin/nurture-queue.html" style="color:#9c7440; text-decoration:underline;">7-day queue →</a>
            · <a href="${esc(baseUrl)}/admin/notes-search.html" style="color:#9c7440; text-decoration:underline;">Notes search →</a>
            · <a href="${esc(baseUrl)}/admin/jot.html" style="color:#9c7440; text-decoration:underline;">Jot a note →</a>
          </p>

        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderText({ dayStr, today, yesterday, thisWeek, pipeline, needsReply, hotToday, baseUrl, nurturePreview, nurtureRecent, nurtureTest, nurtureRedirect }) {
  const lines = [];
  lines.push(`Paver Portal Portal Morning Digest · ${dayStr}`);
  lines.push('');
  if (needsReply.length > 0) lines.push(`${needsReply.length} client${needsReply.length === 1 ? '' : 's'} waiting on you.`);
  lines.push('');
  lines.push(`Today: ${today.views || 0} views · ${today.new_lockins || 0} lock-ins · ${today.new_inbound_msgs || 0} msgs · ${(today.new_subs||0)+(today.new_redesigns||0)} design req`);
  lines.push(`Pipeline: ${fmtMoney(pipeline.active_value)} active across ${pipeline.active_proposals || 0} proposals`);
  lines.push(`This week: ${fmtMoney(thisWeek.locked_value)} locked across ${thisWeek.lockins || 0} lock-ins`);
  lines.push('');
  if (needsReply.length > 0) {
    lines.push('Awaiting your reply:');
    for (const it of needsReply) {
      lines.push(`  • ${it.client_name} · ${timeAgo(it.last_inbound_at)} · ${baseUrl}/admin/conversations.html?client_id=${it.client_id}`);
    }
    lines.push('');
  }
  if (hotToday.length > 0) {
    lines.push('Hot proposals (last 24h):');
    for (const it of hotToday) {
      lines.push(`  • ${it.project_address} · ${it.views_today} views · ${baseUrl}/p/${it.slug || ''}`);
    }
    lines.push('');
  }
  if (nurturePreview.length > 0) {
    const testNote = nurtureTest ? ` (test mode → ${nurtureRedirect})` : '';
    lines.push(`Nurture queued for tonight${testNote}:`);
    for (const p of nurturePreview) {
      lines.push(`  • ${p.client_name} · ${fmtPhaseLabel(p.phase)} day ${p.day_offset} · "${p.template_subject}"`);
    }
    lines.push('');
  }
  if (nurtureRecent.length > 0) {
    lines.push('Nurture sent in last 24h:');
    for (const r of nurtureRecent) {
      lines.push(`  • ${r.client_name} · ${fmtPhaseLabel(r.phase)} day ${r.day_offset} · "${r.rendered_subject}" · ${timeAgo(r.sent_at)}`);
    }
    lines.push('');
  }
  lines.push(`Full dashboard: ${baseUrl}/admin/today.html`);
  return lines.join('\n');
}
