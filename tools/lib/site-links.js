/**
 * Site-specific content edits the owner asked for, kept apart from the generic URL
 * rules in ingest/wp/staticize.js.
 *
 * Those two things change for different reasons: staticize.js exists to make a
 * mirror faithful to its source, and this file exists to deliberately depart from it
 * on request. Mixing them would make it impossible to tell, six months from now,
 * whether a line of rewriting was a bug fix or an owner's preference.
 *
 * Every function here is pure: html in, html out, so the edits can be tested against
 * a fixture instead of only against a deployed site.
 */
import { enclosingTag, matchingClose } from './html-tags.js';

/**
 * The owner's preferences for this site, in one place so the builder and the
 * deployment gate cannot drift into disagreeing about what was asked for.
 *
 * The number is written the way it appears on the site itself, in the contact block
 * and in an existing tel: link, both of which carry +86.
 */
export const ENQUIRY_PHONE = '13714286517';

/** The button labels that mean "send me an enquiry about this product". */
export const ENQUIRE_LABELS = ['Inquire about this product', '咨询此产品'];

/**
 * The year the footer should claim.
 *
 * Hardcoded rather than computed at runtime, because a copyright range is a legal
 * statement about the content, not the wall clock: a page printed in 2024 still
 * asserts 2024, and a visitor's browser clock is not the authority on that. It is a
 * constant here so that changing it is one edit that the build and the gate both
 * read, instead of a string to hunt through 217 files.
 */
export const COPYRIGHT_YEAR = '2026';

/**
 * Move the footer's copyright year onto the current one.
 *
 * The source wrote `© 2024` in both footer variants on every page - 212 occurrences,
 * and not one page carried any other year, so there is no range to preserve and no
 * per-page decision to make.
 *
 * Only a year that directly follows the copyright sign is touched. Blog dates are
 * plain text and 2021 post URLs live in hrefs; neither is preceded by ©, so neither
 * can be caught by this rule.
 */
export function updateCopyrightYear(html, year = COPYRIGHT_YEAR) {
  return html.replace(/(©|&copy;)\s*(?:19|20)\d\d/g, `$1 ${year}`);
}

/**
 * Menu items whose WordPress URL was typed as a bare number.
 *
 * Several header entries were authored as `menu-item-type-custom` with the URL field
 * holding a number, so WordPress prefixed `http://` and the browser resolves
 * `http://3` to 0.0.0.3. The visible label is the only thing that says what was
 * meant, which is why this is keyed by label: an entry whose label someone edits
 * stops matching and stays as it was, rather than being pointed somewhere invented.
 *
 * Only labels with a page that really exists are listed. The size ranges
 * ("1.28-2.1英寸液晶显示屏") and "热卖产品" are deliberately absent - they are group
 * headings spanning several categories or a homepage section, and no single page
 * answers for them, so routing them would be a guess dressed up as a fix.
 */
export const MENU_LABEL_LINKS = {
  '串口屏': '/product-category/串口屏/',
  '转接板': '/product-category/转接板/',
  'Serial screen': '/en/product-category/串口屏/',
  'adapter board': '/en/product-category/转接板/',
};

/**
 * Give those menu items their real destination, matched on their own label.
 *
 * The anchor and its `<span class="nav-link-text">` are rewritten together: the
 * dropdown markup puts the label after the href, so the pair has to be handled as one
 * unit, and the label may carry `&#038;` entities that must be decoded before the
 * comparison.
 */
export function repairMenuLinks(html, links = MENU_LABEL_LINKS) {
  const dead = /<a\b[^>]*href="https?:\/\/[^"\/]*"[^>]*class="[^"]*woodmart-nav-link[^"]*"[^>]*>[\s\S]{0,900}?<\/a>/g;
  let repaired = 0;

  const output = html.replace(dead, (anchor) => {
    // A URL that is a real host with a dot in it is somebody's genuine external link.
    const href = /href="(https?:\/\/[^"\/]*)\/?"/.exec(anchor)?.[1];
    if (!href || /\./.test(href.split('//')[1])) return anchor;

    const raw = /nav-link-text">([^<]*)</.exec(anchor)?.[1] ?? '';
    const label = raw.replace(/&#0*38;/g, '&').replace(/&nbsp;/g, ' ').trim();
    const target = links[label];
    if (!target) return anchor;

    repaired += 1;
    return anchor.replace(/href="[^"]*"/, `href="${target}"`);
  });

  return { html: output, repaired };
}

