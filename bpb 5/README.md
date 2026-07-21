# Paver Portal Proposal Builder

Internal tool for generating Paver Portal proposal pages. Replaces the hand-built HTML workflow with a repeatable pipeline: project info → bid PDF parse → material selection → site plan extraction → HTML export.

Single-user (Tim). Self-hosted on Cloudflare Pages, backed by the existing `bayside-pavers` Supabase project.

---

## Stack

- **Frontend**: vanilla JS, ES modules, no build step. Supabase JS client loaded from ESM CDN.
- **Hosting**: Cloudflare Pages (static assets in `/public`, server functions in `/functions`).
- **Database**: Supabase Postgres (`bayside-pavers` project). Tables: `proposals`, `proposal_sections`, `proposal_materials`, `proposal_images`, `third_party_materials`, `proposal_sitemaps`, plus the existing `belgard_materials` catalog.
- **APIs**: Claude API (Sonnet 4) for PDF parsing and Cam To Plan vision extraction. Called from CF Pages Functions with a server-side API key.
- **Fonts**: Playfair Display (display) + DM Sans (body). Loaded from Google Fonts.

---

## Setup (local development)

```bash
git clone <this repo>
cd bayside-proposal-builder
npm install
cp .dev.vars.example .dev.vars   # then fill in actual secrets
npm run dev                      # serves at http://localhost:8788
```

The `.dev.vars` file stores secrets for the local wrangler dev server. It is gitignored.

---

## Setup (Cloudflare Pages production)

1. Push this repo to GitHub (private).
2. In Cloudflare dashboard → Pages → **Create a project** → connect GitHub repo.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `public`
4. Environment variables (Settings → Environment variables → Production):
   - `SUPABASE_SERVICE_KEY` *(encrypted)*
   - `ANTHROPIC_API_KEY` *(encrypted)*
   - `SUPABASE_URL` (not secret but keep consistent with local)
5. Deploy.

The Supabase **anon key** is committed in `public/js/config.js` — that's intentional and safe; anon keys are designed for frontend use and row-level security governs what they can actually do. The **service role key** must stay server-side only and is never committed.

---

## Database migration

Before the tool can read or write, run the schema migration:

```
migrations/001_phase1_schema.sql
```

Paste into Supabase SQL Editor → run. It's idempotent (safe to re-run) and seeds the first two `third_party_materials` rows (Trex Transcend Lineage + Tru-Scapes).

Expected verification output after run: `third_party = 2`, all other tables `= 0`.

---

## Project structure

```
.
├── public/                      # static assets served by CF Pages
│   ├── index.html               # landing page
│   ├── dashboard.html           # proposals list
│   ├── editor.html              # proposal editor (stub in Phase 1.0)
│   ├── styles.css               # shared stylesheet
│   └── js/
│       ├── config.js            # public Supabase URL + anon key
│       ├── supabase-client.js   # initialized client (imported by pages)
│       ├── dashboard.js         # dashboard logic
│       └── editor.js            # editor logic (stub)
├── functions/                   # CF Pages Functions (server-side)
│   └── api/                     # empty in 1.0, populated in 1.2+
├── migrations/
│   └── 001_phase1_schema.sql    # run once in Supabase SQL Editor
├── .dev.vars.example            # template for local secrets
├── .gitignore
├── package.json
├── wrangler.toml                # CF Pages config
└── README.md
```

---

## Current status

### Phase 1.0 — foundation ✅ *(this commit)*

- Repo scaffolded, CF Pages config in place
- Schema migration written and ready to run
- Landing page with branded hero and feature grid
- Dashboard with proposals list, empty state, and "new proposal" creation
- Stub editor that loads a proposal by ID (proves end-to-end Supabase connectivity)

### Phase 1.1 — material picker *(next)*

- Search/filter UI over `belgard_materials` (266 rows)
- Selected-materials tray with application area per item
- "Add third-party" flow for non-Belgard products
- Persists selections to `proposal_materials` junction

### Phase 1.2 — PDF bid parser

- Drop zone for JobNimbus bid PDF
- CF Pages Function uploads to Supabase Storage
- Same function calls Claude API with structured-output prompt
- Parsed JSON populates `proposals.parsed_bid_data`, `proposal_sections`, and line items
- Review/edit UI before commit

### Phase 1.3 — HTML export

- Template function reads full proposal state
- Renders a single HTML document matching the existing hand-built proposal pages (Edgerton, Whitham, etc.)
- "Copy to clipboard" for Webflow embed, or "Publish" for standalone hosted page

### Phase 2 — Cam To Plan

Deferred per the design spike findings. Real Cam To Plan outputs have ~20 vertices and closely-packed fractional labels; single-pass vision extraction gets ~70% of edges right. The Phase 2 design includes a manual correction UI alongside the extraction pass.

### Phase 3 — polish

Multi-user auth if opening to the team, versioning for sent-vs-draft, and dedicated hosting at `proposals.mcmullen.properties` for generated pages.

---

## Data model

See [`proposal-builder-data-model.md`](./proposal-builder-data-model.md) for the full data model spec — table schemas, frontend state shape, key flows, and rationale for specific decisions.
