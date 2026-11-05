/**
 * Inventory probe: proves the dump reader works and reports what content the
 * site actually holds, before any extractor is written against it.
 *
 *   node tools/ingest/wp/probe.mjs
 *
 * Run this first whenever a new backup arrives. Designing an extractor from a
 * row count is cheap; designing one from an assumption is not.
 */
import { join } from 'node:path';
import { root } from '../../lib/paths.js';
import { readDump } from './sql-dump.js';

const DUMP = join(root, 'work/tftstar.sql');

const TABLES = ['wp_posts', 'wp_terms', 'wp_term_taxonomy', 'wp_term_relationships', 'wp_postmeta'];

const started = Date.now();
const dump = readDump(DUMP, TABLES);
const ms = Date.now() - started;

console.log(`\n  parsed in ${ms} ms\n`);

for (const [table, data] of Object.entries(dump)) {
  console.log(`  ${table.padEnd(24)} ${String(data.rows.length).padStart(7)} rows  cols: ${data.columns ? data.columns.length : 'UNKNOWN'}`);
}

const posts = table('wp_posts');
const byType = count(posts, 'post_type');
const byStatus = count(posts, 'post_status');

console.log('\n  post types');
for (const [type, n] of entries(byType, 'post_type')) console.log(`    ${type.padEnd(22)}${n}`);

console.log('\n  status of published content');
for (const [status, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) console.log(`    ${status.padEnd(22)}${n}`);

// publish+product is the intersection the catalogue actually lives in
const live = posts.filter((row) => row.post_status === 'publish');
console.log(`\n  published rows: ${live.length}`);
console.log(`    of those products: ${live.filter((r) => r.post_type === 'product').length}`);
console.log(`    of those pages:    ${live.filter((r) => r.post_type === 'page').length}`);
console.log(`    of those posts:    ${live.filter((r) => r.post_type === 'post').length}`);

const taxonomies = table('wp_term_taxonomy');
console.log('\n  taxonomies');
for (const [name, n] of countEntries(taxonomies, 'taxonomy')) console.log(`    ${name.padEnd(28)}${n}`);

/** Map rows to an object keyed by the column names the dump declared. */
function table(name) {
  const data = dump[name];
  if (!data.columns) throw new Error(`${name}: dump did not state columns`);
  return data.rows.map((row) => Object.fromEntries(data.columns.map((column, index) => [column, row[index]])));
}

function count(rows, key) {
  const totals = new Map();
  for (const row of rows) totals.set(row[key], (totals.get(row[key]) ?? 0) + 1);
  return totals;
}

function entries(map, key) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
}

function countEntries(rows, key) {
  return [...count(rows, key).entries()].sort((a, b) => b[1] - a[1]);
}
