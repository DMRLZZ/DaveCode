# DaveCode public site

The landing page at https://davecode.app: black and white, the bird mark, a static terminal
that mirrors the real TUI, and the install command. No analytics, cookies or signup forms.

It is served by the Cloudflare Worker `davecode-site` with static assets, on the same account
as the domain and the `davecode-auth` account service.

```bash
node site/build.mjs                 # copies the files into site/dist
npx serve site/dist                 # preview locally
cd site && npx wrangler deploy      # publish (wrangler.jsonc attaches davecode.app and www)
```

`assets/og.png` is the 1200×630 share image; `assets/mark.svg` and `assets/favicon.svg` come
from `assets/brand/`. Geist is self-hosted; its license is in `assets/GEIST-LICENSE.txt`.
