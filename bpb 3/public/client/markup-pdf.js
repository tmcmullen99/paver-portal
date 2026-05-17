// ═══════════════════════════════════════════════════════════════════════════
// /client/markup-pdf.js — Phase 1A
//
// Generates a brand-matched markup PDF for a Bayside proposal entirely
// client-side using jsPDF (loaded from CDN on first use). Mirrors the
// "Project Site Map Proposal" template:
//
//   - Landscape letter (792 × 612 pt)
//   - Dark charcoal header band with Bayside green "Bayside Pavers" logo
//     left, "PROJECT SITE MAP PROPOSAL" white centered, brand subtitle.
//   - Top strip: Client / Date / Revision # + baysidepavers.com URL
//   - Two-column body: image on the left, lined NOTES & MARKUPS column
//     on the right for handwritten markup.
//   - Dark footer band with the project address and URL.
//
// One page is generated per detected image. Auto-detection order from
// the proposals table:
//   1. site_plan_backdrop_url  → "Top-down site plan"
//   2. hero_image_url           → "3D rendering"
//   3. construction_drawing_url → "Construction view"
//
// Phase 2 will add a designer-side picker so renderings can be ordered
// or extended beyond these three; the picker's output will write to a
// new `markup_pdf_images jsonb` column on proposals which this module
// will prefer when present.
// ═══════════════════════════════════════════════════════════════════════════

const JSPDF_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

const BRAND = {
  charcoal:  [53, 53, 53],
  green:     [93, 126, 105],
  greenDark: [74, 101, 84],
  tan:       [218, 215, 197],
  cream:     [250, 248, 243],
  mute:      [120, 120, 120],
  rule:      [218, 215, 197],
  inkLight:  [200, 200, 200],
};

// ── jsPDF loader ─────────────────────────────────────────────────────
async function ensureJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;

  const existing = document.getElementById('bpc-jspdf-cdn');
  if (existing) {
    // Another caller already started the load — wait for it
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (window.jspdf && window.jspdf.jsPDF) {
          clearInterval(tick);
          resolve(window.jspdf.jsPDF);
        } else if (Date.now() - t0 > 15000) {
          clearInterval(tick);
          reject(new Error('jsPDF load timeout'));
        }
      }, 50);
    });
  }

  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.id = 'bpc-jspdf-cdn';
    s.src = JSPDF_CDN;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load jsPDF from CDN'));
    document.head.appendChild(s);
  });

  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error('jsPDF script loaded but global was not registered');
  }
  return window.jspdf.jsPDF;
}

// ── Image fetch + base64 conversion ──────────────────────────────────
async function fetchAsDataUrl(url) {
  try {
    const resp = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn('[markup-pdf] image fetch failed:', url, e && e.message);
    return null;
  }
}

function imageMimeFromUrl(url) {
  const lower = String(url || '').split('?')[0].toLowerCase();
  if (lower.endsWith('.png')) return 'PNG';
  if (lower.endsWith('.webp')) return 'WEBP';
  return 'JPEG'; // safe default
}

// ── Image collection ─────────────────────────────────────────────────
function collectImageUrls(proposal) {
  const out = [];
  const seen = new Set();
  const push = (url, label) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, label });
  };
  push(proposal.site_plan_backdrop_url, 'Top-down site plan');
  push(proposal.hero_image_url,         '3D rendering');
  push(proposal.construction_drawing_url, 'Construction view');
  return out;
}

// ── Filename sanitization ────────────────────────────────────────────
function sanitizeFilename(s) {
  return String(s || 'proposal')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'proposal';
}

// ── Image natural-size measurement (for aspect-ratio fit) ────────────
function measureImageDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = dataUrl;
  });
}

