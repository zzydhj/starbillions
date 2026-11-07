/**
 * Generate the two media optimisations this site ships, and record them in one manifest.
 *
 *   npm run images
 *
 * Neither is part of `npm run mirror`, and that separation is the point: the mirror has
 * no network step and no image codec, so it stays reproducible on any machine. This
 * script needs `sharp` (devDependency) and, for posters only, a local `ffmpeg`. When it
 * has not been run, the manifest is absent and the mirror ships the backup's own bytes -
 * a slower site, not a broken one.
 *
 * What it writes, all under work/media/ (gitignored, disposable, derived):
 *   files/<original path>.webp          the same picture, smaller
 *   files/<original path>.poster.webp   a video's own first frame
 *   manifest.json                       the mapping the mirror reads
 *
 * Two measured decisions live here rather than in the mirror:
 *
 *   - Only images above MIN_KB, and only when WebP comes out at least MIN_SAVING
 *     smaller. Measured across the fourteen largest files in the uploads tree, WebP
 *     went 30,495 KB to 3,951 KB (87%), but `Detail-16-topaz-enhance-2.9x.jpg` went
 *     835 KB to 780 KB (7%) - and a 7% saving is not worth a second file and a rewritten
 *     reference. On the images the shipped pages actually ask for, nothing was lost to
 *     the saving rule: every file that cleared the size floor beat 25%.
 *   - Posters come from the video itself. The pages offer no honest alternative: every
 *     product page's "featured image" is the same site-wide placeholder
 *     (`62b9cc781cece.png`), so using it would paste one unrelated picture over fourteen
 *     different products, which is worse than a black rectangle.
 *
 * MIN_KB started at 150 KB, which is where the obvious wins are. The live probe then
 * found four 149 KB PNGs still shipping as originals, so the band under the floor got
 * counted: 155 referenced files, 12.4 MB. The floor is now 40 KB - below that a WebP
 * saves tens of kilobytes at best, and the manifest, the file count and the repository
 * each pay for every one.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { paths } from '../lib/paths.js';
import { walk } from '../lib/fs-utils.js';
import { fileReferencesIn } from '../ingest/wp/staticize.js';
import { discover } from '../mirror.mjs';

const MIN_KB = 40;
const MIN_SAVING = 0.25;
const WEBP_QUALITY = 82;
const POSTER_WIDTH = 800;

const mediaDir = join(paths.work, 'media');
const filesDir = join(mediaDir, 'files');
// Emptied first, so the tree under files/ is exactly what this run's manifest names.
// Two failure modes that closes: a conversion left over from earlier settings would ship
// as a file nothing asks for, and an interrupted run would leave a manifest naming bytes
// that are not on disk - which the page then points at, and a 404 product photograph is
// not a failure this build gets to leave for something downstream to discover.
rmSync(filesDir, { recursive: true, force: true });
mkdirSync(filesDir, { recursive: true });

/**
 * Which paths the site actually asks for. Converting the whole uploads tree would ship
 * hundreds of files no page names, and the mirror's asset pass is driven by references,
 * so an unused conversion is pure weight.
 *
 * The cache writes some of them as absolute URLs on the origin (`https://tftstar.com/wp-
 * content/...`), which the mirror later rewrites to root-relative, so both spellings are
 * reduced to a pathname here. Keying on the raw string instead silently missed every
 * video and would have missed any image the theme happened to write out in full.
 */
const toPath = (ref) => {
  const clean = ref.split('?')[0].split('#')[0];
  const pathname = /^https?:\/\//i.test(clean) ? new URL(clean).pathname : clean;
  return decodeURIComponent(pathname).replace(/^\/+/, '');
};

const referenced = new Set();
for (const page of discover(paths.pageCache)) {
  for (const ref of fileReferencesIn(readFileSync(page.file, 'utf8'))) {
    referenced.add(toPath(ref));
  }
}

const images = {};
let scanned = 0;
let skippedSmall = 0;
let skippedSaving = 0;

