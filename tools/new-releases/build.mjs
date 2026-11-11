/**
 * tools/new-releases/build.mjs
 *
 * Runs the whole new-release pipeline in one command after the mirror has
 * finished. Called from `npm run products`, wired in as a step of
 * `npm run verify` between `mirror` and `check`:
 *
 *   mirror   -> the 137 cached pages land in dist/, sitemap.xml is written
 *   products -> this file: 64 built pages x2 langs, category listing, media,
 *               plus appends to sitemap.xml and search.json
 *   check    -> reads the combined tree, gates both the mirror's own
 *               assertions and the six new-release assertions
 *
 * Kept out of `mirror.mjs` because mirror is already 850 lines and its job
 * is to reproduce a backup faithfully. This file does the opposite: it
 * authors pages that never existed in the backup. Mixing the two makes it
 * impossible to tell later whether a piece of output is "the site as it was"
 * or "the site as the owner wants it now".
 *
 * Idempotent: the whole `new-*` page tree and `uploads/new-releases/` are
 * wiped and rewritten every run, so a folder rename in the source produces
 * a clean move rather than two pages pointing at the same content. The
 * wipe is scoped strictly to the `new-` slug prefix - the mirrored 34
 * product pages are never touched.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../lib/paths.js';
import { removeTree, writeFile } from '../lib/fs-utils.js';
import { MOBILE_TOOLBAR, replaceMobileToolbar, SITE_ORIGIN } from '../lib/site-links.js';
import { loadShell, renderProduct } from './render.mjs';
import { convertNewReleaseImages } from './webp.mjs';
import { insertStrips } from './strip.mjs';

const SLUG_PREFIX = 'new-';
const CATEGORY_SLUG = '新品发布';

export function buildAll() {
  const records = readJson(join(paths.data, 'new-products.json'));
  const built = records.filter((r) => !r.skip);
  const skipped = records.length - built.length;

  wipePrevious();

  const shell = loadShell();
  const rendered = built.map((record) => renderProduct(record, shell));

  const category = buildCategoryListing(rendered);

  appendToSitemap(rendered, category);
  appendToSearchIndex(rendered);
  recordCascades(rendered, category);

  return { built: rendered.length, skipped, category, rendered };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Remove the previous run's output before writing new pages.
 *
 * Deleting is scoped to (1) every `dist/uploads/new-releases/` byte, (2)
 * every `dist/product/new-*` and `dist/en/product/new-*` directory, and (3)
 * the two category listing files. Nothing outside the `new-` prefix can be
 * caught by this: a typo in the prefix would take out every mirror page in
 * one shot, so the check is literal, not "starts with something like".
 */
function wipePrevious() {
  const mediaRoot = join(paths.dist, 'uploads/new-releases');
  if (existsSync(mediaRoot)) removeTree(mediaRoot);

  for (const dir of [join(paths.dist, 'product'), join(paths.dist, 'en/product')]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(SLUG_PREFIX)) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  }

  for (const cat of [
    join(paths.dist, 'product-category', CATEGORY_SLUG),
    join(paths.dist, 'en/product-category', CATEGORY_SLUG),
  ]) {
    if (existsSync(cat)) removeTree(cat);
  }
}

/**
 * Category listing: one page holding every new-release product card.
 *
 * The card markup copies Woodmart's `.product-grid-item.产品卡` shape from
 * the existing category pages, so the theme's grid + hover rules fire on the
 * new cards without any new CSS. The section is inserted into the shell's
 * main region the same way product pages do it - breadcrumb first, then a
 * heading, then the grid.
 *
 * Sixty-four cards on one page is well within what the mirror already
 * renders (each of the 24 existing category pages ships 4-14 cards; the
 * shop page ships all 34 at once), so there is no reason to paginate.
 */
function buildCategoryListing(rendered) {
  const shell = loadShell();

  const cards = rendered.map((r) => productCard(r)).join('\n');
  const listing = `<section class="elementor-section elementor-top-section elementor-element elementor-section-boxed" data-id="new-release-category" data-element_type="section">
  <div class="elementor-container elementor-column-gap-default">
    <div class="elementor-column elementor-col-100 elementor-top-column elementor-element">
      <div class="elementor-widget-wrap elementor-element-populated">
        <div class="elementor-element elementor-widget elementor-widget-heading">
          <div class="elementor-widget-container">
            <h1 class="wd-entities-title">新品发布</h1>
          </div>
        </div>
        <div class="elementor-element elementor-widget elementor-widget-wd_products">
          <div class="elementor-widget-container">
            <ul class="products columns-4">
${cards}
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>`;

  const zh = spliceInto(shell, listing, 'zh');
  const en = applyEnglishBar(spliceInto(shell, listing.replace('>新品发布<', '>New Releases<'), 'en'));

  writeFile(join(paths.dist, 'product-category', CATEGORY_SLUG, 'index.html'), zh);
  writeFile(join(paths.dist, 'en/product-category', CATEGORY_SLUG, 'index.html'), en);

  return { slug: CATEGORY_SLUG, url: `/product-category/${encodeSegment(CATEGORY_SLUG)}/`, urlEn: `/en/product-category/${encodeSegment(CATEGORY_SLUG)}/` };
}

