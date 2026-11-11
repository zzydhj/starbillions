/**
 * tools/new-releases/media.mjs
 *
 * Copies the images, videos and PDF spec sheets each new-release record
 * references out of `新品发布/<folder>/` (which is not in the repo) and into
 * `dist/uploads/new-releases/<slug>/`. The render step then builds HTML
 * against the dist-relative URLs and the gate reads the same list back to
 * prove nothing 404s.
 *
 * Why `dist/uploads/new-releases/` and not `dist/wp-content/uploads/...`
 * the mirror already uses: the mirror's asset pruning walks the cached
 * WordPress pages to decide which uploads still have a reference, and new
 * releases by definition have no cache page. Files placed in the mirrored
 * path would be judged unreferenced and deleted on the next run. A sibling
 * tree the mirror never touches is the honest home.
 *
 * Filenames on disk are preserved verbatim. Two reasons: the owner edits
 * the source folder between runs (adding a photo means only the new file
 * changes hash in the gate output, not every URL), and the CJK names on
 * several files (`微信图片_2023111.jpg`, `XBY18004C18规格书.pdf`) would be
 * unintelligible once rewritten. URL-encoding happens only where a URL is
 * written into HTML; the files themselves keep their original bytes.
 */
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from '../lib/fs-utils.js';
import { paths } from '../lib/paths.js';
import { encodePath } from './urls.mjs';
import { MEDIA_MAX_BYTES, VIDEO_COMPRESS_ABOVE, compressVideo } from './video.mjs';

const MB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * How many files land in the gallery and how many in the body.
 *
 * Eight was measured against the folder inventory: the median is five, the
 * mean six, and a handful of folders carry thirty-plus. Cap the gallery at
 * six (one hero + five thumbnails, matching what Woodmart's flexslider
 * renders cleanly without horizontal scroll), cap the body at twelve, and
 * drop the rest. The gate reports the drop count so the owner sees whether
 * a specific folder was culled more than expected.
 */
export const GALLERY_LIMIT = 6;
export const BODY_LIMIT = 12;

/**
 * Copy one product's media into dist and return the URLs the page should
 * reference.
 *
 * The record is expected to have `folder` (the subfolder inside `新品发布`)
 * and `slug` (the URL slug the render step writes to). Files are picked by
 * the same rule as before: skip duplicates carrying a `_副本` or `_copy`
 * suffix, sort by bytes descending, slice to the limits above.
 *
 * Videos get a poster chosen from the same folder's first non-duplicate
 * image. That is not the video's own first frame - `tools/media/convert.mjs`
 * does that job for the mirrored site by running ffmpeg over the cache page's
 * videos, but the new-release videos have no cache page and the pipeline
 * would need a second input path to cover them. Until that exists, a still
 * image from the same folder is the least dishonest option: at least it is a
 * picture of the product. A folder with only videos (row 14, `2.4寸 演示视频`)
 * gets no poster; the browser shows the video element's own first frame or
 * black, and the gate reports that specific absence rather than failing.
 */
