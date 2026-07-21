// ═══════════════════════════════════════════════════════════════════════════
// Bid PDF section (Phase 1.5 Sprint 1).
//
// On upload: runs TWO pipelines in parallel
//   1. POST the PDF to /api/parse-bid-pdf (existing — Claude API extracts
//      client info, scope sections, line items, totals, materials).
//   2. Client-side, pdfjs-dist walks every page and extracts every embedded
//      raster image (logos, renderings, product photos). Duplicates are
//      collapsed by SHA-1 hash of the decoded pixels.
//
// While parsing, the UI shows dual progress: "Extracting image 5 of 12…" for
// the visual pipeline alongside the text-parse spinner.
//
// On review: thumbnail strip of everything extracted (blob URLs — not yet
// uploaded). Tim confirms what came out before committing.
//
// On commit:
//   a. Update proposals row with parsed client info + totals (existing)
//   b. Replace proposal_sections rows (existing)
//   c. Wipe any previous bid_pdf_extract images from Storage + DB
//   d. Resize each extracted image to 2400px main + 400px thumb (same pipeline
//      photos.js uses) and upload to Storage
//   e. Insert proposal_images rows with extraction_source='bid_pdf_extract':
//        • images with area >= 400x400 = category='property_condition'
//          (appear in Photos list + hero picker)
//        • smaller images = category='bid_pdf_asset'
//          (stored for future catalog backfill, hidden from UI)
//   f. Auto-pick hero: largest image >= 800x600 becomes proposals.hero_image_url.
//      Tim can change it later via the hero picker in Section 06.
//
// Re-upload wipes previously-extracted images entirely (Storage + DB rows)
// before re-extracting, so a second bid PDF doesn't duplicate assets.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';

// pdfjs-dist is loaded on demand from cdnjs the first time Tim uploads a PDF.
const PDFJS_VERSION = '4.0.379';
const PDFJS_MJS = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

const BUCKET = 'proposal-photos';
const MAX_DIMENSION = 2400;
const THUMB_DIMENSION = 400;
const JPEG_QUALITY = 0.85;
const PROPERTY_MIN_AREA = 400 * 400;   // 160,000 px²: below this = hidden asset
const HERO_MIN_WIDTH = 800;
const HERO_MIN_HEIGHT = 600;

let pdfjsLib = null;  // cached after first load

