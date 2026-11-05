/**
 * Where the mirror check's two failures actually come from.
 *
 *   node tools/inspect-failures.mjs
 *
 * check.mjs reports "217 pages still name the old origin" and "949 internal paths
 * do not resolve", but neither number is actionable on its own: an origin inside a
 * Woodmart inline-JS config object must be rewritten, an origin inside prose is
 * content that the mirror has no business changing, and a path that does not
 * resolve is either a missing CSS file (our bug) or a page the site never cached
 * (their gap). Splitting the two decides what gets fixed and what gets reported.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './lib/paths.js';
import { walk } from './lib/fs-utils.js';
import { ORIGIN_URLS } from './ingest/wp/staticize.js';

const known = new Set(walk(paths.dist).map((file) => file.rel));
const documents = walk(paths.dist)
  .filter((file) => file.rel.endsWith('.html'))
  .map((file) => ({ ...file, text: readFileSync(file.abs, 'utf8') }));

/* origins ------------------------------------------------------------------- */

const contexts = new Map();
let insideAttribute = 0;
let insideScript = 0;
let insideStyle = 0;
let insideText = 0;

for (const doc of documents) {
  for (const origin of ORIGIN_URLS) {
    let cursor = 0;

    while ((cursor = doc.text.indexOf(origin, cursor)) !== -1) {
      const before = doc.text.slice(Math.max(0, cursor - 60), cursor);
      const after = doc.text.slice(cursor, cursor + origin.length + 60);

      if (/<script\b/i.test(before.slice(-300)) && !/<\/script>/.test(before)) insideScript += 1;
      else if (/<style\b/i.test(before.slice(-400)) && !/<\/style>/.test(before)) insideStyle += 1;
      else if (/="\s*$/.test(before)) insideAttribute += 1;
      else insideText += 1;

      const key = kind(before, after);
      contexts.set(key, (contexts.get(key) ?? 0) + 1);
      cursor += origin.length;
    }
  }
}

function kind(before, after) {
  if (/_baseUrl|baseUrl|ajaxurl|homeUrl|siteUrl|"url"/.test(before)) return 'JS config (baseUrl/ajaxurl)';
  if (/rel="canonical|og:url|og:image|twitter:/.test(before)) return 'head metadata tag';
  if (/srcset|data-src|href=/.test(before)) return 'an attribute still holding the origin';
  if (/%2F%2Ftftstar/.test(after) || /%2F%2Ftftstar/.test(before)) return 'percent-encoded inside another URL';
  return 'other';
}

console.log('\n  occurrences of the old origin, by surrounding syntax\n');
console.log(`    inside <script>   ${insideScript}`);
console.log(`    inside <style>    ${insideStyle}`);
console.log(`    attribute value   ${insideAttribute}`);
console.log(`    bare text/other   ${insideText}\n`);
for (const [key, count] of [...contexts].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(count).padStart(6)}  ${key}`);
}

/* broken paths -------------------------------------------------------------- */

const asset = new Map();
const page = new Map();
const feed = new Map();
const languagePrefix = new Map();

for (const doc of documents) {
  for (const match of doc.text.matchAll(/(?:href|src|poster|data-src|data-rocket-src|data-lazy-src)="(\/[^"]+)"/g)) {
    const pathname = decodeURIComponent(match[1].split('?')[0].split('#')[0]);
    if (pathname === '/' || pathname === '/index.html') continue;

    const asFile = pathname.replace(/^\/+/, '');
    if (known.has(asFile) || known.has(join(asFile, 'index.html'))) continue;

    if (/^\/zh_cn\//.test(pathname)) bucket(languagePrefix, pathname.replace('/zh_cn/', '/'));
    else if (/\/feed\/$|^\/comments\/feed\/$/.test(pathname)) bucket(feed, pathname);
    else if (/\.[a-z0-9]{2,5}$/i.test(pathname)) bucket(asset, pathname);
    else bucket(page, pathname);
  }
}

function bucket(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

console.log('\n  unresolved internal paths, classified\n');
console.log(`    assets (our bug)          ${asset.size}`);
console.log(`    RSS/comment feeds         ${feed.size}`);
console.log(`    /zh_cn/ language prefix   ${languagePrefix.size}`);
console.log(`    pages never cached        ${page.size}\n`);

console.log('  top asset failures:');
for (const [key, count] of [...asset].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`    ${count} x  ${key}`);
console.log('\n  top uncached page targets:');
for (const [key, count] of [...page].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`    ${count} x  ${key}`);
console.log('\n  distinct /zh_cn/ targets, first 5:');
for (const [key] of [...languagePrefix].slice(0, 5)) console.log(`         ${key}`);
