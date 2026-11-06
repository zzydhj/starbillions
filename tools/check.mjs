/**
 * Output verifier for the mirror. Runs after tools/mirror.mjs.
 *
 *   node tools/check.mjs
 *
 * Exits non-zero on any failure, so it can gate a deploy.
 *
 * What gets asserted is what a mirror breaks on, not what a hand-written site
 * would: a single leftover reference to the origin host means pages silently
 * borrowing CSS or links from a server that is already returning fatal errors, and
 * a root-absolute path with no file behind it is a 404 the mirror itself created.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './lib/paths.js';
import { exists, walk } from './lib/fs-utils.js';
import { FLOATER_POSITIONS, ORIGIN_URLS, OWNER_REMOVED_SECTIONS, isOwnerRemoved, removeDeadShopControls, removeOwnerMenuItems, resolvesInOutput } from './ingest/wp/staticize.js';
import { CONTACT_FORM_LABELS, COPYRIGHT_YEAR, ENQUIRE_LABELS, MOBILE_TOOLBAR, replaceMobileToolbar } from './lib/site-links.js';
import { discover } from './mirror.mjs';

/** The origin the mirror was built for, read from its own build report. */
const reportData = exists(join(paths.work, 'mirror-report.json'))
  ? JSON.parse(readFileSync(join(paths.work, 'mirror-report.json'), 'utf8'))
  : {};
const siteOrigin = reportData.siteOrigin ?? 'https://starbillions.com';
const siteHost = new URL(siteOrigin).host;

const failures = [];
const notes = [];

function check(name, condition, detail = '') {
  if (condition) notes.push(`  ok    ${name}${detail && ` - ${detail}`}`);
  else failures.push(`  FAIL  ${name}${detail && ` - ${detail}`}`);
}

const files = walk(paths.dist);
const known = new Set(files.map((file) => file.rel));
const html = files.filter((file) => file.rel.endsWith('.html'));

if (html.length === 0) {
  console.error('\n  nothing to check: dist/ has no HTML, run node tools/mirror.mjs first\n');
  process.exit(1);
}

const documents = html.map((file) => ({ ...file, text: readFileSync(file.abs, 'utf8') }));

/* 1. no references to the origin host may survive --------------------------- */

const originHits = documents
  .map((doc) => ({ rel: doc.rel, hits: ORIGIN_URLS.filter((origin) => doc.text.includes(origin)) }))
  .filter((entry) => entry.hits.length > 0);

check(
  'no reference to the old origin survives in a page',
  originHits.length === 0,
  originHits.length > 0 ? `${originHits.length} page(s), e.g. ${originHits[0].rel}` : `${documents.length} pages clean`,
);

/**
 * No resource may be addressed through an absolute URL, old host or new.
 *
 * A browser check caught this the first time: 67 stylesheets were being loaded from
 * an absolute origin baked into Elementor's data-settings JSON and Woodmart's inline
 * config, which works only where that domain resolves and fails everywhere else,
 * including a local preview. An absolute path to the mirror's own domain is the same
 * trap wearing a different name.
 */
const absoluteResources = [];

