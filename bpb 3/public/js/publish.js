// ═══════════════════════════════════════════════════════════════════════════
// Phase 1.5 Sprint 2 Part B.2 — Preview & Publish
//
// Changes from Sprint 1:
//
//   1. "Why preparation matters" section is now DYNAMIC.
//      • Queries installation_guide_sections joined via
//        installation_guide_section_categories for the Belgard categories
//        actually present in this proposal's materials.
//      • Renders one card per unique section with real ICPI-standard
//        summary + 3-5 key technical points extracted by Claude from the
//        Belgard Product Installation Guide PDF.
//      • Each card has a "View the full installation standards →" link
//        pointing at the master PDF with a #page={N} anchor.
//      • Falls back to the hardcoded 4-card version when no install_guide
//        data is linked (so the page never renders empty).
//
//   2. Per-material "View installation guide" button is now page-anchored.
//      • When a Belgard material's category has a mapped install guide
//        section, the button links to the master PDF at the relevant page
//        ({BELGARD_MASTER_PDF}#page=N).
//      • Falls back to the generic Paver Portal install guide if the material's
//        category isn't mapped (preserves prior behavior — no regressions
//        for materials without section linkage).
//
//   3. [Sprint 3 Part C] "Why preparation matters" now also renders
//      non-Belgard standards cards when the proposal contains turf or
//      Tru-Scapes lighting, detected via pattern match on
//      proposal_sections.line_items and the third-party materials tray.
//      Content is hardcoded in renderThirdPartyPrepCards; when the
//      installation_guide_sections schema is extended to cover non-Belgard
//      categories, this will migrate to a data-driven query.
//
//   4. [Sprint 3 Part D] Construction drawing picker + featured page
//      section. Admin selects one image from proposal_images as the
//      "construction drawing" (stored as proposals.construction_drawing_url,
//      added in migration 014); it renders as its own framed full-width
//      section on the published page between the Loom embed and Scope.
//
//   5. [Sprint 3 Part D] Scope line items now render as STRUCTURED blocks
//      instead of one middle-dot-joined paragraph. Each entry in the
//      line_items array becomes its own card with:
//        • a small TYPE chip (extracted from ALL-CAPS "PAVER:" / "TURF:" /
//          etc. prefixes — 2+ chars, colon-terminated)
//        • a material-name heading (first pipe-delimited segment)
//        • a row of Pattern / Color / Part Number attributes (remaining
//          pipe-delimited "KEY: VALUE" pairs)
//      Lines without that structure (construction notes, lowercase-prefixed
//      narrative) fall through to plain body text — no type chip, no attrs.
//      See parseLineItem + formatLineItemsHtml.
//
//   6. [Sprint 3 Part F] Property photos section split into TWO top-level
//      sections on the published page — "Current site conditions" (04)
//      and "Design renderings" (05). Sprint 3F partitioned on
//      extraction_source as a proxy, which assumed PDF-extracted images
//      were always renderings and manual uploads were always photos.
//
//   7. [Sprint 3 Part G] Photo classification is now user-controlled via
//      the new proposal_images.display_section column (migration 015).
//      Each image is tagged 'current_photo', 'design_rendering', or
//      'hidden' from a dropdown in Section 05 of the BPB editor. This
//      replaces the extraction_source proxy from Sprint 3F — because a
//      bid PDF can contain real current-condition photos, and a manual
//      upload can be a SketchUp screenshot, the old partition inverted
//      for proposals like Parag's 88 Prospect. Legacy rows with null
//      display_section fall back to the Sprint 3F logic so nothing
//      disappears silently during the migration rollout.
//
//      Mobile spacing on scope line items also improved in this sprint:
//      non-structured line items now stack vertically on narrow viewports
//      (<640px) so the TYPE chip and body text each get full width
//      instead of the body being compressed into a narrow right column
//      next to a wide empty left column.
//
//   8. [Sprint 3 Part J] Turf prep-card false-positive fix. Sprint 3C's
//      turf detection scanned scope line_items with a single regex that
//      included a bare \bturf\b alternate — which matches demolition
//      language like "Remove and dispose of existing turf/flagstone/tile
//      material" on proposals where no synthetic turf is actually being
//      installed (e.g. 1728 Whitham Ave). The regex is now split into
//      TURF_GENERIC_PATTERN (plain "turf", "artificial grass", "synthetic
//      grass") and TURF_SPECIFIC_PATTERN (brand/product names: evergrass,
//      summer gold, platinum spring, arizona platinum). Scope-text scanning
//      uses ONLY the specific pattern, so an off-hand "turf" mention in
//      demolition or "sod installation" no longer triggers the prep card.
//      The materials-list check still uses the combined pattern —
//      third_party_materials rows are explicitly categorized, so any turf
//      signal there is authoritative. resolveThirdPartyInstallUrl() also
//      still uses the combined pattern for material-row URL routing.
//      Tru-Scapes detection is unchanged — "Tru-Scapes"/"TruScape" is a
//      specific brand mark with no ambiguous contexts, so scope-text
//      scanning for it remains safe.
//
//   9. [Phase 1B] Polygon overlay on the construction drawing. When a
//      proposal has labeled regions (proposal_regions, drawn in the
//      site-map labeling tool admin UI) AND a backdrop image with stored
//      native dimensions (proposals.site_plan_backdrop_url + width +
//      height), the public construction-drawing section renders the
//      backdrop with an SVG overlay on top. Each polygon is a clickable
//      anchor scrolling to its corresponding scope section (#section-{id})
//      when proposal_section_id is set; unlinked regions render as visual
//      markers only. When no regions are present, the existing
//      construction_drawing_url + lightbox-to-zoom behavior is preserved
//      byte-identical so the 40 already-published proposals are unchanged.
//
//  10. [Phase 1B.2] Two-column layout for the construction-drawing
//      polygon view (Condo Market SF pattern). Drawing sticks to the
//      left while a scrollable list of region cards runs down the right.
//      Each card shows the region name + the materials assigned to its
//      scope section, with bidirectional hover sync — hover a card →
//      the matching polygon highlights; hover a polygon → its card
//      highlights. Polygons get a louder treatment (thicker stroke,
//      higher fill opacity, brighter active state). Mobile collapses to
//      a single column with cards stacked under the drawing. Inline
//      script at the end of the section wires up the sync. No schema
//      changes; cards are derived from existing proposal_materials rows
//      filtered by proposal_section_id. The legacy construction_drawing_url
//      branch (no regions) is unchanged from Phase 1B.
//
//  11. [Phase 1B.3] Per-region material assignments via a proper
//      many-to-many join (proposal_region_materials, schema migration
//      phase_1b3_proposal_region_materials_join). The right-rail card
//      now prefers explicit assignments from the join table when they
//      exist — rendering only those materials in their stored
//      display_order. When a region has no assignments (legacy
//      regions, or regions Tim hasn't labeled with materials yet) it
//      falls back to the Phase 1B.2 behavior of listing every material
//      whose proposal_section_id matches the region's section. The
//      labeling tool admin UI grew a togglable-pill picker per region
//      card so Tim can assign materials directly without needing
//      proposal_materials.proposal_section_id to be set first. The
//      legacy proposals.construction_drawing_url branch (no regions)
//      is still unchanged.
//
//  12. [Phase 1B.4] Hybrid full-width site plan layout. The Phase
//      1B.2 two-column grid (sticky map left, scrolling region cards
//      right) is replaced by a single stacked column: full-width map
//      with polygon overlay, compact horizontal "region legend" strip
//      directly beneath, and the materials grid (formerly its own
//      Section 02) below that. The standalone "Selected materials"
//      section is suppressed when the proposal has labeled regions —
//      materials only appear once now, where they're spatially
//      relevant. Each material card carries usage chips ("Pavers",
//      "Pergola Paver Area") with the matching region color dot, and
//      data-region-ids drives the hover-sync IIFE: hover a card and
//      every polygon + legend row that maps to it lights up. Scope
//      of work also gets a typography pass — numbered eyebrow +
//      display-size section name + tabular-num price per row, with a
//      prominent grand total at the bottom and hairline-divider line
//      items inside each section instead of cream-card boxes. The
//      legacy construction_drawing_url branch (no regions) is still
//      unchanged.
//
//  13. [Phase 1B.5] Quality Standards section redesigned as a
//      horizontally scrollable rail showcasing every category Paver Portal
//      installs, not just the categories present in this specific bid.
//      Two data-layer changes feed it: loadInstallGuideData now
//      fetches every row from installation_guide_sections (instead of
//      filtering to the proposal's belgard categories), and the
//      proposalHasTurf / proposalHasTruScapesLighting predicates no
//      longer gate the third-party turf + lighting cards — both
//      always render. categoryToSection (used by per-material
//      "Installation guide" deep-links) stays bid-filtered since its
//      job is unchanged. UI: cards live in a flex rail with
//      scroll-snap-type: x mandatory and fixed 380px-wide cards;
//      gradient fades on the rail edges + circular chevron arrow
//      buttons absolutely positioned over the fade zones provide
//      explicit nav. The arrow buttons disable themselves at the
//      rail's start/end via an inline IIFE. Mobile hides the arrows,
//      narrows cards to 320px, and lets touch scroll do the work.
//
//  14. [Phase 1B.6] Cohesion pass on Sections 04, 05, footer CTAs,
//      and bottom strip — bringing them up to the Phase 1B.4/1B.5
//      luxe baseline. Photo group labels (formerly green
//      eyebrow-style 12px) now render as a navy 18px sub-heading
//      with a tabular-num "N photos" count to the right, separated
//      from the next group by a hairline divider — same rhythm as
//      the Phase 1B.4 materials grid. Photo cards get the 14px
//      border-radius + hover lift that material cards introduced.
//      Footer CTAs gain a "What happens next" eyebrow for section
//      identity, the call/email buttons invert to navy fill on hover
//      (was a flat translate), and the lede paragraph caps at 520px
//      so it doesn't sprawl. The bottom byline ("Proposal prepared
//      by…") becomes a JetBrains Mono uppercase mark rather than
//      plain text, finishing the page with an editorial signature.
//
//  15. [Phase 1B.7] Material Type eyebrow + compelling final CTA.
//      Each material card now renders a small mono-caps eyebrow
//      above the product name (e.g. "PAVERS", "RETAINING WALL",
//      "DECKING") so the buyer immediately registers what kind of
//      product each card represents. Belgard rows resolve their
//      type from belgard_categories.name (loaded via a new parallel
//      fetch in the materials loader); third-party rows use
//      third_party_materials.category. Long category names are
//      hand-mapped to short labels by formatMaterialType.
//
//      The footer CTA is replaced wholesale: navy hero panel with a
//      headline that surfaces the 5% Immediate Start Discount and
//      its dollar amount, a 48-hour countdown (hours/min/sec) that
//      ticks per-viewer (deadline persisted in localStorage keyed by
//      slug, so each visitor gets their own 48 hours from first
//      sight), and a prominent green "Ready to sign — send for
//      signatures" button. Click opens a modal with name/email/
//      phone/message form that POSTs to /api/sign-intent, which
//      inserts a row into the new signature_intents table and
//      best-effort emails Tim via Resend (skipped silently if
//      RESEND_API_KEY / RESEND_FROM_EMAIL aren't configured — the
//      table row is the source of truth either way). On expiration
//      the timer freezes at 00:00:00 and an explanatory message
//      appears; the sign button still works, just without the
//      discount messaging. Tertiary "Or reach Tim directly" links
//      (call / email / installation guide) preserve the prior
//      footer's affordances beneath the main CTA.
//
// Preserved from Sprint 1 / Sprint 1.5:
//   • Hero picker grid (bid-PDF-extracted + manually uploaded images)
//   • Hero banner at top of published page
//   • Materials grouped by application_area with 4:3 aspect cards
//   • Cut sheet + install guide action buttons on each card
//   • Publish / slug / history infrastructure
//   • Section order: header → hero → loom → 01 drawing → 02 scope
//     → 03 materials → 04 why prep → 05 photos → footer CTAs
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';

// Paver Portal-branded installation guide PDF — remains the bottom footer CTA.
// This is the client-facing "Here's how we install" document.
const INSTALL_GUIDE_URL = '/account/';

// Belgard master Product Installation Guide — the 110+ page PDF we parsed
// in Sprint 2 Part B.1. Used for page-anchored deep links per section since
// its pagination is what installation_guide_sections.page_start references.
const BELGARD_MASTER_INSTALL_GUIDE_URL = 'https://www.belgard.com/wp-content/uploads/2025/05/Product-Installation-Guide_WEB_BEL24-D-298050.pdf';

// Third-party install / product guide URLs — referenced from the dynamic
// "Why preparation matters" cards when the proposal uses turf or Tru-Scapes
// lighting. Keep these here rather than in-line so Tim can swap the hosting
// location (Webflow CDN, Supabase Storage, manufacturer URL) in one place.
const EVERGRASS_INSTALL_GUIDE_URL = 'https://cdn.msisurfaces.com/files/flyers/evergrass-artificial-turf-pavers.pdf';
const TRU_SCAPES_PRODUCT_GUIDE_URL = 'https://cdn.prod.website-files.com/65a1ca4354f63bd7376b5027/69e99762031d43f432f14cde_Tru%20Scapes-compressed.pdf';

const PAVER PORTAL_LOGO_URL = '/assets/paver-portal-logo.svg';
const TIM_PHONE = '415-691-9272';
const TIM_PHONE_HREF = '+14156919272';
const TIM_EMAIL = 'tim@mcmullen.properties';
const BUCKET = 'proposal-photos';

let proposalId = null;
let container = null;
let onSaveCb = null;
let currentData = null; // { proposal, sections, materials, photos, heroCandidates, drawingCandidates, history, installSections, categoryToSection, regions }

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────
export async function initPublish(opts) {
  proposalId = opts.proposalId;
  container = opts.container;
  onSaveCb = opts.onSave || (() => {});

  renderShell();
  await reload();
}

