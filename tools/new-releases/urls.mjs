/**
 * tools/new-releases/urls.mjs
 *
 * One URL helper. Kept apart so both media.mjs (writing files into dist)
 * and render.mjs (writing URLs into HTML) share the same encoding, because
 * a filename written one way in the file system and another way in the
 * anchor's `href` is exactly the "silently 404" bug the mirror's whole URL
 * layer exists to prevent.
 */

/**
 * Percent-encode the CJK and punctuation parts of a filename, leaving the
 * ASCII-safe characters alone.
 *
 * Node's global `encodeURI` keeps `[` `]` `#` `?` intact, which is fine for
 * URLs where those carry meaning; here they are literal filename characters
 * (`XBY028-30MB-A1（MIPI).pdf` has a full-width `）` and a plain `)` next to
 * it, `微信图片_2023111.jpg` has CJK). Encoding per segment with
 * `encodeURIComponent` then restoring `/` is what actually matches how
 * Cloudflare Pages resolves the file on disk.
 */
export function encodePath(name) {
  return encodeURIComponent(name).replace(/%2F/g, '/');
}
