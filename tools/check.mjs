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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { paths } from './lib/paths.js';
import { exists, readJson, walk } from './lib/fs-utils.js';
import { FLOATER_POSITIONS, ORIGIN_URLS, OWNER_REMOVED_SECTIONS, DEAD_AJAX_SCRIPTS, DEAD_AJAX_WIDGETS, absoluteIdentityUrls, combineStylesheets, expandedShape, isOwnerRemoved, jsChunkNames, localizeCssAssetUrls, removeDeadAjaxScripts, removeDeadShopControls, removeDeadTabsNavigation, removeOwnerMenuItems, resolvesInOutput, rootCssUrls } from './ingest/wp/staticize.js';
import { CONTACT_FORM_LABELS, COPYRIGHT_YEAR, ENQUIRY_PHONE, ENQUIRE_LABELS, MOBILE_TOOLBAR, SITE_ORIGIN, rewriteRobotsSitemap, replaceMobileToolbar, repairPhoneLinks } from './lib/site-links.js';
import { keyForReference, namedAssetPaths } from './media/apply.js';
import { discover } from './mirror.mjs';

/** The origin the mirror was built for, read from its own build report. */
const reportData = exists(join(paths.work, 'mirror-report.json'))
  ? JSON.parse(readFileSync(join(paths.work, 'mirror-report.json'), 'utf8'))
  : {};
const siteOrigin = reportData.siteOrigin ?? SITE_ORIGIN;
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

/**
 * The shipped pages, indexed by the URL path they answer on. Declared here because
 * several independent sections need it, and a second `const` further down would sit in
 * the temporal dead zone for everything above it - which reads as a crash in the middle
 * of the report, not as a missing definition.
 */
const builtByPath = new Map(documents.map((doc) => [`/${doc.rel.replace(/index\.html$/, '')}`, doc]));

/* 1. no references to the origin host may survive --------------------------- */

/**
 * "The origin" means the host the backup was taken from, and the rule is about
 * references this build cannot control. It has one legitimate exception: one of the two
 * deployments sharing this code is served from that very domain - the backup came from
 * tftstar.com, and one of the two sites is tftstar.com - so without the exception that
 * site's own canonical URL is reported as a leftover of the origin, on all 138 pages.
 * Only the exact declared origin is excluded, so a stale `http://` spelling still fails
 * even when `https://` is the site itself.
 */
const staleOrigins = ORIGIN_URLS.filter((origin) => origin !== siteOrigin);
const originHits = documents
  .map((doc) => ({ rel: doc.rel, hits: staleOrigins.filter((origin) => doc.text.includes(origin)) }))
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
const LAZY_IMG = /<img\b[^>]*data-wood-src=[^>]*>/gi;

/**
 * One stylesheet link, as the attribute parser reads the rel value.
 *
 * Both the merge section and the switcher-survival count below need this shape, and
 * `rel=["']stylesheet["']` with a backreference rather than an optional quote: the site
 * writes single quotes in head metadata and double quotes elsewhere, and a pattern that
 * only sees one of the two reads a quiet zero.
 */
