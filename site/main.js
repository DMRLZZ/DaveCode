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

// Motion: the intro, line reveals, the live terminal, typing panes and scroll effects. With
// reduced motion (or without IntersectionObserver) none of this runs and the page stays static.
const root = document.documentElement;
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Wrap each <br>-separated line of a heading in a mask so it can slide up. */
function splitLines(heading) {
  const lines = heading.innerHTML.split(/<br\s*\/?>/i);
  heading.innerHTML = lines
    .map((line, i) => {
      const dim = /^\s*<span>([\s\S]*)<\/span>\s*$/.exec(line);
      return `<span class="ln${dim ? ' dim' : ''}" style="--i: ${i}"><span>${dim ? dim[1] : line}</span></span>`;
    })
    .join('');
}

async function typeInto(element, text, perChar = 22) {
  element.textContent = '';
  for (const char of text) {
    element.textContent += char;
    await wait(perChar);
  }
}

/** The hero terminal: type "/", open the menu, pick /connect, choose Claude Code, repeat. */
async function runTerminal(term) {
  const typed = term.querySelector('.typed');
  const menu = term.querySelector('.menu');
  const picker = term.querySelector('.picker');
  const done = term.querySelector('.done');
  if (!typed || !menu || !picker || !done) return;
  const items = [...menu.querySelectorAll('li')];
  const names = items.map((li) => li.querySelector('b')?.textContent.replace('› ', '') ?? '');
  items.forEach((li, i) => {
    li.style.transitionDelay = `${i * 0.05}s`;
  });
  const select = (index) =>
    items.forEach((li, i) => {
      li.classList.toggle('on', i === index);
      const label = li.querySelector('b');
      if (label) label.textContent = `${i === index ? '› ' : ''}${names[i]}`;
    });
  let visible = false;
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
  }).observe(term);

  for (;;) {
    while (!visible || document.hidden) await wait(400);
    typed.textContent = '';
    done.hidden = true;
    picker.hidden = true;
    menu.hidden = false;
    menu.classList.add('hidden');
    select(0);
    await wait(900);
    typed.textContent = '/';
    await wait(250);
    menu.classList.remove('hidden');
    await wait(1100);
    select(1);
    await wait(900);
    await typeInto(typed, '/connect', 45);
    await wait(500);
    menu.hidden = true;
    picker.hidden = false;
    await wait(1600);
    picker.hidden = true;
    typed.textContent = '';
    done.hidden = false;
    await wait(3200);
  }
}

/** An agent pane types its prompt, works for a moment, then shows the result. */
async function runPane(pane, delay) {
  const ask = pane.querySelector('.ask span');
  const work = pane.querySelector('.work');
  const out = pane.querySelector('.out');
  if (!ask || !work || !out) return;
  const text = ask.textContent ?? '';
  ask.textContent = '';
  await wait(delay);
  await typeInto(ask, text);
  work.classList.add('on');
  await wait(1100);
  work.classList.remove('on');
  out.classList.add('on');
}

if (!reduce && 'IntersectionObserver' in window) {
  root.classList.add('motion');
  if (root.classList.contains('play-intro')) {
    try {
      sessionStorage.setItem('davecode-intro', '1');
    } catch {
      // Private mode: the intro may play again, which is harmless.
    }
    window.setTimeout(() => root.classList.remove('play-intro'), 3200);
  }

  for (const heading of document.querySelectorAll('main section:not(.hero) h2')) {
    splitLines(heading);
  }
  for (const selector of [
    '.pane',
    '.grid article',
    '.steps li',
    '.platform',
    '.questions details',
  ]) {
    document.querySelectorAll(selector).forEach((element, i) => {
      element.style.setProperty('--i', String(i));
    });
  }
  for (const element of document.querySelectorAll(
    'main section:not(.hero) .body, main section:not(.hero) .caption',
  )) {
    element.classList.add('rise');
    element.style.setProperty('--d', '3');
  }
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('ready')));

  const pending = new Set(document.querySelectorAll('main section:not(.hero)'));
  const show = (section) => {
    if (!pending.delete(section)) return;
    section.classList.add('shown');
    section.querySelectorAll('.pane').forEach((pane, i) => {
      void runPane(pane, 500 + i * 450);
    });
  };
  const sections = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        sections.unobserve(entry.target);
        show(entry.target);
      }
    },
    { threshold: 0.15 },
  );
  for (const section of pending) sections.observe(section);

  const term = document.querySelector('.hero .term');
  if (term) void runTerminal(term);

  // The terminal leans toward the pointer; cards light up under it.
  if (window.matchMedia('(pointer: fine)').matches) {
    const hero = document.querySelector('.hero');
    hero?.addEventListener('pointermove', (event) => {
      if (!term) return;
      const box = term.getBoundingClientRect();
      const x = (event.clientX - (box.left + box.width / 2)) / box.width;
      const y = (event.clientY - (box.top + box.height / 2)) / box.height;
      term.style.setProperty('--tilt-y', `${(x * 6).toFixed(2)}deg`);
      term.style.setProperty('--tilt-x', `${(-y * 6).toFixed(2)}deg`);
    });
    hero?.addEventListener('pointerleave', () => {
      term?.style.setProperty('--tilt-x', '0deg');
      term?.style.setProperty('--tilt-y', '0deg');
    });
    for (const card of document.querySelectorAll('.pane, .platform')) {
      card.addEventListener('pointermove', (event) => {
        const box = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${event.clientX - box.left}px`);
        card.style.setProperty('--my', `${event.clientY - box.top}px`);
      });
    }
  }

  // Scroll: progress bar, nav border and the large bird in the download section.
  const progress = document.querySelector('.progress');
  const nav = document.querySelector('.nav');
  const download = document.querySelector('.download');
  const bird = download?.querySelector('.big-bird');
  let queued = false;
  const onScroll = () => {
    queued = false;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress?.style.setProperty('--progress', String(max > 0 ? window.scrollY / max : 0));
    nav?.classList.toggle('scrolled', window.scrollY > 8);
    // Backstop for the observer: anything scrolled well into view is shown.
    for (const section of pending) {
      if (section.getBoundingClientRect().top < window.innerHeight * 0.85) show(section);
    }
    if (download && bird) {
      const box = download.getBoundingClientRect();
      const seen = (window.innerHeight - box.top) / (window.innerHeight * 0.9 + box.height * 0.4);
      bird.style.setProperty('--draw', String(1 - Math.min(1, Math.max(0, seen))));
    }
  };
  window.addEventListener(
    'scroll',
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(onScroll);
    },
    { passive: true },
  );
  onScroll();
}
