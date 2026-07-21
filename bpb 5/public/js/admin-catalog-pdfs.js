// ═══════════════════════════════════════════════════════════════════════════
// Admin tool: Catalog PDFs — Session 2 (real swatch extraction for Belgard)
//
// Session 1 shipped: PDF upload, list, delete, plus a 501 stub for extract.
// Session 2 ships: real swatch extraction for the Belgard PCG.
//
// Flow when "Extract swatches" is clicked on the Belgard PCG row:
//   1. Modal opens with a product picker (loaded from belgard_materials
//      grouped by product_name + pcg_page).
//   2. User picks a product → we resolve its pcg_page integer.
//   3. Browser dynamically imports pdfjs-dist from cdnjs/jsdelivr.
//   4. Browser fetches the PCG via /api/proxy-pdf?id=<pcg_uuid> (CORS-safe).
//   5. Browser renders the target page to a canvas at 1.5x scale → PNG blob.
//   6. Browser POSTs the base64 PNG to /api/extract-pdf-swatches.
//   7. CF Function calls Claude vision and returns swatch JSON with bboxes.
//   8. Browser displays the JSON and draws bounding-box rectangles over
//      the canvas so Tim can visually verify Claude found the right tiles.
//
// No DB writes this session. Session 3 adds match-or-insert + cropping.
//
// Techo-Bloc / Keystone PDFs still show the 501 placeholder when their
// Extract button is clicked — they're handled in 3B.3.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';

const MAX_FILE_BYTES = 80 * 1024 * 1024;
const RENDER_SCALE = 1.5; // 1.5× the PDF's native resolution → ~108 DPI for 72 DPI PDFs
const PDFJS_VERSION = '4.0.379';
const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/';

const state = {
  selectedFile: null,
  pdfs: [],
  uploading: false,
  loadingList: false,
  myProfile: null,

  // Extraction modal state
  belgardProducts: [],   // [{ product_name, pcg_page, sample_color }]
  pdfDocument: null,     // pdfjs document (cached after first load)
  currentPcgId: null,
  currentManufacturer: null,
  selectedProduct: null,
  extracting: false,
};

// Will be set once pdfjs is dynamically imported
let pdfjsLib = null;

// ───────────────────────────────────────────────────────────────────────────
// Bootstrap
// ───────────────────────────────────────────────────────────────────────────
init();

async function init() {
  await loadMyProfile();
  if (state.myProfile && state.myProfile.role !== 'master') {
    disableUploadForNonMaster();
  }

  wireUploadForm();
  wireDropZone();
  wireExtractModal();
  await loadPdfList();
}

async function loadMyProfile() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data, error } = await supabase
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', user.id)
      .maybeSingle();
    if (!error && data) state.myProfile = data;
  } catch (err) {
    console.error('Could not load profile:', err);
  }
}

function disableUploadForNonMaster() {
  const panel = document.getElementById('cpUploadPanel');
  panel.querySelectorAll('input, select, button').forEach(el => el.disabled = true);
  showUploadMessage(
    'Only master users can upload new catalogs. You can still view registered PDFs below.',
    'info'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Upload form (unchanged from session 1)
// ───────────────────────────────────────────────────────────────────────────
function wireUploadForm() {
  document.getElementById('cpUploadBtn').addEventListener('click', runUpload);
  document.getElementById('cpFileInput').addEventListener('change', (e) => {
    setSelectedFile(e.target.files && e.target.files[0]);
  });
  document.getElementById('cpManufacturer').addEventListener('change', refreshUploadButton);
  document.getElementById('cpPdfName').addEventListener('input', refreshUploadButton);
}

function wireDropZone() {
  const zone = document.getElementById('cpDropZone');
  ['dragenter', 'dragover'].forEach(evt => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      zone.classList.add('is-dragover');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      zone.classList.remove('is-dragover');
    });
  });
  zone.addEventListener('drop', (e) => {
    setSelectedFile(e.dataTransfer.files && e.dataTransfer.files[0]);
  });
}

function setSelectedFile(file) {
  if (!file) {
    state.selectedFile = null;
    document.getElementById('cpDropZone').classList.remove('has-file');
    document.getElementById('cpDropText').style.display = '';
    document.getElementById('cpDropFilename').style.display = 'none';
    refreshUploadButton();
    return;
  }
  if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showUploadMessage('Only PDF files are supported.', 'error');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showUploadMessage(
      `File is ${formatBytes(file.size)} — that's larger than the ${formatBytes(MAX_FILE_BYTES)} limit.`,
      'error'
    );
    return;
  }

  state.selectedFile = file;
  document.getElementById('cpDropZone').classList.add('has-file');
  document.getElementById('cpDropText').style.display = 'none';
  const fnEl = document.getElementById('cpDropFilename');
  fnEl.textContent = `${file.name} (${formatBytes(file.size)})`;
  fnEl.style.display = '';

  const nameInput = document.getElementById('cpPdfName');
  if (!nameInput.value.trim()) {
    nameInput.value = titleCase(file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim());
  }
  clearUploadMessage();
  refreshUploadButton();
}

