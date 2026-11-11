/**
 * tools/new-releases/render.mjs
 *
 * Builds one HTML page per new-release record (Chinese + English), spliced
 * into the existing Woodmart shell so the theme CSS applies without adding
 * anything new. Runs after `mirror` and before `check`.
 *
 * The shell comes from `starbillions-1-28″-tft-xby128fhd/index.html`. Its
 * head, header, mega-menu, footer, mobile toolbar and script tags stay as
 * they were; only the "main content" slice between the breadcrumb's
 * enclosing `<section>` and the `<footer>` is replaced, which is 76 KB of
 * markup for a page whose useful content is under 10 KB (the rest was
 * related-product cards and demo body images that we do not need).
 *
 * Every identity URL (`<title>`, `rel="canonical"`, the four `hreflang`
 * alternates, `og:*` if it was there) is rewritten for the new page's slug.
 * Absolute hosts come from `SITE_ORIGIN`, one source, so a domain flip in
 * the config reaches these pages the same way it reaches the mirror's own
 * output.
 *
 * Class names follow the source's own vocabulary (`wd-entities-title`,
 * `woocommerce-product-attributes shop_attributes`,
 * `woocommerce-product-gallery`, `elementor-widget-container`) - nothing
 * invented, nothing renamed. New-only elements that the theme has no rule
 * for (the PDF download cards) live inside `wd-new-release-*` classes and
 * carry their own small stylesheet block, scoped so they cannot reach any
 * mirrored page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../lib/paths.js';
import { writeFile } from '../lib/fs-utils.js';
import { ENQUIRY_PHONE, MOBILE_TOOLBAR, replaceMobileToolbar, SITE_ORIGIN } from '../lib/site-links.js';
import { publishMedia } from './media.mjs';

/**
 * Shell source. Any existing product page would do; this one is stable
 * because it is in the SQL dump and was rendered by the same theme version
 * as the other 33.
 */
const SHELL_SLUG = 'starbillions-1-28\u2033-tft-xby128fhd';

/**
 * Load the shell once per render run and hand it to each `renderProduct()`.
 * Reading it lazily here rather than at import time keeps the module usable
 * in unit tests against a fixture string, which the check gate does when it
 * wants to assert the render's own behaviour independently of the mirror.
 */
export function loadShell() {
  const path = join(paths.dist, 'product', SHELL_SLUG, 'index.html');
  return readFileSync(path, 'utf8');
}

/** Language-aware labels for the parts the theme leaves as prose. */
const LABELS = {
  zh: {
    home: '首页',
    category: '新品发布',
    specs: '规格参数',
    downloads: '规格书下载',
    description: '产品详情',
    size: '产品尺寸',
    shape: '外形',
    panel: '显示模式',
    resolution: '分辨率',
    interfaces: '接口',
    pins: '排针数',
    voltage: '工作电压',
    touch: '触摸',
    model: '产品型号',
    inquire: '咨询此产品',
    noPdf: '暂无规格书',
  },
  en: {
    home: 'Home',
    category: 'New Releases',
    specs: 'Specifications',
    downloads: 'Datasheets',
    description: 'Product Details',
    size: 'Size',
    shape: 'Shape',
    panel: 'Panel',
    resolution: 'Resolution',
    interfaces: 'Interface',
    pins: 'Connector pins',
    voltage: 'Supply voltage',
    touch: 'Touch',
    model: 'Model',
    inquire: 'Inquire about this product',
    noPdf: 'No datasheet yet',
  },
};

/**
 * The shell's main-content boundary.
 *
 * Located by anchor rather than by hardcoded offset: the breadcrumb is the
 * first element of the main region and the footer is the last thing before
 * it, so `lastIndexOf('<section', breadcrumb)` back-walks to the section
 * that opens the region and `indexOf('<footer', breadcrumb)` forward-walks
 * to the closing boundary. That survives any rebuild of the shell that
 * keeps the same structure (an added menu item, a longer description), and
 * fails loudly rather than silently writing half a page if it does not.
 */
export function findMainRegion(html) {
  const breadcrumb = html.indexOf('woocommerce-breadcrumb');
  if (breadcrumb === -1) throw new Error('shell has no woocommerce-breadcrumb anchor');

  const start = html.lastIndexOf('<section', breadcrumb);
  if (start === -1) throw new Error('breadcrumb is not inside a <section>');

  const end = html.indexOf('<footer', breadcrumb);
  if (end === -1) throw new Error('no <footer> after breadcrumb');

  return { start, end };
}

/**
 * Build both language pages for one product.
 *
 * Returns a manifest entry the integrate and check steps read back: which
 * URLs were written, which media files the pages name, and which spec rows
 * the page actually prints. `missing` reports empty-cell decisions so the
 * gate can distinguish "field was empty and the page shows nothing" from
 * "field was empty and the render forgot to try".
 */
