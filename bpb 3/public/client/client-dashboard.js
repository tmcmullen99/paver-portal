// ═══════════════════════════════════════════════════════════════════════════
// client-dashboard.js
//
// Client dashboard — proposals + Refer & Earn ($500 per referred design
// consultation). Markup PDF download flow preserved from Phase 1B.
//
// Refer & Earn (Phase 1):
//   - Renders the client's refer_code as a share link:
//     https://portal-baysidepavers.com/refer.html?code=<refer_code>
//   - Copy-to-clipboard, email/SMS prefills, native Web Share API
//   - Credit balance pulled from clients.referral_credit_cents
//   - Referrals list with status-color badges
//
// Markup PDF (Phase 1A + 1B):
//   - Each proposal card has "📥 Markup PDF" if any image source is set,
//     OR a designer-curated markup_pdf_images list is non-empty.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import {
  requireClient,
  isAdminUser,
  getClientRecord,
  signOut,
  logClientActivity,
} from '/js/auth-util.js';
import { generateMarkupPdf } from './markup-pdf.js';

// ── DOM ────────────────────────────────────────────────────────────────────
const loadingState = document.getElementById('loadingState');
const contentState = document.getElementById('contentState');
const adminBanner = document.getElementById('adminBanner');
const userEmailEl = document.getElementById('userEmail');
const welcomeTitle = document.getElementById('welcomeTitle');
const welcomeSubtitle = document.getElementById('welcomeSubtitle');
const proposalsGrid = document.getElementById('proposalsGrid');
const proposalsCount = document.getElementById('proposalsCount');
const signOutBtn = document.getElementById('signOutBtn');

const referCard = document.getElementById('referCard');
const creditAmount = document.getElementById('creditAmount');
const referralCount = document.getElementById('referralCount');
const referProgress = document.getElementById('referProgress');
const progressLabel = document.getElementById('progressLabel');
const referLinkInput = document.getElementById('referLinkInput');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const shareEmail = document.getElementById('shareEmail');
const shareSms = document.getElementById('shareSms');
const shareNative = document.getElementById('shareNative');
const referralList = document.getElementById('referralList');

// ── State ──────────────────────────────────────────────────────────────────
const ctx = {
  user: null,
  client: null,
  proposals: [],
  referrals: [],
};

// ── Bootstrap ──────────────────────────────────────────────────────────────
(async function init() {
  ctx.user = await requireClient();
  if (!ctx.user) return;

  userEmailEl.textContent = ctx.user.email;

  if (isAdminUser(ctx.user)) {
    adminBanner.style.display = 'block';
    welcomeTitle.textContent = 'Admin preview';
    welcomeSubtitle.innerHTML =
      `You don't have a client record yet. To test this view, add yourself as a client at <a href="/admin/clients.html">admin/clients</a>.`;
    loadingState.style.display = 'none';
    contentState.style.display = 'block';
    proposalsCount.textContent = '0 proposals';
    proposalsGrid.innerHTML = renderProposalEmpty();
    return;
  }

  ctx.client = await getClientRecord(ctx.user);

  if (!ctx.client) {
    loadingState.style.display = 'none';
    contentState.style.display = 'block';
    welcomeTitle.textContent = 'Hi there';
    welcomeSubtitle.innerHTML =
      `We don't have a client account set up for <strong>${escapeHtml(ctx.user.email)}</strong> yet. If Tim invited you, check that you're signing in with the same email he used. Otherwise, email <a href="mailto:tim@mcmullen.properties">tim@mcmullen.properties</a>.`;
    proposalsGrid.innerHTML = '';
    proposalsCount.textContent = '';
    return;
  }

  await Promise.all([loadProposals(), loadReferrals()]);

  renderDashboard();
  renderReferCard();

  loadingState.style.display = 'none';
  contentState.style.display = 'block';
})();

