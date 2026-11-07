/**
 * Turning the site's own rendered pages into a static mirror: URL classification,
 * link rewriting, asset discovery. No I/O in here on purpose.
 *
 * The mirror builder that uses this can be tested against fixtures without a
 * server, and the decisions worth arguing about are all pure functions:
 *
 * - Where a URL lands on disk. WordPress serves /product/x/, Cloudflare Pages
 *   serves that from product/x/index.html, and an asset keeps its own path.
 * - What is not a page at all. The cart, checkout and account pages were ruled out
 *   of the static site, so they are removed from the markup rather than shipped as
 *   links to a 404.
 * - How a same-site URL is written in the output. As a root-absolute path, not a
 *   relative one: the mirror's pages sit at wildly different depths (/product/x/ vs
 *   /2021-08-26-y/), and the stylesheets themselves contain absolute url() values,
 *   so re-basing relatively would need per-file arithmetic for no benefit on a site
 *   that is always served from a domain root.
 *
 * The identity URLs (canonical, hreflang, og:url, JSON-LD ids) are the exception:
 * they are meant to be absolute, so they get the new origin instead of a path.
 *
 * Two hosts count as internal because the database stored absolute
 * https://tftstar.com URLs while the pages were rendered there, and the cache also
 * carries leftovers from a local preview host.
 */
import path from 'node:path';
import { enclosingTag, matchingClose } from '../../lib/html-tags.js';

/** Origins that appear in the cached HTML and mean "this site". */
export const ORIGIN_URLS = ['https://tftstar.com', 'http://tftstar.com'];

/** Attributes that carry a URL in WordPress and Woodmart output. */
export const REFERENCE_ATTRS = [
  'href', 'src', 'srcset', 'poster', 'action', 'data-src', 'data-lazy-src', 'data-bg',
  'data-rocket-src', 'data-minify-src', 'data-thumb', 'data-srcset',
];

/**
 * WordPress and WooCommerce endpoints that cannot become static pages.
 *
 * The commerce ones were dropped by decision: a static host has no session to run
 * a cart against. The rest would 404 or serve something meaningless from a file.
 */
export const EXCLUDED_PREFIXES = [
  '/cart/',
  '/checkout/',
  '/my-account/',
  '/wp-admin/',
  '/wp-login.php',
  '/wp-json/',
  '/wp-cron.php',
  '/admin-ajax.php',
  '/xmlrpc.php',
  '/feed/',
  '/comments/',
  '/wp-comments-post.php',
];

/** Extensions that mark a URL as a file to copy rather than a page to render. */
export const ASSET_EXTENSIONS = new Set([
  'css', 'js', 'mjs', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'mp3', 'pdf', 'json', 'xml', 'txt',
]);

export function originSet(extra = []) {
  return new Set([...ORIGIN_URLS, ...extra].map((value) => new URL(value).origin));
}

/**
 * The internal URL behind a raw reference, or null when it is not ours.
 *
 * Excluded URLs are returned too, deliberately: "not part of this site" and "part
 * of this site but not shipped" produce opposite edits, an external link kept and
 * an internal one removed.
 *
 * `base` must be the URL of the page being rewritten, because a bare relative
 * reference resolves against the document.
 */