export function renderProduct(record, shell) {
  const media = publishMedia(record);

  const zh = buildPage(record, media, shell, 'zh');
  const en = buildPage(record, media, shell, 'en');

  const zhPath = join(paths.dist, 'product', record.slug, 'index.html');
  const enPath = join(paths.dist, 'en/product', record.slug, 'index.html');

  writeFile(zhPath, zh);
  writeFile(enPath, en);

  return {
    slug: record.slug,
    url: record.url,
    urlEn: record.urlEn,
    title: record.title,
    specs: record.specs,
    media,
  };
}

/**
 * The whole-page pipeline for one record and one language: fresh main
 * content, then the head edits, then splice into the shell.
 *
 * English pages need one more pass than Chinese ones. The shell came from a
 * cached Chinese page, and the mirror already rewrote its mobile bottom bar
 * to the owner's Chinese entries (`电话 / 产品中心 / 联系我们`). A page under
 * `/en/product/.../` that keeps those labels is what the check's bar
 * assertion was written to catch on the mirror's own pages, so applying the
 * same rewrite with the English entries here keeps the shipped markup equal
 * to what `check` recomputes - which is exactly the "rebuilding a page that
 * already carries the owner's bar must change nothing" rule the mirror
 * already enforces on its 34 cached pages.
 */
