/**
 * tools/new-releases/webp.mjs
 *
 * Converts the images `build.mjs` just copied into `dist/uploads/new-releases/`
 * to WebP and rewrites every new-release page to name the smaller file.
 *
 * Kept apart from `tools/media/convert.mjs` for the same reason the rest of
 * the new-release pipeline is: convert.mjs drives itself from the cached
 * WordPress pages, so its "which images does the site ask for" scan cannot
 * see the new-release pages, which do not exist in the cache. Two
 * independent manifests would then need to agree on names and pruning, and
 * that agreement is exactly the kind of cross-file coupling the README's
 * rule 8/9 already calls out. This module owns one directory tree, one
 * rename rule, and one reference set - the mirror owns the rest.
 *
 * Thresholds match the mirror's own (40 KB floor, 25% minimum saving,
 * quality 82) so the two halves of the site look like they were prepared by
 * one hand. Different numbers would make the new pages faster or slower
 * than the mirrored ones for no reason the owner chose.
 *
 * Runs as a step of `npm run products`, after the pages and media land and
 * before `check` reads the tree.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../lib/paths.js';
import { walk } from '../lib/fs-utils.js';
import { encodePath } from './urls.mjs';

const MIN_BYTES = 40 * 1024;
const MIN_SAVING = 0.25;
const QUALITY = 82;
const IMAGE_EXT = /\.(jpe?g|png)$/i;

let sharpModule = null;
/**
 * `sharp` is a devDependency and Pages never builds, so the pipeline must
 * still run where it is absent - the same bargain `npm run images` makes for
 * the mirrored half of the site: no converter means the originals ship, which
 * is heavier but not broken. Imported lazily so that absence is a line in the
 * build report instead of a crash while loading this module, which would take
 * the pages, the category listing, the sitemap and the search index down with
 * it (they are all written before this step and none of them need `sharp`).
 */
async function loadSharp() {
  if (sharpModule === null) {
    sharpModule = await import('sharp').then((m) => m.default).catch(() => false);
  }
  return sharpModule || null;
}

/**
 * Convert every image in `dist/uploads/new-releases/` and rewrite the
 * references in every new-release page. Returns counts so the build step
 * can report, and the gate can assert that "we ran" is visible even when
 * the tree is empty.
 *
 * A file that converts well gets `<name>.webp` appended to its own name on
 * disk, and every page naming the old path is rewritten. A file under 40 KB
 * or saving < 25% stays as it was - no entry in the mapping, so the sweep
 * below leaves it alone. Both decisions are recorded so the caller can
 * distinguish "nothing to do" from "everything refused".
 *
 * Deleting the original is a separate third pass, not part of the convert
 * loop, for two reasons. Correctness: the delete must happen after the
 * rewrite, so there is never a window where a page names a file that is
 * gone. Robustness: on Windows an `rmSync` immediately after `writeFileSync`
 * intermittently fails with EPERM, because Defender or the Explorer
 * thumbnail service opens the *new* `.webp` in the same directory and the OS
 * locks that directory against further operations. A sweep that runs after
 * 390 conversions and 132 page rewrites is seconds later, which is normally
 * long enough for the scan to finish; `maxRetries` absorbs the rest, and a
 * delete that still fails is reported rather than thrown - the WebP is on
 * disk, every page points at it, and the stale original is dead weight but
 * not a 404. Leaving it silent would let the leftovers pile up while the
 * gate stayed green.
 */
export async function convertNewReleaseImages() {
  const empty = { converted: 0, refused: 0, skipped: 0, cleared: 0, stuck: 0 };
  const sharp = await loadSharp();
  if (!sharp) return { ...empty, unavailable: true };

  const root = join(paths.dist, 'uploads/new-releases');
  if (!existsSync(root)) return empty;

  const manifest = await convertTree(root, sharp);
  const pages = collectPages();
  rewritePages(pages, manifest);
  sweepOriginals(root, manifest);

  return manifest;
}

