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
 * Point every `tel:` link at the company's own number.
 *
 * The contact block under each product *says* "Phone: (86) 13714286517", while the
 * invisible link Woodmart stretches over the whole list item - `<a class="wd-fill"
 * href="tel: (064) 332-1233">` - still carries the theme demo's New Zealand number. On
 * a phone, tapping that line dials a number that never belonged to this company: the
 * text is the half a visitor can check, the href is the half that acts.
 *
 * Measured before the rule was written, because "rewrite all tel: links" is only safe
 * if the site has one number: three distinct values ship across 137 pages - the real
 * one, and the same placeholder twice (plain and %-encoded). Comparison is on digits,
 * so the existing correct links come back untouched whatever punctuation they use.
 */
export function repairPhoneLinks(html, phone = `tel:+86${ENQUIRY_PHONE}`) {
  const digits = phone.replace(/\D/g, '');
  let repaired = 0;

  const output = html.replace(/href=(["'])tel:([^"']*)\1/gi, (tag, quote, value) => {
    if (value.replace(/\D/g, '') === digits) return tag;

    repaired += 1;
    return `href=${quote}${phone}${quote}`;
  });

  return { html: output, repaired };
}

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
 * Give those menu items their real destination.
 *
 * Two sources, tried in order, and neither is invented by this file:
 *
 *   1. the label table, where a page is known for the label itself;
 *   2. the first link inside that item's own dropdown panel - the ordering the site
 *      already publishes for that group, preferring a category listing over a single
 *      product because a heading should open a list.
 *
 * An item with neither has its href removed rather than pointed at the homepage: a
 * heading with no destination is honest, and a heading that lies about one is the bug
 * this function exists to fix.
 *
 * Edits are applied back to front, because rewriting the first anchor shifts every
 * offset the scan was working from - the symptom of getting that wrong is a corrupted
 * page much further down, far from the change that caused it.
 */
export function repairMenuLinks(html, links = MENU_LABEL_LINKS) {
  const opening = /<a\b[^>]*href="(https?:\/\/[^"\/]*)"[^>]*class="[^"]*woodmart-nav-link[^"]*"[^>]*>/g;
  const edits = [];

  for (const match of html.matchAll(opening)) {
    const host = match[1].split('//')[1];
    // A host with a dot in it is somebody's real external site, not a typo.
    if (!host || /\./.test(host)) continue;

    const li = html.lastIndexOf('<li', match.index);
    if (li === -1) continue;

    const panel = html.slice(match.index + match[0].length, matchingClose(html, li, 'li'));
    const label = decodeEntities(/nav-link-text">([^<]*)</.exec(match[0] + panel)?.[1] ?? '').trim();
    const target = links[label]
      ?? /href="(\/[^"#]*product-category\/[^"]+)"/.exec(panel)?.[1]
      ?? /href="(\/[^"#]*product\/[^"]+)"/.exec(panel)?.[1]
      ?? /href="(\/[^"#]+)"/.exec(panel)?.[1]
      ?? null;

    edits.push({ at: match.index, tag: match[0], target });
  }

  let output = html;
  let repaired = 0;
  let dropped = 0;

  for (const edit of edits.reverse()) {
    const tag = edit.target
      ? edit.tag.replace(/href="[^"]*"/, `href="${edit.target}"`)
      : edit.tag.replace(/\s+href="[^"]*"/, '');
    output = output.slice(0, edit.at) + tag + output.slice(edit.at + edit.tag.length);
    if (edit.target) repaired += 1;
    else dropped += 1;
  }

  return { html: output, repaired, dropped };
}

