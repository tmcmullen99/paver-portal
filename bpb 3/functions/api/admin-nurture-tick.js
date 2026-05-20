/**
 * BPB Sprint 12C — /api/admin-nurture-tick
 *
 * Scheduled task that scans for clients due a nurture email and sends them.
 *
 * Auth: requires header `x-bayside-cron-secret` matching env BAYSIDE_CRON_SECRET.
 * Triggered by GitHub Actions daily (see .github/workflows/scheduled-tasks.yml).
 *
 * Sequence (per client+proposal):
 *   Step 1 — 24h after canonical publish    "Quick note on your {address} design"
 *   Step 2 —  3d after step 1 was sent      "Anything I can help clarify on {address}?"
 *   Step 3 —  7d after step 2 was sent      "Closing the loop on {address}"
 *
 * Query param `?dry_run=true` returns what WOULD be sent without sending.
 *
 * Env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — database access
 *   RESEND_API_KEY, RESEND_FROM_EMAIL         — email send
 *   BAYSIDE_CRON_SECRET                       — auth shared secret
 *   PORTAL_BASE_URL                           — optional, defaults to portal-baysidepavers.com
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
  // ── Auth
  const provided = request.headers.get('x-bayside-cron-secret');
  if (!env.BAYSIDE_CRON_SECRET || provided !== env.BAYSIDE_CRON_SECRET) {
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
  const baseUrl = (env.PORTAL_BASE_URL || 'https://portal-baysidepavers.com').replace(/\/$/, '');
  const fromEmail = env.RESEND_FROM_EMAIL || 'Bayside Pavers <tim@mcmullen.properties>';

  // ── 1. Fetch candidates via RPC
  const rpcResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/rpc/admin_nurture_candidates`,
    {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }
  );

  if (!rpcResp.ok) {
    const errText = await rpcResp.text();
    return jsonResponse({ error: 'RPC failed', detail: errText }, 500);
  }

  const candidates = await rpcResp.json();

  if (candidates.length === 0) {
    return jsonResponse({
      success: true,
      dry_run: dryRun,
      candidates: 0,
      sent: 0,
      failed: 0,
      results: [],
      message: 'No nurture emails due right now.',
    });
  }

  // ── 2. For each candidate, render + send + log
  const results = [];
  for (const c of candidates) {
    const tmpl = renderTemplate(c.next_step, {
      firstName:        firstName(c.client_name),
      projectAddress:   c.project_address,
      bidTotalAmount:   c.bid_total_amount,
      proposalUrl:      `${baseUrl}/p/${encodeURIComponent(c.canonical_slug)}`,
      unsubscribeUrl:   `${baseUrl}/api/nurture-unsubscribe?id=${encodeURIComponent(c.client_id)}`,
    });

    if (dryRun) {
      results.push({
        client_id:    c.client_id,
        client_name:  c.client_name,
        client_email: c.client_email,
        proposal_id:  c.proposal_id,
        next_step:    c.next_step,
        subject:      tmpl.subject,
        status:       'would_send',
      });
      continue;
    }

    let sendResult;
    let sendError;
    try {
      const resendResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from:     fromEmail,
          to:       [c.client_email],
          subject:  tmpl.subject,
          html:     tmpl.html,
          text:     tmpl.text,
          reply_to: 'tim@mcmullen.properties',
          headers: {
            'List-Unsubscribe':      `<${baseUrl}/api/nurture-unsubscribe?id=${encodeURIComponent(c.client_id)}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }),
      });
      const resendData = await resendResp.json();
      if (!resendResp.ok) {
        sendError = resendData.message || `Resend ${resendResp.status}`;
      } else {
        sendResult = resendData;
      }
    } catch (e) {
      sendError = e.message || String(e);
    }

    // Log to send table (success OR failure)
    const status = sendError ? 'failed' : 'sent';
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/nurture_email_sends`,
      {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          client_id:       c.client_id,
          proposal_id:     c.proposal_id,
          sequence_step:   c.next_step,
          template_key:    `step_${c.next_step}`,
          subject:         tmpl.subject,
          body_preview:    tmpl.text.slice(0, 200),
          recipient_email: c.client_email,
          status,
          resend_id:       sendResult ? sendResult.id : null,
          error_message:   sendError || null,
        }),
      }
    ).catch((e) => console.error('send log insert failed (non-fatal):', e));

    results.push({
      client_id:    c.client_id,
      client_name:  c.client_name,
      client_email: c.client_email,
      proposal_id:  c.proposal_id,
      next_step:    c.next_step,
      subject:      tmpl.subject,
      status,
      resend_id:    sendResult ? sendResult.id : null,
      error:        sendError || null,
    });
  }

  return jsonResponse({
    success:    true,
    dry_run:    dryRun,
    candidates: candidates.length,
    sent:       results.filter((r) => r.status === 'sent').length,
    failed:     results.filter((r) => r.status === 'failed').length,
    results,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function firstName(fullName) {
  if (!fullName) return 'there';
  return String(fullName).trim().split(/\s+/)[0];
}

function formatMoney(n) {
  if (n == null) return '';
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function renderTemplate(step, ctx) {
  const { firstName: first, projectAddress, bidTotalAmount, proposalUrl, unsubscribeUrl } = ctx;
  const amount = bidTotalAmount ? ` (${formatMoney(bidTotalAmount)})` : '';

  const tmpls = {
    1: {
      subject: `Quick note on your ${projectAddress} design`,
      paragraphs: [
        `Hi ${first},`,
        `Wanted to make sure the proposal for ${projectAddress}${amount} came through OK yesterday and was easy to look through.`,
        `A few things you can do right from the proposal page:`,
        `• Tweak the materials if you'd like to see other options\n• Send me a quick message or request a redesign\n• Lock in your selection when you're ready`,
        `Here's the direct link: ${proposalUrl}`,
        `Take your time. Just let me know if anything's unclear.`,
      ],
    },
    2: {
      subject: `Anything I can help clarify on ${projectAddress}?`,
      paragraphs: [
        `Hi ${first},`,
        `Following up on the proposal for ${projectAddress}. Some homeowners take a bit to mull it over — totally normal — but I want to make sure I'm not the bottleneck.`,
        `If you've got questions on pricing, scope, materials, or timing, hit reply or jump straight in:`,
        proposalUrl,
        `Happy to hop on a call too if that's easier. Just say the word.`,
      ],
    },
    3: {
      subject: `Closing the loop on ${projectAddress}`,
      paragraphs: [
        `Hi ${first},`,
        `Last check-in from me on the ${projectAddress} project. Totally fine if the timing isn't right — I just want to make sure I'm not letting it sit if you're still interested.`,
        `If you'd like to:\n• Keep the proposal live → just reply and I'll hold it\n• Tweak something → ping me or use the chat on the page\n• Go a different direction → no hard feelings, just let me know so I can take it off my radar`,
        `Either way, I appreciate you considering us. Link to your proposal: ${proposalUrl}`,
      ],
    },
  };

  const tmpl = tmpls[step];
  if (!tmpl) throw new Error(`No template for step ${step}`);

  const sig = `— Tim McMullen\nBayside Pavers\ntim@mcmullen.properties`;

  const text =
    tmpl.paragraphs.join('\n\n') +
    `\n\n${sig}\n\n` +
    `---\nIf you'd prefer no more check-ins, click here to opt out: ${unsubscribeUrl}`;

  const html = renderHtml({
    paragraphs: tmpl.paragraphs,
    proposalUrl,
    unsubscribeUrl,
    sig,
  });

  return { subject: tmpl.subject, text, html };
}

function renderHtml({ paragraphs, proposalUrl, unsubscribeUrl, sig }) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const bodyHtml = paragraphs
    .map((p) => {
      // Detect bullet sections (lines starting with •)
      if (p.includes('•')) {
        const lines = p.split('\n').filter(Boolean);
        const intro = lines.find((l) => !l.startsWith('•'));
        const bullets = lines.filter((l) => l.startsWith('•')).map((l) => l.replace(/^•\s*/, ''));
        const introHtml = intro
          ? `<p style="margin: 0 0 8px; color:#353535; font-size:15px; line-height:1.6;">${esc(intro)}</p>`
          : '';
        const ul = `<ul style="margin: 0 0 16px; padding-left: 22px; color:#353535; font-size:15px; line-height:1.6;">${bullets
          .map((b) => `<li style="margin-bottom: 4px;">${esc(b)}</li>`)
          .join('')}</ul>`;
        return introHtml + ul;
      }
      // Detect bare-URL paragraph → button
      if (p === proposalUrl) {
        return `<p style="margin: 16px 0;"><a href="${esc(proposalUrl)}" style="display:inline-block; background:#5d7e69; color:#fff; padding:11px 22px; border-radius:6px; text-decoration:none; font-weight:600; font-size:15px;">View your proposal →</a></p>`;
      }
      // Detect inline URLs and linkify
      const linked = esc(p).replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" style="color:#4a6654; text-decoration:underline;">$1</a>'
      );
      return `<p style="margin: 0 0 16px; color:#353535; font-size:15px; line-height:1.6; white-space:pre-wrap;">${linked}</p>`;
    })
    .join('');

  const sigHtml = `<p style="margin: 22px 0 0; color:#353535; font-size:15px; line-height:1.6; white-space:pre-wrap;">${esc(sig)}</p>`;

  const footerHtml = `
    <hr style="border:0; border-top:1px solid #e8e8e3; margin:24px 0 16px;">
    <p style="margin:0; color:#999; font-size:12px; line-height:1.5;">
      You're getting this because we recently sent you a proposal. If you'd prefer no more check-ins,
      <a href="${esc(unsubscribeUrl)}" style="color:#777;">click here to opt out</a>.
    </p>
  `;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0; padding:0; background:#fafafa; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fafafa;">
    <tr><td align="center" style="padding:24px 16px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px; background:#fff; border:1px solid #e8e8e3; border-radius:10px;">
        <tr><td style="padding:28px 32px;">
          ${bodyHtml}
          ${sigHtml}
          ${footerHtml}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
