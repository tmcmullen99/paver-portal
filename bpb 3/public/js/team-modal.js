// ═══════════════════════════════════════════════════════════════════════════
// team-modal.js  —  Phase 2C
//
// Lazy-loaded by supabase-client.js when a master clicks "Team" in the auth
// pill. Exports openTeamModal() which builds (on first call) and shows a
// modal listing active profiles plus an invite form. Submissions POST to
// /api/invite-designer; the CF function does the actual admin work.
//
// The modal is self-contained — styling lives in an inline <style> block
// inside the modal element, so it works on any page that loads supabase-
// client.js (dashboard, editor, site-map, etc.) without requiring host-
// page CSS hooks.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';

let _overlay = null;

export function openTeamModal() {
  if (_overlay) {
    _overlay.style.display = 'flex';
    refreshTeamList();
    return;
  }
  _overlay = buildModal();
  document.body.appendChild(_overlay);
  refreshTeamList();
}

function closeModal() {
  if (_overlay) _overlay.style.display = 'none';
  clearMsg();
}

function buildModal() {
  const overlay = document.createElement('div');
  overlay.id = 'bpb-team-overlay';
  overlay.innerHTML =
    '<style>' +
    '#bpb-team-overlay {' +
    '  position: fixed; inset: 0; z-index: 10000;' +
    '  background: rgba(26, 31, 46, 0.55);' +
    '  display: flex; align-items: center; justify-content: center;' +
    '  padding: 24px;' +
    "  font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;" +
    '  animation: bpbTeamFade 0.18s ease-out;' +
    '}' +
    '@keyframes bpbTeamFade { from { opacity: 0; } to { opacity: 1; } }' +
    '@keyframes bpbTeamSlide { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }' +
    '.bpb-team-modal {' +
    '  background: #fff;' +
    '  border-radius: 16px;' +
    '  max-width: 580px; width: 100%;' +
    '  max-height: calc(100vh - 48px);' +
    '  overflow-y: auto;' +
    '  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);' +
    '  padding: 32px;' +
    '  animation: bpbTeamSlide 0.22s ease-out;' +
    '  color: #353535;' +
    '}' +
    '.bpb-team-eyebrow {' +
    "  font-family: 'JetBrains Mono', ui-monospace, monospace;" +
    '  font-size: 11px; letter-spacing: 0.22em;' +
    '  color: #666; text-transform: uppercase;' +
    '  margin-bottom: 8px;' +
    '}' +
    '.bpb-team-title {' +
    '  font-size: 24px; font-weight: 600;' +
    '  color: #33281c; letter-spacing: -0.014em;' +
    '  margin: 0 0 22px 0;' +
    '}' +
    '.bpb-team-section-h {' +
    '  font-size: 12px; font-weight: 600;' +
    '  color: #353535; letter-spacing: 0.06em;' +
    '  text-transform: uppercase;' +
    '  margin: 4px 0 12px 0;' +
    '}' +
    '.bpb-team-list {' +
    '  list-style: none; margin: 0 0 24px 0; padding: 0;' +
    '}' +
    '.bpb-team-row {' +
    '  display: flex; align-items: center; gap: 12px;' +
    '  padding: 12px 0;' +
    '  border-bottom: 1px solid #f0f0f0;' +
    '}' +
    '.bpb-team-row:last-child { border-bottom: none; }' +
    '.bpb-team-row-info { flex: 1; min-width: 0; }' +
    '.bpb-team-row-name { font-weight: 600; color: #33281c; font-size: 14px; }' +
    '.bpb-team-row-email { color: #666; font-size: 12px; margin-top: 2px; word-break: break-all; }' +
    '.bpb-team-row-role {' +
    "  font-family: 'JetBrains Mono', ui-monospace, monospace;" +
    '  font-size: 9px; letter-spacing: 0.18em;' +
    '  color: #9c7440; text-transform: uppercase; font-weight: 600;' +
    '  padding: 4px 10px;' +
    '  background: #f1e7d3;' +
    '  border-radius: 999px;' +
    '  white-space: nowrap;' +
    '}' +
    '.bpb-team-row-role-master { color: #33281c; background: #f0f0f0; }' +
    '.bpb-team-form {' +
    '  display: grid; grid-template-columns: 1fr 1fr; gap: 12px;' +
    '  padding: 18px; background: #faf8f3;' +
    '  border-radius: 12px;' +
    '}' +
    '.bpb-team-form label {' +
    '  display: flex; flex-direction: column; gap: 6px;' +
    '  font-size: 12px; font-weight: 600; color: #353535;' +
    '}' +
    '.bpb-team-form label.full { grid-column: 1 / -1; }' +
    '.bpb-team-form input, .bpb-team-form select {' +
    '  font: inherit; font-size: 14px;' +
    '  padding: 10px 12px;' +
    '  border: 1px solid #e5e5e5;' +
    '  border-radius: 8px;' +
    '  background: #fff; color: #33281c;' +
    '  transition: border-color 0.15s, box-shadow 0.15s;' +
    '}' +
    '.bpb-team-form input:focus, .bpb-team-form select:focus {' +
    '  outline: none; border-color: #9c7440;' +
    '  box-shadow: 0 0 0 3px rgba(93, 126, 105, 0.15);' +
    '}' +
    '.bpb-team-btn {' +
    '  padding: 12px 18px; border-radius: 10px;' +
    '  font: inherit; font-weight: 600; font-size: 14px;' +
    '  cursor: pointer; border: 1px solid transparent;' +
    '  transition: background 0.15s, color 0.15s, transform 0.12s, box-shadow 0.15s, opacity 0.15s;' +
    '}' +
    '.bpb-team-btn-primary {' +
    '  background: #9c7440; color: #fff;' +
    '  box-shadow: 0 6px 16px rgba(93, 126, 105, 0.24);' +
    '}' +
    '.bpb-team-btn-primary:hover { background: #7d5c31; transform: translateY(-1px); }' +
    '.bpb-team-btn-primary:disabled { opacity: 0.55; cursor: not-allowed; transform: none; box-shadow: none; }' +
    '.bpb-team-btn-secondary {' +
    '  background: #f5f5f5; color: #353535;' +
    '}' +
    '.bpb-team-btn-secondary:hover { background: #e5e5e5; }' +
    '.bpb-team-msg {' +
    '  grid-column: 1 / -1;' +
    '  padding: 10px 14px; border-radius: 8px;' +
    '  font-size: 13px; line-height: 1.5;' +
    '}' +
    '.bpb-team-msg-ok {' +
    '  background: #f1e7d3; color: #7d5c31; border: 1px solid #c7d6cc;' +
    '}' +
    '.bpb-team-msg-err {' +
    '  background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;' +
    '}' +
    '.bpb-team-loading, .bpb-team-empty {' +
    '  color: #666; font-size: 13px;' +
    '  padding: 20px 0; text-align: center;' +
    '}' +
    '.bpb-team-foot {' +
    '  display: flex; justify-content: space-between; align-items: center;' +
    '  margin-top: 24px; gap: 12px;' +
    '}' +
    '.bpb-team-foot-note {' +
    '  font-size: 11px; color: #999;' +
    '  flex: 1; line-height: 1.5;' +
    '}' +
    '@media (max-width: 580px) {' +
    '  .bpb-team-modal { padding: 24px 20px; }' +
    '  .bpb-team-form { grid-template-columns: 1fr; }' +
    '}' +
    '</style>' +
    '<div class="bpb-team-modal" role="dialog" aria-labelledby="bpbTeamTitle">' +
    '  <div class="bpb-team-eyebrow">Master controls</div>' +
    '  <h2 id="bpbTeamTitle" class="bpb-team-title">Team members</h2>' +
    '  <div class="bpb-team-section-h">Active team</div>' +
    '  <ul class="bpb-team-list" id="bpbTeamList"><li class="bpb-team-loading">Loading…</li></ul>' +
    '  <div class="bpb-team-section-h">Invite a new team member</div>' +
    '  <form class="bpb-team-form" id="bpbTeamForm" novalidate>' +
    '    <label class="full">' +
    '      <span>Display name</span>' +
    '      <input type="text" name="display_name" required placeholder="e.g. Adriana">' +
    '    </label>' +
    '    <label class="full">' +
    '      <span>Email</span>' +
    '      <input type="email" name="email" required autocomplete="off" placeholder="name@baysidepavers.com">' +
    '    </label>' +
    '    <label>' +
    '      <span>Role</span>' +
    '      <select name="role">' +
    '        <option value="designer" selected>Designer</option>' +
    '        <option value="master">Master</option>' +
    '      </select>' +
    '    </label>' +
    '    <div style="display: flex; align-items: end;">' +
    '      <button type="submit" class="bpb-team-btn bpb-team-btn-primary" id="bpbTeamSubmit" style="width: 100%;">' +
    '        Send invite' +
    '      </button>' +
    '    </div>' +
    '    <div id="bpbTeamMsg"></div>' +
    '  </form>' +
    '  <div class="bpb-team-foot">' +
    '    <div class="bpb-team-foot-note">Invite emails come from Supabase Auth (default templates).</div>' +
    '    <button type="button" class="bpb-team-btn bpb-team-btn-secondary" id="bpbTeamClose">Close</button>' +
    '  </div>' +
    '</div>';

  // Close interactions
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector('#bpbTeamClose').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _overlay && _overlay.style.display !== 'none') {
      closeModal();
    }
  });

  // Invite submit
  overlay.querySelector('#bpbTeamForm').addEventListener('submit', handleInvite);

  return overlay;
}

