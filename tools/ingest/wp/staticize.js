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

export function isExcluded(url) {
  const pathname = decodeURIComponent(url.pathname);
  if (EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;

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
