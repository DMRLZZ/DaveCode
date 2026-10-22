# DaveCode public site

Black, responsive marketing site with a full-bleed generated artwork, a scroll-driven
hero, section reveals, keyboard-accessible tabs and a copyable source-install flow.
Reduced-motion users and browsers without scroll timelines get a readable fallback.

```text
node site/build.mjs
python -m http.server 4180 --directory site/dist
```

The portable Sites checkout is separate from the app's repository. The exact Site
identity is tracked in `.openai/hosting.json`; do not create a replacement Site.
Deployment: https://davecode-app.mor4lez.chatgpt.site
Requested custom domain: https://davecode.app

The landing page has no account backend, analytics or signup form. The local app's
Google/GitHub OAuth lives in the DaveCode gateway. Do not expose a user's gateway
or provider credentials merely to serve this public page.

`assets/hero.webp` was generated with ChatGPT's built-in image tool. Prompt: a wide,
dark graphite folded doorway, a restrained orange seam of light, negative space
for website typography, no text, logos or UI. Original PNG is retained alongside it.
Geist is self-hosted; its license is in `assets/GEIST-LICENSE.txt`.
