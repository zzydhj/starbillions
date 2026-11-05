/**
 * Inventory of the WP Rocket page cache inside the backup.
 *
 *   node tools/ingest/wp/probe-cache.mjs
 *
 * This decides the whole approach. WordPress themes produce their markup by
 * executing PHP, which is why a static mirror normally needs a runtime; but WP
 * Rocket writes the *rendered* result of that execution to disk under
 * wp-content/cache/wp-rocket/<host>/... . If those files are complete documents,
 * the backup already holds the finished pages for both languages and no PHP or
 * MySQL is required at all.
 *
 * So the question is not "are there HTML files" but three specific ones, checked
 * here rather than assumed: is each one a whole document from <!DOCTYPE>, how many
 * distinct URLs do the tree and its per-directory duplicates actually represent,
 * and are the catalogue pages among them.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../../lib/paths.js';
import { walk, writeFile } from '../../lib/fs-utils.js';

const CACHE = join(root, 'work', 'wp', 'tftstar.com', 'wp-content', 'cache', 'wp-rocket', 'tftstar.com');

const files = walk(CACHE);
const html = files.filter((file) => file.abs.toLowerCase().endsWith('.html'));

/**
 * One URL can leave several files behind: WP Rocket stores the plain page and,
 * depending on settings, a separate entry per User Group or a `_gzip` variant.
 * Counting files would therefore overstate coverage, so entries are keyed by the
 * decoded directory, which is the URL.
 */
const byUrl = new Map();
for (const file of html) {
  // A page at the cache root has no directory at all, so slice(0, -1) on the
  // strength of a missing "/" would turn index.html into "index.htm" and invent a
  // URL that never existed.
  const at = file.rel.lastIndexOf('/');
  const directory = at === -1 ? '' : file.rel.slice(0, at);
  const key = decodeURIComponent(directory === '' ? '/' : `/${directory}`);

  if (!byUrl.has(key)) byUrl.set(key, []);
  byUrl.get(key).push(file);
}

const report = [];
let incomplete = 0;

for (const [urlPath, entries] of [...byUrl].sort()) {
  // Take the largest variant: a truncated write is shorter than the real page.
  const biggest = entries.sort((a, b) => statSync(b.abs).size - statSync(a.abs).size)[0];
  const text = readFileSync(biggest.abs, 'utf8');
  const isDocument = /^\s*<!DOCTYPE html/i.test(text);
  if (!isDocument) incomplete += 1;

  report.push({
    url: urlPath,
    bytes: statSync(biggest.abs).size,
    variants: entries.length,
    document: isDocument,
    woodmart: /class="[^"]*\bwd-/.test(text),
    elementor: /\be-elementor/.test(text),
    header: /<header[\s>]/i.test(text),
    footer: /<footer[\s>]/i.test(text),
    internalLinks: [...text.matchAll(/href="(https?:\/\/tftstar\.com[^"]*)"/g)].length,
    images: [...text.matchAll(/src="(https?:\/\/[^"]*\/wp-content\/uploads\/[^"]*)"/g)].length,
    mtime: statSync(biggest.abs).mtime.toISOString().slice(0, 10),
  });
}

const count = (predicate) => report.filter(predicate).length;

console.log('\n  WP Rocket page cache\n');
console.log(`  html files          ${html.length}`);
console.log(`  distinct URLs       ${report.length}`);
console.log(`  complete documents  ${count((page) => page.document)} / ${report.length}`);
console.log(`  not a document      ${incomplete}`);
console.log(`  carry <header>      ${count((page) => page.header)}`);
console.log(`  carry <footer>      ${count((page) => page.footer)}`);
console.log(`  Woodmart markup     ${count((page) => page.woodmart)}`);
console.log(`  Elementor markup    ${count((page) => page.elementor)}`);

console.log('\n  coverage by page kind\n');
const kinds = [
  ['product detail', /^\/product\//],
  ['product category', /^\/product-category\//],
  ['english (/en/)', /^\/en\//],
  ['blog post (dated)', /^\/\d{4}-\d{2}-\d{2}-/],
  ['shop', /^\/shop\/?$/],
  ['cart or account', /^\/(cart|my-account|checkout)/],
  ['home', /^\/$/],
];
for (const [label, pattern] of kinds) {
  console.log(`    ${label.padEnd(20)} ${count((page) => pattern.test(page.url))}`);
}

console.log('\n  newest and oldest cached pages\n');
const dated = [...report].sort((a, b) => a.mtime.localeCompare(b.mtime));
if (dated.length) {
  console.log(`    oldest ${dated[0].mtime}  ${dated[0].url.slice(0, 60)}`);
  console.log(`    newest ${dated.at(-1).mtime}  ${dated.at(-1).url.slice(0, 60)}`);
}

console.log('\n  ten largest pages\n');
for (const page of [...report].sort((a, b) => b.bytes - a.bytes).slice(0, 10)) {
  console.log(`    ${(page.bytes / 1024).toFixed(0).padStart(6)} kB  ${page.url.slice(0, 62)}`);
}

writeFile(join(root, 'work', 'rocket-cache.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n  full inventory -> work/rocket-cache.json\n`);