for (const doc of documents) {
  for (const match of doc.text.matchAll(/(?:href|src|data-src|data-wood-src|data-rocket-src)="(https?:\/\/[^"']+\.(?:css|js|png|jpe?g|webp|svg|gif|woff2?|ttf))[^"]*"/gi)) {
    const url = match[1];
    if (!url.includes(siteHost) && !ORIGIN_URLS.some((origin) => url.includes(origin.split('://')[1]))) continue;
    absoluteResources.push({ from: doc.rel, url });
  }

  // The JSON and JS forms, which no attribute regex reaches.
  for (const match of doc.text.matchAll(/https?:\\{0,2}\/\\{0,2}\/[^"'\\ ]*\.(?:css|js|png|jpe?g|webp|svg|woff2?)(?=["'\\ ])/gi)) {
    const url = match[0];
    if (!url.includes(siteHost) && !ORIGIN_URLS.some((origin) => url.includes(origin.split('://')[1]))) continue;
    absoluteResources.push({ from: doc.rel, url });
  }
}

check(
  'no same-site resource is addressed by absolute URL',
  absoluteResources.length === 0,
  `${absoluteResources.length} found, e.g. ${absoluteResources[0]?.url ?? '-'}`,
);

/** Whether a root-absolute path the pages use actually resolves. */

/* 2. every root-absolute path the mirror points at must be accounted for ---- */

/**
 * Split by what the failure would mean.
 *
 * A stylesheet or image that does not resolve is a bug in this build: the file came
 * from the same backup and should have been copied. A page that does not resolve is
 * a property of the source, because WP Rocket only stored pages someone actually
 * visited - archives, tag pages and feeds were never rendered. Failing on the second
 * would be failing for the site's own history, so it is reported instead.
 */
const brokenAssets = [];
const uncachedPages = new Set();

for (const doc of documents) {
  for (const match of doc.text.matchAll(/(?:href|src|poster|data-src|data-wood-src|data-lazy-src|data-rocket-src|data-thumb|data-bg)="(\/[^"]+)"/g)) {
    const pathname = match[1].split('?')[0].split('#')[0];
    if (resolvesInOutput(known, pathname)) continue;

    const decoded = decodeURIComponent(pathname);
    if (/\.[a-z0-9]{2,5}$/i.test(decoded)) brokenAssets.push({ from: doc.rel, target: decoded });
    else uncachedPages.add(decoded);
  }
}

check('every referenced asset resolves inside dist', brokenAssets.length === 0, `${brokenAssets.length} broken asset reference(s)`);
for (const item of brokenAssets.slice(0, 12)) notes.push(`        ${item.target}  <- ${item.from}`);

notes.push(`  info  links to pages the origin never cached: ${uncachedPages.size} distinct, they will hit 404.html`);
for (const target of [...uncachedPages].filter((path) => /\/zh_cn\//.test(path)).slice(0, 3)) {
  notes.push(`        language-prefixed link: ${target}`);
}

/**
 * References must not silently disappear.
 *
 * The earlier version of this file asserted that no remaining reference pointed at a
 * missing file - which scores a deleted attribute as perfect. A browser check then
 * found the mirror had stripped the src from 69 scripts and the href from 13
 * stylesheets per page, because a ?ver= cache buster had been read as a
 * request-specific page URL. Comparing counts against the source catches that whole
 * class: the mirror may rewrite a reference, it may not quietly forget one.
 *
 * Counting is by tag with a non-empty attribute, not by searching for the literal
 * text `<link rel="stylesheet" href=`: that reported 0 in the source and 0 in the
 * output, and 0 >= 0 passes any threshold. An assertion that can only ever be
 * satisfied measures nothing, so a source count of zero is itself a failure here.
 */
function countReferences(texts, pattern, attr) {
  let total = 0;

  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const tag = match[0];
      const value = new RegExp(`\\b${attr}=["']([^"']+)['"]`, 'i').exec(tag);
      if (value) total += 1;
    }
  }

  return total;
}

const SCRIPT_TAG = /<script\b[^>]*type=["']?rocketlazyloadscript["']?[^>]*>/gi;
const LINK_TAG = /<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi;
const LAZY_IMG = /<img\b[^>]*data-wood-src=[^>]*>/gi;

/**
 * Only the pages that are supposed to ship. 46 cached pages are the demo content the
 * owner removed, and counting their references here would turn a deliberate deletion
 * into a "references lost" failure - the same list the builder filters with, so the
 * two can never disagree about what should exist.
 */
const sourceTexts = discover(paths.pageCache)
  .filter((page) => !isOwnerRemoved(page.urlPath))
  .map((page) => readFileSync(page.file, 'utf8'));
const builtTexts = documents.map((doc) => doc.text);

const counted = [
  ['delayed script sources', SCRIPT_TAG, 'data-rocket-src'],
  ['stylesheet hrefs', LINK_TAG, 'href'],
  ['lazy image sources', LAZY_IMG, 'data-wood-src'],
];

for (const [label, pattern, attr] of counted) {
  const before = countReferences(sourceTexts, pattern, attr);
  const after = countReferences(builtTexts, pattern, attr);

  // An assertion comparing two zeros would have looked like this passing, so a
  // measurement that found nothing in the source is reported as a broken check.
  if (before === 0) {
    check(`${label} survived the rewrite`, false, 'the source count is 0, so this check is not measuring anything');
    continue;
  }

  check(`${label} survived the rewrite`, after >= before * 0.95, `${after} in dist from ${before} in the cache`);
}

/* 5. copied CSS may not still name the old host ---------------------------- */

/**
 * The page pass cannot see inside a stylesheet, and WP writes absolute URLs into the
 * CSS that Elementor generates per post.
 */
const cssWithOldOrigin = files
  .filter((file) => file.rel.endsWith('.css'))
  .map((file) => file.rel)
  .filter((rel) => ORIGIN_URLS.some((origin) => readFileSync(join(paths.dist, rel), 'utf8').includes(origin)));

check('no copied stylesheet names the old host', cssWithOldOrigin.length === 0, `${cssWithOldOrigin.length} file(s)${cssWithOldOrigin[0] ? `, e.g. ${cssWithOldOrigin[0]}` : ''}`);

/* 6. structural expectations of a bilingual mirror ------------------------- */

const pages = documents.filter((doc) => doc.text.includes('<!DOCTYPE html'));
check('every page is a complete document', pages.length === documents.length, `${pages.length}/${documents.length}`);
check('the mirror has a root document', documents.some((doc) => doc.rel === 'index.html'));
check('english pages exist', documents.some((doc) => doc.rel.startsWith(`en${'/'}`) || doc.rel.startsWith('en\\')));
check('a sitemap was generated', known.has('sitemap.xml'));
check('Pages headers file was carried over', known.has('_headers'));

/* 4. the mechanisms the mirror deliberately did not touch ------------------- */

const lazy = documents.filter((doc) => doc.text.includes('data-rocket-src')).length;
const rocket = documents.filter((doc) => doc.text.includes('RocketLazyLoadScripts')).length;
notes.push(`  info  delay-JS placeholders kept: ${lazy} page(s), loader present on ${rocket}`);

const bytes = files.reduce((total, file) => total + readFileSync(file.abs).length, 0);
notes.push(`  info  dist: ${(bytes / 1048576).toFixed(1)} MB across ${files.length} files, ${documents.length} pages`);

/**
 * Pages-root 404.html is required rather than nice to have: uncached link targets
 * above, plus any mistyped URL, land there. Without it Cloudflare Pages answers
 * with its own branded error page instead of the site's.
 */
check('a 404 page is present', known.has('404.html'));

/* 7. the owner's requested departures from 1:1 ------------------------------ */

/**
 * These two are not mirror fidelity; they are changes the owner asked for, so the
 * thing worth guarding is that they survived the rebuild. Both assertions refuse to
 * pass on an empty measurement: a build that lost the enquiry buttons entirely would
 * otherwise report zero problems, which is the worst possible output of a checker.
 *
 * The expected values come from the build's own report rather than being restated
 * here, so the gate cannot drift away from what the builder was told to do.
 */
const whatsapp = reportData.whatsapp ?? '';
const floater = reportData.floaterPosition ?? 'top-right';
const BUTTON_ANCHOR = /<a\b[^>]*class="[^"]*elementor-button[^"]*"[^>]*>[\s\S]*?<\/a>/gi;

let enquiryCount = 0;
const enquiryWrong = [];

for (const doc of documents) {
  for (const match of doc.text.matchAll(BUTTON_ANCHOR)) {
    const label = /<span class="elementor-button-text">([\s\S]*?)<\/span>/i.exec(match[0])?.[1]?.trim();
    if (!label || !ENQUIRE_LABELS.some((want) => want.toLowerCase() === label.toLowerCase())) continue;

    enquiryCount += 1;
    const href = /\bhref="([^"]*)"/i.exec(match[0])?.[1] ?? '(no href)';
    if (href !== whatsapp) enquiryWrong.push(`${doc.rel} -> ${href}`);
  }
}