for (const file of walk(paths.docroot)) {
  const rel = file.rel.replace(/\\/g, '/');
  if (!/\.(png|jpe?g)$/i.test(rel)) continue;
  if (!referenced.has(rel)) continue;
  if (statSync(file.abs).size < MIN_KB * 1024) { skippedSmall += 1; continue; }

  scanned += 1;
  const buffer = await sharp(file.abs).webp({ quality: WEBP_QUALITY }).toBuffer();
  const original = statSync(file.abs).size;

  if (buffer.length > original * (1 - MIN_SAVING)) {
    skippedSaving += 1;
    continue;
  }

  const target = join(filesDir, ...`${rel}.webp`.split('/'));
  mkdirSync(join(filesDir, ...rel.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(target, buffer);

  images[`/${rel}`] = { to: `/${rel}.webp`, fromKb: Math.round(original / 1024), toKb: Math.round(buffer.length / 1024) };
}

/* Posters: every video the shipped pages name, decoded from its own first frame.
   The source sits in data-lazy-load on this site, but a theme that wrote src instead
   should still get a poster, so all four spellings are read - the same list the apply
   pass matches on, which is why every converted video ends up with one. */
const videos = new Set();
for (const page of discover(paths.pageCache)) {
  const text = readFileSync(page.file, 'utf8');
  for (const m of text.matchAll(/<video\b[^>]*\b(?:data-lazy-load|data-src|data-wood-src|src)="([^"]+\.(?:mp4|m4v|webm|ogv|ogg))"/gi)) {
    videos.add(`/${toPath(m[1])}`);
  }
}

let ffmpeg = null;
try {
  ffmpeg = execFileSync('ffmpeg', ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] }) ? true : true;
} catch {
  ffmpeg = null;
}

const posters = {};
let posterFailures = [];

if (ffmpeg) {
  for (const url of [...videos].sort()) {
    const src = join(paths.docroot, ...url.replace(/^\//, '').split('/'));
    if (!existsSync(src)) { posterFailures.push(`${url} (备份里没有这个文件)`); continue; }

    const rel = `${url.replace(/^\//, '').replace(/\.[a-z0-9]+$/i, '')}.poster.webp`;
    const tmp = join(mediaDir, 'frame.png');

    try {
      execFileSync('ffmpeg', ['-y', '-i', src, '-frames:v', '1', '-q:v', '2', tmp], { stdio: ['ignore', 'ignore', 'ignore'] });
      const buffer = await sharp(tmp).resize({ width: POSTER_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      rmSync(tmp, { force: true });

      const target = join(filesDir, ...rel.split('/'));
      mkdirSync(join(filesDir, ...rel.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(target, buffer);
      posters[url] = { to: `/${rel}`, toKb: Math.round(buffer.length / 1024) };
    } catch (error) {
      posterFailures.push(`${url} (${String(error.message).split('\n')[0].slice(0, 80)})`);
    }
  }
}

const manifest = {
  generatedBy: 'npm run images',
  settings: { minKb: MIN_KB, minSaving: MIN_SAVING, webpQuality: WEBP_QUALITY, posterWidth: POSTER_WIDTH },
  ffmpeg: Boolean(ffmpeg),
  images,
  posters,
};

writeFileSync(join(mediaDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

const savedKb = Object.values(images).reduce((n, e) => n + e.fromKb - e.toKb, 0);
const fromKb = Object.values(images).reduce((n, e) => n + e.fromKb, 0);

console.log(`  images       ${Object.keys(images).length} converted of ${scanned} candidates >${MIN_KB} KB (${skippedSaving} left because WebP saved <${Math.round(MIN_SAVING * 100)}%, ${skippedSmall} under the threshold)`);
console.log(`  weight       ${fromKb} KB → ${fromKb - savedKb} KB, ${savedKb} KB saved`);
console.log(`  posters      ${Object.keys(posters).length} of ${videos.size} video(s)${ffmpeg ? '' : ' (ffmpeg not found on PATH - videos stay as they are)'}`);
for (const failure of posterFailures.slice(0, 5)) console.log(`    skipped: ${failure}`);
console.log(`  manifest     work/media/manifest.json`);