export function internalUrl(raw, origins, base = ORIGIN_URLS[0]) {
  if (!raw) return null;
  if (/^(data:|blob:|javascript:|mailto:|tel:|ftp:|#)/i.test(raw)) return null;

  let url;
  try {
    url = new URL(raw.replace(/^\/\//, 'https://'), base);
  } catch {
    return null;
  }

  return origins.has(url.origin) ? url : null;
}

/**
 * Content the owner decided not to ship - kept apart from EXCLUDED_PREFIXES because
 * the two lists answer different questions. "Could this ever be a file" is a fact
 * about WordPress; "does this site want it" is a decision, and someone reading the
 * first list should not have to guess which entries are editorial.
 *
 * The date-shaped pages are the theme's demo posts (Japanese furniture, John
 * Doerson, Atlanta homes) - lorem ipsum with no bearing on displays. Once they go,
 * the archives that existed only to list them are empty shells, and so is the
 * header's 博客 entry, so all of it goes together.
 *
 * The post URLs are /YYYY/MM/DD/slug/, which is this site's permalink structure as
 * the cache directory layout proves it. Matching only the hyphenated form reads the
 * same on screen - a display collapses `/2021/08/26/` into `2021-08-26` - and does
 * not match a single real page, which is how a rule can look written and tested and
 * still ship the whole demo tree.
 *
 * /product-category/ is deliberately not caught by the `category` section: the
 * comparison is anchored at the start of the path, and the shop's real categories
 * are the business of this site. Anchoring matters the same way for the dates - an
 * upload path carries year and month segments too.
 *
 * The other sections are the same demo theme in a different post type, measured
 * rather than assumed: every /portfolio/ title is Latin filler ("A lacus bibendum
 * pulvinar"), their images are the only thing still naming the author's preview
 * host, and 8 of them print a PHP file_get_contents warning into their own body.
 * /project-cat/ lists nothing else. /sample-page/ is WordPress's placeholder page
 * ("I'm a postman by day, an aspiring actor by night"), and /woodmart_slider/123/
 * renders "nothing found" - both sit in the sitemap with no link pointing at them.
 *
 * Kept, because they are features rather than filler: /compare/ and /wishlist/ are
 * the WooCommerce tool pages the header icons lead to, and /metform-form/ is now a
 * WhatsApp button.
 */
export const OWNER_REMOVED_SECTIONS = [
  'blog', 'category', 'tag', 'author',
  'portfolio', 'project-cat',
  'sample-page', 'woodmart_slider',
];

export function isOwnerRemoved(pathname) {
  // One leading language directory is stripped, because the English tree mirrors the
  // same sections under /en/ and both halves are removed together.
  const clean = decodeURIComponent(pathname).replace(/^\/+/, '').replace(/^en\//, '');

  if (OWNER_REMOVED_SECTIONS.some((section) => clean.startsWith(`${section}/`) || clean === section)) return true;

  // /2021/, /2021/08/ and /2021/08/26/ are the year, month and day archives of the
  // same removed posts, so they go with the posts rather than standing empty.
  return /^\d{4}(\/\d{2}){0,2}(\/|$)/.test(clean);
}

/**
 * Drop whole menu items that lead to removed content, before the URL pass runs.
 *
 * rewriteReferences deletes the href of an excluded link, which is right for a
 * "购物车" button whose chrome can stay and wrong for a navigation entry: the header
 * would keep an inert 博客 label that looks like a menu item and does nothing. The
 * whole <li> has to go, and it can only be recognised while its href is still there -
 * after the URL pass there is nothing left to match on.
 *
 * Only items whose own link is removed content are dropped, and then the whole
 * subtree with them: a "博客" entry pointing at /blog/ has children that are the
 * demo posts, so removing the label and leaving an empty submenu behind would be
 * half an edit. An item whose own link is still live is kept even when a child is
 * removed, which is what protects a real parent in the mega menu.
 */
export function removeOwnerMenuItems(html) {
  let output = html;
  let removed = 0;

  for (;;) {
    const at = findRemovableItem(output);
    if (at === -1) break;

    const end = matchingClose(output, at, 'li');
    output = output.slice(0, at) + output.slice(end);
    removed += 1;
  }

  return { html: output, removed };
}

function findRemovableItem(html) {
  const pattern = /<li\b[^>]*class="[^"]*menu-item[^"]*"[^>]*>/gi;

  for (const match of html.matchAll(pattern)) {
    const block = html.slice(match.index, matchingClose(html, match.index, 'li'));

    const href = /<a\b[^>]*href="([^"]*)"/i.exec(block)?.[1];
    if (!href) continue;

    let pathname;
    try {
      pathname = new URL(href, ORIGIN_URLS[0]).pathname;
    } catch {
      continue;
    }

    if (isOwnerRemoved(pathname)) return match.index;
  }

  return -1;
}

/**
 * Elementor widgets that only work while admin-ajax.php answers, cut whole.
 *
 * `wd_product_filters` renders a swatch filter form (产品 / 尺寸 / 1.54″ TFT ...) whose
 * results come from an AJAX query, and every option links to `/?filter_size=...` - a
 * query URL the mirror rules out of the static site, so the stripped form would ship as
 * labels with nothing behind them. The widget goes, and so does the section that held it
 * when that leaves the section empty, because an Elementor section keeps its own padding
 * and would otherwise show as a blank band where the block was.
 */
export const DEAD_AJAX_WIDGETS = ['wd_product_filters'];

/**
 * Widgets whose *control* needs admin-ajax.php while their content does not.
 *
 * `wd_products_tabs` server-renders the first tab's product grid and fetches the other
 * three panes on click. Deleting the whole widget was my first instinct and the browser
 * proved it wrong: the front page's body carries no other product grid - the 56
 * `wd_products` widgets are inside the header's category dropdown, `visibility: hidden`
 * until hover - so cutting the widget left the home page with zero visible products on a
 * display-only brief. So the spinner and the tab row, which are the part that could only
 * ever spin, are cut, and the heading and the rendered grid stay.
 */
export const DEAD_TAB_WIDGETS = ['wd_products_tabs'];

/** The control parts of a tabs widget, by whole class token. */
const TAB_CONTROL_CLASSES = ['wd-tabs-loader', 'wd-nav-wrapper'];

/** What makes a section worth keeping: a nested widget or column, or visible content. */
const SECTION_CONTENT = /elementor-widget|elementor-column|<(?:img|p|h[1-6]|a|ul|ol|table|video|iframe|svg|button)\b/i;

export function removeDeadAjaxWidgets(html, widgets = DEAD_AJAX_WIDGETS) {
  let output = html;
  const removed = [];

  for (const widget of widgets) {
    let count = 0;

    for (;;) {
      const at = output.indexOf(`elementor-widget-${widget}`);
      if (at === -1) break;

      const start = enclosingTag(output, at, 'div');
      if (start === -1) break;

      const section = enclosingSection(output, start);
      const cutEnd = matchingClose(output, start, 'div');

      /**
       * A cut that does not shorten the page is a rule that cannot see its own input,
       * and looping on "find the marker, fail to remove it" is how a build hangs on one
       * unexpected page instead of shipping it. Counting only what was really removed
       * keeps the report honest as well: a zero-length cut is not a removal.
       */
      const shortened = output.slice(0, start) + output.slice(cutEnd);
      if (shortened.length >= output.length) break;

      output = shortened;
      count += 1;

      // The section holding the widget is a flex container with its own padding, so
      // cutting only the widget would leave a blank band exactly where the block was -
      // a new defect wearing the old layout. It goes when nothing is left inside it.
      if (section !== -1) {
        const sectionEnd = matchingClose(output, section, 'div');
        if (!SECTION_CONTENT.test(output.slice(section, sectionEnd))) {
          output = output.slice(0, section) + output.slice(sectionEnd);
        }
      }
    }

    if (count > 0) removed.push({ widget, count });
  }

  return { html: output, removed, count: removed.reduce((total, entry) => total + entry.count, 0) };
}

/**
 * Whether `name` is one of a tag's classes.
 *
 * Tested against the token list, not with `\be-con\b` against the attribute: a hyphen is
 * a word boundary to a regex, so `\be-con\b` also matches `e-con-inner` - and mistaking
 * the inner wrapper for the section cut the wrong element out of the page, leaving the
 * section's own div standing empty with its padding intact. Exactly the blank band this
 * code exists to prevent.
 */
function hasClass(classes, name) {
  return classes.split(/\s+/).includes(name);
}

/**
 * Cut the spinner and the tab row out of every AJAX-only tabs widget, keep the pane.
 *
 * The loop is bounded by "did this pass change anything": the widget's own class stays
 * in the page (it is what the surviving grid is styled from), so a marker search alone
 * would find the same widget forever.
 */
export function removeDeadTabsNavigation(html, widgets = DEAD_TAB_WIDGETS) {
  let output = html;
  let removed = 0;

  for (const widget of widgets) {
    for (;;) {
      const at = output.indexOf(`elementor-widget-${widget}`);
      if (at === -1) break;

      const start = enclosingTag(output, at, 'div');
      if (start === -1) break;

      const end = matchingClose(output, start, 'div');
      if (end <= start) break;

      const region = output.slice(start, end);
      const stripped = cutClassBlocks(region, TAB_CONTROL_CLASSES);
      if (stripped.blocks === 0) break;

      output = output.slice(0, start) + stripped.html + output.slice(end);
      removed += stripped.blocks;
    }
  }

  return { html: output, removed };
}

/**
 * Scripts whose only working feature is a request a static host cannot answer.
 *
 * `trp-translate-dom-changes.js` is TranslatePress's dynamic translator: a
 * MutationObserver that batches strings added to the DOM after load and POSTs them to
 * the plugin's `trp-ajax.php`, falling back to `admin-ajax.php` when that 404s. On this
 * mirror every page arrives already translated in its HTML, so the request can never
 * succeed: each English page fired 2-4 POSTs at load and logged the failures as console
 * errors, while Chinese pages - which do not load this file - logged none. That
 * asymmetry is the evidence that removing it costs nothing: a feature that has never
 * worked on this host cannot be broken by deleting it. The plugin's compatibility script,
 * which the language switcher and the floating selector actually use, is left alone, and
 * so is the `trp_data` object it reads.
 *
 * Checked before writing the rule: the symbol that file defines (`TRP_Translator`) is
 * referenced by no page and by no other script in the backup, so nothing is left
 * calling an undefined constructor.
 */
export const DEAD_AJAX_SCRIPTS = ['trp-translate-dom-changes.js'];

export function removeDeadAjaxScripts(html, scripts = DEAD_AJAX_SCRIPTS) {
  let output = html;
  const removed = [];

  for (const script of scripts) {
    /**
     * An external script has an empty body by definition, so requiring only whitespace
     * between the tags means an inline block that merely mentions the file cannot be
     * deleted by accident. The reference sits in `src` or, when WP Rocket delays the
     * load, in `data-rocket-src` - matched both, with either quoting, so one filename
     * is one rule instead of three.
     */
    const pattern = new RegExp(
      `<script\\b[^>]*(?:src|data-rocket-src)="[^"]*${escapeForRegExp(script)}[^"]*"[^>]*>\\s*</script>|` +
      `<script\\b[^>]*(?:src|data-rocket-src)='[^']*${escapeForRegExp(script)}[^']*'[^>]*>\\s*</script>`,
      'gi',
    );
    const count = (output.match(pattern) || []).length;
    if (count === 0) continue;

    const shortened = output.replace(pattern, '');
    if (shortened.length >= output.length) continue;

    output = shortened;
    removed.push({ script, count });
  }

  return { html: output, removed, count: removed.reduce((total, entry) => total + entry.count, 0) };
}

/** Escape a literal filename for use inside new RegExp. */
function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove every <div> in `html` that carries one of `names` as a whole class token. */
function cutClassBlocks(html, names) {
  let output = html;
  let blocks = 0;

  for (;;) {
    const at = findClassBlock(output, names);
    if (at === -1) break;

    const end = matchingClose(output, at, 'div');
    if (end <= at) break;

    output = output.slice(0, at) + output.slice(end);
    blocks += 1;
  }

  return { html: output, blocks };
}

/**
 * Index of the next <div> carrying one of `names` as a class, or -1.
 *
 * Whole tokens, not `\bname\b` against the attribute: a hyphen is a word boundary to a
 * regex, so `\bwd-nav\b` would also match `wd-nav-wrapper` and cut the wrong element.
 */
function findClassBlock(html, names) {
  for (const match of html.matchAll(/<div\b[^>]*class="([^"]*)"[^>]*>/g)) {
    if (match[1].split(/\s+/).some((token) => names.includes(token))) return match.index;
  }

  return -1;
}

/**
 * The Elementor section (`e-con`) that contains `at`, or -1.
 *
 * Found by walking the preceding <div> tags rather than by searching backwards for the
 * class, because a page nests dozens of divs and only the one carrying `e-con` is the
 * section whose padding would show.
 */
function enclosingSection(html, at) {
  for (let index = at; index >= 0; ) {
    const open = html.lastIndexOf('<div', index);
    if (open === -1) return -1;

    // lastIndexOf treats a negative fromIndex as 0, so the loop counts down through
    // real positions instead: otherwise a widget that starts the document re-finds the
    // same <div> forever.
    if (hasClass(classesOf(html, open), 'e-con')) return open;
    index = open - 1;
  }

  return -1;
}

/** The class attribute of the tag starting at `open`, or the empty string. */
function classesOf(html, open) {
  const tagEnd = html.indexOf('>', open);
  if (tagEnd === -1) return '';
  return /class="([^"]*)"/.exec(html.slice(open, tagEnd))?.[1] ?? '';
}

