for (const box of document.querySelectorAll('[data-copy]')) {
  const button = box.querySelector('button');
  button?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(box.querySelector('code')?.textContent ?? '');
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select it';
    }
    window.setTimeout(() => {
      button.textContent = 'Copy';
    }, 1600);
  });
}

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
  for (const section of document.querySelectorAll('.agents,.why,.start,.faq')) {
    section.classList.add('reveal');
    observer.observe(section);
  }
}
