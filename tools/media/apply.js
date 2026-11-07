/**
 * Apply the media manifest that `npm run images` produced to a finished document.
 *
 * The manifest maps two kinds of thing:
 *
 *   images   /wp-content/uploads/2023/12/big.png  ->  the same picture as .png.webp
 *   posters  /wp-content/uploads/2023/12/movie.mp4 -> that video's own first frame
 *
 * Both are applied here, at the end of the page pass, because that is the only point
 * where a reference has its final spelling. Earlier the same file appears as an
 * absolute URL on the backup's host, as a root-relative path, percent-encoded, and
 * verbatim; later it also sits inside `srcset` lists, Elementor's `data-settings`
 * JSON, inline `url()`, and `og:image`. An attribute-by-attribute rewrite would have
 * to enumerate all of that and got it wrong twice already in this project, so instead
 * the rule appends `.webp` to whatever spelling the document actually contains - the
 * match is the replacement's prefix. Percent-encoded and raw spellings both resolve to
 * the one decoded file the host serves, which is how the mirror already ships the
 * uploads tree.
 *
 * The substitution never touches the backup's files: the converted bytes live under
 * work/media/ and reach dist through the asset map, so a machine that has not run
 * `npm run images` builds the site exactly as it did before - slower, not broken.
 */

/**
 * The characters that may follow a path without being part of it.
 *
 * `x.jpg` must not match inside `x.jpg.png` (a different file) and must not match
 * inside `x.jpg.webp` that this very rule already wrote, so a dot, a dash, a percent
 * sign and word characters all mean "this is a longer name, leave it alone".
 */
const TAIL = '(?![A-Za-z0-9._\\-~%])';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Both spellings one decoded asset path can take inside a document.
 *
 * WordPress writes `Picture topaz.png` as `Picture%20topaz.png` in some places and raw
 * in others, and the Chinese filenames in this uploads tree appear both ways, so
 * matching only the filesystem spelling silently leaves a `srcset` pointing at the
 * original - invisible until the original is pruned and the picture 404s.
 */
export function spellingsOf(decodedPath) {
  const raw = decodedPath.replace(/^\/+/, '/');
  let encoded = raw;
  try {
    encoded = encodeURI(raw);
  } catch {
    // A stray half-percent in a filename: the raw spelling is all there is.
  }
  return [...new Set([raw, encoded])];
}

/** The regex that finds one asset path in either spelling, at a name boundary. */
export function pathPattern(decodedPath) {
  const sources = spellingsOf(decodedPath).map((spelling) => escapeRegExp(spelling));

  return new RegExp(`(?:${sources.join('|')})${TAIL}`, 'g');
}

/** The manifest key a reference in a document resolves to: decoded, leading slash. */
export function keyForReference(reference) {
  const clean = reference.split('?')[0].split('#')[0];
  const pathname = /^https?:\/\//i.test(clean) ? new URL(clean).pathname : clean;

  return `/${decodeURIComponent(pathname).replace(/^\/+/, '')}`;
}

/**
 * Point every converted picture at its WebP, in place.
 *
 * Returns how many references changed. Longest path first: two manifest entries can
 * share a directory and one filename can be the prefix of another (`panel.png` and
 * `panel-2.png`), and the boundary guard only protects the side that matched last.
 */
export function substituteImages(html, manifest) {
  const entries = Object.entries(manifest?.images ?? {}).sort((a, b) => b[0].length - a[0].length);
  let replaced = 0;

  let output = html;
  for (const [from] of entries) {
    const pattern = pathPattern(from);
    output = output.replace(pattern, (match) => {
      replaced += 1;
      return `${match}.webp`;
    });
  }

  return { html: output, replaced };
}

/**
 * Give every video the poster its own first frame provides.
 *
 * A <video> with no poster paints a black box, and on this site that box is 800px tall
 * on fourteen product pages. No other picture could honestly stand in: every product
 * page's "featured image" is the same site-wide placeholder, so the alternative to the
 * video's own frame was one unrelated image pasted over fourteen different products.
 *
 * An existing poster is never overwritten, and a video with no entry in the manifest
 * keeps the tag exactly as it was.
 */