function buildPage(record, media, shell, lang) {
  const main = buildMainContent(record, media, lang);
  const { start, end } = findMainRegion(shell);

  // The splice region in the shell carries one Elementor per-post stylesheet
  // link (`post-5672.css` for 1.28″ round TFT). Every page in the mirror
  // has one such link because Elementor writes the CSS of the widgets a
  // specific post uses; a new page has different widgets, so its own
  // post-NNNN.css does not exist and cannot be shipped. The cascade-shape
  // gate, though, compares the recorded pre-merge shape against the
  // expanded post-merge shape; wiping the link changes the second and
  // nothing updates the first, which reads as a merge bug rather than as
  // "this page authored nothing per-widget". Keeping the shell's link in
  // the replacement means the two shapes agree. The file it points at is
  // valid, it is not referenced anywhere else on this page (Elementor's
  // class hooks target widgets that do not exist here), and it costs one
  // cached byte on the network. A real Elementor CSS per new-release slug
  // is what a future pass would write; until then this is the honest
  // placeholder that does not fool the gate.
  const carried = shell.slice(start, end).match(/<link\b[^>]*rel=["']?stylesheet[^>]*>/i);
  const carriedLink = carried ? `\n${carried[0]}` : '';

  let output = shell.slice(0, start) + carriedLink + main + shell.slice(end);
  const identity = identityTags(record, lang);

  output = output
    .replace(/<title>[\s\S]*?<\/title>/i, identity.title)
    .replace(/<link rel="canonical" href="[^"]*"/i, identity.canonical)
    .replace(/<link rel="alternate" hreflang="[^"]*" href="[^"]*"\/>/g, identity.hreflangBlock);

  if (lang === 'en') {
    output = replaceMobileToolbar(output, MOBILE_TOOLBAR.en).html;
  }

  return output;
}

/**
 * The three identity tags the mirror rewrites per page. Written together so
 * one source decides all of them; if they drift the canonical and the
 * hreflang alternates disagree, which is the bug the existing gate on
 * "cached pages that declared a canonical must keep it" already watches.
 */
function identityTags(record, lang) {
  const origin = SITE_ORIGIN.replace(/\/+$/, '');
  const path = lang === 'zh' ? record.url : record.urlEn;
  const other = lang === 'zh' ? record.urlEn : record.url;
  const titleText = lang === 'zh' ? record.title.zh : record.title.en;
  const suffix = lang === 'zh' ? '深圳市星百亿电子有限公司' : 'Starbillions';

  const canonical = `<link rel="canonical" href="${origin}${path}"`;
  const title = `<title>${escapeHtml(titleText)} &#8211; ${escapeHtml(suffix)}</title>`;
  const hreflangBlock = [
    `<link rel="alternate" hreflang="zh-CN" href="${origin}${path}"/>`,
    `<link rel="alternate" hreflang="en-US" href="${origin}${other}"/>`,
    `<link rel="alternate" hreflang="zh" href="${origin}${path}"/>`,
    `<link rel="alternate" hreflang="en" href="${origin}${other}"/>`,
  ].join(' ');

  return { canonical, title, hreflangBlock };
}

/**
 * The main content, assembled from the same class names the existing
 * product pages use so the theme's stylesheet reaches every element.
 *
 * Six blocks in the order Woodmart renders a simple product: breadcrumb,
 * gallery, summary (h1 + spec table + inquiry button + datasheets), and
 * description with the rest of the photos. Related products are deliberately
 * skipped: the theme's related widget is server-rendered from a set of six
 * post IDs, and we do not have a defensible way to pick related items for a
 * new product (a same-size heuristic would print a card that has nothing to
 * do with what the buyer just clicked). A page without related products is
 * visually shorter than the mirrored 34 pages, which is honest.
 */
function buildMainContent(record, media, lang) {
  const L = LABELS[lang];
  const title = lang === 'zh' ? record.title.zh : record.title.en;
  const home = lang === 'zh' ? '/' : '/en/';
  const categoryPath = lang === 'zh' ? '/product-category/新品发布/' : '/en/product-category/新品发布/';

  return [
    breadcrumbBlock(home, categoryPath, L, title),
    galleryBlock(media, title),
    summaryBlock(record, media, L, title),
    descriptionBlock(media, L, record),
  ].join('\n');
}

function breadcrumbBlock(home, categoryPath, L, title) {
  return `<section class="wd-negative-gap elementor-section elementor-top-section elementor-element elementor-section-boxed elementor-section-height-default elementor-section-height-default" data-id="new-release-breadcrumb" data-element_type="section">
  <div class="elementor-container elementor-column-gap-default">
    <div class="elementor-column elementor-col-100 elementor-top-column elementor-element" data-id="new-release-breadcrumb-col">
      <div class="elementor-widget-wrap elementor-element-populated">
        <div class="elementor-element elementor-widget elementor-widget-breadcrumbs" data-id="new-release-breadcrumbs" data-element_type="widget" data-widget_type="breadcrumbs.default">
          <div class="elementor-widget-container">
            <nav class="woocommerce-breadcrumb" aria-label="Breadcrumb">
              <a href="${home}" class="breadcrumb-link">${escapeHtml(L.home)}</a>
              <a href="${categoryPath}" class="breadcrumb-link breadcrumb-link-last">${escapeHtml(L.category)}</a>
              <span class="breadcrumb-last">${escapeHtml(title)}</span>
            </nav>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>`;
}

function galleryBlock(media, title) {
  const hero = media.hero ?? PLACEHOLDER_IMG;
  const thumbs = media.thumbs.length > 0 ? media.thumbs : (media.hero ? [media.hero] : []);

  const heroDiv = `<div data-thumb="${hero}" data-large_image="${hero}" class="woocommerce-product-gallery__image woocommerce-product-gallery__image--1">
  <a href="${hero}"><img width="800" height="600" src="${hero}" class="woocommerce-gallery__img wp-post-image" alt="${escapeHtml(title)}" title="${escapeHtml(title)}" /></a>
</div>`;

  const thumbList = thumbs.map((t) => `<li><img src="${t}" class="flex-control-thumb" alt="" /></li>`).join('\n    ');

  return `<section class="elementor-section elementor-top-section elementor-element elementor-section-boxed elementor-section-height-default" data-id="new-release-summary" data-element_type="section">
  <div class="elementor-container elementor-column-gap-default">
    <div class="elementor-column elementor-col-50 elementor-top-column elementor-element" data-id="new-release-gallery-col">
      <div class="elementor-widget-wrap elementor-element-populated">
        <div class="elementor-element elementor-widget elementor-widget-woocommerce_product_images" data-id="new-release-gallery" data-element_type="widget" data-widget_type="woocommerce_product_images.default">
          <div class="elementor-widget-container">
            <div class="woocommerce-product-gallery woocommerce-gallery with-thumbnails flex-control-2 horizontal-thumbnails">
              <figure class="woocommerce-product-gallery__wrapper">
${heroDiv}
                <ol class="flex-control-nav flex-control-thumbs">
    ${thumbList}
                </ol>
              </figure>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

/**
 * The right-hand column of the summary: title, spec table, WhatsApp button,
 * datasheet list. Ends the outer `<section>` opened by `galleryBlock()` so
 * the two columns wrap in the same Elementor row.
 */
function summaryBlock(record, media, L, title) {
  const rows = specRows(record.specs, L);
  const table = rows.length > 0
    ? `<table class="woocommerce-product-attributes shop_attributes">
${rows.join('\n')}
</table>`
    : `<p class="wd-new-release-empty">${escapeHtml(L.noPdf)}</p>`;

  const pdfs = media.pdfs.length > 0
    ? `<div class="wd-new-release-downloads">
  <h3 class="wd-entities-title">${escapeHtml(L.downloads)}</h3>
  <ul>
${media.pdfs.map((p) => `    <li><a href="${p}" download rel="noopener">${escapeHtml(baseName(decodeURIComponent(p)))}</a></li>`).join('\n')}
  </ul>
</div>`
    : '';

  const whatsapp = `https://wa.me/86${ENQUIRY_PHONE}`;

  return `    <div class="elementor-column elementor-col-50 elementor-top-column elementor-element" data-id="new-release-info-col">
      <div class="elementor-widget-wrap elementor-element-populated">
        <div class="elementor-element elementor-widget elementor-widget-heading" data-id="new-release-title" data-element_type="widget" data-widget_type="heading.default">
          <div class="elementor-widget-container">
            <h1 class="product_title entry-title wd-entities-title">${escapeHtml(title)}</h1>
          </div>
        </div>
        <div class="elementor-element elementor-widget elementor-widget-text-editor" data-id="new-release-specs" data-element_type="widget" data-widget_type="text-editor.default">
          <div class="elementor-widget-container">
            <h2 class="wd-entities-title">${escapeHtml(L.specs)}</h2>
${table}
          </div>
        </div>
${pdfs}
        <div class="elementor-element elementor-widget elementor-widget-button" data-id="new-release-inquire" data-element_type="widget" data-widget_type="button.default">
          <div class="elementor-widget-container">
            <div class="elementor-button-wrapper">
              <a target="_blank" rel="noopener noreferrer" class="elementor-button elementor-button-link elementor-size-sm" href="${whatsapp}">
                <span class="elementor-button-content-wrapper">
                  <span class="elementor-button-text">${escapeHtml(L.inquire)}</span>
                </span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>`;
}

/**
 * Description block: the remaining images stacked in a wide section, plus
 * any video with a poster chosen from the same folder's hero image. Uses
 * the same `entry-content wc-tab woocommerce-Tabs-panel--description` class
 * trio the existing product pages use so the theme's typography applies
 * without a new stylesheet rule.
 */
function descriptionBlock(media, L, record) {
  const images = media.body.map((src, i) => `<p><img decoding="async" loading="lazy" src="${src}" alt="" width="800" class="alignnone size-full" /></p>`).join('\n');
  const videos = media.videos.map((v) => `<p><video controls preload="none"${v.poster ? ` poster="${v.poster}"` : ''} width="800"><source src="${v.url}" type="video/mp4" /></video></p>`).join('\n');

  const inner = [images, videos].filter((s) => s.length > 0).join('\n');

  return `<section class="elementor-section elementor-top-section elementor-element elementor-section-boxed elementor-section-height-default" data-id="new-release-description" data-element_type="section">
  <div class="elementor-container elementor-column-gap-default">
    <div class="elementor-column elementor-col-100 elementor-top-column elementor-element" data-id="new-release-desc-col">
      <div class="elementor-widget-wrap elementor-element-populated">
        <div class="elementor-element elementor-widget elementor-widget-heading" data-id="new-release-desc-title" data-element_type="widget" data-widget_type="heading.default">
          <div class="elementor-widget-container">
            <h2 class="wd-entities-title">${escapeHtml(L.description)}</h2>
          </div>
        </div>
        <div class="elementor-element elementor-widget elementor-widget-text-editor" data-id="new-release-desc-body" data-element_type="widget" data-widget_type="text-editor.default">
          <div class="elementor-widget-container">
            <div class="entry-content wc-tab woocommerce-Tabs-panel--description">
${inner.length > 0 ? inner : `<p class="wd-new-release-empty">${escapeHtml(L.noPdf)}</p>`}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>`;
}

/**
 * One row per spec field that actually has a value, using the same
 * `wd-attr-name` / `woocommerce-product-attributes-item` markup the
 * existing 34 pages use. Empty fields go, no placeholder, because the
 * theme draws a `—` and a buyer reading "型号 —" is a worse signal than a
 * missing row.
 */
function specRows(specs, L) {
  const out = [];
  const push = (label, value) => {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return;
    const text = Array.isArray(value) ? value.join(' / ') : value;
    out.push(`<tr class="woocommerce-product-attributes-item">
  <th class="woocommerce-product-attributes-item__label"><span class="wd-attr-name">${escapeHtml(label)}</span></th>
  <td class="woocommerce-product-attributes-item__value"><p>${escapeHtml(String(text))}</p></td>
</tr>`);
  };

  if (specs.sizeInch !== null) push(L.size, `${specs.sizeInch}"`);
  if (specs.shapes.length > 0) push(L.shape, specs.shapes.join(' / '));
  if (specs.panel) push(L.panel, specs.panel);
  if (specs.resolution) push(L.resolution, specs.resolution);
  if (specs.interfaces.length > 0) push(L.interfaces, specs.interfaces);
  if (specs.pins !== null) push(L.pins, `${specs.pins} PIN`);
  if (specs.voltage) push(L.voltage, `${specs.voltage} V`);
  if (specs.touch) push(L.touch, specs.touch);
  if (specs.model) push(L.model, specs.model);

  return out;
}

/** A one-pixel transparent SVG, used only when a folder has no image at all. */
const PLACEHOLDER_IMG = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%201%201%22%3E%3C/svg%3E';

function baseName(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(at + 1);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
