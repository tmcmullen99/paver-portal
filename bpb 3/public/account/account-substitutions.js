// Material substitution modal for /account/v2/
// Opens via window.openSubstitutionModal(proposalId, clientId)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL  = 'https://gfgbypcnxkschnfsitfb.supabase.co';
const SUPABASE_ANON = 'sb_publishable_Ko4LNw2VjhZVFmwJ-i2qtA_XeGgBcew';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const PENDING = new Map();  // proposal_region_material_id -> { region, current, replacement }
let CURRENT_PROPOSAL_ID = null;
let CURRENT_CLIENT_ID = null;
let ROWS = [];
let MATERIALS_BY_CAT = new Map();

function injectStyles() {
  if (document.getElementById('vs-styles')) return;
  const css = document.createElement('style');
  css.id = 'vs-styles';
  css.textContent = `
    .vs-modal { position: fixed; inset: 0; background: rgba(20,24,22,.55); display: flex; align-items: flex-start; justify-content: center; z-index: 1200; padding: 24px 16px; overflow-y: auto; }
    .vs-dialog { background: #fff; border-radius: 14px; max-width: 880px; width: 100%; box-shadow: 0 24px 64px rgba(0,0,0,.32); margin: auto; display: flex; flex-direction: column; max-height: calc(100vh - 48px); }
    .vs-head { padding: 22px 28px 16px; border-bottom: 1px solid var(--bp-border); display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-shrink: 0; }
    .vs-head-info { flex: 1; min-width: 0; }
    .vs-head-eyebrow { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--bp-green-dk); font-weight: 700; margin-bottom: 4px; }
    .vs-head h2 { font-size: 20px; font-weight: 600; letter-spacing: -.012em; color: var(--bp-text); }
    .vs-head-close { background: none; border: none; font-size: 22px; cursor: pointer; color: var(--bp-muted); width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; }
    .vs-head-close:hover { background: var(--bp-cream); color: var(--bp-charcoal); }
    .vs-body { padding: 20px 28px; overflow-y: auto; flex: 1; }
    .vs-intro { font-size: 13px; color: var(--bp-muted); line-height: 1.6; margin-bottom: 18px; }
    .vs-row { border: 1px solid var(--bp-border); border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; transition: border-color .15s; }
    .vs-row.has-swap { border-color: var(--bp-green); background: #f7faf8; }
    .vs-row-head { display: flex; gap: 12px; align-items: center; }
    .vs-row-img { width: 56px; height: 56px; border-radius: 8px; background: var(--bp-cream); flex-shrink: 0; object-fit: cover; overflow: hidden; }
    .vs-row-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .vs-row-info { flex: 1; min-width: 0; }
    .vs-row-region { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--bp-muted); font-weight: 700; }
    .vs-row-name { font-size: 14px; font-weight: 600; color: var(--bp-text); line-height: 1.3; margin: 2px 0; }
    .vs-row-meta { font-size: 11px; color: var(--bp-muted); }
    .vs-row-toggle { padding: 8px 14px; border-radius: 8px; background: #fff; border: 1px solid var(--bp-border); color: var(--bp-charcoal); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: background .15s, border-color .15s, color .15s; flex-shrink: 0; }
    .vs-row-toggle:hover { background: var(--bp-cream); border-color: var(--bp-green); color: var(--bp-green-dk); }
    .vs-row.has-swap .vs-row-toggle { background: var(--bp-green); border-color: var(--bp-green); color: #fff; }
    .vs-row-expand { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--bp-border); display: none; }
    .vs-row.is-open .vs-row-expand { display: block; }
    .vs-alt-label { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--bp-muted); font-weight: 700; margin-bottom: 10px; }
    .vs-alt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
    .vs-alt {
      border: 1px solid var(--bp-border); border-radius: 8px;
      cursor: pointer; overflow: hidden; background: #fff;
      transition: border-color .15s, transform .15s;
    }
    .vs-alt:hover { border-color: var(--bp-green); transform: translateY(-1px); }
    .vs-alt.is-selected { border-color: var(--bp-green); box-shadow: 0 0 0 2px var(--bp-green); }
    .vs-alt-img { aspect-ratio: 1/1; background: var(--bp-cream); }
    .vs-alt-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .vs-alt-info { padding: 6px 8px 8px; }
    .vs-alt-mfr { font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--bp-green-dk); font-weight: 700; }
    .vs-alt-name { font-size: 11px; font-weight: 600; color: var(--bp-text); line-height: 1.3; margin-top: 2px; }
    .vs-empty { padding: 32px; text-align: center; color: var(--bp-muted); font-size: 13px; background: var(--bp-cream); border-radius: 10px; }
    .vs-foot { padding: 16px 28px 22px; border-top: 1px solid var(--bp-border); flex-shrink: 0; }
    .vs-note { width: 100%; padding: 10px 12px; border: 1px solid var(--bp-border); border-radius: 8px; font: inherit; font-size: 13px; resize: vertical; margin-bottom: 14px; }
    .vs-foot-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .vs-pending-count { font-size: 12px; color: var(--bp-muted); }
    .vs-pending-count strong { color: var(--bp-green-dk); }
    .vs-actions { display: flex; gap: 8px; }
    .vs-err { background: #fef2f2; color: var(--bp-err); border: 1px solid #fecaca; border-radius: 8px; padding: 10px 14px; font-size: 12px; margin-bottom: 12px; display: none; }
    .vs-success { padding: 48px 24px; text-align: center; }
    .vs-success-icon { font-size: 48px; margin-bottom: 12px; }
    .vs-success h3 { font-size: 18px; font-weight: 600; color: var(--bp-text); margin-bottom: 6px; }
    .vs-success p { font-size: 13px; color: var(--bp-muted); }
  `;
  document.head.appendChild(css);
}

