// Sticky nav border on scroll
const topnav = document.getElementById('topnav');
window.addEventListener('scroll', () => {
  topnav.classList.toggle('scrolled', window.scrollY > 40);
}, { passive: true });

// Reveal-on-scroll
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -80px 0px' });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// Hero counter animation
const counterObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const el = entry.target;
    const target = parseInt(el.dataset.countTo, 10);
    if (isNaN(target)) return;
    const duration = 1400;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(target * eased);
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = target;
    };
    requestAnimationFrame(tick);
    counterObserver.unobserve(el);
  });
}, { threshold: 0.4 });
document.querySelectorAll('.hero-stat-num[data-count-to]').forEach(el => counterObserver.observe(el));

// Hot deals card pulse on reveal
const cardObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in-view');
      cardObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.3 });
const hdDemo = document.getElementById('hotDealsDemo');
if (hdDemo) cardObserver.observe(hdDemo);

// Elisa timeline tooltips
(function() {
  const tooltip = document.getElementById('timelineTooltip');
  const svg = document.getElementById('timelineSvg');
  if (!tooltip || !svg) return;
  document.querySelectorAll('.session-dot').forEach(dot => {
    dot.addEventListener('mouseenter', (e) => {
      const day = dot.dataset.day;
      const events = dot.dataset.events;
      const detail = dot.dataset.detail;
      tooltip.innerHTML = `<strong>Day ${day}</strong> · ${events} events<br><span style="opacity:0.7;font-size:11px;">${detail}</span>`;
      const rect = svg.getBoundingClientRect();
      const cx = parseFloat(dot.getAttribute('cx'));
      const cy = parseFloat(dot.getAttribute('cy'));
      const xPct = cx / 1000;
      const yPct = cy / 160;
      tooltip.style.left = (xPct * rect.width) + 'px';
      tooltip.style.top = (yPct * rect.height - 14) + 'px';
      tooltip.classList.add('visible');
    });
    dot.addEventListener('mouseleave', () => {
      tooltip.classList.remove('visible');
    });
  });
})();

// Pricing calculator · revenue impact model
(function() {
  const projectsSlider = document.getElementById('projectsSlider');
  const projectSizeSlider = document.getElementById('projectSizeSlider');
  const liftSlider = document.getElementById('liftSlider');
  if (!projectsSlider || !projectSizeSlider || !liftSlider) return;

  const projectsLabel = document.getElementById('projectsLabel');
  const projectSizeLabel = document.getElementById('projectSizeLabel');
  const liftLabel = document.getElementById('liftLabel');
  const projectValue = document.getElementById('projectValue');
  const designerCommission = document.getElementById('designerCommission');
  const portalFee = document.getElementById('portalFee');
  const projectsContext = document.getElementById('projectsContext');
  const baselineRevenue = document.getElementById('baselineRevenue');
  const liftedRateLabel = document.getElementById('liftedRateLabel');
  const liftedRevenue = document.getElementById('liftedRevenue');
  const pricingIncRevenue = document.getElementById('pricingIncRevenue');
  const totalPortalFees = document.getElementById('totalPortalFees');
  const portalROI = document.getElementById('portalROI');

  const BASELINE_CLOSE_RATE = 0.25;
  const DESIGNER_COMMISSION_PCT = 0.10;
  const PORTAL_FEE_PCT = 0.01;

  function fmtKM(n) {
    if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1_000) return '$' + Math.round(n / 1_000) + 'K';
    return '$' + Math.round(n).toLocaleString();
  }
  function fmtExact(n) {
    return '$' + Math.round(n).toLocaleString();
  }

  function recalc() {
    const projects = parseInt(projectsSlider.value, 10);
    const projectSize = parseInt(projectSizeSlider.value, 10);
    const liftPts = parseInt(liftSlider.value, 10);

    projectsLabel.textContent = projects;
    projectSizeLabel.textContent = '$' + projectSize.toLocaleString();
    liftLabel.textContent = '+' + liftPts + ' pts';

    const designerComm = projectSize * DESIGNER_COMMISSION_PCT;
    const portalFeeAmt = projectSize * PORTAL_FEE_PCT;
    projectValue.textContent = '$' + projectSize.toLocaleString();
    designerCommission.textContent = fmtExact(designerComm);
    portalFee.textContent = fmtExact(portalFeeAmt);

    const liftedRate = BASELINE_CLOSE_RATE + (liftPts / 100);
    const baselineCloses = projects * BASELINE_CLOSE_RATE;
    const liftedCloses = projects * liftedRate;
    const baselineRev = baselineCloses * projectSize;
    const liftedRev = liftedCloses * projectSize;
    const incRev = liftedRev - baselineRev;
    const totalFees = liftedCloses * portalFeeAmt;
    const roi = totalFees > 0 ? (incRev / totalFees) : 0;

    projectsContext.textContent = projects;
    baselineRevenue.textContent = fmtKM(baselineRev);
    liftedRateLabel.textContent = Math.round(liftedRate * 100) + '%';
    liftedRevenue.textContent = fmtKM(liftedRev);
    pricingIncRevenue.textContent = fmtKM(incRev);
    totalPortalFees.textContent = fmtExact(totalFees);
    portalROI.textContent = roi.toFixed(1) + '×';
  }

  projectsSlider.addEventListener('input', recalc);
  projectSizeSlider.addEventListener('input', recalc);
  liftSlider.addEventListener('input', recalc);
  recalc();
})();

