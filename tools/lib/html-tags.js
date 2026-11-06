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