/**
 * Hand the search box over to the static implementation.
 *
 * Two things happen here and both are needed. The theme's own autocomplete is keyed off
 * the woodmart-ajax-search class and posts to /wp-admin/admin-ajax.php, which a static
 * host cannot answer: leaving the class in place means a spinner that never resolves
 * running alongside ours. Then the static script and its stylesheet are linked, on pages
 * that actually contain a search box rather than every page, since the mirror's pages
 * each load dozens of stylesheets already and an unused one is pure weight.
 *
 * The marker class the stylesheet scopes itself to is added by the script at runtime,
 * not here, so with JavaScript disabled none of these rules apply and the page remains
 * the mirror.
 */
export function enableStaticSearch(html, { css = '/site-search.css', script = '/site-search.js' } = {}) {
  if (!html.includes('search-results-wrapper')) return { html, wired: false };

  let output = html.replace(/\s*\bwoodmart-ajax-search\b/g, '');

  output = output.replace(/<\/head>/i, `  <link rel="stylesheet" href="${css}" />\n</head>`);
  output = output.replace(/<\/body>/i, `  <script type="module" src="${script}"></script>\n</body>`);

  return { html: output, wired: true };
}

/**
 * Point the product enquiry buttons at WhatsApp.
 *
 * On the source site these buttons are Elementor links to a contact page on a third
 * domain (starbillions.cn), which is not this site and not reachable from the mirror.
 * The owner asked for the product-page buttons specifically and for nothing else to
 * change, so the target is matched by the button's own visible text rather than by
 * class or by position in the page: the same label appears on the English and the
 * Chinese page, and no other button on the site carries it.
 *
 * Matching on text also means a button whose label someone later edits simply stops
 * matching. That is the safe failure: the link stays as it was instead of being
 * rewired to WhatsApp by accident.
 *
 * target=_blank is added because a messaging app opening over a product page loses
 * the page the customer was reading, which is the one thing an enquiry flow cannot
 * afford.
 */
export function rewriteInquireButtons(html, whatsappUrl, labels) {
  if (!whatsappUrl) return html;

  const wanted = new Set(labels.map((label) => label.toLowerCase()));

  return html.replace(/<a\b[^>]*class="[^"]*elementor-button[^"]*"[^>]*>[\s\S]*?<\/a>/gi, (anchor) => {
    const text = /<span class="elementor-button-text">([\s\S]*?)<\/span>/i.exec(anchor)?.[1];
    if (!text || !wanted.has(text.trim().toLowerCase())) return anchor;

    let edited = anchor.replace(/\bhref="[^"]*"/i, `href="${whatsappUrl}"`);

    if (!/\btarget=/i.test(edited)) {
      edited = edited.replace(/^<a\b/i, '<a target="_blank" rel="noopener noreferrer"');
    }

    return edited;
  });
}

/**
 * Normalise a phone number into the form wa.me requires: digits only, country code
 * included, no plus, no spaces.
 *
 * The rule is deliberately narrow, because the ambiguous case is unavoidable: a bare
 * eleven-digit string is a mainland China mobile number here, but could be a US number
 * that already carries its country code. There is no way to tell from the digits.
 * So the rule is written down instead of guessed at:
 *
 *   written with a leading +   the digits are taken as complete
 *   written with 00 prefix     the 00 is the international dialling prefix, dropped
 *   bare eleven digits         treated as a mainland China mobile, country code added
 *   anything else long enough  taken as complete
 *
 * A number too short to be either is an error rather than a silent guess, because a
 * wrong wa.me link opens a chat with somebody else.
 */
export function whatsappUrlFor(input, { defaultCountryCode = '86' } = {}) {
  const written = String(input).trim();
  let digits = written.replace(/\D/g, '');

  if (digits === '') return '';

  if (!written.startsWith('+')) digits = digits.replace(/^00/, '');

  if (!written.startsWith('+') && /^\d{11}$/.test(digits)) {
    return `https://wa.me/${defaultCountryCode}${digits}`;
  }

  if (digits.length >= 8) return `https://wa.me/${digits}`;

  throw new Error(`"${input}" does not look like a phone number (${digits.length} digits)`);
}