async function loadRows(proposalId) {
  const { data: regions, error: rErr } = await supabase
    .from('proposal_regions')
    .select('id, name, display_order, proposal_material_id, proposal_id')
    .eq('proposal_id', proposalId)
    .order('display_order');
  if (rErr) throw rErr;
  if (!regions || regions.length === 0) return [];

  const { data: rms } = await supabase
    .from('proposal_region_materials')
    .select('id, region_id, proposal_material_id, display_order')
    .in('region_id', regions.map(r => r.id))
    .order('display_order');

  const allPmIds = [
    ...new Set([
      ...regions.map(r => r.proposal_material_id).filter(Boolean),
      ...(rms || []).map(rm => rm.proposal_material_id).filter(Boolean),
    ]),
  ];
  const { data: pms } = await supabase
    .from('proposal_materials')
    .select('id, material_id, override_product_name, override_color')
    .in('id', allPmIds);

  const matIds = [...new Set((pms || []).map(p => p.material_id).filter(Boolean))];
  const { data: mats } = await supabase
    .from('materials')
    .select('id, manufacturer, product_name, color, category, primary_image_url, swatch_url')
    .in('id', matIds.length ? matIds : ['00000000-0000-0000-0000-000000000000']);

  const matsById = new Map((mats || []).map(m => [m.id, m]));
  const pmsById  = new Map((pms || []).map(p => [p.id, p]));
  const regById  = new Map(regions.map(r => [r.id, r]));

  const rows = (rms || []).map(rm => {
    const reg = regById.get(rm.region_id);
    const pm  = pmsById.get(rm.proposal_material_id);
    const mat = pm ? matsById.get(pm.material_id) : null;
    return { rmId: rm.id, region: reg, pm, mat };
  }).filter(r => r.region && r.mat);  // skip rows without a master material match
  return rows;
}

async function loadAlternatives(categories) {
  if (!categories.length) return;
  const missing = categories.filter(c => !MATERIALS_BY_CAT.has(c));
  if (!missing.length) return;
  const { data } = await supabase
    .from('materials')
    .select('id, manufacturer, product_name, color, category, primary_image_url, swatch_url')
    .in('category', missing)
    .order('manufacturer')
    .order('product_name');
  missing.forEach(c => MATERIALS_BY_CAT.set(c, []));
  (data || []).forEach(m => {
    const arr = MATERIALS_BY_CAT.get(m.category) || [];
    arr.push(m);
    MATERIALS_BY_CAT.set(m.category, arr);
  });
}

function renderBody(bodyEl) {
  if (!ROWS.length) {
    bodyEl.innerHTML = `
      <div class="vs-empty">
        <div style="font-size:36px;margin-bottom:8px;">🧱</div>
        This proposal doesn't have any swappable materials assigned to regions yet.
        <div style="font-size:11px;margin-top:8px;">Your designer adds region-level materials before substitutions become available.</div>
      </div>`;
    return;
  }
  bodyEl.innerHTML = `
    <div class="vs-intro">Pick any zone below to see alternative materials from the same category. When you're done, click <strong>Send swap request</strong> and your designer will reprice and confirm.</div>
    <div id="vs-rows"></div>
  `;
  const rowsEl = document.getElementById('vs-rows');
  rowsEl.innerHTML = ROWS.map(renderRow).join('');
  rowsEl.querySelectorAll('.vs-row-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      const row = e.target.closest('.vs-row');
      const isOpen = row.classList.toggle('is-open');
      if (isOpen) loadRowAlternatives(row);
    });
  });
}