const state = {
  proposalId: null,
  container: null,
  onSave: null,
  phase: 'empty',              // empty | parsing | review | committed | error
  parsed: null,                // from /api/parse-bid-pdf
  extracted: [],               // array of { blob, blobUrl, width, height, sourcePage, hash }
  parseProgress: null,         // { done: int, total: int } while extracting
  error: null,
  editedClient: {}
};

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────
export async function initBidPdf({ proposalId, container, onSave }) {
  Object.assign(state, {
    proposalId,
    container,
    onSave,
    phase: 'empty',
    parsed: null,
    extracted: [],
    parseProgress: null,
    error: null,
    editedClient: {}
  });

  container.innerHTML = `<div class="mp-loading">Loading…</div>`;

  const { data: proposal } = await supabase
    .from('proposals')
    .select('parsed_bid_data')
    .eq('id', proposalId)
    .single();

  if (proposal?.parsed_bid_data) {
    state.parsed = proposal.parsed_bid_data;
    state.phase = 'committed';
  }

  render();
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering
// ───────────────────────────────────────────────────────────────────────────
function render() {
  state.container.innerHTML = `
    <style>
      .bp-extracted-strip {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 12px;
        margin-top: 12px;
      }
      .bp-extracted-thumb {
        position: relative;
        aspect-ratio: 4 / 3;
        background: #faf8f3;
        border: 1px solid #e5e5e5;
        border-radius: 6px;
        overflow: hidden;
      }
      .bp-extracted-thumb img {
        width: 100%; height: 100%;
        object-fit: cover;
        display: block;
      }
      .bp-extracted-thumb-meta {
        position: absolute;
        bottom: 0; left: 0; right: 0;
        padding: 4px 8px;
        background: linear-gradient(transparent, rgba(0,0,0,0.7));
        color: #fff;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.04em;
        display: flex;
        justify-content: space-between;
      }
      .bp-parse-progress {
        margin-top: 14px;
        font-size: 13px;
        color: #666;
      }
      .bp-parse-progress-bar {
        height: 4px;
        background: #f1e7d3;
        border-radius: 2px;
        overflow: hidden;
        margin-top: 6px;
      }
      .bp-parse-progress-fill {
        height: 100%;
        background: #9c7440;
        transition: width 0.2s ease;
      }
      .bp-extract-warning {
        margin-top: 8px;
        padding: 10px 14px;
        background: #fff8e1;
        border: 1px solid #e8d97a;
        border-radius: 6px;
        font-size: 13px;
        color: #6b5a1a;
      }
    </style>

    <div class="section-header">
      <span class="eyebrow">Section 02</span>
      <h2>Bid PDF</h2>
      <p class="section-sub">Upload a JobNimbus bid PDF. Claude extracts the client info, scope sections, totals, and every image in the PDF — review, then commit.</p>
    </div>
    ${renderPhase()}
  `;
  attachEvents();
}

function renderPhase() {
  switch (state.phase) {
    case 'empty': return renderUploadZone();
    case 'parsing': return renderParsing();
    case 'review': return renderReview();
    case 'committed': return renderCommitted();
    case 'error': return renderError();
    default: return '';
  }
}

function renderUploadZone() {
  return `
    <div class="bp-upload-zone" id="uploadZone">
      <input type="file" id="pdfInput" accept="application/pdf" hidden>
      <div class="bp-upload-icon">📄</div>
      <div class="bp-upload-title">Drop a JobNimbus bid PDF</div>
      <div class="bp-upload-sub">or click to select · max 30 MB · extraction takes 10–40 seconds</div>
      <button class="btn primary" id="selectPdfBtn" type="button">Choose PDF</button>
    </div>
  `;
}

function renderParsing() {
  const p = state.parseProgress;
  const progressHtml = p && p.total > 0 ? `
    <div class="bp-parse-progress">
      Extracting image ${p.done} of ${p.total} from the PDF…
      <div class="bp-parse-progress-bar">
        <div class="bp-parse-progress-fill" style="width:${Math.round((p.done / p.total) * 100)}%"></div>
      </div>
    </div>
  ` : '';

  return `
    <div class="bp-parsing">
      <div class="bp-spinner"></div>
      <div class="bp-parsing-title">Parsing bid PDF…</div>
      <div class="bp-parsing-sub">Reading client info, scope sections, totals, and images. Usually 10–40 seconds.</div>
      ${progressHtml}
    </div>
  `;
}

function renderReview() {
  const p = state.parsed || {};
  const client = { ...(p.client || {}), ...state.editedClient };
  const sections = p.sections || [];
  const totals = p.totals || {};
  const materials = p.materials_mentioned || [];
  const extracted = state.extracted || [];

  // Extracted-image strip (using in-memory blob URLs — not yet in Storage).
  const extractedStrip = extracted.length > 0 ? `
    <div class="bp-extracted-strip">
      ${extracted.map(ex => `
        <div class="bp-extracted-thumb">
          <img src="${ex.blobUrl}" alt="Extracted page ${ex.sourcePage}">
          <div class="bp-extracted-thumb-meta">
            <span>p.${ex.sourcePage}</span>
            <span>${ex.width}×${ex.height}</span>
          </div>
        </div>
      `).join('')}
    </div>
  ` : `
    <div class="bp-extract-warning">
      No images could be extracted from this PDF. The text parse worked fine, but you'll need
      to upload photos manually in Section 05. (This is normal for flattened-scan PDFs.)
    </div>
  `;

  return `
    <div class="bp-review">
      <div class="bp-review-header">
        <span class="eyebrow">Extracted · review before committing</span>
        <button class="btn ghost" id="resetBtn">← Start over</button>
      </div>

      <div class="bp-review-section">
        <h3>Client</h3>
        <div class="bp-field-grid">
          ${renderField('client_name', 'Client name', client.client_name)}
          ${renderField('project_label', 'Project label', client.project_label)}
          ${renderField('client_email', 'Email', client.client_email)}
          ${renderField('client_phone', 'Phone', client.client_phone)}
          ${renderField('proposal_date', 'Proposal date', client.proposal_date)}
          ${renderField('bayside_estimate_number', 'Estimate #', client.bayside_estimate_number)}
        </div>
      </div>

      <div class="bp-review-section">
        <h3>Project address</h3>
        <div class="bp-field-grid">
          ${renderField('project_address', 'Street', client.project_address)}
          ${renderField('project_city', 'City', client.project_city)}
          ${renderField('project_state', 'State', client.project_state)}
          ${renderField('project_zip', 'ZIP', client.project_zip)}
        </div>
      </div>

      <div class="bp-review-section">
        <h3>Scope sections <span class="bp-count">${sections.length}</span></h3>
        <div class="bp-sections-list">
          ${sections.map((s, i) => renderSectionCard(s, i)).join('')}
        </div>
      </div>

      <div class="bp-review-section">
        <h3>Totals</h3>
        <dl class="kv bp-totals">
          <dt>Subtotal</dt><dd>${formatMoney(totals.subtotal)}</dd>
          <dt>Discount</dt><dd>${formatMoney(totals.discount_amount)}</dd>
          <dt>Final total</dt><dd><strong>${formatMoney(totals.final_total)}</strong></dd>
        </dl>
      </div>

      <div class="bp-review-section">
        <h3>Extracted images <span class="bp-count">${extracted.length}</span></h3>
        <p class="hint">
          Every embedded image found in the PDF, deduplicated. On commit these are uploaded to storage —
          larger ones become Property Photos and the biggest becomes the hero. You can change the hero later in Section 06.
        </p>
        ${extractedStrip}
      </div>

      ${materials.length ? `
        <div class="bp-review-section">
          <h3>Materials mentioned <span class="bp-count">${materials.length}</span></h3>
          <div class="bp-materials-list">
            ${materials.map(m => renderMaterialChip(m)).join('')}
          </div>
          <p class="hint">Reference only — you'll still pick exact catalog products in the Materials section.</p>
        </div>
      ` : ''}

      <div class="bp-commit-bar">
        <button class="btn primary" id="commitBtn">Commit to proposal →</button>
        <span class="hint">Populates client fields, creates ${sections.length} section record${sections.length === 1 ? '' : 's'}, and uploads ${extracted.length} image${extracted.length === 1 ? '' : 's'}.</span>
      </div>
    </div>
  `;
}

function renderField(key, label, value) {
  return `
    <div class="bp-field">
      <label for="field_${key}">${escapeHtml(label)}</label>
      <input type="text" id="field_${key}" data-key="${key}" value="${escapeHtml(value || '')}" placeholder="—">
    </div>
  `;
}

function renderSectionCard(s, idx) {
  const items = s.line_items || [];
  return `
    <div class="bp-section-card">
      <div class="bp-section-head">
        <span class="bp-section-num">${String(idx + 1).padStart(2, '0')}</span>
        <div class="bp-section-name">${escapeHtml(s.name || '—')}</div>
        <div class="bp-section-total ${s.total_amount < 0 ? 'negative' : ''}">${formatMoney(s.total_amount)}</div>
      </div>
      ${items.length ? `
        <ul class="bp-section-items">
          ${items.map(li => `<li>${escapeHtml(li)}</li>`).join('')}
        </ul>
      ` : `<div class="bp-section-empty">No line items extracted</div>`}
    </div>
  `;
}

function renderMaterialChip(m) {
  const mfr = m.manufacturer || '?';
  const name = m.product_name || '?';
  const bits = [m.color, m.size_spec].filter(Boolean);
  return `
    <div class="bp-material-chip">
      <div class="bp-material-head">
        <strong>${escapeHtml(mfr)}</strong>
        <span>${escapeHtml(name)}</span>
      </div>
      ${bits.length ? `<div class="bp-material-specs">${bits.map(escapeHtml).join(' · ')}</div>` : ''}
      ${m.application ? `<div class="bp-material-app">${escapeHtml(m.application)}</div>` : ''}
    </div>
  `;
}

function renderCommitted() {
  const p = state.parsed || {};
  const c = p.client || {};
  const t = p.totals || {};
  const sectionCount = p.sections?.length || 0;

  return `
    <div class="bp-committed">
      <div class="bp-committed-header">
        <span class="eyebrow">✓ Committed</span>
        <h3>Bid parsed and saved</h3>
      </div>
      <dl class="kv">
        <dt>Client</dt><dd>${escapeHtml(c.client_name || '—')}</dd>
        <dt>Address</dt><dd>${escapeHtml([c.project_address, c.project_city, c.project_state, c.project_zip].filter(Boolean).join(', ') || '—')}</dd>
        <dt>Sections</dt><dd>${sectionCount}</dd>
        <dt>Final total</dt><dd><strong>${formatMoney(t.final_total)}</strong></dd>
      </dl>
      <div class="bp-commit-bar">
        <button class="btn" id="reuploadBtn">Re-upload a different bid</button>
        <span class="hint">Replacing overwrites the extracted data, section rows, and extracted images (manually-uploaded photos are preserved).</span>
      </div>
    </div>
  `;
}

function renderError() {
  return `
    <div class="error-box"><strong>Parsing failed:</strong> ${escapeHtml(state.error || 'Unknown error')}</div>
    <div class="bp-commit-bar">
      <button class="btn" id="resetBtn">← Try again</button>
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Events
// ───────────────────────────────────────────────────────────────────────────
function attachEvents() {
  const c = state.container;

  const selectBtn = c.querySelector('#selectPdfBtn');
  const pdfInput = c.querySelector('#pdfInput');
  const uploadZone = c.querySelector('#uploadZone');

  selectBtn?.addEventListener('click', () => pdfInput.click());
  pdfInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleUpload(file);
  });

  if (uploadZone) {
    uploadZone.addEventListener('click', (e) => {
      if (e.target === uploadZone || e.target.classList.contains('bp-upload-title') ||
          e.target.classList.contains('bp-upload-sub') || e.target.classList.contains('bp-upload-icon')) {
        pdfInput.click();
      }
    });
    uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (file.type !== 'application/pdf') {
        state.phase = 'error';
        state.error = `Expected PDF, got ${file.type || 'unknown type'}`;
        render();
        return;
      }
      handleUpload(file);
    });
  }

  c.querySelector('#resetBtn')?.addEventListener('click', () => {
    revokeExtractedBlobs();
    state.phase = 'empty';
    state.parsed = null;
    state.extracted = [];
    state.parseProgress = null;
    state.error = null;
    state.editedClient = {};
    render();
  });

  c.querySelectorAll('input[data-key]').forEach(input => {
    input.addEventListener('input', () => {
      state.editedClient[input.dataset.key] = input.value;
    });
  });

  c.querySelector('#commitBtn')?.addEventListener('click', commitToProposal);

  c.querySelector('#reuploadBtn')?.addEventListener('click', () => {
    if (!confirm('Re-uploading will delete the existing bid sections, extracted images, and overwrite the parsed data. Manually-uploaded photos in Section 05 are preserved. Continue?')) return;
    state.phase = 'empty';
    state.parsed = null;
    state.extracted = [];
    state.parseProgress = null;
    state.editedClient = {};
    render();
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Upload handler — runs text parse + image extraction in parallel
// ───────────────────────────────────────────────────────────────────────────
async function handleUpload(file) {
  state.phase = 'parsing';
  state.error = null;
  state.extracted = [];
  state.parseProgress = null;
  render();

  // Read file into an ArrayBuffer once; both pipelines need the bytes.
  let arrayBuf;
  try {
    arrayBuf = await file.arrayBuffer();
  } catch (err) {
    state.phase = 'error';
    state.error = `Could not read the PDF file: ${err.message}`;
    render();
    return;
  }

  // Pipeline A: server-side text parse (existing behavior).
  const textParsePromise = (async () => {
    const fd = new FormData();
    fd.append('pdf', new Blob([arrayBuf], { type: 'application/pdf' }), file.name);
    const res = await fetch('/api/parse-bid-pdf', { method: 'POST', body: fd });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) {
      throw new Error(json?.error || `HTTP ${res.status}`);
    }
    return json.parsed;
  })();

  // Pipeline B: client-side image extraction via pdfjs-dist.
  // Failure here is non-fatal — we'll proceed without images.
  const imageExtractPromise = extractImages(arrayBuf).catch(err => {
    console.warn('Image extraction failed (continuing without images):', err);
    return [];
  });

  // Wait for both. Text parse failure is fatal; image failure isn't.
  const [textResult, imageResult] = await Promise.allSettled([
    textParsePromise,
    imageExtractPromise,
  ]);

  if (textResult.status === 'rejected') {
    state.phase = 'error';
    state.error = textResult.reason?.message || String(textResult.reason);
    state.extracted = [];
    render();
    return;
  }

  state.parsed = textResult.value;
  state.extracted = imageResult.status === 'fulfilled' ? imageResult.value : [];
  state.editedClient = {};
  state.phase = 'review';
  state.parseProgress = null;
  render();
}

// ───────────────────────────────────────────────────────────────────────────
// pdfjs-dist loader + image extraction
// ───────────────────────────────────────────────────────────────────────────
async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  // Dynamic import of the ES module build from cdnjs.
  pdfjsLib = await import(PDFJS_MJS);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return pdfjsLib;
}

async function extractImages(arrayBuf) {
  const lib = await loadPdfJs();

  // pdfjs consumes the ArrayBuffer; pass a copy so the text-parse fetch
  // (which may still be in flight) doesn't hit a detached buffer.
  const pdf = await lib.getDocument({ data: arrayBuf.slice(0) }).promise;

  // First pass: count how many image paint operations exist so the progress
  // bar has a meaningful total before we start extracting.
  let totalOps = 0;
  const pageOpLists = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const opList = await page.getOperatorList();
    const imageNames = [];
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      if (fn === lib.OPS.paintImageXObject ||
          fn === lib.OPS.paintJpegXObject ||
          fn === lib.OPS.paintInlineImageXObject) {
        imageNames.push(opList.argsArray[i][0]);
      }
    }
    totalOps += imageNames.length;
    pageOpLists.push({ page, imageNames, pageNum });
  }

  state.parseProgress = { done: 0, total: totalOps };
  render();

  // Second pass: actually extract each image.
  const extracted = [];
  const seenHashes = new Set();
  let processed = 0;

  for (const { page, imageNames, pageNum } of pageOpLists) {
    for (const name of imageNames) {
      processed += 1;

      try {
        const img = await getImageObject(page, name);
        if (!img) continue;

        const blob = await imageObjectToBlob(img);
        if (!blob) continue;

        // Deduplicate — logos and headers repeat on every page.
        const hash = await sha1(await blob.arrayBuffer());
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        const width = img.width || img.bitmap?.width || 0;
        const height = img.height || img.bitmap?.height || 0;

        extracted.push({
          blob,
          blobUrl: URL.createObjectURL(blob),
          width,
          height,
          sourcePage: pageNum,
          hash,
        });
      } catch (err) {
        // Per-image failure is non-fatal; keep going.
        console.warn(`Extract failed for "${name}" on page ${pageNum}:`, err);
      }

      // Update progress every few images (throttle re-renders).
      if (processed % 2 === 0 || processed === totalOps) {
        state.parseProgress = { done: processed, total: totalOps };
        render();
      }
    }
  }

  // Sort largest-first so the hero auto-pick is index 0.
  extracted.sort((a, b) => (b.width * b.height) - (a.width * a.height));

  return extracted;
}

// Image objects in pdfjs can live in page.objs OR page.commonObjs. Which one
// depends on whether the image is used on a single page (page.objs) or shared
// across pages like a logo (commonObjs). Try both, resolve whichever fires.
function getImageObject(page, name) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };

    // 5 second timeout — some fonts/objects never resolve, we skip them.
    const timer = setTimeout(() => finish(null), 5000);

    const tryStore = (store) => {
      try {
        store.get(name, (val) => {
          clearTimeout(timer);
          finish(val || null);
        });
      } catch (_e) {
        // Object not registered in this store — ignore.
      }
    };

    // commonObjs is typically where shared image XObjects live in newer pdfjs.
    tryStore(page.commonObjs);
    // Also ask page.objs in case the image is page-local.
    tryStore(page.objs);
  });
}

// Convert a pdfjs image object to a JPEG Blob via an offscreen canvas.
// Handles the two common formats: ImageBitmap (.bitmap) or raw pixel data
// (.data with .kind indicating RGBA/RGB/grayscale).
async function imageObjectToBlob(img) {
  const width = img.width || img.bitmap?.width;
  const height = img.height || img.bitmap?.height;
  if (!width || !height) return null;

  // Skip tiny images (<64px²) — they're almost certainly decoration/border
  // artifacts, not content. Saves storage and noise.
  if (width * height < 64 * 64) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (img.bitmap instanceof ImageBitmap) {
    ctx.drawImage(img.bitmap, 0, 0, width, height);
  } else if (img.data) {
    const imageData = ctx.createImageData(width, height);
    const src = img.data;

    if (src.length === width * height * 4) {
      // RGBA
      imageData.data.set(src);
    } else if (src.length === width * height * 3) {
      // RGB → RGBA
      for (let s = 0, d = 0; s < src.length; s += 3, d += 4) {
        imageData.data[d] = src[s];
        imageData.data[d + 1] = src[s + 1];
        imageData.data[d + 2] = src[s + 2];
        imageData.data[d + 3] = 255;
      }
    } else if (src.length === width * height) {
      // 8-bit grayscale → RGBA
      for (let s = 0, d = 0; s < src.length; s += 1, d += 4) {
        imageData.data[d] = src[s];
        imageData.data[d + 1] = src[s + 1] ?? src[s];
        imageData.data[d + 2] = src[s + 2] ?? src[s];
        imageData.data[d + 3] = 255;
      }
    } else {
      // Unknown packing (1bpp, palette, etc.) — skip rather than corrupt.
      return null;
    }
    ctx.putImageData(imageData, 0, 0);
  } else {
    return null;
  }

  return await new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      'image/jpeg',
      0.9
    );
  });
}

async function sha1(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function revokeExtractedBlobs() {
  for (const ex of state.extracted || []) {
    if (ex.blobUrl) {
      try { URL.revokeObjectURL(ex.blobUrl); } catch (_) {}
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Commit handler — persists parsed data AND uploads extracted images
// ───────────────────────────────────────────────────────────────────────────
async function commitToProposal() {
  const btn = state.container.querySelector('#commitBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Committing…';
  }

  const p = state.parsed || {};
  const mergedClient = { ...(p.client || {}), ...state.editedClient };
  const totals = p.totals || {};
  const sections = p.sections || [];

  // Build proposals update payload (strip empties)
  const updates = {
    client_name: mergedClient.client_name || null,
    client_email: mergedClient.client_email || null,
    client_phone: mergedClient.client_phone || null,
    project_address: mergedClient.project_address || null,
    project_city: mergedClient.project_city || null,
    project_state: mergedClient.project_state || null,
    project_zip: mergedClient.project_zip || null,
    project_label: mergedClient.project_label || null,
    bayside_estimate_number: mergedClient.bayside_estimate_number || null,
    bid_subtotal: totals.subtotal ?? null,
    bid_discount_amount: totals.discount_amount ?? null,
    bid_total_amount: totals.final_total ?? null,
    parsed_bid_data: p
  };

  if (mergedClient.proposal_date && /^\d{4}-\d{2}-\d{2}$/.test(mergedClient.proposal_date)) {
    updates.designed_date = mergedClient.proposal_date;
  }

  // 1. Update proposals row
  const { error: proposalErr } = await supabase
    .from('proposals')
    .update(updates)
    .eq('id', state.proposalId);

  if (proposalErr) {
    alert('Failed to update proposal:\n' + proposalErr.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Commit to proposal →'; }
    return;
  }

  // 2. Delete existing bid_section rows
  const { error: deleteErr } = await supabase
    .from('proposal_sections')
    .delete()
    .eq('proposal_id', state.proposalId)
    .eq('section_type', 'bid_section');

  if (deleteErr) {
    alert('Proposal updated but could not clear old sections:\n' + deleteErr.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Commit to proposal →'; }
    return;
  }

  // 3. Insert new proposal_sections
  if (sections.length > 0) {
    const sectionRows = sections.map((s, idx) => ({
      proposal_id: state.proposalId,
      section_type: 'bid_section',
      name: s.name || `Section ${idx + 1}`,
      display_order: idx,
      total_amount: typeof s.total_amount === 'number' ? s.total_amount : null,
      line_items: s.line_items || []
    }));

    const { error: insertErr } = await supabase
      .from('proposal_sections')
      .insert(sectionRows);

    if (insertErr) {
      alert('Proposal updated but failed to create sections:\n' + insertErr.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Commit to proposal →'; }
      return;
    }
  }

  // 4. Wipe old extracted images for this proposal (re-upload scenario).
  //    Manually-uploaded photos are preserved — the filter is
  //    extraction_source='bid_pdf_extract' specifically.
  try {
    await wipeOldExtractedImages();
  } catch (err) {
    alert('Proposal updated but could not clean up old extracted images:\n' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Commit to proposal →'; }
    return;
  }

  // 5. Upload the freshly extracted images.
  if (btn) btn.textContent = `Uploading 0 of ${state.extracted.length} images…`;
  const uploaded = [];

  for (let i = 0; i < state.extracted.length; i++) {
    const ex = state.extracted[i];
    if (btn) btn.textContent = `Uploading ${i + 1} of ${state.extracted.length} images…`;
    try {
      const row = await uploadExtractedImage(ex, i);
      if (row) uploaded.push(row);
    } catch (err) {
      console.warn(`Upload of extracted image ${i} failed:`, err);
    }
  }

  // 6. Auto-pick hero: largest uploaded image meeting min dimensions.
  //    If no image qualifies, leave hero_image_url as-is (Tim picks later).
  const heroRow = uploaded
    .filter(r => r.width >= HERO_MIN_WIDTH && r.height >= HERO_MIN_HEIGHT)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];

  if (heroRow) {
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(heroRow.storage_path);
    const heroUrl = data?.publicUrl;
    if (heroUrl) {
      await supabase
        .from('proposals')
        .update({ hero_image_url: heroUrl })
        .eq('id', state.proposalId);
    }
  }

  // Release memory held by blob URLs — we're done showing them.
  revokeExtractedBlobs();
  state.extracted = [];

  state.phase = 'committed';
  render();
  state.onSave?.();
}

async function wipeOldExtractedImages() {
  const { data: oldRows, error: listErr } = await supabase
    .from('proposal_images')
    .select('id, storage_path, thumbnail_path')
    .eq('proposal_id', state.proposalId)
    .eq('extraction_source', 'bid_pdf_extract');

  if (listErr) throw new Error(listErr.message);
  if (!oldRows || oldRows.length === 0) return;

  const paths = [];
  for (const row of oldRows) {
    if (row.storage_path) paths.push(row.storage_path);
    if (row.thumbnail_path) paths.push(row.thumbnail_path);
  }
  if (paths.length > 0) {
    // Non-fatal if some objects are already gone.
    await supabase.storage.from(BUCKET).remove(paths);
  }

  const { error: delErr } = await supabase
    .from('proposal_images')
    .delete()
    .eq('proposal_id', state.proposalId)
    .eq('extraction_source', 'bid_pdf_extract');

  if (delErr) throw new Error(delErr.message);
}

async function uploadExtractedImage(ex, idx) {
  // Resize via the same 2400/400 canvas pipeline photos.js uses.
  const { blob: mainBlob, width, height } = await resizeBlob(ex.blob, MAX_DIMENSION, JPEG_QUALITY);
  const { blob: thumbBlob } = await resizeBlob(ex.blob, THUMB_DIMENSION, JPEG_QUALITY);

  const uuid = crypto.randomUUID();
  const mainPath = `${state.proposalId}/${uuid}.jpg`;
  const thumbPath = `${state.proposalId}/${uuid}_thumb.jpg`;

  const { error: mainErr } = await supabase.storage
    .from(BUCKET)
    .upload(mainPath, mainBlob, { contentType: 'image/jpeg', upsert: false });
  if (mainErr) throw new Error(`Storage upload failed: ${mainErr.message}`);

  const { error: thumbErr } = await supabase.storage
    .from(BUCKET)
    .upload(thumbPath, thumbBlob, { contentType: 'image/jpeg', upsert: false });
  if (thumbErr) {
    await supabase.storage.from(BUCKET).remove([mainPath]);
    throw new Error(`Thumbnail upload failed: ${thumbErr.message}`);
  }

  const area = width * height;
  const category = area >= PROPERTY_MIN_AREA ? 'property_condition' : 'bid_pdf_asset';

  const { error: insertErr } = await supabase
    .from('proposal_images')
    .insert({
      proposal_id: state.proposalId,
      category,
      extraction_source: 'bid_pdf_extract',
      source_page: ex.sourcePage,
      storage_path: mainPath,
      thumbnail_path: thumbPath,
      original_filename: `bid-pdf-page-${ex.sourcePage}-${idx + 1}.jpg`,
      width,
      height,
      display_order: 10000 + idx   // push extracted after any existing manual uploads
    });

  if (insertErr) {
    await supabase.storage.from(BUCKET).remove([mainPath, thumbPath]);
    throw new Error(`DB insert failed: ${insertErr.message}`);
  }

  return { storage_path: mainPath, thumbnail_path: thumbPath, width, height };
}

// Same canvas-resize helper photos.js uses — kept local to this module for
// clean separation.
function resizeBlob(blob, maxDim, quality) {
  return new Promise(async (resolve, reject) => {
    let img;
    try {
      img = await blobToImage(blob);
    } catch (err) {
      return reject(err);
    }

    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longEdge > maxDim ? maxDim / longEdge : 1;
    const width = Math.round(img.naturalWidth * scale);
    const height = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);

    canvas.toBlob(
      (b) => b ? resolve({ blob: b, width, height }) : reject(new Error('toBlob failed')),
      'image/jpeg',
      quality
    );
  });
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function formatMoney(n) {
  if (n === null || n === undefined) return '—';
  const num = typeof n === 'number' ? n : parseFloat(n);
  if (isNaN(num)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