// ── Proposals (existing flow, unchanged behavior) ──────────────────────────
async function loadProposals() {
  const { data, error } = await supabase
    .from('client_proposals')
    .select(`
      id, status, sent_at, first_viewed_at, signed_at, created_at,
      proposal:proposals!proposal_id (
        id,
        address,
        project_address,
        site_plan_backdrop_url,
        hero_image_url,
        construction_drawing_url,
        markup_pdf_images,
        created_at,
        published_proposals (id, slug)
      )
    `)
    .eq('client_id', ctx.client.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error loading proposals:', error);
    ctx.proposals = [];
    return;
  }
  ctx.proposals = data || [];
}

function renderDashboard() {
  const firstName = (ctx.client.name || '').split(/\s+/)[0] || 'there';
  welcomeTitle.textContent = `Welcome, ${firstName}`;
  welcomeSubtitle.textContent = ctx.proposals.length === 0
    ? "You don't have any proposals yet. Tim will send you one when it's ready."
    : `Here's the latest on your project${ctx.proposals.length > 1 ? 's' : ''} with Paver Portal.`;

  proposalsCount.textContent = `${ctx.proposals.length} proposal${ctx.proposals.length === 1 ? '' : 's'}`;

  if (ctx.proposals.length === 0) {
    proposalsGrid.innerHTML = renderProposalEmpty();
    return;
  }

  proposalsGrid.innerHTML = ctx.proposals.map(cp => renderProposalCard(cp)).join('');

  proposalsGrid.querySelectorAll('.proposal-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      handleProposalView(btn.dataset.cpId, btn.dataset.slug);
    });
  });
  proposalsGrid.querySelectorAll('.proposal-pdf-btn').forEach(btn => {
    btn.addEventListener('click', () => handleMarkupPdfDownload(btn.dataset.cpId, btn));
  });
}