const SHEET_LINK = /<link\b[^>]*rel=(["'])stylesheet\1[^>]*>/gi;

/**
 * Only the pages that are supposed to ship. 46 cached pages are the demo content the
 * owner removed, and counting their references here would turn a deliberate deletion
 * into a "references lost" failure - the same list the builder filters with, so the
 * two can never disagree about what should exist.
 */
const sourcePages = discover(paths.pageCache).filter((page) => !isOwnerRemoved(page.urlPath));
const sourceTexts = sourcePages.map((page) => readFileSync(page.file, 'utf8'));
const builtTexts = documents.map((doc) => doc.text);

const counted = [
  ['delayed script sources', SCRIPT_TAG, 'data-rocket-src'],
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

/**
 * The stylesheet merge may change how many files a page asks for. It may not change
 * which rules reach the page, or the order they arrive in.
 *
 * This replaces the `stylesheet hrefs` count above, which measured the wrong thing once
 * bundles existed: 12,089 links folding into 2,657 is the point of the rule, and a
 * threshold on link counts would have called the improvement a loss. What still has to
 * hold is the cascade, and that is asserted two independent ways:
 *
 *   - sequence: per page, the ordered run of "a stylesheet applies" and "an inline style
 *     applies" events, with every bundle expanded back into the members it names, must
 *     be identical to the cached page's. A bundle hoisted over an inline override would
 *     change which rule wins on one widget and would be invisible in every other check.
 *   - bytes: each bundle's text must equal the shipped member files, in the order the
 *     bundle declares them, after the same two transformations the builder applies
 *     (relative url() re-rooted, BOM and stray @charset dropped). The bundle states its
 *     own members in comments, so this reads the output rather than trusting the builder.
 */

/** The members a bundle was made from, in order, read out of the bundle's own text. */
function bundleMembers(path) {
  const abs = join(paths.dist, path.slice(1));
  if (!exists(abs)) return null;
  return [...readFileSync(abs, 'utf8').matchAll(/^\/\* ---- merged from (\S+) ---- \*\/$/gm)].map((m) => m[1]);
}

/**
 * Per page, the cascade the merge started from against the cascade it produced.
 *
 * The baseline is the builder's own record of the page before the pass, not the cached
 * page: those two already differ on purpose, because the dead Elementor widgets that
 * were cut took their inline <style> blocks with them (18 becoming 17 on the homepage).
 * Judging the merge against the cache would blame the wrong rule for the right edit.
 *
 * What is still checked, and checked hard, is that expanding the shipped bundles back
 * into the sheets they declare leaves the same sequence of applications. A run of five
 * sheets that came back as four, or as five with an 'S' moved across them, fails here -
 * and the bundle byte check below is independent of both, so neither can cover for the
 * other.
 */
const baseline = reportData.stylesheetCascades ?? {};
const sequenceBroken = [];

if (Object.keys(baseline).length === 0) {
  check('the stylesheet merge has a baseline to be checked against', false,
    'work/mirror-report.json carries no stylesheetCascades - run node tools/mirror.mjs first');
} else {
  check('every page has a pre-merge cascade recorded', Object.keys(baseline).length === documents.length,
    `${Object.keys(baseline).length} recorded for ${documents.length} pages`);

  for (const doc of documents) {
    const want = baseline[doc.rel];
    if (want === undefined) { sequenceBroken.push({ rel: doc.rel, want: '(not recorded)', got: '' }); continue; }

    const got = expandedShape(doc.text, bundleMembers);
    if (got !== want) sequenceBroken.push({ rel: doc.rel, want, got });
  }

  check(
    'no merged bundle dropped a stylesheet or moved one across an inline style',
    sequenceBroken.length === 0,
    `${sequenceBroken.length} page(s)${sequenceBroken[0]
      ? `: e.g. ${sequenceBroken[0].rel}\n        was ${sequenceBroken[0].want}\n        is ${sequenceBroken[0].got}` : ''}`,
  );
}

const bundlesShipped = files.filter((file) => file.rel.startsWith('gen/'));
const bundleMismatch = [];
const bundleNameWrong = [];
const bundleHoles = [];
const distKnown = (p) => known.has(p.replace(/^\//, ''));

for (const file of bundlesShipped) {
  const text = readFileSync(file.abs, 'utf8');
  const members = bundleMembers(`/${file.rel}`);

  // The name is the content fingerprint the cache policy depends on.
  if (!file.rel.endsWith(createHash('sha1').update(text).digest('hex').slice(0, 24) + '.css')) {
    bundleNameWrong.push(file.rel);
  }

  let cursor = 0;
  for (const member of members) {
    const abs = join(paths.dist, member.slice(1));
    if (!exists(abs)) { bundleHoles.push(`${file.rel} names ${member}`); continue; }

    const rooted = rootCssUrls(readFileSync(abs, 'utf8'), member, distKnown);
    const expected = `/* ---- merged from ${member} ---- */\n`
      + rooted.text.replace(/^\uFEFF/, '').replace(/@charset\s+(["'])[^"']*\1\s*;/gi, '');

    if (!text.startsWith(expected, cursor)) bundleMismatch.push(`${file.rel} at ${member}`);
    cursor += expected.length + 1;
  }
}

check(
  'every bundle contains the shipped bytes of its members, in the order it declares',
  bundleMismatch.length === 0 && bundleHoles.length === 0,
  `${bundlesShipped.length} bundle(s), ${bundleMismatch.length} differing segment(s), ${bundleHoles.length} naming a file that is not there`,
);
for (const item of bundleMismatch.slice(0, 6)) notes.push(`        ${item}`);
for (const item of bundleHoles.slice(0, 6)) notes.push(`        ${item}`);

check(
  'a bundle is named after its own bytes, which is what lets _headers hold it for a year',
  bundleNameWrong.length === 0,
  `${bundleNameWrong.length} bundle(s) named otherwise`,
);

/**
 * And the pass must be finished: re-running it over the output has to find nothing, the
 * same way the AJAX and dead-control rules are checked. If it found something, the build
 * left half the pages unmerged - which would look like a success, just a slow one.
 */
const stillMergeable = [];
for (const doc of documents) {
  const again = combineStylesheets(doc.text, {
    read: (p) => (known.has(p.slice(1)) ? readFileSync(join(paths.dist, p.slice(1)), 'utf8') : null),
    exists: distKnown,
    bundleName: (text) => `/gen/${createHash('sha1').update(text).digest('hex').slice(0, 24)}.css`,
  });
  if (again.bundles.size > 0) stillMergeable.push({ rel: doc.rel, runs: again.bundles.size });
}

check(
  'running the merge again over the output finds nothing left to merge',
  stillMergeable.length === 0,
  `${stillMergeable.length} page(s)${stillMergeable[0] ? `, e.g. ${stillMergeable[0].rel}` : ''}`,
);

/**
 * The two halves of this line are not the same population, and the builder's log is a
 * third: the cache number is the 137 pages that are supposed to ship, the output number
 * adds the search stylesheet the build injects (131 pages) and the generated 404 page
 * (78 links), which is exactly the 12089 the builder counted before it merged. Reading
 * 11880 and 12089 as a discrepancy would send someone to look for a bug that is not there.
 */
const linkedSheets = documents.reduce((n, doc) => n + (doc.text.match(SHEET_LINK) || []).length, 0);
notes.push(`  info  stylesheets: ${sourceTexts.reduce((n, t) => n + (t.match(SHEET_LINK) || []).length, 0)} links in the cache, ${linkedSheets} in the output as ${bundlesShipped.length} bundle(s) plus singles`);

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

/**
 * The deployment host refuses a single file over 100 MB, and it refuses it at
 * push time - not in the build report, not as a warning. A build that emitted
 * one looked finished until `git push` said otherwise, with no earlier clue:
 * the 144 MB phone recording that started this rule was already sitting in a
 * `新品发布/` folder while every gate above was green. `video.mjs` owns the
 * ceiling on the writing side; this is the reading side, so a ceiling that
 * gets bypassed (a new media path, a large file added by the mirror, a
 * threshold edited in the wrong place) cannot reach the repository.
 */
const HOST_FILE_LIMIT = 100 * 1024 * 1024;
const overHostLimit = files
  .filter((file) => statSync(file.abs).size > HOST_FILE_LIMIT)
  .map((file) => `${file.rel} (${(statSync(file.abs).size / 1024 / 1024).toFixed(1)} MB)`);
check('no file is past the host per-file limit', overHostLimit.length === 0, `${overHostLimit.length} file(s)${overHostLimit[0] ? `, e.g. ${overHostLimit[0]}` : ''}`);

/**
 * The output must name one host and only one. Which spelling that host is - with or
 * without `www` - is the owner's choice and has changed three times: the original
 * WordPress declared the bare host (its cached homepage's canonical reads
 * `https://tftstar.com/`), the owner then asked for `www` as the only address, then said
 * there are no redirects at all and each domain is simply itself, and on 2026-11-07 the
 * deployed site was measured answering the bare host with a `301` to `www` - a rule in
 * the Cloudflare zone, not in this repository - so `www` is declared again, this time
 * because the wire says so. What does not depend on that choice: whichever spelling the
 * build declares, the *other* one must not appear in a page, because a document naming
 * two hosts makes its own canonical ambiguous - and a page that canonicalises to a host
 * nobody serves from still renders perfectly, which is why this is gated rather than
 * eyeballed. The other spelling is derived from the declared one, so flipping the
 * constant flips the assertion too, and a half-changed build cannot pass it.
 *
 * The robots line and the sitemap are asserted the same way, and each is re-derived
 * with the builder's own function rather than compared against a second copy of the
 * rule: the robots line must equal the build's origin and re-applying the rewrite must
 * change nothing, and every <loc> must sit on that host.
 */
const declaredHost = new URL(siteOrigin).host;
const otherHost = declaredHost.startsWith('www.') ? declaredHost.slice(4) : `www.${declaredHost}`;
const otherOrigin = siteOrigin.replace(declaredHost, otherHost);
const robotsText = exists(join(paths.dist, 'robots.txt')) ? readFileSync(join(paths.dist, 'robots.txt'), 'utf8') : '';
const sitemapLine = (robotsText.match(/^Sitemap: (\S+)/m) || [])[1] ?? '(no line)';

check(
  'robots.txt names the sitemap on the host the build serves from',
  sitemapLine === `${siteOrigin}/sitemap.xml` && rewriteRobotsSitemap(robotsText, siteOrigin) === robotsText,
  `line: ${sitemapLine}, origin: ${siteOrigin}`,
);

// The capture group, not the whole match: `String.match` with /g hands back the
// surrounding `<loc>` tags too, and every entry then "fails" a startsWith on the URL.
const locs = [...readFileSync(join(paths.dist, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
const offHostLocs = locs.filter((loc) => !loc.startsWith(`${siteOrigin}/`));
check(
  'every sitemap <loc> is on that same host',
  offHostLocs.length === 0,
  `${offHostLocs.length} of ${locs.length}: ${offHostLocs.slice(0, 2).join(', ')}`,
);

const ambiguousPages = documents.filter((doc) => doc.text.includes(otherOrigin));
check(
  `no page names the other spelling of this host (${otherHost})`,
  ambiguousPages.length === 0,
  `${ambiguousPages.length} page(s): ${ambiguousPages.slice(0, 3).map((doc) => doc.rel).join(', ')}`,
);

/**
 * And the canonical has to name the host, not just a path.
 *
 * This is the assertion that caught the second deployment shipping `href="/"`: when a
 * site is served from the same domain the backup was taken from, the pass that turns
 * same-site absolute URLs into root-relative ones reaches the identity fields too, and a
 * canonical that resolves against whichever host the visitor arrived on is not a
 * canonical rule - it is the absence of one.
 *
 * Coverage is deliberately not asserted. 54 of the 138 shipped pages carry no canonical
 * at all - 26 English pages, 24 category archives, the three shop pages and the 404
 * document this build writes itself - and measured against the cache, that is what the
 * origin printed: a mirror may not invent a field the source never had. What is asserted
 * instead is the one failure a mirror can actually cause: dropping a canonical the source
 * did declare. That comparison runs per page against the cache, so the count of missing
 * ones is allowed to be whatever the origin made it.
 */
const canonicalOf = (text) => (text.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i) || [])[1] ?? null;
const wrongCanonicals = documents
  .map((doc) => ({ rel: doc.rel, href: canonicalOf(doc.text) }))
  .filter((entry) => entry.href !== null && !entry.href.startsWith(`${siteOrigin}/`));

check(
  'every canonical in the output is an absolute URL on the declared host',
  wrongCanonicals.length === 0,
  `${wrongCanonicals.length} wrong of ${documents.filter((doc) => canonicalOf(doc.text) !== null).length} declared${wrongCanonicals.length ? `, e.g. ${wrongCanonicals[0].rel} -> ${wrongCanonicals[0].href}` : ''}`,
);

const droppedCanonicals = [];

for (const page of discover(paths.pageCache).filter((page) => !isOwnerRemoved(page.urlPath))) {
  const doc = builtByPath.get(page.urlPath.endsWith('/') ? page.urlPath : `${page.urlPath}/`);
  if (!doc) continue;

  const source = canonicalOf(readFileSync(page.file, 'utf8'));
  if (source !== null && canonicalOf(doc.text) === null) droppedCanonicals.push(doc.rel);
}

check(
  'no page lost a canonical the cached page declared',
  droppedCanonicals.length === 0,
  `${droppedCanonicals.length} page(s): ${droppedCanonicals.slice(0, 3).join(', ')}`,
);

const identityLeft = documents.filter((doc) => absoluteIdentityUrls(doc.text, siteOrigin).absolutised > 0);
check(
  'and running that rule again over the output has nothing left to fix',
  identityLeft.length === 0,
  `${identityLeft.length} page(s): ${identityLeft.slice(0, 3).map((doc) => doc.rel).join(', ')}`,
);

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

  /**
   * And the saved stylesheets must be self-contained: they were written by rewriting
   * Google's own url() values, so a font file that was named but not downloaded is a
   * glyph that silently falls back - the same class of half-done state as shipping the
   * manifest while still calling Google, and it is only visible on one browser.
   */
  const savedSheets = [...known].filter((rel) => rel.startsWith('fonts/') && rel.endsWith('.css'));
  const faceFiles = new Set();
  const stillRemote = [];

  for (const rel of savedSheets) {
    const text = readFileSync(join(paths.dist, rel), 'utf8');
    if (/fonts\.(gstatic|googleapis)\.com/.test(text)) stillRemote.push(rel);
    for (const match of text.matchAll(/url\(['"]?\/fonts\/([^'")\s]+)/g)) faceFiles.add(`fonts/${match[1]}`);
  }

  check(
    'the saved font stylesheets name font files that are in the output',
    savedSheets.length > 0 && faceFiles.size > 0 && [...faceFiles].every((rel) => known.has(rel)),
    `${savedSheets.length} stylesheet(s), ${faceFiles.size} font file(s), ${[...faceFiles].filter((rel) => !known.has(rel)).length} without a file`,
  );
  check(
    'no saved font stylesheet still points at Google',
    stillRemote.length === 0,
    `${stillRemote.length} file(s): ${stillRemote.slice(0, 2).join(', ')}`,
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

/* 7h. the two defects a browser reports only in its own console ------------- */

/**
 * Both of these were invisible in the build output, which is why they survived until
 * someone opened devtools. Elementor's generated CSS pointed the homepage banner's
 * backgrounds at the owner's older domain, whose certificate does not validate, so
 * every visitor saw a banner with no picture; and Elementor's webpack runtime asks for
 * hashed chunk files by a name no page or stylesheet mentions, so the widget threw
 * ChunkLoadError and stopped working.
 *
 * The checks re-run the builder's own finders against the shipped files rather than
 * counting numbers written down here, for the usual reason: a second copy of a rule is
 * a rule that can drift, and drift in this direction looks like success.
 */
const foreignCss = [];
const missingChunks = [];
const bannerRefs = new Set();

for (const file of files.filter((f) => /\.(?:css|js)$/.test(f.rel))) {
  const text = readFileSync(file.abs, 'utf8');

  // available: () => true means "there is still something here to point locally", so a
  // stylesheet that was handled is left alone and one that was not is named.
  if (file.rel.endsWith('.css')) {
    if (localizeCssAssetUrls(text, { available: () => true }).text !== text) foreignCss.push(file.rel);
    for (const match of text.matchAll(/url\(\s*['"]?(\/wp-content\/[^'"?)]*10001[^'")?]*)/gi)) bannerRefs.add(match[1]);
  }

  const dir = file.rel.slice(0, file.rel.lastIndexOf('/') + 1);
  for (const name of jsChunkNames(text)) {
    if (!known.has(`${dir}${name}`)) missingChunks.push(`${file.rel} -> ${dir}${name}`);
  }
}

check(
  'no stylesheet still points a file we ship at another domain',
  foreignCss.length === 0,
  `${foreignCss.length} file(s): ${foreignCss.slice(0, 2).join(', ')}`,
);
check(
  'the banner backgrounds those stylesheets now name are in the output',
  bannerRefs.size > 0 && [...bannerRefs].every((rel) => known.has(rel.replace(/^\/+/, ''))),
  `${bannerRefs.size} reference(s), ${[...bannerRefs].filter((rel) => !known.has(rel.replace(/^\/+/, ''))).length} without a file`,
);
check(
  'every chunk a copied script asks for by name was copied',
  missingChunks.length === 0,
  `${missingChunks.length} missing: ${missingChunks.slice(0, 2).join('; ')}`,
);

/* 7i. the AJAX-only widgets are gone, and nothing else went with them ---------- */

/**
 * The front pages carry a Woodmart tabs widget whose panes two to four come from
 * admin-ajax.php, and a swatch filter form whose results come from the same place, so
 * the build cuts both. Three ways that edit can be wrong, all computed from the cache
 * and the output rather than from numbers written down here:
 *
 *   - the widget can still be on a page, which is a rule that cannot see its input;
 *   - the section that held it can be left standing empty, which shows as a blank band
 *     with the old padding - a new defect wearing the layout it replaced;
 *   - and the cut can take content with it. That is the claim worth gating: every
 *     product and category link the cached page offered must still appear on the built
 *     page, from somewhere else on it. It is the difference between deleting a
 *     duplicate and deleting content, and no later reader has to trust a comment.
 */
const deadWidgetMarkers = DEAD_AJAX_WIDGETS.map((widget) => `elementor-widget-${widget}`);
const widgetsLeft = documents.filter((doc) => deadWidgetMarkers.some((marker) => doc.text.includes(marker)));

check(
  'no page still carries a widget that needs admin-ajax.php',
  widgetsLeft.length === 0,
  `${widgetsLeft.length} page(s): ${widgetsLeft.slice(0, 2).map((doc) => doc.rel).join(', ')}`,
);

/**
 * The tabs widget is kept for the grid it renders, so what has to be gone is its
 * control. Re-running the builder's own pass over the shipped page is the assertion:
 * if it still finds a spinner or a tab row to cut, the build did not cut it.
 */
const shellsLeft = documents.filter((doc) => removeDeadTabsNavigation(doc.text).removed > 0);

check(
  'no kept tabs widget still offers a spinner or a tab row that cannot switch',
  shellsLeft.length === 0,
  `${shellsLeft.length} page(s): ${shellsLeft.slice(0, 2).map((doc) => doc.rel).join(', ')}`,
);

/**
 * Catalogue links as paths, so an absolute source URL and a root-absolute one compare.
 *
 * Exactly one segment after `product/` or `product-category/`, because the looser form
 * also matched `/product/x/feed/` - and the mirror deletes those RSS endpoints on
 * purpose, which this gate then reported as content lost. A gate that flags deliberate
 * deletions is worse than no gate: the next reader learns to ignore the section.
 */
const CATALOGUE_PATH = /^\/(?:en\/)?(?:product|product-category)\/[^/]+\/?$/;

function catalogueLinks(text) {
  const found = new Set();

  for (const match of text.matchAll(/href="([^"]*\/product(?:-category)?\/[^"]*)"/g)) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(match[1], ORIGIN_URLS[0]).pathname);
    } catch {
      continue; // Not a URL at all, so not a link that could have been lost.
    }

    if (CATALOGUE_PATH.test(pathname)) found.add(pathname.endsWith('/') ? pathname : `${pathname}/`);
  }

  return found;
}

const emptySections = (text) => (text.match(/<div class="e-con-inner">\s*<\/div>/g) || []).length;
const lostLinks = [];
const lostCards = [];
let sectionsCached = 0;
let sectionsShipped = 0;

/**
 * Card counting is the claim that would have caught my first version of this edit: I
 * cut the whole tabs widget and the browser had to tell me the front page then showed
 * no products at all, because its body carries no other grid - the 56 `wd_products`
 * widgets are inside the header's hover dropdown. Comparing cards per page, source
 * against output, says in one number whether a deletion took content or only chrome.
 *
 * The subtraction below exists because the new-release build inserts a strip of
 * six `wd-new-release-card` items into the home page and 产品中心 listing. Those
 * cards do share the theme's `product-grid-item` class (that is the point - the
 * styling has to apply), so a naive count sees them as "the shipped page gained
 * cards" and this deletion-safety gate starts reporting the strip as a mirror
 * bug. Subtracting them keeps the gate about what it was written to protect -
 * the mirror's own deletion behaviour - and lets a separate gate below assert
 * the strip's own integrity against `data/new-products.json`.
 */
const cards = (text) =>
  (text.match(/class="product-grid-item/g) || []).length
  - (text.match(/class="product-grid-item wd-new-release-card/g) || []).length;

for (const page of discover(paths.pageCache).filter((page) => !isOwnerRemoved(page.urlPath))) {
  const doc = builtByPath.get(page.urlPath.endsWith('/') ? page.urlPath : `${page.urlPath}/`);
  if (!doc) continue;

  const source = readFileSync(page.file, 'utf8');
  for (const link of catalogueLinks(source)) {
    if (!catalogueLinks(doc.text).has(link)) lostLinks.push(`${page.urlPath} -> ${link}`);
  }

  if (cards(source) !== cards(doc.text)) lostCards.push(`${page.urlPath}: ${cards(source)} -> ${cards(doc.text)}`);

  sectionsCached += emptySections(source);
  sectionsShipped += emptySections(doc.text);
}

check(
  'removing those widgets removed no product or category from any page',
  lostLinks.length === 0,
  `${lostLinks.length} link(s) no longer reachable: ${lostLinks.slice(0, 3).join('; ')}`,
);
check(
  'no page gained or lost a product card on the way',
  lostCards.length === 0,
  `${lostCards.length} page(s) differ: ${lostCards.slice(0, 3).join('; ')}`,
);
check(
  'no page gained an empty section from the cut',
  sectionsShipped <= sectionsCached,
  `${sectionsCached} empty section(s) in the cache, ${sectionsShipped} in the output`,
);

/* 7j. every phone link dials this company ------------------------------------ */

/**
 * The theme's demo number survives in the invisible link Woodmart stretches over the
 * contact line, so the visible text said China and the href dialled New Zealand. This
 * re-runs the builder's own repair over the output: a page where it still finds
 * something to change is a page the build did not change. The expected value comes from
 * the same preference the builder used, and the distinct values are printed as evidence,
 * because "one number, 137 times" is the whole claim in one line.
 */
const telValues = new Map();
const unfixedPhones = [];

for (const doc of documents) {
  if (repairPhoneLinks(doc.text).html !== doc.text) unfixedPhones.push(doc.rel);
  for (const match of doc.text.matchAll(/href=(["'])tel:([^"']*)\1/gi)) {
    telValues.set(match[2], (telValues.get(match[2]) || 0) + 1);
  }
}

check(
  'no tel: link dials a number that is not the company\'s own',
  unfixedPhones.length === 0 && telValues.size === 1 && telValues.has(`+86${ENQUIRY_PHONE}`),
  `${telValues.size} distinct value(s): ${[...telValues].map(([value, count]) => `${value} x${count}`).join(', ')}`,
);

/**
 * The same class of defect as the widgets: a script that posts to admin-ajax.php on
 * load can only ever fail here, and it fails audibly only in a browser console - two to
 * four 404s and console errors on every English page, none on the Chinese pages that do
 * not load it. Three assertions, because the interesting risk is not that the tag
 * survives but that the fix eats the language switcher it sits next to:
 *
 *   - no page loads it (matched on the tag, not on the filename: the surviving
 *     `trp_data` config block mentions that name in a comment),
 *   - re-running the builder's rule over the output finds nothing, which is how a rule
 *     that cannot see its own input is told apart from one that already did its work,
 *   - and the machinery that must stay - the compatibility script, the plugin's config
 *     object and the floating selector markup - is counted per page against the cache,
 *     so nothing that used to be there quietly went with the script.
 */
const translatorPattern = DEAD_AJAX_SCRIPTS.map((name) => new RegExp(`<script[^>]*${name.replace(/[.]/g, '\\.')}[^>]*>`, 'i'));
const translatorPages = documents.filter((doc) => translatorPattern.some((pattern) => pattern.test(doc.text)));

check(
  'no page loads a script whose only working feature is a PHP endpoint',
  translatorPages.length === 0,
  `${translatorPages.length} page(s): ${translatorPages.slice(0, 2).map((doc) => doc.rel).join(', ')}`,
);

const scriptsLeft = documents.filter((doc) => removeDeadAjaxScripts(doc.text).count > 0);
check(
  'running that rule again over the output finds nothing left to remove',
  scriptsLeft.length === 0,
  `${scriptsLeft.length} page(s): ${scriptsLeft.slice(0, 2).map((doc) => doc.rel).join(', ')}`,
);

const countOf = (text, needle) => text.split(needle).length - 1;
const survivals = [];

/**
 * Sheet links are folded into bundles, and TranslatePress's own CSS filenames contain
 * the very strings this assertion counts (`trp-language-switcher.css` appears in both
 * the id and the href of one link). Counting them would report the merge as deleting
 * the switcher, so the links are removed from both sides first: what must survive is the
 * switcher's DOM, its config object and its compatibility script, all of which live in
 * the body, not in a stylesheet address.
 */
const outsideSheets = (text) => text.replace(SHEET_LINK, '');

for (const page of discover(paths.pageCache).filter((page) => !isOwnerRemoved(page.urlPath))) {
  const doc = builtByPath.get(page.urlPath.endsWith('/') ? page.urlPath : `${page.urlPath}/`);
  if (!doc) continue;

  const source = outsideSheets(readFileSync(page.file, 'utf8'));
  const built = outsideSheets(doc.text);
  for (const kept of ['trp-frontend-compatibility', 'trp_data', 'trp-floater', 'trp-language']) {
    if (countOf(source, kept) !== countOf(built, kept)) survivals.push(`${page.urlPath} ${kept}: ${countOf(source, kept)} -> ${countOf(built, kept)}`);
  }
}

check(
  'the language switcher and its config survived the removal untouched',
  survivals.length === 0,
  `${survivals.length} difference(s): ${survivals.slice(0, 3).join('; ')}`,
);

/* 8. the media conversions are complete in both directions ------------------- */

/**
 * `npm run images` is optional, so this section has two states and says which one it is
 * in, in the same shape as the fonts check above.
 *
 * When a manifest exists, none of what is worth asserting shows up in a browser. A page
 * can name a WebP that was never copied and still look correct wherever the original
 * happens to remain; a substitution can miss one spelling of one filename and quietly
 * keep shipping an 800 KB PNG; and the build can drop an original that a stylesheet -
 * which the page pass never rewrites - still asks for, which is a 404 on a product
 * photograph, the one failure this site cannot be seen to have.
 *
 * So the scan runs over every text file in the output rather than the pages alone, and
 * uses the builder's own matcher instead of a second copy of the rule: what the build
 * counted when it chose what to copy is exactly what is counted here. The stylesheet
 * bundles are text files too, so a url() that reached a bundle is still counted.
 */
const mediaManifest = exists(join(paths.work, 'media', 'manifest.json'))
  ? JSON.parse(readFileSync(join(paths.work, 'media', 'manifest.json'), 'utf8'))
  : null;

if (mediaManifest) {
  /** role: the jpg the backup had | the webp that replaces it | a video's first frame */
  const converted = new Map();

  for (const [from, entry] of Object.entries(mediaManifest.images)) {
    converted.set(from.replace(/^\/+/, ''), 'original');
    converted.set(entry.to.replace(/^\/+/, ''), 'webp');
  }
  for (const entry of Object.values(mediaManifest.posters)) {
    converted.set(entry.to.replace(/^\/+/, ''), 'poster');
  }

  const named = new Set();
  const pagesStillOnOriginals = [];

  for (const file of files.filter((entry) => /\.(html|css|js|json|xml|svg)$/i.test(entry.rel))) {
    const found = [...namedAssetPaths(readFileSync(file.abs, 'utf8'), mediaManifest)].filter((path) => converted.has(path));
    for (const path of found) named.add(path);

    // A stylesheet naming an original is legitimate - the build sees it and keeps the
    // file - but a page naming one means the substitution missed a spelling.
    const originals = file.rel.endsWith('.html')
      ? found.filter((path) => converted.get(path) === 'original')
      : [];
    if (originals.length > 0) pagesStillOnOriginals.push({ rel: file.rel, count: originals.length, first: originals[0] });
  }

  const missing = [...named].filter((path) => !known.has(path));
  check(
    'every converted file the output asks for is in the output',
    missing.length === 0,
    missing.length === 0 ? `${named.size} converted file(s) named, all present` : `${missing.length} missing: ${missing.slice(0, 3).join(', ')}`,
  );

  const unreferenced = [...converted].filter(([path, role]) => role !== 'original' && !named.has(path) && known.has(path));
  check(
    'nothing ships a converted file no document asks for',
    unreferenced.length === 0,
    `${unreferenced.length} unreferenced: ${unreferenced.slice(0, 3).map(([path]) => path).join(', ')}`,
  );

  check(
    'no page still asks for an image that has a webp',
    pagesStillOnOriginals.length === 0,
    pagesStillOnOriginals.length === 0
      ? `${Object.keys(mediaManifest.images).length} converted image(s) named by pages, every one as webp`
      : `${pagesStillOnOriginals.length} page(s), e.g. ${pagesStillOnOriginals[0].rel} (${pagesStillOnOriginals[0].count} reference(s), ${pagesStillOnOriginals[0].first})`,
  );

  const bareVideos = documents.flatMap((doc) => [...doc.text.matchAll(/<video\b[^>]*>/gi)]
    .filter((match) => {
      const source = (match[0].match(/\b(?:data-lazy-load|data-src|data-wood-src|src)="([^"]+\.(?:mp4|m4v|webm|ogv|ogg))"/i) || [])[1];
      return source && mediaManifest.posters[keyForReference(source)] && !/\bposter=/i.test(match[0]);
    })
    .map(() => doc.rel));
  check(
    'every video with a converted source shows a frame before it plays',
    bareVideos.length === 0,
    `${bareVideos.length} tag(s) without a poster${bareVideos[0] ? `, e.g. ${bareVideos[0]}` : ''}`,
  );

  /**
   * The weight line, stated only in terms this file can see.
   *
   * "46 MB saved" would be a claim about a build that was not run, so instead: how many
   * converted files the output names, how many originals are not in the deploy, how many
   * bytes the shipped media actually is - and how many of those originals were never in
   * the backup either, which is not a saving won here and gets said separately.
   */
  const dropped = Object.entries(mediaManifest.images).filter(([from]) => !known.has(from.replace(/^\/+/, '')));
  const replaced = dropped.filter(([from]) => exists(join(paths.docroot, from.replace(/^\/+/, ''))));
  const neverInBackup = dropped.length - replaced.length;
  const convertedKb = Math.round([...named].filter((path) => known.has(path))
    .reduce((total, path) => total + statSync(join(paths.dist, path)).size, 0) / 1024);

  notes.push(`  info  media: ${named.size} converted path(s) asked for, ${replaced.length} original(s) not in the deploy, ${convertedKb} KB of webp shipped in their place${neverInBackup ? `, ${neverInBackup} of them never in the backup either` : ''}`);
} else {
  notes.push('  info  media: npm run images has not been run, so every picture ships as the backup had it');
}

/* 9. the static search replaces the origin's AJAX one ------------------------- */

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

/* 7k. new-release integrity --------------------------------------------------- */

/**
 * The mirror's own gates above assert "the shipped site is what the backup
 * rendered". These assert "the new-release build produced what
 * `data/new-products.json` says it should", which is the same style of
 * claim (source of truth -> artefact on disk) but on the authored half of
 * the site. Every one of them compares a file count to a JSON count, so
 * they still pass when there are zero new releases (both sides empty) and
 * fail the moment the render silently drops a page or a media file.
 *
 * The count assertions come in pairs. "Page directories match the records"
 * proves the render wrote every file; "the pages the sitemap lists all
 * exist" proves the sitemap did not drift. A bug in either direction shows
 * up as a real number in the failure message, not as an empty list that
 * could also mean "the check ran and saw nothing".
 */
const newProductsPath = join(paths.data, 'new-products.json');
if (exists(newProductsPath)) {
  const newProducts = readJson(newProductsPath);
  const built = newProducts.filter((r) => !r.skip);
  const skipped = newProducts.length - built.length;

  const expectedSlugs = built.map((r) => r.slug).sort();

  const zhSlugs = readdirSync(join(paths.dist, 'product'))
    .filter((n) => n.startsWith('new-')).sort();
  const enSlugs = readdirSync(join(paths.dist, 'en/product'))
    .filter((n) => n.startsWith('new-')).sort();

  check(
    'every new-release product has a Chinese page on disk',
    sameStrings(zhSlugs, expectedSlugs),
    `expected ${expectedSlugs.length}, found ${zhSlugs.length} (skipped ${skipped})`,
  );
  check(
    'every new-release product has an English page on disk',
    sameStrings(enSlugs, expectedSlugs),
    `expected ${expectedSlugs.length}, found ${enSlugs.length}`,
  );

  /**
   * Media files. Each record in the render manifest lists the URLs its
   * pages name; each URL has to resolve to a file under
   * `dist/uploads/new-releases/`. This is the same claim the mirror's
   * "every referenced asset resolves inside dist" makes for cache pages,
   * scoped to the new tree so it can fail with a specific slug in the
   * message rather than one of 1400 uploads paths.
   */
  const missingMedia = [];
  for (const doc of documents) {
    if (!doc.rel.startsWith('product/new-') && !doc.rel.startsWith('en/product/new-')) continue;
    if (!doc.rel.endsWith('index.html')) continue;
    for (const url of mediaUrlsIn(doc.text)) {
      if (!resolvesInOutput(known, url)) missingMedia.push(`${doc.rel} -> ${url}`);
    }
  }
  check(
    'every media file a new-release page names is in the output',
    missingMedia.length === 0,
    `${missingMedia.length} reference(s) unresolved: ${missingMedia.slice(0, 3).join('; ')}`,
  );

  /**
   * The strip's six cards on home + 产品中心. Six in Chinese, six in
   * English, four pages, matching `strip.mjs`'s STRIP_CARDS. If the
   * insertion regressed (the strip landed on three pages instead of four,
   * or a rename broke the marker), this number moves and the message
   * names which page came up short.
   */
  const stripPages = documents.filter((doc) => doc.text.includes('data-new-release-strip'));
  check(
    'the new-release strip sits on the four pages the owner asked for',
    stripPages.length === 4,
    `${stripPages.length} page(s) carry a strip (want 4: home, /en/, 产品中心, /en/产品中心/)`,
  );

  /**
   * Sitemap `<loc>` count: the mirror's own pages, plus two per new
   * release (zh + en), plus the two category listing pages. If render
   * writes pages but the sitemap append fails, the site silently loses
   * every new-release page to search engines - which is what this
   * assertion prevents.
   */
  const sitemapText = readFileSync(join(paths.dist, 'sitemap.xml'), 'utf8');
  const locCount = (sitemapText.match(/<loc>/g) || []).length;
  const expectedLoc = 137 + built.length * 2 + 2;
  check(
    'sitemap carries every new-release page and the category listing',
    locCount === expectedLoc,
    `${locCount} <loc> in dist, ${expectedLoc} expected (137 mirror + ${built.length * 2} products + 2 category)`,
  );

  /**
   * Search index entries. The mirror wrote 68 (34 products x 2 langs);
   * the new-release build appended two per record. If the append drops
   * silently, a buyer searching "新品发布" sees nothing even though the
   * pages exist.
   */
  const searchIndex = readJson(join(paths.dist, 'search.json'));
  const expectedEntries = 68 + built.length * 2;
  check(
    'the static search index carries every new-release page',
    searchIndex.length === expectedEntries,
    `${searchIndex.length} entries, ${expectedEntries} expected (68 mirror + ${built.length * 2} new-release)`,
  );
}

function sameStrings(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The media URLs a page names, in the same shape `known` uses for its
 * keys (root-relative, forward-slashed, still percent-encoded the way the
 * page writes it). Restricted to the new-release tree so this assertion
 * does not re-litigate every asset the mirror already covers.
 */
function mediaUrlsIn(html) {
  const out = new Set();
  for (const m of html.matchAll(/(?:src|href|poster)="(\/uploads\/new-releases\/[^"]+)"/g)) {
    out.add(m[1].slice(1));
  }
  return out;
}

console.log('\n  mirror checks\n');
for (const line of [...notes, ...failures]) console.log(line);
console.log(failures.length ? `\n  ${failures.length} failure(s)\n` : '\n  all checks passed\n');
process.exit(failures.length ? 1 : 0);
