// ═══════════════════════════════════════════════════════════════════════════
// /api/notify-design-retainer-interest — Sprint 9b
//
// POST endpoint called by homeowner-revision-cta.js when the homeowner
// clicks "I'm interested" on the Design Retainer pitch popup.
//
// Auth: Bearer JWT from the homeowner's Supabase session.
// Body: { client_proposal_id, proposal_id }
//
// What it does (in order):
//   1. Verifies the JWT and resolves the homeowner's auth.users.id.
//   2. Looks up their clients row and confirms the client_proposal_id
//      they're claiming actually belongs to them.
//   3. Idempotency: if design_retainer_interest_at is already set, returns
//      success without resending email (so duplicate clicks don't spam).
//   4. Updates client_proposals.design_retainer_interest_at = now().
//   5. Looks up the proposal's owner_user_id → designer email + name.
//   6. Sends a notification email to the designer via Resend.
//   7. Returns { ok: true, email_sent: true|false }.
//
// All Supabase reads/writes use the service role key (env.SUPABASE_SERVICE_ROLE_KEY)
// to bypass RLS. RLS is still our defense at the row level — but here we've
// already verified the user owns the row, so service role is the cleanest
// way to write the update + read the proposal owner.
// ═══════════════════════════════════════════════════════════════════════════

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // ── 1. Verify auth ─────────────────────────────────────────────────
    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return jsonError('Unauthorized — missing token', 401);
    }
    const accessToken = auth.slice(7);

    const body = await request.json().catch(() => null);
    if (!body) return jsonError('Invalid JSON body', 400);

    const { client_proposal_id, proposal_id } = body;
    if (!client_proposal_id || !proposal_id) {
      return jsonError('Missing client_proposal_id or proposal_id', 400);
    }

    const userResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'apikey': env.SUPABASE_ANON_KEY,
      },
    });
    if (!userResp.ok) return jsonError('Invalid session', 401);
    const user = await userResp.json();
    if (!user.id) return jsonError('Invalid session', 401);

    const userId = user.id;

    const SR_HEADERS = {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    };

    // ── 2. Resolve client + verify ownership of client_proposal_id ────
    const clientResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/clients?user_id=eq.${userId}&select=id,name,email`,
      { headers: SR_HEADERS }
    );
    const clientRows = await clientResp.json();
    if (!Array.isArray(clientRows) || clientRows.length === 0) {
      return jsonError('No client record found for this user', 404);
    }
    const client = clientRows[0];

    const cpResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/client_proposals?id=eq.${client_proposal_id}&select=id,client_id,proposal_id,design_retainer_interest_at`,
      { headers: SR_HEADERS }
    );
    const cpRows = await cpResp.json();
    if (!Array.isArray(cpRows) || cpRows.length === 0) {
      return jsonError('Client proposal not found', 404);
    }
    const cp = cpRows[0];
    if (cp.client_id !== client.id) {
      return jsonError('Forbidden — this client_proposal does not belong to you', 403);
    }
    if (cp.proposal_id !== proposal_id) {
      return jsonError('client_proposal_id and proposal_id mismatch', 400);
    }

    // ── 3. Idempotency: if already recorded, skip the email ───────────
    if (cp.design_retainer_interest_at) {
      return new Response(
        JSON.stringify({ ok: true, already_recorded: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── 4. Update timestamp ───────────────────────────────────────────
    const nowIso = new Date().toISOString();
    const updResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/client_proposals?id=eq.${client_proposal_id}`,
      {
        method: 'PATCH',
        headers: { ...SR_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ design_retainer_interest_at: nowIso }),
      }
    );
    if (!updResp.ok) {
      const errTxt = await updResp.text();
      return jsonError('Update failed: ' + errTxt, 500);
    }

    // ── 5. Look up the proposal + assigned designer ────────────────────
    const propResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/proposals?id=eq.${proposal_id}&select=id,project_address,project_city,owner_user_id,bid_total_amount`,
      { headers: SR_HEADERS }
    );
    const propRows = await propResp.json();
    if (!Array.isArray(propRows) || propRows.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, email_sent: false, reason: 'proposal_not_found' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const proposal = propRows[0];

    let designerEmail = null;
    let designerName = 'there';
    if (proposal.owner_user_id) {
      const profResp = await fetch(
        `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${proposal.owner_user_id}&select=email,display_name`,
        { headers: SR_HEADERS }
      );
      const profRows = await profResp.json();
      if (Array.isArray(profRows) && profRows.length > 0) {
        designerEmail = profRows[0].email || null;
        designerName = profRows[0].display_name || profRows[0].email || 'there';
      }
    }

    // ── 6. Send email via Resend ──────────────────────────────────────
    let emailSent = false;
    if (designerEmail && env.RESEND_API_KEY) {
      const projectAddr = [proposal.project_address, proposal.project_city]
        .filter(Boolean).join(', ') || 'their proposal';
      const adminLink = 'https://portal-baysidepavers.com/admin/clients';
      const fromEmail = env.RESEND_FROM || 'Paver Portal <tim@mcmullen.properties>';

      const emailHtml = `
<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #353535; max-width: 560px; margin: 0 auto; padding: 32px 24px;">
  <h2 style="color: #9c7440; font-size: 18px; margin: 0 0 16px;">🔔 Design Retainer interest</h2>
  <p style="font-size: 15px; line-height: 1.6;">Hi ${escapeText(designerName)},</p>
  <p style="font-size: 15px; line-height: 1.6;">
    <strong>${escapeText(client.name)}</strong> just clicked
    <em>"I'm interested"</em> on the Design Retainer CTA on their
    ${escapeText(projectAddr)} proposal.
  </p>
  <div style="background: #f4f8f5; border-left: 3px solid #9c7440; padding: 14px 18px; margin: 20px 0; border-radius: 6px;">
    <strong>Recommended next step:</strong> Call or text within 24 hours to discuss the
    $2,500 retainer terms and collect payment.
  </div>
  <p style="font-size: 14px; line-height: 1.6;">
    <strong>Client contact:</strong><br>
    ${escapeText(client.name)}<br>
    <a href="mailto:${escapeText(client.email)}" style="color: #9c7440;">${escapeText(client.email)}</a>
  </p>
  <p style="font-size: 13px; color: #666; margin-top: 30px;">
    <a href="${adminLink}" style="color: #9c7440;">Open in admin →</a>
  </p>
</body></html>
      `;

      const resendResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [designerEmail],
          subject: `🔔 ${client.name} is interested in the Design Retainer`,
          html: emailHtml,
        }),
      });
      emailSent = resendResp.ok;
      if (!emailSent) {
        console.warn('[notify-design-retainer-interest] Resend returned',
          resendResp.status, await resendResp.text());
      }
    }

    return new Response(
      JSON.stringify({ ok: true, email_sent: emailSent }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('[notify-design-retainer-interest] error:', err);
    return jsonError('Server error: ' + (err.message || 'unknown'), 500);
  }
}

function jsonError(message, status) {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

function escapeText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
