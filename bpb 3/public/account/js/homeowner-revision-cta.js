/* ═══════════════════════════════════════════════════════════════════════════
   homeowner-revision-cta.js — Sprint 9b

   Loaded by every published proposal page via a <script src=> tag baked into
   the html_snapshot at publish time. Self-contained (vanilla JS + Supabase).

   Reads .pub-cta-final[data-proposal-id] to know which proposal we're on.
   Detects auth state via Supabase session. If the viewer is the assigned
   homeowner of this proposal, renders the revision-CTA state machine:

     State 1 (initial)         : "Request Revision" button → wrapper modal
                                  with 3 options (materials / design / note).
                                  Each option captures a textarea note and
                                  inserts a proposal_redesign_request row
                                  with category-prefixed homeowner_note.
                                  Designer republish auto-marks delivered
                                  via the Sprint 9a Postgres trigger.

     State 2 (used free)       : "Learn about the Design Retainer" button →
                                  value-pitch popup. "I'm interested" click
                                  POSTs to /api/notify-design-retainer-interest
                                  which records the timestamp on the row and
                                  emails the assigned designer via Resend.

     State 3 (interest shown)  : "✓ We'll reach out soon" — informational
                                  card, no clickable. Designer formalizes the
                                  retainer offline (call/text/follow-up).

   Anonymous viewers see no UI (revision actions require auth identity).
   Authenticated non-homeowners see no UI (we silently hide the section).
   ═══════════════════════════════════════════════════════════════════════════ */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = 'https://gfgbypcnxkschnfsitfb.supabase.co';
const SUPABASE_ANON = 'sb_publishable_Ko4LNw2VjhZVFmwJ-i2qtA_XeGgBcew';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// ═══ Bootstrap ═══════════════════════════════════════════════════════════
(async function init() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
    return;
  }

  const ctaFinal = document.querySelector('.pub-cta-final');
  if (!ctaFinal) return; // Not a published proposal page; silent abort.
  const proposalId = ctaFinal.getAttribute('data-proposal-id');
  if (!proposalId) return;

  injectStyles();

  const mount = document.createElement('section');
  mount.id = 'bp-homeowner-revision-cta';
  mount.className = 'bp-hrc-section';
  mount.innerHTML = '<div class="bp-hrc-loading">Loading…</div>';
  ctaFinal.parentNode.insertBefore(mount, ctaFinal);

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    // Anonymous viewer — hide UI; revision flows require client identity.
    mount.style.display = 'none';
    return;
  }

  const state = await loadHomeownerState(session.user.id, proposalId);
  if (!state) {
    // Auth'd but not the assigned homeowner — silently hide.
    mount.style.display = 'none';
    return;
  }

  if (state.clientProposal.design_retainer_interest_at) {
    renderInterestExpressedState(mount, state);
  } else if (state.clientProposal.has_used_free_revision) {
    renderDesignRetainerState(mount, state);
  } else {
    renderRequestRevisionState(mount, state);
  }
})();

// ═══ State loader ═════════════════════════════════════════════════════════
async function loadHomeownerState(userId, proposalId) {
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('id, name, email')
    .eq('user_id', userId)
    .maybeSingle();
  if (clientErr || !client) return null;

  const { data: cp, error: cpErr } = await supabase
    .from('client_proposals')
    .select('id, has_used_free_revision, design_retainer_interest_at, status')
    .eq('client_id', client.id)
    .eq('proposal_id', proposalId)
    .maybeSingle();
  if (cpErr || !cp) return null;

  return { client, clientProposal: cp, proposalId };
}

// ═══ State renderers ══════════════════════════════════════════════════════

function renderRequestRevisionState(mount, state) {
  mount.innerHTML = `
    <div class="bp-hrc-card">
      <div class="bp-hrc-eyebrow">Need changes?</div>
      <h3 class="bp-hrc-title">Want to tweak this design?</h3>
      <p class="bp-hrc-text">
        Your first round of revisions is on us. Tell us what you'd like to change
        and your designer will update the proposal.
      </p>
      <button type="button" class="bp-hrc-btn bp-hrc-btn-primary" id="bpHrcRequestBtn">
        Request Revision
      </button>
    </div>
  `;
  document.getElementById('bpHrcRequestBtn').addEventListener('click', () => {
    openRequestRevisionModal(state, mount);
  });
}