async function convertTree(root, sharp) {
  const result = { converted: 0, refused: 0, skipped: 0, cleared: 0, stuck: 0, mapping: new Map() };

  for (const file of walk(root)) {
    if (!IMAGE_EXT.test(file.rel)) continue;
    const size = statSync(file.abs).size;
    if (size < MIN_BYTES) {
      result.skipped += 1;
      continue;
    }

    let webp;
    try {
      webp = await sharp(file.abs).webp({ quality: QUALITY }).toBuffer();
    } catch (error) {
      console.warn(`  webp: sharp refused ${file.rel}: ${error.message}`);
      result.refused += 1;
      continue;
    }

    const saving = 1 - webp.length / size;
    if (saving < MIN_SAVING) {
      result.refused += 1;
      continue;
    }

    // Suffix append, not extension swap: `x.jpg` -> `x.jpg.webp`. That is
    // what `tools/media/convert.mjs` does for the mirrored site, and the
    // reason it does is a collision this tree has too - four folders ship the
    // same render as `x.jpg` *and* `x.png`. Swapping the extension sends both
    // to `x.webp`, so the second conversion overwrites the first, one of the
    // two originals is left naming a picture that is not its own, and a file
    // refused on the saving threshold can sit next to a WebP that came from
    // its twin. Appending keeps every converted file addressable by the name
    // it was asked for.
    writeFileSync(`${file.abs}.webp`, webp);
    result.mapping.set(file.rel, `${file.rel}.webp`);
    result.converted += 1;
  }

  return result;
}

/**
 * Remove every original that has been converted and rewritten, after the
 * rewrite pass has moved all references onto its `.jpg.webp` twin.
 *
 * The list is the mapping, not a filesystem pattern: a refused conversion
 * never gets an entry, so its original keeps serving the pages that name it.
 * Doing this after the rewrite (rather than inside the convert loop) is what
 * closes the Windows hole - `rmSync` right after `writeFileSync` intermittently
 * fails with EPERM because Defender or the Explorer thumbnail service has the
 * directory busy, and a sweep that runs 390 conversions and 132 page rewrites
 * later is seconds past that scan. `maxRetries` absorbs the tail, and a delete
 * that still fails is counted and reported instead of thrown: the WebP is on
 * disk and every page names it, so a stale original is dead weight, not a
 * 404. Reporting it is the point - staying silent let seventeen such files
 * pile up (17 MB) while the gate kept saying the tree was clean.
 */
function sweepOriginals(root, result) {
  for (const [fromRel] of result.mapping) {
    const abs = join(root, fromRel);
    if (!existsSync(abs)) continue;
    try {
      rmSync(abs, { maxRetries: 16, retryDelay: 100 });
      result.cleared += 1;
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
      result.stuck += 1;
    }
  }
  return result;
}

/**
 * Every HTML file that can name a new-release image.
 *
 * Three groups, all listed by hand rather than globbed: the two product
 * trees, the two category listing pages, and the four archive pages
 * `strip.mjs` inserts a preview strip into. Kept explicit so a bug in a
 * pattern cannot rewrite one of the mirrored pages by accident - and so the
 * strip pages cannot be forgotten, which is exactly how the first cut of
 * this pipeline shipped twenty-four `<img src="...jpg">` tags naming files
 * the conversion pass had already deleted. The strip is inserted before
 * `convertNewReleaseImages` runs (see `build.mjs`), so these four files
 * exist by the time this list is read; rewriting them here is what makes
 * the strip's heroes point at the same `.webp` bytes the gallery does.
 */
