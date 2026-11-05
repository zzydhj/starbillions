/**
 * Does a cached page describe the product its URL says it is?
 *
 *   node tools/ingest/wp/probe-spec-integrity.mjs
 *
 * A browser check found the 1.28″ product page showing 2.1″ specifications. Two
 * explanations are possible and they lead to opposite work: the mirror moved data
 * between pages (a bug in this build, or a collision in the cache tree), or the
 * cache itself was stale on the origin (a property of the source, which a 1:1 mirror
 * must inherit rather than fix).
 *
 * The database is the only disambiguating source, so each product's attribute rows
 * are read from data/wp-products.json and compared against the spec table in the
 * document cached under its own URL.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../lib/paths.js';

const products = JSON.parse(readFileSync(join(paths.data, 'wp-products.json'), 'utf8'));

/** The rows of a WooCommerce specification table, as name and value text. */
function specTable(html) {
  const table = /<table[^>]*woocommerce-product-attributes[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  if (!table) return null;

  const rows = new Map();
  for (const match of table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)) {
    rows.set(strip(match[1]), strip(match[2]));
  }
  return rows;
}

function strip(fragment) {
  return fragment.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** The attributes the database says this product has, keyed by facet label. */
function dbSpecs(product) {
  const map = new Map();
  for (const facet of product.attributes ?? []) map.set(facet.label, facet.value);
  return map;
}

let compared = 0;
let mismatched = 0;
const samples = [];

for (const product of products) {
  const out = join(paths.dist, 'product', product.slug, 'index.html');
  let html;
  try {
    html = readFileSync(out, 'utf8');
  } catch {
    continue;
  }

  const shown = specTable(html);
  const stored = dbSpecs(product);
  if (shown === null || stored.size === 0) continue;
  compared += 1;

  const problems = [];
  if (html.includes(product.title) === false) problems.push('标题不在此页');

  for (const [label, value] of stored) {
    const here = shown.get(label);
    if (here === undefined) continue; // the theme renders some facets elsewhere
    if (normalize(here) !== normalize(value)) problems.push(`${label}: 页面="${here}" 数据库="${value}"`);
  }

  if (problems.length > 0) {
    mismatched += 1;
    if (samples.length < 6) samples.push({ slug: product.slug, title: product.title, problems });
  }
}

function normalize(text) {
  // The theme writes the inch mark as ″ and the database stores a bare ", plus
  // HTML entities and spacing; compare on the alphanumeric core only.
  return text
    .replace(/&quot;|&#8243;|["″”]/g, '')
    .replace(/&times;|×/g, 'x')
    .replace(/\s+/g, '')
    .toLowerCase();
}

console.log(`\n  产品页规格表与数据库逐行比对\n`);
console.log(`  可比对的页面   ${compared}`);
console.log(`  不一致的页面   ${mismatched}\n`);

for (const sample of samples) {
  console.log(`  ${sample.slug}`);
  console.log(`    标题: ${sample.title}`);
  for (const problem of sample.problems.slice(0, 4)) console.log(`    - ${problem}`);
  console.log('');
}
