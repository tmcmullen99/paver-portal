// Redesign markup tool for /account/v2/
// Opens via window.openRedesignModal(proposalId, clientId, proposalAddress)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL  = 'https://gfgbypcnxkschnfsitfb.supabase.co';
const SUPABASE_ANON = 'sb_publishable_Ko4LNw2VjhZVFmwJ-i2qtA_XeGgBcew';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

let CURRENT_PROPOSAL_ID = null;
let CURRENT_CLIENT_ID = null;
let SITEMAP = null;            // { source_png_url, width, height }
let PATHS = [];                // [[{x,y},{x,y},...], ...]
let CURRENT_PATH = null;
let PHOTO_FILE = null;

function injectStyles() {
  if (document.getElementById('vr-styles')) return;
  const css = document.createElement('style');
  css.id = 'vr-styles';
  css.textContent = `
    .vr-modal { position: fixed; inset: 0; background: rgba(20,24,22,.55); display: flex; align-items: flex-start; justify-content: center; z-index: 1200; padding: 24px 16px; overflow-y: auto; }
    .vr-dialog { background: #fff; border-radius: 14px; max-width: 860px; width: 100%; box-shadow: 0 24px 64px rgba(0,0,0,.32); margin: auto; display: flex; flex-direction: column; max-height: calc(100vh - 48px); }
    .vr-head { padding: 22px 28px 16px; border-bottom: 1px solid var(--bp-border); display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-shrink: 0; }
    .vr-head h2 { font-size: 20px; font-weight: 600; letter-spacing: -.012em; color: var(--bp-text); }
    .vr-head-eyebrow { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--bp-green-dk); font-weight: 700; margin-bottom: 4px; }
    .vr-head-close { background: none; border: none; font-size: 22px; cursor: pointer; color: var(--bp-muted); width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; }
    .vr-head-close:hover { background: var(--bp-cream); color: var(--bp-charcoal); }
    .vr-body { padding: 20px 28px; overflow-y: auto; flex: 1; }
    .vr-intro { font-size: 13px; color: var(--bp-muted); line-height: 1.6; margin-bottom: 16px; }
    .vr-tools { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .vr-tool-btn { padding: 7px 13px; border-radius: 8px; background: #fff; border: 1px solid var(--bp-border); color: var(--bp-charcoal); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: background .15s, border-color .15s, color .15s; }
    .vr-tool-btn:hover { background: var(--bp-cream); border-color: var(--bp-green); color: var(--bp-green-dk); }
    .vr-canvas-wrap { position: relative; background: var(--bp-cream); border-radius: 10px; overflow: hidden; border: 1px solid var(--bp-border); user-select: none; touch-action: none; }
    .vr-canvas-img { display: block; width: 100%; height: auto; pointer-events: none; }
    .vr-canvas-svg { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; }
    .vr-canvas-empty { padding: 60px 24px; text-align: center; color: var(--bp-muted); font-size: 13px; }
    .vr-canvas-empty input[type="file"] { display: none; }
    .vr-canvas-empty label { display: inline-block; padding: 10px 18px; border-radius: 8px; background: var(--bp-green); color: #fff; cursor: pointer; font-size: 13px; font-weight: 600; margin-top: 12px; }
    .vr-canvas-empty label:hover { background: var(--bp-green-dk); }
    .vr-field-row { margin-top: 16px; }
    .vr-field-label { display: block; font-size: 12px; font-weight: 600; color: var(--bp-charcoal); margin-bottom: 4px; }
    .vr-field-note { width: 100%; padding: 10px 12px; border: 1px solid var(--bp-border); border-radius: 8px; font: inherit; font-size: 13px; resize: vertical; }
    .vr-photo-row { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: var(--bp-cream); border-radius: 8px; }
    .vr-photo-info { font-size: 12px; color: var(--bp-muted); flex: 1; }
    .vr-photo-info strong { color: var(--bp-text); display: block; font-size: 13px; }
    .vr-photo-btn { padding: 8px 14px; border-radius: 8px; background: #fff; border: 1px solid var(--bp-border); color: var(--bp-charcoal); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
    .vr-photo-btn:hover { background: #fff; border-color: var(--bp-green); color: var(--bp-green-dk); }
    .vr-foot { padding: 16px 28px 22px; border-top: 1px solid var(--bp-border); flex-shrink: 0; display: flex; justify-content: flex-end; gap: 8px; }
    .vr-err { background: #fef2f2; color: var(--bp-err); border: 1px solid #fecaca; border-radius: 8px; padding: 10px 14px; font-size: 12px; margin-bottom: 12px; display: none; }
    .vr-success { padding: 48px 24px; text-align: center; }
    .vr-success-icon { font-size: 48px; margin-bottom: 12px; }
    .vr-success h3 { font-size: 18px; font-weight: 600; color: var(--bp-text); margin-bottom: 6px; }
    .vr-success p { font-size: 13px; color: var(--bp-muted); }
  `;
  document.head.appendChild(css);
}