export function isExcluded(url) {
  const pathname = decodeURIComponent(url.pathname);
  if (EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  if (isOwnerRemoved(pathname)) return true;

  // RSS hangs off nearly every URL on a WordPress site, including /comments/feed/
  // and the per-post feeds, none of which start with /feed/. They are links to a
  // live endpoint, not documents, so none of them can be mirrored.
  if (/\/feed\/$/.test(pathname)) return true;

  if (url.search === '') return false;

  // A query on a page URL means WordPress rendered something request-specific -
  // pagination, search, filters, add-to-cart - and one file per path is all a static
  // host can hold, so the un-queried URL is the canonical one.
  //
  // Assets are the opposite case and this distinction matters: WordPress appends a
  // cache buster to every script and stylesheet (?ver=3.7.1), so treating a query as
  // "not a page" deleted the src of 69 scripts and the href of 13 stylesheets on one
  // page, which left jQuery unloaded and every lazy image unfilled. A checker that
  // only asserts "no reference points at a missing file" scores that as perfect.
  return !isAssetPath(pathname);
}

/** Whether a path ends in an extension this site serves as a file. */
export function isAssetPath(pathname) {
  const dot = pathname.lastIndexOf('.');
  if (dot === -1 || pathname.endsWith('/')) return false;
  return ASSET_EXTENSIONS.has(pathname.slice(dot + 1).toLowerCase());
}

/**
 * Disk location for an internal URL.
 *
 * Pages become directory documents so the served URL keeps its trailing slash;
 * assets keep their path minus the query, because `?ver=7.3.3` is cache busting
 * and not part of the filename.
 */
export function toOutputPath(url) {
  const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const extension = path.posix.extname(pathname).slice(1).toLowerCase();

  if (ASSET_EXTENSIONS.has(extension)) return pathname;
  if (pathname === '') return 'index.html';
  return pathname.endsWith('/') ? `${pathname}index.html` : `${pathname}/index.html`;
}

/** Root-absolute form of a same-site URL, query kept so cache busting survives. */
export function toRootAbsolute(url) {
  const pathname = encodeURI(decodeURI(url.pathname));
  return `${pathname}${url.search}`;
}

/**
 * Whether a root-absolute URL path is satisfied by the built output.
 *
 * This lives beside toOutputPath rather than being written again in the checker,
 * because the two had already diverged: joining with path.join on Windows produces
 * backslashes while the file list uses forward slashes, and the comparison then
 * reported 949 broken links in a mirror whose files were all present. One rule, one
 * place, tested.
 */
export function resolvesInOutput(known, pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, '');

  if (clean === '') return known.has('index.html');
  if (known.has(clean)) return true;

  return known.has(`${clean.replace(/\/+$/, '')}/index.html`);
}