function collectPages() {
  const roots = [
    join(paths.dist, 'product'),
    join(paths.dist, 'en/product'),
  ];
  const files = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const slug of readdirSync(root)) {
      if (!slug.startsWith('new-')) continue;
      const html = join(root, slug, 'index.html');
      if (existsSync(html)) files.push(html);
    }
  }

  for (const slug of ['新品发布']) {
    for (const prefix of [join(paths.dist, 'product-category'), join(paths.dist, 'en/product-category')]) {
      const html = join(prefix, slug, 'index.html');
      if (existsSync(html)) files.push(html);
    }
  }

  // `strip.mjs` owns this same list of four; if a target is added there it
  // has to be added here too, or the new page's strip keeps referencing a
  // pruned original. Referenced by comment rather than import because the
  // two modules run in opposite directions (build calls strip, then webp).
  for (const html of [
    join(paths.dist, 'index.html'),
    join(paths.dist, 'en/index.html'),
    join(paths.dist, '产品中心/index.html'),
    join(paths.dist, 'en/产品中心/index.html'),
  ]) {
    if (existsSync(html)) files.push(html);
  }
  return files;
}

/**
 * Move every page's image URLs from the original onto its `.jpg.webp`.
 *
 * Two spellings are matched because a page's markup and the file's on-disk
 * name can differ - the HTML writes
 * `/uploads/new-releases/<slug>/<encoded>` and `<encoded>` percent-encodes
 * CJK and punctuation. Matching only one is how the mirror's own rewrite
 * used to leave the whole `srcset` pointing at a pruned original.
 *
 * Both spellings go into ONE alternation over the original text rather than
 * two chained `split().join()` passes, and that distinction only started to
 * matter when the conversion moved to suffix appending. Appending makes the
 * search string a prefix of the replacement (`x.png` -> `x.png.webp`), so a
 * second chained pass re-matches what the first pass just wrote and yields
 * `x.png.webp.webp` - 760 dead references on 132 pages, which the first
 * version of this pass shipped until the gate named them. `replace` with a
 * function scans the input once, so the replacement can never be eaten by a
 * later rule.
 *
 * Longest pattern first for the same reason in reverse: a folder holding
 * both `x.png` and `x.png.jpg` must not have the longer name half-rewritten
 * by the shorter rule that happens to be tried first. The trailing lookahead
 * is the other half of that guard - a name may only be rewritten where it
 * ends, so `x.png` inside `x.png.jpg` is not a hit at all, whatever order the
 * alternatives are in.
 */
function rewritePages(files, manifest) {
  if (manifest.mapping.size === 0) return 0;

  const pairs = [];
  for (const [fromRel, toRel] of manifest.mapping) {
    pairs.push(['/' + fromRel, '/' + toRel]);
    pairs.push([
      '/' + fromRel.split('/').map(encodePath).join('/'),
      '/' + toRel.split('/').map(encodePath).join('/'),
    ]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);

  const target = new Map(pairs);
  // The alternatives go inside a non-capturing group before the lookahead:
  // `A|B(?!x)` parses as `A` or `B(?!x)`, so an ungrouped guard would only
  // ever protect the last name in a list of 762.
  const pattern = new RegExp(
    '(?:' + pairs.map(([from]) => escapeRegExp(from)).join('|') + ')(?![A-Za-z0-9._-])',
    'g',
  );

  let rewritten = 0;
  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    const next = html.replace(pattern, (matched) => target.get(matched));
    if (next !== html) {
      writeFileSync(file, next, 'utf8');
      rewritten += 1;
    }
  }
  return rewritten;
}

/** The URLs are file paths, so regex metacharacters in them are data. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * CLI entry (suffix-detected so Windows paths compare correctly; the same
 * lesson as `build.mjs` documents). Not normally invoked alone - it is
 * called from `build.mjs` after pages land.
 */
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/new-releases/webp.mjs')) {
  const r = await convertNewReleaseImages();
  console.log(`\n  new-release webp: ${r.converted} converted, ${r.refused} refused, ${r.skipped} under 40 KB, ${r.cleared} originals cleared, ${r.stuck} still locked\n`);
}
