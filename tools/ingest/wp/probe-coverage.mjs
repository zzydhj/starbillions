/**
 * Does the page cache cover the whole catalogue?
 *
 *   node tools/ingest/wp/probe-coverage.mjs
 *
 * 217 cached documents is only useful if they are the *right* 217. The database
 * knows how many published products, categories, pages and posts exist, so this
 * compares that against what the cache actually holds, matched on the canonical
 * URL inside each document rather than on the cache directory name.
 *
 * Whatever is missing is the real remaining gap, and it decides whether a running
 * WordPress is needed at all: a gap of zero means every page is already rendered
 * and archived, and a gap of a few dozen means the cache has to be topped up from
 * somewhere.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../../lib/paths.js';
import { readJson } from '../../lib/fs-utils.js';

const cache = JSON.parse(readFileSync(join(root, 'work', 'rocket-cache.json'), 'utf8'));
const assets = JSON.parse(readFileSync(join(root, 'work', 'cache-assets.json'), 'utf8'));
const products = readJson(join(root, 'src', 'data', 'wp-products.json'));
const pages = readJson(join(root, 'src', 'data', 'wp-pages.json'));
const posts = readJson(join(root, 'src', 'data', 'wp-posts.json'));

/** Every URL the cache holds, taken from each document's own canonical link. */
const cached = new Set(Object.values(assets.canonicals).map((href) => new URL(href).pathname));
const cachedEnglish = new Set([...cached].filter((path) => path.startsWith('/en/')));

const wants = [
  ['products', products.map((product) => `/product/${product.slug}/`)],
  // WooCommerce archives its categories under /product-category/ unless the site
  // changed the base; that option was empty in wp_options, so this is the default.
  ['categories', readJson(join(root, 'src', 'data', 'wp-categories.json')).map((category) => `/product-category/${category.slug}/`)],
  ['content pages', pages.map((page) => `/${page.slug}/`)],
  ['blog posts', posts.map((post) => `/${post.slug}/`)],
];

console.log('\n  cache coverage, matched on canonical URL\n');

for (const [label, paths] of wants) {
  const wanted = paths.filter(Boolean);
  const hit = wanted.filter((path) => cached.has(path));
  const miss = wanted.filter((path) => !cached.has(path));

  console.log(`  ${label.padEnd(14)} ${String(hit.length).padStart(3)} / ${String(wanted.length).padEnd(3)} cached`);
  if (miss.length > 0 && miss.length <= 12) {
    for (const path of miss) console.log(`        missing ${decodeURIComponent(path)}`);
  } else if (miss.length > 12) {
    console.log(`        ${miss.length} missing, first: ${decodeURIComponent(miss[0].url ?? miss[0])}`);
  }
}

console.log(`\n  english paths in cache   ${cachedEnglish.size}`);
console.log(`  total cached documents   ${cache.length}`);
console.log(`  distinct cached URLs     ${new Set(cache.map((page) => page.url)).size}\n`);

/**
 * Pages that exist in the cache but not in the database's published content are
 * worth naming too: they are either archives, or content the earlier ingest
 * classified as theme demo data and dropped.
 */
const known = new Set(wants.flatMap(([, paths]) => paths.filter(Boolean)));
const orphans = [...cached].filter((path) => !known.has(path) && !path.startsWith('/en/'));
console.log(`  cached URLs with no matching database row: ${orphans.length}`);
for (const path of orphans.slice(0, 14)) console.log(`    ${decodeURIComponent(path)}`);