async function refreshTeamList() {
  const listEl = document.getElementById('bpbTeamList');
  if (!listEl) return;
  listEl.innerHTML = '<li class="bpb-team-loading">Loading…</li>';
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, display_name, role, is_active')
      .eq('is_active', true)
      .order('role', { ascending: true })   // master before designer (alphabetical)
      .order('display_name', { ascending: true });

    if (error) throw error;
    if (!data || data.length === 0) {
      listEl.innerHTML = '<li class="bpb-team-empty">No team members yet.</li>';
      return;
    }

    listEl.innerHTML = '';
    for (const p of data) {
      const li = document.createElement('li');
      li.className = 'bpb-team-row';
      const info = document.createElement('div');
      info.className = 'bpb-team-row-info';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'bpb-team-row-name';
      nameDiv.textContent = p.display_name || '—';
      const emailDiv = document.createElement('div');
      emailDiv.className = 'bpb-team-row-email';
      emailDiv.textContent = p.email;
      info.appendChild(nameDiv);
      info.appendChild(emailDiv);
      const roleSpan = document.createElement('span');
      roleSpan.className = 'bpb-team-row-role' + (p.role === 'master' ? ' bpb-team-row-role-master' : '');
      roleSpan.textContent = p.role;
      li.appendChild(info);
      li.appendChild(roleSpan);
      listEl.appendChild(li);
    }
  } catch (err) {
    listEl.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'bpb-team-msg bpb-team-msg-err';
    li.textContent = (err && err.message) || 'Failed to load team list';
    listEl.appendChild(li);
  }
}

