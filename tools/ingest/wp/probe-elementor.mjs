/**
 * How much Elementor would have to be reproduced for a pixel-level clone.
 *
 *   node tools/ingest/wp/probe-elementor.mjs
 *
 * Elementor stores a page as JSON in `_elementor_data`: nested sections,
 * columns, then widgets. A static renderer therefore has a bounded job — cover
 * the widget types this site actually used, not all of Elementor. This counts
 * them, and reports which of the pages we care about are Elementor-authored at
 * all versus plain post_content.
 */
import { readDump } from './sql-dump.js';
import { metaByPost, toObjects } from './model.js';

const dump = readDump('work/tftstar.sql', ['wp_posts', 'wp_postmeta']);
const posts = toObjects(dump, 'wp_posts');
const meta = metaByPost(toObjects(dump, 'wp_postmeta'));

const widgets = new Map();
const settings = new Map();
let pagesWithData = 0;

const walk = (nodes) => {
  for (const node of nodes) {
    if (node?.widgetType) {
      widgets.set(node.widgetType, (widgets.get(node.widgetType) ?? 0) + 1);
      for (const key of Object.keys(node.settings ?? {})) {
        settings.set(key, (settings.get(key) ?? 0) + 1);
      }
    }
    if (Array.isArray(node?.elements)) walk(node.elements);
  }
};

const byType = new Map();
for (const row of posts) {
  const raw = meta[row.ID]?._elementor_data;
  if (!raw) continue;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // WordPress slashes JSON when saving meta; the magic-quotes escape has to be
    // undone before the value is parseable, which is why this is a second attempt
    // rather than a different reader.
    try {
      parsed = JSON.parse(raw.replace(/\\(["\\/])/g, '$1'));
    } catch {
      continue;
    }
  }

  pagesWithData += 1;
  byType.set(row.post_type, (byType.get(row.post_type) ?? 0) + 1);
  walk(Array.isArray(parsed) ? parsed : [], 0);
}

console.log(`\n  posts with _elementor_data: ${pagesWithData}\n`);
for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(type).padEnd(18)} ${count}`);
}

console.log('\n  widget types used (the renderer must cover these)\n');
for (const [type, count] of [...widgets].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(type).padEnd(26)} ${count}`);
}
console.log(`    distinct widget types: ${widgets.size}`);

console.log('\n  most common settings keys\n');
for (const [key, count] of [...settings].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(`    ${key.padEnd(26)} ${count}`);
}

const wanted = ['home-black-friday', '%e5%85%b3%e4%ba%8e%e6%88%91%e4%bb%ac', '%e8%81%94%e7%b3%bb%e6%88%91%e4%bb%ac'];
console.log('\n  the pages that matter, and who authored them\n');
for (const slug of wanted) {
  const row = posts.find((post) => post.post_name === slug);
  if (!row) continue;
  console.log(`    ${slug.padEnd(32)} content=${String(row.post_content).length} elementor=${meta[row.ID]?._elementor_data ? 'yes' : 'no'} template=${meta[row.ID]?._wp_page_template ?? '-'}`);
}

const products = posts.filter((post) => post.post_type === 'product' && post.post_status === 'publish');
const withElementor = products.filter((post) => meta[post.ID]?._elementor_data);
console.log(`\n  products with Elementor data: ${withElementor.length}/${products.length}`);
console.log(`  products with plain post_content: ${products.filter((post) => String(post.post_content).length > 40).length}/${products.length}`);