check(
  'every enquiry button points at WhatsApp',
  enquiryCount > 0 && enquiryWrong.length === 0,
  enquiryCount === 0
    ? 'not one enquiry button found, so this check measured nothing'
    : `${enquiryCount} button(s) -> ${whatsapp || '(none)'}, ${enquiryWrong.length} elsewhere`,
);
for (const item of enquiryWrong.slice(0, 5)) notes.push(`        ${item}`);

const floaters = documents.filter((doc) => doc.text.includes('id="trp-floater-ls"'));
const floatersElsewhere = floaters.filter((doc) => {
  const classes = /id="trp-floater-ls"[^>]*class="([^"]*)"/i.exec(doc.text)?.[1] ?? '';
  return !classes.includes(`trp-${floater}`) || FLOATER_POSITIONS.some((p) => p !== floater && classes.includes(`trp-${p}`));
});

check(
  'the language switcher sits in the corner the owner asked for',
  floaters.length > 0 && floatersElsewhere.length === 0,
  floaters.length === 0
    ? 'no floating switcher found, so this check measured nothing'
    : `${floaters.length} page(s) carry trp-${floater}, ${floatersElsewhere.length} elsewhere`,
);

/* 7b. the dead shop toolbar controls are gone -------------------------------- */

/**
 * "Show: 9 / 12 / 18 / 24" and the column-count icons have no href and no script that
 * listens for them, here or on the origin, so they were removed.
 *
 * Asserted by asking the builder's own function whether anything is left to cut,
 * rather than by searching for the class names: those strings also occur in inline
 * CSS (268 mentions against 51 elements), so a text search could never report zero,
 * and a narrower regex written only here would drift from what the build actually
 * recognises as a control.
 */
