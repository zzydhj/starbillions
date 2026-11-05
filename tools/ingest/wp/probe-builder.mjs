/**
 * Which page builder authored the content, and whether the theme's own CSS is
 * available. Decides between "render the HTML we were given" and "rebuild the
 * structure from fields", so it has to be answered before templates are written.
 *
 *   node tools/ingest/wp/probe-builder.mjs
 */
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { paths } from '../../lib/paths.js';
import { readDump } from './sql-dump.js';
import { toObjects } from './model.js';

const dump = readDump(paths.sql, ['wp_posts', 'wp_postmeta', 'wp_options']);
const meta = toObjects(dump, 'wp_postmeta');
const options = toObjects(dump, 'wp_options');

const counts = new Map();
for (const row of meta) {
  const key = /^[a-z_]*(elementor|wpb_backend|_edit_|siteorigin|fl_|briz|ct_|tatsu|rev_slider)/i.test(row.meta_key)
    ? row.meta_key
    : null;
  if (key === null) continue;
  counts.set(row.meta_key, (counts.get(row.meta_key) ?? 0) + 1);
}

console.log('\n  page-builder meta keys\n');
if (counts.size === 0) console.log('    none — no builder meta, post_content is the whole story');
for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`    ${key.padEnd(28)} ${count}`);
}

// Presence of any of these keys, per post, is what tells a builder page from a
// classic-editor one: builders keep their layout in meta and leave post_content
// nearly empty, so the raw HTML on its own does not answer the question.
const BUILDER_KEYS = ['_elementor_data', '_wpb-js-composer', '_wp_page_template', '_rev_slider'];
const perPost = new Map();
for (const row of meta) {
  const key = String(row.meta_key);
  if (!BUILDER_KEYS.some((prefix) => key.startsWith(prefix))) continue;
  perPost.set(row.post_id, (perPost.get(row.post_id) ?? 0) + 1);
}
console.log('\n  posts carrying builder meta: ' + perPost.size);
console.log('\n  top meta keys overall\n');
const all = new Map();
for (const row of meta) all.set(row.meta_key, (all.get(row.meta_key) ?? 0) + 1);
for (const [key, count] of [...all].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`    ${String(key).slice(0, 28).padEnd(30)} ${count}`);
}

for (const name of ['stylesheet', 'template', 'home-page', 'show_on_front', 'page_on_front', 'woocommerce_shop_page_id', 'trp_language_switcher_short_code']) {
  const row = options.find((option) => option.option_name === name);
  console.log(`    option ${String(name).padEnd(26)} ${row ? JSON.stringify(String(row.option_value).slice(0, 60)) : '-'}`);
}

const pages = JSON.parse(readFileSync(join(paths.data, 'wp-pages.json'), 'utf8'));
const home = pages.find((page) => page.slug === 'home-black-friday');
const bodyPath = join(paths.work, 'home-body.html');
writeFileSync(bodyPath, home?.body ?? '', 'utf8');
console.log(`\n  home body written to ${bodyPath} (${(home?.body ?? '').length} chars)`);
console.log('  first 900 chars, whitespace collapsed:\n');
console.log('    ' + String(home?.body ?? '').replace(/\s+/g, ' ').slice(0, 900));
