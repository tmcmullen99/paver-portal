// ═══════════════════════════════════════════════════════════════════════════
// Photos section (Sprint 3G).
//
// Property condition / "before" photos for this proposal — a unified list of
// images from two sources:
//
//   • extraction_source='manual_upload'   — dragged/picked by Tim here
//   • extraction_source='bid_pdf_extract' — pulled from the bid PDF in
//                                            Section 02 automatically
//
// Small extracted assets (logos, icons, sub-400x400 swatches) land with
// category='bid_pdf_asset' and never appear in this grid — the property
// condition list only shows usable photos.
//
// Sprint 3G change: every image has a display_section classifier that
// controls which section of the published page it renders in. Tim sets this
// from a dropdown on each row:
//
//   'current_photo'    → "Current site conditions" section (04) on the
//                         published page
//   'design_rendering' → "Design renderings" section (05)
//   'hidden'           → not published at all (data-hygiene escape hatch
//                         for blurry shots, unusable extracts, duplicates)
//
// Why the dropdown is needed: extraction_source is a technical signal
// (where the bytes came from), not a semantic signal (what type of image
// it is). Bid PDFs can contain real photos; manual uploads can be
// SketchUp screenshots. display_section decouples the two so classification
// survives independent of upload origin.
//
// Flow for manual uploads is unchanged from Phase 1.5:
//   1. User drags image onto dropzone OR picks via file input
//   2. Client-side: Canvas API resizes to max 2400px long edge, JPEG quality 85
//   3. A 400px thumbnail is generated the same way
//   4. Both uploaded directly to Supabase Storage (bucket 'proposal-photos')
//      under paths: {proposalId}/{uuid}.jpg and {proposalId}/{uuid}_thumb.jpg
//   5. A proposal_images row is inserted with extraction_source='manual_upload'
//      and display_section='current_photo' (the sensible default for a
//      hand-uploaded image — Tim can re-classify to rendering if needed)
//   6. UI re-renders the list
//
// Reorder: up/down arrow buttons swap display_order with the neighbor row.
// Delete: removes Storage objects + DB row (including extracted ones).
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';

const BUCKET = 'proposal-photos';
const MAX_DIMENSION = 2400;
const THUMB_DIMENSION = 400;
const JPEG_QUALITY = 0.85;

const LOCATION_TAGS = [
  { value: '',             label: '— no tag —' },
  { value: 'front_yard',   label: 'Front yard' },
  { value: 'backyard',     label: 'Backyard' },
  { value: 'side_yard',    label: 'Side yard' },
  { value: 'full_property',label: 'Full property' }
];

// Sprint 3G — the authoritative list of display sections.
// These MUST match the CHECK constraint in migration 015 and the filter
// predicates in publish.js (renderCurrentPhotosSection / renderRenderingsSection).
const DISPLAY_SECTIONS = [
  { value: 'current_photo',    label: 'Current site conditions' },
  { value: 'design_rendering', label: 'Design renderings' },
  { value: 'hidden',           label: '⊘ Hidden (do not publish)' }
];

const state = {
  proposalId: null,
  container: null,
  onSave: null,
  photos: [],      // rows from proposal_images (property_condition only)
  uploading: 0,    // count of in-flight uploads
  error: null
};

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────
export async function initPhotos({ proposalId, container, onSave }) {
  Object.assign(state, {
    proposalId,
    container,
    onSave,
    photos: [],
    uploading: 0,
    error: null
  });

  container.innerHTML = `<div class="mp-loading">Loading photos…</div>`;

  await loadPhotos();
  render();
}

