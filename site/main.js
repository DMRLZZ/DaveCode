const tabs = [...document.querySelectorAll('[role="tab"]')];
const demo = document.querySelector('.demo');
const toggle = document.getElementById('demo-toggle');
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
let playing = !motion.matches;
let inView = false;
let timer;

function schedule() {
  window.clearTimeout(timer);
  toggle?.setAttribute('aria-pressed', String(playing));
  if (toggle) toggle.textContent = playing ? 'Pause demo' : 'Play demo';
  if (!playing || !inView || document.hidden || !tabs.length) return;
  timer = window.setTimeout(() => {
    const index = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    activate(tabs[(index + 1) % tabs.length]);
    schedule();
  }, 4500);
}

function activate(tab) {
  for (const item of tabs) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(item.getAttribute('aria-controls'));
    if (panel) panel.hidden = !active;
  }
  if (demo) demo.dataset.stage = tab.id.replace('tab-', '');
  const position = document.getElementById('demo-position');
  if (position) position.textContent = `${tabs.indexOf(tab) + 1} / ${tabs.length}`;
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => {
    playing = false;
    activate(tab);
    schedule();
  });
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    playing = false;
    activate(tabs[next]);
    tabs[next].focus();
    schedule();
  });
}
toggle?.addEventListener('click', () => {
  playing = !playing;
  schedule();
});
demo?.addEventListener('focusin', (event) => {
  if (event.target === toggle) return;
  playing = false;
  schedule();
});
motion.addEventListener('change', () => {
  if (motion.matches) playing = false;
  schedule();
});
document.addEventListener('visibilitychange', schedule);
if (demo && 'IntersectionObserver' in window) {
  new IntersectionObserver(
    ([entry]) => {
      inView = entry.isIntersecting;
      schedule();
    },
    { threshold: 0.25 },
  ).observe(demo);
} else {
  inView = true;
}
schedule();
document.getElementById('copy-install')?.addEventListener('click', async () => {
  const status = document.getElementById('copy-status');
  try {
    await navigator.clipboard.writeText(document.getElementById('install-code')?.textContent ?? '');
    status.textContent = 'Copied. Paste the commands into your terminal.';
  } catch {
    status.textContent = 'Select the commands above and copy them manually.';
  }
});

if (
  'IntersectionObserver' in window &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches
) {
  document.body.classList.add('js-reveal');
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
    },
    { threshold: 0.08 },
  );
  for (const section of document.querySelectorAll('.intro,.principles,.manifesto,.start,.faq'))
    observer.observe(section);
}
