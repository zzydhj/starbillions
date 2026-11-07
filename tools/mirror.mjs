/**
 * Build the static mirror from the site's own rendered page cache.
 *
 *   node tools/mirror.mjs [--site-origin https://example.com] [--dry]
 *
 * The input is WP Rocket's cache under work/wp/.../cache/wp-rocket/<host>/, which
 * holds the HTML WordPress finished producing: complete documents with the theme's
 * header and footer, for both languages. That is why no PHP is needed here, and why
 * the result can be a true 1:1 rather than a reconstruction.
 *
 * Three things are decided in this file rather than assumed:
 *
 * 1. Which variant to ship. Every cached page exists as a desktop
 *    (index-https.html) and a mobile (index-mobile-https.html) document, served
 *    apart by User-Agent. A static host cannot vary on User-Agent, so the desktop
 *    document is the one that ships, and the three pages that only have a mobile
 *    variant fall back with a report instead of silently differing.
 *
 * 2. Which URL a page is. Taken from the directory it was cached in, because that
 *    tree mirrors the site's URL path segment for segment. The canonical link is
 *    read only to cross-check it: 97 of the 217 cached pages - every archive, the
 *    shop, the blog, categories, an author page and the paginated pages - carry no
 *    canonical at all, which is WordPress behaviour on those templates rather than
 *    damage in the backup. Keying on the canonical would have deleted 45% of the
 *    mirror's pages, including the whole product catalogue's structure.
 *
 * 3. What happens to a reference. Handled by staticize.js: same-site files are
 *    copied and written as root-absolute paths, cart and account links are removed
 *    by the earlier decision, and head metadata keeps an absolute URL on the new
 *    origin because a canonical pointing at the old host would tell search engines
 *    this mirror is somebody else's copy.
 *
 * The desktop and mobile files are byte-identical for 214 of the 217 directories,
 * so preferring one of them costs nothing; the three that exist only as mobile are
 * reported rather than skipped.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, writeFile as writeFileAsync } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dirname as posixDirname, join as posixJoin, resolve as posixResolve } from 'node:path/posix';
import { paths } from './lib/paths.js';
import { exists, removeTree, copyTree, walk } from './lib/fs-utils.js';
import { applyMediaManifest, mediaOutputs, namedAssetPaths, prunableOriginals, unaskedOutputs } from './media/apply.js';
import { ENQUIRE_LABELS, ENQUIRY_PHONE, SITE_ORIGIN, rewriteRobotsSitemap, CONTACT_FORM_LABELS, MOBILE_TOOLBAR, enableStaticSearch, localizeGoogleFonts, replaceContactForm, replaceMapWithAddress, replaceMobileToolbar, repairMenuLinks, repairPhoneLinks, rewriteInquireButtons, translateEnglishTitle, updateCopyrightYear, whatsappUrlFor } from './lib/site-links.js';
import { buildSearchIndex } from './ingest/wp/search-index.js';
import {
  cascadeShape,
  combineStylesheets,
  fileReferencesIn,
  internalUrl,
  isExcluded,
  isOwnerRemoved,
  jsChunkNames,
  localizeCssAssetUrls,
  moveLanguageFloater,
  originSet,
  rebaseIdentityUrls,
  referencesIn,
  removeDeadAjaxScripts,
  absoluteIdentityUrls,
  DEAD_AJAX_SCRIPTS,
  removeDeadAjaxWidgets,
  removeDeadShopControls,
  removeDeadTabsNavigation,
  removeOwnerMenuItems,
  rewriteReferences,
  rootifyOrigins,
  safeDecode,
  stripLanguagePrefix,
  toOutputPath,
} from './ingest/wp/staticize.js';

const VARIANTS = ['index-https.html', 'index.html', 'index-mobile-https.html'];
const MOBILE = 'index-mobile-https.html';

// The enquiry button labels and the number they should reach are the owner's
// preference, held in lib/site-links.js so the deployment gate checks the same values
// this builder applied.

const args = process.argv.slice(2);
const siteOrigin = valueAfter('--site-origin') ?? SITE_ORIGIN;
const floaterPosition = valueAfter('--language-floater') ?? 'top-right';
const whatsapp = whatsappUrlFor(valueAfter('--whatsapp') ?? ENQUIRY_PHONE);
const dry = args.includes('--dry');

const origins = originSet();

/* discover ------------------------------------------------------------------ */

/**
 * Every cached page, as { urlPath, file, variant, mobileOnly, canonical }.
 *
 * Directory names on disk are percent-encoded exactly as the browser requested
 * them, so decoding one gives the real path segment; the output file keeps the
 * decoded form, which is how the host resolves a percent-encoded request to it -
 * the same arrangement the site's own uploads already use.
 */
