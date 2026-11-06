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