// ───────────────────────────────────────────────────────────────────────────
// Data loading — manual joins to avoid PostgREST FK ambiguity
// ───────────────────────────────────────────────────────────────────────────
async function reload() {
  setStatus('Loading…');

  // heroCandidates query: all property_condition images (extracted + manual),
  // since those are the viable hero sources. Small bid_pdf_asset images are
  // excluded to keep the picker grid readable.
  //
  // drawingCandidates query: ALL proposal_images for this proposal, regardless
  // of category. The construction drawing can come from a PDF extraction
  // (bid_pdf_asset) OR a manual upload in any category, so we don't filter —
  // we just present everything sorted with extracted-images first, then uploads.
  //
  // regions query (Phase 1B): proposal_regions for this proposal, in
  // display_order. When the proposal has a labeled site-map backdrop, these
  // become the polygon overlay rendered on top of the construction drawing
  // on the published page.
  //
  // Phase 1B.3: the regions query now also embeds proposal_region_materials
  // via PostgREST so each region carries its explicit material assignments
  // (with display_order) inline. When that array is non-empty, the right-rail
  // card renders only those materials in order; when empty, the Phase 1B.2
  // section-filter fallback kicks in. The dev_all_proposal_region_materials
  // RLS policy mirrors proposal_regions so anon read works the same way.
  const [proposalQ, sectionsQ, materialsQ, photosQ, heroCandidatesQ, drawingCandidatesQ, historyQ, regionsQ] = await Promise.all([
    supabase.from('proposals').select('*').eq('id', proposalId).single(),
    supabase.from('proposal_sections').select('*').eq('proposal_id', proposalId)
      .order('display_order', { ascending: true }),
    supabase.from('proposal_materials').select('*')
      .eq('proposal_id', proposalId).order('display_order', { ascending: true }),
    supabase.from('proposal_images').select('*').eq('proposal_id', proposalId)
      .eq('category', 'property_condition')
      .order('display_order', { ascending: true }),
    supabase.from('proposal_images').select('*').eq('proposal_id', proposalId)
      .eq('category', 'property_condition')
      .order('width', { ascending: false, nullsFirst: false }),
    supabase.from('proposal_images').select('*').eq('proposal_id', proposalId)
      .order('extraction_source', { ascending: true })
      .order('source_page', { ascending: true, nullsFirst: false }),
    supabase.from('published_proposals').select('id, slug, title, published_at')
      .eq('proposal_id', proposalId).order('published_at', { ascending: false }),
    supabase.from('proposal_regions')
      .select('*, region_materials:proposal_region_materials(proposal_material_id, display_order)')
      .eq('proposal_id', proposalId)
      .order('display_order', { ascending: true }),
  ]);

  const err = proposalQ.error || sectionsQ.error || materialsQ.error
    || photosQ.error || heroCandidatesQ.error || drawingCandidatesQ.error
    || historyQ.error || regionsQ.error;
  if (err) {
    setStatus('');
    showError('Could not load data: ' + err.message);
    return;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Phase 3B.1 — single unified materials query.
  //
  // Replaces the prior parallel belgard_materials + third_party_materials
  // queries with one read against the unified `materials` table (which holds
  // both manufacturer types preserving original UUIDs). The result is
  // shimmed back into the prior `belgard_material` / `third_party_material`
  // shape so the 3000+ lines of render code below — renderMaterialCard,
  // extractMaterialInfo, the turf/Tru-Scapes detection helpers — keep
  // working byte-identical.
  //
  // Partitioning is by the unified row's `manufacturer` column (Belgard vs
  // anything else). The per-material `material_source` discriminator on
  // proposal_materials remains authoritative for rendering branches.
  // ───────────────────────────────────────────────────────────────────────
  const rawMaterials = materialsQ.data || [];
  const allCatalogIds = [...new Set([
    ...rawMaterials.filter(m => m.belgard_material_id).map(m => m.belgard_material_id),
    ...rawMaterials.filter(m => m.third_party_material_id).map(m => m.third_party_material_id),
  ])];

  const [materialsCatalogQ, categoriesQ] = await Promise.all([
    allCatalogIds.length
      ? supabase.from('materials').select('*').in('id', allCatalogIds)
      : Promise.resolve({ data: [], error: null }),
    // Phase 1B.7 — small lookup table; fetch all so we can resolve any
    // material's category_id to its display name without a second
    // round-trip per material.
    supabase.from('belgard_categories').select('id, name'),
  ]);

  if (materialsCatalogQ.error) {
    setStatus('');
    showError('Could not load materials catalog: ' + materialsCatalogQ.error.message);
    return;
  }

  const belgardCategoryMap = new Map(
    (categoriesQ.data || []).map(c => [c.id, c.name])
  );
  const unifiedById = new Map((materialsCatalogQ.data || []).map(m => [m.id, m]));

  // Build the prior-shape shim. When proposal_materials.belgard_material_id is
  // set, the corresponding unified row gets shaped as `belgard_material`
  // (with category_name resolved). When third_party_material_id is set, the
  // unified row gets passed through as `third_party_material`. Edge case
  // (both FKs set) preserved from original behavior — both fields populated.
  const materials = rawMaterials.map(m => {
    let belgardMaterial = null;
    let thirdPartyMaterial = null;
    if (m.belgard_material_id) {
      const row = unifiedById.get(m.belgard_material_id);
      if (row) {
        belgardMaterial = {
          ...row,
          category_name: belgardCategoryMap.get(row.category_id) || '',
        };
      }
    }
    if (m.third_party_material_id) {
      const row = unifiedById.get(m.third_party_material_id);
      if (row) thirdPartyMaterial = row;
    }
    return {
      ...m,
      belgard_material: belgardMaterial,
      third_party_material: thirdPartyMaterial,
    };
  });

  // Belgard-only subset for loadInstallGuideData (which expects rows with
  // category_id, used to load installation_guide_sections via the
  // installation_guide_section_categories join). Filtering by manufacturer
  // matches the prior behavior of passing belgardQ.data only.
  const belgardCatalogRows = (materialsCatalogQ.data || [])
    .filter(row => row.manufacturer === 'Belgard');

  // ───────────────────────────────────────────────────────────────────────
  // Sprint 2 Part B.2: load install guide sections for the Belgard categories
  // present in this proposal's materials. Powers the dynamic "Why preparation
  // matters" section and per-material page-anchored install guide CTAs.
  //
  // Third-party materials are NOT included here — the install guide was
  // parsed from Belgard's master PDF and its page numbers only apply to
  // Belgard products. Third-party materials retain prior behavior.
  // ───────────────────────────────────────────────────────────────────────
  const { installSections, categoryToSection } = await loadInstallGuideData(belgardCatalogRows);

  currentData = {
    proposal: proposalQ.data,
    sections: sectionsQ.data || [],
    materials,
    photos: photosQ.data || [],
    heroCandidates: heroCandidatesQ.data || [],
    drawingCandidates: drawingCandidatesQ.data || [],
    history: historyQ.data || [],
    installSections,
    categoryToSection,
    regions: regionsQ.data || [],
  };

  renderBody();
  setStatus('');
}

async function loadInstallGuideData(belgardRows) {
  // Phase 1B.4 — fetch ALL install guide sections for the Quality
  // Standards rail. The section is now a showcase of every category
  // Paver Portal installs, not just what's in this bid, so the unfiltered
  // sections feed renderWhyPrepSection. categoryToSection (built below)
  // remains bid-filtered because it powers the deep-link from each
  // per-material "Installation guide" button to its matching section.
  const { data: allSectionsData, error: allSectionsErr } = await supabase
    .from('installation_guide_sections')
    .select('*');

  if (allSectionsErr) {
    console.error('Could not load install guide sections:', allSectionsErr);
    return { installSections: [], categoryToSection: new Map() };
  }
  const installSections = allSectionsData || [];

  const usedCategoryIds = [...new Set(
    belgardRows.map(b => b.category_id).filter(Boolean)
  )];

  if (usedCategoryIds.length === 0) {
    return { installSections, categoryToSection: new Map() };
  }

  // Fetch the join-table rows that link a category to a section
  const { data: linksData, error: linksErr } = await supabase
    .from('installation_guide_section_categories')
    .select('section_id, category_id')
    .in('category_id', usedCategoryIds);

  if (linksErr) {
    // Non-fatal — categoryToSection just stays empty, so per-material
    // install buttons fall back to the generic guide URL. The Quality
    // Standards rail is unaffected since it doesn't use this map.
    console.error('Could not load install guide category links:', linksErr);
    return { installSections, categoryToSection: new Map() };
  }

  const linkRows = linksData || [];
  const sectionById = new Map(installSections.map(s => [s.id, s]));

  const categoryToSection = new Map();
  for (const link of linkRows) {
    const section = sectionById.get(link.section_id);
    if (section) categoryToSection.set(link.category_id, section);
  }

  return { installSections, categoryToSection };
}

// ───────────────────────────────────────────────────────────────────────────
// UI shell (static)
// ───────────────────────────────────────────────────────────────────────────
function renderShell() {
  container.innerHTML = `
    <style>
      /* Hero picker */
      .bp-hero-picker-section {
        margin-bottom: 32px;
        padding: 20px 22px;
        background: #fff;
        border: 1px solid #e5e5e5;
        border-radius: 10px;
      }
      .bp-hero-picker-header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 4px;
        gap: 12px;
      }
      .bp-hero-picker-label {
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #353535;
        font-weight: 700;
      }
      .bp-hero-picker-count {
        font-size: 12px;
        color: #999;
      }
      .bp-hero-picker-hint {
        font-size: 13px;
        color: #666;
        margin-bottom: 14px;
        line-height: 1.5;
      }
      .bp-hero-picker-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 10px;
      }
      .bp-hero-picker-item {
        position: relative;
        aspect-ratio: 4 / 3;
        border-radius: 6px;
        overflow: hidden;
        cursor: pointer;
        background: #faf8f3;
        border: 2px solid transparent;
        transition: border-color 0.15s, transform 0.15s;
      }
      .bp-hero-picker-item:hover {
        border-color: #c9d3cb;
        transform: translateY(-1px);
      }
      .bp-hero-picker-item.is-selected {
        border-color: #9c7440;
        box-shadow: 0 0 0 3px rgba(93, 126, 105, 0.15);
      }
      .bp-hero-picker-item img {
        width: 100%; height: 100%;
        object-fit: cover;
        display: block;
      }
      .bp-hero-picker-badge {
        position: absolute;
        top: 8px; left: 8px;
        padding: 3px 7px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        border-radius: 3px;
        background: #9c7440;
        color: #fff;
      }
      .bp-hero-picker-source {
        position: absolute;
        bottom: 6px; right: 6px;
        padding: 2px 6px;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        border-radius: 3px;
        background: rgba(0,0,0,0.55);
        color: #fff;
      }
      .bp-hero-picker-empty {
        padding: 28px 20px;
        text-align: center;
        background: #faf8f3;
        border: 1px dashed #d5d5d5;
        border-radius: 8px;
        color: #666;
        font-size: 14px;
        line-height: 1.5;
      }
      .bp-hero-picker-clear {
        display: inline-block;
        margin-top: 10px;
        font-size: 12px;
        color: #b04040;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        text-decoration: underline;
      }
      .bp-hero-picker-clear:hover { color: #8a2020; }
    </style>

    <div class="section-header">
      <span class="eyebrow">Section 06</span>
      <h2>Preview &amp; publish</h2>
    </div>

    <div class="bp-publish">
      <div class="bp-hero-picker-section" id="bpHeroPickerSection">
        <div class="bp-hero-picker-header">
          <span class="bp-hero-picker-label">Hero image</span>
          <span class="bp-hero-picker-count" id="bpHeroCount"></span>
        </div>
        <p class="bp-hero-picker-hint">
          Click any image to set it as the full-width banner at the top of the published proposal.
          Images come from the bid PDF (auto-extracted) or from Section 05 (manual uploads).
        </p>
        <div id="bpHeroPickerGrid"></div>
      </div>

      <div class="bp-hero-picker-section" id="bpDrawingPickerSection">
        <div class="bp-hero-picker-header">
          <span class="bp-hero-picker-label">Construction drawing</span>
          <span class="bp-hero-picker-count" id="bpDrawingCount"></span>
        </div>
        <p class="bp-hero-picker-hint">
          Click any image to feature it as the project's construction drawing — it renders
          in its own framed section between the hero and the scope of work on the published page.
          Pulls from every image attached to this proposal (extracted + uploaded).
        </p>
        <div id="bpDrawingPickerGrid"></div>
      </div>

      <div class="bp-publish-loom-row">
        <label class="bp-publish-loom-label">
          Loom walkthrough URL
          <input type="url" id="bpPublishLoom" class="bp-publish-loom-input"
            placeholder="https://www.loom.com/share/...">
        </label>
        <p class="bp-publish-loom-hint">
          Paste a Loom share link. Optional — if set, the video appears in the
          hero of the published page.
        </p>
      </div>

    <div style="margin-bottom:24px;padding:16px 20px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
          <input type="checkbox" id="bpPublishShowDiscount" style="width:16px;height:16px;flex-shrink:0;margin-top:2px;">
          <span style="font-size:14px;font-weight:600;color:#353535;line-height:1.4;">Show signing-discount countdown timer (48-hour 5% off)</span>
        </label>
        <p style="font-size:13px;color:#666;margin:8px 0 0 26px;line-height:1.5;">
          When checked, the published page shows a 48-hour countdown with the Immediate Start Discount messaging at the bottom. Uncheck to publish without the timer — the sign button and contact info remain. Changes apply on next publish.
        </p>
      </div>

    <div style="margin-bottom:24px;padding:18px 20px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;">
      <label for="bpPublishChangeNote" style="display:block;font-size:14px;font-weight:600;color:#353535;line-height:1.4;margin-bottom:6px;">
        What changed in this version? <span style="font-weight:400;color:#999;">— optional</span>
      </label>
      <p style="font-size:13px;color:#666;margin:0 0 10px;line-height:1.5;">
        When set, the homeowner sees a "What's new in this version" banner at the top of the proposal explaining your changes. Also included in the auto-email when the "Email client about this update" box below is checked. Leave blank for typo-fix republishes that don't need a callout.
      </p>
      <textarea id="bpPublishChangeNote" rows="3" placeholder="e.g. Reduced backyard paver area to bring total under $120K. Swapped to Belgard Catalina for better tonal match with house. Added retaining wall at upper tier."
        style="width:100%;padding:10px 12px;border:1px solid #d4d0c2;border-radius:6px;font-family:inherit;font-size:14px;line-height:1.5;color:#353535;resize:vertical;box-sizing:border-box;"></textarea>
    </div>

      <div class="bp-publish-actions">
        <div>
          <div class="bp-publish-next-slug-label">Next publish URL</div>
          <code id="bpPublishNextSlug" class="bp-publish-next-slug">…</code>
         <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;font-weight:500;color:#353535;cursor:pointer;text-transform:none;letter-spacing:normal;">
            <input type="checkbox" id="bpPublishNotify" checked style="width:14px;height:14px;flex-shrink:0;">
            <span>Email client about this update</span>
          </label>
        </div>
        <div class="bp-publish-action-btns">
          <button id="bpPublishRefresh" class="bp-publish-refresh-btn">
            Refresh preview
          </button>
          <button id="bpPublishBtn" class="bp-publish-btn">
            Publish new version
          </button>
        </div>
      </div>

      <div id="bpPublishStatus" class="bp-publish-status"></div>

      <div class="bp-publish-preview-wrap">
        <div class="bp-publish-preview-header">
          <span class="eyebrow">Preview</span>
          <span class="bp-publish-preview-note">
            This is what will be published.
          </span>
        </div>
        <iframe id="bpPublishPreview" class="bp-publish-preview-iframe"
          sandbox="allow-same-origin"></iframe>
      </div>

      <div class="bp-publish-history-wrap">
        <div class="section-header">
          <span class="eyebrow">Version history</span>
          <h3>Published versions</h3>
        </div>
        <div id="bpPublishHistory" class="bp-publish-history"></div>
      </div>
    </div>
  `;

  document.getElementById('bpPublishBtn')
    .addEventListener('click', handlePublish);
  document.getElementById('bpPublishRefresh')
    .addEventListener('click', () => reload());
  document.getElementById('bpPublishLoom')
    .addEventListener('input', handleLoomInput);
  document.getElementById('bpPublishShowDiscount')
    .addEventListener('change', handleShowDiscountToggle);
}

// ───────────────────────────────────────────────────────────────────────────
// UI body (dynamic — runs after data load)
// ───────────────────────────────────────────────────────────────────────────
function renderBody() {
  const { proposal, history } = currentData;

  document.getElementById('bpPublishLoom').value = proposal.loom_url || '';
  document.getElementById('bpPublishShowDiscount').checked =
    proposal.show_signing_discount !== false;
  // Phase 6.5 — change-note is per-publish (not persisted on the proposal),
  // so always start blank on each editor load. This matches typo-fix
  // workflow: open editor → fix → publish without re-typing a stale note.
  document.getElementById('bpPublishChangeNote').value = '';

  const nextSlug = slugifyBase(proposal.project_address, new Date());
  const origin = window.location.origin;
  document.getElementById('bpPublishNextSlug').textContent =
    `${origin}/p/${nextSlug}`;

  renderHeroPicker();
  renderDrawingPicker();
  renderHistory(history, origin);
  renderPreview();
}

function renderHeroPicker() {
  const { heroCandidates, proposal } = currentData;
  const grid = document.getElementById('bpHeroPickerGrid');
  const count = document.getElementById('bpHeroCount');

  const heroUrl = proposal.hero_image_url || null;

  count.textContent = heroCandidates.length > 0
    ? `${heroCandidates.length} image${heroCandidates.length === 1 ? '' : 's'} available`
    : '';

  if (heroCandidates.length === 0) {
    grid.innerHTML = `
      <div class="bp-hero-picker-empty">
        <strong>No images yet.</strong><br>
        Commit a bid PDF in Section 02 to auto-extract images, or upload photos in Section 05.
      </div>
    `;
    return;
  }

  const items = heroCandidates.map(img => {
    const thumb = img.thumbnail_path ? publicUrl(img.thumbnail_path) : publicUrl(img.storage_path);
    const full = publicUrl(img.storage_path);
    const isSelected = heroUrl && full === heroUrl;
    const sourceBadge = img.extraction_source === 'bid_pdf_extract'
      ? `<div class="bp-hero-picker-source">PDF${img.source_page ? ' p.' + img.source_page : ''}</div>`
      : `<div class="bp-hero-picker-source">Uploaded</div>`;

    return `
      <div class="bp-hero-picker-item ${isSelected ? 'is-selected' : ''}"
           data-url="${escapeAttr(full)}">
        <img src="${escapeAttr(thumb)}" alt="" loading="lazy">
        ${isSelected ? `<div class="bp-hero-picker-badge">Hero</div>` : ''}
        ${sourceBadge}
      </div>
    `;
  }).join('');

  const clearBtn = heroUrl
    ? `<button type="button" class="bp-hero-picker-clear" id="bpHeroClear">Clear hero selection</button>`
    : '';

  grid.innerHTML = `<div class="bp-hero-picker-grid">${items}</div>${clearBtn}`;

  // Wire up click-to-select
  grid.querySelectorAll('.bp-hero-picker-item').forEach(el => {
    el.addEventListener('click', () => setHero(el.dataset.url));
  });

  const clearEl = grid.querySelector('#bpHeroClear');
  if (clearEl) clearEl.addEventListener('click', () => setHero(null));
}

async function setHero(url) {
  // Save immediately — no debounce needed, clicks are discrete events.
  const { error } = await supabase
    .from('proposals')
    .update({ hero_image_url: url || null })
    .eq('id', proposalId);

  if (error) {
    showError(`Could not set hero: ${error.message}`);
    return;
  }

  if (currentData) currentData.proposal.hero_image_url = url || null;
  renderHeroPicker();
  renderPreview();
  onSaveCb();
}

// ───────────────────────────────────────────────────────────────────────────
// Construction drawing picker (Sprint 3 Part D)
//
// Identical pattern to the hero picker, but backed by a separate DB column
// (proposals.construction_drawing_url, added in migration 014). Pulls from
// ALL proposal_images — the drawing can be extracted from the bid PDF or
// uploaded manually in any category, so we don't filter at the query level.
// ───────────────────────────────────────────────────────────────────────────
function renderDrawingPicker() {
  const { drawingCandidates, proposal } = currentData;
  const grid = document.getElementById('bpDrawingPickerGrid');
  const count = document.getElementById('bpDrawingCount');

  const drawingUrl = proposal.construction_drawing_url || null;

  count.textContent = drawingCandidates.length > 0
    ? `${drawingCandidates.length} image${drawingCandidates.length === 1 ? '' : 's'} available`
    : '';

  if (drawingCandidates.length === 0) {
    grid.innerHTML = `
      <div class="bp-hero-picker-empty">
        <strong>No images yet.</strong><br>
        Commit a bid PDF in Section 02 to auto-extract images, or upload photos in Section 05.
      </div>
    `;
    return;
  }

  const items = drawingCandidates.map(img => {
    const thumb = img.thumbnail_path ? publicUrl(img.thumbnail_path) : publicUrl(img.storage_path);
    const full = publicUrl(img.storage_path);
    const isSelected = drawingUrl && full === drawingUrl;
    const sourceBadge = img.extraction_source === 'bid_pdf_extract'
      ? `<div class="bp-hero-picker-source">PDF${img.source_page ? ' p.' + img.source_page : ''}</div>`
      : `<div class="bp-hero-picker-source">Uploaded</div>`;

    return `
      <div class="bp-hero-picker-item ${isSelected ? 'is-selected' : ''}"
           data-url="${escapeAttr(full)}">
        <img src="${escapeAttr(thumb)}" alt="" loading="lazy">
        ${isSelected ? `<div class="bp-hero-picker-badge">Drawing</div>` : ''}
        ${sourceBadge}
      </div>
    `;
  }).join('');

  const clearBtn = drawingUrl
    ? `<button type="button" class="bp-hero-picker-clear" id="bpDrawingClear">Clear drawing selection</button>`
    : '';

  grid.innerHTML = `<div class="bp-hero-picker-grid">${items}</div>${clearBtn}`;

  grid.querySelectorAll('.bp-hero-picker-item').forEach(el => {
    el.addEventListener('click', () => setDrawing(el.dataset.url));
  });

  const clearEl = grid.querySelector('#bpDrawingClear');
  if (clearEl) clearEl.addEventListener('click', () => setDrawing(null));
}

async function setDrawing(url) {
  const { error } = await supabase
    .from('proposals')
    .update({ construction_drawing_url: url || null })
    .eq('id', proposalId);

  if (error) {
    showError(`Could not set construction drawing: ${error.message}`);
    return;
  }

  if (currentData) currentData.proposal.construction_drawing_url = url || null;
  renderDrawingPicker();
  renderPreview();
  onSaveCb();
}

function renderHistory(history, origin) {
  const el = document.getElementById('bpPublishHistory');
  if (!history.length) {
    el.innerHTML = `
      <p class="bp-publish-history-empty">
        No versions published yet. Click <strong>Publish new version</strong>
        above to create the first one.
      </p>
    `;
    return;
  }

  el.innerHTML = history.map(h => {
    const url = `${origin}/p/${h.slug}`;
    const when = formatDateTime(h.published_at);
    return `
      <div class="bp-publish-history-item">
        <div class="bp-publish-history-item-info">
          <div class="bp-publish-history-item-slug">/p/${escapeHtml(h.slug)}</div>
          <div class="bp-publish-history-item-date">${escapeHtml(when)}</div>
        </div>
        <div class="bp-publish-history-item-actions">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener"
            class="bp-publish-history-btn bp-publish-history-btn-open">Open ↗</a>
          <button class="bp-publish-history-btn bp-publish-history-btn-copy"
            data-url="${escapeHtml(url)}">Copy URL</button>
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.bp-publish-history-btn-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.url);
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    });
  });
}

function renderPreview() {
  const html = buildHtmlSnapshot(currentData);
  const iframe = document.getElementById('bpPublishPreview');
  iframe.srcdoc = html;
}

// ───────────────────────────────────────────────────────────────────────────
// Auto-save handler for Loom URL (debounced)
// ───────────────────────────────────────────────────────────────────────────
let loomSaveTimer = null;

// Phase 6.4B — handler for the show-discount toggle. Saves to DB, mirrors
// into currentData so subsequent renderPreview() calls reflect the change,
// and re-renders the iframe preview so the toggle takes effect immediately.
// The actual published HTML updates only on the next "Publish new version"
// click — the iframe preview is a live render of buildHtmlSnapshot() with
// the current flag state.
async function handleShowDiscountToggle(e) {
  const value = !!e.target.checked;
  const { error } = await supabase
    .from('proposals')
    .update({ show_signing_discount: value })
    .eq('id', proposalId);
  if (error) {
    showError(`Could not save discount toggle: ${error.message}`);
    e.target.checked = !value;
    return;
  }
  if (currentData) currentData.proposal.show_signing_discount = value;
  renderPreview();
  onSaveCb();
}

// Phase 6.4B — sends an "Updated proposal" email to the linked client via
// the existing /api/send-follow-up endpoint. Uses template_kind='custom'
// (already accepted) and force=true to bypass the 7-day dedup window
// (republishes are legitimate update notifications, not spam). Status is
// reflected inline in the publish-status line; failures are non-blocking
// — the publish itself is already complete by the time this runs.
async function sendPublishNotification(slug, changeNote) {
  const proposal = currentData.proposal;
  const fullName = (proposal.client_name || '').trim();
  const firstName = fullName ? fullName.split(/\s+/)[0] : 'there';
  const address = proposal.project_address || 'your project';

  setStatus(`Published! Notifying client…`, 'ok');

  let token = null;
  try {
    const sess = await supabase.auth.getSession();
    token = sess && sess.data && sess.data.session && sess.data.session.access_token;
  } catch (e) {}
  if (!token) {
    setStatus(`Published at /p/${slug} — but couldn't get auth token to email client.`, 'ok');
    return;
  }

  // Phase 6.5 — when a change_note is set, include it verbatim in the email
  // body so the homeowner gets the "what changed" message in their inbox
  // (not just on the page). When no note is set, use the original generic
  // email — preserves typo-fix-republish flow without spamming the client
  // with empty "I made changes" notes.
  const subject = `Updated proposal — ${address}`;
  const body = changeNote
    ? `Hi ${firstName},\n\n` +
      `I've put together an updated version of your proposal for ${address}. Here's what changed:\n\n` +
      `${changeNote}\n\n` +
      `Take a look and let me know if you have any questions or want to discuss any of these changes.`
    : `Hi ${firstName},\n\n` +
      `I've put together an updated version of your proposal for ${address}. ` +
      `Take a look and let me know if you have any questions or want to discuss any of the changes.`;

  try {
    const resp = await fetch('/api/send-follow-up', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({
        proposal_id: proposalId,
        template_kind: 'custom',
        subject,
        body,
        force: true,
      }),
    });
    const result = await resp.json().catch(() => ({}));
    if (resp.ok && result.ok) {
      setStatus(`Published at /p/${slug} & emailed client at ${maskEmail(result.recipient_email)}`, 'ok');
    } else {
      const msg = (result && result.error) || `HTTP ${resp.status}`;
      setStatus(`Published at /p/${slug} — but couldn't email client: ${msg}`, 'ok');
    }
  } catch (err) {
    setStatus(`Published at /p/${slug} — but notify request failed: ${(err && err.message) || 'network error'}`, 'ok');
  }
}

function maskEmail(email) {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at < 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const masked = local.length <= 2 ? local : local[0] + '***' + local.slice(-1);
  return masked + domain;
}

function handleLoomInput(e) {
  const val = e.target.value.trim();
  clearTimeout(loomSaveTimer);
  loomSaveTimer = setTimeout(async () => {
    const { error } = await supabase
      .from('proposals')
      .update({ loom_url: val || null })
      .eq('id', proposalId);
    if (error) {
      showError(`Could not save loom_url: ${error.message}`);
      return;
    }
    if (currentData) currentData.proposal.loom_url = val || null;
    renderPreview();
    onSaveCb();
  }, 600);
}

// ───────────────────────────────────────────────────────────────────────────
// Publish action
// ───────────────────────────────────────────────────────────────────────────
export async function handlePublish() {
  if (!currentData) return;

  const btn = document.getElementById('bpPublishBtn');
  btn.disabled = true;
  btn.textContent = 'Publishing…';
  setStatus('Generating snapshot…');

  try {
    // Phase 6.5 — canonical-slug publish flow. Replaces "always INSERT a
    // new dated row" with: ensure a canonical row exists at a stable URL,
    // UPDATE it on republish, AND insert a dated historical snapshot so
    // homeowners can compare to prior versions.
    //
    // First publish: no canonical row exists yet → generate canonical_slug
    // (e.g. "88-prospect-ave"), save to proposals table, INSERT new
    // published_proposals row with is_canonical=true, version_number=1.
    //
    // Republish: canonical row exists → INSERT a dated historical snapshot
    // (is_canonical=false, version_number=N+1) preserving the prior
    // canonical state, then UPDATE the canonical row with the new
    // html_snapshot, change_note, and bumped published_at. Homeowners
    // bookmarked at /p/{canonical_slug} always see the latest, and the
    // historical row is reachable for "view previous version" links.
    const proposal = currentData.proposal;
    const changeNote = (document.getElementById('bpPublishChangeNote').value || '').trim() || null;
    const title = proposal.project_address
      || proposal.client_name
      || 'Paver Portal proposal';
    const totalAmount = proposal.bid_total_amount || null;

    // Look up the existing canonical row, if any.
    const { data: canonRows, error: canonErr } = await supabase
      .from('published_proposals')
      .select('id, slug, html_snapshot, change_note, version_number')
      .eq('proposal_id', proposalId)
      .eq('is_canonical', true)
      .limit(1);
    if (canonErr) throw canonErr;
    const existingCanonical = (canonRows && canonRows[0]) || null;

    // Resolve canonical_slug — generated once on first publish, persisted
    // on the proposals row, never changes thereafter. Uses the same
    // slugifyBase() generator as historical slugs but without a date
    // suffix.
    let canonicalSlug = proposal.canonical_slug;
    if (!canonicalSlug) {
      canonicalSlug = await allocateCanonicalSlug(proposal);
      const { error: canonSlugErr } = await supabase
        .from('proposals')
        .update({ canonical_slug: canonicalSlug })
        .eq('id', proposalId);
      if (canonSlugErr) throw canonSlugErr;
      proposal.canonical_slug = canonicalSlug;
    }

    // Build the snapshot HTML *with the change note baked in*. The change
    // note is rendered as a banner at the top of the published page.
    const html = buildHtmlSnapshot({ ...currentData, changeNote });

    if (!existingCanonical) {
      // First publish — create canonical row at the stable URL.
      const { error: insErr } = await supabase
        .from('published_proposals')
        .insert({
          proposal_id: proposalId,
          slug: canonicalSlug,
          html_snapshot: html,
          title,
          project_address: proposal.project_address || null,
          total_amount: totalAmount,
          is_canonical: true,
          version_number: 1,
          change_note: changeNote,
        });
      if (insErr) throw insErr;
      setStatus(`Published! Live at ${window.location.origin}/p/${canonicalSlug}`, 'ok');
    } else {
      // Republish — preserve the prior version as a dated historical row,
      // then UPDATE the canonical row in place. Note that the historical
      // row's change_note is the prior version's note, not the incoming
      // one — preserves "what was current when this version was live."
      const dateSuffix = await allocateSlug(proposal); // dated slug
      const { error: histErr } = await supabase
        .from('published_proposals')
        .insert({
          proposal_id: proposalId,
          slug: dateSuffix,
          html_snapshot: existingCanonical.html_snapshot,
          title,
          project_address: proposal.project_address || null,
          total_amount: totalAmount,
          is_canonical: false,
          version_number: existingCanonical.version_number,
          change_note: existingCanonical.change_note,
        });
      if (histErr) throw histErr;

      const { error: updErr } = await supabase
        .from('published_proposals')
        .update({
          html_snapshot: html,
          title,
          project_address: proposal.project_address || null,
          total_amount: totalAmount,
          version_number: existingCanonical.version_number + 1,
          change_note: changeNote,
          published_at: new Date().toISOString(),
        })
        .eq('id', existingCanonical.id);
      if (updErr) throw updErr;

      setStatus(`Published v${existingCanonical.version_number + 1}! Live at ${window.location.origin}/p/${canonicalSlug}`, 'ok');
    }

    // Phase 6.4B — optionally email the linked client about this update.
    // Phase 6.5 — also pass changeNote so the email body can include it.
    const notifyEl = document.getElementById('bpPublishNotify');
    if (notifyEl && notifyEl.checked) {
      await sendPublishNotification(canonicalSlug, changeNote);
    }

    await reload();
    onSaveCb();
  } catch (err) {
    showError('Publish failed: ' + (err.message || String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Publish new version';
  }
}

async function allocateSlug(proposal) {
  const base = slugifyBase(proposal.project_address, new Date());

  const { data: existing, error } = await supabase
    .from('published_proposals')
    .select('slug')
    .like('slug', `${base}%`);

  if (error) throw error;
  const taken = new Set((existing || []).map(r => r.slug));
  if (!taken.has(base)) return base;

  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Phase 6.5 — canonical slug allocator. Like slugifyBase but without the
// date suffix. The canonical slug is the proposal's permanent URL, used
// only on first publish (afterward stored on proposals.canonical_slug
// and reused). Falls back to a uuid-prefixed slug if the address is
// missing or another proposal already claims the natural slug.
async function allocateCanonicalSlug(proposal) {
  const base = slugifyAddressOnly(proposal.project_address) || `proposal-${proposal.id.slice(0, 8)}`;

  const { data: existing, error } = await supabase
    .from('published_proposals')
    .select('slug')
    .like('slug', `${base}%`);
  if (error) throw error;

  const taken = new Set((existing || []).map(r => r.slug));
  if (!taken.has(base)) return base;

  // Address-only slug is already taken by an unrelated published row.
  // Fall back to address-N to avoid colliding. The canonical_slug is
  // stamped onto the proposals row and never regenerated, so the value
  // is stable forever once chosen.
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Phase 6.5 — slug from address only, no date.
function slugifyAddressOnly(address) {
  return (address || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function slugifyBase(address, date) {
  const addr = (address || 'proposal')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'proposal';

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${addr}-${yyyy}-${mm}-${dd}`;
}

// ───────────────────────────────────────────────────────────────────────────
// HTML snapshot builder — full standalone document
// ───────────────────────────────────────────────────────────────────────────
function buildHtmlSnapshot({ proposal, sections, materials, photos, installSections, categoryToSection, regions, changeNote }) {
  const address = proposal.project_address || '';
  const cityLine = [proposal.project_city, proposal.project_state,
    proposal.project_zip].filter(Boolean).join(', ');
  const clientName = proposal.client_name || '';
  const total = proposal.bid_total_amount != null
    ? formatMoney(proposal.bid_total_amount) : null;
  const dateStr = formatDate(new Date());
  // Phase 1B.7 + post-launch — discount deadline anchored to publish time.
  // 48h from the moment this snapshot is generated. Stamped into HTML as
  // data-publish-deadline so all viewers count down toward the same fixed
  // moment instead of each visitor getting their own fresh 48h.
  const discountDeadlineIso = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const loomEmbed = buildLoomEmbed(proposal.loom_url);
  const heroBanner = buildHeroBanner(proposal.hero_image_url);
  const drawingSection = buildDrawingSection(proposal, regions, materials, categoryToSection);
  // Phase 6.5 — change-note banner. Renders above the hero when a non-empty
  // changeNote is provided. Wrapped in pub-changed-banner-wrap so the
  // dismiss-via-localStorage script can find and hide it.
  const changeNoteBanner = buildChangeNoteBanner(changeNote, proposal);

  const scopeHtml = renderScopeSection(sections, proposal.bid_total_amount);
  // Phase 1B.4 — when the proposal has labeled regions on a backdrop,
  // the materials grid is rendered inside the Site plan section directly
  // beneath the legend strip. The standalone Section 02 "Selected
  // materials" only renders for legacy proposals (no regions) where it's
  // still the only place materials show up.
  const hasLabeledRegions = Array.isArray(regions) && regions.length > 0
    && proposal.site_plan_backdrop_url;
  const materialsHtml = hasLabeledRegions ? '' : renderMaterialsSection(materials, categoryToSection);
  const whyPrepHtml = renderWhyPrepSection(installSections, sections, materials);
  const photosHtml = renderPhotosSection(photos);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(address || 'Paver Portal Proposal')} · Paver Portal</title>
<link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --green: #9c7440;
    --green-dark: #7d5c31;
    --green-soft: #f1e7d3;
    --charcoal: #353535;
    --tan: #dad7c5;
    --cream: #faf8f3;
    --navy: #33281c;
    --border: #e5e5e5;
    --muted: #666;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
    color: var(--charcoal);
    background: #fff;
    line-height: 1.6;
    font-size: 16px;
  }
  .num { font-family: 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums; }
  a { color: inherit; }

  /* ═════════ Header ═════════ */
  .pub-header {
    padding: 24px 32px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
  }
  .pub-header-logo { height: 40px; width: auto; display: block; }
  .pub-header-date { color: var(--muted); font-size: 14px; }

  /* ═════════ Hero ═════════ */
  .pub-hero {
    background: var(--cream);
    border-bottom: 1px solid var(--border);
  }
  .pub-hero-banner-wrap {
    width: 100%;
    max-height: 520px;
    overflow: hidden;
  }
  .pub-hero-banner {
    width: 100%;
    height: 100%;
    min-height: 360px;
    max-height: 520px;
    object-fit: cover;
    display: block;
  }
  .pub-hero-body {
    padding: 72px 32px 80px;
    text-align: center;
  }
  .pub-hero-banner-wrap + .pub-hero-body {
    padding-top: 56px;
  }
  .pub-hero-eyebrow {
    font-size: 13px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--green);
    margin-bottom: 20px;
    font-weight: 600;
  }
  .pub-hero-address {
    font-size: clamp(32px, 5vw, 52px);
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-bottom: 12px;
    line-height: 1.15;
  }
  .pub-hero-city {
    font-size: 18px;
    color: var(--muted);
    margin-bottom: 32px;
  }
  .pub-hero-client {
    font-size: 15px;
    color: var(--muted);
    margin-bottom: 24px;
  }
  .pub-hero-total-label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--muted);
    margin-bottom: 8px;
    font-weight: 600;
  }
  .pub-hero-total {
    font-size: clamp(40px, 7vw, 72px);
    font-weight: 700;
    color: var(--green);
    letter-spacing: -0.02em;
  }

  /* ═════════ Loom embed ═════════ */
  .pub-loom {
    max-width: 1000px;
    margin: 64px auto 0;
    padding: 0 32px;
  }
  .pub-loom-embed {
    position: relative;
    padding-bottom: 56.25%;
    height: 0;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    background: #000;
  }
  .pub-loom-embed iframe {
    position: absolute; top: 0; left: 0;
    width: 100%; height: 100%; border: 0;
  }

  /* ═════════ Section shell ═════════ */
  .pub-section {
    max-width: 1040px;
    margin: 0 auto;
    padding: 88px 32px;
  }
  .pub-section-eyebrow {
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--green);
    font-weight: 600;
    margin-bottom: 12px;
  }
  .pub-section h2 {
    font-size: clamp(28px, 4vw, 36px);
    font-weight: 600;
    letter-spacing: -0.01em;
    margin-bottom: 12px;
  }
  .pub-section-lede {
    color: var(--muted);
    margin-bottom: 48px;
    font-size: 17px;
    max-width: 640px;
  }

  /* ═════════ Construction drawing ═════════ */
  .pub-drawing {
    background: #fff;
    border-bottom: 1px solid var(--border);
  }
  .pub-drawing-inner {
    max-width: 1200px;
    margin: 0 auto;
    padding: 88px 32px 64px;
  }
  .pub-drawing-frame {
    background: var(--cream);
    border-radius: 12px;
    padding: 32px;
    display: flex;
    justify-content: center;
    align-items: center;
    box-shadow: 0 4px 24px rgba(0,0,0,0.04);
    margin-top: 8px;
  }
  .pub-drawing-link {
    display: block;
    width: 100%;
    text-align: center;
    line-height: 0;
  }
  .pub-drawing-img {
    max-width: 100%;
    max-height: 720px;
    height: auto;
    display: block;
    margin: 0 auto;
    border-radius: 4px;
    cursor: zoom-in;
    transition: transform 0.2s ease;
  }
  .pub-drawing-img:hover { transform: scale(1.01); }
  .pub-drawing-caption {
    text-align: center;
    margin-top: 16px;
    font-size: 13px;
    color: var(--muted);
    font-style: italic;
  }

  /* Phase 1B — polygon overlay on the construction drawing.
     The wrap is inline-block so it shrink-wraps to the rendered img size;
     the SVG is 100%/100% absolutely positioned so it always matches the img
     exactly, regardless of how the img scales (max-width 100% on small
     screens, max-height 720px on large ones). The viewBox uses the
     backdrop's native pixel dimensions, so polygon coords convert from
     0..1 fractions to user units via simple multiplication at render time.
     vector-effect: non-scaling-stroke keeps the outline a consistent
     device-pixel width regardless of how much the SVG is scaled down.

     Phase 1B.2 — louder treatment so polygons read clearly on top of
     colored SketchUp drawings: thicker stroke, higher fill opacity, and
     an .is-active state that bumps both. The active class is toggled by
     the inline hover-sync IIFE rendered below the section, so hovering
     the matching card on the right rail also lights the polygon. */
  .pub-drawing-overlay-wrap {
    position: relative;
    display: inline-block;
    vertical-align: top;
    max-width: 100%;
    line-height: 0;
  }
  .pub-drawing-overlay-img {
    display: block;
    max-width: 100%;
    max-height: 720px;
    height: auto;
    width: auto;
    border-radius: 4px;
  }
  .pub-drawing-overlay-svg {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .pub-drawing-region {
    fill: rgba(93, 126, 105, 0.22);
    stroke: var(--green);
    stroke-width: 5;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
    cursor: pointer;
    transition: fill 0.15s ease, stroke-width 0.15s ease;
  }
  .pub-drawing-region--static {
    cursor: default;
  }
  .pub-drawing-region.is-active,
  .pub-drawing-region:hover {
    fill: rgba(93, 126, 105, 0.42);
    stroke-width: 7;
  }

  /* ════════════════════════════════════════════════════════════════════
     Phase 1B.4 — full-width site plan + region legend strip + materials
     grid (with region-usage badges) all stacked under the construction
     drawing. Replaces the Phase 1B.2 two-column layout. The map is the
     visual anchor at full width; the legend strip beneath gives at-a-
     glance region context with click-to-scroll into the scope; the
     materials grid below shows the full library with chips indicating
     which regions each material is used in. Hover sync between polygons
     ↔ legend rows ↔ material cards is wired by the inline IIFE rendered
     at the end of the section.
     ════════════════════════════════════════════════════════════════════ */

  .pub-site-plan-map {
    margin-top: 32px;
    text-align: center;
  }
  .pub-drawing-caption {
    font-size: 13px;
    color: var(--muted);
    margin-top: 14px;
    font-style: italic;
  }

  /* Region legend — compact horizontal rail of color-dot + name + meta.
     Each row is an <a> linking to its scope section so clicking it scrolls
     to that part of the breakdown below. Hover sync lights the matching
     polygon and any material cards that reference this region. */
  .pub-region-legend {
    margin-top: 36px;
    padding: 4px 0;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
  }
  .pub-region-legend-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 24px;
    text-decoration: none;
    color: inherit;
    border-right: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.15s ease;
    flex-shrink: 0;
  }
  .pub-region-legend-row:last-child { border-right: none; }
  .pub-region-legend-row:hover,
  .pub-region-legend-row.is-active {
    background: var(--cream);
  }
  .pub-region-legend-dot {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    flex-shrink: 0;
    border: 1px solid rgba(0,0,0,0.08);
  }
  .pub-region-legend-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.2;
  }
  .pub-region-legend-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--navy);
    letter-spacing: -0.005em;
  }
  .pub-region-legend-meta {
    font-family: 'JetBrains Mono', monospace;
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.02em;
  }

  /* Materials block under the legend. Replaces the standalone Section 02
     when the proposal has labeled regions — the same grid renders here
     instead, beneath the map, so materials live next to the spatial
     context they apply to. */
  .pub-site-plan-materials {
    margin-top: 64px;
  }
  .pub-site-plan-materials-eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.22em;
    color: var(--muted);
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .pub-site-plan-materials-heading {
    font-size: 24px;
    font-weight: 600;
    color: var(--navy);
    letter-spacing: -0.012em;
    margin-bottom: 8px;
    line-height: 1.2;
  }
  .pub-site-plan-materials-lede {
    font-size: 14px;
    color: var(--muted);
    line-height: 1.6;
    margin-bottom: 28px;
    max-width: 60ch;
  }

  .pub-materials-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 28px;
  }
  .pub-material-card {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
  }
  .pub-material-card.is-active,
  .pub-material-card:hover {
    border-color: var(--green);
    box-shadow: 0 12px 30px rgba(93, 126, 105, 0.16);
    transform: translateY(-2px);
  }
  .pub-material-card .pub-lightbox-trigger {
    background: none;
    border: none;
    padding: 0;
    cursor: zoom-in;
    width: 100%;
    display: block;
    border-bottom: 1px solid var(--border);
  }
  .pub-material-card img {
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    display: block;
    background: var(--cream);
  }
  .pub-material-card-placeholder {
    width: 100%;
    aspect-ratio: 4 / 3;
    background: linear-gradient(135deg, var(--cream), var(--green-soft));
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--green);
    font-weight: 700;
    font-size: 18px;
    letter-spacing: 0.12em;
    border-bottom: 1px solid var(--border);
  }
  .pub-material-card-body {
    padding: 22px 24px 24px;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  /* Phase 1B.7 — material type eyebrow above the product name.
     Mono caps tracking matches the section-level eyebrow rhythm; green-dark
     ties the card identity to the Paver Portal palette without competing with
     the navy product name. */
  .pub-material-card-type {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.2em;
    color: var(--green-dark);
    text-transform: uppercase;
    margin-bottom: -8px;
  }
  .pub-material-card-name {
    font-size: 18px;
    font-weight: 600;
    color: var(--navy);
    line-height: 1.3;
    letter-spacing: -0.005em;
  }
  .pub-material-card-color {
    font-size: 13px;
    color: var(--muted);
    line-height: 1.45;
    margin-top: -10px;
    letter-spacing: 0.005em;
  }
  .pub-material-card-regions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pub-region-badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 5px 11px;
    background: var(--cream);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    color: var(--charcoal);
    letter-spacing: 0.015em;
  }
  .pub-region-badge-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .pub-material-card-actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: auto;
    padding-top: 14px;
    border-top: 1px dashed var(--border);
  }
  .pub-material-card-action {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--green-dark);
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    transition: color 0.12s ease, transform 0.12s ease;
  }
  .pub-material-card-action:hover {
    color: var(--green);
    transform: translateX(2px);
  }

  /* ═════════ Scope of Work — Phase 1B.4 polished typography ═════════
     Replaces the prior cream-card line items with a flow layout: hairline
     dividers between rows, generous vertical rhythm, larger typography.
     Each scope section opens with a numbered eyebrow + display-size name
     and a tabular-num price right-aligned. Line items break the type tag
     out as a green eyebrow above the body text. */
  .pub-scope-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .pub-scope-item {
    padding: 56px 0;
    border-top: 1px solid var(--border);
    scroll-margin-top: 32px;
  }
  .pub-scope-item:first-child {
    padding-top: 8px;
    border-top: none;
  }
  .pub-scope-item-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 32px;
    margin-bottom: 28px;
  }
  .pub-scope-item-header-text { min-width: 0; flex: 1; }
  .pub-scope-item-eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.22em;
    color: var(--muted);
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .pub-scope-item-name {
    font-size: 26px;
    font-weight: 600;
    color: var(--navy);
    letter-spacing: -0.014em;
    line-height: 1.18;
  }
  .pub-scope-item-amount {
    font-family: 'JetBrains Mono', monospace;
    font-variant-numeric: tabular-nums;
    font-size: 22px;
    font-weight: 500;
    color: var(--navy);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .pub-scope-total {
    margin-top: 16px;
    padding: 40px 0 12px;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 32px;
    border-top: 2px solid var(--charcoal);
  }
  .pub-scope-total-label {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: var(--charcoal);
  }
  .pub-scope-total-amount {
    font-family: 'JetBrains Mono', monospace;
    font-variant-numeric: tabular-nums;
    font-size: 32px;
    font-weight: 600;
    color: var(--navy);
    letter-spacing: -0.012em;
  }

  /* Line items — flow layout with hairline rules between, no boxing. */
  .pub-line-items {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .pub-line-item {
    padding: 22px 0;
    border-top: 1px solid var(--border);
    color: var(--charcoal);
  }
  .pub-line-item:first-child {
    border-top: none;
    padding-top: 4px;
  }
  .pub-line-item-type {
    display: block;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.2em;
    color: var(--green-dark);
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .pub-line-item-body {
    font-size: 15px;
    line-height: 1.65;
    color: var(--charcoal);
    max-width: 68ch;
  }
  .pub-line-item--structured {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .pub-line-item-head {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pub-line-item-name {
    font-size: 17px;
    font-weight: 600;
    color: var(--navy);
    line-height: 1.35;
    letter-spacing: -0.005em;
  }
  .pub-line-item-attrs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 24px;
    font-size: 13px;
    margin-top: 4px;
  }
  .pub-line-item-attr {
    color: var(--muted);
    line-height: 1.55;
  }
  .pub-line-item-attr em {
    font-style: normal;
    font-weight: 600;
    color: var(--charcoal);
    letter-spacing: 0.015em;
    margin-right: 6px;
  }

  /* ═════════ Why preparation matters ═════════ */
  .pub-prep {
    background: var(--cream);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .pub-prep-inner {
    max-width: 1040px;
    margin: 0 auto;
    padding: 96px 32px;
  }
  .pub-prep-intro {
    max-width: 760px;
    margin-bottom: 56px;
  }
  .pub-prep-intro p {
    font-size: 18px;
    line-height: 1.65;
    color: var(--charcoal);
  }
  /* Phase 1B.4 — horizontal scrollable rail. Replaces the prior auto-fit
     grid. Cards have a fixed width and the rail uses scroll-snap so each
     stop lands cleanly on the next card. Edge gradient fades signal that
     more content is to the side; absolutely-positioned arrow buttons
     give an explicit nav for desktop users without obscuring touch
     scrolling on mobile. */
  .pub-prep-rail-wrap {
    position: relative;
    margin: 0 -32px; /* break out of the .pub-prep-inner padding so the rail can extend edge-to-edge within the cream band */
  }
  /* Sprint 14C.7 — fade gradient fix: width was 56px and held cream solid
     until the 30% mark, so the leftmost card was getting clipped by ~24px
     of overlapping fade (the "P" in "Paver Installation" and the left
     edge of the diagram were unreadable). Narrowed to 24px and made the
     gradient smooth from the edge so no portion of the card is masked.
     Visual hint of horizontal scroll is preserved; content readability
     comes first. */
  .pub-prep-rail-wrap::before,
  .pub-prep-rail-wrap::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 16px;
    width: 24px;
    pointer-events: none;
    z-index: 2;
  }
  .pub-prep-rail-wrap::before {
    left: 0;
    background: linear-gradient(to right, var(--cream), rgba(250, 248, 243, 0));
  }
  .pub-prep-rail-wrap::after {
    right: 0;
    background: linear-gradient(to left, var(--cream), rgba(250, 248, 243, 0));
  }
  .pub-prep-rail {
    display: flex;
    gap: 20px;
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    scroll-behavior: smooth;
    scroll-padding: 0 32px;
    padding: 8px 32px 16px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .pub-prep-rail::-webkit-scrollbar { height: 8px; }
  .pub-prep-rail::-webkit-scrollbar-track { background: transparent; }
  .pub-prep-rail::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 4px;
  }
  .pub-prep-rail::-webkit-scrollbar-thumb:hover { background: var(--muted); }
  .pub-prep-rail-arrow {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: #fff;
    border: 1px solid var(--border);
    color: var(--navy);
    font-size: 22px;
    line-height: 1;
    font-weight: 400;
    cursor: pointer;
    z-index: 3;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
    transition: opacity 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
    padding: 0 0 2px; /* nudge chevron up slightly to optically center */
  }
  .pub-prep-rail-arrow:hover {
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
    transform: translateY(-50%) scale(1.04);
  }
  .pub-prep-rail-arrow.is-disabled {
    opacity: 0.3;
    cursor: default;
    pointer-events: none;
    box-shadow: none;
  }
  .pub-prep-rail-arrow--prev { left: 8px; }
  .pub-prep-rail-arrow--next { right: 8px; }
  .pub-prep-card {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 32px 28px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    flex: 0 0 380px;
    max-width: 380px;
    scroll-snap-align: start;
    /* Sprint 14C.7 — cards now have a resting shadow so they visually
       lift off the cream section background. Previously the resting
       state was just a 1px gray border which was nearly invisible
       against the cream. Hover state intensifies the shadow further. */
    box-shadow: 0 2px 8px rgba(53, 53, 53, 0.06), 0 1px 2px rgba(53, 53, 53, 0.04);
    transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
  }
  .pub-prep-card:hover {
    border-color: var(--green);
    box-shadow: 0 12px 28px rgba(93, 126, 105, 0.14), 0 2px 6px rgba(93, 126, 105, 0.08);
    transform: translateY(-2px);
  }
  .pub-prep-card-number {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    color: var(--green);
    font-weight: 600;
    letter-spacing: 0.05em;
  }
  .pub-prep-card-title {
    font-size: 19px;
    font-weight: 600;
    color: var(--navy);
    letter-spacing: -0.01em;
  }
  .pub-prep-card-body {
    color: var(--muted);
    font-size: 15px;
    line-height: 1.65;
  }

  /* Dynamic-section-only additions (Sprint 2 Part B.2) */
  .pub-prep-card-summary {
    color: var(--charcoal);
    font-size: 15px;
    line-height: 1.65;
  }
  .pub-prep-card-points {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .pub-prep-card-points li {
    color: var(--muted);
    font-size: 14px;
    line-height: 1.55;
    padding-left: 18px;
    position: relative;
  }
  .pub-prep-card-points li::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
  }
  .pub-prep-card-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    font-size: 13px;
    font-weight: 600;
    color: var(--green-dark);
    text-decoration: none;
  }
  .pub-prep-card-link:hover {
    color: var(--green);
    text-decoration: underline;
  }

  .pub-prep-footer {
    margin-top: 48px;
    padding-top: 32px;
    border-top: 1px solid var(--border);
    font-size: 15px;
    color: var(--muted);
    max-width: 760px;
    line-height: 1.65;
  }

  /* ═════════ Photos — Phase 1B.6 polish ═════════
     Group label + count render side-by-side in a flex header with a hairline
     divider below each group. Photo cards get the same 14px radius as
     materials, a 24px grid gap (up from 14px), and a subtle hover lift so
     they feel interactive — they're already buttons that open the lightbox,
     but the previous styling gave no visual feedback. */
  .pub-photos-group {
    margin-bottom: 56px;
    padding-bottom: 48px;
    border-bottom: 1px solid var(--border);
  }
  .pub-photos-group:last-child {
    margin-bottom: 0;
    padding-bottom: 0;
    border-bottom: none;
  }
  .pub-photos-group-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 24px;
  }
  .pub-photos-group-label {
    font-size: 18px;
    font-weight: 600;
    color: var(--navy);
    letter-spacing: -0.005em;
    line-height: 1.3;
  }
  .pub-photos-group-count {
    font-family: 'JetBrains Mono', monospace;
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    letter-spacing: 0.18em;
    color: var(--muted);
    text-transform: uppercase;
    white-space: nowrap;
  }
  .pub-photos-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 24px;
  }
  .pub-photos-grid .pub-lightbox-trigger {
    background: none;
    border: none;
    padding: 0;
    cursor: zoom-in;
    border-radius: 14px;
    overflow: hidden;
    display: block;
    transition: transform 0.18s ease, box-shadow 0.18s ease;
  }
  .pub-photos-grid .pub-lightbox-trigger:hover {
    transform: translateY(-2px);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.10);
  }
  .pub-photos-grid img {
    width: 100%;
    aspect-ratio: 4/3;
    object-fit: cover;
    display: block;
    background: var(--cream);
  }

  /* ═════════ Final CTA — Phase 1B.7 ═════════
     Replaces the prior cream-bg "Ready to move forward?" panel with a
     navy hero CTA. Headline carries the discount amount, a 48-hour
     countdown counts down per-viewer (timer state lives in localStorage
     keyed by slug), and a prominent green button opens the signature
     modal. Tertiary links (call/email/guide) live below the main button
     so they're available without competing visually. */
  .pub-cta-final {
    background: var(--navy);
    color: #fff;
    padding: 96px 32px;
    text-align: center;
    border-top: 1px solid var(--border);
  }
  .pub-cta-final-inner {
    max-width: 720px;
    margin: 0 auto;
  }
  .pub-cta-final-eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.24em;
    color: var(--tan);
    text-transform: uppercase;
    margin-bottom: 24px;
  }
  .pub-cta-final-headline {
    font-size: clamp(30px, 4.5vw, 42px);
    font-weight: 600;
    letter-spacing: -0.018em;
    margin-bottom: 18px;
    line-height: 1.2;
    color: #fff;
  }
  .pub-cta-final-amount {
    color: var(--green);
    display: block;
    margin-top: 6px;
    font-weight: 600;
  }
  .pub-cta-final-lede {
    color: rgba(255, 255, 255, 0.78);
    font-size: 16px;
    line-height: 1.65;
    margin: 0 auto 36px;
    max-width: 520px;
  }

  /* Countdown */
  .pub-cta-countdown {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    padding: 22px 36px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    margin-bottom: 32px;
  }
  .pub-cta-countdown-unit {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    min-width: 64px;
  }
  .pub-cta-countdown-value {
    font-family: 'JetBrains Mono', monospace;
    font-variant-numeric: tabular-nums;
    font-size: 40px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: #fff;
    line-height: 1;
  }
  .pub-cta-countdown-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.18em;
    color: rgba(255, 255, 255, 0.6);
    text-transform: uppercase;
  }
  .pub-cta-countdown-sep {
    font-family: 'JetBrains Mono', monospace;
    font-size: 36px;
    font-weight: 300;
    color: rgba(255, 255, 255, 0.3);
    line-height: 1;
    padding-bottom: 18px;
  }
  /* Post-launch — when the publish-time-anchored 48h discount window has
     elapsed, every element in the .pub-cta-discount-block hides at once
     (eyebrow, headline, lede, countdown box, expired-msg). The sign
     button + secondary contact links remain. */
 .pub-cta-final.is-discount-expired .pub-cta-discount-block { display: none; }
  /* Phase 6.4B — designer-controlled toggle. When show_signing_discount is
     false on the proposal, all discount messaging hides (same target classes
     as is-discount-expired). The sign button + secondary contact links stay
     visible. */
  .pub-cta-final.is-discount-disabled .pub-cta-discount-block { display: none; }

  .pub-cta-countdown.is-expired { opacity: 0.6; }
  .pub-cta-countdown.is-expired .pub-cta-countdown-value {
    color: rgba(255, 255, 255, 0.4);
  }
  .pub-cta-expired-msg {
    color: var(--tan);
    font-size: 14px;
    margin: 0 auto 28px;
    max-width: 480px;
    line-height: 1.55;
  }

  .pub-cta-sign-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 22px 44px;
    background: var(--green);
    color: #fff;
    border: none;
    border-radius: 14px;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.005em;
    cursor: pointer;
    font-family: inherit;
    transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
    box-shadow: 0 8px 24px rgba(93, 126, 105, 0.36);
    max-width: 100%;
  }
  .pub-cta-sign-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 14px 38px rgba(93, 126, 105, 0.48);
    background: var(--green-dark);
  }
  .pub-cta-sign-btn:active { transform: translateY(0); }
  .pub-cta-sign-btn-arrow {
    transition: transform 0.18s ease;
  }
  .pub-cta-sign-btn:hover .pub-cta-sign-btn-arrow {
    transform: translateX(3px);
  }
  .pub-cta-final-secondary {
    margin-top: 28px;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.6);
  }
  .pub-cta-final-secondary a {
    color: var(--tan);
    text-decoration: none;
    font-weight: 600;
    border-bottom: 1px dotted rgba(218, 215, 197, 0.4);
    margin: 0 4px;
  }
  .pub-cta-final-secondary a:hover {
    color: #fff;
    border-bottom-color: rgba(255, 255, 255, 0.8);
  }

  /* Sign modal */
  .pub-sign-modal {
    position: fixed;
    inset: 0;
    background: rgba(26, 31, 46, 0.86);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    z-index: 1100;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .pub-sign-modal.is-open { display: flex; }
  .pub-sign-modal-stage {
    background: #fff;
    border-radius: 16px;
    max-width: 520px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    padding: 40px;
    position: relative;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.4);
  }
  .pub-sign-modal-close {
    position: absolute;
    top: 14px;
    right: 14px;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--cream);
    border: none;
    color: var(--charcoal);
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s ease;
  }
  .pub-sign-modal-close:hover { background: var(--border); }
  .pub-sign-modal-eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.22em;
    color: var(--muted);
    text-transform: uppercase;
    margin-bottom: 12px;
  }
  .pub-sign-modal-title {
    font-size: 24px;
    font-weight: 600;
    color: var(--navy);
    letter-spacing: -0.012em;
    margin-bottom: 10px;
    line-height: 1.2;
  }
  .pub-sign-modal-lede {
    color: var(--muted);
    font-size: 14px;
    line-height: 1.6;
    margin-bottom: 28px;
  }
  .pub-sign-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .pub-sign-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .pub-sign-field-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--charcoal);
    letter-spacing: 0.005em;
  }
  .pub-sign-field-opt {
    font-weight: 400;
    color: var(--muted);
    margin-left: 2px;
  }
  .pub-sign-field input,
  .pub-sign-field textarea {
    font-family: inherit;
    font-size: 15px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fff;
    color: var(--charcoal);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
    resize: vertical;
    width: 100%;
  }
  .pub-sign-field input:focus,
  .pub-sign-field textarea:focus {
    outline: none;
    border-color: var(--green);
    box-shadow: 0 0 0 3px rgba(93, 126, 105, 0.15);
  }
  .pub-sign-form-actions {
    display: flex;
    gap: 10px;
    margin-top: 8px;
  }
  .pub-sign-btn {
    flex: 1;
    padding: 14px 20px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    border: 1px solid transparent;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
  }
  .pub-sign-btn-cancel {
    background: #fff;
    color: var(--charcoal);
    border-color: var(--border);
  }
  .pub-sign-btn-cancel:hover { background: var(--cream); }
  .pub-sign-btn-submit {
    background: var(--green);
    color: #fff;
  }
  .pub-sign-btn-submit:hover { background: var(--green-dark); }
  .pub-sign-btn-submit:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .pub-sign-form-error {
    background: #fef2f2;
    color: #b91c1c;
    border: 1px solid #fecaca;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
  }
  .pub-sign-success {
    text-align: center;
    padding: 12px 0 4px;
  }
  .pub-sign-success-icon {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--green-soft);
    color: var(--green-dark);
    font-size: 28px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 18px;
  }
  .pub-sign-success h3 {
    font-size: 22px;
    font-weight: 600;
    color: var(--navy);
    letter-spacing: -0.01em;
    margin-bottom: 10px;
  }
  .pub-sign-success p {
    color: var(--muted);
    font-size: 14px;
    line-height: 1.6;
  }

  /* ═════════ Bottom strip — Phase 1B.6 polish ═════════ */
  .pub-bottom {
    padding: 36px 32px;
    text-align: center;
    color: var(--muted);
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    border-top: 1px solid var(--border);
  }

  /* ═════════ Mobile ═════════ */
  @media (max-width: 640px) {
    .pub-header { padding: 20px; }
    .pub-hero-body { padding: 48px 20px 56px; }
    .pub-hero-banner-wrap + .pub-hero-body { padding-top: 40px; }
    .pub-hero-banner { min-height: 240px; max-height: 340px; }
    .pub-section { padding: 56px 20px; }
    .pub-prep-inner { padding: 72px 20px; }
    .pub-drawing-inner { padding: 56px 20px 40px; }
    .pub-drawing-frame { padding: 14px; }
    .pub-loom { padding: 0 20px; margin-top: 48px; }

    /* Phase 1B.4 mobile — scope item header collapses to stacked layout
       so the section name + price get full width. */
    .pub-scope-item { padding: 40px 0; }
    .pub-scope-item-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
    .pub-scope-item-name { font-size: 22px; }
    .pub-scope-item-amount { font-size: 20px; }
    .pub-scope-total { padding: 32px 0 8px; }
    .pub-scope-total-amount { font-size: 26px; }

    /* Region legend — wider padding eats the row width on phones; switch
       to a stacked layout where each row is full-width with a top border. */
    .pub-region-legend {
      flex-direction: column;
    }
    .pub-region-legend-row {
      border-right: none;
      border-bottom: 1px solid var(--border);
      padding: 14px 16px;
    }
    .pub-region-legend-row:last-child { border-bottom: none; }

    .pub-site-plan-materials { margin-top: 48px; }
    .pub-site-plan-materials-heading { font-size: 22px; }

    /* Phase 1B.4 mobile — Quality Standards rail. Arrow buttons hide on
       mobile (touch scrolling is the native gesture; the buttons would
       just clutter the corners). Card width drops so the next card
       peeks in at the right edge, hinting the rail scrolls. The rail's
       margin/padding also re-aligns to the 20px mobile gutter. */
    .pub-prep-rail-wrap {
      margin: 0 -20px;
    }
    .pub-prep-rail {
      scroll-padding: 0 20px;
      padding: 8px 20px 16px;
    }
    .pub-prep-rail-arrow { display: none; }
    .pub-prep-card {
      flex: 0 0 320px;
      max-width: 320px;
      padding: 28px 24px;
    }
    .pub-prep-rail-wrap::before,
    .pub-prep-rail-wrap::after { width: 32px; }

    /* Phase 1B.7 — final CTA mobile sizing. Countdown digits and padding
       shrink so the unit row fits a 320px viewport without horizontal
       scroll. Sign button takes full width on mobile, modal action
       buttons stack column-reverse so the primary submit sits up top. */
    .pub-cta-final { padding: 64px 20px; }
    .pub-cta-final-headline { font-size: clamp(26px, 7vw, 34px); }
    .pub-cta-countdown {
      padding: 18px 20px;
      gap: 6px;
    }
    .pub-cta-countdown-unit { min-width: 50px; }
    .pub-cta-countdown-value { font-size: 32px; }
    .pub-cta-countdown-sep {
      font-size: 28px;
      padding-bottom: 14px;
    }
    .pub-cta-sign-btn {
      padding: 18px 24px;
      font-size: 15px;
      width: 100%;
      max-width: 360px;
    }
    .pub-sign-modal { padding: 16px; }
    .pub-sign-modal-stage { padding: 28px 22px; }
    .pub-sign-form-actions { flex-direction: column-reverse; }
  }

  /* ═════════ Lightbox (Sprint 3H) ═════════
     Every non-hero image on the published page opens in a full-viewport
     modal when clicked. Images are grouped by a data-gallery attribute
     (drawing / materials / photos-04 / photos-05) so the prev/next arrows
     cycle through siblings within the same gallery. The trigger is a
     transparent button wrapper — it does NOT override the inner img
     sizing, so aspect-ratio and object-fit rules from .pub-material-card
     img, .pub-photos-grid img, etc. still apply. */
  .pub-lightbox-trigger {
    display: block;
    width: 100%;
    padding: 0;
    margin: 0;
    border: 0;
    background: transparent;
    cursor: zoom-in;
    line-height: 0;
    font: inherit;
    color: inherit;
    text-align: inherit;
  }
  .pub-lightbox {
    position: fixed;
    inset: 0;
    background: rgba(12, 14, 18, 0.92);
    z-index: 9999;
    display: none;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.18s ease;
    touch-action: pan-y;
  }
  .pub-lightbox.is-open {
    display: flex;
    opacity: 1;
  }
  .pub-lightbox-stage {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 64px 80px;
    box-sizing: border-box;
  }
  .pub-lightbox-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
    cursor: zoom-out;
  }
  .pub-lightbox-close,
  .pub-lightbox-nav {
    position: absolute;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    color: #fff;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s;
    font-family: inherit;
    padding: 0;
  }
  .pub-lightbox-close:hover,
  .pub-lightbox-nav:hover {
    background: rgba(255, 255, 255, 0.18);
  }
  .pub-lightbox-close {
    top: 20px;
    right: 20px;
    font-size: 22px;
    line-height: 1;
  }
  .pub-lightbox-nav {
    top: 50%;
    transform: translateY(-50%);
    font-size: 28px;
    line-height: 1;
  }
  .pub-lightbox-nav--prev { left: 20px; }
  .pub-lightbox-nav--next { right: 20px; }
  .pub-lightbox-nav[hidden] { display: none; }
  .pub-lightbox-counter {
    position: absolute;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    color: rgba(255, 255, 255, 0.7);
    font-size: 13px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  @media (max-width: 640px) {
    .pub-lightbox-stage { padding: 60px 12px; }
    .pub-lightbox-close,
    .pub-lightbox-nav {
      width: 40px;
      height: 40px;
    }
    .pub-lightbox-close { top: 12px; right: 12px; font-size: 18px; }
    .pub-lightbox-nav { font-size: 22px; }
    .pub-lightbox-nav--prev { left: 8px; }
    .pub-lightbox-nav--next { right: 8px; }
  }
</style>
</head>
<body>
  <header class="pub-header">
    <img src="${escapeAttr(PAVER PORTAL_LOGO_URL)}" alt="Paver Portal" class="pub-header-logo">
    <span class="pub-header-date">${escapeHtml(dateStr)}</span>
  </header>

  ${changeNoteBanner}

  <section class="pub-hero">
    ${heroBanner}
    <div class="pub-hero-body">
      <div class="pub-hero-eyebrow">Design Proposal</div>
      <h1 class="pub-hero-address">${escapeHtml(address || 'Paver Portal')}</h1>
      ${cityLine ? `<div class="pub-hero-city">${escapeHtml(cityLine)}</div>` : ''}
      ${clientName ? `<div class="pub-hero-client">Prepared for ${escapeHtml(clientName)}</div>` : ''}
      ${total ? `
        <div class="pub-hero-total-label">Project total</div>
        <div class="pub-hero-total num">${escapeHtml(total)}</div>
      ` : ''}
    </div>
  </section>

  ${loomEmbed}

  ${drawingSection}

  ${scopeHtml}

  ${materialsHtml}

  ${whyPrepHtml}

  ${photosHtml}

<section class="pub-cta-final${proposal.show_signing_discount === false ? ' is-discount-disabled' : ''}" data-proposal-id="${escapeAttr(proposal.id || '')}" data-bid-total="${escapeAttr(String(proposal.bid_total_amount || 0))}" data-publish-deadline="${escapeAttr(discountDeadlineIso)}">
    <div class="pub-cta-final-inner">
      <div class="pub-cta-final-eyebrow pub-cta-discount-block">Limited time · Immediate start discount</div>
      <h2 class="pub-cta-final-headline pub-cta-discount-block">
        Sign within 48 hours and save 5%${proposal.bid_total_amount ? `
        <span class="pub-cta-final-amount num">— that's $<span id="ctaDiscountAmt">${escapeHtml(Math.round(proposal.bid_total_amount * 0.05).toLocaleString('en-US'))}</span> off</span>` : ''}
      </h2>
      <p class="pub-cta-final-lede pub-cta-discount-block">
        The Immediate Start Discount locks your project into our next build window. Construction begins within 14 days of signing — materials, crew, and permits coordinated by Tim directly.
      </p>

      <div class="pub-cta-countdown pub-cta-discount-block" aria-live="polite">
        <div class="pub-cta-countdown-unit">
          <div class="pub-cta-countdown-value num" id="ctaHours">48</div>
          <div class="pub-cta-countdown-label">Hours</div>
        </div>
        <div class="pub-cta-countdown-sep">:</div>
        <div class="pub-cta-countdown-unit">
          <div class="pub-cta-countdown-value num" id="ctaMins">00</div>
          <div class="pub-cta-countdown-label">Minutes</div>
        </div>
        <div class="pub-cta-countdown-sep">:</div>
        <div class="pub-cta-countdown-unit">
          <div class="pub-cta-countdown-value num" id="ctaSecs">00</div>
          <div class="pub-cta-countdown-label">Seconds</div>
        </div>
      </div>

      <div class="pub-cta-expired-msg pub-cta-discount-block" id="ctaExpiredMsg" hidden>
        The Immediate Start window has closed — but Tim can still help you move forward. Click below or give him a call.
      </div>

      <button type="button" class="pub-cta-sign-btn" id="ctaSignBtn">
        <span>Ready to sign — send for signatures</span>
        <span class="pub-cta-sign-btn-arrow" aria-hidden="true">→</span>
      </button>

      <div class="pub-cta-final-secondary">
        Or reach Tim directly ·
        <a href="tel:${TIM_PHONE_HREF}">${escapeHtml(TIM_PHONE)}</a> ·
        <a href="mailto:${escapeAttr(TIM_EMAIL)}">Email</a> ·
        <a href="${escapeAttr(INSTALL_GUIDE_URL)}" target="_blank" rel="noopener">Installation Guide</a>
      </div>
    </div>
  </section>

  <div class="pub-bottom">
    Proposal prepared by Tim McMullen · Paver Portal
  </div>

  <!-- Phase 1B.7 Sign modal -->
  <div class="pub-sign-modal" id="pubSignModal" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="pubSignModalTitle">
    <div class="pub-sign-modal-stage">
      <button type="button" class="pub-sign-modal-close" id="pubSignModalClose" aria-label="Close">✕</button>
      <div class="pub-sign-modal-eyebrow">Send for signatures</div>
      <h3 id="pubSignModalTitle" class="pub-sign-modal-title">Lock in your project</h3>
      <p class="pub-sign-modal-lede">Tim will reach out within 24 hours to coordinate the contract, confirm your start date, and answer any final questions.</p>
      <form class="pub-sign-form" id="pubSignForm" novalidate>
        <label class="pub-sign-field">
          <span class="pub-sign-field-label">Your name</span>
          <input type="text" name="name" required maxlength="120" autocomplete="name">
        </label>
        <label class="pub-sign-field">
          <span class="pub-sign-field-label">Email</span>
          <input type="email" name="email" required maxlength="200" autocomplete="email">
        </label>
        <label class="pub-sign-field">
          <span class="pub-sign-field-label">Phone <span class="pub-sign-field-opt">(optional)</span></span>
          <input type="tel" name="phone" maxlength="40" autocomplete="tel">
        </label>
        <label class="pub-sign-field">
          <span class="pub-sign-field-label">Anything Tim should know? <span class="pub-sign-field-opt">(optional)</span></span>
          <textarea name="message" maxlength="2000" rows="3"></textarea>
        </label>
        <div class="pub-sign-form-error" id="pubSignError" hidden></div>
        <div class="pub-sign-form-actions">
          <button type="button" class="pub-sign-btn pub-sign-btn-cancel" id="pubSignCancel">Cancel</button>
          <button type="submit" class="pub-sign-btn pub-sign-btn-submit" id="pubSignSubmit">Send for signatures →</button>
        </div>
      </form>
      <div class="pub-sign-success" id="pubSignSuccess" hidden>
        <div class="pub-sign-success-icon">✓</div>
        <h3>Got it — Tim's on it.</h3>
        <p>You'll hear from him within 24 hours to coordinate signing and confirm your start date. The Immediate Start Discount is locked in for you.</p>
      </div>
    </div>
  </div>

  <!-- Lightbox modal (Sprint 3H) -->
  <div class="pub-lightbox" id="pubLightbox" role="dialog" aria-modal="true" aria-hidden="true">
    <div class="pub-lightbox-stage">
      <button type="button" class="pub-lightbox-nav pub-lightbox-nav--prev" id="pubLbPrev"
              aria-label="Previous image">‹</button>
      <img class="pub-lightbox-img" id="pubLbImg" src="" alt="">
      <button type="button" class="pub-lightbox-nav pub-lightbox-nav--next" id="pubLbNext"
              aria-label="Next image">›</button>
      <button type="button" class="pub-lightbox-close" id="pubLbClose"
              aria-label="Close">✕</button>
      <div class="pub-lightbox-counter" id="pubLbCounter"></div>
    </div>
  </div>

  <script>
    (function () {
      var modal    = document.getElementById('pubLightbox');
      var imgEl    = document.getElementById('pubLbImg');
      var closeEl  = document.getElementById('pubLbClose');
      var prevEl   = document.getElementById('pubLbPrev');
      var nextEl   = document.getElementById('pubLbNext');
      var counter  = document.getElementById('pubLbCounter');
      if (!modal || !imgEl) return;

      var currentList  = [];  // array of { src, alt }
      var currentIndex = 0;

      // Collect every trigger on the page and bucket by gallery so prev/next
      // cycles through images in the same section (renderings, current photos,
      // materials, drawing). Triggers with no data-gallery form a singleton.
      var triggers = Array.prototype.slice.call(
        document.querySelectorAll('.pub-lightbox-trigger')
      );
      var galleries = {};
      triggers.forEach(function (el) {
        var key = el.getAttribute('data-gallery') || ('lb-' + Math.random());
        if (!galleries[key]) galleries[key] = [];
        galleries[key].push({
          src: el.getAttribute('data-lightbox-src') || '',
          alt: el.getAttribute('data-lightbox-alt') || '',
          el:  el
        });
      });

      function openAt(list, idx) {
        currentList  = list;
        currentIndex = idx;
        update();
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
      }

      function close() {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        // Clear src after transition so we don't flash the previous image
        // if the modal reopens quickly.
        setTimeout(function () { imgEl.src = ''; }, 200);
      }

      function update() {
        var item = currentList[currentIndex];
        if (!item) return;
        imgEl.src = item.src;
        imgEl.alt = item.alt;
        var hasSiblings = currentList.length > 1;
        prevEl.hidden = !hasSiblings;
        nextEl.hidden = !hasSiblings;
        counter.textContent = hasSiblings
          ? (currentIndex + 1) + ' / ' + currentList.length
          : '';
      }

      function step(delta) {
        if (currentList.length <= 1) return;
        currentIndex = (currentIndex + delta + currentList.length) % currentList.length;
        update();
      }

      // Wire each trigger — identify which gallery it belongs to, find its
      // index, and open the lightbox positioned there.
      Object.keys(galleries).forEach(function (key) {
        var list = galleries[key];
        list.forEach(function (item, idx) {
          item.el.addEventListener('click', function (e) {
            e.preventDefault();
            openAt(list, idx);
          });
        });
      });

      // Click the backdrop (not the image itself) to close. Click the image
      // to close too — it already has cursor: zoom-out.
      modal.addEventListener('click', function (e) {
        if (e.target === modal || e.target === imgEl ||
            e.target.classList.contains('pub-lightbox-stage')) {
          close();
        }
      });
      closeEl.addEventListener('click', close);
      prevEl.addEventListener('click',  function (e) { e.stopPropagation(); step(-1); });
      nextEl.addEventListener('click',  function (e) { e.stopPropagation(); step(+1); });

      // Keyboard: Esc closes, arrows navigate.
      document.addEventListener('keydown', function (e) {
        if (!modal.classList.contains('is-open')) return;
        if (e.key === 'Escape')     close();
        else if (e.key === 'ArrowLeft')  step(-1);
        else if (e.key === 'ArrowRight') step(+1);
      });
    })();
  </script>

  <script>
    // Phase 1B.7 — final CTA: countdown + sign-for-signatures workflow.
    //
    // Per-viewer 48h deadline: localStorage key is the proposal slug
    // (extracted from the URL path /p/{slug}), so each visitor gets
    // their own 48-hour window from first sight. A shared server-side
    // deadline would already be expired by the time most viewers open
    // the page, defeating the point of "Immediate Start." If the visitor
    // returns within 48h the timer resumes from where it left off; if
    // they return after expiration the deadline is reset (we don't
    // enforce the discount server-side — this is messaging, not billing).
    //
    // Form submit POSTs to /api/sign-intent which inserts into the
    // signature_intents Supabase table and (best-effort) emails Tim.
    (function () {
      var section = document.querySelector('.pub-cta-final');
      if (!section) return;

      var proposalId = section.getAttribute('data-proposal-id') || '';
      var bidTotal = parseFloat(section.getAttribute('data-bid-total') || '0');
      var slug = (window.location.pathname.split('/p/')[1] || '').replace(/\\/$/, '');
      var DISCOUNT_PERCENT = 5;

      var hoursEl = document.getElementById('ctaHours');
      var minsEl  = document.getElementById('ctaMins');
      var secsEl  = document.getElementById('ctaSecs');
      var signBtn = document.getElementById('ctaSignBtn');

      // ─── Countdown ─────────────────────────────────────────────────────
      // Publish-time-anchored deadline: stamped into HTML as
      // data-publish-deadline at snapshot generation. All viewers count
      // down toward the same fixed moment — so a homeowner who opens the
      // page 3 days late sees an expired window, not a fresh 48h.
      //
      // Fallback: if the attribute is missing or unparseable (defensive
      // against future schema changes or copy-paste corruption), default
      // to 48h from page load. This is per-session, not persisted.
      var publishDeadlineStr = section.getAttribute('data-publish-deadline');
      var deadline = publishDeadlineStr ? Date.parse(publishDeadlineStr) : NaN;
      if (!Number.isFinite(deadline)) {
        deadline = Date.now() + 48 * 60 * 60 * 1000;
      }

      function pad(n) { return String(n).padStart(2, '0'); }
      var expired = false;
      function tick() {
        var remaining = deadline - Date.now();
        if (remaining <= 0) {
          if (!expired) {
            expired = true;
            // Hide every element with .pub-cta-discount-block — eyebrow,
            // headline, lede, countdown, expired-msg — via the CSS rule
            // that targets .pub-cta-final.is-discount-expired. The sign
            // button + secondary contact links remain.
            section.classList.add('is-discount-expired');
          }
          return;
        }
        var totalSec = Math.floor(remaining / 1000);
        var h = Math.floor(totalSec / 3600);
        var m = Math.floor((totalSec % 3600) / 60);
        var s = totalSec % 60;
        if (hoursEl) hoursEl.textContent = pad(h);
        if (minsEl)  minsEl.textContent  = pad(m);
        if (secsEl)  secsEl.textContent  = pad(s);
      }
      tick();
      setInterval(tick, 1000);

      // ─── Sign modal ────────────────────────────────────────────────────
      var modal     = document.getElementById('pubSignModal');
      var modalClose= document.getElementById('pubSignModalClose');
      var cancelBtn = document.getElementById('pubSignCancel');
      var form      = document.getElementById('pubSignForm');
      var submitBtn = document.getElementById('pubSignSubmit');
      var errorEl   = document.getElementById('pubSignError');
      var successEl = document.getElementById('pubSignSuccess');
      if (!modal || !signBtn || !form) return;

      function openModal() {
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        setTimeout(function () {
          var firstInput = modal.querySelector('input[name="name"]');
          if (firstInput) firstInput.focus();
        }, 80);
      }
      function closeModal() {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
      }

      signBtn.addEventListener('click', openModal);
      modalClose.addEventListener('click', closeModal);
      cancelBtn.addEventListener('click', closeModal);
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeModal();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
      });

      // ─── Form submit ───────────────────────────────────────────────────
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (errorEl) errorEl.hidden = true;

        var fd = new FormData(form);
        var payload = {
          proposal_id: proposalId,
          slug: slug,
          viewer_name:    (fd.get('name')    || '').trim(),
          viewer_email:   (fd.get('email')   || '').trim(),
          viewer_phone:   (fd.get('phone')   || '').trim(),
          viewer_message: (fd.get('message') || '').trim(),
          referrer: document.referrer || '',
        };

        if (!payload.proposal_id) {
          showError('This proposal is missing an identifier — please call Tim directly.');
          return;
        }
        if (!payload.viewer_name) {
          showError('Please enter your name.');
          return;
        }
        if (!payload.viewer_email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(payload.viewer_email)) {
          showError('Please enter a valid email address.');
          return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending…';

        fetch('/api/sign-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(function (r) {
            if (!r.ok) {
              return r.json().then(
                function (j) { throw new Error(j.error || ('Server error ' + r.status)); },
                function ()  { throw new Error('Server error ' + r.status); }
              );
            }
            return r.json();
          })
          .then(function () {
            form.hidden = true;
            if (successEl) successEl.hidden = false;
          })
          .catch(function (err) {
            showError((err && err.message) || 'Something went wrong. Please call Tim directly at the number below.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Send for signatures →';
          });
      });

      function showError(msg) {
        if (!errorEl) return;
        errorEl.textContent = msg;
        errorEl.hidden = false;
      }
    })();
  </script>
<script src="/js/homeowner-revision-cta.js" type="module"></script>
</body>
</html>`;
}

// ───────────────────────────────────────────────────────────────────────────
// Template partials
// ───────────────────────────────────────────────────────────────────────────
function buildHeroBanner(url) {
  if (!url) return '';
  return `
    <div class="pub-hero-banner-wrap">
      <img src="${escapeAttr(url)}" alt="Project rendering" class="pub-hero-banner">
    </div>
  `;
}

// Phase 6.5 — change-note banner. Rendered between the header and the hero
// when the designer typed a non-empty "what changed" note before publishing.
//
// The banner is dismissable per-viewer via localStorage. Key includes a
// hash of the note text so re-publishing with a NEW note re-shows the
// banner — otherwise a homeowner who dismissed v3's note would never see
// v4's note.
function buildChangeNoteBanner(changeNote, proposal) {
  if (!changeNote || !changeNote.trim()) return '';
  const note = changeNote.trim();
  // Simple non-cryptographic hash so the dismiss key changes when the
  // note changes. Java string hashCode equivalent — fine for this use.
  let hash = 0;
  for (let i = 0; i < note.length; i++) {
    hash = ((hash << 5) - hash) + note.charCodeAt(i);
    hash |= 0;
  }
  const dismissKey = `bpb-change-note-dismiss-${proposal.id || 'x'}-${hash}`;
  const dateStr = formatDate(new Date());

  return `
    <style>
      .pub-changed-banner-wrap {
        background: linear-gradient(135deg, #f0f4f1, #faf8f3);
        border-bottom: 1px solid #d8dbd2;
        padding: 24px 32px;
        font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      }
      .pub-changed-banner {
        max-width: 880px;
        margin: 0 auto;
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 18px;
        align-items: start;
      }
      .pub-changed-banner-icon {
        width: 38px;
        height: 38px;
        border-radius: 50%;
        background: #9c7440;
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 17px;
        flex-shrink: 0;
      }
      .pub-changed-banner-body { min-width: 0; }
      .pub-changed-banner-title {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #9c7440;
        margin-bottom: 4px;
      }
      .pub-changed-banner-meta {
        font-size: 12px;
        color: #888;
        margin-bottom: 10px;
      }
      .pub-changed-banner-text {
        font-size: 15px;
        line-height: 1.55;
        color: #353535;
        white-space: pre-wrap;
        margin: 0;
      }
      .pub-changed-banner-dismiss {
        background: transparent;
        border: 1px solid transparent;
        color: #999;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        padding: 6px 10px;
        border-radius: 4px;
        flex-shrink: 0;
        align-self: start;
      }
      .pub-changed-banner-dismiss:hover {
        background: #fff;
        color: #353535;
        border-color: #d8d2bf;
      }
      @media (max-width: 640px) {
        .pub-changed-banner-wrap { padding: 18px 20px; }
        .pub-changed-banner {
          grid-template-columns: auto 1fr;
          gap: 12px;
        }
        .pub-changed-banner-dismiss {
          grid-column: 1 / -1;
          justify-self: end;
          margin-top: 4px;
        }
      }
    </style>
    <div class="pub-changed-banner-wrap" id="pubChangedBanner" data-dismiss-key="${escapeAttr(dismissKey)}">
      <div class="pub-changed-banner">
        <div class="pub-changed-banner-icon" aria-hidden="true">✨</div>
        <div class="pub-changed-banner-body">
          <div class="pub-changed-banner-title">What's new in this version</div>
          <div class="pub-changed-banner-meta">Posted ${escapeHtml(dateStr)} by Tim</div>
          <p class="pub-changed-banner-text">${escapeHtml(note)}</p>
        </div>
        <button type="button" class="pub-changed-banner-dismiss" id="pubChangedBannerDismiss" aria-label="Dismiss this notice">Dismiss</button>
      </div>
    </div>
    <script>
      (function () {
        var wrap = document.getElementById('pubChangedBanner');
        if (!wrap) return;
        var key = wrap.getAttribute('data-dismiss-key');
        try {
          if (localStorage.getItem(key) === '1') {
            wrap.style.display = 'none';
            return;
          }
        } catch (e) {}
        var btn = document.getElementById('pubChangedBannerDismiss');
        if (btn) {
          btn.addEventListener('click', function () {
            try { localStorage.setItem(key, '1'); } catch (e) {}
            wrap.style.display = 'none';
          });
        }
      })();
    </script>
  `;
}

// Construction drawing featured section. Renders as its own framed block
// between the hero/Loom and the Scope of Work. Returns an empty string
// when nothing is available, so unselected proposals render unchanged.
//
// Two render paths:
//
//   • Phase 1B polygon-overlay path: when the proposal has labeled regions
//     (proposal_regions, drawn in the site-map labeling tool admin UI) AND
//     a backdrop image with stored native dimensions, render the backdrop
//     with an SVG overlay of clickable polygons. Each polygon scrolls to
//     its corresponding scope section anchor (#section-{uuid}) when
//     proposal_section_id is set; unlinked regions render as visual
//     markers only. No lightbox in this mode — the polygons are the
//     primary interaction.
//
//   • Sprint 3 Part D legacy path: when no regions exist, fall back to the
//     existing construction_drawing_url with lightbox-to-zoom. Preserved
//     byte-identical so the 40 already-published proposals continue to
//     behave exactly as before.
function buildDrawingSection(proposal, regions, materials, categoryToSection) {
  const hasRegions = Array.isArray(regions) && regions.length > 0;
  const hasBackdrop = proposal.site_plan_backdrop_url
    && proposal.site_plan_backdrop_width
    && proposal.site_plan_backdrop_height;

  if (hasRegions && hasBackdrop) {
    return renderBackdropWithRegions(proposal, regions, materials, categoryToSection);
  }

  if (!proposal.construction_drawing_url) return '';
  return `
    <section class="pub-drawing">
      <div class="pub-drawing-inner">
        <div class="pub-section-eyebrow">Construction drawing</div>
        <h2>Your project plan</h2>
        <p class="pub-section-lede">The working plan-view for your project — dimensions, material zones, and elevations captured in a single reference.</p>
        <div class="pub-drawing-frame">
          <button type="button" class="pub-lightbox-trigger pub-drawing-link"
                  data-lightbox-src="${escapeAttr(proposal.construction_drawing_url)}"
                  data-lightbox-alt="Construction drawing"
                  data-gallery="drawing"
                  aria-label="Open construction drawing full size">
            <img src="${escapeAttr(proposal.construction_drawing_url)}" alt="Construction drawing" class="pub-drawing-img">
          </button>
        </div>
        <p class="pub-drawing-caption">Click to view full size.</p>
      </div>
    </section>
  `;
}

// Phase 1B — polygon overlay renderer (Phase 1B.4 — hybrid full-width layout).
//
// Reads the backdrop's native pixel dimensions from the proposals row
// (set when the labeling tool uploads the backdrop) and uses them as
// the SVG viewBox. Polygon vertices are stored as {x, y} fractions in
// [0..1] of those native dimensions, so converting to user-space coords
// is a single multiplication per vertex.
//
// Layout (Phase 1B.4): a single stacked column. Top: full-width construction
// drawing with the SVG polygon overlay. Middle: a horizontal "region legend"
// strip — one row per region with a color dot, region name, and sqft/lnft.
// Each row is an <a> link to the region's scope section so clicking it
// scrolls to that part of the breakdown below. Bottom: the materials grid
// (formerly Section 02). Each material card carries chips showing which
// regions use it ("Pavers", "Pergola Paver Area"), with the matching
// color dots, plus a data-region-ids="..." attribute consumed by the
// inline hover-sync IIFE rendered at the end of the section.
//
// Hover sync is bidirectional in three directions:
//   • polygons    → light the matching legend row + any material cards
//                   referencing that region
//   • legend rows → light the matching polygon + any material cards
//                   referencing that region
//   • material cards → light every polygon + legend row referenced in
//                       that card's data-region-ids
//
// Each polygon either wraps in <a href="#section-{uuid}"> for click-to-
// scroll (when proposal_section_id is set) or renders as a static visual
// marker (when not). Smooth scroll is enabled globally via
// `html { scroll-behavior: smooth }` in the snapshot CSS, and the
// `scroll-margin-top: 32px` rule on .pub-scope-item ensures the section
// header isn't crammed against the top of the viewport on landing.
// Phase 1B.4 — distinct stable colors for region overlays. Each region
// gets one of these by display order, used for both the polygon outline
// and the matching legend dot / badge dot on material cards. Picked to
// be visually distinct on a busy SketchUp drawing (the SVG fill itself
// stays the green from .pub-drawing-region; these colors only appear in
// the legend strip and material badges to identify each region).
const REGION_LEGEND_COLORS = [
  '#9c7440', '#3b82f6', '#f59e0b', '#a855f7', '#ec4899',
  '#14b8a6', '#f97316', '#06b6d4', '#84cc16', '#ef4444',
];

// Phase 1B.4 — for each material id, return the list of region rows
// (full region objects) that reference it via proposal_region_materials.
// Used to render usage badges on each material card and to populate
// data-region-ids for hover sync.
function buildMaterialRegionMap(regions) {
  const map = new Map();
  for (const r of regions) {
    const assignments = Array.isArray(r.region_materials) ? r.region_materials : [];
    for (const a of assignments) {
      if (!a || !a.proposal_material_id) continue;
      if (!map.has(a.proposal_material_id)) map.set(a.proposal_material_id, []);
      map.get(a.proposal_material_id).push(r);
    }
  }
  return map;
}

// Phase 1B.4 — render one row of the legend strip below the map.
// Click navigates to the region's scope section; hover lights the matching
// polygon and any material cards that reference this region.
//
// Sprint 14C.7 fix: a region without proposal_section_id used to be filtered
// out at the call site, which silently broke the entire region-aware
// reader layout (no legend → p-customize.js extractRegions() returned []
// → 2-col PROJECT TOTAL sidebar never activated → page degraded to the
// pre-Phase-1B static-image layout). Now unanchored regions render as a
// <div> instead of an <a>; the click-to-jump behavior just doesn't fire,
// but everything else (legend dot, region name, area, hover sync with the
// map and material cards, p-customize transformation) works identically.
function renderLegendRow(region, color) {
  const sqft = region.area_sqft != null && Number(region.area_sqft) > 0
    ? `${Number(region.area_sqft).toLocaleString('en-US')} sqft` : '';
  const lnft = region.area_lnft != null && Number(region.area_lnft) > 0
    ? `${Number(region.area_lnft).toLocaleString('en-US')} lnft` : '';
  const meta = [sqft, lnft].filter(Boolean).join(' · ');

  const innerHtml = `
      <span class="pub-region-legend-dot" style="background:${color};"></span>
      <span class="pub-region-legend-text">
        <span class="pub-region-legend-name">${escapeHtml(region.name || 'Region')}</span>
        ${meta ? `<span class="pub-region-legend-meta">${escapeHtml(meta)}</span>` : ''}
      </span>`;

  if (region.proposal_section_id) {
    return `
    <a href="#section-${escapeAttr(region.proposal_section_id)}" class="pub-region-legend-row" data-region-id="${escapeAttr(region.id)}">${innerHtml}
    </a>`;
  }
  return `
    <div class="pub-region-legend-row" data-region-id="${escapeAttr(region.id)}">${innerHtml}
    </div>`;
}

function renderBackdropWithRegions(proposal, regions, materials, categoryToSection) {
  const W = proposal.site_plan_backdrop_width;
  const H = proposal.site_plan_backdrop_height;
  const url = proposal.site_plan_backdrop_url;

  // Stable color per region by display order, reused everywhere a region
  // is referenced (legend dot + material-card badge dot).
  const regionColors = new Map();
  regions.forEach((r, i) => {
    regionColors.set(r.id, REGION_LEGEND_COLORS[i % REGION_LEGEND_COLORS.length]);
  });

  const polygons = regions.map(r => {
    const verts = Array.isArray(r.polygon) ? r.polygon : [];
    if (verts.length < 3) return ''; // degenerate, skip

    // Convert fractional coords (0..1) to viewBox user units. One decimal
    // place is plenty of precision for an SVG up to a few thousand units
    // wide and keeps the snapshot HTML compact.
    const points = verts
      .map(v => `${(Number(v.x) * W).toFixed(1)},${(Number(v.y) * H).toFixed(1)}`)
      .join(' ');

    const labelAttr = r.name ? ` aria-label="${escapeAttr(r.name)}"` : '';
    const dataAttr = ` data-region-id="${escapeAttr(r.id)}"`;

    if (r.proposal_section_id) {
      return `<a href="#section-${escapeAttr(r.proposal_section_id)}"${labelAttr}>` +
             `<polygon class="pub-drawing-region" points="${points}"${dataAttr} />` +
             `</a>`;
    }
    return `<polygon class="pub-drawing-region pub-drawing-region--static" points="${points}"${dataAttr}${labelAttr} />`;
  }).filter(Boolean).join('');

  const anyLinked = regions.some(r => r.proposal_section_id);
  const caption = anyLinked
    ? 'Tap any highlighted area on the plan — or any material below — to see how it connects to the scope.'
    : 'Highlighted areas show the scope of work for this project.';

  const lede = anyLinked
    ? 'Your project at a glance. Each highlighted area on the plan corresponds to a part of the scope below — hover any region or material to see how they connect.'
    : 'The working plan-view for your project — highlighted areas show the scope of work for each part of the project.';

  // Sprint 14C.7 fix: the legend used to filter out regions without a
  // proposal_section_id. That meant a proposal where the designer drew
  // polygons but skipped the "anchor to scope section" step in the editor
  // produced a snapshot with NO legend block at all, which silently
  // disabled the 2-col reader layout for the entire page (p-customize.js
  // bails when extractRegions() returns []). Now every region with a
  // polygon gets a legend row; renderLegendRow degrades to a non-clickable
  // <div> if proposal_section_id is null. Section-anchored regions still
  // work the same: clicking jumps to the scope section.
  const legendHtml = regions
    .map(r => renderLegendRow(r, regionColors.get(r.id)))
    .join('');

  // Phase 1B.4 — materials grid lives inside the site plan section now,
  // beneath the legend. Each card carries data-region-ids for hover sync
  // and a small chip strip showing which regions use it.
  const materialRegions = buildMaterialRegionMap(regions);
  const materialCards = (materials || [])
    .map(m => renderMaterialCard(m, categoryToSection, materialRegions, regionColors))
    .join('');

  const materialsBlock = materialCards ? `
        <div class="pub-site-plan-materials">
          <div class="pub-site-plan-materials-eyebrow">Materials</div>
          <h3 class="pub-site-plan-materials-heading">Selected for your project</h3>
          <p class="pub-site-plan-materials-lede">Each material below carries chips indicating which regions on the plan it's used for. Hover a card to highlight those regions on the drawing.</p>
          <div class="pub-materials-grid">${materialCards}</div>
        </div>` : '';

  return `
    <section class="pub-drawing">
      <div class="pub-drawing-inner">
        <div class="pub-section-eyebrow">01 / Site plan</div>
        <h2>Your project plan</h2>
        <p class="pub-section-lede">${escapeHtml(lede)}</p>

        <div class="pub-site-plan-map">
          <div class="pub-drawing-frame">
            <div class="pub-drawing-overlay-wrap">
              <img src="${escapeAttr(url)}" alt="Construction drawing" class="pub-drawing-overlay-img">
              <svg class="pub-drawing-overlay-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">${polygons}</svg>
            </div>
          </div>
          <p class="pub-drawing-caption">${escapeHtml(caption)}</p>
        </div>

        ${legendHtml ? `<div class="pub-region-legend">${legendHtml}</div>` : ''}

        ${materialsBlock}
      </div>
    </section>
    <script>
      (function () {
        var polygons = Array.prototype.slice.call(
          document.querySelectorAll('polygon[data-region-id]')
        );
        var legendRows = Array.prototype.slice.call(
          document.querySelectorAll('.pub-region-legend-row[data-region-id]')
        );
        var materialCards = Array.prototype.slice.call(
          document.querySelectorAll('.pub-material-card[data-region-ids]')
        );
        if (!polygons.length) return;

        // setActiveByIds toggles .is-active on every polygon, legend row,
        // and material card whose region IDs intersect with the given set.
        // Used by all three hover sources — polygons, legend rows, material
        // cards — so any of them can light the others.
        function setActiveByIds(ids, active) {
          if (!ids || !ids.length) return;
          var idSet = {};
          for (var i = 0; i < ids.length; i++) idSet[ids[i]] = true;
          polygons.forEach(function (p) {
            if (idSet[p.getAttribute('data-region-id')]) {
              p.classList.toggle('is-active', active);
            }
          });
          legendRows.forEach(function (r) {
            if (idSet[r.getAttribute('data-region-id')]) {
              r.classList.toggle('is-active', active);
            }
          });
          materialCards.forEach(function (c) {
            var cardIds = (c.getAttribute('data-region-ids') || '').split(',').filter(Boolean);
            for (var j = 0; j < cardIds.length; j++) {
              if (idSet[cardIds[j]]) {
                c.classList.toggle('is-active', active);
                break;
              }
            }
          });
        }

        polygons.forEach(function (p) {
          var rid = p.getAttribute('data-region-id');
          if (!rid) return;
          p.addEventListener('mouseenter', function () { setActiveByIds([rid], true); });
          p.addEventListener('mouseleave', function () { setActiveByIds([rid], false); });
        });
        legendRows.forEach(function (r) {
          var rid = r.getAttribute('data-region-id');
          if (!rid) return;
          r.addEventListener('mouseenter', function () { setActiveByIds([rid], true); });
          r.addEventListener('mouseleave', function () { setActiveByIds([rid], false); });
        });
        materialCards.forEach(function (c) {
          var cardIds = (c.getAttribute('data-region-ids') || '').split(',').filter(Boolean);
          if (!cardIds.length) return;
          c.addEventListener('mouseenter', function () { setActiveByIds(cardIds, true); });
          c.addEventListener('mouseleave', function () { setActiveByIds(cardIds, false); });
        });
      })();
    </script>
  `;
}

function renderScopeSection(sections, totalAmount) {
  if (!sections.length) return '';

  const items = sections.map((s, i) => {
    const lineItemsHtml = formatLineItemsHtml(s.line_items);
    const amount = s.total_amount != null ? formatMoney(s.total_amount) : '';
    const indexNum = String(i + 1).padStart(2, '0');
    return `
      <li class="pub-scope-item" id="section-${escapeAttr(s.id)}">
        <div class="pub-scope-item-header">
          <div class="pub-scope-item-header-text">
            <div class="pub-scope-item-eyebrow">Section ${escapeHtml(indexNum)}</div>
            <div class="pub-scope-item-name">${escapeHtml(s.name || 'Untitled section')}</div>
          </div>
          ${amount ? `<div class="pub-scope-item-amount num">${escapeHtml(amount)}</div>` : ''}
        </div>
        ${lineItemsHtml}
      </li>
    `;
  }).join('');

  const totalRow = totalAmount != null ? `
    <div class="pub-scope-total">
      <span class="pub-scope-total-label">Project total</span>
      <span class="pub-scope-total-amount num">${escapeHtml(formatMoney(totalAmount))}</span>
    </div>
  ` : '';

  return `
    <section class="pub-section">
      <div class="pub-section-eyebrow">02 / Scope of work</div>
      <h2>The complete breakdown</h2>
      <p class="pub-section-lede">Everything included in your project, organized by section. Each line is one piece of the work, with materials, colors, and construction details called out where relevant.</p>
      <ul class="pub-scope-list">${items}</ul>
      ${totalRow}
    </section>
  `;
}

function renderMaterialsSection(materials, categoryToSection) {
  if (!materials.length) return '';

  const groups = groupMaterialsByArea(materials);
  const groupsHtml = Object.entries(groups).map(([area, items]) => `
    <div class="pub-materials-group">
      <div class="pub-materials-group-header">
        <div class="pub-materials-group-name">${escapeHtml(area)}</div>
        <div class="pub-materials-group-count">${items.length} ${items.length === 1 ? 'product' : 'products'}</div>
      </div>
      <div class="pub-materials-grid">
        ${items.map(m => renderMaterialCard(m, categoryToSection)).join('')}
      </div>
    </div>
  `).join('');

  return `
    <section class="pub-section">
      <div class="pub-section-eyebrow">02</div>
      <h2>Selected materials</h2>
      <p class="pub-section-lede">Products chosen for your project, grouped by application area. Click any material for its cut sheet or installation walkthrough.</p>
      ${groupsHtml}
    </section>
  `;
}

// Phase 1B.7 — short, homeowner-friendly label for a material's category.
// Belgard category names ("Freestanding and Retaining Walls", "Coping, Caps,
// Edgers and Steps") and third-party categories ("decking") get normalized
// to the kind of label a buyer would naturally use ("Retaining Wall",
// "Coping & Edges", "Decking"). Unknown categories fall back to titlecase.
function formatMaterialType(rawCategory) {
  if (!rawCategory) return '';
  const lower = String(rawCategory).toLowerCase().trim();
  const map = {
    'concrete pavers': 'Pavers',
    'porcelain pavers': 'Porcelain Pavers',
    'freestanding and retaining walls': 'Retaining Wall',
    'coping, caps, edgers and steps': 'Coping & Edges',
    'fire features': 'Fire Feature',
    'accessories': 'Accessory',
    'decking': 'Decking',
    'turf': 'Artificial Turf',
    'lighting': 'Landscape Lighting',
  };
  if (map[lower]) return map[lower];
  // Fallback: titlecase the raw value
  return String(rawCategory).replace(/\b\w/g, c => c.toUpperCase());
}

// Phase 1B.4 — material card with color subtitle, region usage chips, and
// hover-sync wiring.
//
// Phase 1B.7 — also renders a Material Type eyebrow above the product name
// (e.g. "PAVERS", "RETAINING WALL") so the buyer immediately knows what
// kind of product each card represents.
//
// Signature is backwards-compatible — `materialRegions` and `regionColors`
// are optional. When omitted (legacy renderMaterialsSection path used by
// proposals without labeled regions) the card renders without badges or
// data-region-ids, which is the original behavior.
function renderMaterialCard(m, categoryToSection, materialRegions, regionColors) {
  const info = extractMaterialInfo(m, categoryToSection);
  const usedInRegions = materialRegions ? (materialRegions.get(m.id) || []) : [];

  // Phase 1B.7 — material type label. Belgard pulls from the resolved
  // category_name (loaded by the materials loader). Third-party uses
  // its own `category` text column. Either source is normalized to a
  // short, homeowner-friendly label by formatMaterialType.
  let rawCategory = '';
  if (m.belgard_material && m.belgard_material.category_name) {
    rawCategory = m.belgard_material.category_name;
  } else if (m.third_party_material && m.third_party_material.category) {
    rawCategory = m.third_party_material.category;
  }
  const materialType = formatMaterialType(rawCategory);

  // Color/pattern subtitle. Belgard uses color + pattern; third-party uses
  // manufacturer + color. Empty if neither catalog row supplies anything.
  const subtitleParts = [];
  if (m.belgard_material) {
    if (m.belgard_material.color) subtitleParts.push(m.belgard_material.color);
    if (m.belgard_material.pattern) subtitleParts.push(m.belgard_material.pattern);
  } else if (m.third_party_material) {
    if (m.third_party_material.manufacturer) subtitleParts.push(m.third_party_material.manufacturer);
    if (m.third_party_material.color) subtitleParts.push(m.third_party_material.color);
  }
  const colorSub = subtitleParts.join(' · ');

  const imgHtml = info.imageUrl
    ? `<button type="button" class="pub-lightbox-trigger"
              data-lightbox-src="${escapeAttr(info.imageUrl)}"
              data-lightbox-alt="${escapeAttr(info.name)}"
              data-gallery="materials"
              aria-label="Open ${escapeAttr(info.name)} full size">
         <img src="${escapeAttr(info.imageUrl)}" alt="${escapeAttr(info.name)}">
       </button>`
    : `<div class="pub-material-card-placeholder">${escapeHtml((info.name || 'Material').slice(0, 3).toUpperCase())}</div>`;

  const regionBadges = usedInRegions.map(r => {
    const color = regionColors ? (regionColors.get(r.id) || '#9c7440') : '#9c7440';
    return `<span class="pub-region-badge"><span class="pub-region-badge-dot" style="background:${color};"></span>${escapeHtml(r.name || 'Region')}</span>`;
  }).join('');

  const cutSheetBtn = info.cutSheetUrl ? `
    <a href="${escapeAttr(info.cutSheetUrl)}" target="_blank" rel="noopener" class="pub-material-card-action">
      <span>Cut sheet</span><span>↗</span>
    </a>
  ` : '';

  const installBtn = info.installGuideUrl ? `
    <a href="${escapeAttr(info.installGuideUrl)}" target="_blank" rel="noopener" class="pub-material-card-action">
      <span>Installation guide</span><span>↗</span>
    </a>
  ` : '';

  const actions = (cutSheetBtn || installBtn)
    ? `<div class="pub-material-card-actions">${cutSheetBtn}${installBtn}</div>`
    : '';

  // data-region-ids drives the hover-sync IIFE in renderBackdropWithRegions.
  // Cards without any region usage still render (the material is in the
  // proposal, just not assigned to a polygon yet) but skip the attr so they
  // don't participate in the sync.
  const regionIdsAttr = usedInRegions.length
    ? ` data-region-ids="${usedInRegions.map(r => escapeAttr(r.id)).join(',')}"`
    : '';

  return `
    <div class="pub-material-card"${regionIdsAttr}>
      ${imgHtml}
      <div class="pub-material-card-body">
        ${materialType ? `<div class="pub-material-card-type">${escapeHtml(materialType)}</div>` : ''}
        <div class="pub-material-card-name">${escapeHtml(info.name)}</div>
        ${colorSub ? `<div class="pub-material-card-color">${escapeHtml(colorSub)}</div>` : ''}
        ${regionBadges ? `<div class="pub-material-card-regions">${regionBadges}</div>` : ''}
        ${actions}
      </div>
    </div>
  `;
}

function groupMaterialsByArea(materials) {
  const groups = {};
  for (const m of materials) {
    const area = m.application_area || 'Other materials';
    if (!groups[area]) groups[area] = [];
    groups[area].push(m);
  }
  return groups;
}

function extractMaterialInfo(m, categoryToSection) {
  // Look up a page-anchored deep link to the master Belgard install guide
  // PDF based on the material's category. If no section is mapped, fall
  // back to the generic Paver Portal install guide URL when installation_guide_id
  // is set (preserves Sprint 1 behavior for unmapped materials).
  const lookupInstallGuide = (catalogRow) => {
    if (categoryToSection && catalogRow.category_id) {
      const section = categoryToSection.get(catalogRow.category_id);
      if (section && Number.isFinite(section.page_start)) {
        return `${BELGARD_MASTER_INSTALL_GUIDE_URL}#page=${section.page_start}`;
      }
    }
    return catalogRow.installation_guide_id ? INSTALL_GUIDE_URL : '';
  };

  if (m.material_source === 'belgard' && m.belgard_material) {
    const bm = m.belgard_material;
    return {
      name: bm.product_name || 'Belgard product',
      // Preference order (Sprint 3 Part A): per-color swatch beats the
      // generic product hero. Once a variant has its Scandina Gray / Sepia /
      // etc. swatch uploaded, it displays instead of the shared Catalina
      // Grana beauty shot. Falls back to primary_image_url (category-level
      // hero from Sprint 2A) and then to legacy image_url.
      imageUrl: bm.swatch_url
        || bm.primary_image_url
        || bm.image_url
        || '',
      cutSheetUrl: bm.cut_sheet_url || '',
      installGuideUrl: lookupInstallGuide(bm),
    };
  }
  if (m.material_source === 'third_party' && m.third_party_material) {
    const tp = m.third_party_material;

    // Sprint 3I — for Tru-Scapes, the single client-facing PDF IS the cut
    // sheet (no separate install guide document). Route it to the cut sheet
    // slot so the card renders "View cut sheet" instead of "See installation".
    // Detection reuses TRU_SCAPES_PATTERN from the install-guide router so
    // both places stay in sync.
    const resolvedUrl = resolveThirdPartyInstallUrl(tp);
    const haystack = `${tp.manufacturer || ''} ${tp.product_name || ''} ${tp.category || ''}`;
    const isTruScapes = TRU_SCAPES_PATTERN.test(haystack);

    return {
      name: tp.product_name || 'Third-party product',
      imageUrl: tp.primary_image_url
        || tp.image_url
        || '',
      cutSheetUrl: tp.cut_sheet_url || (isTruScapes ? resolvedUrl : ''),
      installGuideUrl: isTruScapes ? '' : resolvedUrl,
    };
  }
  return { name: 'Material', imageUrl: '', cutSheetUrl: '', installGuideUrl: '' };
}

// ───────────────────────────────────────────────────────────────────────────
// Third-party install guide router (Sprint 3 Part E)
//
// Maps a third_party_materials row to the most appropriate client-facing
// install/product guide PDF. Routing is pattern-based against manufacturer
// + product_name + category:
//
//   • Tru-Scapes lighting products → TRU_SCAPES_PRODUCT_GUIDE_URL
//   • Turf products (explicit turf/grass terms OR known MSI turf product
//     names — Summer Gold, Platinum Spring, Arizona Platinum)
//     → EVERGRASS_INSTALL_GUIDE_URL
//   • Anything else with installation_guide_id set → generic Paver Portal guide
//   • Otherwise no link (card renders without the "See installation" button,
//     same as pre-Sprint-3E behavior for unknown products)
//
// Patterns are conservative — "MSI" alone isn't enough to trigger the turf
// route since MSI also makes tile, countertops, and flooring; we require a
// known turf product line in the name. When Tim adds new MSI turf variants
// with different SKU names, add them to the TURF_SPECIFIC_PATTERN regex.
//
// Sprint 3J note — the turf patterns were split into GENERIC (plain "turf",
// "artificial grass", "synthetic grass") and SPECIFIC (brand/product names)
// so the prep-card detection logic can scan scope text safely with only the
// specific pattern. This router still uses the COMBINED TURF_PRODUCT_PATTERNS
// because a third_party_materials row is authoritative — if it's categorized
// as turf at all, route it to the Evergrass PDF.
// ───────────────────────────────────────────────────────────────────────────
const TRU_SCAPES_PATTERN = /tru-?\s*scapes?/i;

// Split from the original single TURF_PRODUCT_PATTERNS in Sprint 3J so that
// prep-card scope scanning doesn't false-positive on demolition language.
//
// GENERIC — the word "turf" and its synonyms. These show up in too many
// non-install contexts to scan scope text with: demolition ("remove existing
// turf"), sod installation ("sod/lawn"), site descriptions, etc. These only
// trigger the turf prep card when they appear on a third_party_materials row.
const TURF_GENERIC_PATTERN = /\b(turf|artificial\s+grass|synthetic\s+grass)\b/i;

// SPECIFIC — product/brand names that only appear in proposals where that
// product is actually being installed. Safe to match in scope line items
// even when the product hasn't been catalogued as a material yet.
const TURF_SPECIFIC_PATTERN = /\b(evergrass|summer\s+gold|platinum\s+spring|arizona\s+platinum)\b/i;

// Combined pattern — used by resolveThirdPartyInstallUrl and the
// materials-list branch of proposalHasTurf, where any turf signal on an
// explicit third_party_materials row is authoritative.
const TURF_PRODUCT_PATTERNS = new RegExp(
  TURF_GENERIC_PATTERN.source + '|' + TURF_SPECIFIC_PATTERN.source,
  'i'
);

function resolveThirdPartyInstallUrl(tp) {
  const haystack = `${tp.manufacturer || ''} ${tp.product_name || ''} ${tp.category || ''}`;

  if (TRU_SCAPES_PATTERN.test(haystack)) {
    return TRU_SCAPES_PRODUCT_GUIDE_URL;
  }
  if (TURF_PRODUCT_PATTERNS.test(haystack)) {
    return EVERGRASS_INSTALL_GUIDE_URL;
  }
  if (tp.installation_guide_id) {
    return INSTALL_GUIDE_URL;
  }
  return '';
}

// ───────────────────────────────────────────────────────────────────────────
// "Why our preparation matters" section
//
// Sprint 2 Part B.2: dynamic rendering from installation_guide_sections for
// Belgard-category materials.
// Sprint 3 Part C: extended to also render non-Belgard cards (turf,
// Tru-Scapes lighting) via pattern match against scope text + third-party
// materials. See renderThirdPartyPrepCards.
// Sprint 3 Part J: tightened turf scope-text detection to specific product
// names only, so "remove existing turf" demolition lines and sod/lawn
// references no longer trigger the turf card. Tru-Scapes detection is
// unchanged because "Tru-Scapes"/"TruScape" is unambiguous.
//
// Falls back to the hardcoded 4-card version only when neither Belgard
// sections nor third-party patterns match — keeps proposals with
// uncategorized materials from rendering an empty section.
// ───────────────────────────────────────────────────────────────────────────
function renderWhyPrepSection(installSections, sections, materials) {
  const belgardCardsHtml = (Array.isArray(installSections) && installSections.length > 0)
    ? renderDynamicPrepCards(installSections)
    : '';

  const belgardCount = Array.isArray(installSections) ? installSections.length : 0;
  // Phase 1B.4 — third-party cards now always render (turf + lighting),
  // so the rail showcases every category Paver Portal installs regardless of
  // what's in this specific bid. The proposalHasTurf / Lighting predicates
  // are no longer consulted here.
  const thirdPartyCardsHtml = renderThirdPartyPrepCards(sections, materials, belgardCount);

  const combinedHtml = belgardCardsHtml + thirdPartyCardsHtml;
  // Sprint 14C.5: legacy renderHardcodedPrepCards() fallback removed.
  // installation_guide_sections is now a hard requirement — the section
  // either renders the data-driven cards or renders empty (which itself
  // signals a misconfigured catalog). Keeping a 4-card "Proper base
  // preparation" zombie copy in production was misleading designers.
  const cardsHtml = combinedHtml;

  return `
    <section class="pub-prep">
      <div class="pub-prep-inner">
        <div class="pub-section-eyebrow">03 · Quality standards</div>
        <h2>Why our preparation matters</h2>
        <div class="pub-prep-intro">
          <p>The biggest cost difference between contractors isn't the materials — it's the work that happens before they go in. Every category we install — pavers, porcelain, retaining walls, accessories, fire features, artificial turf, low-voltage lighting — has its own preparation standard, and the standard is what determines whether your installation lasts 5 years or 30. Below is what we hold ourselves to for every category we touch.</p>
        </div>
        <div class="pub-prep-rail-wrap">
          <button type="button" class="pub-prep-rail-arrow pub-prep-rail-arrow--prev" aria-label="Scroll to previous">‹</button>
          <button type="button" class="pub-prep-rail-arrow pub-prep-rail-arrow--next" aria-label="Scroll to next">›</button>
          <div class="pub-prep-rail">
            ${cardsHtml}
          </div>
        </div>
        <div class="pub-prep-footer">
          Want to see what this looks like in practice? Ask Tim for a site visit to an active installation — it's the fastest way to understand what you're paying for.
        </div>
      </div>
    </section>
    <script>
      (function () {
        // Phase 1B.4 — Quality Standards rail nav. The arrow buttons scroll
        // the card rail by roughly one card-width (so a click feels like
        // "next card") and the buttons disable themselves at the rail's
        // start/end so the user can see how far they've scrolled.
        var wraps = document.querySelectorAll('.pub-prep-rail-wrap');
        wraps.forEach(function (wrap) {
          var rail = wrap.querySelector('.pub-prep-rail');
          var prev = wrap.querySelector('.pub-prep-rail-arrow--prev');
          var next = wrap.querySelector('.pub-prep-rail-arrow--next');
          if (!rail || !prev || !next) return;

          function scrollDir(dir) {
            // First card width + gap is a sensible scroll step. Falls back
            // to 400px if no cards present (which shouldn't happen, but
            // protects against blank rails).
            var firstCard = rail.querySelector('.pub-prep-card');
            var step = firstCard
              ? Math.round(firstCard.getBoundingClientRect().width + 20)
              : 400;
            rail.scrollBy({ left: dir * step, behavior: 'smooth' });
          }
          prev.addEventListener('click', function () { scrollDir(-1); });
          next.addEventListener('click', function () { scrollDir(1); });

          function updateArrowState() {
            var maxScroll = rail.scrollWidth - rail.clientWidth;
            prev.classList.toggle('is-disabled', rail.scrollLeft <= 4);
            next.classList.toggle('is-disabled', rail.scrollLeft >= maxScroll - 4);
          }
          rail.addEventListener('scroll', updateArrowState, { passive: true });
          window.addEventListener('resize', updateArrowState);
          updateArrowState();
        });
      })();
    </script>
  `;
}

function renderDynamicPrepCards(installSections) {
  // Order sections by their page_start in the source PDF — this matches the
  // natural flow of the Belgard guide (pavers → porcelain → walls → accessories
  // → fire features) and avoids alphabetical-by-section_key awkwardness.
  const ordered = [...installSections].sort((a, b) =>
    (a.page_start || 9999) - (b.page_start || 9999)
  );

  return ordered.map((section, idx) => {
    const number = String(idx + 1).padStart(2, '0');
    const summary = section.summary || '';
    const keyPoints = Array.isArray(section.key_points) ? section.key_points : [];
    const pointsHtml = keyPoints
      .map(p => `<li>${escapeHtml(p)}</li>`)
      .join('');
    const pdfAnchor = Number.isFinite(section.page_start)
      ? `${BELGARD_MASTER_INSTALL_GUIDE_URL}#page=${section.page_start}`
      : BELGARD_MASTER_INSTALL_GUIDE_URL;

    return `
      <div class="pub-prep-card">
        <div class="pub-prep-card-number">${number}</div>
        <div class="pub-prep-card-title">${escapeHtml(section.title || 'Installation standard')}</div>
        ${summary ? `<div class="pub-prep-card-summary">${escapeHtml(summary)}</div>` : ''}
        ${pointsHtml ? `<ul class="pub-prep-card-points">${pointsHtml}</ul>` : ''}
        <a href="${escapeAttr(pdfAnchor)}" target="_blank" rel="noopener"
          class="pub-prep-card-link">
          View the full installation standards →
        </a>
      </div>
    `;
  }).join('');
}

// ───────────────────────────────────────────────────────────────────────────
// Third-party quality-standards cards
//
// Phase 1B.4 — these always render now (turf + lighting), regardless of
// what's in this specific bid. The Quality Standards rail showcases every
// category Paver Portal installs to demonstrate breadth + expertise; gating
// these cards by proposalHasTurf / proposalHasTruScapesLighting was
// appropriate when the section was bid-scoped, but the new framing is
// "here's what we install across the board." The detection helpers are
// preserved below for any future per-bid use, but no longer consulted here.
//
// When the installation_guide_sections schema is extended to cover
// non-Belgard categories, this function migrates to a data-driven query.
// ───────────────────────────────────────────────────────────────────────────
function renderThirdPartyPrepCards(sections, materials, startIndex = 0) {
  const cards = [];

  cards.push({
    title: 'Artificial Turf Installation',
    summary: "Long-lasting synthetic turf installations depend on base preparation that matches paver-grade standards: 4–6 inches of excavation, compaction of subgrade soil, and a 3–4 inch crushed gravel base compacted in lifts. The difference between a turf installation that stays level and plush for 15 years and one that ripples, pools water, or mats down in two is whether the installer treats the base with the same rigor as a paver base. We do. We also direction-match turf pieces, use S-cut seams for invisible transitions, and finish with silica sand infill to keep blades upright and UV-protected.",
    keyPoints: [
      'Minimum 4–6 inches of excavation below finished grade, with existing sprinkler heads capped at pipe level (not the riser) to prevent leakage, and irrigation/electrical lines mapped before any digging',
      'Subgrade compacted with a minimum 5,000 lb plate compactor — the same machine used for paver bases — followed by a weed barrier on compacted subgrade; plastic sheeting is explicitly prohibited as it traps water and causes turf to heave',
      'Base layer of 3/4-inch to dust crushed gravel installed in 3–4 inch lifts, compacted with water-assist; minimum 2% slope away from structures to drainage points, identical to our paver drainage spec',
      'All turf pieces laid with blade direction matched (pile nap running the same way); seams joined via S-cut method with seam tape and synthetic turf adhesive, then secured with U-nails spaced every 6 inches along the full seam length',
      'Edges tucked with wonder bar into hardscape perimeters; silica sand infill applied via drop spreader and power-brushed into the base of the blades, then watered to settle — the infill is what keeps blades upright and the surface walkable for 15+ years',
    ],
    pdfUrl: EVERGRASS_INSTALL_GUIDE_URL,
    linkLabel: 'View the Evergrass installation guide',
  });

  cards.push({
    title: 'Landscape & Hardscape Lighting',
    summary: "Tru-Scapes® low-voltage landscape lighting covers every outdoor placement we install — path lights, accent spots, in-ground well lights, paver-integrated fixtures, step risers — with Color Control app-based tuning (RGBCW, dimming, zones). Fixture placement is intentionally flexible on every job: we finalize exact positioning during the Pre-Walk on-site, so the lighting accents what actually matters — tree canopies, walkway curves, step transitions, architectural features — rather than being locked to a blueprint before we've seen it in context.",
    keyPoints: [
      'Low-voltage 12V/15V system with Tru-Scapes® transformers sized to load (100W, 200W, or 400W WiFi-enabled) and tin-plated copper heat-shrink wire connectors for waterproof, lifetime-duty splices',
      'Color Control available on most fixtures: full-color RGBCW spectrum, warm-to-cool white tuning (2700K–6500K), dimming, and multi-zone scene control via the Tru-Scapes® Bluetooth app',
      'Fixture library covers every outdoor placement — path, accent, wall-wash, in-ground well, paver-integrated, step riser, post cap, sconce, pendant, bistro, and concrete-embed — so the same system scales from subtle to dramatic without mixing manufacturers',
      'Final placement decided at Pre-Walk: before wiring is pulled, we walk the site with you and mark each fixture location together — path lights spaced to the actual walkway curve, accent lights aimed at the real tree or feature, step lights positioned for the true stride of each tread',
      '5-year warranty on fixtures, bulbs, and transformers; all fixtures IP-rated for direct-burial and year-round outdoor use in California climate',
    ],
    pdfUrl: TRU_SCAPES_PRODUCT_GUIDE_URL,
    linkLabel: 'View the Tru-Scapes product guide',
  });

  return cards.map((c, i) => {
    const number = String(startIndex + i + 1).padStart(2, '0');
    const pointsHtml = c.keyPoints
      .map(p => `<li>${escapeHtml(p)}</li>`)
      .join('');
    return `
      <div class="pub-prep-card">
        <div class="pub-prep-card-number">${number}</div>
        <div class="pub-prep-card-title">${escapeHtml(c.title)}</div>
        <div class="pub-prep-card-summary">${escapeHtml(c.summary)}</div>
        <ul class="pub-prep-card-points">${pointsHtml}</ul>
        <a href="${escapeAttr(c.pdfUrl)}" target="_blank" rel="noopener"
          class="pub-prep-card-link">
          ${escapeHtml(c.linkLabel)} →
        </a>
      </div>
    `;
  }).join('');
}

// Sprint 3J — turf detection refactored to prevent false positives from
// demolition language ("remove existing turf") and sod/lawn references.
//
// Scope scan uses TURF_SPECIFIC_PATTERN only (brand/product names). The
// generic word "turf" is no longer enough to trigger the prep card from
// scope text. Materials-list scan still uses the combined pattern — a
// third_party_materials row with turf signal is explicit product data,
// not prose, so any match is authoritative.
function proposalHasTurf(sections, materials) {
  // Scope-text scan: ONLY match on specific product names. Demolition lines
  // like "Remove and dispose of existing turf/flagstone/tile material" and
  // grass/sod scope items must not trigger the prep card.
  if (scopeContains(sections, TURF_SPECIFIC_PATTERN)) return true;

  // Materials-list scan: combined pattern. If Tim added a turf product as
  // a third_party material, whether by specific name or generic category,
  // render the turf prep card.
  for (const m of materials || []) {
    if (m.material_source !== 'third_party') continue;
    const tp = m.third_party_material;
    if (!tp) continue;
    const hay = `${tp.manufacturer || ''} ${tp.product_name || ''} ${tp.category || ''}`;
    if (TURF_PRODUCT_PATTERNS.test(hay)) return true;
  }
  return false;
}

function proposalHasTruScapesLighting(sections, materials) {
  if (scopeContains(sections, TRU_SCAPES_PATTERN)) return true;
  for (const m of materials || []) {
    if (m.material_source !== 'third_party') continue;
    const tp = m.third_party_material;
    if (!tp) continue;
    const hay = `${tp.manufacturer || ''} ${tp.product_name || ''}`;
    if (TRU_SCAPES_PATTERN.test(hay)) return true;
  }
  return false;
}

function scopeContains(sections, regex) {
  for (const s of sections || []) {
    if (regex.test(s.name || '')) return true;
    const items = Array.isArray(s.line_items) ? s.line_items : [];
    for (const li of items) {
      const text = typeof li === 'string' ? li : (li?.description || li?.text || '');
      if (regex.test(text)) return true;
    }
  }
  return false;
}

function renderPhotosSection(photos) {
  if (!photos.length) return '';

  // Sprint 3G — partition on display_section (user-controlled classifier).
  //
  // display_section is set per-image in Section 05 of the BPB editor and
  // is migrated from extraction_source by 015_display_section.sql. For
  // rows that somehow still have null display_section (pre-migration,
  // constraint edge case, or RLS block on UPDATE during backfill), fall
  // back to the old extraction_source heuristic so nothing ever goes
  // missing silently.
  const classify = (p) => {
    if (p.display_section === 'hidden') return 'hidden';
    if (p.display_section === 'current_photo') return 'current';
    if (p.display_section === 'design_rendering') return 'rendering';
    // Fallback for unmigrated rows — mirrors Sprint 3F behavior.
    if (p.extraction_source === 'manual_upload') return 'current';
    if (p.extraction_source === 'bid_pdf_extract') return 'rendering';
    return 'hidden';
  };

  const currentPhotos = photos.filter(p => classify(p) === 'current');
  const renderings    = photos.filter(p => classify(p) === 'rendering');

  const currentHtml = renderPhotosBlock(
    currentPhotos,
    '04',
    'Current site conditions',
    'Photos of the property as it exists today.'
  );
  const renderingsHtml = renderPhotosBlock(
    renderings,
    '05',
    'Design renderings',
    'How your completed project will look — 3D renderings generated from the design plan.'
  );

  return currentHtml + renderingsHtml;
}

function renderPhotosBlock(photos, number, heading, lede) {
  if (!photos.length) return '';

  // Sprint 3H — lightbox galleries. Use the section number as the gallery
  // key so prev/next arrows cycle through images in the same section
  // (04 = current photos, 05 = design renderings) and don't mix the two.
  const gallery = 'photos-' + number;

  const groups = groupPhotosByLocation(photos);
  const groupsHtml = Object.entries(groups).map(([label, items]) => {
    const imgs = items.map(p => {
      const url = storagePublicUrl(p.storage_path);
      if (!url) return '';
      const altText = p.original_filename || heading;
      return `<button type="button" class="pub-lightbox-trigger"
                data-lightbox-src="${escapeAttr(url)}"
                data-lightbox-alt="${escapeAttr(altText)}"
                data-gallery="${escapeAttr(gallery)}"
                aria-label="Open ${escapeAttr(altText)} full size">
                <img src="${escapeAttr(url)}" alt="${escapeAttr(altText)}" loading="lazy">
              </button>`;
    }).join('');
    const countLabel = `${items.length} ${items.length === 1 ? 'photo' : 'photos'}`;
    return `
      <div class="pub-photos-group">
        <div class="pub-photos-group-header">
          <div class="pub-photos-group-label">${escapeHtml(label)}</div>
          <div class="pub-photos-group-count num">${escapeHtml(countLabel)}</div>
        </div>
        <div class="pub-photos-grid">${imgs}</div>
      </div>
    `;
  }).join('');

  return `
    <section class="pub-section">
      <div class="pub-section-eyebrow">${escapeHtml(number)}</div>
      <h2>${escapeHtml(heading)}</h2>
      <p class="pub-section-lede">${escapeHtml(lede)}</p>
      ${groupsHtml}
    </section>
  `;
}

function groupPhotosByLocation(photos) {
  const order = ['Front yard', 'Backyard', 'Side yard', 'Full property', 'Other'];
  const groups = {};
  for (const p of photos) {
    const label = p.location_tag || 'Other';
    if (!groups[label]) groups[label] = [];
    groups[label].push(p);
  }
  const ordered = {};
  for (const key of order) if (groups[key]) ordered[key] = groups[key];
  for (const key of Object.keys(groups)) if (!ordered[key]) ordered[key] = groups[key];
  return ordered;
}

function storagePublicUrl(path) {
  if (!path) return '';
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data?.publicUrl || '';
}

function publicUrl(path) {
  return storagePublicUrl(path);
}

function buildLoomEmbed(loomUrl) {
  const embed = loomUrlToEmbed(loomUrl);
  if (!embed) return '';
  return `
    <div class="pub-loom">
      <div class="pub-loom-embed">
        <iframe src="${escapeAttr(embed)}" frameborder="0"
          allowfullscreen webkitallowfullscreen mozallowfullscreen></iframe>
      </div>
    </div>
  `;
}

function loomUrlToEmbed(url) {
  if (!url) return '';
  const m = url.match(/loom\.com\/(?:share|embed)\/([a-f0-9]+)/i);
  if (!m) return '';
  return `https://www.loom.com/embed/${m[1]}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Scope line item rendering (Sprint 3 Part D)
//
// Each entry in proposal_sections.line_items comes in as either a string or
// an object with { description } / { text }. The strings follow a loose
// contractor convention that we parse into three visible pieces:
//
//   1. TYPE prefix — an ALL-CAPS phrase (2+ chars, may contain spaces,
//      slashes, en-dashes) terminated by a colon. Examples: "PAVER:",
//      "TURF:", "STEP:", "STRUCTURAL RETAINING WALL:", "PLANT INSTALLATION
//      – LABOR ONLY:". We require ALL-CAPS so we don't false-match things
//      like "Gravel:" or "Install 3/4\" pipe:" which are narrative, not type
//      tags.
//
//   2. Primary name/description — everything up to the first pipe `|`.
//      For a structured material line ("PAVER: BELGARD DIMENSIONS 12 |
//      PATTERN: RANDOM | COLOR: DURAFUSION") this is the material name.
//      For a narrative line ("STEP: Provide and install bullnose step...")
//      this is the body sentence.
//
//   3. Attribute pairs — remaining pipe-delimited segments, each expected
//      in "KEY: VALUE" shape. Gets rendered as a row of little
//      "Pattern: Random · Color: Durafusion" chips.
//
// Lines that don't match the TYPE pattern still render — they just skip the
// type chip and fall through to a plain body-text treatment. Same for lines
// with no pipes (no attributes row).
// ───────────────────────────────────────────────────────────────────────────
function formatLineItemsHtml(lineItems) {
  if (!lineItems) return '';

  const rawItems = Array.isArray(lineItems) ? lineItems : [lineItems];
  const parsed = rawItems
    .map(parseLineItem)
    .filter(Boolean);

  if (parsed.length === 0) return '';

  return `<ul class="pub-line-items">${parsed.map(renderLineItem).join('')}</ul>`;
}

function parseLineItem(raw) {
  const text = (typeof raw === 'string'
    ? raw
    : (raw?.description || raw?.text || '')).trim();
  if (!text) return null;

  let type = '';
  let rest = text;

  // ALL-CAPS prefix ending in colon. Requires the type to be at least 2
  // characters long so single-letter prefixes don't false-match. Allows
  // spaces, slashes, en-dashes, ampersands inside the type phrase.
  const typeMatch = text.match(/^([A-Z][A-Z\s\/\u2013&-]*?):\s*(.+)$/s);
  if (typeMatch && typeMatch[1].trim().length >= 2) {
    type = typeMatch[1].trim();
    rest = typeMatch[2].trim();
  }

  const parts = rest.split('|').map(p => p.trim()).filter(Boolean);
  const primary = parts[0] || '';
  const attrs = parts.slice(1).map(part => {
    const kv = part.match(/^([^:]+):\s*(.+)$/);
    if (kv) return { label: titleCaseLabel(kv[1].trim()), value: kv[2].trim() };
    return { label: '', value: part };
  });

  return { type, primary, attrs };
}

function renderLineItem({ type, primary, attrs }) {
  const typeTag = type
    ? `<span class="pub-line-item-type">${escapeHtml(type)}</span>`
    : '';

  const hasAttrs = attrs && attrs.length > 0;

  if (hasAttrs) {
    const attrsHtml = attrs.map(a => {
      if (a.label) {
        return `<span class="pub-line-item-attr"><em>${escapeHtml(a.label)}:</em>${escapeHtml(a.value)}</span>`;
      }
      return `<span class="pub-line-item-attr">${escapeHtml(a.value)}</span>`;
    }).join('');

    return `
      <li class="pub-line-item pub-line-item--structured">
        <div class="pub-line-item-head">
          ${typeTag}
          <span class="pub-line-item-name">${escapeHtml(primary)}</span>
        </div>
        <div class="pub-line-item-attrs">${attrsHtml}</div>
      </li>
    `;
  }

  return `
    <li class="pub-line-item">
      ${typeTag}
      <span class="pub-line-item-body">${escapeHtml(primary)}</span>
    </li>
  `;
}

// Title-case attribute labels so "PATTERN" renders as "Pattern", "PART
// NUMBER" as "Part Number", etc. Values are left unchanged — they contain
// proper nouns, SKU codes, and mixed-case color names that we don't want
// to re-case.
function titleCaseLabel(s) {
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// Legacy string-concatenation formatter. No longer called by renderScopeSection
// (which now uses formatLineItemsHtml), but kept exported-in-spirit for
// safety in case other callers reference it.
function formatLineItems(lineItems) {
  if (!lineItems) return '';
  if (typeof lineItems === 'string') return lineItems;
  if (!Array.isArray(lineItems)) return '';
  return lineItems
    .map(li => (typeof li === 'string' ? li : (li.description || li.text || '')))
    .filter(Boolean)
    .join(' · ');
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function setStatus(msg, kind) {
  const el = document.getElementById('bpPublishStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'bp-publish-status' + (kind ? ` bp-publish-status-${kind}` : '');
}

function showError(msg) {
  setStatus(msg, 'error');
}

function formatMoney(n) {
  const num = Number(n) || 0;
  return '$' + num.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatDate(d) {
  return d.toLocaleDateString('en-US',
    { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatDateTime(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US',
    { year: 'numeric', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US',
    { hour: 'numeric', minute: '2-digit' });
  return `${date} at ${time}`;
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
