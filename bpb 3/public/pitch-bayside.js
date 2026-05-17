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
      el.textContent = Math.round(eased * target);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    counterObserver.unobserve(el);
  });
}, { threshold: 0.5 });
document.querySelectorAll('[data-count-to]').forEach(el => counterObserver.observe(el));

// Animate Hot Deals breakdown bars when in view
const cardObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.querySelectorAll('.hd-comp-bar-fill-demo').forEach(b => b.classList.add('animate'));
    cardObserver.unobserve(entry.target);
  });
}, { threshold: 0.4 });
const hd = document.getElementById('hotDealsDemo');
if (hd) cardObserver.observe(hd);

// Elisa timeline tooltips
const tooltip = document.getElementById('timelineTooltip');
const timelineSvg = document.getElementById('timelineSvg');
if (timelineSvg && tooltip) {
  document.querySelectorAll('.session-dot').forEach(dot => {
    dot.addEventListener('mouseenter', () => {
      const detail = dot.dataset.detail;
      const day = dot.dataset.day;
      const events = dot.dataset.events;
      tooltip.innerHTML = `<strong style="color:#b78b3a">Day ${day}</strong> · ${events} events<br><span style="opacity:0.85">${detail}</span>`;
      const wrapRect = timelineSvg.parentElement.getBoundingClientRect();
      const dotRect = dot.getBoundingClientRect();
      const left = dotRect.left - wrapRect.left + dotRect.width / 2;
      const top = dotRect.top - wrapRect.top;
      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
      tooltip.classList.add('visible');
    });
    dot.addEventListener('mouseleave', () => {
      tooltip.classList.remove('visible');
    });
  });
}

// Pricing calculator — per-deal-first framing (rebuilt 2026-05-17)
const dealsSlider = document.getElementById('dealsSlider');
const dealSizeSlider = document.getElementById('dealSizeSlider');
const splitSlider = document.getElementById('splitSlider');
const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');

function updateCalc() {
  const deals = parseInt(dealsSlider.value, 10);
  const dealSize = parseInt(dealSizeSlider.value, 10);
  const splitPct = parseInt(splitSlider.value, 10);

  // Per-deal economics (the headline)
  const feePerDeal = dealSize * 0.01;
  const designerSharePerDeal = feePerDeal * (splitPct / 100);
  const platformSharePerDeal = feePerDeal - designerSharePerDeal;

  // Annual context
  const annualFee = feePerDeal * deals;
  const netCostToBayside = platformSharePerDeal * deals;

  // Update slider labels
  document.getElementById('dealsLabel').textContent = deals;
  document.getElementById('dealSizeLabel').textContent = fmt(dealSize);
  document.getElementById('splitLabel').textContent = splitPct + '%';

  // Update headline + breakdown
  document.getElementById('feePerDeal').textContent = fmt(feePerDeal);
  document.getElementById('feeContext').textContent = '1% of a ' + fmt(dealSize) + ' deal';
  document.getElementById('designerSharePerDeal').textContent = fmt(designerSharePerDeal);
  document.getElementById('platformSharePerDeal').textContent = fmt(platformSharePerDeal);

  // Update volume context
  document.getElementById('annualFee').textContent = fmt(annualFee);
  document.getElementById('netCostToBayside').textContent = fmt(netCostToBayside);
}
if (dealsSlider && dealSizeSlider && splitSlider) {
  [dealsSlider, dealSizeSlider, splitSlider].forEach(s => s.addEventListener('input', updateCalc));
  updateCalc();
}

// Conversion lift calculator
const currentRespSlider = document.getElementById('currentRespSlider');
const bpbRespSlider = document.getElementById('bpbRespSlider');
const liftVolumeSlider = document.getElementById('liftVolumeSlider');
const AVG_DEAL_SIZE = 50000;

function fmtHours(h) {
  if (h < 24) return h + (h === 1 ? ' hour' : ' hours');
  const days = Math.round(h / 24 * 10) / 10;
  return days + (days === 1 ? ' day' : ' days');
}

function closeRateAt(hours) {
  return Math.max(0.07, 0.22 * Math.exp(-0.018 * hours) + 0.06);
}

function fmtMoney(n) {
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return '$' + Math.round(n / 1000) + 'K';
  return '$' + Math.round(n);
}

function updateLiftCalc() {
  const currentH = parseInt(currentRespSlider.value, 10);
  const bpbH = parseInt(bpbRespSlider.value, 10);
  const volume = parseInt(liftVolumeSlider.value, 10);

  document.getElementById('currentRespLabel').textContent = fmtHours(currentH);
  document.getElementById('bpbRespLabel').textContent = fmtHours(bpbH);
  document.getElementById('liftVolumeLabel').textContent = volume;

  const currR = closeRateAt(currentH);
  const bpbR = closeRateAt(bpbH);
  const lift = currR > 0 ? ((bpbR - currR) / currR) * 100 : 0;
  const incDeals = volume * (bpbR - currR);
  const incRev = incDeals * AVG_DEAL_SIZE;

  document.getElementById('currentCloseRate').textContent = Math.round(currR * 100) + '%';
  document.getElementById('bpbCloseRate').textContent = Math.round(bpbR * 100) + '%';
  document.getElementById('liftPct').textContent = (lift >= 0 ? '+' : '') + Math.round(lift) + '%';
  document.getElementById('incDeals').textContent = (incDeals >= 0 ? '+' : '') + Math.round(incDeals);
  document.getElementById('incRevenue').textContent = (incRev >= 0 ? '+' : '') + fmtMoney(Math.abs(incRev));
}

if (currentRespSlider && bpbRespSlider && liftVolumeSlider) {
  [currentRespSlider, bpbRespSlider, liftVolumeSlider].forEach(s =>
    s.addEventListener('input', updateLiftCalc)
  );
  updateLiftCalc();
}