// ── Page rendering ───────────────────────────────────────────────────
async function renderPage(doc, imgInfo, dataUrl, proposal, options) {
  const pw = doc.internal.pageSize.getWidth();    // 792 pt
  const ph = doc.internal.pageSize.getHeight();   // 612 pt

  // Top dark header band
  doc.setFillColor(...BRAND.charcoal);
  doc.rect(0, 0, pw, 70, 'F');

  // Logo (text fallback — Phase 2 can swap to a PNG of the real logo)
  doc.setTextColor(...BRAND.green);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Bayside Pavers', 28, 42);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(170, 170, 170);
  doc.text('hardscape company', 28, 54);

  // Centered title
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(22);
  doc.text('PROJECT SITE MAP PROPOSAL', pw / 2, 38, { align: 'center' });
  doc.setFontSize(9);
  doc.setTextColor(...BRAND.inkLight);
  doc.text('BAYSIDE PAVERS', pw / 2, 56, { align: 'center' });

  // Top strip: Client / Date / Revision + URL
  doc.setTextColor(80, 80, 80);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const clientName = (options.clientName || '').slice(0, 24);
  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
  const rev = options.revisionNumber ? String(options.revisionNumber) : '';
  const padLine = (label, val, width) => {
    const filled = label + ' ' + val;
    const underscores = '_'.repeat(Math.max(4, width - filled.length));
    return filled + underscores;
  };
  const stripText =
    padLine('Client:', clientName, 36) + '   ' +
    padLine('Date:',   dateStr,    32) + '   ' +
    padLine('Revision #:', rev,    12);
  doc.text(stripText, 28, 90);
  doc.setTextColor(...BRAND.green);
  doc.text('baysidepavers.com', pw - 28, 90, { align: 'right' });
  doc.setTextColor(140, 140, 140);
  doc.text(
    'Print this page and mark up with arrows, notes, and drawings. Send back to your designer.',
    28, 102
  );

  // ── Body: image left, notes right ──
  const colGap = 24;
  const rightW = 320;
  const leftX = 28;
  const rightX = pw - rightW - 28;
  const colY = 120;
  const colH = ph - colY - 40;
  const leftBoxW = rightX - leftX - colGap;
  const leftBoxH = colH;

  // Image
  if (dataUrl) {
    try {
      // Fit image to box preserving aspect ratio
      const dim = await measureImageDataUrl(dataUrl);
      let drawW = leftBoxW;
      let drawH = leftBoxH;
      if (dim.w > 0 && dim.h > 0) {
        const boxAR = leftBoxW / leftBoxH;
        const imgAR = dim.w / dim.h;
        if (imgAR > boxAR) {
          // Image is wider than box — letterbox top/bottom
          drawW = leftBoxW;
          drawH = leftBoxW / imgAR;
        } else {
          // Image is taller — letterbox left/right
          drawH = leftBoxH;
          drawW = leftBoxH * imgAR;
        }
      }
      const drawX = leftX + (leftBoxW - drawW) / 2;
      const drawY = colY + (leftBoxH - drawH) / 2;
      const mime = imageMimeFromUrl(imgInfo.url);
      doc.addImage(dataUrl, mime, drawX, drawY, drawW, drawH, '', 'FAST');
    } catch (e) {
      doc.setTextColor(180, 80, 80);
      doc.setFontSize(10);
      doc.text('Image could not be embedded: ' + (imgInfo.label || ''), leftX, colY + 20);
    }
  } else {
    // No image — blank framed canvas for raw markup
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(1);
    doc.rect(leftX, colY, leftBoxW, leftBoxH);
    doc.setTextColor(180, 180, 180);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.text('Blank canvas', leftX + 20, colY + 30);
    doc.setFontSize(8);
    doc.text(imgInfo.label || 'No image attached yet — draw freely.', leftX + 20, colY + 46);
  }

  // Notes column
  doc.setTextColor(...BRAND.charcoal);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('NOTES & MARKUPS', rightX, colY + 10);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...BRAND.mute);
  doc.text(
    'Print this page and mark up with arrows, notes, and drawings. Send back to your designer.',
    rightX, colY + 26
  );

  // Ruled lines
  doc.setDrawColor(...BRAND.rule);
  doc.setLineWidth(0.5);
  const linesTop = colY + 50;
  const linesBot = ph - 60;
  const lineGap = 32;
  for (let y = linesTop; y < linesBot; y += lineGap) {
    doc.line(rightX, y, rightX + rightW, y);
  }

  // Footer band
  doc.setFillColor(...BRAND.charcoal);
  doc.rect(0, ph - 24, pw, 24, 'F');
  doc.setTextColor(180, 180, 180);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  const addr = proposal.project_address || proposal.address || '';
  if (addr) doc.text(addr, 28, ph - 8);
  doc.text('baysidepavers.com', pw - 28, ph - 8, { align: 'right' });
  if (imgInfo.label) {
    doc.text(imgInfo.label, pw / 2, ph - 8, { align: 'center' });
  }
}

// ── Public API ───────────────────────────────────────────────────────
/**
 * Generate and trigger download of a markup-ready PDF.
 *
 * @param {Object} proposal - { project_address?, site_plan_backdrop_url?,
 *                              hero_image_url?, construction_drawing_url? }
 * @param {Object} [options]
 *   @prop {string} [options.clientName]      Pre-fills the Client field
 *   @prop {string} [options.revisionNumber]  Pre-fills the Revision # field
 *   @prop {string} [options.filename]        Override the default filename
 */
export async function generateMarkupPdf(proposal, options = {}) {
  const jsPDFCtor = await ensureJsPDF();
  let images = collectImageUrls(proposal);

  // No images on the proposal yet — generate a single blank page so the
  // homeowner still has a printable markup template.
  if (images.length === 0) {
    images = [{ url: null, label: 'Markup space' }];
  }

  const doc = new jsPDFCtor({
    orientation: 'landscape',
    unit: 'pt',
    format: 'letter',
    compress: true,
  });

  // Fetch all images in parallel for speed
  const dataUrls = await Promise.all(
    images.map(img => img.url ? fetchAsDataUrl(img.url) : Promise.resolve(null))
  );

  for (let i = 0; i < images.length; i++) {
    if (i > 0) doc.addPage();
    await renderPage(doc, images[i], dataUrls[i], proposal, options);
  }

  const baseName = sanitizeFilename(
    proposal.project_address || proposal.address || 'proposal'
  );
  const filename = options.filename || (baseName + '-markup.pdf');
  doc.save(filename);
}
