// ═══════════════════════════════════════════════════════════════════════════
// /api/send-follow-up  —  Phase 6.3B
//
// Designer- or master-callable. Sends a follow-up email to a homeowner about
// a specific proposal. Supports two modes:
//
//   single mode  — { proposal_id, template_kind, subject, body, force? }
//                  Sends one follow-up. Returns { ok, follow_up_id, ... }.
//
//   bulk mode    — { items: [{ proposal_id, template_kind, subject, body }, ...], force? }
//                  Sends up to 50 follow-ups in sequence (200ms stagger
//                  between Resend calls to stay well under any rate limit).
//                  Returns { ok, results: [...] }.
//
// Dedup logic (skipped if force=true):
//   For each proposal, if any prior follow-up was sent in the last 7 days,
//   skip and report status='skipped_recent_send'.
//
// reply_to is set to the DESIGNER'S email (caller's profile.email) so client
// replies route back to the designer's inbox, not the from-address.
//
// Returns:
//   200 { ok, follow_up_id?, results? }
//   400 { error }   bad input
//   401 { error }   missing/invalid auth
//   403 { error }   caller is neither master nor designer, or doesn't own
//                   the proposal (master bypasses ownership)
//   502 { error }   upstream Supabase / Resend error
// ═══════════════════════════════════════════════════════════════════════════

const DEDUP_WINDOW_DAYS = 7;
const DEDUP_WINDOW_MS = DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const MAX_BULK = 50;
const STAGGER_MS = 200;

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const SUPABASE_URL    = env.SUPABASE_URL;
    const SERVICE_ROLE    = env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND_API_KEY  = env.RESEND_API_KEY;
    const RESEND_FROM     = env.RESEND_FROM || 'Tim McMullen <tim@mcmullen.properties>';

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { error: 'Server not configured' });
    }
    if (!RESEND_API_KEY) {
      return json(500, { error: 'RESEND_API_KEY not configured — cannot send follow-ups' });
    }

    // Verify caller
    const auth = request.headers.get('authorization') || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!tok) return json(401, { error: 'Missing auth token' });

    const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'Authorization': 'Bearer ' + tok, 'apikey': SERVICE_ROLE },
    });
    if (!userResp.ok) return json(401, { error: 'Invalid auth token' });
    const callerUser = await userResp.json();
    if (!callerUser || !callerUser.id) return json(401, { error: 'Invalid auth token' });

    // Look up caller profile (must be master or active designer)
    const profResp = await fetch(
      SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(callerUser.id) +
      '&select=id,email,role,is_active,display_name',
      { headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE } }
    );
    const profs = await profResp.json();
    const callerProfile = Array.isArray(profs) && profs[0];
    if (!callerProfile || !callerProfile.is_active ||
        (callerProfile.role !== 'master' && callerProfile.role !== 'designer')) {
      return json(403, { error: 'Designer or master access required' });
    }

    const isMaster = callerProfile.role === 'master';
    const replyTo = callerProfile.email || RESEND_FROM;

    // Parse body
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json(400, { error: 'Invalid JSON body' });
    }
    const force = !!body.force;

    // Normalize to bulk shape regardless of mode
    let items = [];
    if (Array.isArray(body.items)) {
      items = body.items;
    } else if (body.proposal_id) {
      items = [{
        proposal_id: body.proposal_id,
        template_kind: body.template_kind || 'custom',
        subject: body.subject,
        body: body.body,
      }];
    } else {
      return json(400, { error: 'Provide proposal_id or items[]' });
    }

    if (items.length === 0) return json(400, { error: 'No items to send' });
    if (items.length > MAX_BULK) {
      return json(400, { error: 'Bulk limit is ' + MAX_BULK + ' per request' });
    }

    // Validate each item up-front
    for (const item of items) {
      if (!item || typeof item !== 'object') return json(400, { error: 'Invalid item shape' });
      if (!item.proposal_id) return json(400, { error: 'Each item needs a proposal_id' });
      if (!item.subject || typeof item.subject !== 'string' || item.subject.length > 240) {
        return json(400, { error: 'Each item needs a subject (≤240 chars)' });
      }
      if (!item.body || typeof item.body !== 'string' || item.body.length > 8000) {
        return json(400, { error: 'Each item needs a body (≤8000 chars)' });
      }
      if (item.template_kind && !['check_in','question','engagement_observed','custom'].includes(item.template_kind)) {
        return json(400, { error: 'Invalid template_kind: ' + item.template_kind });
      }
    }

    const sb = (path, init) =>
      fetch(SUPABASE_URL + '/rest/v1/' + path, {
        ...init,
        headers: {
          'apikey': SERVICE_ROLE,
          'Authorization': 'Bearer ' + SERVICE_ROLE,
          ...((init && init.headers) || {}),
        },
      });

    // Process items sequentially (with stagger)
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (i > 0) await sleep(STAGGER_MS);

      const result = await sendOne({
        item,
        callerUser,
        callerProfile,
        isMaster,
        replyTo,
        force,
        sb,
        SUPABASE_URL,
        SERVICE_ROLE,
        RESEND_API_KEY,
        RESEND_FROM,
        request,
      });
      results.push(result);
    }

    // Single mode → flatten
    if (!Array.isArray(body.items)) {
      const r = results[0];
      const status = r.ok ? 200 : (r.status_code || 502);
      return json(status, r.ok ? r : { error: r.error, ...r });
    }

    return json(200, { ok: true, results });

  } catch (err) {
    return json(500, { error: (err && err.message) || 'Unexpected server error' });
  }
}

