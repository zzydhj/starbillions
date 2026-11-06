/**
 * Builds the static search index from the mirror's own rendered product pages.
 *
 *   import { extractProduct, buildSearchIndex } from './search-index.js'
 *
 * The source of truth is the rendered HTML, not data/wp-products.json. That file came
 * out of the SQL dump with empty sku and price fields (the origin runs YITH catalog
 * mode, which hides prices), while the page itself carries the title, the breadcrumb
 * category and the full attribute table - which is precisely what a visitor would want
 * to search by: "3.5", "HDMI", "串口屏", "XBY035MGA310". Indexing the database copy
 * would have produced an index missing the most useful text, and the omission would
 * only show up when someone searched and got nothing.
 *
 * Both languages are indexed as separate entries because the mirror ships separate
 * pages: the English page's title and specs are not the Chinese ones, and a search box
 * on /en/ must not answer with a page the visitor cannot read.
 */

// The same normalisation the browser will apply to the query. Imported from the runtime
// rather than duplicated here: if the two drifted apart, the index would be built one
// way and searched another, and every entry whose text changed shape would silently
// stop matching.
import { normalise } from '../../../public/site-search.js';

/**
 * Pull one product out of its own page.
 *
 * Returns null when the page has no product title: the mirror's product URLs are
 * discovered by path, and a path can outlive its content (an archived or empty listing
 * still renders), so the title is the thing that says "this page is a product".
 */
export function extractProduct({ html, urlPath, lang }) {
  const title = textOf(html, /<h1\b[^>]*class="[^"]*\bproduct_title\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  if (!title) return null;

  const sku = textOf(html, /<mark\b[^>]*class="sku"[^>]*>([\s\S]*?)<\/mark>/i) ?? '';
  const categories = categoryList(html);
  const specs = specRows(html);
  const summary = textOf(
    html,
    /<div\b[^>]*class="[^"]*woocommerce-product-details__short-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ) ?? '';
  const image = productImage(html);

  // The haystack is what scoring reads. Keeping it a single normalised string means the
  // runtime never has to walk fields, and the field weights below are the only place the
  // ranking policy lives.
  const fields = {
    title,
    sku,
    categories: categories.join(' '),
    specs: specs.map((row) => `${row.name} ${row.value}`).join(' '),
    summary,
  };

  return {
    url: urlPath,
    lang,
    title,
    sku,
    categories,
    image,
    specs,
    fields,
  };
}

/**
 * The attribute table WooCommerce prints under the gallery.
 *
 * Rows are th/td pairs; the th holds the attribute name (产品尺寸, 分辨率, 接口类型...)
 * and the td the value. Values contain links and markup for variable products, so they
 * are flattened to text.
 */
export function specRows(html) {
  const table = /<table\b[^>]*class="[^"]*shop_attributes[^"]*"[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  if (!table) return [];

  const rows = [];
  for (const match of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const name = flatten(match[1].match(/<th\b[^>]*>([\s\S]*?)<\/th>/i)?.[1]);
    const value = flatten(match[1].match(/<td\b[^>]*>([\s\S]*?)<\/td>/i)?.[1]);
    if (name && value) rows.push({ name, value });
  }

  return rows;
}

/**
 * Category names from the breadcrumb, which is the only place the rendered page states
 * them: the theme's "posted_in" line is switched off for products on this site.
 *
 * The trail reads 首页 > 1.28 inch LCD display > product title, so everything after the
 * home crumb and before the product itself is a category.
 */
export function categoryList(html) {
  const crumb = /<nav\b[^>]*class="[^"]*woocommerce-breadcrumb[^"]*"[^>]*>([\s\S]*?)<\/nav>/i.exec(html)?.[1];
  if (!crumb) return [];

  const home = /^(首页|home)$/i;
  const links = crumb.match(/<a\b[^>]*>([\s\S]*?)<\/a>/gi) ?? [];

  return links
    .map(flatten)
    .filter((label) => label && !home.test(label));
}

/**
 * The first gallery image, as the mirror wrote it.
 *
 * Woodmart defers its gallery images, so the real path sits in data-wood-src while src
 * is a 1x1 placeholder. Reading src would have indexed the placeholder and every search
 * result would have shown the same blank thumbnail.
 */
export function productImage(html) {
  const gallery = /class="[^"]*woocommerce-product-gallery__image[^"]*"[\s\S]{0,1200}?<img\b([\s\S]*?)>/i.exec(html)?.[1];
  const candidates = [
    gallery && /data-wood-src="([^"]+)"/i.exec(gallery)?.[1],
    gallery && /data-lazy-src="([^"]+)"/i.exec(gallery)?.[1],
    gallery && /(?<!data-)src="([^"]+)"/i.exec(gallery)?.[1],
    /property="og:image"\s+content="([^"]+)"/i.exec(html)?.[1],
  ];

  return candidates.find((value) => value && !/lazy\.png|data:image/.test(value)) ?? '';
}