function renderDesignRetainerState(mount, state) {
  mount.innerHTML = `
    <div class="bp-hrc-card">
      <div class="bp-hrc-eyebrow">Take it further</div>
      <h3 class="bp-hrc-title">Unlimited revisions with the Design Retainer</h3>
      <p class="bp-hrc-text">
        You've used your complimentary revision. Lock in unlimited tweaks for
        the next 30 days — and if you build with us, the entire $2,500 fee is
        credited to your project.
      </p>
      <button type="button" class="bp-hrc-btn bp-hrc-btn-primary" id="bpHrcRetainerBtn">
        Learn about the Design Retainer
      </button>
    </div>
  `;
  document.getElementById('bpHrcRetainerBtn').addEventListener('click', () => {
    openDesignRetainerPopup(state, mount);
  });
}

function renderInterestExpressedState(mount, state) {
  const at = new Date(state.clientProposal.design_retainer_interest_at);
  const formatted = at.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  mount.innerHTML = `
    <div class="bp-hrc-card bp-hrc-card-confirmed">
      <div class="bp-hrc-eyebrow">Design Retainer requested</div>
      <h3 class="bp-hrc-title">✓ We'll reach out soon</h3>
      <p class="bp-hrc-text">
        You expressed interest on ${formatted}. Your designer will be in touch
        within the next business day to discuss the Design Retainer and next steps.
      </p>
    </div>
  `;
}