/** Every URL string a document mentions, srcset members and CSS urls included. */
export function referencesIn(html) {
  const found = new Set();

  for (const attr of REFERENCE_ATTRS) {
    for (const match of html.matchAll(new RegExp(`(?:^|\\s)${attr}="([^"]*)"`, 'g'))) {
      for (const candidate of attr.endsWith('set') ? splitSrcset(match[1]) : [match[1]]) {
        found.add(candidate);
      }
    }
  }

  for (const match of html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) found.add(match[1]);
  for (const match of html.matchAll(/<base\s+href="([^"]*)"/g)) found.add(match[1]);

  return [...found].filter(Boolean);
}

function splitSrcset(value) {
  return value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0]).filter(Boolean);
}

/**
 * Tags whose URL identifies the page rather than links to it.
 *
 * These must keep an absolute URL, and it must be the new origin: a canonical
 * pointing at the old host tells search engines the mirror is a copy of somebody
 * else's page, which is the opposite of what a migration wants.
 */
const IDENTITY_TAGS = [
  /<link\b[^>]*\brel="canonical"[^>]*>/gi,
  /<link\b[^>]*\brel="alternate"[^>]*\bhreflang="[^"]+"[^>]*>/gi,
  /<meta\b[^>]*\bproperty="og:(?:url|image|image:secure_url)"[^>]*>/gi,
  /<meta\b[^>]*\bname="twitter:(?:url|image|domain)"[^>]*>/gi,
  /<meta\b[^>]*\bproperty="og:site_name"[^>]*>/gi,
];

