// ═══════════════════════════════════════════════════════════════════════════
// auth-util.js
// Shared authentication helpers for BPB admin + client platform.
//
// SPRINT 1 (Decouple): the /admin/ area is now MASTER-ONLY. The designer
// product (/dashboard, /editor, /site-map) contains no role branches at
// all — every query there is scoped to owner_user_id, for everyone.
//
// requireDesigner() and requireAdmin() were previously "designer or
// master" guards used by every /admin/ page. Since ALL of their importers
// live under /admin/ (verified via repo-wide grep), tightening them here
// seals the entire admin area in one change. Designers hitting any /admin/
// URL — bookmark, stale link, typed path — are bounced to /dashboard.
//
//   requireMaster()    → master only. Non-masters bounced to /dashboard.
//   requireDesigner()  → NOW ALSO master only (admin-area guard).
//   requireAdmin()     → alias of requireDesigner(), unchanged signature.
//
// Core functions:
//   getCurrentUser()           → current authenticated user (or null)
//   getProfile(user)           → loads {role, email, display_name, is_active}
//                                from profiles. Returns null if no row.
//   isMasterUser(profile)      → profile.role === 'master'
//   isDesignerUser(profile)    → profile.role IN ('master','designer')
//   isAdminUser(user)          → legacy email-only check (kept for callers
//                                that haven't migrated; new code should use
//                                isMasterUser / isDesignerUser)
//   requireMaster()            → guards master-only pages
//   requireDesigner()          → guards designer + master pages
//   requireAdmin()             → alias for requireDesigner()
//   requireClient()            → guards homeowner-portal pages
//   sendMagicLink(email, ret)  → triggers Supabase magic-link email
//   signOut()                  → clears session, redirects home
//   getClientRecord(user)      → loads the clients row for a logged-in client
//   linkClientOnFirstLogin(u)  → on first login, writes auth.uid() into the
//                                pre-existing clients row so future queries
//                                work under RLS
//   logClientActivity(...)     → writes to client_activity
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';

// Kept for backward compat: legacy email check used by isAdminUser().
const ADMIN_EMAIL = 'tim@mcmullen.properties';

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function getCurrentSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

// Loads the profile row keyed by auth.uid() for the given user. Returns null
// if no row exists or RLS blocks the read (which would mean the user isn't
// internal staff).
export async function getProfile(user) {
  if (!user?.id) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, display_name, role, is_active')
    .eq('id', user.id)
    .maybeSingle();
  if (error) {
    console.warn('getProfile:', error.message);
    return null;
  }
  return data;
}

export function isMasterUser(profile) {
  return profile?.role === 'master' && profile?.is_active !== false;
}

export function isDesignerUser(profile) {
  return (profile?.role === 'master' || profile?.role === 'designer')
    && profile?.is_active !== false;
}

// Legacy: kept for pages that still call this. New code should use
// isMasterUser / isDesignerUser.
export function isAdminUser(user) {
  return user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

/**
 * Guards master-only pages. Redirects to login if unauthenticated, to
 * /admin/index.html with an alert if authenticated but not master.
 * Returns {user, profile} on success, null on failure (after redirect).
 */
export async function requireMaster() {
  const user = await getCurrentUser();
  if (!user) {
    const ret = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login.html?redirect=${ret}`;
    return null;
  }
  const profile = await getProfile(user);
  if (!isMasterUser(profile)) {
    // Designers and clients have no business in /admin/. Send designers
    // to their pipeline; send anyone else (clients) home. No alert()
    // popups — a clean redirect reads as "that page isn't for you"
    // rather than an error.
    if (isDesignerUser(profile)) {
      window.location.replace('/dashboard');
    } else {
      window.location.replace('/');
    }
    return null;
  }
  return { user, profile };
}

/**
 * SPRINT 1: previously "designer or master" — now an alias for
 * requireMaster(). Every importer of this function is an /admin/ page,
 * and /admin/ is master-only after the decouple. Keeping the export
 * name means zero changes needed across the ~27 admin files.
 * Returns {user, profile} on success, null on failure (after redirect).
 */
export async function requireDesigner() {
  return requireMaster();
}

/**
 * Legacy: kept for backward compatibility with admin pages that import
 * `requireAdmin`. Behaves the same as `requireDesigner()` — returns the
 * user/profile so pages can read role-specific data — but pages that
 * destructure the return value as `const user = await requireAdmin()`
 * still get a truthy object back, so they keep working.
 *
 * Returns the user object (not a {user,profile} bundle) to match the
 * pre-Phase-5A signature used by existing pages like admin-clients.js.
 */
export async function requireAdmin() {
  const result = await requireDesigner();
  return result ? result.user : null;
}

/**
 * Guards client routes. Redirects to login if unauthenticated.
 * Unlike requireDesigner, does not reject staff — they can preview client pages.
 */
export async function requireClient() {
  const user = await getCurrentUser();
  if (!user) {
    const ret = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/client/login.html?return=${ret}`;
    return null;
  }
  // Link on first login in case we haven't yet — but only for non-staff,
  // since staff don't have clients rows.
  const profile = await getProfile(user);
  if (!isDesignerUser(profile)) {
    await linkClientOnFirstLogin(user);
  }
  return user;
}

/**
 * Sends a magic-link email via Supabase Auth (routed through Resend SMTP
 * if configured at the Supabase project level).
 *
 * @param email       {string} recipient
 * @param redirectPath {string} path the user lands on after clicking the link
 *                              e.g. '/client/dashboard.html' or '/admin/clients.html'
 */
export async function sendMagicLink(email, redirectPath = '/client/dashboard.html') {
  const redirectTo = `${window.location.origin}${redirectPath}`;
  const { data, error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: {
      emailRedirectTo: redirectTo,
      shouldCreateUser: true,
    },
  });
  return { data, error };
}

/**
 * Signs out the current user and redirects to home.
 */
export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = '/';
}

/**
 * Loads the client record for the currently authenticated user (by user_id).
 * Returns null if no client record exists for this auth user.
 */
export async function getClientRecord(user) {
  if (!user) return null;
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) {
    console.error('Error loading client record:', error);
    return null;
  }
  return data;
}

/**
 * On a client's first login, their new auth.users.id needs to be written
 * into the clients row that was pre-created by Tim. The RLS policy
 * "Clients link on first login" allows this specific update when:
 *   (1) clients.user_id IS NULL
 *   (2) clients.email matches the authenticated user's email
 *
 * Safe to call on every page load — it's a no-op if user_id is already set
 * or if no clients row exists for this email.
 */
export async function linkClientOnFirstLogin(user) {
  if (!user?.email) return;

  const { error } = await supabase
    .from('clients')
    .update({ user_id: user.id })
    .eq('email', user.email.toLowerCase())
    .is('user_id', null);

  if (error && error.code !== 'PGRST116') {
    console.warn('linkClientOnFirstLogin:', error.message);
  }
}

/**
 * Logs an activity event. Safe to call without awaiting.
 */
export async function logClientActivity(clientId, eventType, metadata = {}, proposalId = null) {
  if (!clientId) return;
  const { error } = await supabase
    .from('client_activity')
    .insert({
      client_id: clientId,
      proposal_id: proposalId,
      event_type: eventType,
      metadata,
    });
  if (error) console.warn('logClientActivity:', error.message);
}
