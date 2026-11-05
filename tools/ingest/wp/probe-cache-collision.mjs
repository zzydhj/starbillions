/**
 * Is a wrong-looking product page the mirror's fault or the origin's?
 *
 *   node tools/ingest/wp/probe-cache-collision.mjs
 *
 * probe-spec-integrity found product pages whose specification table belongs to a
 * different product. Three causes are possible and only one of them is mine:
 *
 *   1. two cache directories decoded to the same output path, so a later write
 *      clobbered an earlier page - a bug in this build;
 *   2. the database extractor kept only one term per attribute facet, so the page is
 *      right and the comparison was against an incomplete expectation;
 *   3. WP Rocket served a page whose dynamic block was rendered from another
 *      product - stale on the origin, which a 1:1 mirror must inherit, not repair.
 *
 * Each is checked against the files themselves rather than argued about.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../lib/paths.js';
import { readDump } from './sql-dump.js';
import { toObjects } from './model.js';

const dump = readDump(paths.sql, ['wp_posts', 'wp_term_relationships', 'wp_term_taxonomy', 'wp_terms']);
const products = toObjects(dump, 'wp_posts').filter((row) => row.post_type === 'product');
const relations = toObjects(dump, 'wp_term_relationships');
const taxonomies = new Map(toObjects(dump, 'wp_term_taxonomy').map((row) => [row.term_taxonomy_id, row]));
const terms = new Map(toObjects(dump, 'wp_terms').map((row) => [row.term_id, row]));

const report = JSON.parse(readFileSync(join(paths.work, 'mirror-report.json'), 'utf8'));

/* 1. did two cached documents land on one output path? ---------------------- */

const byOut = new Map();
for (const page of report.pages) {
  if (!page.out.startsWith('product/')) continue;
  byOut.set(page.out, [...(byOut.get(page.out) ?? []), page.url]);
}

const collisions = [...byOut].filter(([, urls]) => urls.length > 1);
console.log(`\n  1) 产物路径冲突\n`);
console.log(`  产品页产物路径   ${byOut.size}`);
console.log(`  被写入多次的路径 ${collisions.length}`);
for (const [out, urls] of collisions.slice(0, 5)) console.log(`     ${out}  <-  ${urls.join('   |   ')}`);

/* 2. how many terms does a facet really have? ------------------------------- */

/** Every term attached to a post, grouped by taxonomy: the ground truth the page renders from. */
function facetsOf(postId) {
  const facets = new Map();

  for (const relation of relations) {
    if (String(relation.object_id) !== String(postId)) continue;

    const taxonomy = taxonomies.get(String(relation.term_taxonomy_id));
    if (taxonomy?.taxonomy?.startsWith('pa_') !== true) continue;

    const term = terms.get(String(relation.term_id));
    const label = taxonomy.taxonomy.slice(3);
    if (!facets.has(label)) facets.set(label, []);
    facets.get(label).push(term?.name ?? '?');
  }

  return facets;
}

const multi = products.map((product) => ({ product, facets: facetsOf(product.ID) }));
const multiFacets = multi.flatMap((item) => [...item.facets].filter(([, values]) => values.length > 1));

/** Which product a listed facet belongs to, for a readable line. */
function ownerOf(label) {
  return multi.find((item) => item.facets.has(label))?.product.post_name ?? '?';
}

console.log(`\n  2) 数据库里一个产品同一规格面有多个 term 的情况\n`);
console.log(`  规格面实例总数        ${multi.reduce((total, item) => total + item.facets.size, 0)}`);
console.log(`  其中含多个值的        ${multiFacets.length}`);
for (const [label, values] of multiFacets.slice(0, 6)) {
  console.log(`     ${label.padEnd(16)} ${values.join(' / ')}   <- ${ownerOf(label)}`);
}

/* 3. what does the cached document actually say? ---------------------------- */

console.log('\n  3) 抽查：产物自报的身份（title / h1 / 产品尺寸 / canonical）\n');

const probes = report.pages
  .filter((page) => page.out.startsWith('product/'))
  .map((page) => page.out)
  .filter((out) => out.includes('xby035') || out.includes('xby21'))
  .slice(0, 4);

for (const out of probes) {
  const built = join(paths.dist, out);
  if (!existsSync(built)) {
    console.log(`  ${out}: 产物缺失`);
    continue;
  }

  const html = readFileSync(built, 'utf8');
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, '').trim();
  const canonical = /<link[^>]*canonical[^>]*href="([^"]+)"/i.exec(html)?.[1];
  const sizeRow = /产品尺寸[\s\S]{0,220}?<td[^>]*>([\s\S]*?)<\/td>/.exec(html)?.[1]?.replace(/<[^>]+>/g, '').trim();

  console.log(`  ${out}`);
  console.log(`     title     ${title}`);
  console.log(`     h1        ${h1}`);
  console.log(`     产品尺寸  ${sizeRow}`);
  console.log(`     canonical ${canonical ?? '（无）'}\n`);
}