/**
 * Rewrites the origin inside head metadata that identifies this page.
 */
export function rebaseIdentityUrls(html, origins, siteOrigin) {
  let output = html;

  for (const pattern of IDENTITY_TAGS) {
    output = output.replace(pattern, (tag) => replaceOrigins(tag, origins, siteOrigin));
  }

  // Structured data lives in a script body, where no attribute regex reaches it.
  output = output.replace(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi,
    (whole, body) => `<script type="application/ld+json">${replaceOrigins(body, origins, siteOrigin)}</script>`,
  );

  return output;
}

function replaceOrigins(text, origins, siteOrigin) {
  let output = text;
  for (const origin of origins) {
    if (origin === siteOrigin) continue;
    output = output.split(origin).join(siteOrigin);
  }
  return output;
}

/**
 * Turn every remaining mention of the old host into a same-site path.
 *
 * Runs after the attribute pass, catching what attribute regexes cannot reach:
 * Elementor stores widget settings as JSON in data-settings (14 on a homepage),
 * Woodmart keeps a config object inline, and WP Rocket's loaders build <link> and
 * <img> elements from those strings at runtime. Leaving them absolute means the
 * page fetches its own CSS from a host that no longer serves it - which looks fine
 * in a source review and fails in a browser.
 *
 * Root-absolute, not the new origin: a mirror deployed under any domain then keeps
 * working, and it can be previewed locally without reaching the public internet.
 *
 * A bare origin with no path stays absolute, because scripts concatenate onto it and
 * replacing it with "/" would turn "/" + "/wp-admin/x" into a protocol-relative URL
 * whose host is wp-admin.
 */
export function rootifyOrigins(html, origins, siteOrigin) {
  let output = html;

  for (const origin of origins) {
    output = rootifyOne(output, origin, siteOrigin);
  }

  return output;
}