function renderProposalCard(cp) {
  const p = cp.proposal;
  if (!p) return '';

  const statusLabel = {
    draft: 'Draft',
    sent: 'Sent',
    viewed: 'Viewed',
    signed: 'Signed',
    in_progress: 'In Progress',
    complete: 'Complete',
  }[cp.status] || cp.status;

  const sentDate = cp.sent_at
    ? new Date(cp.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Not sent yet';

  const slug = getLatestSlug(p);
  const curatedHasItems = Array.isArray(p.markup_pdf_images) && p.markup_pdf_images.length > 0;
  const hasImagesForPdf = curatedHasItems
    || !!(p.site_plan_backdrop_url || p.hero_image_url || p.construction_drawing_url);

  const pdfButton = hasImagesForPdf
    ? `<button class="btn btn-secondary proposal-pdf-btn"
               data-cp-id="${escapeAttr(cp.id)}"
               title="Download a printable PDF you can mark up by hand">
         📥 Markup PDF
       </button>`
    : '';

  const viewButton = slug
    ? `<button class="btn proposal-view-btn"
               data-cp-id="${escapeAttr(cp.id)}"
               data-slug="${escapeAttr(slug)}">
         View proposal →
       </button>`
    : `<button class="btn" disabled style="opacity:0.5;cursor:not-allowed;">
         Not available yet
       </button>`;

  return `
    <div class="proposal-card">
      <div class="proposal-card-info">
        <div class="proposal-card-address">${escapeHtml(getDisplayAddress(p))}</div>
        <div class="proposal-card-meta">
          <span class="status-badge ${cp.status}">${escapeHtml(statusLabel)}</span>
          <span>Sent ${escapeHtml(sentDate)}</span>
        </div>
      </div>
      <div class="proposal-card-actions">
        ${pdfButton}
        ${viewButton}
      </div>
    </div>
  `;
}

function renderProposalEmpty() {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">📋</div>
      <h3>No proposals yet</h3>
      <p>When Tim creates a proposal for you, it'll appear here.</p>
    </div>
  `;
}

// ── Referrals ──────────────────────────────────────────────────────────────
async function loadReferrals() {
  const { data, error } = await supabase
    .from('referrals')
    .select(`
      id, referred_name, referred_email, referred_phone, status,
      invite_sent_at, scheduled_at, appointment_completed_at,
      credit_awarded_at, credit_amount_cents, created_at
    `)
    .eq('referrer_client_id', ctx.client.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error loading referrals:', error);
    ctx.referrals = [];
    return;
  }
  ctx.referrals = data || [];
}

function renderReferCard() {
  if (!ctx.client || !ctx.client.refer_code) {
    referCard.style.display = 'none';
    return;
  }
  referCard.style.display = 'block';

  // Credit balance
  const creditCents = ctx.client.referral_credit_cents || 0;
  const usedCents = ctx.client.referral_credit_used_cents || 0;
  const availableCents = Math.max(0, creditCents - usedCents);
  const availableDollars = Math.floor(availableCents / 100);
  creditAmount.textContent = '$' + availableDollars.toLocaleString('en-US');

  // Referral count summary
  const total = ctx.referrals.length;
  const credited = ctx.referrals.filter(r => r.credit_awarded_at).length;
  referralCount.textContent =
    `${total} referral${total === 1 ? '' : 's'} · ${credited} credited`;

  // Progress (every $500 = one milestone, target $2,500 = 5 referrals)
  const target = 2500;
  const pct = Math.min(100, (availableDollars / target) * 100);
  referProgress.style.width = pct + '%';
  progressLabel.textContent =
    `$${availableDollars.toLocaleString('en-US')} of $${target.toLocaleString('en-US')} toward your next project`;

  // Share link
  const shareUrl = buildShareUrl(ctx.client.refer_code);
  referLinkInput.value = shareUrl;

  // Copy button
  copyLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      const orig = copyLinkBtn.innerHTML;
      copyLinkBtn.innerHTML = '✓ Copied';
      copyLinkBtn.classList.add('copied');
      setTimeout(() => {
        copyLinkBtn.innerHTML = orig;
        copyLinkBtn.classList.remove('copied');
      }, 2000);
    } catch (e) {
      referLinkInput.select();
      document.execCommand('copy');
    }
  });

  // Share buttons
  const firstName = (ctx.client.name || '').split(/\s+/)[0] || 'a friend';
  const emailSubject = encodeURIComponent(`${firstName} thinks you'd love Paver Portal`);
  const emailBody = encodeURIComponent(
    `Hi —\n\n` +
    `I've been working with Paver Portal on a hardscape project and they've been great. ` +
    `If you've been thinking about a patio, walkway, or retaining wall, they offer free design consultations.\n\n` +
    `Here's my personal link — book through this and Paver Portal will credit me, no cost to you:\n${shareUrl}\n\n` +
    `— ${ctx.client.name || ''}`
  );
  shareEmail.href = `mailto:?subject=${emailSubject}&body=${emailBody}`;

  const smsBody = encodeURIComponent(
    `Hey — Paver Portal does great hardscape work. Free design consultation through my link: ${shareUrl}`
  );
  shareSms.href = `sms:?&body=${smsBody}`;

  // Native share (mobile)
  if (navigator.share) {
    shareNative.style.display = '';
    shareNative.addEventListener('click', async () => {
      try {
        await navigator.share({
          title: 'Paver Portal free design consultation',
          text: `${firstName} thinks you'd love Paver Portal. Book a free consultation:`,
          url: shareUrl,
        });
      } catch (e) {
        // user canceled — silent
      }
    });
  } else {
    shareNative.style.display = 'none';
  }

  // Referrals list
  if (ctx.referrals.length === 0) {
    referralList.innerHTML = `
      <div class="refer-list-empty">
        No referrals yet — share your link to get started!
      </div>
    `;
  } else {
    referralList.innerHTML = ctx.referrals.slice(0, 8).map(r => {
      const status = getReferralStatusLabel(r);
      const date = new Date(r.invite_sent_at || r.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
      });
      return `
        <div class="refer-list-row">
          <div>
            <span class="refer-list-name">${escapeHtml(r.referred_name || r.referred_email)}</span>
            <span class="refer-list-meta">${escapeHtml(date)}</span>
          </div>
          <span class="refer-list-status ${status.cls}">${escapeHtml(status.label)}</span>
        </div>
      `;
    }).join('');
  }
}

