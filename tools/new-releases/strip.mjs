/**
 * tools/new-releases/strip.mjs
 *
 * Inserts a new-release product strip into the two archive surfaces the
 * owner named: the site's front page and the 产品中心 listing, each in both
 * languages. Without this the 64 new pages are reachable from the sitemap,
 * the search dropdown, and a direct URL, but nothing on the site links to
 * them, which is not "published" in the sense a buyer would use.
 *
 * Design of the insertion, and why it is a strip not a mixed grid:
 *
 *   - The mirror's own card grid is server-rendered from the cached pages
 *     and each card links to an existing product. Interleaving new-release
 *     cards into the same `<ul>` would change the card count the mirror's
 *     gate asserts on ("no page gained or lost a product card on the way"),
 *     which is a deletion-safety rule and should stay a deletion-safety
 *     rule. Mixing content types under it hides regressions on both sides.
 *
 *   - The strip is a sibling `<section>` before the footer, using the same
 *     `.wd-entities-title` heading class and a modified card markup. Cards
 *     carry `class="product-grid-item wd-new-release-card"` - the theme's
 *     `product-grid-item` selector still reaches them, so the visual shape
 *     matches the rest of the archive. The `wd-new-release-card` suffix is
 *     what `check.mjs` uses to subtract these cards from its count, so the
 *     gate sees "the mirror's own cards" and asserts against the cached
 *     page, and a separate gate asserts the strip card count against the
 *     new-release data.
 *
 *   - Anchor for insertion is `<footer`, the same boundary `render.mjs`
 *     uses. It is on every page, unique within a page, and appears after
 *     every content block Elementor authored. Inserting before it puts the
 *     strip at the visual bottom without editing Elementor markup.
 *
 *   - Six cards is a preview, not a full listing. Sixteen would push the
 *     existing content so far up the page that a returning visitor would
 *     not recognise it; four would look arbitrary. The "view all" link
 *     goes to `/product-category/新品发布/`, which carries all 64.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../lib/paths.js';

export const STRIP_CARDS = 6;

const STRIP_CLASS = 'wd-new-release-strip';
const CARD_CLASS = 'product-grid-item wd-new-release-card';

const LABELS = {
  zh: { heading: '新品发布', more: '查看全部', moreAria: '查看新品发布全部产品' },
  en: { heading: 'New Releases', more: 'View all', moreAria: 'View all new releases' },
};

/**
 * Insert the strip into each of the four target pages.
 *
 * Idempotent: an existing strip is replaced rather than duplicated, so
 * running the whole build twice in a row leaves the file the same. That is
 * what makes the pipeline safe to iterate on while the render is still
 * changing shape.
 */
export function insertStrips(rendered) {
  if (rendered.length === 0) return { inserted: 0 };

  const targets = [
    { file: join(paths.dist, 'index.html'), lang: 'zh' },
    { file: join(paths.dist, 'en/index.html'), lang: 'en' },
    { file: join(paths.dist, '产品中心/index.html'), lang: 'zh' },
    { file: join(paths.dist, 'en/产品中心/index.html'), lang: 'en' },
  ];

  let inserted = 0;
  for (const target of targets) {
    if (!existsSync(target.file)) continue;

    const html = readFileSync(target.file, 'utf8');
    const stripped = removeExistingStrip(html);
    if (stripped === null) continue;

    const strip = buildStrip(rendered.slice(0, STRIP_CARDS), target.lang);
    const at = stripped.indexOf('<footer');
    if (at === -1) continue;

    writeFileSync(target.file, stripped.slice(0, at) + strip + '\n' + stripped.slice(at), 'utf8');
    inserted += 1;
  }
  return { inserted };
}

/**
 * The most recently built `rendered` order is the alphabetical folder order
 * from `data/new-products.json`, which the scanner sorted by leading number.
 * The strip therefore shows `new-01` through `new-06` - small panels first,
 * because that is where the site's existing 34 products already sit. Owner
 * can reverse by flipping the slice here when a "newest first" ordering
 * matches the release cadence better.
 */
function buildStrip(rendered, lang) {
  const L = LABELS[lang];
  const categoryPath = lang === 'zh' ? '/product-category/新品发布/' : '/en/product-category/新品发布/';

  const cards = rendered.map((r) => cardMarkup(r, lang)).join('\n');
  const heroImageForFallback = '';

  return `<section class="elementor-section elementor-top-section elementor-element elementor-section-boxed ${STRIP_CLASS}" data-id="new-release-strip" data-element_type="section" data-new-release-strip>
  <div class="elementor-container elementor-column-gap-default">
    <div class="elementor-column elementor-col-100 elementor-top-column elementor-element">
      <div class="elementor-widget-wrap elementor-element-populated">
        <div class="elementor-element elementor-widget elementor-widget-heading">
          <div class="elementor-widget-container">
            <h2 class="wd-entities-title">${escapeHtml(L.heading)}</h2>
          </div>
        </div>
        <div class="elementor-element elementor-widget elementor-widget-wd_products">
          <div class="elementor-widget-container">
            <ul class="products columns-${Math.min(rendered.length, 6)}">
${cards}
            </ul>
            <p class="wd-new-release-more"><a href="${categoryPath}" aria-label="${escapeHtml(L.moreAria)}">${escapeHtml(L.more)} &rarr;</a></p>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>`.replace(heroImageForFallback, '');
}

function cardMarkup(r, lang) {
  const title = lang === 'zh' ? r.title.zh : r.title.en;
  const url = lang === 'zh' ? r.url : r.urlEn;
  const hero = r.media.hero ?? '';
  const size = r.specs.sizeInch !== null ? `${r.specs.sizeInch}"` : '';
  const resolution = r.specs.resolution ?? '';
  const meta = [size, resolution].filter(Boolean).join(' · ');

  return `      <li class="${CARD_CLASS} type-product status-publish">
        <a href="${url}">
          <div class="product-detail-wrapper">
            <figure class="product-media"><img src="${hero}" alt="${escapeHtml(title)}" /></figure>
            <div class="wd-product-item-info">
              <span class="wd-entities-title">${escapeHtml(title)}</span>
              <span class="wd-new-release-card-meta">${escapeHtml(meta)}</span>
            </div>
          </div>
        </a>
      </li>`;
}

/**
 * Remove any previously-inserted strip so re-running is idempotent.
 *
 * Anchored by `<section ... data-new-release-strip>` and matched up to the
 * closing `</section>` at the same indent level. Regex is safe here because
 * the markup is fully written by this file - there are no nested sections
 * with the same marker, and Elementor's own sections do not carry
 * `data-new-release-strip`.
 */
function removeExistingStrip(html) {
  const re = /<section\b[^>]*data-new-release-strip[^>]*>[\s\S]*?<\/section>\s*/;
  return html.replace(re, '');
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
