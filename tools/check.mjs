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
import { FLOATER_POSITIONS, ORIGIN_URLS, resolvesInOutput } from './ingest/wp/staticize.js';
import { ENQUIRE_LABELS } from './lib/site-links.js';
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

const sourceTexts = discover(paths.pageCache).map((page) => readFileSync(page.file, 'utf8'));
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

console.log('\n  mirror checks\n');
for (const line of [...notes, ...failures]) console.log(line);
console.log(failures.length ? `\n  ${failures.length} failure(s)\n` : '\n  all checks passed\n');
process.exit(failures.length ? 1 : 0);
