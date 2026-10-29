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

// Offer the installer for this computer first.
const platform = navigator.userAgentData?.platform ?? navigator.platform ?? '';
const os = /win/i.test(platform)
  ? 'windows'
  : /mac/i.test(platform)
    ? 'mac'
    : /linux/i.test(platform) && !/android/i.test(navigator.userAgent)
      ? 'linux'
      : undefined;
const mine = os && document.querySelector(`.platform[data-os="${os}"]`);
const download = document.getElementById('download');
if (mine && download) {
  mine.classList.add('mine');
  download.href = mine.href;
  download.textContent = `Download for ${mine.querySelector('h3')?.textContent}`;
  const hint = document.getElementById('download-hint');
  if (hint) hint.innerHTML = 'Also for <a href="#download-all">other platforms</a> and as a CLI.';
}
