/**
 * Reports what the search index would actually contain, before it ships.
 *
 *   node tools/inspect-search-index.mjs
 *
 * Extraction from rendered HTML is regex work over markup nobody hand-checked, so the
 * failure mode is silent: a pattern that matches nothing yields an entry with an empty
 * spec field, the index builds successfully, and the search box simply never finds a
 * product by its resolution. Counting how many entries have each field is what turns
 * that from a guess into a measurement.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './lib/paths.js';
import { walk } from './lib/fs-utils.js';
import { buildSearchIndex } from './ingest/wp/search-index.js';

/**
 * Every product document in the mirror, tagged with the language of the tree it sits
 * in. dist is walked once: filtering by path prefix is what separates the two
 * languages, so scanning it twice would only double the work and the chance of the two
 * halves disagreeing.
 */
const pages = walk(paths.dist)
  .filter((file) => file.rel.endsWith('.html') && /(^|[\\/])product[\\/]/.test(file.rel))
  .filter((file) => !/[\\/]product-category[\\/]/.test(file.rel))
  .map((file) => {
    const rel = file.rel.replace(/\\/g, '/');
    return {
      html: readFileSync(file.abs, 'utf8'),
      urlPath: `/${rel.replace(/index\.html$/, '')}`,
      lang: rel.startsWith('en/') ? 'en' : 'zh',
    };
  });

/** Category archives: where the Chinese term names live. */
const categoryPages = walk(paths.dist)
  .filter((file) => file.rel.endsWith('.html') && /[\\/]product-category[\\/]/.test(file.rel))
  .map((file) => ({
    html: readFileSync(file.abs, 'utf8'),
    urlPath: `/${file.rel.replace(/\\/g, '/').replace(/index\.html$/, '')}`,
  }));

const entries = buildSearchIndex(pages, categoryPages, readFileSync(join(paths.dist, 'index.html'), 'utf8'));

const withTitle = entries.filter((entry) => entry.title).length;
const withSpecs = entries.filter((entry) => entry.text.split(' ').length > 6).length;
const withImage = entries.filter((entry) => entry.image.startsWith('/wp-content/')).length;
const withCategory = entries.filter((entry) => entry.categories.length > 0).length;
const withSku = entries.filter((entry) => entry.sku).length;

console.log(`\n  搜索索引抽取\n`);
console.log(`  扫到的产品页    ${pages.length}   （zh ${pages.filter((p) => p.lang === 'zh').length} / en ${pages.filter((p) => p.lang === 'en').length}）`);
console.log(`  抽出条目        ${entries.length}`);
console.log(`  有标题          ${withTitle}`);
console.log(`  文本足够长      ${withSpecs}   （规格表进来了没有）`);
console.log(`  有站内图片      ${withImage}`);
console.log(`  有分类          ${withCategory}`);
console.log(`  有 SKU          ${withSku}`);
console.log(`  索引体积        ${(JSON.stringify(entries).length / 1024).toFixed(1)} KB`);

const missing = pages.filter((page) => !entries.some((entry) => entry.url === page.urlPath));
if (missing.length > 0) {
  console.log(`\n  抽不出标题的页面 ${missing.length} 个：`);
  for (const page of missing.slice(0, 10)) console.log(`    ${page.urlPath}`);
}

const sample = entries.find((entry) => entry.lang === 'zh');
if (sample) {
  console.log(`\n  中文样本 ${sample.url}`);
  console.log(`    title      ${sample.title}`);
  console.log(`    categories ${sample.categories.join(' / ')}`);
  console.log(`    image      ${sample.image}`);
  console.log(`    text       ${sample.text.slice(0, 240)}`);
}

const sampleEn = entries.find((entry) => entry.lang === 'en');
if (sampleEn) {
  console.log(`\n  英文样本 ${sampleEn.url}`);
  console.log(`    title      ${sampleEn.title}`);
  console.log(`    text       ${sampleEn.text.slice(0, 200)}`);
}

/**
 * The queries a buyer would actually type. Listing them with what they resolve to is
 * the only way to see that the index is useful rather than merely populated.
 */
const probes = ['3.5', 'hdmi', '串口屏', '圆形', '分辨率', 'XBY128', '2.1', 'touch', '电容', '转接板', '长条'];
console.log(`\n  试探几个真实查询（命中条数 / 首个结果）\n`);

for (const query of probes) {
  const hits = entries.filter((entry) => entry.text.includes(query.toLowerCase()));
  console.log(`    ${query.padEnd(10)} ${String(hits.length).padStart(3)}  ${hits[0]?.url ?? '(无)'}`);
}
