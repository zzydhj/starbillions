/**
 * Content survey: what the ingested rows actually hold, before any route is
 * written against them.
 *
 *   node tools/ingest/wp/probe-content.mjs
 *
 * Existence checks are not enough. The row counts proved the dump reader worked
 * while the blog was still Woodmart's demo posts and the page slugs were still
 * percent-encoded, so this reports the shape: shortcode usage, body sizes,
 * non-ASCII slugs, and which rows are WooCommerce system pages rather than
 * anything a visitor is meant to read.
 */
import { join } from 'node:path';
import { paths } from '../../lib/paths.js';
import { readFileSync } from 'node:fs';

const data = (name) => join(paths.data, name);

const products = JSON.parse(readFileSync(data('wp-products.json'), 'utf8'));
const pages = JSON.parse(readFileSync(data('wp-pages.json'), 'utf8'));
const posts = JSON.parse(readFileSync(data('wp-posts.json'), 'utf8'));

const shortcodes = new Map();
for (const row of [...products, ...pages, ...posts]) {
  for (const [, name] of String(row.body ?? '').matchAll(/\[(\w+)[\s/]]/g)) {
    shortcodes.set(name, (shortcodes.get(name) ?? 0) + 1);
  }
}

console.log('\n  shortcode tags found in post_content\n');
for (const [name, count] of [...shortcodes].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${name.padEnd(22)} ${count}`);
}
if (shortcodes.size === 0) console.log('    none — bodies are plain HTML');

console.log('\n  bodies by size\n');
const sized = [
  ...products.map((row) => ['product', row]),
  ...pages.map((row) => ['page', row]),
  ...posts.map((row) => ['post', row]),
]
  .map(([kind, row]) => [kind, row.slug, String(row.body ?? '').length])
  .filter(([, , length]) => length > 0)
  .sort((a, b) => b[2] - a[2]);
for (const [kind, slug, length] of sized.slice(0, 12)) {
  console.log(`    ${String(length).padStart(7)}  ${kind.padEnd(8)} ${slug.slice(0, 52)}`);
}
console.log(`    ... ${sized.length} rows with a body, ${products.length + pages.length + posts.length - sized.length} without`);

console.log('\n  slugs needing a decode pass\n');
const encoded = [...products, ...pages, ...posts].filter((row) => row.slug.includes('%'));
for (const row of encoded.slice(0, 8)) {
  console.log(`    ${row.slug.slice(0, 40)} -> ${safeDecode(row.slug)}`);
}
console.log(`    total encoded: ${encoded.length}`);

console.log('\n  first product body, 500 chars\n');
console.log('    ' + String(products.find((p) => p.body)?.body ?? '').replace(/\s+/g, ' ').slice(0, 500));

console.log('\n  every page slug\n');
for (const page of pages) {
  console.log(`    ${safeDecode(page.slug).padEnd(30)} body=${String(page.body ?? '').length}`);
}

console.log('\n  attribute facets\n');
for (const facet of JSON.parse(readFileSync(data('wp-attributes.json'), 'utf8'))) {
  console.log(`    ${facet.label.padEnd(18)} ${facet.values.length} values, e.g. ${facet.values[0]?.value}`);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
