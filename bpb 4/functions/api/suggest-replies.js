// ═══════════════════════════════════════════════════════════════════════════
// suggest-replies.js — Sprint 11 + Sprint 12
//
// Cloudflare Pages Function at POST /api/suggest-replies.
// Generates 3 contextual reply OR outreach suggestions for the War Room.
//
// Input:
//   { client_id: <uuid>, mode?: 'reply' | 'outreach', bucket?: string }
//
//   mode='reply'    (default) — respond to last message in thread
//   mode='outreach' — draft a re-engagement message to a cold lead
//   bucket          — optional context tag for outreach mode
//                     ('drafted' | 'never_opened' | 'ghosted' | 'manual')
//
// Auth:   Bearer <designer/master access_token>
// Output: { ok: true, mode, suggestions: [string, string, string] }
//      or { ok: false, error: "human-readable", suggestions: [...fallback] }
// ═══════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://gfgbypcnxkschnfsitfb.supabase.co';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const RECENT_MESSAGE_COUNT = 6;
const DISCOUNT_WINDOW_MS = 48 * 60 * 60 * 1000;

const FALLBACK_REPLY = [
  "Happy to schedule a quick call to walk you through it — what's a good time?",
  "Great question — let me look into that and get back to you shortly.",
  "I can put together a quick comparison if that would help.",
];

const FALLBACK_OUTREACH = [
  "Hey, just circling back on your project — is now still a good time to chat about next steps?",
  "Wanted to check in and see if any questions have come up since we last connected.",
  "If it'd help, I can hop on a quick 15-min call to walk through the proposal together.",
];

export async function onRequestPost({ request, env }) {
  let mode = 'reply';
  try {
    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ ok: false, error: 'API key not configured', suggestions: FALLBACK_REPLY }, 200);
    }

    const auth = request.headers.get('Authorization') || '';
    if (!auth.startsWith('Bearer ')) {
      return jsonResponse({ ok: false, error: 'Missing auth' }, 401);
    }
    const accessToken = auth.slice(7);

    const body = await request.json().catch(() => ({}));
    const clientId = body.client_id;
    mode = body.mode === 'outreach' ? 'outreach' : 'reply';
    const bucket = typeof body.bucket === 'string' ? body.bucket : null;

    if (!clientId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      return jsonResponse({ ok: false, error: 'Invalid client_id' }, 400);
    }

    const profile = await sbFetchSingle(
      `${SUPABASE_URL}/rest/v1/profiles?select=id,role,display_name,is_active&limit=1`,
      accessToken,
    );
    if (!profile || profile.is_active === false || (profile.role !== 'master' && profile.role !== 'designer')) {
      return jsonResponse({ ok: false, error: 'Staff access required' }, 403);
    }

    const [client, messages, proposalLinks] = await Promise.all([
      sbFetchSingle(
        `${SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}&select=id,name,email`,
        accessToken,
      ),
      sbFetchList(
        `${SUPABASE_URL}/rest/v1/client_messages?client_id=eq.${clientId}&select=sender_role,body,created_at&order=created_at.desc&limit=${RECENT_MESSAGE_COUNT}`,
        accessToken,
      ),
      sbFetchList(
        `${SUPABASE_URL}/rest/v1/client_proposals?client_id=eq.${clientId}&select=status,sent_at,signed_at,has_used_free_revision,proposal:proposals(id,address,project_address,bid_total_amount,show_signing_discount,published_proposals(slug,published_at,is_canonical))`,
        accessToken,
      ),
    ]);

    if (!client) {
      return jsonResponse({ ok: false, error: 'Client not found or no access' }, 404);
    }

    const promptContext = buildPromptContext({
      designer: profile,
      client,
      messages: (messages || []).reverse(),
      proposalLinks: proposalLinks || [],
      mode,
      bucket,
    });

    const suggestions = await callAnthropic(env.ANTHROPIC_API_KEY, promptContext);

    return jsonResponse({ ok: true, mode, suggestions });

  } catch (err) {
    console.error('[suggest-replies] error:', err);
    return jsonResponse({
      ok: false,
      error: err.message || 'Unknown error',
      mode,
      suggestions: mode === 'outreach' ? FALLBACK_OUTREACH : FALLBACK_REPLY,
    }, 200);
  }
}

