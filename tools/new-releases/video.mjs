/**
 * tools/new-releases/video.mjs
 *
 * One rule with one job: nothing the new-release pipeline copies may be a
 * file the deployment host refuses. GitHub rejects a single file over
 * 100 MB at push time - not at build time, not with a warning the gate can
 * read, so a build that produced one was a build that could not be
 * published, and the only way to find out was the push itself. The source
 * folders contain exactly one such file (`VID_20220619_181256.mp4`, 144 MB,
 * 68 seconds of 1920x1080 phone screen recording at 17.7 Mbps), and the
 * largest file the site already ships is 12 MB, so this is not a
 * hypothetical ceiling.
 *
 * Why re-encode rather than drop. The recording is 17.7 Mbps of a 480x800
 * panel being tapped with a finger: the bitrate is a property of the phone's
 * camera, not of the product. Re-encoding to H.264 CRF 26 at the source's
 * own resolution keeps every frame and every pixel of the same recording and
 * costs about a tenth of the bytes, which is the same bargain the mirror
 * struck with WebP for stills - same picture, smaller, nothing redrawn or
 * cropped. Dropping the video would be the honest fallback if `ffmpeg` is
 * missing, and it is what happens then, reported rather than silent.
 *
 * `ffmpeg` is optional in the exact way `sharp` is optional in `webp.mjs`:
 * Pages never builds, so the tool only ever runs on the owner's machine, and
 * its absence must degrade to "that video is not shipped" instead of crashing
 * a step that writes pages, media, the sitemap, and the search index.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths } from '../lib/paths.js';

/** Above this, a video is re-encoded before it is allowed into the output. */
export const VIDEO_COMPRESS_ABOVE = 20 * 1024 * 1024;

/**
 * Above this, nothing ships whatever it is: 95 MB leaves headroom under
 * GitHub's 100 MB per-file hard limit (and under the 1 GB repository-size
 * advice the day one more of these lands). Checked before the extension
 * split, so a 140 MB PDF or PSD cannot walk past it on the strength of not
 * being a video.
 */
export const MEDIA_MAX_BYTES = 95 * 1024 * 1024;

const CRF = '26';
const MAX_HEIGHT = 1080;
// `medium`, not `slow`: the encode runs again after every `wipePrevious()`,
// and 10-15% fewer bytes is not worth turning `npm run verify` into a
// several-minute wait. The cache below is what keeps the repeat cost down.
const PRESET = 'medium';

let ffmpegState = null;
export function hasFfmpeg() {
  if (ffmpegState === null) {
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      ffmpegState = true;
    } catch {
      ffmpegState = false;
    }
  }
  return ffmpegState;
}

/**
 * Re-encode `src` into `dst`, keeping the source's own resolution (never
 * upscaling: `min(1080,ih)`) and its audio.
 *
 * Returns `{ ok, fromBytes, toBytes, note, cached }` and never throws - the
 * caller decides what a failure means for that product page, and
 * `execFileSync` hands back ffmpeg's whole stderr, which is 40 lines of
 * banner and progress and is not something to put in a build report.
 *
 * The encode is cached under `work/video-cache/` keyed by name, size and
 * source mtime, because `build.mjs` wipes `dist/uploads/new-releases/` on
 * every run and a 1080p re-encode must not be the price of editing one
 * headline. That is a cache, not an input: deleting `work/` costs a few
 * minutes, and a source file the owner re-exported has a new mtime, so it
 * re-encodes.
 */
export function compressVideo(src, dst) {
  const source = statSync(src);
  const fromBytes = source.size;
  if (!hasFfmpeg()) {
    return { ok: false, fromBytes, toBytes: 0, note: 'ffmpeg not installed' };
  }

  const cacheDir = join(paths.work, 'video-cache');
  const key = `${basename(src, extname(src))}-${fromBytes}-${Math.round(source.mtimeMs)}`
    .replace(/[^A-Za-z0-9._-]/g, '_') + '.mp4';
  const cached = join(cacheDir, key);

  if (existsSync(cached) && statSync(cached).size < fromBytes) {
    mkdirSync(cacheDir, { recursive: true });
    copyFileSync(cached, dst);
    return { ok: true, fromBytes, toBytes: statSync(dst).size, cached: true };
  }

  try {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', src,
      '-vf', `scale=-2:'min(${MAX_HEIGHT},ih)'`,
      '-c:v', 'libx264', '-crf', CRF, '-preset', PRESET, '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      // Faststart puts the moov atom first, which is what lets the browser
      // begin playback before the file has finished downloading. A demo
      // video the visitor has to wait out entirely is not a demo video.
      '-movflags', '+faststart',
      dst,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    const first = String(error.stderr ?? error.message).split('\n').filter(Boolean).pop() ?? '';
    return { ok: false, fromBytes, toBytes: 0, note: first.slice(0, 90) };
  }

  if (!existsSync(dst)) {
    return { ok: false, fromBytes, toBytes: 0, note: 'ffmpeg wrote nothing' };
  }
  const toBytes = statSync(dst).size;
  if (toBytes >= fromBytes) {
    // Rare (an already-maxed encode), but the fallback must not be "shipped
    // a bigger file": drop the output and let the caller report the skip.
    return { ok: false, fromBytes, toBytes: 0, note: 're-encode not smaller' };
  }

  mkdirSync(cacheDir, { recursive: true });
  copyFileSync(dst, cached);
  return { ok: true, fromBytes, toBytes };
}

/** Plain byte-for-byte copy, used for everything small enough to be itself. */
export function copyPlain(src, dst) {
  copyFileSync(src, dst);
  return statSync(dst).size;
}
