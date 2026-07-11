// ═══════════════════════════════════════════════════════════════════════════
// Editor coordinator.
//
// Loads the proposal, renders the sidebar + main layout, switches between
// sections. Phase 1.1 shipped Materials (03). Phase 1.2 shipped Bid PDF (02).
// Phase 1.3 shipped Photos (05). Phase 1.4 ships Preview & publish (06).
// Project info (01) and Site plan (04) remain explanatory placeholders.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';
import { initMaterials } from './materials.js';
import { initBidPdf } from './bid-pdf.js';
import { initPhotos } from './photos.js';
import { initPublish } from './publish.js';
import { initSitePlan } from './site-plan.js';
import { initBidBuilder } from './bid-builder.js';

let proposalId = null;
let proposal = null;
let currentSection = 'bid-pdf';
let saveTimer = null;

const bootError = document.getElementById('bootError');
const layout = document.getElementById('editorLayout');
const sectionContent = document.getElementById('sectionContent');
const projectTitleEl = document.getElementById('projectTitle');
const saveIndicator = document.getElementById('saveIndicator');
const editorNav = document.getElementById('editorNav');
const deleteBtn = document.getElementById('deleteProposalBtn');

// ───────────────────────────────────────────────────────────────────────────
// Bootstrap
// ───────────────────────────────────────────────────────────────────────────
async function init() {
  proposalId = new URLSearchParams(window.location.search).get('id');
  if (!proposalId) {
    bootError.innerHTML = `<div class="page"><div class="error-box">No proposal id in URL. <a href="/dashboard">Back to dashboard</a>.</div></div>`;
    return;
  }

  const loaded = await loadProposal();
  if (!loaded) return;

  layout.style.display = 'grid';
  renderProjectTitle();
  attachNavigation();
  attachDelete();
  switchSection(currentSection);
}

async function loadProposal() {
  const { data, error } = await supabase
    .from('proposals')
    .select('*')
    .eq('id', proposalId)
    .single();

  if (error) {
    bootError.innerHTML = `<div class="page"><div class="error-box">Could not load proposal: ${escapeHtml(error.message)}</div></div>`;
    return false;
  }
  proposal = data;
  // Phase 2E.1: tab title falls back through label and address before "Untitled draft".
  document.title = `${getProposalTitle(proposal)} · Editor`;
  return true;
}

function renderProjectTitle() {
  // Phase 2E.1: use shared fallback chain. When the address itself is the title,
  // show city (if any) as subtitle instead of repeating the address.
  const title = getProposalTitle(proposal);
  const subtitle = getProposalSubtitle(proposal);
  projectTitleEl.innerHTML = `
    <span class="title">${escapeHtml(title)}</span>
    ${subtitle ? `<span class="subtitle">${escapeHtml(subtitle)}</span>` : ''}
  `;
}

// Title + subtitle fallback used by the editor and matched in dashboard.js.
// Order: client_name → project_label → project_address → "Untitled draft".
function getProposalTitle(p) {
  return p.client_name || p.project_label || p.project_address || 'Untitled draft';
}
function getProposalSubtitle(p) {
  if (p.client_name || p.project_label) {
    // Real-world title — subtitle is full address.
    return [p.project_address, p.project_city].filter(Boolean).join(', ');
  }
  if (p.project_address) {
    // Address became the title — subtitle is just city.
    return p.project_city || '';
  }
  return '';
}

// ───────────────────────────────────────────────────────────────────────────
// Section switching
// ───────────────────────────────────────────────────────────────────────────
function attachNavigation() {
  editorNav.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => switchSection(btn.dataset.section));
  });
}

function switchSection(name) {
  currentSection = name;
  editorNav.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.section === name);
  });
  sectionContent.innerHTML = '';

  switch (name) {
    case 'bid-pdf':
      initBidPdf({ proposalId, container: sectionContent, onSave: onDataSaved });
      break;
    case 'bid-builder':
      initBidBuilder({ proposalId, container: sectionContent, onSave: onDataSaved });
      break;
    case 'materials':
      initMaterials({ proposalId, container: sectionContent, onSave: touchSave });
      break;
    case 'photos':
      initPhotos({ proposalId, container: sectionContent, onSave: touchSave });
      break;
    case 'export':
      initPublish({ proposalId, container: sectionContent, onSave: touchSave });
      break;
    case 'project-info':
      renderPlaceholder('Project info',
        'Client name, email, address, estimate number, Loom walkthrough link.',
        'Most of these fields are auto-populated when you commit a bid PDF in Section 02. The Loom URL field now lives in Section 06 (Preview & publish), so it can be set right before publishing.');
      break;
    case 'site-plan':
      initSitePlan({ proposalId, container: sectionContent, onSave: touchSave });
      break;
  }
}

function renderPlaceholder(title, description, status) {
  sectionContent.innerHTML = `
    <div class="section-header">
      <span class="eyebrow">Section</span>
      <h2>${escapeHtml(title)}</h2>
    </div>
    <div class="section-placeholder">
      <p class="lead">${description}</p>
      <div class="status-note"><span class="eyebrow">Status</span><p>${status}</p></div>
      <p class="hint">Use the Bid PDF, Materials, Photos, or Preview &amp; publish sections in the meantime — those are the live ones.</p>
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Save indicator
// ───────────────────────────────────────────────────────────────────────────
function touchSave() {
  saveIndicator.textContent = 'Saved just now';
  saveIndicator.classList.add('saved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveIndicator.textContent = 'Saved'; }, 12000);
}

// When the Bid PDF section saves, we also want to refresh the project title
// since client_name / project_address may have just been populated.
async function onDataSaved() {
  touchSave();
  const { data } = await supabase
    .from('proposals')
    .select('client_name, project_label, project_address, project_city')
    .eq('id', proposalId)
    .single();
  if (data) {
    proposal = { ...proposal, ...data };
    renderProjectTitle();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Delete proposal
// ───────────────────────────────────────────────────────────────────────────
function attachDelete() {
  deleteBtn.addEventListener('click', async () => {
    if (!confirm('Delete this proposal and all its materials, sections, photos, and data? This cannot be undone.')) return;
    const { error } = await supabase.from('proposals').delete().eq('id', proposalId);
    if (error) {
      alert('Delete failed: ' + error.message);
      return;
    }
    window.location.href = '/dashboard';
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

init();