const leftToCut = documents.reduce((total, doc) => {
  return total + Object.values(removeDeadShopControls(doc.text).removed).reduce((sum, n) => sum + n, 0);
}, 0);

check(
  'the dead shop toolbar controls are gone from every page',
  leftToCut === 0,
  `${leftToCut} control(s) still cuttable`,
);

/**
 * The removal must not have reached the products it sits next to. Counting cards is
 * the build's own job - mirror.mjs throws when its edit moves the number - so what
 * belongs here is the weaker, non-brittle statement that an archive page still shows
 * a loop and still shows something in it.
 */
const archives = documents.filter((doc) => /product-category|\/(shop|产品)/.test(doc.rel));
const bareArchives = archives.filter((doc) => !doc.text.includes('class="product-grid-item'));

// No closing quote: a card's class list continues (`product-grid-item product
// product-no-swatches ...`), and matching the attribute as if it were a lone value
// reported every archive page as empty.

check(
  'the archive pages still render their product grid',
  archives.length > 0 && bareArchives.length === 0,
  archives.length === 0
    ? 'no archive page found, so this check measured nothing'
    : `${archives.length} archive page(s), ${bareArchives.length} with no card: ${bareArchives.slice(0, 3).map((doc) => doc.rel).join(', ')}`,
);

/* 7c. the mobile bottom bar reaches real destinations ----------------------- */

/**
 * The bar shipped as three items labelled `123`, each pointing at a preview host on
 * another domain. Asserted against the same table the build used, so the two cannot
 * disagree about what the owner asked for, and asserted on destinations rather than
 * on markup: the point of the edit is that a phone visitor lands somewhere.
 */