// ═══ Request Revision modal ═══════════════════════════════════════════════
function openRequestRevisionModal(state, mount) {
  const overlay = document.createElement('div');
  overlay.className = 'bp-hrc-overlay';
  overlay.innerHTML = `
    <div class="bp-hrc-modal" role="dialog" aria-modal="true" aria-labelledby="bpHrcModalTitle">
      <button type="button" class="bp-hrc-modal-close" aria-label="Close">×</button>
      <div class="bp-hrc-modal-head">
        <div class="bp-hrc-modal-eyebrow">Request Revision</div>
        <h3 id="bpHrcModalTitle" class="bp-hrc-modal-title">What would you like to change?</h3>
      </div>
      <div class="bp-hrc-modal-body">
        <div class="bp-hrc-error" id="bpHrcModalError" hidden></div>
        <div class="bp-hrc-options">
          <label class="bp-hrc-option">
            <input type="radio" name="bpHrcCategory" value="materials" checked>
            <div class="bp-hrc-option-content">
              <div class="bp-hrc-option-title">Change materials</div>
              <div class="bp-hrc-option-sub">Swap a paver, change colors, or update finishes</div>
            </div>
          </label>
          <label class="bp-hrc-option">
            <input type="radio" name="bpHrcCategory" value="design">
            <div class="bp-hrc-option-content">
              <div class="bp-hrc-option-title">Change design</div>
              <div class="bp-hrc-option-sub">Adjust layout, dimensions, or features</div>
            </div>
          </label>
          <label class="bp-hrc-option">
            <input type="radio" name="bpHrcCategory" value="note">
            <div class="bp-hrc-option-content">
              <div class="bp-hrc-option-title">Send a note</div>
              <div class="bp-hrc-option-sub">Questions, comments, or other feedback</div>
            </div>
          </label>
        </div>
        <label class="bp-hrc-textarea-label">Tell us more</label>
        <textarea id="bpHrcNote" class="bp-hrc-textarea" rows="5"
          placeholder="Describe what you'd like to change in your own words…"></textarea>
      </div>
      <div class="bp-hrc-modal-foot">
        <button type="button" class="bp-hrc-btn bp-hrc-btn-secondary" id="bpHrcCancel">Cancel</button>
        <button type="button" class="bp-hrc-btn bp-hrc-btn-primary" id="bpHrcSubmit">Send to designer</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  function close() {
    overlay.remove();
    document.body.style.overflow = '';
  }
  overlay.querySelector('.bp-hrc-modal-close').addEventListener('click', close);
  overlay.querySelector('#bpHrcCancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const submitBtn = overlay.querySelector('#bpHrcSubmit');
  submitBtn.addEventListener('click', async () => {
    const errEl = overlay.querySelector('#bpHrcModalError');
    errEl.hidden = true;

    const category = overlay.querySelector('input[name="bpHrcCategory"]:checked').value;
    const note = overlay.querySelector('#bpHrcNote').value.trim();
    if (!note) {
      errEl.textContent = "Please describe what you'd like to change.";
      errEl.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    const categoryLabel = {
      materials: 'Change materials',
      design: 'Change design',
      note: 'Send a note',
    }[category] || 'Request';

    const homeownerNote = `[${categoryLabel}] ${note}`;

    const { error } = await supabase
      .from('proposal_redesign_requests')
      .insert({
        proposal_id: state.proposalId,
        client_id: state.client.id,
        homeowner_note: homeownerNote,
        status: 'submitted',
      });

    if (error) {
      console.error('[homeowner-revision-cta] insert failed:', error);
      errEl.textContent = 'Could not send: ' + (error.message || 'unknown error');
      errEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send to designer';
      return;
    }

    close();
    mount.innerHTML = `
      <div class="bp-hrc-card bp-hrc-card-confirmed">
        <div class="bp-hrc-eyebrow">Sent</div>
        <h3 class="bp-hrc-title">✓ Your designer has been notified</h3>
        <p class="bp-hrc-text">
          We'll review your request and update your proposal. You'll see the
          changes here when they're ready — usually within 1–3 business days.
        </p>
      </div>
    `;
  });

  document.addEventListener('keydown', function escListener(e) {
    if (e.key === 'Escape' && overlay.isConnected) {
      close();
      document.removeEventListener('keydown', escListener);
    }
  });
}

// ═══ Design Retainer popup ════════════════════════════════════════════════
function openDesignRetainerPopup(state, mount) {
  const overlay = document.createElement('div');
  overlay.className = 'bp-hrc-overlay';
  overlay.innerHTML = `
    <div class="bp-hrc-modal bp-hrc-modal-wide" role="dialog" aria-modal="true">
      <button type="button" class="bp-hrc-modal-close" aria-label="Close">×</button>
      <div class="bp-hrc-modal-head">
        <div class="bp-hrc-modal-eyebrow">Design Retainer</div>
        <h3 class="bp-hrc-modal-title">Take your design further</h3>
      </div>
      <div class="bp-hrc-modal-body">
        <p class="bp-hrc-pitch-lead">
          You've used your complimentary revision. <strong>The Design Retainer
          unlocks unlimited revisions</strong> so we can keep iterating until
          your design is exactly right.
        </p>
        <ul class="bp-hrc-pitch-list">
          <li><strong>Unlimited design revisions</strong> for 30 days</li>
          <li>A <strong>finalized design</strong> and <strong>construction drawing</strong> — ready for permit</li>
          <li>Direct line to your designer for tweaks of any size</li>
        </ul>
        <div class="bp-hrc-pitch-investment">
          <div class="bp-hrc-pitch-amount">$2,500</div>
          <div class="bp-hrc-pitch-amount-sub">
            <strong>Fully credited toward your final payment</strong> if you choose
            Paver Portal to build your project. Most clients who sign the retainer
            do go on to build with us — which means in practice it costs them nothing.
          </div>
        </div>
        <div class="bp-hrc-error" id="bpHrcRetainerError" hidden></div>
      </div>
      <div class="bp-hrc-modal-foot">
        <button type="button" class="bp-hrc-btn bp-hrc-btn-secondary" id="bpHrcRetainerCancel">Not right now</button>
        <button type="button" class="bp-hrc-btn bp-hrc-btn-primary" id="bpHrcRetainerSubmit">I'm interested — have my designer reach out</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  function close() {
    overlay.remove();
    document.body.style.overflow = '';
  }
  overlay.querySelector('.bp-hrc-modal-close').addEventListener('click', close);
  overlay.querySelector('#bpHrcRetainerCancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const submitBtn = overlay.querySelector('#bpHrcRetainerSubmit');
  submitBtn.addEventListener('click', async () => {
    const errEl = overlay.querySelector('#bpHrcRetainerError');
    errEl.hidden = true;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      errEl.textContent = 'Session expired. Please refresh and try again.';
      errEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "I'm interested — have my designer reach out";
      return;
    }

    try {
      const response = await fetch('/api/notify-design-retainer-interest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + session.access_token,
        },
        body: JSON.stringify({
          client_proposal_id: state.clientProposal.id,
          proposal_id: state.proposalId,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Server error ' + response.status);
      }

      close();
      const formatted = new Date().toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      mount.innerHTML = `
        <div class="bp-hrc-card bp-hrc-card-confirmed">
          <div class="bp-hrc-eyebrow">Design Retainer requested</div>
          <h3 class="bp-hrc-title">✓ We'll reach out soon</h3>
          <p class="bp-hrc-text">
            You expressed interest on ${formatted}. Your designer will be in touch
            within the next business day to discuss the Design Retainer and next steps.
          </p>
        </div>
      `;
    } catch (err) {
      console.error('[homeowner-revision-cta] retainer interest failed:', err);
      errEl.textContent = 'Could not send: ' + err.message;
      errEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "I'm interested — have my designer reach out";
    }
  });

  document.addEventListener('keydown', function escListener(e) {
    if (e.key === 'Escape' && overlay.isConnected) {
      close();
      document.removeEventListener('keydown', escListener);
    }
  });
}

