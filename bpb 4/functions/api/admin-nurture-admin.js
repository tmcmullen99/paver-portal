/**
 * BPB Sprint 17 — /api/admin-nurture-admin
 *
 * Action-routed endpoint for the /admin/nurture.html control panel.
 * Auth: Supabase JWT in Authorization header, role 'master' or 'designer'.
 *
 * Actions (passed in JSON body):
 *   { action: 'get_state' }                       → full state for the page (calls admin_nurture_state)
 *   { action: 'pause',       client_id, days? }   → pause client for N days (default 7)
 *   { action: 'resume',      client_id }          → clear pause
 *   { action: 'opt_out',     client_id }          → permanently opt client out
 *   { action: 'force_send',  client_id, step }    → force-send a specific step right now
 *   { action: 'save_template', step, subject, paragraphs }  → update one template
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
    return json({ error: 'SUPABASE config missing' }, 500);
  }

  // ── Auth
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
  const token = authHeader.slice(7);

  const userResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userResp.ok) return json({ error: 'Invalid session' }, 401);
  const user = await userResp.json();
  if (!user?.id) return json({ error: 'No user' }, 401);

  const profResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const profs = await profResp.json();
  if (!profs?.[0] || !['master', 'designer'].includes(profs[0].role)) {
    return json({ error: 'Forbidden' }, 403);
  }
  const userId = user.id;

  // ── Body
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }
  const { action } = body || {};
  if (!action) return json({ error: 'Missing action' }, 400);

  // ── Dispatch
  try {
    switch (action) {
      case 'get_state':       return await handleGetState(env);
      case 'pause':           return await handlePause(env, body);
      case 'resume':          return await handleResume(env, body);
      case 'opt_out':         return await handleOptOut(env, body);
      case 'force_send':      return await handleForceSend(env, body);
      case 'save_template':   return await handleSaveTemplate(env, body, userId);
      default:                return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: 'Internal error', detail: String(e?.message || e) }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Action handlers
// ─────────────────────────────────────────────────────────────────────

async function handleGetState(env) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_nurture_state`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!resp.ok) return json({ error: 'State RPC failed', detail: await resp.text() }, 500);
  return json({ success: true, state: await resp.json() });
}

async function handlePause(env, body) {
  const { client_id, days } = body;
  if (!UUID_RE.test(client_id || '')) return json({ error: 'Invalid client_id' }, 400);
  const numDays = Math.max(1, Math.min(parseInt(days, 10) || 7, 365));
  const until = new Date(Date.now() + numDays * 86400000).toISOString();
  const resp = await patchClient(env, client_id, { nurture_paused_until: until });
  if (!resp.ok) return json({ error: 'Pause failed', detail: resp.error }, 500);
  return json({ success: true, client_id, paused_until: until });
}

async function handleResume(env, body) {
  const { client_id } = body;
  if (!UUID_RE.test(client_id || '')) return json({ error: 'Invalid client_id' }, 400);
  const resp = await patchClient(env, client_id, { nurture_paused_until: null });
  if (!resp.ok) return json({ error: 'Resume failed', detail: resp.error }, 500);
  return json({ success: true, client_id });
}

async function handleOptOut(env, body) {
  const { client_id } = body;
  if (!UUID_RE.test(client_id || '')) return json({ error: 'Invalid client_id' }, 400);
  const resp = await patchClient(env, client_id, { nurture_opted_out_at: new Date().toISOString() });
  if (!resp.ok) return json({ error: 'Opt-out failed', detail: resp.error }, 500);
  return json({ success: true, client_id });
}

async function handleForceSend(env, body) {
  const { client_id, step } = body;
  if (!UUID_RE.test(client_id || '')) return json({ error: 'Invalid client_id' }, 400);
  const stepNum = parseInt(step, 10);
  if (![1, 2, 3].includes(stepNum)) return json({ error: 'Invalid step (must be 1, 2, or 3)' }, 400);
  if (!env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY missing' }, 500);

  // Look up client + their canonical proposal
  const clientResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/clients?id=eq.${client_id}&deleted_at=is.null&select=id,name,email`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const clients = await clientResp.json();
  if (!clients?.[0]) return json({ error: 'Client not found' }, 404);
  const client = clients[0];
  if (!client.email) return json({ error: 'Client has no email on file' }, 400);

  const propResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/client_proposals?client_id=eq.${client_id}&select=proposal_id,proposal:proposals(id,project_address,bid_total_amount),published:published_proposals(slug,is_canonical)&order=created_at.desc&limit=1`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const props = await propResp.json();
  if (!props?.[0]?.proposal) return json({ error: 'No proposal found for client' }, 404);
  const proposal = props[0].proposal;
  const pubArr = (props[0].published || []).filter((p) => p.is_canonical);
  const slug = pubArr[0]?.slug;
  if (!slug) return json({ error: 'No canonical published proposal' }, 404);

  // Load template
  const tmplResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/nurture_email_templates?sequence_step=eq.${stepNum}&select=subject,paragraphs`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const tmpls = await tmplResp.json();
  if (!tmpls?.[0]) return json({ error: `No template for step ${stepNum}` }, 500);
  const template = tmpls[0];

  const baseUrl = (env.PORTAL_BASE_URL || 'https://portal-baysidepavers.com').replace(/\/$/, '');
  const fromEmail = env.RESEND_FROM_EMAIL || 'Paver Portal <tim@mcmullen.properties>';

  const ctx = {
    first_name: (client.name || 'there').split(/\s+/)[0],
    project_address: proposal.project_address || 'your project',
    bid_total_amount: proposal.bid_total_amount,
    proposal_url: `${baseUrl}/p/${encodeURIComponent(slug)}`,
    unsubscribe_url: `${baseUrl}/api/nurture-unsubscribe?id=${encodeURIComponent(client_id)}`,
  };

  const subject = substitute(template.subject, ctx);
  const paragraphs = (template.paragraphs || []).map((p) => substitute(p, ctx));
  const text = buildText(paragraphs, ctx);
  const html = buildHtml(paragraphs, ctx);

  // Send
  let resendId = null;
  let sendError = null;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromEmail,
        to: [client.email],
        subject, html, text,
        reply_to: 'tim@mcmullen.properties',
        headers: {
          'List-Unsubscribe': `<${ctx.unsubscribe_url}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    });
    const data = await resp.json();
    if (!resp.ok) sendError = data.message || `Resend ${resp.status}`;
    else resendId = data.id;
  } catch (e) { sendError = e.message || String(e); }

  // Log to nurture_email_sends (use UPSERT to avoid unique-constraint error if already sent)
  await fetch(
    `${env.SUPABASE_URL}/rest/v1/nurture_email_sends?on_conflict=client_id,proposal_id,sequence_step`,
    {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        client_id,
        proposal_id: proposal.id,
        sequence_step: stepNum,
        template_key: `step_${stepNum}_forced`,
        subject,
        body_preview: text.slice(0, 200),
        recipient_email: client.email,
        status: sendError ? 'failed' : 'sent',
        resend_id: resendId,
        error_message: sendError || null,
      }),
    }
  ).catch(() => {});

  if (sendError) return json({ error: 'Send failed', detail: sendError }, 500);
  return json({ success: true, client_id, step: stepNum, resend_id: resendId, subject });
}

async function handleSaveTemplate(env, body, userId) {
  const { step, subject, paragraphs } = body;
  const stepNum = parseInt(step, 10);
  if (![1, 2, 3].includes(stepNum)) return json({ error: 'Invalid step' }, 400);
  if (!subject || typeof subject !== 'string') return json({ error: 'Subject required' }, 400);
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) return json({ error: 'Paragraphs must be a non-empty array' }, 400);
  if (subject.length > 200) return json({ error: 'Subject too long (max 200)' }, 400);
  if (paragraphs.some((p) => typeof p !== 'string')) return json({ error: 'Each paragraph must be a string' }, 400);

  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/nurture_email_templates?sequence_step=eq.${stepNum}`,
    {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ subject, paragraphs, updated_at: new Date().toISOString(), updated_by: userId }),
    }
  );
  if (!resp.ok) return json({ error: 'Update failed', detail: await resp.text() }, 500);
  const rows = await resp.json();
  return json({ success: true, template: rows[0] });
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

async function patchClient(env, clientId, patch) {
  try {
    const resp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}&deleted_at=is.null`,
      {
        method: 'PATCH',
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      }
    );
    if (!resp.ok) return { ok: false, error: await resp.text() };
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

function substitute(s, ctx) {
  const bidParen = ctx.bid_total_amount
    ? ` ($${Number(ctx.bid_total_amount).toLocaleString('en-US', { maximumFractionDigits: 0 })})`
    : '';
  return String(s ?? '')
    .replace(/\{first_name\}/g,      ctx.first_name || 'there')
    .replace(/\{project_address\}/g, ctx.project_address || 'your project')
    .replace(/\{bid_amount_paren\}/g, bidParen)
    .replace(/\{proposal_url\}/g,    ctx.proposal_url || '')
    .replace(/\{unsubscribe_url\}/g, ctx.unsubscribe_url || '');
}

function buildText(paragraphs, ctx) {
  const sig = '— Tim McMullen\nPaver Portal\ntim@mcmullen.properties';
  return paragraphs.join('\n\n') + `\n\n${sig}\n\n---\nIf you'd prefer no more check-ins, click here to opt out: ${ctx.unsubscribe_url}`;
}

function buildHtml(paragraphs, ctx) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = paragraphs.map((p) => {
    if (p.includes('•')) {
      const lines = p.split('\n').filter(Boolean);
      const intro = lines.find((l) => !l.startsWith('•'));
      const bullets = lines.filter((l) => l.startsWith('•')).map((l) => l.replace(/^•\s*/, ''));
      const introHtml = intro ? `<p style="margin:0 0 8px;color:#353535;font-size:15px;line-height:1.6;">${esc(intro)}</p>` : '';
      const ul = `<ul style="margin:0 0 16px;padding-left:22px;color:#353535;font-size:15px;line-height:1.6;">${bullets.map((b) => `<li style="margin-bottom:4px;">${esc(b)}</li>`).join('')}</ul>`;
      return introHtml + ul;
    }
    if (p.trim() === ctx.proposal_url) {
      return `<p style="margin:16px 0;"><a href="${esc(ctx.proposal_url)}" style="display:inline-block;background:#9c7440;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">View your proposal →</a></p>`;
    }
    const linked = esc(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#7d5c31;text-decoration:underline;">$1</a>');
    return `<p style="margin:0 0 16px;color:#353535;font-size:15px;line-height:1.6;white-space:pre-wrap;">${linked}</p>`;
  }).join('');
  const sig = `<p style="margin:22px 0 0;color:#353535;font-size:15px;line-height:1.6;white-space:pre-wrap;">— Tim McMullen\nPaver Portal\ntim@mcmullen.properties</p>`;
  const footer = `<hr style="border:0;border-top:1px solid #e8e8e3;margin:24px 0 16px;"><p style="margin:0;color:#999;font-size:12px;line-height:1.5;">You're getting this because we recently sent you a proposal. If you'd prefer no more check-ins, <a href="${esc(ctx.unsubscribe_url)}" style="color:#777;">click here to opt out</a>.</p>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fafafa;"><tr><td align="center" style="padding:24px 16px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;background:#fff;border:1px solid #e8e8e3;border-radius:10px;"><tr><td style="padding:28px 32px;">${body}${sig}${footer}</td></tr></table></td></tr></table></body></html>`;
}
