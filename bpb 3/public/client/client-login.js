// ═══════════════════════════════════════════════════════════════════════════
// client-login.js
// Unified login page — sends magic link via Supabase Auth (routed through
// Resend SMTP at the project level). Works for both admin (Tim) and clients.
//
// URL params:
//   ?return=<path>  — path to redirect to after successful auth
//   ?admin=1        — shows admin-flavored copy (Tim logging into /admin)
//
// Flow:
//   1. User enters email → click "Send login link"
//   2. Supabase signInWithOtp triggers email via Resend
//   3. Success view shows "check your email for <email>"
//   4. User clicks link in email → lands back here with auth token in URL
//      hash → Supabase client picks up session → redirect to return path
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { sendMagicLink, getCurrentUser, isAdminUser } from '/js/auth-util.js';

// DOM
const formView = document.getElementById('formView');
const successView = document.getElementById('successView');
const emailInput = document.getElementById('email');
const submitBtn = document.getElementById('submitBtn');
const statusBox = document.getElementById('status');
const sentToEmail = document.getElementById('sentToEmail');
const tryAgainLink = document.getElementById('tryAgainLink');
const headline = document.getElementById('headline');
const subtitle = document.getElementById('subtitle');
const brandName = document.getElementById('brandName');

// URL params
const params = new URLSearchParams(window.location.search);
const returnPath = params.get('return') || '';
const isAdminMode = params.get('admin') === '1';

// Adapt copy for admin mode
if (isAdminMode) {
  brandName.textContent = 'Paver Portal Proposal Builder';
  headline.textContent = 'Admin Login';
  subtitle.textContent = 'Enter your admin email to manage clients and proposals.';
}

// ── Check for existing session ─────────────────────────────────────────────
// If the user lands here with a magic-link hash in the URL, Supabase will
// pick it up automatically and set a session. If they're already signed in
// from a prior session, we redirect immediately.
(async function checkExistingSession() {
  // Small delay to allow Supabase to process URL hash (onAuthStateChange)
  await new Promise(r => setTimeout(r, 200));
  const user = await getCurrentUser();
  if (user) {
    redirectAuthenticated(user);
  }
})();

// Listen for auth state changes (magic link completion)
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session?.user) {
    redirectAuthenticated(session.user);
  }
});

function redirectAuthenticated(user) {
  // Determine where to go
  let destination = returnPath;
  if (!destination) {
    destination = isAdminUser(user) ? '/admin/clients.html' : '/client/dashboard.html';
  }
  // Preserve admin landing even if return was unspecified
  if (isAdminMode && !returnPath && isAdminUser(user)) {
    destination = '/admin/clients.html';
  }
  window.location.href = destination;
}

// ── Handle form submission ─────────────────────────────────────────────────
submitBtn.addEventListener('click', handleSubmit);
emailInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleSubmit();
});

async function handleSubmit() {
  const email = emailInput.value.trim();
  if (!email || !email.includes('@')) {
    showStatus('error', 'Please enter a valid email address.');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending…';
  hideStatus();

  // Pick redirect path based on mode
  const redirectPath = returnPath ||
    (isAdminMode ? '/admin/clients.html' : '/client/dashboard.html');

  const { error } = await sendMagicLink(email, redirectPath);

  if (error) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Send login link';
    showStatus('error', `Could not send login link: ${error.message}`);
    return;
  }

  // Show success view
  sentToEmail.textContent = email;
  formView.style.display = 'none';
  successView.classList.add('visible');
}

tryAgainLink.addEventListener('click', (e) => {
  e.preventDefault();
  successView.classList.remove('visible');
  formView.style.display = 'block';
  emailInput.value = '';
  emailInput.focus();
  submitBtn.disabled = false;
  submitBtn.textContent = 'Send login link';
});

// ── Utils ──────────────────────────────────────────────────────────────────
function showStatus(type, msg) {
  statusBox.className = `status visible ${type}`;
  statusBox.textContent = msg;
}

function hideStatus() {
  statusBox.className = 'status';
  statusBox.textContent = '';
}