async function sendOne({ item, callerUser, callerProfile, isMaster, replyTo, force, sb, SUPABASE_URL, SERVICE_ROLE, RESEND_API_KEY, RESEND_FROM, request }) {
  const proposalId = item.proposal_id;

  // Load proposal + ownership check + client info
  const propResp = await sb(
    'proposals?id=eq.' + encodeURIComponent(proposalId) +
    '&select=id,address,project_address,owner_user_id,client_name,client_email,bid_total_amount&limit=1'
  );
  if (!propResp.ok) {
    return { proposal_id: proposalId, ok: false, error: 'Proposal lookup failed', status_code: 502 };
  }
  const propRows = await propResp.json();
  if (!propRows.length) {
    return { proposal_id: proposalId, ok: false, error: 'Proposal not found', status_code: 404 };
  }
  const proposal = propRows[0];

  if (!isMaster && proposal.owner_user_id && proposal.owner_user_id !== callerUser.id) {
    return { proposal_id: proposalId, ok: false, error: 'Not your proposal', status_code: 403 };
  }

  // Resolve recipient — prefer client_proposals → clients.email, fallback to proposals.client_email
  let recipientEmail = null;
  let recipientName = null;
  let clientId = null;

  const cpResp = await sb(
    'client_proposals?proposal_id=eq.' + encodeURIComponent(proposalId) +
    '&select=client:clients!client_id(id,name,email)&limit=10'
  );
  if (cpResp.ok) {
    const cpRows = await cpResp.json();
    const firstWithEmail = cpRows.find((r) => r.client && r.client.email);
    if (firstWithEmail && firstWithEmail.client) {
      recipientEmail = firstWithEmail.client.email;
      recipientName = firstWithEmail.client.name;
      clientId = firstWithEmail.client.id;
    }
  }
  if (!recipientEmail && proposal.client_email) {
    recipientEmail = proposal.client_email;
    recipientName = proposal.client_name;
  }
  if (!recipientEmail) {
    return { proposal_id: proposalId, ok: false, error: 'No client email on file', status_code: 400 };
  }

  // Dedup check
  if (!force) {
    const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const dupResp = await sb(
      'proposal_follow_ups?proposal_id=eq.' + encodeURIComponent(proposalId) +
      '&status=eq.sent&sent_at=gte.' + encodeURIComponent(cutoff) +
      '&select=id,sent_at&limit=1'
    );
    if (dupResp.ok) {
      const dupRows = await dupResp.json();
      if (dupRows.length > 0) {
        return {
          proposal_id: proposalId,
          ok: false,
          status: 'skipped_recent_send',
          error: 'A follow-up was sent within the last 7 days. Use force=true to override.',
          last_sent_at: dupRows[0].sent_at,
          status_code: 409,
        };
      }
    }
  }

  // Build engagement snapshot (for retro / record-keeping)
  const engagementSnapshot = await buildEngagementSnapshot(sb, proposalId);

  // Insert queued row
  const followUpId = crypto.randomUUID();
  const insertResp = await sb('proposal_follow_ups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({
      id: followUpId,
      proposal_id: proposalId,
      client_id: clientId,
      sent_by: callerUser.id,
      template_kind: item.template_kind || 'custom',
      recipient_email: recipientEmail,
      subject: item.subject,
      body_text: item.body,
      engagement_snapshot: engagementSnapshot,
      status: 'queued',
    }),
  });
  if (!insertResp.ok) {
    const errText = await insertResp.text();
    return { proposal_id: proposalId, ok: false, error: 'Could not queue: ' + errText.slice(0, 240), status_code: 502 };
  }

  // Render email
  const proposalAddress = proposal.address || proposal.project_address || 'your proposal';
  const designerName = (callerProfile.display_name || 'your designer').trim();
  const proposalUrl = await resolveProposalUrl(sb, proposalId, request);

  const html = buildHtml({
    bodyText: item.body,
    designerName,
    proposalAddress,
    proposalUrl,
  });
  const text = buildText({
    bodyText: item.body,
    designerName,
    proposalAddress,
    proposalUrl,
  });

  // Send via Resend
  let sendStatus = 'failed';
  let resendId = null;
  let errorMessage = null;
  try {
    const emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:     RESEND_FROM,
        to:       [recipientEmail],
        reply_to: [replyTo],
        subject:  item.subject,
        html,
        text,
      }),
    });
    if (emailResp.ok) {
      const respData = await emailResp.json().catch(() => ({}));
      resendId = respData.id || null;
      sendStatus = 'sent';
    } else {
      errorMessage = 'Resend ' + emailResp.status + ': ' + (await emailResp.text()).slice(0, 240);
    }
  } catch (err) {
    errorMessage = 'Resend fetch failed: ' + ((err && err.message) || 'unknown');
  }

  // Update row with final status
  await sb('proposal_follow_ups?id=eq.' + encodeURIComponent(followUpId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: sendStatus,
      resend_message_id: resendId,
      error_message: errorMessage,
      sent_at: sendStatus === 'sent' ? new Date().toISOString() : null,
    }),
  }).catch(() => {});

  if (sendStatus === 'sent') {
    return {
      proposal_id: proposalId,
      ok: true,
      follow_up_id: followUpId,
      status: 'sent',
      recipient_email: recipientEmail,
      resend_message_id: resendId,
    };
  }
  return {
    proposal_id: proposalId,
    ok: false,
    follow_up_id: followUpId,
    status: 'failed',
    error: errorMessage || 'Send failed',
    status_code: 502,
  };
}

