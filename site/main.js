const tabs = [...document.querySelectorAll('[role="tab"]')];
function activate(tab) {
  for (const item of tabs) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(item.getAttribute('aria-controls'));
    if (panel) panel.hidden = !active;
  }
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => activate(tab));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    activate(tabs[next]);
    tabs[next].focus();
  });
}
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
