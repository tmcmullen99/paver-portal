// ═══════════════════════════════════════════════════════════════════════════
// POST /api/submit-substitutions
//
// Phase 4.1 Sprint B2: writes a homeowner's pending material swap requests
// to proposal_substitutions + proposal_substitution_items, then emails the
// designer.
//
// Body: {
//   slug: string,
//   homeowner_note: string|null,
//   items: [{
//     proposal_region_material_id: uuid,
//     replacement_material_id: uuid|null  // null = "remove this material"
//   }]
// }
//
// Auth: homeowner JWT in Authorization: Bearer header.
//
// Returns: { ok: true, substitution_id, item_count, email_sent, email_error }
// ═══════════════════════════════════════════════════════════════════════════

const PUBLIC_BASE_URL = 'https://portal-baysidepavers.com';

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const SUPABASE_URL   = env.SUPABASE_URL;
    const SERVICE_ROLE   = env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND_API_KEY = env.RESEND_API_KEY;
    const RESEND_FROM    = env.RESEND_FROM || 'Paver Portal <tim@mcmullen.properties>';
    const DESIGNER_EMAIL = env.DESIGNER_NOTIFICATION_EMAIL || 'tim@mcmullen.properties';

    if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: 'Server not configured' });

    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return json(401, { error: 'Missing auth token' });

    // Resolve caller
    const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'Authorization': 'Bearer ' + token, 'apikey': SERVICE_ROLE },
    });
    if (!userResp.ok) return json(401, { error: 'Invalid auth token' });
    const callerUser = await userResp.json();
    if (!callerUser || !callerUser.id) return json(401, { error: 'Invalid auth token' });

    // Body
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json(400, { error: 'Invalid JSON body' });
    const slug = String(body.slug || '').trim();
    const homeowner_note = body.homeowner_note ? String(body.homeowner_note).slice(0, 4000) : null;
    const items = Array.isArray(body.items) ? body.items : [];
    if (!slug) return json(400, { error: 'slug is required' });
    if (items.length === 0) return json(400, { error: 'No swaps to submit' });
    if (items.length > 50) return json(400, { error: 'Too many swaps in one submission (max 50)' });

    const sb = (path, init) =>
      fetch(SUPABASE_URL + '/rest/v1/' + path, {
        ...init,
        headers: {
          'apikey': SERVICE_ROLE,
          'Authorization': 'Bearer ' + SERVICE_ROLE,
          ...((init && init.headers) || {}),
        },
      });

    // Resolve slug → proposal_id, published_proposal_id
    const ppResp = await sb(
      'published_proposals?slug=eq.' + encodeURIComponent(slug) +
      '&select=id,proposal_id,project_address&limit=1'
    );
    if (!ppResp.ok) return json(502, { error: 'Slug lookup failed' });
    const ppRows = await ppResp.json();
    if (!ppRows.length) return json(404, { error: 'Proposal not found' });
    const { id: published_proposal_id, proposal_id } = ppRows[0];
    const project_address = ppRows[0].project_address;

    // Ownership check
    const cpResp = await sb(
      'client_proposals?proposal_id=eq.' + encodeURIComponent(proposal_id) +
      '&select=client:clients(id,name,email,user_id)&limit=20'
    );
    if (!cpResp.ok) return json(502, { error: 'Ownership lookup failed' });
    const cpRows = await cpResp.json();
    const matchedRow = cpRows.find((r) => r.client && r.client.user_id === callerUser.id);
    if (!matchedRow) return json(403, { error: 'Not your proposal' });
    const client = matchedRow.client;

    // Validate every proposal_region_material_id actually belongs to this proposal
    const targetIds = items.map((i) => i.proposal_region_material_id).filter(Boolean);
    if (targetIds.length !== items.length) return json(400, { error: 'Each item needs a proposal_region_material_id' });
    const targetInList = targetIds.map((id) => '"' + id + '"').join(',');
    const validResp = await sb(
      'proposal_region_materials?id=in.(' + targetInList + ')' +
      '&select=id,region:proposal_regions(id,proposal_id,name)'
    );
    if (!validResp.ok) return json(502, { error: 'Validation lookup failed' });
    const validRows = await validResp.json();
    const validMap = new Map();
    validRows.forEach((row) => {
      if (row.region && row.region.proposal_id === proposal_id) {
        validMap.set(row.id, row.region.name);
      }
    });
    if (validMap.size !== targetIds.length) {
      return json(400, { error: 'One or more region materials do not belong to this proposal' });
    }

    // Insert parent substitution
    const subInsResp = await sb('proposal_substitutions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({
        proposal_id,
        client_id: client.id,
        published_proposal_id,
        status: 'submitted',
        homeowner_note,
      }),
    });
    if (!subInsResp.ok) {
      return json(502, { error: 'Could not create substitution: ' + (await subInsResp.text()).slice(0, 240) });
    }
    const subRows = await subInsResp.json();
    const substitution = Array.isArray(subRows) ? subRows[0] : subRows;

    // Insert items
    const itemsToInsert = items.map((i) => ({
      substitution_id: substitution.id,
      proposal_region_material_id: i.proposal_region_material_id,
      replacement_material_id: i.replacement_material_id || null,
      homeowner_note: i.homeowner_note ? String(i.homeowner_note).slice(0, 1000) : null,
    }));
    const itemInsResp = await sb('proposal_substitution_items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(itemsToInsert),
    });
    if (!itemInsResp.ok) {
      // Roll back the parent if items fail
      await sb('proposal_substitutions?id=eq.' + substitution.id, { method: 'DELETE' });
      return json(502, { error: 'Could not save swap items: ' + (await itemInsResp.text()).slice(0, 240) });
    }
    const insertedItems = await itemInsResp.json();

    // Look up replacement material names + region context for the email
    const repIds = items.map((i) => i.replacement_material_id).filter(Boolean);
    let materialsLookup = new Map();
    if (repIds.length > 0) {
      const repInList = repIds.map((id) => '"' + id + '"').join(',');
      const matResp = await sb(
        'materials?id=in.(' + repInList + ')&select=id,product_name,color,category'
      );
      if (matResp.ok) {
        (await matResp.json()).forEach((m) => materialsLookup.set(m.id, m));
      }
    }
    // Look up the *current* materials being swapped FROM (for the email)
    const fromInList = targetIds.map((id) => '"' + id + '"').join(',');
    const fromResp = await sb(
      'proposal_region_materials?id=in.(' + fromInList + ')' +
      '&select=id,proposal_material:proposal_materials(' +
        'override_product_name,override_color,' +
        'material:materials(product_name,color),' +
        'belgard_material:belgard_materials(product_name,color),' +
        'third_party_material:third_party_materials(product_name,color)' +
      ')'
    );
    let fromLookup = new Map();
    if (fromResp.ok) {
      (await fromResp.json()).forEach((row) => {
        const pm = row.proposal_material || {};
        const src = pm.material || pm.belgard_material || pm.third_party_material || {};
        fromLookup.set(row.id, {
          product_name: pm.override_product_name || src.product_name || 'Material',
          color: pm.override_color || src.color || '',
        });
      });
    }

    // Send designer email
    let emailSent = false;
    let emailError = null;
    if (RESEND_API_KEY) {
      try {
        const proposalUrl = PUBLIC_BASE_URL + '/p/' + slug;
        const emailResp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: RESEND_FROM,
            to: [DESIGNER_EMAIL],
            reply_to: client.email,
            subject: (client.name || 'Homeowner') + ' requested ' + items.length + ' material change' + (items.length === 1 ? '' : 's') + ' on ' + (project_address || 'their proposal'),
            html: buildDesignerEmailHtml({
              clientName: client.name,
              clientEmail: client.email,
              projectAddress: project_address,
              proposalUrl,
              homeownerNote: homeowner_note,
              items: items.map((i) => ({
                regionName: validMap.get(i.proposal_region_material_id) || 'Section',
                from: fromLookup.get(i.proposal_region_material_id) || { product_name: 'Current material', color: '' },
                to: i.replacement_material_id ? (materialsLookup.get(i.replacement_material_id) || { product_name: 'Selected material', color: '' }) : null,
                note: i.homeowner_note || null,
              })),
            }),
            text: buildDesignerEmailText({
              clientName: client.name,
              projectAddress: project_address,
              proposalUrl,
              homeownerNote: homeowner_note,
              items: items.map((i) => ({
                regionName: validMap.get(i.proposal_region_material_id) || 'Section',
                from: fromLookup.get(i.proposal_region_material_id) || { product_name: 'Current material', color: '' },
                to: i.replacement_material_id ? (materialsLookup.get(i.replacement_material_id) || { product_name: 'Selected material', color: '' }) : null,
                note: i.homeowner_note || null,
              })),
            }),
          }),
        });
        if (emailResp.ok) {
          emailSent = true;
        } else {
          emailError = 'Resend ' + emailResp.status + ': ' + (await emailResp.text()).slice(0, 240);
        }
      } catch (err) {
        emailError = 'Resend fetch failed: ' + ((err && err.message) || 'unknown');
      }
    } else {
      emailError = 'RESEND_API_KEY not configured';
    }

    return json(200, {
      ok: true,
      substitution_id: substitution.id,
      item_count: insertedItems.length,
      email_sent: emailSent,
      email_error: emailError,
    });

  } catch (err) {
    return json(500, { error: (err && err.message) || 'Unexpected server error' });
  }
}

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