function getReferralStatusLabel(r) {
  if (r.credit_awarded_at) return { cls: 'credited', label: '✓ $500 earned' };
  if (r.appointment_completed_at) return { cls: 'completed', label: 'Met w/ Tim' };
  if (r.scheduled_at) return { cls: 'scheduled', label: 'Scheduled' };
  return { cls: 'sent', label: 'Invited' };
}

function buildShareUrl(referCode) {
  return `https://portal-baysidepavers.com/refer.html?code=${encodeURIComponent(referCode)}`;
}

// ── Proposal view action (existing) ────────────────────────────────────────
async function handleProposalView(cpId, slug) {
  const cp = ctx.proposals.find(x => x.id === cpId);
  if (cp && !cp.first_viewed_at) {
    const now = new Date().toISOString();
    supabase
      .from('client_proposals')
      .update({
        first_viewed_at: now,
        status: cp.status === 'sent' ? 'viewed' : cp.status,
      })
      .eq('id', cpId)
      .then(({ error }) => {
        if (error) console.warn('Could not mark viewed:', error.message);
      });
  }
  logClientActivity(ctx.client.id, 'proposal_viewed', { slug }, cp?.proposal?.id);
  window.location.href = `/p/${slug}`;
}

// ── Markup PDF download (Phase 1A + 1B, existing) ──────────────────────────
async function handleMarkupPdfDownload(cpId, btn) {
  const cp = ctx.proposals.find(x => x.id === cpId);
  if (!cp || !cp.proposal) return;

  const origText = btn.textContent;
  const origDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = '⏳ Generating…';

  try {
    await generateMarkupPdf(
      {
        project_address: cp.proposal.project_address || cp.proposal.address,
        site_plan_backdrop_url: cp.proposal.site_plan_backdrop_url,
        hero_image_url: cp.proposal.hero_image_url,
        construction_drawing_url: cp.proposal.construction_drawing_url,
        markup_pdf_images: cp.proposal.markup_pdf_images,
      },
      { clientName: ctx.client.name || '' }
    );

    logClientActivity(
      ctx.client.id,
      'markup_pdf_downloaded',
      { proposal_id: cp.proposal.id },
      cp.proposal.id
    );

    btn.textContent = '✓ Downloaded';
    setTimeout(() => {
      btn.textContent = origText;
      btn.disabled = origDisabled;
    }, 2200);
  } catch (err) {
    console.error('Markup PDF generation failed:', err);
    btn.textContent = '⚠ Try again';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = origText; }, 2500);
  }
}

// ── Sign out ───────────────────────────────────────────────────────────────
signOutBtn.addEventListener('click', async () => {
  await signOut();
});

// ── Slug / address helpers ─────────────────────────────────────────────────
function parseSlugSortKey(slug) {
  if (!slug) return { date: '', version: 0 };
  const match = String(slug).match(/(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?$/);
  if (!match) return { date: '', version: 0 };
  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    version: parseInt(match[4] || '1', 10),
  };
}

function getLatestSlug(proposal) {
  const pubs = proposal?.published_proposals;
  if (!Array.isArray(pubs) || pubs.length === 0) return null;
  const sorted = [...pubs].sort((a, b) => {
    const ka = parseSlugSortKey(a.slug);
    const kb = parseSlugSortKey(b.slug);
    if (kb.date !== ka.date) return kb.date.localeCompare(ka.date);
    return kb.version - ka.version;
  });
  return sorted[0]?.slug || null;
}

function getDisplayAddress(proposal) {
  if (proposal?.project_address) return proposal.project_address;
  if (proposal?.address) return proposal.address;
  const slug = getLatestSlug(proposal);
  if (slug) {
    const stripped = slug.replace(/-\d{4}-\d{2}-\d{2}(-\d+)?$/, '');
    if (stripped) {
      return stripped
        .split('-')
        .map(w => w ? w[0].toUpperCase() + w.slice(1) : w)
        .join(' ');
    }
  }
  return 'Untitled proposal';
}

// ── Utilities ──────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}