function productCard(r) {
  const title = escapeHtml(r.title.zh);
  const hero = r.media.hero ?? '';
  const resolution = r.specs.resolution ? escapeHtml(r.specs.resolution) : '';
  const size = r.specs.sizeInch !== null ? `${r.specs.sizeInch}"` : '';

  return `  <li class="product-grid-item type-product status-publish">
    <a href="${r.url}">
      <div class="product-detail-wrapper">
        <figure class="product-media">
          <img src="${hero}" alt="${title}" />
        </figure>
        <div class="wd-product-item-info">
          <span class="wd-entities-title">${title}</span>
          <div class="wd-new-release-card-meta">${escapeHtml(size)} ${escapeHtml(resolution)}</div>
        </div>
      </div>
    </a>
  </li>`;
}

function spliceInto(shell, main, lang) {
  // The listing page is not a product page; its title, canonical, and
  // breadcrumb all point at the category rather than at the shell product.
  const origin = SITE_ORIGIN.replace(/\/+$/, '');
  const slugPath = `/product-category/${encodeSegment(CATEGORY_SLUG)}/`;
  const path = lang === 'zh' ? slugPath : `/en${slugPath}`;
  const other = lang === 'zh' ? `/en${slugPath}` : slugPath;
  const pageTitle = lang === 'zh' ? '新品发布' : 'New Releases';
  const suffix = lang === 'zh' ? '深圳市星百亿电子有限公司' : 'Starbillions';

  // Replace the shell's main content (breadcrumb through pre-footer) with
  // our listing; the shell's own breadcrumb still names a specific product,
  // so we rewrite it inside the new main content rather than reuse it.
  const withMain = (() => {
    const bcStart = shell.indexOf('woocommerce-breadcrumb');
    const start = shell.lastIndexOf('<section', bcStart);
    const end = shell.indexOf('<footer', bcStart);
    const carried = shell.slice(start, end).match(/<link\b[^>]*rel=["']?stylesheet[^>]*>/i)?.[0] ?? '';
    const breadcrumb = `<section class="wd-negative-gap elementor-section elementor-top-section elementor-element elementor-section-boxed" data-id="listing-breadcrumb" data-element_type="section"><div class="elementor-container"><div class="elementor-column elementor-col-100"><div class="elementor-widget-wrap"><nav class="woocommerce-breadcrumb" aria-label="Breadcrumb"><a href="${lang === 'zh' ? '/' : '/en/'}" class="breadcrumb-link">${lang === 'zh' ? '首页' : 'Home'}</a><span class="breadcrumb-link breadcrumb-link-last">${escapeHtml(pageTitle)}</span></nav></div></div></div></section>`;
    return shell.slice(0, start) + carried + '\n' + breadcrumb + main + shell.slice(end);
  })();

  return withMain
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(pageTitle)} &#8211; ${escapeHtml(suffix)}</title>`)
    .replace(/<link rel="canonical" href="[^"]*"/i, `<link rel="canonical" href="${origin}${path}"`)
    .replace(/<link rel="alternate" hreflang="[^"]*" href="[^"]*"\/>/g, [
      `<link rel="alternate" hreflang="zh-CN" href="${origin}${path}"/>`,
      `<link rel="alternate" hreflang="en-US" href="${origin}${other}"/>`,
      `<link rel="alternate" hreflang="zh" href="${origin}${path}"/>`,
      `<link rel="alternate" hreflang="en" href="${origin}${other}"/>`,
    ].join(' '));
}

/**
 * The English category page needs the same bottom-bar swap the product
 * pages do; both come from the same Chinese shell. Kept out of `spliceInto`
 * so the pipeline for identity tags reads linearly, and applied *after* the
 * return so `replaceMobileToolbar` sees a fully-formed page (its anchor is
 * the `wd-toolbar` class, which lives in the footer area). */
function applyEnglishBar(html) {
  return replaceMobileToolbar(html, MOBILE_TOOLBAR.en).html;
}

/**
 * Register each new-release page's stylesheet cascade in the mirror's own
 * report so `check`'s pre-merge shape assertion has an entry to compare
 * against.
 *
 * The value is copied from the shell page's own entry. That is not a
 * shortcut - every new page inherits the shell's head byte-for-byte except
 * the three identity tags the render edits, and the cascade shape depends
 * only on which `<link rel=stylesheet>` tags are present and what lives
 * between them. Same head means same shape. Recording it here means the
 * gate keeps its original meaning ("a merged bundle must contain exactly
 * what the pre-merge cascade said") for new pages too, without needing a
 * second copy of `cascadeShape()` wired up to import from the mirror.
 */
function recordCascades(rendered, category) {
  const reportPath = join(paths.work, 'mirror-report.json');
  if (!existsSync(reportPath)) return;

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const baseline = report.stylesheetCascades;
  if (!baseline) return;

  // Every new page's shape is identical to the shell's, so grab the shell
  // entry once and copy it forward. `shellSlug` is defined in render.mjs;
  // matching the exact key it uses keeps the two modules honest about which
  // page is the reference.
  const shellKey = Object.keys(baseline).find((k) => k.startsWith('product/starbillions-1-28'));
  const shellShape = shellKey ? baseline[shellKey] : null;
  if (shellShape === null) return;

  for (const r of rendered) {
    baseline[`product/${r.slug}/index.html`] = shellShape;
    baseline[`en/product/${r.slug}/index.html`] = shellShape;
  }
  baseline[`product-category/${category.slug}/index.html`] = shellShape;
  baseline[`en/product-category/${category.slug}/index.html`] = shellShape;

  writeFile(reportPath, JSON.stringify(report));
}

/**
 * Append new-release `<loc>` entries to the sitemap the mirror wrote.
 *
 * Editing the file in place rather than regenerating it is deliberate: the
 * mirror's buildSitemap() reads from the cached page set and knows nothing
 * about the new-release records, and duplicating its ordering / alternates
 * logic here would drift. Inserting before `</urlset>` keeps every one of
 * the mirror's own entries byte-identical while adding ours at the end.
 *
 * Idempotency is what the STRIP marker comment buys. Without it, running
 * the build a second time (a normal thing while iterating on the render,
 * and the exact thing `npm run verify` does after `npm run mirror` if you
 * happen to run both) appended another 130 entries each time and the file
 * silently grew. Between builds, everything else in the pipeline is
 * replaced by rewriting it from scratch (wipePrevious removes the pages and
 * media); the sitemap is the one file that has a mirror-authored prefix we
 * must keep, so "strip the marked block, then write it again" is the shape
 * that survives.
 */
const SITEMAP_MARK_BEGIN = '<!-- new-release entries -->';
const SITEMAP_MARK_END = '<!-- /new-release entries -->';

function appendToSitemap(rendered, category) {
  const origin = SITE_ORIGIN.replace(/\/+$/, '');
  const path = join(paths.dist, 'sitemap.xml');
  const current = readFileSync(path, 'utf8');

  const stripped = current.replace(
    new RegExp(`${SITEMAP_MARK_BEGIN}[\\s\\S]*?${SITEMAP_MARK_END}\\s*`),
    '',
  );

  const entries = [];
  for (const r of rendered) {
    entries.push(urlEntry(`${origin}${r.url}`, `${origin}${r.urlEn}`));
    entries.push(urlEntry(`${origin}${r.urlEn}`, `${origin}${r.url}`));
  }
  entries.push(urlEntry(`${origin}${category.url}`, `${origin}${category.urlEn}`));
  entries.push(urlEntry(`${origin}${category.urlEn}`, `${origin}${category.url}`));

  const block = `${SITEMAP_MARK_BEGIN}\n${entries.join('\n')}\n${SITEMAP_MARK_END}\n`;
  const updated = stripped.replace('</urlset>', `${block}</urlset>`);
  writeFile(path, updated);
}

function urlEntry(loc, alt) {
  return `<url>\n  <loc>${loc}</loc>\n  <xhtml:link rel="alternate" hreflang="x-default" href="${alt}"/>\n  <xhtml:link rel="alternate" hreflang="zh-CN" href="${loc}"/>\n  <xhtml:link rel="alternate" hreflang="en-US" href="${alt}"/>\n</url>`;
}

/**
 * Append new-release records to `dist/search.json`.
 *
 * The shape mirrors what `tools/ingest/wp/search-index.js` writes: one
 * object per language, with `title`, `url`, `img`, and a joined `specs`
 * text field the runtime scorer reads. Same shape means the existing
 * `public/site-search.js` finds new-release entries without a single line
 * of change - the runtime does not care where a row came from, only that
 * the fields exist.
 *
 * Entries pointing at a new-release product page (any slug starting
 * with `new-`) or the new-release category are filtered out before the new
 * set is written, so a second run does not double them up.
 */
function appendToSearchIndex(rendered) {
  const path = join(paths.dist, 'search.json');
  const current = JSON.parse(readFileSync(path, 'utf8'));

  const mine = /^(?:\/en)?\/product\/new-|\/(?:en\/)?product-category\/%E6%96%B0%E5%93%81%E5%8F%91%E5%B8%83\//;
  const kept = current.filter((entry) => !mine.test(entry.url));

  const extra = [];
  for (const r of rendered) {
    extra.push(searchEntry(r, 'zh'));
    extra.push(searchEntry(r, 'en'));
  }

  writeFile(path, JSON.stringify([...kept, ...extra]));
}

function searchEntry(r, lang) {
  const s = r.specs;
  const parts = [];
  if (s.sizeInch !== null) parts.push(String(s.sizeInch) + '"');
  if (s.shapes && s.shapes.length) parts.push(s.shapes.join(' '));
  if (s.panel) parts.push(s.panel);
  if (s.resolution) parts.push(s.resolution);
  if (s.interfaces && s.interfaces.length) parts.push(s.interfaces.join(' '));
  if (s.pins) parts.push(String(s.pins) + 'PIN');
  if (s.touch) parts.push(s.touch);
  if (s.model) parts.push(s.model);

  return {
    title: lang === 'zh' ? r.title.zh : r.title.en,
    url: lang === 'zh' ? r.url : r.urlEn,
    img: r.media.hero || '',
    specs: parts.join(' '),
    categories: [lang === 'zh' ? '新品发布' : 'New Releases'],
  };
}

function encodeSegment(name) {
  return encodeURIComponent(name);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * CLI entry: `node tools/new-releases/build.mjs` (also `npm run products`).
 *
 * Detected by suffix rather than by `import.meta.url === 'file://' + argv[1]`,
 * which is the usual recipe and fails on Windows: `argv[1]` arrives with
 * backslashes and a drive letter (`C:\Users\...`) while the URL form has
 * forward slashes and a lowercase drive (`file:///c:/Users/...`). The
 * compare then reports "not the main module" for the very invocation this
 * branch exists to serve, and `npm run products` silently exits 0 having
 * done nothing.
 */
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/new-releases/build.mjs')) {
  const result = await buildAll();

  // Order matters. `insertStrips` reads `r.media.hero` from the render
  // manifest, and `webp.mjs` rewrites references only inside the files it
  // is pointed at. Running strips first means the four strip pages exist
  // by the time webp starts, so webp's rewrite pass covers them alongside
  // the product pages and the strip cards point at the same `.webp` bytes
  // the product gallery does. Running it the other way left the strip's
  // six `<img src="...jpg">` tags naming files webp had already deleted,
  // which is the 24-asset-reference failure the first cut of this pipeline
  // showed.
  const strips = insertStrips(result.rendered);
  const webp = await convertNewReleaseImages();

  console.log(`\n  new-release build -> dist/`);
  console.log(`    pages built  ${result.built} x 2 langs`);
  console.log(`    skipped      ${result.skipped} folder(s) marked skip`);
  console.log(`    category     ${result.category.url} (+ en)`);
  console.log(`    strips       ${strips.inserted} page(s)`);
  console.log(`    webp         ${webp.unavailable
    ? 'skipped - sharp is not installed, originals ship as they are'
    : `${webp.converted} converted, ${webp.refused} refused, ${webp.skipped} under floor, ${webp.cleared} originals cleared${webp.stuck ? `, ${webp.stuck} still locked (retry the build)` : ''}`}`);

  // `media.mjs` refuses to copy anything the deployment host would reject, so
  // a page may legitimately arrive with one fewer video than its folder has.
  // Named here because it is the one output difference between "the site the
  // owner describes" and "the site the owner's folders contain"; the gate
  // cannot see it (a missing file nobody links to is not a broken reference).
  const droppedFiles = result.rendered.flatMap((r) => r.media.droppedFiles ?? []);
  for (const note of droppedFiles) console.log(`    dropped      ${note}`);
  console.log('');
}
