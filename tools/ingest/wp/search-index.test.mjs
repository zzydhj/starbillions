/**
 * Tests for the static search: extraction from rendered HTML, and the ranking the
 * browser will run.
 *
 *   node --test tools/ingest/wp/search-index.test.mjs
 *
 * The extraction cases are fixtures rather than the real pages because the point is to
 * pin down what the regexes are supposed to find, including the shapes that appear only
 * once in the catalogue. The behaviour that actually broke during development - the
 * category page attributing its name to every product in the header's mega menu - is
 * encoded as a test below, since it produced a plausible-looking index rather than an
 * error.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSearchIndex, categoryMembership, extractProduct, menuMembership, productLoop } from './search-index.js';
import { LIMIT, highlight, normalise, score, search } from '../../../public/site-search.js';

const productPage = ({
  title = 'Starbillions 3.5″ TFT XBY35FHD',
  sku = '',
  crumb = '<a href="/">首页</a> <a href="/product-category/%E4%B8%B2%E5%8F%A3%E5%B1%8F/">串口屏</a>',
  specs = '<tr><th>分辨率</th><td>480*480</td></tr><tr><th>接口</th><td>MIPI</td></tr>',
  image = '/wp-content/uploads/2024/01/a.jpg',
} = {}) => `<html><head><title>${title}</title></head><body>
  <nav class="woocommerce-breadcrumb">${crumb}</nav>
  <h1 class="product_title entry-title wd-entities-title"> ${title} </h1>
  ${sku ? `<mark class="sku">${sku}</mark>` : ''}
  <div class="woocommerce-product-gallery__image"><img src="/wp-content/themes/woodmart/images/lazy.png" data-wood-src="${image}"></div>
  <table class="woocommerce-product-attributes shop_attributes"><tr>${specs}</tr></table>
</body></html>`;

test('extractProduct reads title, breadcrumb category, specs and the deferred image', () => {
  const product = extractProduct({ html: productPage(), urlPath: '/product/x/', lang: 'zh' });

  assert.equal(product.title, 'Starbillions 3.5″ TFT XBY35FHD');
  assert.deepEqual(product.categories, ['串口屏']);
  assert.deepEqual(product.specs, [{ name: '分辨率', value: '480*480' }, { name: '接口', value: 'MIPI' }], 'one attribute per table row');
  assert.equal(product.image, '/wp-content/uploads/2024/01/a.jpg', 'the real image, not the lazy placeholder');
});

test('a page without a product title is not indexed', () => {
  assert.equal(extractProduct({ html: '<h1 class="entry-title">Blog post</h1>', urlPath: '/blog/', lang: 'zh' }), null);
});

test('the index folds every field into one searchable string', () => {
  const [entry] = buildSearchIndex([{ html: productPage({ sku: 'XBY35FHD' }), urlPath: '/product/x/', lang: 'zh' }]);

  assert.equal(entry.url, '/product/x/');
  for (const needle of ['3.5', 'xby35fhd', '串口屏', '分辨率', 'mipi']) {
    assert.ok(entry.text.includes(normalise(needle)), `text should contain ${needle}`);
  }
});

test('category membership is read from the product loop, not the whole page', () => {
  // Every category page carries the site header, and the header's mega menu links
  // products from across the catalogue. Reading the document as a whole therefore
  // claims those products belong to this category.
  const categoryHtml = `<h1 class="page-title">串口屏</h1>
    <div class="wd-header-search-form"><a href="/product/from-mega-menu/">other</a></div>
    <p class="woocommerce-result-count">显示全部 1 个结果</p>
    <ul class="products columns-4"><li><a href="/product/inside-loop/">real</a></li></ul>
    <footer><a href="/product/in-footer/">footer item</a></footer>`;

  const loop = productLoop(categoryHtml);
  assert.ok(loop.includes('/product/inside-loop/'), 'the loop itself is found');
  assert.ok(!loop.includes('/product/in-footer/'), 'the footer is excluded');
  assert.ok(!loop.includes('/product/from-mega-menu/'), 'the header is excluded');

  const membership = categoryMembership([{ html: categoryHtml, urlPath: '/product-category/chuan/' }]);
  assert.deepEqual([...membership.keys()], ['/product/inside-loop/']);
});

test('percent-encoded links and decoded file paths meet on the same key', () => {
  // The mirror writes the product at /product/starbillions-1-28″-tft/ on disk while the
  // HTML links to it as %E2%80%B3. Keying one against the other silently loses most of
  // the join, which is exactly what the first run did.
  const categoryHtml = `<h1 class="page-title">串口屏</h1>
    <p class="woocommerce-result-count">x</p>
    <ul class="products"><li><a href="/product/starbillions-1-28%E2%80%B3-tft-xby128fhd/">round</a></li></ul>`;

  const membership = categoryMembership([{ html: categoryHtml, urlPath: '/product-category/x/' }]);
  assert.ok(membership.has('/product/starbillions-1-28″-tft-xby128fhd/'), 'decoded key');
});

test('menu labels join to the products in their panel', () => {
  const nav = `<ul id="menu-categories">
    <li id="menu-item-1"><a><span class="nav-link-text">圆形&amp;长条形显示屏</span></a>
      <div class="wd-dropdown-menu"><ul class="products"><li><a href="/product/round-one/">a</a></li></ul></div>
    </li>
    <li id="menu-item-2"><a><span class="nav-link-text">串口屏</span></a>
      <div class="wd-dropdown-menu"><ul class="products"><li><a href="/product/serial-one/">b</a></li></ul></div>
    </li>
  </ul>`;

  const membership = menuMembership(nav);
  assert.deepEqual(membership.get('/product/round-one/'), ['圆形&长条形显示屏']);
  assert.deepEqual(membership.get('/product/serial-one/'), ['串口屏']);
});

/* ---- ranking, which is what the visitor judges ---------------------------------- */