async function loadPhotos() {
  const { data, error } = await supabase
    .from('proposal_images')
    .select('*')
    .eq('proposal_id', state.proposalId)
    .eq('category', 'property_condition')
    .order('display_order', { ascending: true });

  if (error) {
    state.error = 'Could not load photos: ' + error.message;
    state.photos = [];
    return;
  }

  state.photos = data || [];
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering
// ───────────────────────────────────────────────────────────────────────────
function render() {
  const { photos, uploading, error } = state;

  // Count by display_section for the contextual header — mirrors what the
  // client will see on the published page.
  const currentCount    = photos.filter(p => p.display_section === 'current_photo').length;
  const renderingCount  = photos.filter(p => p.display_section === 'design_rendering').length;
  const hiddenCount     = photos.filter(p => p.display_section === 'hidden').length;
  // Legacy rows that predate the 015 migration may have null display_section
  // — count them so the UI surfaces the issue rather than silently hiding them.
  const unclassifiedCount = photos.filter(p => !p.display_section).length;

  state.container.innerHTML = `
    <style>
      .bp-photo-tag {
        display: inline-block;
        padding: 3px 8px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        border-radius: 4px;
        margin-right: 8px;
        vertical-align: middle;
      }
      .bp-photo-tag-pdf {
        background: #f1e7d3;
        color: #7d5c31;
      }
      .bp-photo-tag-upload {
        background: #f0f0f0;
        color: #666;
      }
      .bp-photo-tag-page {
        color: #999;
        font-size: 11px;
        font-weight: 500;
        margin-left: 6px;
      }
      .bp-photo-source-summary {
        font-size: 13px;
        color: #666;
        margin-top: 4px;
      }
      .bp-photo-source-summary strong {
        color: #353535;
        font-weight: 600;
      }
      .bp-photo-source-summary .bp-sep {
        color: #ccc;
        margin: 0 8px;
      }

      /* Sprint 3G — display_section dropdown styling. Pill-shaped select
         with a left-edge accent color per section so Tim can eyeball at
         a glance what's classified as what. */
      .bp-photo-classification {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
      }
      .bp-photo-classification-label {
        font-size: 10px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #666;
        font-weight: 700;
        flex-shrink: 0;
      }
      .bp-photo-classification select {
        padding: 6px 10px;
        font-size: 13px;
        font-weight: 600;
        border-radius: 6px;
        border: 1.5px solid #d5d5d5;
        background: #fff;
        cursor: pointer;
        transition: border-color 0.15s;
      }
      .bp-photo-classification select:hover {
        border-color: #9c7440;
      }
      .bp-photo-classification select[data-value="current_photo"] {
        border-left: 5px solid #9c7440;
        color: #7d5c31;
      }
      .bp-photo-classification select[data-value="design_rendering"] {
        border-left: 5px solid #91a1ba;
        color: #33281c;
      }
      .bp-photo-classification select[data-value="hidden"] {
        border-left: 5px solid #b04040;
        color: #8a2020;
        background: #fdf6f6;
      }

      /* Unclassified-row warning — shown on any row where display_section
         is NULL (should only happen for pre-migration rows that slipped
         through the backfill). */
      .bp-photo-classification select[data-value=""] {
        border-left: 5px solid #d89a2a;
        color: #8b5a00;
        background: #fffbe6;
      }

      .bp-photo-row.is-hidden {
        opacity: 0.55;
      }

      .bp-warn-banner {
        margin: 16px 0;
        padding: 12px 16px;
        background: #fffbe6;
        border: 1px solid #d89a2a;
        border-radius: 8px;
        color: #8b5a00;
        font-size: 14px;
      }
    </style>

    <div class="section-header">
      <span class="eyebrow">Section 05</span>
      <h2>Photos — property condition</h2>
      <p class="lead">
        Drag "before" photos of the property here. Images are resized to 2400px and compressed
        automatically. Classify each image as <strong>Current site conditions</strong> or
        <strong>Design renderings</strong> to control which section it renders in on the
        published proposal. Hidden images stay in the database but don't publish.
      </p>
      ${photos.length > 0 ? `
        <p class="bp-photo-source-summary">
          <strong>${photos.length}</strong> photo${photos.length === 1 ? '' : 's'}
          <span class="bp-sep">·</span>
          <strong>${currentCount}</strong> current
          <span class="bp-sep">·</span>
          <strong>${renderingCount}</strong> rendering${renderingCount === 1 ? '' : 's'}
          <span class="bp-sep">·</span>
          <strong>${hiddenCount}</strong> hidden
        </p>
      ` : ''}
    </div>

    ${unclassifiedCount > 0 ? `
      <div class="bp-warn-banner">
        <strong>${unclassifiedCount} photo${unclassifiedCount === 1 ? '' : 's'} unclassified.</strong>
        Set a section below so ${unclassifiedCount === 1 ? 'it appears' : 'they appear'} on the published page.
      </div>
    ` : ''}

    ${error ? `<div class="bp-error-box">${escapeHtml(error)}</div>` : ''}

    <div class="bp-photo-dropzone" id="bpPhotoDrop">
      <div class="bp-photo-dropzone-inner">
        <div class="bp-photo-dropzone-icon">+</div>
        <div class="bp-photo-dropzone-text">
          <strong>Drag photos here</strong>
          <span>or <button type="button" class="bp-link" id="bpPhotoPick">pick from your computer</button></span>
        </div>
        <div class="bp-photo-dropzone-hint">JPEG, PNG, HEIC · any size · multiple at once</div>
      </div>
      <input type="file" id="bpPhotoInput" accept="image/*" multiple style="display:none">
    </div>

    ${uploading > 0 ? `
      <div class="bp-photo-uploading">
        Uploading ${uploading} photo${uploading === 1 ? '' : 's'}… don't navigate away.
      </div>
    ` : ''}

    <div class="bp-photo-list">
      ${photos.length === 0 && uploading === 0
        ? `<div class="bp-photo-empty">No photos yet — commit a bid PDF in Section 02 to auto-extract images, or drop some above.</div>`
        : photos.map((p, idx) => renderPhotoRow(p, idx, photos.length)).join('')
      }
    </div>
  `;

  attachDropzone();
  attachRowControls();
}

function renderPhotoRow(photo, idx, total) {
  const thumbUrl = photo.thumbnail_path ? publicUrl(photo.thumbnail_path) : publicUrl(photo.storage_path);
  const fullUrl  = publicUrl(photo.storage_path);

  const locationOptions = LOCATION_TAGS.map(t => `
    <option value="${t.value}" ${(photo.location_tag || '') === t.value ? 'selected' : ''}>
      ${t.label}
    </option>
  `).join('');

  // Sprint 3G — display_section dropdown. Includes a blank option only if
  // the current value is unexpectedly blank (so legacy unclassified rows
  // don't silently self-assign).
  const sectionValue = photo.display_section || '';
  const sectionOptions = [
    sectionValue === ''
      ? `<option value="" selected>— unclassified —</option>`
      : '',
    ...DISPLAY_SECTIONS.map(s => `
      <option value="${s.value}" ${sectionValue === s.value ? 'selected' : ''}>
        ${s.label}
      </option>
    `)
  ].join('');

  // Source pill — green for PDF-extracted, gray for manually uploaded.
  const isPdf = photo.extraction_source === 'bid_pdf_extract';
  const tagPill = isPdf
    ? `<span class="bp-photo-tag bp-photo-tag-pdf">From bid PDF</span>${
        photo.source_page ? `<span class="bp-photo-tag-page">p.${photo.source_page}</span>` : ''
      }`
    : `<span class="bp-photo-tag bp-photo-tag-upload">Uploaded</span>`;

  const rowClasses = ['bp-photo-row'];
  if (sectionValue === 'hidden') rowClasses.push('is-hidden');

  return `
    <div class="${rowClasses.join(' ')}" data-id="${photo.id}">
      <div class="bp-photo-thumb">
        <a href="${fullUrl}" target="_blank" rel="noopener">
          <img src="${thumbUrl}" alt="" loading="lazy">
        </a>
      </div>
      <div class="bp-photo-meta">
        <div class="bp-photo-filename" title="${escapeHtml(photo.original_filename || '')}">
          ${tagPill}${escapeHtml(photo.original_filename || 'Untitled')}
        </div>
        <div class="bp-photo-dims">
          ${photo.width && photo.height ? `${photo.width} × ${photo.height}` : ''}
        </div>

        <div class="bp-photo-classification">
          <span class="bp-photo-classification-label">Section</span>
          <select data-field="display_section" data-id="${photo.id}"
                  data-value="${escapeAttr(sectionValue)}">
            ${sectionOptions}
          </select>
        </div>

        <label class="bp-photo-location">
          <span class="eyebrow">Location</span>
          <select data-field="location_tag" data-id="${photo.id}">
            ${locationOptions}
          </select>
        </label>
      </div>
      <div class="bp-photo-actions">
        <button type="button" class="bp-icon-btn" data-action="up" data-id="${photo.id}"
                ${idx === 0 ? 'disabled' : ''} title="Move up">▲</button>
        <button type="button" class="bp-icon-btn" data-action="down" data-id="${photo.id}"
                ${idx === total - 1 ? 'disabled' : ''} title="Move down">▼</button>
        <button type="button" class="bp-icon-btn bp-icon-btn-danger" data-action="delete"
                data-id="${photo.id}" title="Delete">✕</button>
      </div>
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Dropzone + file input wiring
// ───────────────────────────────────────────────────────────────────────────
function attachDropzone() {
  const drop = state.container.querySelector('#bpPhotoDrop');
  const input = state.container.querySelector('#bpPhotoInput');
  const pick = state.container.querySelector('#bpPhotoPick');

  if (!drop || !input) return;

  pick?.addEventListener('click', (e) => { e.preventDefault(); input.click(); });

  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;
    await handleFiles(files);
  });

  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    if (files.length === 0) return;
    await handleFiles(files);
    input.value = '';
  });
}

function attachRowControls() {
  state.container.querySelectorAll('.bp-photo-row [data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'up') await movePhoto(id, -1);
      else if (action === 'down') await movePhoto(id, +1);
      else if (action === 'delete') await deletePhoto(id);
    });
  });

  // Handles BOTH location_tag AND display_section dropdowns — same write
  // pattern (update column, refresh local state, trigger onSave). The
  // data-field attribute on the <select> tells us which column to touch.
  state.container.querySelectorAll('.bp-photo-row select[data-field]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.dataset.id;
      const field = sel.dataset.field;
      const value = sel.value || null;
      const { error } = await supabase
        .from('proposal_images')
        .update({ [field]: value })
        .eq('id', id);
      if (error) {
        state.error = `Could not save ${field}: ${error.message}`;
        render();
      } else {
        const row = state.photos.find(p => p.id === id);
        if (row) row[field] = value;
        // Re-render so the summary counts, hidden-row opacity, and
        // select-accent color update in-place.
        render();
        state.onSave?.();
      }
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Upload pipeline (manual uploads only — extraction uploads happen in bid-pdf.js)
// ───────────────────────────────────────────────────────────────────────────
async function handleFiles(files) {
  state.uploading += files.length;
  state.error = null;
  render();

  // Process files in parallel (browser will naturally throttle canvas work)
  const uploads = files.map(file => processAndUpload(file).catch(err => {
    console.error('Upload failed:', file.name, err);
    return { error: err.message || String(err), file };
  }));

  const results = await Promise.all(uploads);
  const failures = results.filter(r => r && r.error);

  state.uploading -= files.length;

  if (failures.length > 0) {
    state.error = `${failures.length} upload${failures.length === 1 ? '' : 's'} failed: ${failures[0].error}`;
  }

  await loadPhotos();
  render();
  state.onSave?.();
}

async function processAndUpload(file) {
  // 1. Decode image
  const img = await loadImage(file);

  // 2. Resize main image to max 2400px long edge
  const { blob: mainBlob, width, height } = await resizeToBlob(img, MAX_DIMENSION, JPEG_QUALITY);

  // 3. Resize thumbnail to 400px long edge
  const { blob: thumbBlob } = await resizeToBlob(img, THUMB_DIMENSION, JPEG_QUALITY);

  // 4. Generate unique paths
  const uuid = crypto.randomUUID();
  const mainPath  = `${state.proposalId}/${uuid}.jpg`;
  const thumbPath = `${state.proposalId}/${uuid}_thumb.jpg`;

  // 5. Upload both to Storage
  const { error: mainErr } = await supabase.storage
    .from(BUCKET)
    .upload(mainPath, mainBlob, { contentType: 'image/jpeg', upsert: false });
  if (mainErr) throw new Error(`Storage upload failed: ${mainErr.message}`);

  const { error: thumbErr } = await supabase.storage
    .from(BUCKET)
    .upload(thumbPath, thumbBlob, { contentType: 'image/jpeg', upsert: false });
  if (thumbErr) {
    // Best-effort cleanup of main, then surface the thumbnail error
    await supabase.storage.from(BUCKET).remove([mainPath]);
    throw new Error(`Thumbnail upload failed: ${thumbErr.message}`);
  }

  // 6. Determine next display_order
  const maxOrder = state.photos.reduce((m, p) => Math.max(m, p.display_order ?? 0), -1);

  // 7. Insert DB row.
  //    Sprint 3G: default display_section = 'current_photo' for manual
  //    uploads because the most common use case is Tim dragging in iPhone
  //    photos of the existing property. He can re-classify individual
  //    rows to 'design_rendering' via the dropdown if he uploads a
  //    SketchUp screenshot instead.
  const { error: insertErr } = await supabase
    .from('proposal_images')
    .insert({
      proposal_id: state.proposalId,
      category: 'property_condition',
      extraction_source: 'manual_upload',
      display_section: 'current_photo',
      storage_path: mainPath,
      thumbnail_path: thumbPath,
      original_filename: file.name,
      width,
      height,
      display_order: maxOrder + 1
    });

  if (insertErr) {
    // Best-effort cleanup of both Storage objects
    await supabase.storage.from(BUCKET).remove([mainPath, thumbPath]);
    throw new Error(`Database insert failed: ${insertErr.message}`);
  }

  return { ok: true };
}

// ───────────────────────────────────────────────────────────────────────────
// Canvas-based resize
// ───────────────────────────────────────────────────────────────────────────
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode ${file.name} — unsupported format?`));
    };
    img.src = url;
  });
}