async function buildEngagementSnapshot(sb, proposalId) {
  const snapshot = {
    event_count: 0,
    last_event_at: null,
    sections_viewed: 0,
    sub_count: 0,
    redesign_count: 0,
  };
  try {
    const evResp = await sb(
      'proposal_events?proposal_id=eq.' + encodeURIComponent(proposalId) +
      '&select=event_type,occurred_at&order=occurred_at.desc&limit=200'
    );
    if (evResp.ok) {
      const events = await evResp.json();
      snapshot.event_count = events.length;
      if (events.length > 0) snapshot.last_event_at = events[0].occurred_at;
      snapshot.sections_viewed = events.filter((e) => e.event_type === 'section_view').length;
    }

    const subResp = await sb(
      'proposal_substitutions?proposal_id=eq.' + encodeURIComponent(proposalId) +
      '&select=id&limit=50'
    );
    if (subResp.ok) snapshot.sub_count = (await subResp.json()).length;

    const redResp = await sb(
      'proposal_redesign_requests?proposal_id=eq.' + encodeURIComponent(proposalId) +
      '&select=id&limit=50'
    );
    if (redResp.ok) snapshot.redesign_count = (await redResp.json()).length;
  } catch (err) {
    // Best-effort. Snapshot is for audit, not critical.
  }
  return snapshot;
}

async function resolveProposalUrl(sb, proposalId, request) {
  try {
    const ppResp = await sb(
      'published_proposals?proposal_id=eq.' + encodeURIComponent(proposalId) +
      '&select=slug&order=published_at.desc&limit=1'
    );
    if (ppResp.ok) {
      const rows = await ppResp.json();
      if (rows.length && rows[0].slug) {
        const origin = new URL(request.url).origin;
        return origin + '/p/' + rows[0].slug;
      }
    }
  } catch (err) {}
  return null;
}

function buildHtml({ bodyText, designerName, proposalAddress, proposalUrl }) {
  const paragraphs = bodyText.split(/\n\n+/).map((p) =>
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#1f2125;">' +
    escapeHtml(p).replace(/\n/g, '<br>') + '</p>'
  ).join('');

  const cta = proposalUrl
    ? '<div style="text-align:center;margin:24px 0 28px;">' +
      '<a href="' + escapeHtml(proposalUrl) + '" style="display:inline-block;background:#9c7440;color:#fff;text-decoration:none;padding:13px 28px;border-radius:4px;font-size:14px;font-weight:600;">View your proposal &rarr;</a>' +
      '</div>'
    : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#f7f7f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f2125;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f7f4;padding:40px 20px;"><tr><td align="center">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
    '<tr><td style="padding:32px 40px 16px;text-align:center;">' +
    '<img src="https://portal-baysidepavers.com/assets/paver-portal-logo.svg" alt="Paver Portal" style="height:32px;width:auto;">' +
    '</td></tr>' +
    '<tr><td style="padding:8px 40px 12px;">' + paragraphs + cta + '</td></tr>' +
    '<tr><td style="padding:24px 40px;background:#f7f7f4;border-top:1px solid #e4e4df;">' +
    '<p style="margin:0 0 4px;font-size:14px;">Talk soon,</p>' +
    '<p style="margin:0;font-size:14px;font-weight:600;">' + escapeHtml(designerName) + '</p>' +
    '<p style="margin:0;font-size:13px;color:#70726f;">Paver Portal</p>' +
    '<p style="margin:8px 0 0;font-size:12px;color:#a0a09c;">Re: ' + escapeHtml(proposalAddress) + '</p>' +
    '</td></tr></table></td></tr></table></body></html>';
}

function buildText({ bodyText, designerName, proposalAddress, proposalUrl }) {
  const lines = [bodyText, ''];
  if (proposalUrl) lines.push('View your proposal: ' + proposalUrl, '');
  lines.push('Talk soon,', designerName, 'Paver Portal', '', 'Re: ' + proposalAddress);
  return lines.join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age':       '86400',
    },
  });
}