function renderRow(r) {
  const img = r.mat.primary_image_url || r.mat.swatch_url || '';
  const swap = PENDING.get(r.rmId);
  return `
    <div class="vs-row${swap ? ' has-swap' : ''}" data-rmid="${escapeAttr(r.rmId)}" data-cat="${escapeAttr(r.mat.category || '')}">
      <div class="vs-row-head">
        <div class="vs-row-img">${img ? `<img src="${escapeAttr(img)}" alt="">` : ''}</div>
        <div class="vs-row-info">
          <div class="vs-row-region">${escapeHtml(r.region.name || 'Zone')}</div>
          <div class="vs-row-name">${swap ? '→ ' + escapeHtml(swap.replacement.product_name) : escapeHtml(r.mat.product_name)}</div>
          <div class="vs-row-meta">${swap ? 'Swap from ' + escapeHtml(r.mat.product_name) : escapeHtml([r.mat.manufacturer, r.mat.color].filter(Boolean).join(' · '))}</div>
        </div>
        <button class="vs-row-toggle" type="button">${swap ? '✓ Swap picked' : 'Change'}</button>
      </div>
      <div class="vs-row-expand"></div>
    </div>`;
}

async function loadRowAlternatives(rowEl) {
  const cat = rowEl.dataset.cat;
  const rmId = rowEl.dataset.rmid;
  const expand = rowEl.querySelector('.vs-row-expand');
  if (expand.dataset.loaded === '1') return;
  expand.innerHTML = `<div class="vs-alt-label">Loading alternatives…</div>`;
  await loadAlternatives([cat]);
  const alts = (MATERIALS_BY_CAT.get(cat) || []).filter(m => m.id !== ROWS.find(r => r.rmId === rmId).mat.id);
  const picked = PENDING.get(rmId);
  expand.innerHTML = `
    <div class="vs-alt-label">Choose a replacement from the ${escapeHtml(cat)} catalog</div>
    ${alts.length ? `<div class="vs-alt-grid">${alts.map(m => `
      <div class="vs-alt${picked && picked.replacement.id === m.id ? ' is-selected' : ''}" data-altid="${escapeAttr(m.id)}">
        <div class="vs-alt-img">${m.primary_image_url || m.swatch_url ? `<img src="${escapeAttr(m.primary_image_url || m.swatch_url)}" alt="">` : ''}</div>
        <div class="vs-alt-info">
          <div class="vs-alt-mfr">${escapeHtml(m.manufacturer || '')}</div>
          <div class="vs-alt-name">${escapeHtml(m.product_name || '')}</div>
        </div>
      </div>`).join('')}</div>
      ${picked ? `<button class="vs-row-toggle" type="button" data-clear="${escapeAttr(rmId)}" style="margin-top:10px;">Remove swap</button>` : ''}
    ` : `<div class="vs-empty" style="padding:16px;">No alternatives in this category.</div>`}
  `;
  expand.dataset.loaded = '1';
  expand.querySelectorAll('.vs-alt').forEach(a => {
    a.addEventListener('click', () => {
      const altId = a.dataset.altid;
      const replacement = alts.find(x => x.id === altId);
      const row = ROWS.find(r => r.rmId === rmId);
      PENDING.set(rmId, { region: row.region, current: row.mat, replacement });
      updateRowMarkup(rowEl, rmId);
      updateFooter();
    });
  });
  expand.querySelector('[data-clear]')?.addEventListener('click', () => {
    PENDING.delete(rmId);
    expand.dataset.loaded = ''; // refresh
    rowEl.classList.remove('is-open');
    updateRowMarkup(rowEl, rmId);
    updateFooter();
  });
}

function updateRowMarkup(rowEl, rmId) {
  const r = ROWS.find(x => x.rmId === rmId);
  const newEl = document.createElement('div');
  newEl.innerHTML = renderRow(r);
  const fresh = newEl.firstElementChild;
  if (rowEl.classList.contains('is-open')) fresh.classList.add('is-open');
  fresh.querySelector('.vs-row-expand').innerHTML = rowEl.querySelector('.vs-row-expand').innerHTML;
  fresh.querySelector('.vs-row-expand').dataset.loaded = rowEl.querySelector('.vs-row-expand').dataset.loaded;
  rowEl.replaceWith(fresh);
  fresh.querySelector('.vs-row-toggle').addEventListener('click', () => {
    const isOpen = fresh.classList.toggle('is-open');
    if (isOpen) loadRowAlternatives(fresh);
  });
  fresh.querySelectorAll('.vs-alt').forEach(a => {
    a.addEventListener('click', () => {
      const altId = a.dataset.altid;
      loadRowAlternatives(fresh); // reload to pick fresh
    });
  });
}