/**
 * The mobile bottom bar, rebuilt with three entries that go somewhere.
 *
 * As shipped by the source site it is three items labelled `123`, all pointing at
 * http://starbillions.savetime.work/ - somebody's preview host, not this site, and
 * not reachable. Only the first item carries an icon; the other two have an empty
 * icon span, which is where the two gear wheels in the screenshot come from: the
 * theme's base `.wd-icon` rule supplies a default glyph when no specific icon class
 * is set, and no `wd-icon-*:before` rule exists anywhere in the mirror's CSS, so
 * there is no font glyph to choose instead.
 *
 * The destinations are the three things a phone visitor of a component supplier
 * actually wants, each verified to exist as a built page: the phone number the site
 * already publishes, the product listing, and the contact page. The English entries
 * point at /en/产品中心/ and /en/联系我们/ because those are the paths the mirror
 * really wrote - TranslatePress keeps the Chinese slug for the default language and
 * the mirror reproduces it, so an invented English slug would 404.
 *
 * The icons are plain <img> with no lazy placeholder. The bar is above the fold on
 * every phone and holds three small files, and the site's own lazy mechanism is what
 * left the first item's icon working while the theme's deferred loading never fired
 * for product thumbnails in testing.
 */
export const MOBILE_TOOLBAR = {
  zh: [
    { label: '电话', href: `tel:+86${ENQUIRY_PHONE}`, icon: '/wp-content/uploads/2023/11/phone.svg' },
    { label: '产品中心', href: '/产品中心/', icon: '/icons/products.svg' },
    { label: '联系我们', href: '/联系我们/', icon: '/icons/contact.svg' },
  ],
  en: [
    { label: 'Call', href: `tel:+86${ENQUIRY_PHONE}`, icon: '/wp-content/uploads/2023/11/phone.svg' },
    { label: 'Products', href: '/en/产品中心/', icon: '/icons/products.svg' },
    { label: 'Contact', href: '/en/联系我们/', icon: '/icons/contact.svg' },
  ],
};

/**
 * Replace every bottom bar on a page with the entries above.
 *
 * Matched by structure, not by the dead URL: the same host appears elsewhere in a
 * page (the owner's own links), and those are not this widget's business. The outer
 * element's original opening tag is reused rather than written again, so whichever
 * variant the theme template used - `wd-toolbar-label-show` or not - survives.
 */
export function replaceMobileToolbar(html, entries) {
  const marker = 'class="wd-toolbar ';
  let output = html;
  let replaced = 0;

  let cursor = 0;
  for (;;) {
    const found = output.indexOf(marker, cursor);
    if (found === -1) break;

    const start = enclosingTag(output, found, 'div');
    if (start === -1) {
      cursor = found + marker.length;
      continue;
    }

    const end = matchingClose(output, start, 'div');
    const block = output.slice(start, end);
    if (!block.includes('wd-toolbar-link')) {
      cursor = end;
      continue;
    }

    const openTag = `${output.slice(start, output.indexOf('>', start) + 1)}`;
    const built = toolbarMarkup(openTag, entries);
    output = output.slice(0, start) + built + output.slice(end);
    replaced += 1;
    cursor = start + built.length;
  }

  return { html: output, replaced };
}

function toolbarMarkup(openTag, entries) {
  const items = entries.map(({ label, href, icon }) => [
    '          <div class="wd-toolbar-link wd-tools-element wd-toolbar-item wd-tools-custom-icon">',
    `            <a href="${href}">`,
    '              <span class="wd-toolbar-icon wd-tools-icon wd-icon wd-custom-icon">',
    `                <img width="1024" height="1024" src="${icon}" class="attachment-thumbnail size-thumbnail" alt="" />`,
    '              </span>',
    `              <span class="wd-toolbar-label">${label}</span>`,
    '            </a>',
    '          </div>',
  ].join('\n'));

  return [openTag, ...items, '        </div>'].join('\n        ');
}
