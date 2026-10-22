import { cpSync, mkdirSync } from 'node:fs';

mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
for (const name of [
  'index.html',
  'privacy.html',
  'style.css',
  'main.js',
  'robots.txt',
  'sitemap.xml',
  'assets',
]) {
  cpSync(new URL(name, import.meta.url), new URL(`dist/${name}`, import.meta.url), {
    recursive: true,
  });
}