export function discover(cacheRoot) {
  const found = [];

  const visit = (dir, relative) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const html = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.html'));

    if (html.length > 0) {
      const names = new Set(html.map((entry) => entry.name));
      const chosen = VARIANTS.find((name) => names.has(name));
      const urlPath = relative === '' ? '/' : `${decodeURIComponent(relative)}/`;
      const text = readFileSync(join(dir, chosen), 'utf8');

      found.push({
        urlPath,
        file: join(dir, chosen),
        variant: chosen,
        mobileOnly: chosen === MOBILE,
        canonical: canonicalOf(text),
        bytes: Buffer.byteLength(text),
      });
    }

    for (const entry of entries) {
      if (entry.isDirectory()) visit(join(dir, entry.name), `${relative}/${entry.name}`);
    }
  };

  visit(cacheRoot, '');
  return found;
}

/** Reads the canonical URL out of a rendered document, tolerating attribute order. */
function canonicalOf(text) {
  for (const match of text.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/rel=["']?canonical["']?/i.test(tag)) continue;

    const href = /href=["']([^"']+)["']/i.exec(tag);
    if (href) return href[1];
  }

  return null;
}

/* build --------------------------------------------------------------------- */

export async function build({ quiet = false } = {}) {
  const started = Date.now();
  const report = quiet ? () => {} : (label, detail) => console.log(`  ${label.padEnd(12)} ${detail}`);

  const cached = discover(paths.pageCache);
  const pages = cached
    // Content the owner decided not to ship is not built at all. The same predicate
    // inside isExcluded removes the links that pointed at it, so one list governs
    // both halves and they cannot disagree about what exists.
    .filter((page) => !isOwnerRemoved(page.urlPath))
    .map((page) => ({
      ...page,
      outPath: toOutputPath(new URL(`https://tftstar.com${page.urlPath}`)),
      pageUrl: `https://tftstar.com${page.urlPath}`,
    }));
  const notBuilt = cached.length - pages.length;

  /**
   * Pages whose own canonical link disagrees with the directory holding them.
   *
   * Both cannot be served from one file, so the directory wins and the disagreement
   * is reported: it means the cache was written under one permalink scheme and later
   * rendered under another, which is exactly what happened to this site's blog URLs.
   */
  const mismatched = pages.filter((page) => page.canonical !== null
    && decodeURIComponent(new URL(page.canonical).pathname) !== page.urlPath);

  /**
   * What the mirror will contain, as a set of URL paths.
   *
   * A link to a page outside this set stays as written and is reported: the cache
   * only holds pages someone visited, so archives and tag pages that were never
   * rendered are genuinely missing, and silently rewiring them would invent
   * structure the site did not have.
   */
  const knownPages = new Set(pages.map((page) => page.urlPath));

  const assets = new Map();
  const unknownPages = new Map();
  const missingFiles = new Set();

  for (const page of pages) {
    const text = readFileSync(page.file, 'utf8');

    // Files first, found by path shape rather than attribute name: Woodmart's own
    // lazy loading hides behind data-wood-src and Elementor inside data-settings
    // JSON, and an attribute list silently missed both.
    for (const reference of fileReferencesIn(text)) {
      const path = assetKey(safeDecode(reference));
      if (assets.has(path)) continue;

      const present = exists(join(paths.docroot, path));
      assets.set(path, present ? 'copy' : 'absent');
      if (!present) missingFiles.add(path);
    }

    // Then page links, to learn which targets the origin never rendered.
    for (const raw of referencesIn(text)) {
      const url = internalUrl(raw, origins, page.pageUrl);
      if (url === null || isExcluded(url)) continue;

      // Not assetKey(): this is a page path, matched against knownPages, and those
      // keys keep the leading slash the cache directories were named from.
      const path = safeDecode(decodeURIComponent(url.pathname));
      if (hasExtension(path)) continue;

      if (!knownPages.has(path.endsWith('/') ? path : `${path}/`)) {
        unknownPages.set(path, (unknownPages.get(path) ?? 0) + 1);
      }
    }
  }

  report('pages', `${pages.length} rendered, ${knownPages.size} distinct URLs, ${mismatched.length} canonical mismatch`);

  /**
   * Second hop: what the copied stylesheets themselves ask for.
   *
   * Scanning pages cannot see these, and Font Awesome's whole web-font set was
   * missing for exactly that reason - icons simply did not render. A relative url()
   * resolves against the stylesheet's own directory and the file keeps that
   * directory in the output, so the reference stays correct without rewriting CSS.
   */
  const fromCss = new Set();
  const cssRewrites = new Map();
  const copiedStylesheets = [...assets].filter(([, kind]) => kind === 'copy').filter(([path]) => path.endsWith('.css'));

  for (const [path] of copiedStylesheets) {
    const text = readFileSync(join(paths.docroot, assetKey(path)), 'utf8');

    for (const match of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
      const raw = safeDecode(match[1].split('?')[0].split('#')[0]);
      if (raw.startsWith('data:') || raw.startsWith('#')) continue;

      const target = raw.startsWith('/') ? raw : posixResolve(posixDirname(posixJoin('/', path)), raw);
      const rel = target.replace(/^\/+/, '');

      if (!rel.startsWith('wp-content/') && !rel.startsWith('wp-includes/')) continue;
      if (assets.has(rel)) continue;

      const present = exists(join(paths.docroot, rel));
      assets.set(rel, present ? 'copy' : 'absent');
      if (!present) missingFiles.add(rel);
      else fromCss.add(rel);
    }

    /**
     * The case copying cannot reach: a url() WordPress wrote absolutely to another
     * host. Elementor did exactly that for the homepage banner backgrounds, and the host
     * is the owner's older domain, starbillions.cn. Why those images failed to load in
     * the browser was never re-verified (the note here used to claim a bad certificate,
     * and both spellings of that host answer over HTTPS when checked on 2026-11-07), but
     * the fix does not depend on the reason: a shipped page must not fetch its artwork
     * from a domain this build does not control. The identical bytes are in the backup at
     * the identical path, which makes this a pointer rather than a substitution of
     * someone's artwork. A url() naming a file we do not have keeps its original text:
     * aiming at a hole we made is worse to explain than aiming at a host that at least
     * has the picture.
     */
    const localized = localizeCssAssetUrls(text, {
      available: (rel) => exists(join(paths.docroot, assetKey(rel))),
    });
    if (localized.text === text) continue;

    cssRewrites.set(assetKey(path), localized.text);
    for (const rel of localized.local) {
      const key = assetKey(rel);
      if (assets.has(key)) continue;
      assets.set(key, 'copy');
      fromCss.add(key);
    }
  }

  /**
   * Third hop: the chunks a copied script asks for by name at run time.
   *
   * Elementor's webpack runtime maps chunk ids to file names inside the loader, so no
   * page and no stylesheet names these files - reading the script that asks for them is
   * the only way to find out they are wanted. Their absence is not silent either: the
   * browser logs a ChunkLoadError and that one widget stops working, which reads as a
   * broken theme rather than a missing file.
   */
  const fromJs = new Set();
  const copiedScripts = [...assets].filter(([, kind]) => kind === 'copy').filter(([path]) => path.endsWith('.js'));

  for (const [path] of copiedScripts) {
    const text = readFileSync(join(paths.docroot, assetKey(path)), 'utf8');

    for (const name of jsChunkNames(text)) {
      const key = assetKey(posixJoin(posixDirname(posixJoin('/', path)), name));
      if (assets.has(key)) continue;

      const present = exists(join(paths.docroot, key));
      assets.set(key, present ? 'copy' : 'absent');
      if (!present) missingFiles.add(key);
      else fromJs.add(key);
    }
  }

  report('from CSS', `${fromCss.size} files reachable only through a stylesheet url()`);
  report('from JS', `${fromJs.size} chunk(s) a copied script asks for by name`);
  report('other host', `${cssRewrites.size} stylesheet(s) rewritten to point at local copies`);
  report('assets', `${[...assets].filter(([, kind]) => kind === 'copy').length} to copy, ${missingFiles.size} referenced but absent`);

  if (dry) {
    console.log('\n  --dry: nothing written\n');
    return { pages: usable.length, assets: assets.size };
  }

  removeTree(paths.dist);

  let written = 0;
  let copied = 0;
  let homeHtml = '';
  const stats = { rewritten: 0, dropped: 0, inquireLinks: 0, searchWired: 0, shopControls: 0, cards: 0, mobileBars: 0, menuLinks: 0, menuHrefsDropped: 0, titlesFixed: 0, copyrightYears: 0, formsReplaced: 0, mapsReplaced: 0, fontsLocal: 0, fontsMissing: 0, demoMenuItems: 0, deadWidgets: 0, deadTabControls: 0, deadScripts: 0, phoneLinks: 0, identityUrls: 0, mediaImages: 0, mediaPosters: 0 };
  // Written by npm run fonts. An absent manifest is a normal state - the mirror has
  // no network step - so it reads as "keep the original links", not as an error.
  const fontManifestPath = join(paths.public, 'fonts', 'manifest.json');
  const fontManifest = exists(fontManifestPath) ? JSON.parse(readFileSync(fontManifestPath, 'utf8')) : {};
  /**
   * WebP and video posters, written by npm run images. An absent manifest is a normal
   * state - the mirror has no image codec, and Pages runs no build at all - so the site
   * ships the backup's own bytes: a heavier page, not a broken one.
   */
  const mediaManifestPath = join(paths.work, 'media', 'manifest.json');
  const mediaManifest = exists(mediaManifestPath) ? JSON.parse(readFileSync(mediaManifestPath, 'utf8')) : null;
  const mediaFilesDir = join(paths.work, 'media', 'files');
  // Inputs for the search index, gathered while writing rather than re-read from disk:
  // the index must describe the pages that were actually shipped, not the cache files
  // they came from.
  const productPages = [];
  const categoryPages = [];

  for (const page of pages) {
    const text = readFileSync(page.file, 'utf8');
    const rebased = rebaseIdentityUrls(text, origins, siteOrigin);

    // Menu items for removed content are cut whole, while their href can still be
    // recognised; the URL pass below would only strip the attribute and leave an
    // inert label in the header.
    const demenued = removeOwnerMenuItems(rebased);
    stats.demoMenuItems += demenued.removed;

    // AJAX-only widgets go next: they are recognised by their Elementor class, which
    // the URL pass neither adds nor removes, so order does not matter here - but they
    // must go before the search index and the card count are gathered, because those
    // describe what the shipped page actually holds.
    const unwidged = removeDeadAjaxWidgets(demenued.html);
    stats.deadWidgets += unwidged.count;

    // The tabs widget keeps its rendered grid, so only its spinner and tab row go.
    const detabbed = removeDeadTabsNavigation(unwidged.html);
    stats.deadTabControls += detabbed.removed;

    // And the script that only exists to ask PHP for translations: on English pages it
    // fired 2-4 POSTs per load, all 404, and on this host it can never do anything else.
    const unscripted = removeDeadAjaxScripts(detabbed.html);
    stats.deadScripts += unscripted.count;

    const out = rewriteReferences(unscripted.html, {
      pageUrl: page.pageUrl,
      origins,
      /**
       * Every same-site reference gets a root-absolute path.
       *
       * Returning nothing would leave the original https://tftstar.com text in the
       * page, and a mirror that links back to the dead origin is not a mirror. So an
       * uncached page still becomes /that/page/ and hits the site's own 404, and an
       * asset missing from the backup loses its attribute - broken there, broken on
       * the original host too, since this file tree is the original host's.
       */
      classify: (url) => {
        const path = assetKey(safeDecode(decodeURIComponent(url.pathname)));
        if (hasExtension(path)) return assets.get(path) === 'copy' ? 'copy' : 'drop';
        return 'page';
      },
    });

    // Two passes the attribute rewrite cannot do: URLs buried in Elementor's
    // data-settings JSON and Woodmart's inline scripts, and the language prefix
    // TranslatePress baked into menu links.
    const stripped = stripLanguagePrefix(rootifyOrigins(out.html, origins, siteOrigin));

    // Identity fields want the opposite of assets: a canonical that resolves against
    // "whichever host the visitor arrived on" is not a canonical rule but the absence of
    // one. This only has work to do where the site is served from the same domain the
    // backup came from - the second deployment - so here it counts zero, and the count is
    // reported rather than assumed.
    const identified = absoluteIdentityUrls(stripped, siteOrigin);
    stats.identityUrls += identified.absolutised;

    const html = identified.html;

    // The floating language switcher sat bottom-right, on top of the theme's mobile
    // toolbar. Moved by swapping the plugin's own position class, not by overriding.
    const positioned = moveLanguageFloater(html, floaterPosition);

    // The owner's one requested departure from 1:1 so far: product enquiry buttons
    // go to WhatsApp instead of a contact page on a third domain.
    const edited = rewriteInquireButtons(positioned, whatsapp, ENQUIRE_LABELS);

    // The toolbar's per-page counts and column icons: no code on the site, or on the
    // origin, can act on them, so they are cut rather than promised.
    const cleaned = removeDeadShopControls(edited);

    // The controls sit beside the loop, never inside it, so the card count cannot
    // move. If it ever does, the tag matching has eaten products, and that is a
    // silent content loss no later check would describe accurately.
    //
    // Matched without the closing quote, because a card's class list continues after
    // this name; with the quote both counts read zero and the guard passes while
    // measuring nothing.
    const cardsBefore = occurrences(edited, 'class="product-grid-item');
    const cardsAfter = occurrences(cleaned.html, 'class="product-grid-item');
    if (cardsAfter !== cardsBefore) {
      throw new Error(`${page.urlPath}: removing the shop toolbar changed the product card count (${cardsBefore} -> ${cardsAfter})`);
    }

    // Three items labelled `123` pointed every phone visitor at a preview host that
    // is not this site. Rebuilt with entries that resolve, per language.
    const bar = replaceMobileToolbar(cleaned.html, page.urlPath.startsWith('/en/') ? MOBILE_TOOLBAR.en : MOBILE_TOOLBAR.zh);

    // The metform contact form posts to a REST endpoint a static host cannot answer:
    // a filled-in form, a press, and no answer and no error. One button, same markup
    // the product enquiry buttons use, on every page carrying the widget.
    const form = replaceContactForm(bar.html, {
      whatsappUrl: whatsapp,
      label: page.urlPath.startsWith('/en/') ? CONTACT_FORM_LABELS.en : CONTACT_FORM_LABELS.zh,
    });

    // The map iframe is Google, which does not answer in the visitors' country; the
    // address is already in the iframe's own title, per language, so nothing is
    // invented by dropping the embed and keeping the words.
    const mapped = replaceMapWithAddress(form.html);

    // Only rewrites when npm run fonts has produced a manifest; without one the
    // original links stay and the gate says so rather than shipping a 404.
    const fonts = localizeGoogleFonts(mapped.html, fontManifest);

    // Two stale facts the source baked into every page: a copyright year that has
    // since passed, and menu items whose URL field was filled with a bare number.
    const dated = updateCopyrightYear(fonts.html);
    const linked = repairMenuLinks(dated);

    // And the theme's demo phone number, which sat in the invisible link over the
    // contact line that shows the real one.
    const phoned = repairPhoneLinks(linked.html);
    const titled = translateEnglishTitle(phoned.html, page.outPath);
    if (dated !== fonts.html) stats.copyrightYears += 1;
    stats.phoneLinks += phoned.repaired;

    // The origin's search box queried PHP; this points it at a local index instead.
    const search = enableStaticSearch(titled.html);

    /**
     * WebP and video posters, and this is the last pass on purpose: it is the first
     * point where a reference has its final spelling. Before it the same picture is an
     * absolute URL on the backup's host in one attribute, a root-relative path in
     * another, percent-encoded in `srcset` and verbatim inside Elementor's JSON - after
     * it there is one form left, and a `.webp` suffix can be appended to whatever the
     * document actually says instead of guessing which of those four a rule should
     * cover. The count is reported because 0 applied and 0 to apply are different facts.
     */
    const media = applyMediaManifest(search.html, mediaManifest);
    stats.mediaImages += media.images;
    stats.mediaPosters += media.posters;

    stats.rewritten += out.rewritten;
    stats.dropped += out.dropped;

    const target = join(paths.dist, page.outPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFileAsync(target, media.html, 'utf8');
    written += 1;
    stats.inquireLinks += occurrences(media.html, whatsapp) - occurrences(positioned, whatsapp);
    stats.searchWired += search.wired ? 1 : 0;
    stats.shopControls += Object.values(cleaned.removed).reduce((sum, n) => sum + n, 0);
    stats.mobileBars += bar.replaced;
    stats.formsReplaced += form.replaced;
    stats.mapsReplaced += mapped.replaced;
    stats.fontsLocal += fonts.replaced;
    stats.fontsMissing += fonts.missing;
    stats.menuLinks += linked.repaired;
    stats.menuHrefsDropped += linked.dropped;
    stats.titlesFixed += titled.changed ? 1 : 0;
    stats.cards += cardsBefore;

    if (/^\/product\//.test(page.urlPath) || /^\/en\/product\//.test(page.urlPath)) {
      productPages.push({ html: media.html, urlPath: page.urlPath, lang: page.urlPath.startsWith('/en/') ? 'en' : 'zh' });
    }
    if (/product-category\//.test(page.urlPath)) {
      categoryPages.push({ html: media.html, urlPath: page.urlPath });
    }

    if (page.urlPath === '/') homeHtml = media.html;
  }

  // WordPress never cached a 404 response, so the mirror has none. Cloudflare Pages
  // looks for exactly this filename, and every uncached link above would otherwise
  // land on Pages' own branded error page instead of the site's.
  await writeFileAsync(join(paths.dist, '404.html'), build404(homeHtml), 'utf8');

  /**
   * A file whose only reference was a script we deliberately removed must not ship.
   *
   * Asset discovery runs over the cached page text rather than the written page, on
   * purpose - half of this site's references hide in data attributes or JSON, and an
   * attribute list missed them twice. The side effect is that deleting a reference from
   * the output does not delete it from the input, so the removed TranslatePress
   * translator would still have been copied, 26 KB that nothing loads. Pruning by the
   * same list the rule uses keeps one source of truth and leaves the follow-hops (a
   * stylesheet's url(), a script's webpack chunks) exactly as they were.
   */
  let pruned = 0;
  for (const [path] of [...assets]) {
    if (!DEAD_AJAX_SCRIPTS.some((name) => path.endsWith(name))) continue;

    assets.delete(path);
    pruned += 1;
  }

  /**
   * Converted media enters the copy list, and an original leaves it once nothing in the
   * written output names it.
   *
   * Both halves read dist rather than the cache, and that is the whole point. The WebP
   * bytes are not in the backup, so no reference pass over the cache could have found
   * them. And the question "is this jpg still used?" has exactly one honest answer -
   * what the shipped documents say after every rule has run - because a stylesheet or a
   * theme script naming the original is invisible to a rule that only rewrote pages.
   * Anything still named stays: 46 MB of weight is a worse outcome than one dead file,
   * while a 404 picture is a defect nobody downstream would connect to this line.
   *
   * This sits before the copy pass and therefore before the stylesheet bundling below,
   * which reads what was copied: a bundle must not absorb a picture reference this pass
   * has just rewrote to a file that will not exist.
   */
  let mediaAdded = 0;
  let mediaUnneeded = 0;
  let mediaDropped = 0;
  let mediaKept = 0;
  let mediaLighterKb = 0;

  if (mediaManifest) {
    for (const out of mediaOutputs(mediaManifest)) {
      const key = assetKey(out);
      if (assets.has(key)) continue;
      assets.set(key, exists(join(mediaFilesDir, key)) ? 'media' : 'absent');
      mediaAdded += 1;
    }

    const named = new Set();
    for (const file of walk(paths.dist)) {
      if (!/\.(html|css|js|json|xml|svg)$/i.test(file.rel)) continue;
      for (const path of namedAssetPaths(readFileSync(file.abs, 'utf8'), mediaManifest)) named.add(path);
    }

    /**
     * A converted file nothing asks for does not ship either. `npm run images` works
     * from the cached pages, and a picture that only appeared inside a widget this build
     * deletes still has a WebP - 108 KB of nothing on the deploy, in one measured case.
     */
    for (const to of unaskedOutputs(mediaManifest, named)) {
      if (assets.get(assetKey(to)) !== 'media') continue;

      assets.delete(assetKey(to));
      mediaUnneeded += 1;
    }

    for (const from of prunableOriginals(mediaManifest, named)) {
      const key = assetKey(from);
      if (!assets.has(key)) continue;
      if (assets.get(key) !== 'copy') { mediaKept += 1; continue; }

      assets.delete(key);
      mediaDropped += 1;
      mediaLighterKb += mediaManifest.images[from].fromKb - mediaManifest.images[from].toKb;
    }
  }

  const copies = [...assets].filter(([, kind]) => kind === 'copy' || kind === 'media').map(([path, kind]) => ({ path, kind }));
  await pool(copies, async ({ path, kind }) => {
    const key = assetKey(path);
    const to = join(paths.dist, key);
    await mkdir(dirname(to), { recursive: true });

    // A stylesheet whose cross-domain url() was localised is written out, not copied:
    // the file it points at only stops being a foreign host if this text changed too.
    const rewrite = cssRewrites.get(key);
    if (rewrite !== undefined) await writeFileAsync(to, rewrite, 'utf8');
    else if (kind === 'media') await copyFile(join(mediaFilesDir, key), to);
    else await copyFile(join(paths.docroot, key), to);
    copied += 1;
  });

  const sitemap = buildSitemap(pages, siteOrigin);
  await writeFileAsync(join(paths.dist, 'sitemap.xml'), sitemap, 'utf8');

  copyPublicExtras(siteOrigin);

  /* ---- fold the render-blocking stylesheets into content-addressed bundles ---- */

  /**
   * This runs after every file has been written, and that ordering is the rule working
   * rather than a detail: a bundle must contain the bytes the browser will get, so the
   * Elementor CSS whose cross-domain url() was localised has to be localised first, and
   * the copies above plus copyPublicExtras() have to have landed. A member that is not
   * in dist/ refuses its whole run - silently dropping one stylesheet out of a bundle
   * would lose rules, which is the one thing this pass is not allowed to do. Before this
   * moved, four font stylesheets that copyPublicExtras() had not written yet were
   * refusing 269 runs on their own.
   */
  const bundles = new Map();
  const mergedInto = { links: 0, removed: 0, skipped: { attribute: 0, import: 0, missing: 0, url: 0 } };
  const cascades = {};

  const distRead = (p) => {
    try { return readFileSync(join(paths.dist, p.replace(/^\//, '')), 'utf8'); } catch { return null; }
  };
  const distExists = (p) => exists(join(paths.dist, p.replace(/^\//, '')));
  // Content-addressed, which is also what makes the bundle safe to cache forever: a
  // changed rule set is a different name, so no visitor can be served an old one.
  const bundleName = (text) => `/gen/${createHash('sha1').update(text).digest('hex').slice(0, 24)}.css`;

  for (const out of [...pages.map((page) => page.outPath), '404.html']) {
    const file = join(paths.dist, out);
    const before = readFileSync(file, 'utf8');
    // What applied before this pass touched the page. The gate expands the bundles back
    // out of the shipped files and requires the same string, so a sheet that went missing
    // or jumped an inline override is caught without trusting anything written here.
    cascades[out] = cascadeShape(before);
    const done = combineStylesheets(before, { read: distRead, exists: distExists, bundleName });

    for (const [name, text] of done.bundles) bundles.set(name, text);
    mergedInto.links += done.links;
    mergedInto.removed += done.merged;
    for (const reason of Object.keys(mergedInto.skipped)) mergedInto.skipped[reason] += done.skipped[reason];

    if (done.merged > 0) await writeFileAsync(file, done.html, 'utf8');
  }

  for (const [name, text] of bundles) {
    const to = join(paths.dist, name.slice(1));
    await mkdir(dirname(to), { recursive: true });
    await writeFileAsync(to, text, 'utf8');
  }

  // The index the browser searches. Built from the shipped pages so a product that is
  // missing from the mirror is missing from search too, rather than being offered as a
  // result that 404s.
  const index = buildSearchIndex(productPages, categoryPages, homeHtml);
  await writeFileAsync(join(paths.dist, 'search.json'), JSON.stringify(index), 'utf8');

  console.log('\n  mirror written\n');
  console.log(`  pages          ${written}`);
  console.log(`  assets         ${copied} copied, ${missingFiles.size} referenced but absent`);
  console.log(`  links          ${stats.rewritten} rewritten, ${stats.dropped} removed (cart, account, ajax, absent assets)`);
  console.log(`  mobile-only    ${pages.filter((page) => page.mobileOnly).length} pages shipped from the mobile variant`);
  console.log(`  sitemap        ${sitemap.split('<url>').length - 1} urls -> ${siteOrigin}`);
  console.log(`  lang switcher  floating button moved to ${floaterPosition}`);
  console.log(`  enquiry        ${stats.inquireLinks} buttons -> ${whatsapp || '(left as they were)'}`);
  console.log(`  shop toolbar   ${stats.shopControls} dead control(s) removed, ${stats.cards} product cards kept`);
  console.log(`  contact form   ${stats.formsReplaced} form(s) replaced by a WhatsApp button, ${stats.mapsReplaced} map(s) by the address`);
  console.log(`  demo content   ${notBuilt} page(s) not built, ${stats.demoMenuItems} menu item(s) cut with them`);
  console.log(`  dead widgets   ${stats.deadWidgets} widget(s) that only worked through admin-ajax.php, ${stats.deadTabControls} tab control(s) cut from the ones that are kept`);
  console.log(`  fonts          ${stats.fontsLocal} link(s) local, ${stats.fontsMissing} not in the manifest${Object.keys(fontManifest).length ? '' : ' (npm run fonts has not been run)'}`);
  console.log(`  mobile bar     ${stats.mobileBars} bar(s) rebuilt from the owner's entries`);
  console.log(`  stale bits     ${stats.copyrightYears} page(s) re-dated, ${stats.menuLinks} menu link(s) routed, ${stats.menuHrefsDropped} heading(s) unlinked, ${stats.titlesFixed} English title(s) fixed`);
  console.log(`  dead scripts   ${stats.deadScripts} script(s) whose only working feature is a PHP endpoint, ${pruned} file(s) not copied any more`);
  console.log(`  identity urls  ${stats.identityUrls} canonical/hreflang value(s) put back to an absolute URL`);
  console.log(`  phone links    ${stats.phoneLinks} tel: link(s) redialled from the theme's demo number to +86${ENQUIRY_PHONE}`);
  console.log(`  media          ${stats.mediaImages} image reference(s) -> webp, ${stats.mediaPosters} video poster(s), ${mediaDropped} original(s) dropped (-${mediaLighterKb} KB), ${mediaAdded - mediaUnneeded} converted file(s) shipped, ${mediaUnneeded} asked for by nothing${mediaKept ? `, ${mediaKept} original(s) still named so still shipped` : ''}${mediaManifest ? '' : '  [npm run images has not been run - the backup\u2019s own bytes]'}`);
  console.log(`  search         ${index.length} entries (${index.filter((e) => e.lang === 'en').length} en), ${stats.searchWired} pages wired`);
  console.log(`  css bundles    ${bundles.size} file(s) from ${mergedInto.links} stylesheet links, ${mergedInto.removed} request(s) removed`
    + `, runs left alone: ${Object.entries(mergedInto.skipped).map(([why, n]) => `${n} ${why}`).join(', ')}`);
  console.log(`  uncached links ${unknownPages.size} targets the mirror links to but never rendered`);
  console.log(`  in             ${((Date.now() - started) / 1000).toFixed(1)} s\n`);

  await writeFileAsync(
    join(paths.work, 'mirror-report.json'),
    `${JSON.stringify({
      siteOrigin,
      floaterPosition,
      whatsapp,
      pages: pages.map((page) => ({ url: page.urlPath, out: page.outPath, mobileOnly: page.mobileOnly, bytes: page.bytes })),
      canonicalMismatch: mismatched.map((page) => ({ served: page.urlPath, canonical: page.canonical })),
      absentAssets: [...missingFiles],
      stylesheetCascades: cascades,
      uncachedLinkTargets: [...unknownPages].sort((a, b) => b[1] - a[1]).map(([path, uses]) => ({ path, uses })),
    }, null, 2)}\n`,
  );
  console.log('  detail -> work/mirror-report.json\n');

  return { written, copied, stats };
}

function hasExtension(pathname) {
  return /\.[a-z0-9]{2,5}$/i.test(pathname);
}

/**
 * The one form an asset key takes: forward-slashed, never leading-slashed.
 *
 * The page pass reads references out of attributes, where WordPress writes
 * `/wp-content/...`, while the two follow-hops derive them from a stylesheet's or
 * script's own directory, where they come out as `wp-content/...`. Two spellings of
 * one file in one Map means `assets.has()` misses, the same file is registered twice,
 * it is copied twice, and the "files to copy" count is inflated by whatever amount
 * neither side can explain afterwards.
 */
function assetKey(pathname) {
  return pathname.replace(/^\/+/, '');
}

/**
 * A 404 page assembled from the home page's own chrome.
 *
 * Measured on the built home page: exactly one <header> and one <footer> element
 * each, so the boundaries are unambiguous. The head is reused so the theme CSS and
 * fonts load identically, with its canonical removed - a 404 must not claim to be
 * the home page. The theme's scripts are left out: they exist to run cart and filter
 * behaviour this page has none of. The one script kept is the static search, because
 * the reused header carries a search box, and the only page on the site where typing in
 * it does nothing would be the page that tells people the site has no search.
 */
function build404(homeHtml) {
  if (homeHtml === '') {
    return '<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>404</title>'
      + '<p>页面未找到 / Page not found. <a href="/">返回首页 / Back to home</a></p>';
  }

  const head = (/<head(?:\s[^>]*)?>([\s\S]*?)<\/head>/i.exec(homeHtml)?.[1] ?? '')
    .replace(/<link\b[^>]*rel=["']?canonical["']?[^>]*>\s*/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>页面未找到 / Not Found${siteSuffix(homeHtml)}</title>`);

  const body = /<body(?:\s[^>]*)?>/i.exec(homeHtml)?.[0] ?? '<body>';
  const header = /<header(?:\s[^>]*)?>[\s\S]*?<\/header>/i.exec(homeHtml)?.[0] ?? '';
  const footer = /<footer(?:\s[^>]*)?>[\s\S]*?<\/footer>/i.exec(homeHtml)?.[0] ?? '';

  const notice = `
    <div class="container" style="padding:80px 0;text-align:center">
      <h1 style="font-size:42px;margin:0 0 12px">404</h1>
      <p style="margin:0 0 8px">页面未找到</p>
      <p style="margin:0 0 24px">Page not found</p>
      <a class="btn" href="/">返回首页 / Back to home</a>
    </div>`;

  const search = /<script[^>]*src="\/site-search\.js"[^>]*><\/script>/i.exec(homeHtml)?.[0] ?? '';

  return `<!DOCTYPE html><html lang="zh-CN"><head>${head}</head>${body}${header}<main>${notice}</main>${footer}${search}</body></html>\n`;
}

/**
 * The site's own name, taken from the home page's title suffix.
 *
 * Hardcoding a brand here would be a residue of the deleted design system rather
 * than this site's name, and the title is the one place the site states it itself.
 */
function siteSuffix(homeHtml) {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(homeHtml)?.[1] ?? '';
  const suffix = title.split(/[\u2013\u2014|-]/).slice(1).join(' ').trim();
  return suffix === '' ? '' : ` - ${suffix}`;
}

/** zh at the root and en under /en/ are one page in two languages, so say so. */
function buildSitemap(pages, origin) {
  const pagePaths = [...new Set(pages.map((page) => page.urlPath))];
  const known = new Set(pagePaths);

  const alternatesFor = (path) => {
    const pairs = [];
    if (path.startsWith('/en/')) {
      const twin = path.slice(3);
      if (known.has(twin)) pairs.push(['zh-Hans', twin]);
      pairs.push(['en', path]);
    } else {
      pairs.push(['zh-Hans', path]);
      const english = `/en${path === '/' ? '/' : path}`;
      if (known.has(english)) pairs.push(['en', english]);
    }
    return pairs;
  };

  const body = pagePaths.map((path) => {
    const links = alternatesFor(path)
      .map(([lang, alt]) => `<xhtml:link rel="alternate" hreflang="${lang}" href="${origin}${alt}"/>`)
      .join('');
    return `  <url><loc>${origin}${path}</loc>${links}</url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${body}\n</urlset>\n`;
}

/**
 * Authored files that belong at the site root rather than inside the copied tree:
 * the Pages directives, the favicon, robots, and the static search runtime.
 */
function copyPublicExtras(origin) {
  for (const name of ['_headers', '_redirects', 'favicon.svg', 'robots.txt', 'site-search.js', 'site-search.css']) {
    const from = join(paths.public, name);
    if (!exists(from)) continue;

    const to = join(paths.dist, name);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);

    /**
     * One exception, because one line here is a promise about another generated file:
     * the sitemap URL has to sit on the host the sitemap's own <loc> values use. The
     * file used to carry a hand-written host and a comment asking someone to change
     * both together, which is a coupling, not a rule.
     */
    if (name === 'robots.txt') writeFileSync(to, rewriteRobotsSitemap(readFileSync(to, 'utf8'), origin), 'utf8');
  }

  // The fetched fonts are a tree of unknown names, so they are copied by walking
  // rather than by a list that would have to be edited after every npm run fonts.
  const fontDir = join(paths.public, 'fonts');
  if (exists(fontDir)) copyTree(fontDir, join(paths.dist, 'fonts'));
}

async function pool(items, worker, limit = 12) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) await worker(queue.shift());
  });
  await Promise.all(runners);
}

function valueAfter(flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/** How many times a literal appears; used to report only what this build changed. */
function occurrences(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

if (process.argv[1] && process.argv[1].endsWith('mirror.mjs')) {
  await build();
}