// ─── Supabase REST helpers ─────────────────────────────────────────────────
async function sbFetchSingle(url, accessToken) {
  const list = await sbFetchList(url, accessToken);
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}
async function sbFetchList(url, accessToken) {
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'apikey': accessToken,
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Supabase ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// ─── Prompt construction ──────────────────────────────────────────────────
function buildPromptContext({ designer, client, messages, proposalLinks, mode, bucket }) {
  const designerName = designer.display_name || 'the designer';

  const sortedProps = [...proposalLinks]
    .filter(cp => cp.proposal)
    .sort((a, b) => (b.sent_at || '').localeCompare(a.sent_at || ''));
  const activeCp = sortedProps.find(cp => cp.status === 'sent') || sortedProps[0] || null;

  let proposalLine = 'No active proposal.';
  let discountNote = '';
  let revisionNote = '';
  let daysSinceSentNote = '';

  if (activeCp && activeCp.proposal) {
    const p = activeCp.proposal;
    const addr = p.address || p.project_address || 'their project';
    const bid = p.bid_total_amount
      ? `$${Number(p.bid_total_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : 'unspecified amount';
    const status = activeCp.status || 'in progress';
    proposalLine = `Active proposal: ${addr} (${bid}, ${status}).`;

    if (activeCp.sent_at) {
      const days = Math.floor((Date.now() - new Date(activeCp.sent_at).getTime()) / 86400000);
      if (days > 0) daysSinceSentNote = `Proposal was sent ${days} day${days === 1 ? '' : 's'} ago.`;
    }

    if (p.show_signing_discount !== false) {
      const pubs = Array.isArray(p.published_proposals) ? p.published_proposals : [];
      const canonical = pubs.find(pp => pp.is_canonical) || pubs[0];
      if (canonical?.published_at) {
        const elapsed = Date.now() - new Date(canonical.published_at).getTime();
        const remaining = DISCOUNT_WINDOW_MS - elapsed;
        if (remaining > 0) {
          const hours = Math.floor(remaining / 3600000);
          discountNote = `5% signing discount expires in ${hours}h.`;
        }
      }
    }

    if (activeCp.has_used_free_revision) {
      revisionNote = 'Free revision has already been used.';
    } else {
      revisionNote = 'Free revision is still available.';
    }
  }

  const transcript = messages.length === 0
    ? '(No prior messages — this would be the designer\'s first reply.)'
    : messages.map(m => {
        const who = m.sender_role === 'homeowner'
          ? client.name || 'Homeowner'
          : (m.sender_role === 'master' || m.sender_role === 'designer') ? designerName : m.sender_role;
        return `${who}: ${(m.body || '').trim()}`;
      }).join('\n');

  return {
    designerName,
    clientName: client.name || 'the homeowner',
    clientFirstName: (client.name || '').split(/\s+/)[0] || 'them',
    proposalLine,
    discountNote,
    revisionNote,
    daysSinceSentNote,
    transcript,
    messageCount: messages.length,
    mode,
    bucket,
  };
}

// ─── Anthropic call ────────────────────────────────────────────────────────
async function callAnthropic(apiKey, ctx) {
  const systemPrompt = ctx.mode === 'outreach'
    ? buildOutreachPrompt(ctx)
    : buildReplyPrompt(ctx);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      messages: [
        { role: 'user', content: systemPrompt },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error('No text in Anthropic response');
  }

  const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('Model returned malformed JSON');
  }

  const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const fallback = ctx.mode === 'outreach' ? FALLBACK_OUTREACH : FALLBACK_REPLY;
  const cleanedList = list
    .map(s => typeof s === 'string' ? s.trim() : '')
    .filter(s => s.length > 0 && s.length <= 220)
    .slice(0, 3);

  while (cleanedList.length < 3) {
    cleanedList.push(fallback[cleanedList.length] || fallback[0]);
  }
  return cleanedList;
}

function buildReplyPrompt(ctx) {
  return [
    `You are helping ${ctx.designerName}, a Paver Portal designer, write quick reply suggestions in a chat with a homeowner.`,
    `Paver Portal installs hardscape: pavers, porcelain decking, retaining walls, fire features, pool decks. ICPI-certified install.`,
    ``,
    `Context:`,
    `Client: ${ctx.clientName}`,
    `${ctx.proposalLine}`,
    ctx.discountNote ? `${ctx.discountNote}` : '',
    ctx.revisionNote ? `${ctx.revisionNote}` : '',
    ``,
    `Recent conversation (oldest first):`,
    ctx.transcript,
    ``,
    `Generate 3 short reply suggestions ${ctx.designerName} could send next. Each must be:`,
    `- Under 110 characters`,
    `- Written in first person, conversational, no formal greeting`,
    `- Helpful and warm but not pushy`,
    `- Distinct in approach: one friendly/acknowledging, one informative/answer-focused, one action-oriented (offer to call, schedule, send PDF, etc.)`,
    ``,
    `Return ONLY a JSON object with this exact shape, no preamble or markdown:`,
    `{"suggestions":["text 1","text 2","text 3"]}`,
  ].filter(Boolean).join('\n');
}

// Sprint 12: outreach mode — draft a fresh re-engagement message to a cold lead.
// The designer hasn't said anything yet (or the thread is stale). We're not
// "responding" — we're opening or re-opening a conversation.
//
// Forward-compat with Sprint 14: prompt asks for messages that read like
// reusable opening templates (specific enough to feel personal, general
// enough to lift into a nurture template later).
function buildOutreachPrompt(ctx) {
  const bucketLine = {
    drafted:      `This client has a DRAFT proposal that ${ctx.designerName} never sent. Goal: nudge them to schedule the design review so the proposal can be finalized and presented.`,
    never_opened: `${ctx.daysSinceSentNote || 'The proposal was sent some time ago.'} They never opened it. Goal: re-engage with a low-pressure check-in. Don't shame them for not opening.`,
    ghosted:      `They opened the proposal at least once but haven't responded recently. Goal: gentle re-engagement, surface a reason to reconnect (questions? want a walkthrough? something specific).`,
    manual:       `${ctx.designerName} is reaching out manually — purpose unspecified. Goal: a friendly opener that creates a reason for them to respond.`,
  }[ctx.bucket] || `${ctx.designerName} is reaching out manually — keep it warm and create a reason to respond.`;

  const transcriptLine = ctx.messageCount === 0
    ? '(No prior chat messages — this is the first contact in the thread.)'
    : `Last messages exchanged (oldest first, may be stale):\n${ctx.transcript}`;

  return [
    `You are helping ${ctx.designerName}, a Paver Portal designer, draft an OUTREACH message to a homeowner who has gone cold.`,
    `Paver Portal installs hardscape: pavers, porcelain decking, retaining walls, fire features, pool decks. ICPI-certified install.`,
    ``,
    `Situation: ${bucketLine}`,
    ``,
    `Context:`,
    `Client first name: ${ctx.clientFirstName}`,
    `${ctx.proposalLine}`,
    ctx.daysSinceSentNote ? `${ctx.daysSinceSentNote}` : '',
    ctx.discountNote ? `${ctx.discountNote} (Don't lead with discount pressure unless natural.)` : '',
    ctx.revisionNote ? `${ctx.revisionNote}` : '',
    ``,
    transcriptLine,
    ``,
    `Generate 3 distinct outreach drafts ${ctx.designerName} could send to re-engage. Each must be:`,
    `- Under 200 characters`,
    `- Written in first person, conversational tone, no formal greeting like "Dear" or "Hello [name]"`,
    `- Address the homeowner by first name only ("${ctx.clientFirstName}") at most once, ideally not at all`,
    `- Genuine and low-pressure — never pushy, never desperate, never guilt-trip`,
    `- Each one a different angle: one warm/checking-in, one offering value (walkthrough call, comparison, tweak), one with a specific small ask (a single question they can easily answer)`,
    `- Phrased generally enough that a fellow designer could reuse them as templates with minor tweaks — but specific enough to feel personal`,
    ``,
    `Return ONLY a JSON object with this exact shape, no preamble or markdown:`,
    `{"suggestions":["text 1","text 2","text 3"]}`,
  ].filter(Boolean).join('\n');
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