function buildDesignerEmailHtml({ clientName, clientEmail, projectAddress, proposalUrl, homeownerNote, items }) {
  const itemsHtml = items.map((it) => {
    const fromLabel = (it.from.product_name || 'Material') + (it.from.color ? ' / ' + it.from.color : '');
    const toLabel = it.to ? ((it.to.product_name || 'Material') + (it.to.color ? ' / ' + it.to.color : '')) : '<em style="color:#a22;">Remove from this section</em>';
    return (
      '<tr><td style="padding:14px 16px;border:1px solid #e7e3d6;background:#fdfcf8;border-radius:6px;">' +
        '<div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#9c7440;font-weight:700;margin-bottom:4px;">' + escapeHtml(it.regionName) + '</div>' +
        '<div style="font-size:14px;color:#353535;line-height:1.45;">' +
          escapeHtml(fromLabel) +
          ' <span style="color:#999;">→</span> ' +
          '<strong>' + toLabel + '</strong>' +
        '</div>' +
        (it.note ? '<div style="font-size:13px;color:#58595b;font-style:italic;margin-top:6px;">"' + escapeHtml(it.note) + '"</div>' : '') +
      '</td></tr>' +
      '<tr><td style="height:8px;"></td></tr>'
    );
  }).join('');

  return '<!DOCTYPE html>\n' +
'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Material change request</title></head>' +
'<body style="margin:0;padding:0;background:#f7f7f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f2125;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f7f4;padding:40px 20px;">' +
'<tr><td align="center">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="640" style="max-width:640px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
'<tr><td style="background:#9c7440;padding:28px 36px;">' +
'<h1 style="margin:0;color:#fff;font-size:20px;font-weight:600;">Material change request</h1>' +
'<p style="margin:6px 0 0;color:#dad7c5;font-size:13px;">From ' + escapeHtml(clientName || 'a homeowner') + (projectAddress ? ' · ' + escapeHtml(projectAddress) : '') + '</p>' +
'</td></tr>' +
'<tr><td style="padding:28px 36px 8px;">' +
(homeownerNote ? '<div style="background:#dad7c5;border-left:3px solid #9c7440;padding:14px 16px;margin-bottom:24px;border-radius:4px;font-size:14px;color:#353535;line-height:1.55;font-style:italic;">"' + escapeHtml(homeownerNote) + '"</div>' : '') +
'<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#999;font-weight:700;margin-bottom:12px;">Requested swaps (' + items.length + ')</div>' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%">' + itemsHtml + '</table>' +
'<div style="text-align:center;margin:24px 0 0;">' +
'<a href="' + escapeHtml(proposalUrl) + '" style="display:inline-block;background:#9c7440;color:#fff;text-decoration:none;padding:12px 28px;border-radius:4px;font-size:14px;font-weight:600;">View the proposal</a>' +
'</div>' +
'<p style="margin:24px 0 0;font-size:12px;color:#a0a09c;line-height:1.5;">' +
'Reply to this email to respond directly to ' + escapeHtml(clientName || 'the homeowner') + '. ' +
'After repricing, mark this request reviewed in the admin tool.' +
'</p>' +
'</td></tr>' +
'<tr><td style="padding:20px 36px;background:#f7f7f4;border-top:1px solid #e4e4df;text-align:center;">' +
'<p style="margin:0;font-size:12px;color:#70726f;">Paver Portal Builder · ' + escapeHtml(PUBLIC_BASE_URL) + '</p>' +
'</td></tr>' +
'</table></td></tr></table></body></html>';
}

function buildDesignerEmailText({ clientName, projectAddress, proposalUrl, homeownerNote, items }) {
  const lines = [
    'Material change request',
    '',
    'From: ' + (clientName || 'a homeowner') + (projectAddress ? ' (' + projectAddress + ')' : ''),
    '',
  ];
  if (homeownerNote) {
    lines.push('Note from homeowner:', '"' + homeownerNote + '"', '');
  }
  lines.push('Requested swaps (' + items.length + '):', '');
  items.forEach((it, idx) => {
    const fromLabel = (it.from.product_name || 'Material') + (it.from.color ? ' / ' + it.from.color : '');
    const toLabel = it.to ? ((it.to.product_name || 'Material') + (it.to.color ? ' / ' + it.to.color : '')) : 'REMOVE';
    lines.push((idx + 1) + '. [' + it.regionName + '] ' + fromLabel + ' -> ' + toLabel);
    if (it.note) lines.push('   "' + it.note + '"');
  });
  lines.push('', 'View the proposal: ' + proposalUrl, '');
  return lines.join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