export function addVideoPosters(html, manifest) {
  const posters = manifest?.posters ?? {};
  let added = 0;

  const output = html.replace(/<video\b[^>]*>/gi, (tag) => {
    if (/\bposter=/i.test(tag)) return tag;

    const source = (tag.match(/\b(?:data-lazy-load|data-src|data-wood-src|src)="([^"]+\.(?:mp4|m4v|webm|ogv|ogg))"/i) || [])[1];
    if (!source) return tag;
    if (!posters[keyForReference(source)]) return tag;

    // The poster takes the source's own spelling with the extension swapped, so the
    // reference and the file the host resolves are the same thing by construction.
    const poster = source.replace(/\.(?:mp4|m4v|webm|ogv|ogg)$/i, '') + '.poster.webp';
    const withPoster = `${tag.slice(0, -1)} poster="${poster}" preload="none">`;
    added += 1;

    return withPoster;
  });

  return { html: output, added };
}

/**
 * One pass over a finished document.
 *
 * Counts are returned rather than logged because the build reports them and the gate
 * re-derives them: "0 applied" is a different fact from "nothing to apply", and only
 * the caller can tell them apart.
 */
export function applyMediaManifest(html, manifest) {
  if (!manifest || (!manifest.images && !manifest.posters)) {
    return { html, images: 0, posters: 0, applied: false };
  }

  const substituted = substituteImages(html, manifest);
  const videoed = addVideoPosters(substituted.html, manifest);

  return { html: videoed.html, images: substituted.replaced, posters: videoed.added, applied: true };
}

/**
 * Every file the manifest puts in the output, by output path.
 *
 * The mirror's asset map is keyed by output path and copies from the backup's docroot;
 * these entries copy from work/media/ instead, which is the kind the map records as
 * 'media'. The paths are the decoded filesystem spelling, because that is how the
 * uploads tree already lands in dist - a percent-encoded request resolves onto it.
 */
export function mediaOutputs(manifest) {
  const outputs = new Set();

  for (const group of [manifest?.images ?? {}, manifest?.posters ?? {}]) {
    for (const entry of Object.values(group)) outputs.add(entry.to);
  }

  return [...outputs].sort();
}

/**
 * The asset paths a piece of output text names, as manifest keys.
 *
 * This is the question the build cannot answer from the cache: after every rule has
 * run, which files does the deploy still have to carry? Both the original and its
 * WebP have to be known, because one is being dropped and the other added.
 *
 * Anchored on the directories the manifest itself uses rather than scanning for any
 * word ending in `.png`, which buys two things. It cannot stop halfway through a
 * filename the way a name-shaped pattern does (`x(1).jpg`, `Picture topaz.png` and
 * `微信图片_2023111.jpg` all defeat a class that excludes spaces, parentheses or
 * non-ASCII bytes, and a missed reference is a 404 rather than a warning), and it looks
 * at forty directory strings instead of every token in 150 MB of markup. Each match is
 * recorded raw and decoded, so a document writing `%E5%BE%AE` counts as naming the
 * decoded file the host actually serves.
 */
export function namedAssetPaths(text, manifest) {
  const dirs = [...new Set([
    ...Object.keys(manifest?.images ?? {}),
    ...Object.keys(manifest?.posters ?? {}),
  ].map((key) => key.slice(0, key.lastIndexOf('/'))).filter((dir) => dir.length > 0))];

  if (dirs.length === 0) return new Set();

  const pattern = new RegExp(
    `(?:${dirs.map(escapeRegExp).join('|')})/[^"'<>\\\\]{0,200}?\\.(?:png|jpe?g|webp|gif)${TAIL}`,
    'gi',
  );

  const named = new Set();
  for (const match of text.matchAll(pattern)) {
    const path = match[0].replace(/^\/+/, '');
    named.add(path);
    try {
      named.add(decodeURIComponent(path));
    } catch {
      // A half-percent in a real filename: the raw spelling is the only one there is.
    }
  }

  return named;
}

/**
 * Which converted originals nothing points at any more.
 *
 * Compared on the full manifest key, so two uploads sharing a file name across
 * directories are decided separately - and a reference this function cannot see at all,
 * such as a theme script assembling a path from parts, keeps its original too, because
 * what is scanned is the written output rather than the cache.
 */
export function prunableOriginals(manifest, named) {
  const list = [];

  for (const from of Object.keys(manifest?.images ?? {})) {
    if (named.has(from.replace(/^\/+/, ''))) continue;
    list.push(from);
  }

  return list;
}

/**
 * Which converted files the output never asks for.
 *
 * The converter works from the cached pages, and this build deletes some of what the
 * cache contained, so an image that only appeared inside a removed widget arrives here
 * with a WebP that no document mentions. Shipping it would be dead weight in a deploy
 * that is committed to a repository and copied to a host on every push.
 */
export function unaskedOutputs(manifest, named) {
  return mediaOutputs(manifest).filter((to) => !named.has(to.replace(/^\/+/, '')));
}