function clearMsg() {
  const msgEl = document.getElementById('bpbTeamMsg');
  if (msgEl) {
    msgEl.className = '';
    msgEl.textContent = '';
  }
}

function setMsg(text, kind) {
  const msgEl = document.getElementById('bpbTeamMsg');
  if (!msgEl) return;
  msgEl.className = 'bpb-team-msg ' + (kind === 'ok' ? 'bpb-team-msg-ok' : 'bpb-team-msg-err');
  msgEl.textContent = text;
}

async function handleInvite(e) {
  e.preventDefault();
  clearMsg();

  const form = e.target;
  const btn = form.querySelector('#bpbTeamSubmit');

  const fd = new FormData(form);
  const display_name = String(fd.get('display_name') || '').trim();
  const email = String(fd.get('email') || '').trim().toLowerCase();
  const role = String(fd.get('role') || 'designer');

  if (!display_name || !email) {
    setMsg('Display name and email are both required.', 'err');
    return;
  }

  btn.disabled = true;
  const origLabel = btn.textContent;
  btn.textContent = 'Sending invite…';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Your session expired — please refresh and sign in again.');

    const r = await fetch('/api/invite-designer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
      },
      body: JSON.stringify({ email, display_name, role }),
    });
    const result = await r.json().catch(() => ({}));

    if (!r.ok) {
      throw new Error(result.error || ('Invite failed (HTTP ' + r.status + ')'));
    }

    setMsg('Invite sent to ' + email + '. They\'ll receive an email to set their password and sign in.', 'ok');
    form.reset();
    await refreshTeamList();
  } catch (err) {
    setMsg((err && err.message) || 'Invite failed', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}