function rootifyOne(text, origin, siteOrigin) {
  const host = origin.split('://')[1];
  const hostPattern = host.replace(/\./g, '\\.');

  // One pattern for both spellings: (?:\\?/){2} accepts the // of a plain URL and
  // the \/ \/ of a JSON-escaped one, and the path group repeats that optional
  // backslash per segment, so https://host/a/b.css and https:\/\/host\/a\/b.css
  // match identically. The optional s matters: without it the protocol-relative pass
  // below would eat the // of an http:// URL and leave a corrupt http:/path behind.
  const pattern = new RegExp(`https?:(?:\\\\?/){2}${hostPattern}((?:\\\\?/[^\\s"'<>\\\\)]*)*)`, 'g');

  let output = text.replace(pattern, (whole, path) => {
    const clean = path.replace(/\\\//g, '/');
    return clean === '' ? siteOrigin : clean;
  });

  // Protocol-relative references carry no scheme to anchor on. Safe to run after,
  // because every scheme-carrying form above has already been consumed.
  output = output.replace(new RegExp(`(?<!:)\\/\\/${hostPattern}((?:\\\\?/[^\\s"'<>\\\\)]*)*)`, 'g'), (whole, path) => {
    const clean = path.replace(/\\\//g, '/');
    return clean === '' ? siteOrigin : clean;
  });

  // A share button needs a complete URL, so that spelling keeps an origin - the new
  // one. It never appears with escaped slashes because it is already percent-encoded.
  const siteHost = siteOrigin.split('://')[1];
  output = output.split(`https%3A%2F%2F${host}`).join(`https%3A%2F%2F${siteHost}`);
  output = output.split(`http%3A%2F%2F${host}`).join(`http%3A%2F%2F${siteHost}`);

  return output;
}

/**
 * Every file under wp-content or wp-includes that a document mentions, in any
 * syntax: attributes, JSON, inline CSS, or a string inside a script.
 *
 * Enumerating attribute names was tried first and it silently missed things -
 * Woodmart's own lazy loading uses data-wood-src, which was not on the list, so 118
 * product images were neither rewritten nor copied, and their placeholders stretched
 * the homepage to 201,161px tall. Matching on the path shape instead catches every
 * spelling at the cost of occasionally copying a file nobody references.
 */
/**
 * The extension group repeats, and the lookahead is what makes it correct: uploads
 * carries names like Emerson_Electric_Company.svg.png, and a lazy match over a single
 * extension stops at .svg, recording a file that does not exist as missing while the
 * real one is never copied.
 */
const FILE_EXTENSION = '(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|json)';
const FILE_REFERENCE = new RegExp(`wp-(?:content|includes)/[^\\s"'<>)]+?(?:\\.${FILE_EXTENSION})+(?![\\w.])`, 'gi');

export function fileReferencesIn(html) {
  const found = new Set();

  // JSON escapes forward slashes; normalise a scan copy so one pattern sees both.
  const scan = html.replace(/\\\//g, '/');

  for (const match of scan.matchAll(FILE_REFERENCE)) {
    const pathname = match[0].slice(0, match[0].indexOf('?') === -1 ? match[0].length : match[0].indexOf('?'));
    found.add(`/${pathname}`);
  }

  return found;
}

/**
 * Decode a URL path without failing on a filename that contains a bare percent sign,
 * which uploads written by hand do occasionally contain.
 *
 * Exported because the builder and this library's own rules must agree on what a
 * reference decodes to: two tolerant decoders written separately is how one side
 * looks up `100%20logo.png` while the other copies `100 logo.png`.
 */
export function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Chunk filenames an already-copied script will ask for at run time.
 *
 * Elementor's webpack runtime carries a map from chunk id to file name inside the
 * bundle loader itself, so a widget's behaviour can live in a file that not one page
 * ever mentions by name - and which the page scan therefore never finds. Missing one
 * is not invisible either: the browser logs a ChunkLoadError and that widget simply
 * stops working, which is the kind of defect that reads as a broken theme.
 *
 * Only the hashed `.bundle.min.js` shape is matched. A bare `"something.js"` string
 * occurs in ordinary code for unrelated reasons, and copying those would put files in
 * the output that nothing asked for.
 */
export function jsChunkNames(text) {
  return [...new Set((text.match(/["'][\w-]+\.[a-f0-9]{8,}\.bundle\.min\.js["']/g) || [])
    .map((name) => name.slice(1, -1)))];
}

/**
 * Hosts the company owns that are not this site.
 *
 * `starbillions.cn` is the owner's older domain, and Elementor baked the homepage
 * banner's background images as absolute URLs to it. The reason recorded here used to
 * be "that host answers with an invalid certificate"; re-checked on 2026-11-07 both
 * `starbillions.cn` and `www.starbillions.cn` serve the old site over HTTPS, so that
 * sentence is not evidence I can repeat from here (my fetches go through a proxy, which
 * cannot prove a real browser's certificate view either way). What does not depend on
 * the reason: a shipped page should not ask a visitor's browser for artwork on somebody
 * else's domain - if that domain expires, changes owner, or turns on hotlink protection,
 * the banner goes blank on a site that did nothing wrong. The same bytes are in the
 * backup at the same paths, so pointing at them is a pointer, not a substitution of
 * someone's artwork.
 */
export const OWNER_FOREIGN_HOSTS = ['starbillions.cn'];

/**
 * Point a stylesheet at our own copy of a file the mirror already has.
 *
 * A page pass cannot see inside a stylesheet, and WordPress writes absolute URLs into
 * the CSS Elementor generates per post, so these references survive every page rule.
 *
 * A URL is only rewritten when `available` says the bytes are here. Leaving the
 * original text in place otherwise is deliberate: pointing at a path we did not ship
 * trades a broken cross-domain image for a broken same-domain one, and the second one
 * is harder to explain.
 */
export function localizeCssAssetUrls(text, { hosts = OWNER_FOREIGN_HOSTS, available = () => false } = {}) {
  const escaped = hosts.map((host) => host.replace(/\./g, '\\.'));
  const pattern = new RegExp(`url\\(\\s*['"]?https?:\\/\\/(${escaped.join('|')})\\/([^'")?#]+)(?:[^'")]*)?['"]?\\s*\\)`, 'gi');

  const local = new Set();
  const output = text.replace(pattern, (tag, _host, path) => {
    const rel = `/${safeDecode(path)}`;
    if (!available(rel)) return tag;
    local.add(rel);
    return `url(${rel})`;
  });

  return { text: output, local: [...local] };
}

/**
 * Move TranslatePress's floating language switcher to a chosen screen corner.
 *
 * The switcher is `#trp-floater-ls`, fixed to a corner by one of four classes the
 * plugin's own stylesheet defines. Its default here was trp-bottom-right, which on a
 * phone sits directly on top of the theme's bottom toolbar and hides a toolbar item.
 *
 * Swapping the class rather than overriding with CSS is deliberate: the plugin already
 * declares all four positions, and its `#trp-floater-ls.trp-top-right` rule comes after
 * the `#trp-floater-ls:hover` rule at equal specificity, so it wins on cascade order.
 * An override file would need !important against roughly twenty bottom-anchored rules
 * to achieve the same thing, and would then diverge from what the plugin's own setting
 * produces for anyone who later changes it in WordPress.
 *
 * The token is unique to this element in the HTML; the plugin's stored setting uses
 * bottom_right with an underscore, so it is not touched.
 */
export const FLOATER_POSITIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];

export function moveLanguageFloater(html, position) {
  if (!FLOATER_POSITIONS.includes(position)) {
    throw new Error(`unknown language switcher position "${position}"; expected one of ${FLOATER_POSITIONS.join(', ')}`);
  }

  if (position === 'bottom-right') return html;

  return html.replace(/\btrp-(?:top|bottom)-(?:right|left)\b/g, `trp-${position}`);
}

/**
 * Remove the shop toolbar's "Show: 9 / 12 / 18 / 24" and the column-count icons.
 *
 * Both are dead interface, and were dead on the origin too. The evidence, measured
 * rather than assumed:
 *
 *   <a rel="nofollow noopener" class="per-page-variation"><span>9</span></a>
 *   <a rel="nofollow noopener" class="shop-view per-row-2" aria-label="网格视图 2"></a>
 *
 * Neither anchor carries an href, so there is nothing for a browser to follow, and
 * every JavaScript file in the source backup - 322 in the theme alone, plus all of
 * the plugins - was searched for `per-page-variation`, `shop-view` and `per-row-`:
 * no file mentions them, so no file can be listening for the click. Only
 * `owlCarouselInit.min.js` contains `per_page`, which is a carousel option of the
 * same spelling and nothing to do with this control.
 *
 * Removing them costs no function that exists, and leaves a toolbar whose remaining
 * parts (the sorting dropdown) still work, because they are plain links.
 *
 * The whole Elementor widget is cut, not just the control inside it: the wrapper
 * carries the layout classes, and an emptied shell would still reserve its margin.
 * Cutting by structure rather than by regex matters here - the same class names also
 * appear in inline CSS (268 mentions against 51 elements), so a text match would
 * delete real content on the strength of a selector. `enclosingTag` refuses any hit
 * that is not inside an opening tag.
 *
 * The loop is guarded separately: no control was found inside `data-source="main_loop"`,
 * so nothing here can reach a product card.
 */
export const DEAD_SHOP_WIDGETS = ['wd_shop_archive_per_page', 'wd_shop_archive_view'];

export function removeDeadShopControls(html) {
  const removed = {};
  let output = html;

  for (const widget of DEAD_SHOP_WIDGETS) {
    const marker = `elementor-widget-${widget}`;
    removed[widget] = 0;

    let cursor = 0;
    for (;;) {
      const found = output.indexOf(marker, cursor);
      if (found === -1) break;

      const start = enclosingTag(output, found, 'div');
      if (start === -1) {
        cursor = found + marker.length;
        continue;
      }

      output = output.slice(0, start) + output.slice(matchingClose(output, start, 'div'));
      removed[widget]++;
      cursor = start;
    }
  }

  return { html: output, removed };
}

/**
 * Drop TranslatePress's hardcoded default-language prefix from links.
 *
 * The site's default language is served at the root with no subdirectory, but menu
 * items were authored as /zh_cn/联系我们/ and the plugin rewrote them at request time.
 * A static file tree cannot rewrite anything, and 57 of those links sit in the
 * header and footer of every English page - the contact button among them.
 *
 * Runs after the URL passes, so every internal reference is already a root-absolute
 * path or a new-origin URL; matching the path shape alone covers both, without this
 * function needing to know the old or new host.
 *
 * Measured against the built mirror, /联系我们/ and /en/联系我们/ both exist, so this
 * lands the links on a real page rather than moving the 404 elsewhere.
 */
export function stripLanguagePrefix(html) {
  return html
    .replace(/(\/en\/)zh_cn\//g, '$1')
    .replace(/\/zh_cn\//g, '/');
}

/**
 * Rewrite every same-site reference in a document for the mirror.
 *
 * `classify(url)` answers what the builder will do with a URL:
 *   'copy'   an asset that will be written            -> root-absolute path
 *   'page'   a page that was rendered and will exist   -> root-absolute path
 *   'drop'   excluded or absent                        -> attribute removed
 *   undefined unknown                                  -> kept, reported as missing
 *
 * A dropped internal link loses its attribute entirely. Leaving href="/cart/"
 * would ship a 404; removing it keeps the markup valid and the label readable.
 *
 * @returns {{ html: string, rewritten: number, dropped: number, missing: Set<string> }}
 */
export function rewriteReferences(html, { pageUrl, origins, classify }) {
  const stats = { rewritten: 0, dropped: 0, missing: new Set() };
  const base = pageUrl ?? ORIGIN_URLS[0];

  /** undefined keeps the value untouched, false deletes the attribute. */
  const decide = (raw) => {
    const url = internalUrl(raw, origins, base);
    if (url === null) return undefined;

    if (isExcluded(url)) {
      stats.dropped += 1;
      return false;
    }

    const verdict = classify(url);

    if (verdict === 'drop') {
      stats.dropped += 1;
      return false;
    }
    if (verdict === undefined) {
      stats.missing.add(url.href);
      return undefined;
    }

    stats.rewritten += 1;
    return toRootAbsolute(url);
  };

  let output = html;

  // First and independent of attributes: a <base> element would make every
  // root-absolute path resolve against it, and once the href pass below empties
  // one, a pattern requiring href="" would miss it and leave a stray element.
  output = output.replace(/<base\b[^>]*>\s*/gi, '');

  for (const attr of REFERENCE_ATTRS) {
    // The leading (?:^|\s) is what keeps `src` from matching inside `data-src`.
    const isList = attr.endsWith('set');

    output = output.replace(new RegExp(`((?:^|\\s)${attr}=)"([^"]*)"`, 'g'), (whole, lead, value) => {
      if (isList) {
        const kept = value
          .split(',')
          .map((candidate) => {
            const [url, ...descriptor] = candidate.trim().split(/\s+/);
            const next = decide(url);
            if (next === false) return '';
            return [next === undefined ? url : next, ...descriptor].join(' ');
          })
          .filter((part) => part !== '');

        return kept.length > 0 ? `${lead}"${kept.join(', ')}"` : '';
      }

      const next = decide(value);
      if (next === undefined) return whole;
      if (next === false) return '';
      return `${lead}"${next}"`;
    });
  }

  // CSS urls appear in style attributes, inline style blocks and imported
  // stylesheets alike, so this pass is deliberately tag-agnostic.
  output = output.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, quote, value) => {
    const next = decide(value);
    if (next === undefined) return whole;
    if (next === false) return 'none';
    return `url("${next}")`;
  });

  return { html: output, ...stats };
}