const bars = documents.filter((doc) => doc.text.includes('wd-toolbar-label-show'));
const badBars = [];

for (const doc of bars) {
  const entries = doc.rel.startsWith('en/') ? MOBILE_TOOLBAR.en : MOBILE_TOOLBAR.zh;
  const rebuilt = replaceMobileToolbar(doc.text, entries);

  // Rebuilding a page that already carries the owner's bar must change nothing, and
  // must still find exactly one bar to change. Together those say the shipped markup
  // is the requested markup, without this file parsing the region to compare it.
  if (rebuilt.replaced !== 1) badBars.push(`${doc.rel}: ${rebuilt.replaced} bar(s) found, expected 1`);
  if (rebuilt.html !== doc.text) badBars.push(`${doc.rel}: its bar is not the owner's entries`);

  for (const entry of entries) {
    // tel: and mailto: have no file to resolve; everything else must be a page the
    // mirror actually wrote, or the fix has only moved the 404 into the footer.
    if (!/^(tel:|mailto:|https?:)/.test(entry.href) && !resolvesInOutput(known, entry.href)) {
      badBars.push(`${doc.rel}: ${entry.href} has no page behind it`);
    }
  }

  // The three icons must share one colour source. A baked hex in any of them is what
  // made the bar look inconsistent in the first place, and CSS cannot reconcile it.
  const bar = /<div class="wd-toolbar wd-toolbar-label-show">[\s\S]{0,2400}<\/div>\s*<\/(?:div|body)/.exec(doc.text)?.[0] ?? '';
  const coloured = (bar.match(/#[0-9a-f]{3,8}\b/gi) || []).length;
  const inherited = (bar.match(/fill="currentColor"/g) || []).length;
  if (inherited !== entries.length) badBars.push(`${doc.rel}: ${inherited} of ${entries.length} icons inherit the colour`);
  if (coloured > 0) badBars.push(`${doc.rel}: ${coloured} baked colour(s) in the bar`);
}

check(
  'the mobile bottom bar offers the owner\'s entries and every one of them resolves',
  bars.length > 0 && badBars.length === 0,
  bars.length === 0
    ? 'no bottom bar found, so this check measured nothing'
    : `${bars.length} page(s) carry a bar, ${badBars.length} problem(s): ${badBars.slice(0, 3).join('; ')}`,
);

/**
 * The preview host used to survive in two places: the three bottom-bar items, fixed
 * just above, and the body text and images of the theme's demo posts and portfolio
 * items. Those pages are now deliberately not built, so there is nothing left to
 * excuse and this is an absolute assertion - a page naming a host that is not this
 * site is the very thing a mirror is supposed to have eliminated.
 *
 * Matched on the domain name rather than the full URL, because an entity-escaped or
 * protocol-relative spelling of the same host is still the same defect.
 */
const demoHost = documents.filter((doc) => doc.text.includes('savetime'));
check(
  'no page names the author\'s old preview host',
  demoHost.length === 0,
  `${demoHost.length} page(s): ${demoHost.slice(0, 3).map((doc) => doc.rel).join(', ')}`,
);

/* 7d. the footer's year and the menu items with a number for a URL ---------- */

/**
 * Two things the source baked into every page that have since become wrong.
 *
 * The copyright year is asserted in both directions: no page may still claim the old
 * one, and at least one page must claim the new one. The second half is what makes
 * the first meaningful - if the rule stopped matching because the footer's markup
 * changed, "zero pages still say 2024" would be reported as a pass.
 */
const staleYear = documents.filter((doc) => /(©|&copy;)\s*2024/.test(doc.text));
const currentYear = documents.filter((doc) => new RegExp(`(©|&copy;)\\s*${COPYRIGHT_YEAR}`).test(doc.text));

check(
  'the footer claims the current year',
  staleYear.length === 0 && currentYear.length > 0,
  `${staleYear.length} page(s) still say 2024, ${currentYear.length} say ${COPYRIGHT_YEAR}`,
);

/**
 * Menu items whose URL field held a bare number. Every one of them is now either
 * routed - to the label table, or to the first listing inside its own dropdown panel
 * - or unlinked entirely, which leaves an honest heading where a broken promise was.
 *
 * The invariant is absolute, so it is asserted absolutely: no navigation link on any
 * page may carry a URL whose host is a number, a Chinese string, or anything else
 * that is not a real site. Counting the leftovers as informational was the previous
 * behaviour, and it let 1696 dead links through as a note.
 */
const deadNav = [];
for (const doc of documents) {
  for (const match of doc.text.matchAll(/<a\b[^>]*href="https?:\/\/([^"\/]*)"[^>]*class="[^"]*woodmart-nav-link[^"]*"/g)) {
    if (!match[1].includes('.')) deadNav.push(`${doc.rel}: http://${match[1]}`);
  }
}

check(
  'no menu link points at an origin that is not a real site',
  deadNav.length === 0,
  `${deadNav.length} dead link(s): ${deadNav.slice(0, 3).join('; ')}`,
);

/**
 * English pages whose tab still reads a Chinese page name. The company suffix is
 * excluded on purpose: that half is a registered name, and en/index.html is titled
 * nothing else, so a Chinese string there is correct.
 */
const zhTitles = [];
for (const doc of documents) {
  if (!doc.rel.startsWith('en/')) continue;
  const page = (/<title>([\s\S]*?)<\/title>/i.exec(doc.text)?.[1] ?? '').split(/&#8211;|–/)[0];
  if (/[\u4e00-\u9fff]/.test(page)) zhTitles.push(`${doc.rel}: ${page.replace(/\s+/g, ' ').trim().slice(0, 40)}`);
}

check(
  'english pages open with an english page name',
  zhTitles.length === 0,
  `${zhTitles.length} page(s): ${zhTitles.slice(0, 3).join('; ')}`,
);

/* 7e. no page offers a form that cannot be submitted ------------------------ */

/**
 * The metform widget posted to a REST endpoint, which a static host has no way to
 * answer: the visitor got no confirmation and no error, which is the worst possible
 * outcome for an enquiry channel. Asserted by absence of the container and the
 * endpoint, and - because an absence alone can also mean the rule stopped matching -
 * by the button being present on a real number of pages.
 */
const liveForms = documents.filter((doc) => doc.text.includes('mf-form-wrapper')
  || doc.text.includes('metform/v1/entries/insert'));
const formButtons = documents.filter((doc) => doc.text.includes(CONTACT_FORM_LABELS.zh)
  || doc.text.includes(CONTACT_FORM_LABELS.en));

check(
  'no page still offers a contact form that cannot be submitted',
  liveForms.length === 0 && formButtons.length > 0,
  `${liveForms.length} page(s) still carry the form, ${formButtons.length} carry the WhatsApp button`,
);

/* 7f. the map is text now, and the fonts state is stated, not assumed ------ */

const embeds = documents.filter((doc) => /<iframe[^>]*maps\.google/i.test(doc.text));
check(
  'no page embeds the Google map',
  embeds.length === 0,
  `${embeds.length} page(s) still embed it`,
);

/**
 * The address must survive the removal. It is looked for as text rather than as a
 * count of replacements, because the point of the edit is that a visitor can still
 * read where the company is.
 */
const addressed = documents.filter((doc) => /<p>(深圳市宝安区|Hengfeng Industrial City)/.test(doc.text));
check(
  'the address is printed where the map used to be',
  addressed.length > 0,
  `${addressed.length} page(s) show it as text`,
);

/**
 * Fonts are reported in the state they are actually in. A manifest that has not been
 * produced is a normal condition - the mirror has no network step - so failing on it
 * would make npm run verify red for something the owner has not chosen to do yet.
 * Once the manifest exists, though, the same line becomes an absolute assertion:
 * shipping a local font tree while still calling Google is the half-done state nobody
 * notices.
 */
const fontManifest = exists(join(paths.public, 'fonts', 'manifest.json'))
  ? JSON.parse(readFileSync(join(paths.public, 'fonts', 'manifest.json'), 'utf8'))
  : null;
const remoteFonts = documents.filter((doc) => doc.text.includes('fonts.googleapis.com'));

if (fontManifest) {
  const unresolved = documents.filter((doc) => /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(doc.text));
  check(
    'the fetched fonts are actually what the pages load',
    unresolved.length === 0,
    `${unresolved.length} page(s) still call Google despite the manifest: ${unresolved.slice(0, 2).map((doc) => doc.rel).join(', ')}`,
  );
} else {
  notes.push(`  info  fonts still load from Google on ${remoteFonts.length} page(s) - npm run fonts has not been run`);
}

/* 7g. the demo content the owner removed is gone and nothing points at it --- */

/**
 * The theme shipped a set of lorem-ipsum posts (Japanese furniture, John Doerson,
 * Atlanta homes) with the archives that existed only to list them and the header's
 * 博客 entry beside them. The owner chose to delete all of it rather than ship a
 * half-populated blog about a product the company does not sell.
 *
 * Three ways this edit fails quietly, so all three are asserted: the files can stay,
 * a link can stay and point at a file that no longer exists, and the link can be
 * stripped out of a menu item that is still on screen - which is a label that looks
 * navigable and does nothing, the same defect the shop toolbar had.
 *
 * "Nothing left to cut" alone could also mean the cut ate the menu, so the surviving
 * menu is counted: every page carrying the main menu must still carry the four items
 * the site actually has, and none of their anchors may be href-less.
 */
const staleFiles = documents.filter((doc) => isOwnerRemoved(`/${doc.rel.replace(/index\.html$/, '')}`));
// The section names come from the builder's own list, because a second copy of the
// list here is a second source of truth: a section added to one and not the other
// would either ship a page the gate thinks is gone, or fail on a page that is fine.
const removedLink = new RegExp(`href="\/(?:en\/)?(?:${OWNER_REMOVED_SECTIONS.map((section) => section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}\/?|\\d{4}\/)`, 'g');
const staleLinks = documents
  .map((doc) => [doc.rel, (doc.text.match(removedLink) || []).length])
  .filter(([, count]) => count > 0);
const itemsLeftToCut = documents.reduce((total, doc) => total + removeOwnerMenuItems(doc.text).removed, 0);
const mainNavs = documents.filter((doc) => doc.text.includes('id="menu-main'));
const thinNavs = documents.filter((doc) => doc.text.includes('id="menu-main')
  && (doc.text.match(/class="menu-item /g) || []).length < 4);
const hreflessNav = documents.filter((doc) => /<a\b(?![^>]*href=)[^>]*class="[^"]*woodmart-nav-link/.test(doc.text));

check(
  'no demo post or empty archive is shipped',
  staleFiles.length === 0,
  `${staleFiles.length} page(s) left: ${staleFiles.slice(0, 2).map((doc) => doc.rel).join(', ')}`,
);
check(
  'nothing links into the removed content',
  staleLinks.length === 0 && itemsLeftToCut === 0,
  `${staleLinks.reduce((total, [, count]) => total + count, 0)} link(s) on ${staleLinks.length} page(s) still point there, ${itemsLeftToCut} menu item(s) left to cut`,
);
check(
  'the menu that is left is the menu the site has',
  mainNavs.length > 0 && thinNavs.length === 0 && hreflessNav.length === 0,
  `${mainNavs.length} page(s) carry the main menu, ${thinNavs.length} too short, ${hreflessNav.length} with an inert item`,
);

const demoWords = documents.filter((doc) => />博客<|>Blog</.test(doc.text));
if (demoWords.length) notes.push(`  info  ${demoWords.length} page(s) still say 博客 or Blog in their text (not as a link): ${demoWords.slice(0, 2).map((doc) => doc.rel).join(', ')}`);

/* 8. the static search replaces the origin's AJAX one ------------------------- */

/**
 * The search box used to query PHP. It is now fed by search.json, which the build
 * derives from the shipped pages, so the things worth asserting are that the index
 * exists, that it points only at pages and images that exist, and that the dead AJAX
 * hook is actually gone rather than merely unused - two autocompletes on one input
 * would race, and the one that cannot fail is the one that wins.
 */
let index = [];
if (known.has('search.json')) {
  try {
    index = JSON.parse(readFileSync(join(paths.dist, 'search.json'), 'utf8'));
  } catch (error) {
    notes.push(`        search.json did not parse: ${error.message}`);
  }
}

check('the search index was built', index.length > 0, `${index.length} entries`);
check('the search index covers both languages', index.some((e) => e.lang === 'zh') && index.some((e) => e.lang === 'en'));

const indexDeadLinks = index.filter((entry) => !resolvesInOutput(known, entry.url));
const indexDeadImages = index.filter((entry) => entry.image && !resolvesInOutput(known, entry.image));
const indexUntitled = index.filter((entry) => !entry.title);

check('every search result points at a page that exists', indexDeadLinks.length === 0, `${indexDeadLinks.length} dead`);
check('every search thumbnail is a file that exists', indexDeadImages.length === 0, `${indexDeadImages.length} missing`);
check('every search result has a title', indexUntitled.length === 0, `${indexUntitled.length} blank`);
for (const entry of indexDeadLinks.slice(0, 5)) notes.push(`        ${entry.url}`);
for (const entry of indexDeadImages.slice(0, 5)) notes.push(`        ${entry.image}  <- ${entry.url}`);

const ajaxForms = documents.filter((doc) => doc.text.includes('woodmart-ajax-search'));
check('the theme\'s AJAX autocomplete is switched off', ajaxForms.length === 0, `${ajaxForms.length} page(s) still carry it`);

const withSearch = documents.filter((doc) => doc.text.includes('search-results-wrapper'));
const unwired = withSearch.filter((doc) => !doc.text.includes('/site-search.js') || !doc.text.includes('/site-search.css'));
check(
  'every page with a search box loads the static search',
  withSearch.length > 0 && unwired.length === 0,
  withSearch.length === 0
    ? 'no search box found, so this check measured nothing'
    : `${withSearch.length} page(s) have one, ${unwired.length} without the script`,
);
check('the search runtime files exist', known.has('site-search.js') && known.has('site-search.css'));

/**
 * A shipped script may not import from the repository.
 *
 * public/site-search.js is copied to the site root and loaded as a module by the
 * browser, so an import of a build-time path resolves to a URL that does not exist.
 * The browser then refuses the whole module: the search box is dead on every page,
 * while every unit test still passes because Node resolves the path fine. That is the
 * exact shape of failure a checker exists to catch, and it can only be caught here -
 * not by importing the file from Node, which is the thing that lies.
 */
const runtimeSource = known.has('site-search.js') ? readFileSync(join(paths.dist, 'site-search.js'), 'utf8') : '';
const repoImports = [...runtimeSource.matchAll(/^\s*import\s[^\n]*?from\s+['"][^'"]*['"]/gm)].map((match) => match[0].trim());

check('the shipped search script imports nothing', repoImports.length === 0, `${repoImports.length} import(s) in a file the browser must load alone`);
for (const line of repoImports.slice(0, 3)) notes.push(`        ${line}`);

console.log('\n  mirror checks\n');
for (const line of [...notes, ...failures]) console.log(line);
console.log(failures.length ? `\n  ${failures.length} failure(s)\n` : '\n  all checks passed\n');
process.exit(failures.length ? 1 : 0);
