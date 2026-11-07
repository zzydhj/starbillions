/**
 * Tag-pair helpers for editing rendered HTML by structure rather than by regex guess.
 *
 *   import { matchingClose } from '../lib/html-tags.js'
 *
 * Both the search index (which measures the product loop) and the staticizer (which
 * removes whole Elementor widgets) need to know where an element ends. A regex cannot
 * say: `<ul>` nests `<ul>`, `<div>` nests `<div>`, and cutting at the first `</ul>`
 * silently eats part of the document. One scanner, shared, so the two cannot disagree
 * about what "this element" means.
 */

/**
 * Index just past the closing tag of the element whose opening tag starts at `from`.
 *
 * `from` must point at `<` of an opening `<tag ...>`; the scan counts that element
 * first, so depth reaches zero at its own close. Returns the end of the string when
 * the document is unbalanced, which for our input means the cached page really is
 * truncated and the caller should treat the remainder as the element.
 */
export function matchingClose(html, from, tag) {
  const pattern = new RegExp(`<${tag}\\b|</${tag}>`, 'gi');
  let depth = 0;

  for (const match of html.matchAll(pattern)) {
    if (match.index < from) continue;
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }

  return html.length;
}

/**
 * Index of the opening `<tag ...>` that contains `at`, or -1 when `at` is not inside
 * one.
 *
 * The "no `>` between" test is what makes this a structure lookup and not a text
 * search: a class name also appears in inline CSS, and cutting from the nearest
 * preceding `<div` there would delete real content on the strength of a selector.
 */
export function enclosingTag(html, at, tag) {
  const open = html.lastIndexOf(`<${tag}`, at);
  if (open === -1) return -1;
  const close = html.indexOf('>', at);
  if (close === -1) return -1;
  return html.slice(open, at).includes('>') ? -1 : open;
}

/**
 * The attributes of one tag, as name -> value, with names lower-cased.
 *
 * Written here rather than inline at each call site because "does this tag carry
 * attribute X" is a question with a trap in it: `title` also occurs inside
 * `id='wd-woo-opt-title-limit-css'`, so a substring test reports nearly every
 * stylesheet on the site as an alternative stylesheet (`title=`), and a build rule
 * quietly does nothing while still reporting the counts it expected. One parser, so
 * the builder and the gate cannot disagree about what an attribute means.
 *
 * Handles both quote styles (this site uses single quotes in head metadata and double
 * quotes elsewhere), unquoted values, and valueless attributes.
 */
export function tagAttributes(tag) {
  const attributes = new Map();
  const inner = tag.replace(/^<\s*[\w:-]+/, '');
  const one = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

  for (const match of inner.matchAll(one)) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes.set(match[1].toLowerCase(), value);
  }

  return attributes;
}

/**
 * Is this attribute present at all, including the valueless form (`disabled`)?
 *
 * `null` means absent, so a caller can tell "not there" from "there but empty" - the
 * difference matters for `media=""`, which is a real value with a different meaning
 * from no media attribute at all.
 */
export function tagAttribute(tag, name) {
  const attributes = tagAttributes(tag);
  const key = name.toLowerCase();
  return attributes.has(key) ? attributes.get(key) : null;
}