function resizeToBlob(img, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longEdge > maxDim ? maxDim / longEdge : 1;
    const width = Math.round(img.naturalWidth * scale);
    const height = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('Canvas toBlob failed'));
        resolve({ blob, width, height });
      },
      'image/jpeg',
      quality
    );
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Reorder + delete
// ───────────────────────────────────────────────────────────────────────────
async function movePhoto(id, direction) {
  const idx = state.photos.findIndex(p => p.id === id);
  if (idx === -1) return;
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= state.photos.length) return;

  const a = state.photos[idx];
  const b = state.photos[swapIdx];

  // Swap display_order values
  const { error: errA } = await supabase
    .from('proposal_images')
    .update({ display_order: b.display_order })
    .eq('id', a.id);
  const { error: errB } = await supabase
    .from('proposal_images')
    .update({ display_order: a.display_order })
    .eq('id', b.id);

  if (errA || errB) {
    state.error = `Reorder failed: ${(errA || errB).message}`;
    render();
    return;
  }

  await loadPhotos();
  render();
  state.onSave?.();
}

async function deletePhoto(id) {
  const photo = state.photos.find(p => p.id === id);
  if (!photo) return;
  if (!confirm(`Delete "${photo.original_filename || 'this photo'}"? This can't be undone.`)) return;

  // Remove Storage objects first (best-effort; a dangling row is worse than dangling blobs)
  const pathsToRemove = [photo.storage_path, photo.thumbnail_path].filter(Boolean);
  if (pathsToRemove.length > 0) {
    await supabase.storage.from(BUCKET).remove(pathsToRemove);
  }

  // Remove DB row
  const { error } = await supabase
    .from('proposal_images')
    .delete()
    .eq('id', id);

  if (error) {
    state.error = `Delete failed: ${error.message}`;
    render();
    return;
  }

  await loadPhotos();
  render();
  state.onSave?.();
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function publicUrl(storagePath) {
  if (!storagePath) return '';
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data?.publicUrl || '';
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}
