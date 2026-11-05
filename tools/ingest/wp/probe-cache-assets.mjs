/**
 * Do the cached pages' assets exist on disk?
 *
 *   node tools/ingest/wp/probe-cache-assets.mjs
 *
 * This is the go/no-go for building the mirror offline. A cached document is only
 * a 1:1 page if the CSS, JS and images it points at are also present; otherwise
 * the HTML is a skeleton and a live render is still required.
 *
 * URLs are taken from each document's own references rather than guessed from the
 * cache directory names, because the directory layout is WP Rocket's and can
 * disagree with the site's current permalink structure. The canonical link inside
 * the document is the authoritative URL, so it is reported next to the file path.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../../lib/paths.js';
import { exists, walk, writeFile } from '../../lib/fs-utils.js';

const DOCROOT = join(root, 'work', 'wp', 'tftstar.com');
const CACHE = join(DOCROOT, 'wp-content', 'cache', 'wp-rocket', 'tftstar.com');

const inventory = JSON.parse(readFileSync(join(root, 'work', 'rocket-cache.json'), 'utf8'));

/** Largest html file per cache directory, matching how the inventory was built. */
const filesByDirectory = new Map();
for (const file of walk(CACHE)) {
  if (!file.abs.toLowerCase().endsWith('.html')) continue;

  const at = file.rel.lastIndexOf('/');
  const directory = at === -1 ? '/' : `/${file.rel.slice(0, at)}`;
  // Decoded, to match how the inventory keys its URLs: the Chinese pages are
  // stored under percent-encoded directories and would otherwise never line up.
  const key = decodeURIComponent(directory);
  const existing = filesByDirectory.get(key);
  const size = readFileSync(file.abs).length;

  if (!existing || size > existing.size) filesByDirectory.set(key, { abs: file.abs, size });
}

/**
 * Absolute and relative references are the same thing here.
 *
 * WP Rocket caches the rendered document with absolute URLs, so sorting by host
 * alone put every stylesheet and image into the "external" bucket. The origin
 * tftstar.com IS the docroot that was unpacked from the archive, so a URL on that
 * host is classified by its path: an extension means a file to look for, a trailing
 * slash means another page. Only the first kind can be missing.
 */
const assets = new Map();
const pageLinks = new Map();
const externalHosts = new Map();
const rawByHost = new Map();
const canonicals = new Map();
let pagesRead = 0;

for (const page of inventory) {
  const found = filesByDirectory.get(page.url.replace(/\/$/, '') || '/');
  if (!found) continue;

  const text = readFileSync(found.abs, 'utf8');
  pagesRead += 1;

  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(text);
  if (canonical) canonicals.set(page.url, canonical[1]);

  for (const match of text.matchAll(/(?:src|href|poster|data-bg)="([^"]+)"/g)) {
    const raw = match[1].replace(/&amp;/g, '&');
    if (!raw || raw.startsWith('#')) continue;
    if (/^(data:|blob:|mailto:|tel:|javascript:)/i.test(raw)) continue;

    let url;
    try {
      url = new URL(raw, 'https://tftstar.com/');
    } catch {
      continue;
    }

    if (url.host !== 'tftstar.com') {
      externalHosts.set(url.host, (externalHosts.get(url.host) ?? 0) + 1);
      if (!rawByHost.has(url.host)) rawByHost.set(url.host, []);
      rawByHost.get(url.host).push(raw.slice(0, 150));
      continue;
    }

    const path = decodeURIComponent(url.pathname);
    if (path.includes('/wp-content/cache/')) continue; // the cache tree itself

    if (/\.[a-z0-9]{2,5}$/i.test(path)) assets.set(path, (assets.get(path) ?? 0) + 1);
    else pageLinks.set(path, (pageLinks.get(path) ?? 0) + 1);
  }
}

const present = [];
const missing = [];
for (const [path, uses] of assets) {
  (exists(join(DOCROOT, path.replace(/^\/+/, ''))) ? present : missing).push({ path, uses });
}

console.log(`\n  cached pages read: ${pagesRead} of ${inventory.length}\n`);
console.log(`  asset files referenced     ${assets.size}`);
console.log(`    present in the archive   ${present.length}  (${percent(present.length, assets.size)})`);
console.log(`    MISSING                  ${missing.length}`);
console.log(`  links to other pages       ${pageLinks.size}`);

if (missing.length > 0) {
  console.log('\n  missing, by most-used first:\n');
  for (const item of missing.sort((a, b) => b.uses - a.uses).slice(0, 15)) {
    console.log(`    ${String(item.uses).padStart(4)} x  ${item.path}`);
  }
}

console.log(`\n  external hosts still referenced:\n`);
for (const [host, count] of [...externalHosts].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${String(count).padStart(5)} x  ${host}`);
  // The raw attribute value, because a host that appears here but nowhere in the
  // HTML as text is a sign the value was parsed out of something unusual.
  for (const raw of [...new Set(rawByHost.get(host) ?? [])].slice(0, 2)) {
    console.log(`             raw: ${raw}`);
  }
}

console.log('\n  canonical URL sanity, three pages:\n');
for (const [url, canonical] of [...canonicals].slice(0, 3)) {
  console.log(`    dir ${url.slice(0, 44).padEnd(46)} -> ${canonical}`);
}

writeFile(
  join(root, 'work', 'cache-assets.json'),
  `${JSON.stringify(
    {
      present,
      missing,
      pageLinks: Object.fromEntries(pageLinks),
      external: Object.fromEntries(externalHosts),
      // Raw values, deduplicated, because the console proved unreliable at showing
      // them: a host beginning 127 printed as 0.0.0.1, and the difference between
      // a staging leftover and a real asset source is entirely in the text.
      externalRaw: Object.fromEntries(
        [...rawByHost].map(([host, raws]) => [host, [...new Set(raws)].slice(0, 6)]),
      ),
      canonicals: Object.fromEntries(canonicals),
    },
    null,
    2,
  )}\n`,
);
console.log('\n  detail -> work/cache-assets.json\n');

function percent(part, total) {
  return total === 0 ? 'n/a' : `${((part / total) * 100).toFixed(1)}%`;
}