// ═══ Styles ═══════════════════════════════════════════════════════════════
function injectStyles() {
  if (document.getElementById('bp-hrc-styles')) return;
  const style = document.createElement('style');
  style.id = 'bp-hrc-styles';
  style.textContent = `
    .bp-hrc-section {
      max-width: 1040px;
      margin: 0 auto;
      padding: 56px 32px 0;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .bp-hrc-loading { color: #888; font-size: 14px; padding: 20px 0; }
    .bp-hrc-card {
      background: #f4f8f5;
      border: 1px solid #d4dfd7;
      border-radius: 14px;
      padding: 36px 40px;
      text-align: left;
    }
    .bp-hrc-card-confirmed {
      background: #f1e7d3;
      border-color: #9c7440;
    }
    .bp-hrc-eyebrow {
      font-size: 12px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #9c7440;
      margin-bottom: 8px;
      font-weight: 600;
    }
    .bp-hrc-title {
      font-size: 24px;
      font-weight: 600;
      color: #353535;
      letter-spacing: -0.012em;
      margin: 0 0 12px;
      line-height: 1.25;
    }
    .bp-hrc-text {
      font-size: 16px;
      color: #555;
      line-height: 1.6;
      margin: 0 0 22px;
      max-width: 560px;
    }
    .bp-hrc-card-confirmed .bp-hrc-text { margin-bottom: 0; }

    .bp-hrc-btn {
      font-family: inherit;
      font-size: 15px;
      font-weight: 600;
      padding: 12px 22px;
      border-radius: 10px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s, opacity 0.15s;
    }
    .bp-hrc-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .bp-hrc-btn-primary {
      background: #9c7440; color: #fff;
      box-shadow: 0 4px 14px rgba(93, 126, 105, 0.22);
    }
    .bp-hrc-btn-primary:hover:not(:disabled) {
      background: #7d5c31;
      transform: translateY(-1px);
    }
    .bp-hrc-btn-secondary {
      background: #fff; color: #353535;
      border-color: #d4cfc0;
    }
    .bp-hrc-btn-secondary:hover:not(:disabled) {
      background: #faf8f3;
      border-color: #888;
    }

    .bp-hrc-overlay {
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(26, 31, 46, 0.55);
      display: flex; align-items: flex-start; justify-content: center;
      padding: 56px 20px 20px;
      overflow-y: auto;
      animation: bpHrcFade 0.18s ease-out;
    }
    @keyframes bpHrcFade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes bpHrcSlide {
      from { transform: translateY(8px); opacity: 0; }
      to   { transform: translateY(0);   opacity: 1; }
    }
    .bp-hrc-modal {
      background: #fff;
      border-radius: 16px;
      max-width: 560px;
      width: 100%;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);
      animation: bpHrcSlide 0.22s ease-out;
      color: #353535;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      max-height: calc(100vh - 80px);
      position: relative;
    }
    .bp-hrc-modal-wide { max-width: 600px; }
    .bp-hrc-modal-close {
      position: absolute; top: 14px; right: 14px;
      width: 32px; height: 32px;
      background: transparent; border: 0; cursor: pointer;
      font-size: 20px; line-height: 1; color: #888;
      border-radius: 6px;
      transition: background 0.12s, color 0.12s;
    }
    .bp-hrc-modal-close:hover { background: #f4f4ef; color: #353535; }
    .bp-hrc-modal-head {
      padding: 24px 32px 18px;
      border-bottom: 1px solid #ece9dd;
    }
    .bp-hrc-modal-eyebrow {
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #9c7440;
      margin-bottom: 6px;
      font-weight: 600;
    }
    .bp-hrc-modal-title {
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.012em;
      margin: 0;
      line-height: 1.25;
    }
    .bp-hrc-modal-body {
      padding: 22px 32px;
      overflow-y: auto;
      flex: 1;
    }
    .bp-hrc-modal-foot {
      padding: 16px 32px;
      border-top: 1px solid #ece9dd;
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      background: #faf8f3;
      flex-wrap: wrap;
    }

    .bp-hrc-options {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 18px;
    }
    .bp-hrc-option {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
      border: 1px solid #d4cfc0;
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    .bp-hrc-option:hover {
      border-color: #9c7440;
      background: #f4f8f5;
    }
    .bp-hrc-option input[type="radio"] {
      margin-top: 3px;
      flex-shrink: 0;
      accent-color: #9c7440;
    }
    .bp-hrc-option:has(input:checked) {
      border-color: #9c7440;
      background: #f1e7d3;
    }
    .bp-hrc-option-content { flex: 1; }
    .bp-hrc-option-title {
      font-weight: 600;
      font-size: 15px;
      color: #353535;
      margin-bottom: 2px;
    }
    .bp-hrc-option-sub {
      font-size: 13px;
      color: #666;
      line-height: 1.4;
    }

    .bp-hrc-textarea-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #888;
      margin-bottom: 6px;
    }
    .bp-hrc-textarea {
      width: 100%;
      font-family: inherit;
      font-size: 15px;
      padding: 12px 14px;
      border: 1px solid #d4cfc0;
      border-radius: 8px;
      background: #fff;
      color: #353535;
      resize: vertical;
      min-height: 100px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .bp-hrc-textarea:focus {
      outline: none;
      border-color: #9c7440;
      box-shadow: 0 0 0 3px #f1e7d3;
    }

    .bp-hrc-pitch-lead {
      font-size: 16px;
      color: #444;
      line-height: 1.6;
      margin: 0 0 18px;
    }
    .bp-hrc-pitch-list {
      list-style: none;
      padding: 0;
      margin: 0 0 22px;
    }
    .bp-hrc-pitch-list li {
      padding: 8px 0 8px 30px;
      position: relative;
      font-size: 15px;
      color: #444;
      line-height: 1.5;
    }
    .bp-hrc-pitch-list li::before {
      content: '✓';
      position: absolute;
      left: 0; top: 8px;
      color: #9c7440;
      font-weight: 700;
      font-size: 16px;
    }
    .bp-hrc-pitch-investment {
      background: #faf8f3;
      border-radius: 10px;
      padding: 18px 22px;
    }
    .bp-hrc-pitch-amount {
      font-size: 32px;
      font-weight: 700;
      color: #9c7440;
      letter-spacing: -0.02em;
      margin-bottom: 6px;
    }
    .bp-hrc-pitch-amount-sub {
      font-size: 13px;
      color: #666;
      line-height: 1.5;
    }

    .bp-hrc-error {
      background: #fbeeee;
      color: #b91c1c;
      border-left: 3px solid #b91c1c;
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 14px;
    }

    @media (max-width: 640px) {
      .bp-hrc-section { padding: 36px 16px 0; }
      .bp-hrc-card { padding: 24px 22px; }
      .bp-hrc-title { font-size: 20px; }
      .bp-hrc-modal-head, .bp-hrc-modal-body, .bp-hrc-modal-foot {
        padding-left: 22px; padding-right: 22px;
      }
      .bp-hrc-modal-foot { flex-direction: column-reverse; }
      .bp-hrc-modal-foot button { width: 100%; }
    }
  `;
  document.head.appendChild(style);
}