async function loadSitemap(proposalId) {
  const { data } = await supabase
    .from('proposal_sitemaps')
    .select('source_png_url')
    .eq('proposal_id', proposalId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data && data.source_png_url ? { source_png_url: data.source_png_url } : null;
}

function renderCanvas(container) {
  if (!SITEMAP || !SITEMAP.source_png_url) {
    container.innerHTML = `
      <div class="vr-canvas-empty">
        <div style="font-size:36px;">📐</div>
        <div style="margin-top:8px;">No site plan found for this proposal yet.</div>
        <label>📷 Upload a photo of your plan to mark up
          <input type="file" accept="image/*" id="vr-upload-bg">
        </label>
      </div>`;
    container.querySelector('#vr-upload-bg').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      SITEMAP = { source_png_url: url, _localBlob: file };
      renderCanvas(container);
    });
    return;
  }

  container.innerHTML = `
    <img class="vr-canvas-img" src="${escapeAttr(SITEMAP.source_png_url)}" alt="Site plan" id="vr-bg-img">
    <svg class="vr-canvas-svg" id="vr-svg" preserveAspectRatio="none"></svg>
  `;
  const img = container.querySelector('#vr-bg-img');
  const svg = container.querySelector('#vr-svg');
  img.addEventListener('load', () => {
    SITEMAP.width = img.naturalWidth;
    SITEMAP.height = img.naturalHeight;
    svg.setAttribute('viewBox', `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
    redrawPaths();
  });
  if (img.complete) img.dispatchEvent(new Event('load'));

  const start = (e) => {
    e.preventDefault();
    const pt = getPt(e, svg);
    CURRENT_PATH = [pt];
    PATHS.push(CURRENT_PATH);
    redrawPaths();
  };
  const move = (e) => {
    if (!CURRENT_PATH) return;
    e.preventDefault();
    const pt = getPt(e, svg);
    CURRENT_PATH.push(pt);
    redrawPaths();
  };
  const end = () => { CURRENT_PATH = null; };
  svg.addEventListener('pointerdown', start);
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('pointerleave', end);
}

function getPt(e, svg) {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return {
    x: (e.clientX - rect.left) / rect.width * vb.width,
    y: (e.clientY - rect.top) / rect.height * vb.height,
  };
}

function redrawPaths() {
  const svg = document.getElementById('vr-svg');
  if (!svg) return;
  const d = PATHS.map(pts => {
    if (pts.length < 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[0].x} ${pts[0].y}`;
    return `M ${pts[0].x} ${pts[0].y} ` + pts.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ');
  }).join(' ');
  const w = Math.max(2, (SITEMAP?.width || 800) / 200);
  svg.innerHTML = `<path d="${d}" stroke="#e11d48" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function buildMarkupSvg() {
  if (!SITEMAP || !SITEMAP.width) return null;
  const w = Math.max(2, SITEMAP.width / 200);
  const d = PATHS.map(pts => {
    if (pts.length < 2) return '';
    return `M ${pts[0].x} ${pts[0].y} ` + pts.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ');
  }).filter(Boolean).join(' ');
  if (!d) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SITEMAP.width} ${SITEMAP.height}"><path d="${d}" stroke="#e11d48" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

async function submit() {
  const errEl = document.getElementById('vr-err');
  const submitBtn = document.getElementById('vr-submit');
  const note = (document.getElementById('vr-note')?.value || '').trim();
  errEl.style.display = 'none';
  const markup = buildMarkupSvg();
  if (!markup && !note && !PHOTO_FILE) {
    errEl.textContent = 'Add some markup on the plan, a note, or a photo before sending.';
    errEl.style.display = 'block';
    return;
  }
  submitBtn.disabled = true; submitBtn.textContent = 'Sending…';
  try {
    let photoUrl = null;
    if (PHOTO_FILE) {
      const ext = (PHOTO_FILE.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${CURRENT_CLIENT_ID}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('client-redesign-uploads').upload(path, PHOTO_FILE, { contentType: PHOTO_FILE.type });
      if (upErr) throw upErr;
      const { data: { publicUrl } } = supabase.storage.from('client-redesign-uploads').getPublicUrl(path);
      photoUrl = publicUrl;
    }
    const payload = {
      proposal_id: CURRENT_PROPOSAL_ID,
      client_id: CURRENT_CLIENT_ID,
      status: 'pending',
      homeowner_note: note || null,
      markup_svg: markup,
      photo_url: photoUrl,
      site_map_url_at_submit: SITEMAP?.source_png_url && !SITEMAP._localBlob ? SITEMAP.source_png_url : null,
      site_map_width_at_submit: SITEMAP?.width || null,
      site_map_height_at_submit: SITEMAP?.height || null,
    };
    const { error: insErr } = await supabase.from('proposal_redesign_requests').insert(payload);
    if (insErr) throw insErr;
    showSuccess();
    PATHS = []; PHOTO_FILE = null;
  } catch (e) {
    console.error(e);
    errEl.textContent = e.message || 'Could not send your redesign request.';
    errEl.style.display = 'block';
    submitBtn.disabled = false; submitBtn.textContent = 'Send redesign request';
  }
}

function showSuccess() {
  const body = document.querySelector('.vr-body');
  const foot = document.querySelector('.vr-foot');
  if (foot) foot.remove();
  if (body) body.innerHTML = `
    <div class="vr-success">
      <div class="vr-success-icon">✏️</div>
      <h3>Redesign request sent</h3>
      <p>Your designer has the markup and will respond with revisions within one business day.</p>
      <button class="v2-btn v2-btn-primary" id="vr-close-after" style="margin-top:18px;padding:10px 22px;">Close</button>
    </div>`;
  document.getElementById('vr-close-after')?.addEventListener('click', closeModal);
  window.dispatchEvent(new CustomEvent('v2-redesign-saved'));
}

function closeModal() {
  const m = document.querySelector('.vr-modal');
  if (m) m.remove();
  document.body.style.overflow = '';
  PATHS = []; CURRENT_PATH = null; PHOTO_FILE = null; SITEMAP = null;
}

window.openRedesignModal = async function(proposalId, clientId, proposalAddress) {
  CURRENT_PROPOSAL_ID = proposalId;
  CURRENT_CLIENT_ID = clientId;
  PATHS = []; PHOTO_FILE = null;
  injectStyles();

  const modal = document.createElement('div');
  modal.className = 'vr-modal';
  modal.innerHTML = `
    <div class="vr-dialog">
      <div class="vr-head">
        <div>
          <div class="vr-head-eyebrow">Request a redesign</div>
          <h2>${escapeHtml(proposalAddress || 'Your project')}</h2>
        </div>
        <button type="button" class="vr-head-close" aria-label="Close">✕</button>
      </div>
      <div class="vr-body">
        <div class="vr-intro">Draw on your plan to show your designer exactly what you want changed — circle areas, draw arrows, sketch new features. Add a note explaining the change. Optionally attach a reference photo.</div>
        <div class="vr-tools">
          <span style="font-size:11px;color:var(--bp-muted);font-weight:700;letter-spacing:.14em;text-transform:uppercase;">Markup:</span>
          <button class="vr-tool-btn" type="button" id="vr-undo">↶ Undo</button>
          <button class="vr-tool-btn" type="button" id="vr-clear">Clear all</button>
        </div>
        <div class="vr-canvas-wrap" id="vr-canvas"></div>
        <div class="vr-field-row">
          <label class="vr-field-label" for="vr-note">What would you like changed?</label>
          <textarea class="vr-field-note" id="vr-note" rows="3" placeholder="Move the fire pit closer to the patio. Add a step where I circled."></textarea>
        </div>
        <div class="vr-field-row">
          <label class="vr-field-label">Reference photo <span style="font-weight:400;color:var(--bp-muted);">(optional)</span></label>
          <div class="vr-photo-row">
            <div class="vr-photo-info" id="vr-photo-info"><strong>No photo attached</strong>Add a photo of an example, your yard, or a sketch</div>
            <input type="file" accept="image/*" id="vr-photo-input" style="display:none;">
            <button class="vr-photo-btn" type="button" id="vr-photo-pick">📷 Choose photo</button>
          </div>
        </div>
        <div class="vr-err" id="vr-err" style="margin-top:14px;"></div>
      </div>
      <div class="vr-foot">
        <button type="button" class="v2-btn v2-btn-ghost" id="vr-cancel" style="padding:10px 18px;">Cancel</button>
        <button type="button" class="v2-btn v2-btn-primary" id="vr-submit" style="padding:10px 22px;">Send redesign request</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';
  modal.querySelector('.vr-head-close').addEventListener('click', closeModal);
  modal.querySelector('#vr-cancel').addEventListener('click', closeModal);
  modal.querySelector('#vr-submit').addEventListener('click', submit);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  modal.querySelector('#vr-undo').addEventListener('click', () => { PATHS.pop(); redrawPaths(); });
  modal.querySelector('#vr-clear').addEventListener('click', () => { PATHS = []; redrawPaths(); });
  modal.querySelector('#vr-photo-pick').addEventListener('click', () => modal.querySelector('#vr-photo-input').click());
  modal.querySelector('#vr-photo-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    PHOTO_FILE = file;
    modal.querySelector('#vr-photo-info').innerHTML = `<strong>${escapeHtml(file.name)}</strong>${(file.size/1024).toFixed(0)} KB · ready to send`;
  });

  try {
    SITEMAP = await loadSitemap(proposalId);
    renderCanvas(modal.querySelector('#vr-canvas'));
  } catch (e) {
    console.error(e);
    renderCanvas(modal.querySelector('#vr-canvas')); // fall back to upload-your-own
  }
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