/**
 * Which categories each product page belongs to, read from the category archives.
 *
 * A product page states its category only as the English term title in the breadcrumb
 * ("1.28 inch LCD display"). The words a customer actually types - 串口屏, 转接板,
 * 圆形&长条形显示屏 - are the Chinese term names, and they appear nowhere on the product
 * page: they live on the category archive pages that list the product. Without this
 * join, searching 圆形 on the Chinese site returns nothing at all, which looks like a
 * broken search box rather than a gap in what was indexed.
 *
 * Keyed by the product's own URL, so a result never points at the other language's
 * page. Note what that does and does not guarantee: the *labels* cross over, because
 * some WooCommerce term names on this site are Chinese even on the English pages
 * (TranslatePress does not translate term names). Measured on the built index, 11 of
 * the 34 English entries carry a Chinese category label, so searching 串口屏 on /en/
 * returns six English product pages. That is the site's own data, and it helps rather
 * than harms: a buyer typing the word they saw in the menu gets results in the language
 * they are reading.
 */
export function categoryMembership(categoryPages) {
  const membership = new Map();

  for (const page of categoryPages) {
    const title = textOf(page.html, /<h1\b[^>]*class="[^"]*page-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
      ?? textOf(page.html, /<title>([\s\S]*?)<\/title>/i)?.split(/[\u2013\u2014|-]/)[0]?.trim();
    if (!title) continue;

    for (const match of productLoop(page.html).matchAll(/href="(\/(?:en\/)?product\/[^"?#]+?)\/?"/gi)) {
      const url = productKey(match[1]);
      const list = membership.get(url) ?? [];
      if (!list.includes(title)) list.push(title);
      membership.set(url, list);
    }
  }

  return membership;
}

/**
 * The product list a category page actually renders, and nothing else.
 *
 * A category with four products contains 144 product links, because every category
 * page also carries the site header, and the header's mega menu panels hold products
 * from across the catalogue. Scanning the whole document therefore tells you that
 * 串口屏 contains the round displays - which is how the first version of this join
 * turned a four-product query into forty results. The loop is found by starting at the
 * result count line WooCommerce prints above it and stopping at the footer, then taking
 * the first products list inside that region.
 */
export function productLoop(html) {
  const from = Math.max(html.search(/woocommerce-result-count/i), 0);
  const footer = html.search(/<footer\b/i);
  const region = html.slice(from, footer > from ? footer : html.length);

  const start = region.search(/<ul[^>]*class="[^"]*\bproducts\b[^"]*"/i);
  if (start === -1) return region;

  return region.slice(start, matchingClose(region, start, 'ul'));
}

/**
 * Which products each navigation label covers, read from the mega menu.
 *
 * Category archives give the term names (串口屏, 转接板) but not the groupings a human
 * put in the menu: 圆形&长条形显示屏 is a menu label, and no term is named that, so the
 * round displays are reachable by that word only through the navigation that presents
 * them. Customers read the menu, not the taxonomy table.
 *
 * The categories menu is nested several levels deep, so it is located by matching its
 * own <ul> open and close rather than by a lazy regex, which would stop at the first
 * nested list and silently index two items instead of ten.
 */
export function menuMembership(html) {
  const start = html.search(/<ul[^>]*id="menu-categories"/i);
  if (start === -1) return new Map();

  const end = matchingClose(html, start, 'ul');
  const menu = html.slice(start, end);
  const membership = new Map();

  // Each top-level entry starts at its own <li>; product lists inside a panel are
  // <li class="product-grid-item">, so splitting on menu-item ids keeps the groups
  // apart without needing to parse the nesting.
  for (const chunk of menu.split(/<li id="menu-item-/).slice(1)) {
    const label = flatten(/<span class="nav-link-text">([\s\S]*?)<\/span>/.exec(chunk)?.[1] ?? '');
    if (label.length < 2) continue;

    for (const match of chunk.matchAll(/href="(\/(?:en\/)?product\/[^"?#]+?)\/?"/gi)) {
      const url = productKey(match[1]);
      const list = membership.get(url) ?? [];
      if (!list.includes(label)) list.push(label);
      membership.set(url, list);
    }
  }

  return membership;
}

/**
 * The lookup key for a product, shared by both joins and by the page list.
 *
 * Links in the HTML are percent-encoded (/product/starbillions-1-28%E2%80%B3-tft-...)
 * while the mirror's files sit on disk under the decoded name (…1-28″-tft-…). Keying
 * one against the other matches almost nothing and, worse, looks like a working index
 * with a few odd gaps - which is exactly what the first run of this produced: eight
 * round displays indexed under 圆形&长条形显示屏, and one hit reported.
 */
function productKey(href) {
  let decoded;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    decoded = href;
  }

  return decoded.endsWith('/') ? decoded : `${decoded}/`;
}

/** Index just past the tag that closes the element opened at `from`. */
function matchingClose(html, from, tag) {
  const pattern = new RegExp(`<${tag}\\b|</${tag}>`, 'gi');
  let depth = 0;

  for (const match of html.matchAll(pattern)) {
    if (match.index < from) continue;
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }

  return html.length;
}

/**
 * Assemble the index: one entry per product page per language, with the searchable
 * text pre-normalised so the browser does no stemming work at keypress time.
 *
 * `categoryPages` is optional because the join only adds labels; with it omitted the
 * index still works, just without Chinese category words.
 */
export function buildSearchIndex(pages, categoryPages = [], navHtml = '') {
  const membership = categoryMembership(categoryPages);
  const navLabels = menuMembership(navHtml);
  const entries = [];

  for (const page of pages) {
    const product = extractProduct(page);
    if (!product) continue;

    const archiveLabels = membership.get(productKey(page.urlPath)) ?? [];
    const groupLabels = navLabels.get(productKey(page.urlPath)) ?? [];
    const categories = [...new Set([...product.categories, ...archiveLabels, ...groupLabels])];

    entries.push({
      url: productKey(page.urlPath),
      lang: product.lang,
      title: product.title,
      sku: product.sku,
      categories,
      image: product.image,
      // Only the fields scoring looks at; the spec table itself is dropped to keep the
      // shipped file small - its text is already folded into `text`.
      text: normalise(
        [product.title, product.sku, categories.join(' '), ...product.specs.map((row) => `${row.name} ${row.value}`), product.summary]
          .filter(Boolean)
          .join(' '),
      ),
    });
  }

  return entries;
}

/** Strip markup, collapse whitespace, trim. */
export function flatten(fragment) {
  if (!fragment) return '';
  return fragment
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function textOf(html, pattern) {
  const match = pattern.exec(html);
  if (!match) return null;
  const value = flatten(match[1]);
  return value === '' ? null : value;
}
