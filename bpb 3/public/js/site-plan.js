// ═══════════════════════════════════════════════════════════════════════════
// Site plan section (Phase 1A Step 3 + post-launch polish).
//
// Renders the existing standalone labeling tool (/admin/site-map.html) inside
// the editor as an iframe scoped to the current proposal. Zero code duplication
// — both the standalone admin URL and this in-editor view render the exact
// same UI from the same source.
//
// Design choices:
//   • Compact one-line header (Site plan title + Open fullscreen link) so the
//     iframe gets maximum vertical space. Earlier two-row "SECTION / Site plan"
//     pattern was matching the other editor sections, but the labeling canvas
//     benefits more from height than from header consistency.
//   • Auto-save-before-fullscreen: clicking "Open fullscreen" first triggers a
//     save inside the iframe (via window.saveSiteMap exposed by site-map.js),
//     waits for completion, then opens the standalone view in a new tab. This
//     way unsaved polygons / vertex moves / section assignments don't get left
//     behind when Tim switches views.
// ═══════════════════════════════════════════════════════════════════════════

export function initSitePlan({ proposalId, container, onSave }) {
  const iframeUrl = `/admin/site-map.html?proposal_id=${encodeURIComponent(proposalId)}`;

  container.innerHTML = `
    <div class="site-plan-header">
      <h2>Site plan</h2>
      <a href="${iframeUrl}" target="_blank" rel="noopener" class="site-plan-fullscreen-link">
        Open fullscreen ↗
      </a>
    </div>
    <div class="site-plan-iframe-wrap">
      <iframe
        id="sitePlanFrame"
        src="${iframeUrl}"
        class="site-plan-iframe"
        title="Site plan labeling tool"
        loading="lazy"
      ></iframe>
    </div>
  `;

  injectStylesOnce();
  attachFullscreenAutoSave(container);
}

/**
 * Intercept the "Open fullscreen ↗" click. If there are unsaved changes in
 * the iframe, save them before navigating. Otherwise just open the link.
 *
 * Cross-frame mechanics:
 *   • site-map.js exposes window.saveSiteMap (returns a Promise) and
 *     window.hasUnsavedSiteMapChanges (returns a boolean).
 *   • Same origin — we can call iframe.contentWindow.* directly. No postMessage
 *     needed.
 *   • If the iframe hasn't finished loading yet, the contentWindow exists but
 *     the helpers don't — we treat that as "nothing to save" and just navigate.
 */
function attachFullscreenAutoSave(container) {
  const link = container.querySelector('.site-plan-fullscreen-link');
  const iframe = container.querySelector('#sitePlanFrame');

  link.addEventListener('click', async (e) => {
    const cw = iframe.contentWindow;
    if (!cw || typeof cw.saveSiteMap !== 'function') {
      return;  // iframe not ready — let the click navigate normally
    }
    if (!cw.hasUnsavedSiteMapChanges?.()) {
      return;  // nothing dirty — let the click navigate normally
    }

    // Have unsaved work — block the navigation, save, then open the new tab.
    e.preventDefault();
    link.textContent = 'Saving…';
    link.style.pointerEvents = 'none';
    try {
      await cw.saveSiteMap();
      window.open(link.href, '_blank', 'noopener');
    } catch (err) {
      // Save failed inside the iframe — surface to user. The iframe's own toast
      // will also fire, but a fallback here is cheap insurance.
      alert('Could not save before opening fullscreen: ' + (err?.message || err));
    } finally {
      link.textContent = 'Open fullscreen ↗';
      link.style.pointerEvents = '';
    }
  });
}

const STYLE_ID = 'site-plan-iframe-styles';
function injectStylesOnce() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .site-plan-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .site-plan-header h2 {
      margin: 0;
    }
    .site-plan-fullscreen-link {
      font-size: 13px;
      color: #91a1ba;
      text-decoration: none;
    }
    .site-plan-fullscreen-link:hover {
      color: #33281c;
      text-decoration: underline;
    }
    .site-plan-iframe-wrap {
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      overflow: hidden;
      background: #f5f6f8;
    }
    .site-plan-iframe {
      display: block;
      width: 100%;
      /* Reclaim ~80px from the previous two-row header. The remaining 140px
         accounts for the BPB topbar (~60px) + breathing room above/below the
         iframe inside the editor's main pane. */
      height: calc(100vh - 140px);
      min-height: 700px;
      border: 0;
    }
  `;
  document.head.appendChild(style);
}