const entries = [
  { url: '/product/a/', lang: 'zh', title: 'Starbillions 3.5″ TFT XBY35FHD', sku: '', categories: ['串口屏'], image: '', text: normalise('Starbillions 3.5″ TFT XBY35FHD 串口屏 分辨率 480*480 接口 MIPI') },
  { url: '/product/b/', lang: 'zh', title: 'Round display 2.1″', sku: '', categories: ['圆形&长条形显示屏'], image: '', text: normalise('Round display 2.1″ 产品尺寸 2.1"TFT round display') },
  { url: '/en/product/a/', lang: 'en', title: 'Starbillions 3.5″ TFT XBY35FHD', sku: '', categories: ['serial screen'], image: '', text: normalise('Starbillions 3.5″ TFT XBY35FHD serial screen') },
];

test('a title match outranks a spec-only match for the same query', () => {
  const inTitle = score({ title: 'Starbillions 3.5″ TFT', sku: '', categories: [], text: normalise('Starbillions 3.5″ TFT') }, '3.5');
  const inSpecs = score({ title: 'Round display', sku: '', categories: [], text: normalise('Round display 分辨率 3.5 inch') }, '3.5');

  assert.ok(inTitle > inSpecs, `title ${inTitle} should beat specs ${inSpecs}`);

  // The site's known content defect: every product page states 产品尺寸 as 2.1", so a
  // bare 2.1 matches all of them. Ranking must put the products named 2.1 first rather
  // than present the whole catalogue as equally relevant.
  const hits = search(entries, '2.1', { lang: 'zh' });
  assert.deepEqual(hits.map((hit) => hit.entry.url), ['/product/b/']);
});

test('multi-word queries narrow rather than widen', () => {
  assert.equal(search(entries, '3.5 mipi', { lang: 'zh' }).length, 1);
  assert.equal(search(entries, '3.5 不存在', { lang: 'zh' }).length, 0, 'one absent term disqualifies the entry');
});

test('search only returns the language the page is in', () => {
  assert.deepEqual(search(entries, '3.5', { lang: 'en' }).map((hit) => hit.entry.url), ['/en/product/a/']);
  assert.deepEqual(search(entries, '3.5', { lang: 'zh' }).map((hit) => hit.entry.url), ['/product/a/']);
});

test('queries under two characters return nothing', () => {
  assert.equal(search(entries, '3', { lang: 'zh' }).length, 0);
});

test('highlight splits the title around the match', () => {
  assert.deepEqual(highlight('Starbillions 3.5″ TFT', '3.5'), [
    { text: 'Starbillions ', hit: false },
    { text: '3.5', hit: true },
    { text: '″ TFT', hit: false },
  ]);
  assert.deepEqual(highlight('Round display', 'zzz'), [{ text: 'Round display', hit: false }]);

  // The prime in a product title is folded to a space by normalise, so locating matches
  // in the normalised text would underline one character early for anything after it.
  assert.deepEqual(highlight('Starbillions 1.28″ round TFT', 'round'), [
    { text: 'Starbillions 1.28″ ', hit: false },
    { text: 'round', hit: true },
    { text: ' TFT', hit: false },
  ]);
});

test('the result list is capped, and the cap is what the view-all link keys on', () => {
  const many = Array.from({ length: LIMIT + 5 }, (_, i) => ({
    url: `/product/p${i}/`, lang: 'zh', title: `Product ${i}`, sku: '', categories: [], image: '', text: normalise(`Product ${i}`),
  }));

  assert.equal(search(many, 'product', { lang: 'zh' }).length, LIMIT);
});