// Conversion lift simulator · response-time model
(function() {
  const currentSlider = document.getElementById('currentRespSlider');
  const bpbSlider = document.getElementById('bpbRespSlider');
  const volSlider = document.getElementById('liftVolumeSlider');
  if (!currentSlider || !bpbSlider || !volSlider) return;

  const currentLabel = document.getElementById('currentRespLabel');
  const bpbLabel = document.getElementById('bpbRespLabel');
  const volLabel = document.getElementById('liftVolumeLabel');
  const currentCloseRate = document.getElementById('currentCloseRate');
  const bpbCloseRate = document.getElementById('bpbCloseRate');
  const liftPct = document.getElementById('liftPct');
  const incDeals = document.getElementById('incDeals');
  const incRevenue = document.getElementById('incRevenue');

  const AVG_DEAL = 50000;

  function closeRateFromHours(hours) {
    const maxRate = 0.28;
    const minRate = 0.08;
    const decay = 0.045;
    const rate = minRate + (maxRate - minRate) * Math.exp(-decay * hours);
    return Math.max(minRate, Math.min(maxRate, rate));
  }
  function fmtHours(h) {
    if (h >= 168) return h + 'h (week+)';
    if (h >= 24) {
      const days = Math.round(h / 24 * 10) / 10;
      return days + (days === 1 ? ' day' : ' days');
    }
    return h + (h === 1 ? ' hour' : ' hours');
  }
  function fmtKM(n) {
    const sign = n >= 0 ? '+' : '-';
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (abs >= 1_000) return sign + '$' + Math.round(abs / 1_000) + 'K';
    return sign + '$' + Math.round(abs).toLocaleString();
  }

  function recalc() {
    const curH = parseInt(currentSlider.value, 10);
    const bpbH = parseInt(bpbSlider.value, 10);
    const vol = parseInt(volSlider.value, 10);

    currentLabel.textContent = fmtHours(curH);
    bpbLabel.textContent = fmtHours(bpbH);
    volLabel.textContent = vol;

    const curRate = closeRateFromHours(curH);
    const bpbRate = closeRateFromHours(bpbH);
    const lift = (bpbRate - curRate) / curRate;
    const curDeals = vol * curRate;
    const bpbDeals = vol * bpbRate;
    const deltaDeals = bpbDeals - curDeals;
    const deltaRev = deltaDeals * AVG_DEAL;

    currentCloseRate.textContent = Math.round(curRate * 100) + '%';
    bpbCloseRate.textContent = Math.round(bpbRate * 100) + '%';
    liftPct.textContent = (lift >= 0 ? '+' : '') + Math.round(lift * 100) + '%';
    incDeals.textContent = (deltaDeals >= 0 ? '+' : '') + Math.round(deltaDeals);
    incRevenue.textContent = fmtKM(deltaRev);
  }

  currentSlider.addEventListener('input', recalc);
  bpbSlider.addEventListener('input', recalc);
  volSlider.addEventListener('input', recalc);
  recalc();
})();