function refreshUploadButton() {
  const manufacturer = document.getElementById('cpManufacturer').value.trim();
  const pdfName = document.getElementById('cpPdfName').value.trim();
  const valid = !!(state.selectedFile && manufacturer && pdfName);
  document.getElementById('cpUploadBtn').disabled = !valid || state.uploading;
}

async function runUpload() {
  if (state.uploading) return;
  const manufacturer = document.getElementById('cpManufacturer').value.trim();
  const pdfName = document.getElementById('cpPdfName').value.trim();
  const file = state.selectedFile;
  if (!manufacturer || !pdfName || !file) return;

  state.uploading = true;
  refreshUploadButton();
  clearUploadMessage();

  const btn = document.getElementById('cpUploadBtn');
  const originalLabel = btn.textContent;
  btn.textContent = 'Uploading…';

  const manufacturerSlug = manufacturer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const uuid = (crypto.randomUUID && crypto.randomUUID()) || ('id-' + Math.random().toString(36).slice(2));
  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const storagePath = `${manufacturerSlug}/${uuid}-${safeName}`;

  try {
    const upRes = await supabase.storage.from('catalog-pdfs').upload(storagePath, file, {
      contentType: 'application/pdf', upsert: false,
    });
    if (upRes.error) throw new Error('Storage upload failed: ' + upRes.error.message);

    const pub = supabase.storage.from('catalog-pdfs').getPublicUrl(storagePath);
    const pdfUrl = pub.data.publicUrl;

    const dbRes = await supabase.from('catalog_pdfs').insert({
      manufacturer, pdf_name: pdfName, pdf_url: pdfUrl,
      storage_path: storagePath, file_size_bytes: file.size,
      uploaded_by: state.myProfile && state.myProfile.id || null,
    }).select('id').single();

    if (dbRes.error) {
      await supabase.storage.from('catalog-pdfs').remove([storagePath]).catch(() => {});
      throw new Error('Database insert failed: ' + dbRes.error.message);
    }

    showUploadMessage(`Uploaded "${pdfName}" successfully.`, 'success');
    resetUploadForm();
    await loadPdfList();
  } catch (err) {
    showUploadMessage(err.message || 'Upload failed.', 'error');
  } finally {
    state.uploading = false;
    btn.textContent = originalLabel;
    refreshUploadButton();
  }
}

function resetUploadForm() {
  document.getElementById('cpManufacturer').value = '';
  document.getElementById('cpPdfName').value = '';
  document.getElementById('cpFileInput').value = '';
  setSelectedFile(null);
}

// ───────────────────────────────────────────────────────────────────────────
// Listing (unchanged from session 1)
// ───────────────────────────────────────────────────────────────────────────
async function loadPdfList() {
  if (state.loadingList) return;
  state.loadingList = true;

  const wrap = document.getElementById('cpTableWrap');
  wrap.innerHTML = '<div class="cp-empty">Loading…</div>';

  const { data, error } = await supabase
    .from('catalog_pdfs')
    .select('id, manufacturer, pdf_name, pdf_url, storage_path, page_count, file_size_bytes, notes, uploaded_at')
    .order('uploaded_at', { ascending: false });

  state.loadingList = false;

  if (error) {
    wrap.innerHTML = `<div class="cp-msg cp-msg-error">Could not load catalogs: ${escapeHtml(error.message)}</div>`;
    return;
  }

  state.pdfs = data || [];
  renderPdfList();
}

