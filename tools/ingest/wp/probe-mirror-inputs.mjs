/**
 * The exact input set for the static mirror.
 *
 *   node tools/ingest/wp/probe-mirror-inputs.mjs
 *
 * Two gaps in the earlier asset probe had to be closed before anything gets
 * deleted or built. It skipped every path containing /wp-content/cache/, which is
 * precisely where WP Rocket writes its combined stylesheets and critical CSS, so
 * the "404 assets" figure was a floor, not the total. And it looked only at plain
 * src/href, while a Rocket-optimised page hides its real URLs behind lazy-load and
 * delay-JS placeholders — copying the visible attribute and not the placeholder
 * would ship blank images.
 *
 * So this reports the full file set to copy, grouped by where it lives, and counts
 * the placeholder mechanisms that the transformer will have to understand.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../../lib/paths.js';
import { exists, walk, writeFile } from '../../lib/fs-utils.js';

const DOCROOT = join(root, 'work', 'wp', 'tftstar.com');
const CACHE = join(DOCROOT, 'wp-content', 'cache', 'wp-rocket', 'tftstar.com');
const ORIGIN = 'https://tftstar.com';

/** Attribute names WordPress themes and WP Rocket use to hide a real URL. */
const URL_ATTRS = [
  'src', 'href', 'poster', 'action', 'data-src', 'data-lazy-src', 'data-bg',
  'data-rocket-src', 'data-minify-src', 'data-thumb', 'data-srcset', 'srcset',
];

const filesByDirectory = new Map();
for (const file of walk(CACHE)) {
  if (!file.abs.toLowerCase().endsWith('.html')) continue;

  const at = file.rel.lastIndexOf('/');
  const key = decodeURIComponent(at === -1 ? '/' : `/${file.rel.slice(0, at)}`);
  const size = readFileSync(file.abs).length;
  const existing = filesByDirectory.get(key);

  if (!existing || size > existing.size) filesByDirectory.set(key, { abs: file.abs, size });
}

const assets = new Map();
const pages = new Map();
const external = new Map();
const placeholders = new Map();
const perPage = [];

for (const [url, entry] of filesByDirectory) {
  const text = readFileSync(entry.abs, 'utf8');

  for (const match of text.matchAll(/<link rel="canonical" href="([^"]+)"/g)) {
    pages.set(new URL(match[1], ORIGIN).pathname, url);
  }

  for (const attr of URL_ATTRS) {
    for (const match of text.matchAll(new RegExp(`(?:^|\\s)${attr}="([^"]+)"`, 'g'))) {
      record(match[1]);
    }
  }

  for (const match of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) record(match[1]);

  for (const name of ['data-rocket-src', 'data-lazy-src', 'data-minify-src', 'data-src', 'rocket-loader', '__rocketdata', 'rocketlazyloadscripts']) {
    const hits = text.toLowerCase().split(name.toLowerCase()).length - 1;
    if (hits > 0) placeholders.set(name, (placeholders.get(name) ?? 0) + hits);
  }

  perPage.push({
    url,
    bytes: entry.size,
    scripts: (text.match(/<script\b/g) ?? []).length,
    externalScripts: (text.match(/<script[^>]+\ssrc=/g) ?? []).length,
    inlineStyles: (text.match(/<style\b/g) ?? []).length,
    images: (text.match(/<img\b/g) ?? []).length,
  });
}

function record(raw) {
  const value = raw.replace(/&amp;/g, '&');
  if (!value || value.startsWith('#')) return;
  if (/^(data:|blob:|mailto:|tel:|javascript:)/i.test(value)) return;

  let url;
  try {
    url = new URL(value.replace(/^\/\//, 'https://'), ORIGIN);
  } catch {
    return;
  }

  if (url.host !== new URL(ORIGIN).host) {
    external.set(url.host, (external.get(url.host) ?? 0) + 1);
    return;
  }

  const path = decodeURIComponent(url.pathname);
  if (/\.[a-z0-9]{2,5}$/i.test(path)) assets.set(path, (assets.get(path) ?? 0) + 1);
  else if (!path.startsWith('/wp-content/cache/')) pages.set(path, pages.get(path) ?? path);
}

const groups = new Map();
const missing = [];

for (const [path, uses] of assets) {
  const where = path.split('/').slice(1, 3).join('/');
  groups.set(where, (groups.get(where) ?? 0) + 1);
  if (!exists(join(DOCROOT, path.replace(/^\/+/, '')))) missing.push({ path, uses });
}

console.log('\n  mirror input set\n');
console.log(`  cached documents        ${filesByDirectory.size}`);
console.log(`  distinct asset paths    ${assets.size}`);
console.log(`  internal page paths     ${pages.size}`);
console.log(`  MISSING asset files     ${missing.length}\n`);

console.log('  assets by location\n');
for (const [where, count] of [...groups].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(count).padStart(4)}  /${where}/`);
}

console.log('\n  WP Rocket placeholder mechanisms present\n');
for (const [name, count] of [...placeholders].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(count).padStart(6)} x  ${name}`);
}

const totals = perPage.reduce(
  (sum, page) => ({ scripts: sum.scripts + page.scripts, images: sum.images + page.images, bytes: sum.bytes + page.bytes }),
  { scripts: 0, images: 0, bytes: 0 },
);
console.log(`\n  across all pages: ${totals.scripts} script tags, ${totals.images} <img>, ${(totals.bytes / 1048576).toFixed(1)} MB of HTML\n`);

writeFile(
  join(root, 'work', 'mirror-inputs.json'),
  `${JSON.stringify({ assets: Object.fromEntries(assets), pages: [...pages.keys()], external: Object.fromEntries(external), missing, placeholders: Object.fromEntries(placeholders) }, null, 2)}\n`,
);
console.log('  full list -> work/mirror-inputs.json\n');