// Moat demo · interactive homeowner editor (drag polygon vertices, swap materials, send to designer)
(function() {
  const root = document.getElementById('moatDemo');
  if (!root) return;
  const svg = root.querySelector('svg');
  if (!svg) return;

  const PIXELS_PER_FOOT = 12;
  let vertices = [
    { x: 160, y: 100 },
    { x: 460, y: 100 },
    { x: 480, y: 280 },
    { x: 130, y: 280 }
  ];
  let currentMaterial = {
    name: 'Catalina Grana',
    color: 'Scandina Gray',
    price: 28.50,
    img: 'https://gfgbypcnxkschnfsitfb.supabase.co/storage/v1/object/public/proposal-photos/swatches/2f59ac36-3424-463d-a7ab-45bfd9a2bb07.png?v=1776891712228'
  };
  const ORIGINAL_MATERIAL_NAME = 'Catalina Grana';
  let originalArea = 0;
  let userInteracted = false;

  const polyEl = document.getElementById('moatPolygon');
  const handlesG = document.getElementById('moatHandles');
  const labelG = document.getElementById('moatAreaLabel');
  const patternImg = document.getElementById('moatMaterialPatternImage');
  const areaSpan = document.getElementById('moatArea');
  const totalSpan = document.getElementById('moatTotal');
  const matDisplay = document.getElementById('moatMaterialDisplay');
  const badge = document.getElementById('moatPendingBadge');
  const badgeText = document.getElementById('moatPendingText');

  function polygonAreaPx(verts) {
    let a = 0;
    for (let i = 0; i < verts.length; i++) {
      const j = (i + 1) % verts.length;
      a += verts[i].x * verts[j].y;
      a -= verts[j].x * verts[i].y;
    }
    return Math.abs(a / 2);
  }
  function polygonCentroid(verts) {
    let cx = 0, cy = 0, a = 0;
    for (let i = 0; i < verts.length; i++) {
      const j = (i + 1) % verts.length;
      const cross = verts[i].x * verts[j].y - verts[j].x * verts[i].y;
      cx += (verts[i].x + verts[j].x) * cross;
      cy += (verts[i].y + verts[j].y) * cross;
      a += cross;
    }
    a /= 2;
    if (a === 0) return { x: verts[0].x, y: verts[0].y };
    return { x: cx / (6 * a), y: cy / (6 * a) };
  }
  function pxToSqft(px) {
    return Math.round(px / (PIXELS_PER_FOOT * PIXELS_PER_FOOT));
  }
  function fmtMoney(n) {
    return '$' + Math.round(n).toLocaleString();
  }

  function renderHandles() {
    handlesG.innerHTML = '';
    vertices.forEach((v, i) => {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', v.x);
      c.setAttribute('cy', v.y);
      c.setAttribute('r', 11);
      c.setAttribute('class', 'moat-handle');
      c.setAttribute('data-idx', i);
      c.addEventListener('pointerdown', startDrag);
      handlesG.appendChild(c);
    });
  }

  function renderLabel() {
    labelG.innerHTML = '';
    const c = polygonCentroid(vertices);
    const sqft = pxToSqft(polygonAreaPx(vertices));
    const text = sqft + ' sqft';
    const w = text.length * 7.5 + 18;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', c.x - w / 2);
    rect.setAttribute('y', c.y - 13);
    rect.setAttribute('width', w);
    rect.setAttribute('height', 26);
    rect.setAttribute('rx', 6);
    rect.setAttribute('fill', '#ffffff');
    rect.setAttribute('opacity', '0.94');
    labelG.appendChild(rect);
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', c.x);
    t.setAttribute('y', c.y + 5);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-family', 'JetBrains Mono, monospace');
    t.setAttribute('font-size', '13');
    t.setAttribute('font-weight', '700');
    t.setAttribute('fill', '#0e1218');
    t.textContent = text;
    labelG.appendChild(t);
  }

  function updateBadge() {
    if (!userInteracted) {
      badge.classList.remove('visible');
      return;
    }
    const sqft = pxToSqft(polygonAreaPx(vertices));
    const delta = sqft - originalArea;
    const parts = [];
    if (Math.abs(delta) >= 3) {
      parts.push((delta > 0 ? '+' : '') + delta + ' sqft');
    }
    if (currentMaterial.name !== ORIGINAL_MATERIAL_NAME) {
      parts.push('material');
    }
    if (parts.length === 0) {
      badge.classList.remove('visible');
    } else {
      badgeText.textContent = parts.join(' · ') + ' pending';
      badge.classList.add('visible');
    }
  }

  function update() {
    polyEl.setAttribute('points', vertices.map(v => v.x + ',' + v.y).join(' '));
    renderLabel();
    const sqft = pxToSqft(polygonAreaPx(vertices));
    const total = sqft * currentMaterial.price;
    areaSpan.textContent = sqft;
    totalSpan.textContent = fmtMoney(total);
    updateBadge();
  }

  // Pointer-based drag handling
  let dragIdx = null;
  let activeHandle = null;
  function startDrag(e) {
    e.preventDefault();
    const idx = parseInt(e.currentTarget.dataset.idx, 10);
    dragIdx = idx;
    activeHandle = e.currentTarget;
    try { activeHandle.setPointerCapture(e.pointerId); } catch (_) {}
    activeHandle.addEventListener('pointermove', onDrag);
    activeHandle.addEventListener('pointerup', endDrag);
    activeHandle.addEventListener('pointercancel', endDrag);
  }
  function onDrag(e) {
    if (dragIdx === null) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const sp = pt.matrixTransform(ctm.inverse());
    vertices[dragIdx].x = Math.max(20, Math.min(580, sp.x));
    vertices[dragIdx].y = Math.max(20, Math.min(340, sp.y));
    if (activeHandle) {
      activeHandle.setAttribute('cx', vertices[dragIdx].x);
      activeHandle.setAttribute('cy', vertices[dragIdx].y);
    }
    if (!userInteracted) {
      userInteracted = true;
    }
    update();
  }
  function endDrag(e) {
    if (activeHandle) {
      try { activeHandle.releasePointerCapture(e.pointerId); } catch (_) {}
      activeHandle.removeEventListener('pointermove', onDrag);
      activeHandle.removeEventListener('pointerup', endDrag);
      activeHandle.removeEventListener('pointercancel', endDrag);
    }
    dragIdx = null;
    activeHandle = null;
  }

  // Material swap
  root.querySelectorAll('.moat-mat-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      root.querySelectorAll('.moat-mat-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      currentMaterial = {
        name: swatch.dataset.name,
        color: swatch.dataset.color,
        price: parseFloat(swatch.dataset.price),
        img: swatch.dataset.img
      };
      patternImg.setAttribute('href', currentMaterial.img);
      patternImg.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', currentMaterial.img);
      matDisplay.textContent = currentMaterial.name;
      userInteracted = true;
      update();
    });
  });

  // Submit button — visual confirmation only
  const submitBtn = document.getElementById('moatSubmitBtn');
  submitBtn.addEventListener('click', () => {
    const orig = submitBtn.textContent;
    submitBtn.textContent = '✓ Sent to designer';
    submitBtn.disabled = true;
    setTimeout(() => {
      submitBtn.textContent = orig;
      submitBtn.disabled = false;
    }, 2200);
  });

  // Init
  originalArea = pxToSqft(polygonAreaPx(vertices));
  renderHandles();
  update();
})();