function renderPdfList() {
  const wrap = document.getElementById('cpTableWrap');
  if (state.pdfs.length === 0) {
    wrap.innerHTML = '<div class="cp-empty">No catalogs registered yet.</div>';
    return;
  }

  const rows = state.pdfs.map(p => {
    const isExternal = !p.storage_path;
    const sourcePill = isExternal
      ? '<span class="cp-source-pill external">External</span>'
      : '<span class="cp-source-pill uploaded">Uploaded</span>';
    const sizeText = p.file_size_bytes ? formatBytes(p.file_size_bytes) : '—';
    const pagesText = p.page_count ? `${p.page_count} pages` : '—';
    const uploadedDate = p.uploaded_at ? new Date(p.uploaded_at).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    }) : '—';

    return `
      <tr data-pdf-id="${escapeAttr(p.id)}">
        <td>
          <div class="cp-pdf-name">${escapeHtml(p.pdf_name)}</div>
          <div class="cp-pdf-meta">
            ${escapeHtml(p.manufacturer)} ·
            <a href="${escapeAttr(p.pdf_url)}" target="_blank" rel="noopener">View PDF ↗</a>
          </div>
        </td>
        <td>${sourcePill}</td>
        <td>${sizeText}</td>
        <td>${pagesText}</td>
        <td>${uploadedDate}</td>
        <td>
          <div class="cp-row-actions">
            <button class="cp-btn cp-btn-secondary cp-extract-btn"
                    data-id="${escapeAttr(p.id)}"
                    data-manufacturer="${escapeAttr(p.manufacturer)}">
              Extract swatches
            </button>
            ${isExternal ? '' : `
              <button class="cp-btn cp-btn-danger cp-delete-btn" data-id="${escapeAttr(p.id)}">
                Delete
              </button>
            `}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  wrap.innerHTML = `
    <table class="cp-table">
      <thead>
        <tr>
          <th>Catalog</th><th style="width: 100px;">Source</th>
          <th style="width: 80px;">Size</th><th style="width: 80px;">Pages</th>
          <th style="width: 110px;">Uploaded</th><th style="width: 240px;"></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  wrap.querySelectorAll('.cp-extract-btn').forEach(btn => {
    btn.addEventListener('click', () => onExtractClick(btn.dataset.id, btn.dataset.manufacturer));
  });
  wrap.querySelectorAll('.cp-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => runDelete(btn.dataset.id));
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Extract: route based on manufacturer
// ───────────────────────────────────────────────────────────────────────────
async function onExtractClick(pdfId, manufacturer) {
  const pdf = state.pdfs.find(p => p.id === pdfId);
  if (!pdf) return;

  if (manufacturer === 'Belgard') {
    // Real flow this session
    openExtractModal(pdfId, manufacturer);
  } else {
    // Other manufacturers still show the 501 placeholder this session
    alert(
      `Swatch extraction for ${manufacturer} ships in session 3.\n\n` +
      'Belgard PCG extraction is live — try that one to see the flow working.'
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Extraction modal
// ───────────────────────────────────────────────────────────────────────────
function wireExtractModal() {
  document.getElementById('cpExtractClose').addEventListener('click', closeExtractModal);
  document.getElementById('cpExtractModal').addEventListener('click', (e) => {
    if (e.target.id === 'cpExtractModal') closeExtractModal();
  });
  document.getElementById('cpProductSearch').addEventListener('input', (e) => {
    filterProductList(e.target.value.trim().toLowerCase());
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('cpExtractModal').style.display !== 'none') {
      closeExtractModal();
    }
  });
}

async function openExtractModal(pdfId, manufacturer) {
  state.currentPcgId = pdfId;
  state.currentManufacturer = manufacturer;
  state.selectedProduct = null;

  document.getElementById('cpExtractModal').style.display = 'flex';
  document.getElementById('cpProductList').innerHTML = '<div class="cp-empty">Loading products…</div>';
  setExtractStatus('Loading Belgard products from your catalog…');
  hideCanvas();
  hideJson();

  await loadBelgardProducts();
  renderProductList();
  setExtractStatus(
    `${state.belgardProducts.length} products loaded from belgard_materials. ` +
    'Pick one on the left to extract swatches from its catalog page.'
  );
}

function closeExtractModal() {
  document.getElementById('cpExtractModal').style.display = 'none';
  state.currentPcgId = null;
  state.selectedProduct = null;
  // Note: we keep state.pdfDocument cached so re-opening doesn't refetch the PCG
}

async function loadBelgardProducts() {
  // Group belgard_materials rows by (product_name, pcg_page) and pick the first sample.
  // We want the page number, the product name, and a count of color rows so the picker
  // shows useful info.
  const { data, error } = await supabase
    .from('belgard_materials')
    .select('product_name, pcg_page, color, collection')
    .not('source_pdf_url', 'is', null)
    .not('pcg_page', 'is', null)
    .order('product_name', { ascending: true });

  if (error) {
    state.belgardProducts = [];
    setExtractStatus('Could not load Belgard products: ' + error.message, 'error');
    return;
  }

  // Group: one entry per unique product_name. Track the pcg_page (assume same per product).
  const grouped = new Map();
  for (const row of data || []) {
    const key = row.product_name;
    if (!grouped.has(key)) {
      grouped.set(key, {
        product_name: row.product_name,
        pcg_page: row.pcg_page,
        collection: row.collection,
        color_count: 0,
      });
    }
    grouped.get(key).color_count++;
  }
  state.belgardProducts = Array.from(grouped.values()).sort((a, b) => {
    return a.product_name.localeCompare(b.product_name);
  });
}

function renderProductList(filter) {
  const list = document.getElementById('cpProductList');
  const filterLower = (filter || '').toLowerCase();
  const filtered = filterLower
    ? state.belgardProducts.filter(p =>
        p.product_name.toLowerCase().includes(filterLower) ||
        (p.collection || '').toLowerCase().includes(filterLower))
    : state.belgardProducts;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="cp-empty">No matches.</div>';
    return;
  }

  list.innerHTML = filtered.map(p => `
    <div class="cp-product-item ${state.selectedProduct === p.product_name ? 'is-active' : ''}"
         data-product="${escapeAttr(p.product_name)}"
         data-page="${p.pcg_page}">
      <div>${escapeHtml(p.product_name)}</div>
      <div class="cp-product-page">page ${p.pcg_page} · ${p.color_count} color${p.color_count === 1 ? '' : 's'}${p.collection ? ' · ' + escapeHtml(p.collection) : ''}</div>
    </div>
  `).join('');

  list.querySelectorAll('.cp-product-item').forEach(el => {
    el.addEventListener('click', () => {
      const product = el.dataset.product;
      const page = parseInt(el.dataset.page, 10);
      onProductPicked(product, page);
    });
  });
}

function filterProductList(query) {
  renderProductList(query);
}

async function onProductPicked(productName, pageNumber) {
  if (state.extracting) return;
  state.selectedProduct = productName;
  // Re-render so active state highlights
  renderProductList(document.getElementById('cpProductSearch').value.trim());

  state.extracting = true;
  hideJson();
  showProgress(0);
  setExtractStatus(`Loading pdfjs library…`);

  try {
    // 1. Load pdfjs from CDN if not already cached
    if (!pdfjsLib) {
      pdfjsLib = await import(PDFJS_BASE + 'pdf.min.mjs');
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.mjs';
    }

    // 2. Fetch the PDF via /api/proxy-pdf if not cached
    showProgress(15);
    if (!state.pdfDocument) {
      setExtractStatus('Fetching PCG PDF (~30 MB)… this is cached after the first load.');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Session expired. Refresh and sign in.');

      const proxyResp = await fetch('/api/proxy-pdf?id=' + encodeURIComponent(state.currentPcgId), {
        headers: { 'Authorization': 'Bearer ' + session.access_token },
      });
      if (!proxyResp.ok) {
        const err = await proxyResp.json().catch(() => ({}));
        throw new Error('Could not fetch PDF: ' + (err.error || proxyResp.status));
      }
      const pdfBytes = await proxyResp.arrayBuffer();
      showProgress(40);
      setExtractStatus('Parsing PDF…');
      state.pdfDocument = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
    }
    showProgress(55);

    // 3. Render the target page to a canvas
    if (pageNumber < 1 || pageNumber > state.pdfDocument.numPages) {
      throw new Error(`Page ${pageNumber} out of range (PDF has ${state.pdfDocument.numPages} pages)`);
    }
    setExtractStatus(`Rendering page ${pageNumber}…`);
    const page = await state.pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.getElementById('cpRenderCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;
    showCanvas();
    showProgress(70);

    // 4. Convert canvas to PNG base64
    setExtractStatus('Encoding image…');
    const pngBase64 = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
    showProgress(80);

    // 5. POST to extract function
    setExtractStatus('Sending to Claude vision…');
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Session expired. Refresh and sign in.');

    const extractResp = await fetch('/api/extract-pdf-swatches', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
      },
      body: JSON.stringify({
        image_base64: pngBase64,
        mime_type: 'image/png',
        page_number: pageNumber,
        manufacturer: state.currentManufacturer,
        product_hint: productName,
      }),
    });

    const result = await extractResp.json().catch(() => ({}));
    showProgress(100);

    if (!extractResp.ok || !result.ok) {
      throw new Error(result.error || ('HTTP ' + extractResp.status));
    }

    // 6. Display results
    showJson(result);
    drawBoundingBoxes(canvas, ctx, viewport, result.extracted.swatches || []);

    const swatchCount = (result.extracted.swatches || []).length;
    const dropped = result.dropped_swatches || 0;
    const droppedNote = dropped > 0 ? ` (${dropped} dropped due to malformed bbox)` : '';
    const usage = result.meta?.usage || {};
    const tokenNote = usage.input_tokens ? ` · ${usage.input_tokens} in / ${usage.output_tokens} out tokens` : '';
    setExtractStatus(
      `Found ${swatchCount} swatch${swatchCount === 1 ? '' : 'es'} on page ${pageNumber}${droppedNote}${tokenNote}.`,
      'success'
    );
  } catch (err) {
    setExtractStatus('Failed: ' + err.message, 'error');
    console.error(err);
  } finally {
    state.extracting = false;
    hideProgress();
  }
}

function drawBoundingBoxes(canvas, ctx, viewport, swatches) {
  // Re-render the page first to clear any prior boxes
  // (Boxes are drawn on the same canvas after rendering completes.)
  ctx.save();
  ctx.lineWidth = 3;
  ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, sans-serif';
  for (let i = 0; i < swatches.length; i++) {
    const s = swatches[i];
    const b = s.bbox;
    const x = b.x * canvas.width;
    const y = b.y * canvas.height;
    const w = b.width * canvas.width;
    const h = b.height * canvas.height;

    ctx.strokeStyle = 'rgba(93, 126, 105, 0.95)';   // Paver Portal green
    ctx.fillStyle = 'rgba(93, 126, 105, 0.15)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    // Number badge in top-left of the box
    const label = String(i + 1);
    const padding = 6;
    const labelWidth = ctx.measureText(label).width + padding * 2;
    ctx.fillStyle = 'rgba(93, 126, 105, 0.95)';
    ctx.fillRect(x, y - 24, labelWidth, 24);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + padding, y - 6);
  }
  ctx.restore();
}

// ───────────────────────────────────────────────────────────────────────────
// Delete (unchanged)
// ───────────────────────────────────────────────────────────────────────────
async function runDelete(pdfId) {
  const pdf = state.pdfs.find(p => p.id === pdfId);
  if (!pdf) return;
  if (!confirm(`Delete "${pdf.pdf_name}"?\n\nThis removes the PDF and its row. Cannot be undone.`)) return;

  const btn = document.querySelector(`.cp-delete-btn[data-id="${cssEscape(pdfId)}"]`);
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Deleting…';

  try {
    if (pdf.storage_path) {
      const stRes = await supabase.storage.from('catalog-pdfs').remove([pdf.storage_path]);
      if (stRes.error) throw new Error('Storage delete failed: ' + stRes.error.message);
    }
    const dbRes = await supabase.from('catalog_pdfs').delete().eq('id', pdfId);
    if (dbRes.error) throw new Error('Database delete failed: ' + dbRes.error.message);
    await loadPdfList();
  } catch (err) {
    alert('Delete failed: ' + (err.message || 'Network error'));
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Status / UI helpers
// ───────────────────────────────────────────────────────────────────────────
function setExtractStatus(text, kind) {
  const el = document.getElementById('cpExtractStatus');
  el.textContent = text;
  el.classList.remove('is-error', 'is-success');
  if (kind === 'error')   el.classList.add('is-error');
  if (kind === 'success') el.classList.add('is-success');
}

function showProgress(pct) {
  document.getElementById('cpExtractProgress').style.display = '';
  document.getElementById('cpExtractProgressFill').style.width = pct + '%';
}
function hideProgress() {
  document.getElementById('cpExtractProgress').style.display = 'none';
}
function showCanvas() { document.getElementById('cpCanvasWrap').style.display = ''; }
function hideCanvas() { document.getElementById('cpCanvasWrap').style.display = 'none'; }
function showJson(payload) {
  const el = document.getElementById('cpJsonOutput');
  el.textContent = JSON.stringify(payload, null, 2);
  el.style.display = '';
}
function hideJson() { document.getElementById('cpJsonOutput').style.display = 'none'; }

function showUploadMessage(text, kind) {
  const el = document.getElementById('cpUploadMsg');
  const klass = kind === 'success' ? 'cp-msg-success' : kind === 'info' ? 'cp-msg-info' : 'cp-msg-error';
  el.innerHTML = `<div class="cp-msg ${klass}">${escapeHtml(text)}</div>`;
}
function clearUploadMessage() { document.getElementById('cpUploadMsg').innerHTML = ''; }

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function titleCase(s) {
  if (!s) return s;
  return s.split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(' ');
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(str) { return escapeHtml(str); }

function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ');
}