function updateFooter() {
  const count = PENDING.size;
  const countEl = document.getElementById('vs-pending-count');
  const submitBtn = document.getElementById('vs-submit');
  if (countEl) countEl.innerHTML = count === 0 ? 'No swaps picked yet.' : `<strong>${count}</strong> ${count === 1 ? 'swap' : 'swaps'} ready to send.`;
  if (submitBtn) submitBtn.disabled = count === 0;
}

async function submit() {
  const errEl = document.getElementById('vs-err');
  const submitBtn = document.getElementById('vs-submit');
  const note = (document.getElementById('vs-note')?.value || '').trim();
  errEl.style.display = 'none';
  submitBtn.disabled = true; submitBtn.textContent = 'Sending…';
  try {
    const { data: sub, error: sErr } = await supabase
      .from('proposal_substitutions')
      .insert({
        proposal_id: CURRENT_PROPOSAL_ID,
        client_id: CURRENT_CLIENT_ID,
        homeowner_note: note || null,
        status: 'pending',
      })
      .select()
      .single();
    if (sErr) throw sErr;
    const items = Array.from(PENDING.entries()).map(([rmId, swap]) => ({
      substitution_id: sub.id,
      proposal_region_material_id: rmId,
      replacement_material_id: swap.replacement.id,
    }));
    const { error: iErr } = await supabase.from('proposal_substitution_items').insert(items);
    if (iErr) throw iErr;
    showSuccess();
    PENDING.clear();
  } catch (e) {
    console.error(e);
    errEl.textContent = e.message || 'Could not save your swap request.';
    errEl.style.display = 'block';
    submitBtn.disabled = false; submitBtn.textContent = 'Send swap request';
  }
}

function showSuccess() {
  const body = document.querySelector('.vs-body');
  const foot = document.querySelector('.vs-foot');
  if (foot) foot.remove();
  if (body) body.innerHTML = `
    <div class="vs-success">
      <div class="vs-success-icon">✅</div>
      <h3>Swap request sent</h3>
      <p>Your designer has been notified and will reprice your proposal within one business day.</p>
      <button class="v2-btn v2-btn-primary" id="vs-close-after" style="margin-top:18px;padding:10px 22px;">Close</button>
    </div>`;
  document.getElementById('vs-close-after')?.addEventListener('click', closeModal);
  // notify caller so it can refresh request history
  window.dispatchEvent(new CustomEvent('v2-substitution-saved'));
}

function closeModal() {
  const m = document.querySelector('.vs-modal');
  if (m) m.remove();
  document.body.style.overflow = '';
  PENDING.clear();
}

window.openSubstitutionModal = async function(proposalId, clientId, proposalAddress) {
  CURRENT_PROPOSAL_ID = proposalId;
  CURRENT_CLIENT_ID = clientId;
  injectStyles();

  const modal = document.createElement('div');
  modal.className = 'vs-modal';
  modal.innerHTML = `
    <div class="vs-dialog">
      <div class="vs-head">
        <div class="vs-head-info">
          <div class="vs-head-eyebrow">Change materials</div>
          <h2>${escapeHtml(proposalAddress || 'Your project')}</h2>
        </div>
        <button type="button" class="vs-head-close" aria-label="Close">✕</button>
      </div>
      <div class="vs-body"><div style="padding:36px;text-align:center;color:var(--bp-muted);font-size:13px;">Loading regions…</div></div>
      <div class="vs-foot">
        <div class="vs-err" id="vs-err"></div>
        <textarea class="vs-note" id="vs-note" rows="2" placeholder="Optional note for your designer..."></textarea>
        <div class="vs-foot-row">
          <div class="vs-pending-count" id="vs-pending-count">No swaps picked yet.</div>
          <div class="vs-actions">
            <button type="button" class="v2-btn v2-btn-ghost" id="vs-cancel" style="padding:10px 18px;">Cancel</button>
            <button type="button" class="v2-btn v2-btn-primary" id="vs-submit" style="padding:10px 22px;" disabled>Send swap request</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';
  modal.querySelector('.vs-head-close').addEventListener('click', closeModal);
  modal.querySelector('#vs-cancel').addEventListener('click', closeModal);
  modal.querySelector('#vs-submit').addEventListener('click', submit);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  try {
    ROWS = await loadRows(proposalId);
    const bodyEl = modal.querySelector('.vs-body');
    renderBody(bodyEl);
  } catch (e) {
    console.error(e);
    modal.querySelector('.vs-body').innerHTML = `<div class="vs-empty" style="color:var(--bp-err);">Could not load proposal regions: ${escapeHtml(e.message || '')}</div>`;
  }
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