export function publishMedia(record) {
  const srcDir = join(paths.newReleases, record.folder);
  const dstDir = join(paths.dist, 'uploads/new-releases', record.slug);
  mkdirSync(dstDir, { recursive: true });

  const dropped = [];
  const entries = collectFiles(srcDir);
  // Ceiling before anything is sorted or picked, but **only for files that
  // have no second act**: a large PDF or a PSD is simply not a page asset, it
  // is a push that fails at the host. Videos are not filtered here - the same
  // 144 MB file that a host refuses is the one `compressVideo` exists for, and
  // applying the ceiling to it first is how a build silently dropped a demo
  // recording instead of shrinking it (the first cut of this rule did exactly
  // that, and printed the drop as if it were a decision).
  const fits = (list) => list.filter((f) => {
    if (f.bytes <= MEDIA_MAX_BYTES) return true;
    dropped.push(`${f.name} - ${MB(f.bytes)}, over the host per-file limit`);
    return false;
  });

  const images = pickAll(fits(entries.images));
  const videos = entries.videos;
  const pdfs = fits(entries.pdfs);

  const hero = images[0] ?? null;
  const thumbs = images.slice(1, GALLERY_LIMIT);
  const body = images.slice(0, BODY_LIMIT);
  const droppedImages = Math.max(0, images.length - BODY_LIMIT);

  const copy = (f) => {
    const to = join(dstDir, f.name);
    if (!existsSync(to) || statSync(to).size !== f.bytes) copyFileSync(f.abs, to);
    return `/uploads/new-releases/${record.slug}/${encodePath(f.name)}`;
  };

  /**
   * Videos get the extra rule: past `VIDEO_COMPRESS_ABOVE` the bytes go
   * through ffmpeg rather than straight into the tree, and a video that
   * cannot be made small enough (`ffmpeg` absent, encode failed, the
   * re-encode not actually smaller, or still over the ceiling afterwards) is
   * **not copied** - the page loses the video and the build report says so.
   * Copying it anyway would put the whole repository past the host's limit to
   * keep one `<video>` tag.
   */
  const copyVideo = (v) => {
    if (v.bytes <= VIDEO_COMPRESS_ABOVE) return copy(v);
    const result = compressVideo(v.abs, join(dstDir, v.name));
    if (!result.ok) {
      dropped.push(`${v.name} - ${MB(v.bytes)}, ${result.note}`);
      return null;
    }
    if (result.toBytes > MEDIA_MAX_BYTES) {
      dropped.push(`${v.name} - re-encoded to ${MB(result.toBytes)}, still over the host per-file limit`);
      return null;
    }
    return `/uploads/new-releases/${record.slug}/${encodePath(v.name)}`;
  };

  const posterFor = (video) => (hero ? copy(hero) : null);

  const shippedVideos = videos
    .map((v) => ({ entry: v, url: copyVideo(v) }))
    .filter((v) => v.url !== null);

  return {
    hero: hero ? copy(hero) : null,
    heroBytes: hero?.bytes ?? 0,
    thumbs: thumbs.map(copy),
    body: body.map(copy),
    gallery: [hero, ...thumbs].filter(Boolean).length,
    videos: shippedVideos.map((v) => ({ url: v.url, poster: posterFor(v.entry), bytes: v.url ? statSync(join(dstDir, v.entry.name)).size : 0 })),
    pdfs: pdfs.map(copy),
    droppedImages,
    droppedFiles: dropped,
  };
}

function collectFiles(dir) {
  const out = { images: [], videos: [], pdfs: [], other: [] };
  if (!existsSync(dir)) return out;

  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (!st.isFile()) continue;
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    const entry = { name, abs, bytes: st.size, ext };
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) out.images.push(entry);
    else if (['.mp4', '.mov', '.webm', '.m4v'].includes(ext)) out.videos.push(entry);
    else if (ext === '.pdf') out.pdfs.push(entry);
    else out.other.push(entry);
  }
  return out;
}

/**
 * The `新品发布/` folders use Windows duplicate markers (`_副本`) and one or
 * two `.jpg`/`.png` pairs of the same render. Both go.
 *
 * The marker is anchored to the end of the stem, not followed by a word
 * boundary: CJK characters are not word characters, so the earlier
 * `_副本\b` form matched nothing at all and every duplicate shipped. The
 * extension is part of the pattern for the same reason - it is the only
 * thing after the marker in all nine real names (`2_副本.png`,
 * `55d5...85_副本.jpg`), and `copy` still needs the digit form Windows uses
 * for a third copy (`_copy1.jpg`).
 */
function pickAll(images) {
  return images
    .filter((f) => !/_(?:副本|复件|copy\d*)\.[a-z0-9]+$/i.test(f.name))
    .sort((a, b) => b.bytes - a.bytes);
}