function decodeEntities(text) {
  return text.replace(/&#0*38;/g, '&').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
}

/**
 * The English pages whose browser tab still reads a Chinese page name.
 *
 * A handful of the English pages have a Chinese string where the page name should
 * be. Most of those strings the site already publishes in English elsewhere - its own
 * English menu says "Serial screen" and "adapter board", and the WordPress defaults
 * arrive in English - so those are transcriptions, not translations.
 *
 * The table names only pages that ship. Two of the original ten, the placeholder page
 * and the slider archive, were demo content and are not built at all, so translating
 * their titles would have been polishing a page nobody can reach.
 *
 * The company suffix is deliberately kept in Chinese on every page: it is the
 * registered name, and the mirror contains no English legal name to substitute.
 * What gets translated is the page name in front of it - except on `en/index.html`,
 * where the title is nothing but the registered name. That page is given the brand
 * the site already publishes in English (`Starbillions 2.1″ round TFT ...`, and the
 * domain itself) as its leading page name, so that every English page opens with an
 * English word instead of the homepage being the one exception in the tree.
 */
export const EN_PAGE_TITLES = {
  'en/index.html': 'Starbillions',
  'en/联系我们/index.html': 'Contact Us',
  'en/关于我们/index.html': 'About Us',
  'en/product-category/串口屏/index.html': 'Serial Screen',
  'en/product-category/转接板/index.html': 'Adapter Board',
  'en/product-category/qspi屏测试板/index.html': 'QSPI Screen Test Board',
  'en/metform-form/在线留言/index.html': 'Online Message',
  'en/metform-form/联系表单2/index.html': 'Contact Form 2',
};

/**
 * Swap the page-name half of an English document's title, keeping the suffix.
 *
 * Only the part before the separator is touched, and only when the table names this
 * exact output file - so a page whose title someone later fixes in WordPress simply
 * stops matching instead of being rewritten twice.
 */
export function translateEnglishTitle(html, outPath, table = EN_PAGE_TITLES) {
  const label = table[outPath];
  if (!label) return { html, changed: false };

  const current = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (current === undefined) return { html, changed: false };

  const parts = current.split(/&#8211;|–/);

  // A title with no separator is the site name alone. Lead with the English brand and
  // keep the registered name as the suffix, which is the shape every other page has.
  if (parts.length === 1) {
    if (!/[\u4e00-\u9fff]/.test(current)) return { html, changed: false };
    return { html: html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${label} &#8211; ${current.trim()}</title>`), changed: true };
  }

  if (!/[\u4e00-\u9fff]/.test(parts[0])) return { html, changed: false };

  const title = [label, ...parts.slice(1)].join(' &#8211;');
  return { html: html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`), changed: true };
}

/**
 * Replace the contact form with one WhatsApp button, everywhere it appears.
 *
 * The form is a metform widget, and metform renders its fields at runtime from a
 * template inside a `<script type="text/mf">` block - the static HTML only carries
 * the container and the schema. That is why the fields survive a build that copies
 * pages faithfully: nothing was ever broken in the mirror, the endpoint it posts to
 * (`/wp-json/metform/v1/entries/insert/16312`) simply does not exist on a static
 * host, so a visitor filled the form, pressed send, and got no answer and no error.
 *
 * The widget is cut whole and replaced with the site's own button markup - the same
 * `elementor-button elementor-button-link elementor-size-sm` structure the product
 * enquiry buttons use - so the result is styled by the theme rather than by anything
 * added here, which is what "unify" has to mean for a button.
 *
 * The metform scripts are deliberately left loaded: with no container they render
 * nothing, and removing the tags would change the reference counts the build compares
 * against the cache for no user-visible gain.
 *
 * Two containers, because the form reaches pages two ways. On ordinary pages it is
 * an Elementor widget (`elementor-widget-metform`), which is what the header and
 * footer template carries on 211 pages. On metform's own pages the plugin prints the
 * form wrapper directly into the content with no widget around it, so the inner
 * `mf-form-wrapper` is cut as well - after the outer pass, which means a page with
 * both is edited once, not twice.
 */
export const CONTACT_FORM_LABELS = {
  zh: '通过 WhatsApp 联系我们',
  en: 'Contact us on WhatsApp',
};

/** Class tokens that identify a metform form container, outermost first. */
export const CONTACT_FORM_MARKERS = ['elementor-widget-metform', 'mf-form-wrapper'];

export function replaceContactForm(html, { whatsappUrl, label }) {
  if (!whatsappUrl) return { html, replaced: 0 };

  let output = html;
  let replaced = 0;

  const button = [
    '<div class="elementor-element elementor-widget elementor-widget-button" data-element_type="widget" data-widget_type="button.default">',
    '  <div class="elementor-widget-container">',
    '    <div class="elementor-button-wrapper">',
    `      <a class="elementor-button elementor-button-link elementor-size-sm" href="${whatsappUrl}" target="_blank" rel="noopener noreferrer">`,
    '        <span class="elementor-button-content-wrapper">',
    `          <span class="elementor-button-text">${label}</span>`,
    '        </span>',
    '      </a>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('\n');

  for (const marker of CONTACT_FORM_MARKERS) {
    let cursor = 0;
    for (;;) {
      const found = output.indexOf(marker, cursor);
      if (found === -1) break;

      const start = enclosingTag(output, found, 'div');
      if (start === -1) {
        cursor = found + marker.length;
        continue;
      }

      output = output.slice(0, start) + button + output.slice(matchingClose(output, start, 'div'));
      replaced += 1;
      cursor = start + button.length;
    }
  }

  return { html: output, replaced };
}

/**
 * Replace the embedded Google map with the address as text.
 *
 * The iframe is an Elementor `google_maps` widget, and it reaches the homepage as
 * well as the contact page through the shared template, so this is one edit applied
 * everywhere rather than a per-page choice.
 *
 * The address is not written here. It is already in the iframe's own title and
 * aria-label, translated per language by TranslatePress - which is the only reason
 * an English page gets an English address. Taking it from the markup keeps one
 * source of truth; a table in this file would be a second one, free to drift.
 *
 * The "在 Google 地图中打开" overlay goes with the widget. That is the whole point:
 * a link to a service that does not answer in the visitor's country is the same
 * defect in a smaller size.
 */
export function replaceMapWithAddress(html) {
  const marker = 'elementor-widget-google_maps';
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

    const widget = output.slice(start, matchingClose(output, start, 'div'));
    const iframe = /<iframe[^>]*maps\.google[^>]*>/i.exec(widget)?.[0];
    const address = iframe && (/\btitle="([^"]*)"/i.exec(iframe)?.[1] ?? /aria-label="([^"]*)"/i.exec(iframe)?.[1]);

    if (!iframe || !address) {
      // A map widget we cannot read an address from is left alone rather than
      // emptied: losing the address would be worse than keeping a broken map.
      cursor = found + marker.length;
      continue;
    }

    const block = [
      '<div class="elementor-element elementor-widget elementor-widget-text-editor" data-element_type="widget" data-widget_type="text-editor.default">',
      '  <div class="elementor-widget-container">',
      `    <p>${address}</p>`,
      '  </div>',
      '</div>',
    ].join('\n');

    const end = matchingClose(output, start, 'div');
    output = output.slice(0, start) + block + output.slice(end);
    replaced += 1;
    cursor = start + block.length;
  }

  return { html: output, replaced };
}

/**
 * A Google Fonts stylesheet reference, in the shape the source really writes.
 *
 * Matched on the URL and not on `href="..."`, because this site's markup quotes these
 * tags with single quotes - `href='https://fonts.googleapis.com/css?...'` - and a rule
 * aimed at the other form reads perfectly while matching nothing: the build reported
 * "0 links local, 0 missing", which looks like nothing to do rather than like a rule
 * that cannot see its own input. `/css` in the pattern is what keeps the
 * `<link rel='dns-prefetch' href='//fonts.googleapis.com'>` hints out of the list; they
 * name a host, not a stylesheet, and there is nothing local to point them at.
 */
export const GOOGLE_FONT_STYLESHEET = /https?:\/\/fonts\.googleapis\.com\/css[^'"<>\s]*/g;

/** The distinct stylesheets a page asks Google for, already in manifest key form. */
export function googleFontStylesheetUrls(html) {
  return [...new Set((html.match(GOOGLE_FONT_STYLESHEET) || []).map(normalizeFontUrl))];
}

/**
 * The form of a Google Fonts URL that identifies the stylesheet.
 *
 * WordPress appends `&#038;ver=7.3.3` - an entity-escaped ampersand plus a cache
 * buster - and Google answers the same CSS without it. Only `ver` is dropped: an
 * earlier version cut the URL at the first ampersand, which also threw away
 * `display=swap`, so the saved CSS would have differed from what the site asks for.
 * Both the fetcher's manifest keys and the rewriter's lookups go through here,
 * because two independent ideas of "the same URL" is how a manifest silently never
 * matches and the page keeps calling Google with no error anywhere to show it.
 */
export function normalizeFontUrl(raw) {
  const text = String(raw).replace(/&#0*38;|&amp;/g, '&');
  const at = text.indexOf('?');
  if (at === -1) return text;

  const kept = text.slice(at + 1).split('&').filter((pair) => pair !== '' && !pair.startsWith('ver='));
  return kept.length > 0 ? `${text.slice(0, at)}?${kept.join('&')}` : text.slice(0, at);
}

/**
 * Point the Google Fonts stylesheets at the local copies, when they exist.
 *
 * The rewrite is driven by the manifest `npm run fonts` writes, so this file never
 * has to know which families the site asks for, and a build without the manifest
 * simply keeps the original links instead of inventing 404s. That asymmetry is the
 * safety: the fetcher is the only thing that can make a local path appear here.
 */
export function localizeGoogleFonts(html, manifest) {
  if (!manifest || Object.keys(manifest).length === 0) return { html, replaced: 0, missing: 0 };

  let replaced = 0;
  let missing = 0;

  const output = html.replace(GOOGLE_FONT_STYLESHEET, (rawUrl) => {
    const local = manifest[normalizeFontUrl(rawUrl)];
    if (!local) {
      missing += 1;
      return rawUrl;
    }

    replaced += 1;
    // Only the URL text changes, so whatever else the source put in the tag - type,
    // media, its own quoting - is kept as written. This is a pointer edit, not a
    // rewrite of the markup.
    return local;
  });

  // The gstatic preconnect is only useful while gstatic is still being contacted.
  const withoutHints = replaced > 0
    ? output.replace(/\s*<link[^>]*(?:preconnect|dns-prefetch)[^>]*fonts\.(?:gstatic|googleapis)\.com[^>]*>/gi, '')
    : output;

  return { html: withoutHints, replaced, missing };
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
 * The icons are inline SVG with `fill="currentColor"`, not image files. That is a
 * deliberate unification, measured: the site's own `uploads/2023/11/phone.svg` has
 * `#0066b6` baked into it and does not read currentColor, while a hand-drawn file was
 * dark, so three items in one bar rendered in two different colours and nothing in CSS
 * could have reconciled them. Inheriting the link's text colour makes the theme the
 * single owner of the icon colour, hover state and colour scheme included.
 */
export const MOBILE_TOOLBAR_ICONS = {
  phone: 'M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.56.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02z',
  grid: 'M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z',
  envelope: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1.5 2.6V17h15V7.6l-7.5 5z',
};

export const MOBILE_TOOLBAR = {
  zh: [
    { label: '电话', href: `tel:+86${ENQUIRY_PHONE}`, icon: 'phone' },
    { label: '产品中心', href: '/产品中心/', icon: 'grid' },
    { label: '联系我们', href: '/联系我们/', icon: 'envelope' },
  ],
  en: [
    { label: 'Call', href: `tel:+86${ENQUIRY_PHONE}`, icon: 'phone' },
    { label: 'Products', href: '/en/产品中心/', icon: 'grid' },
    { label: 'Contact', href: '/en/联系我们/', icon: 'envelope' },
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
    `                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${MOBILE_TOOLBAR_ICONS[icon]}"/></svg>`,
    '              </span>',
    `              <span class="wd-toolbar-label">${label}</span>`,
    '            </a>',
    '          </div>',
  ].join('\n'));

  return [openTag, ...items, '        </div>'].join('\n        ');
}
