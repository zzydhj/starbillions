/**
 * tools/new-releases/video.mjs
 *
 * One rule with one job: nothing the new-release pipeline copies may be a
 * file the deployment host refuses. Cloudflare Pages rejects a single asset
 * over 25 MiB - not at build time, not in a warning the gate can read, but in
 * its own deployment log, so the push succeeds, the deploy fails, and the
 * live site keeps serving the previous release with no local signal at all.
 * The source folders contain exactly one file in that shape (`VID_20220619_181256.mp4`,
 * 144 MB, 68 seconds of 1920x1080 phone screen recording at 17.7 Mbps), and
 * GitHub's own 100 MB per-file limit - the one this file first targeted - is
 * four times looser, which is what made the first cut of this rule look
 * satisfied while the site stayed stale.
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
import { HOST_FILE_MAX_BYTES } from '../lib/site-links.js';

/**
 * Below this, a video is already itself: copied byte for byte.
 *
 * 20 MiB is deliberately under `HOST_FILE_MAX_BYTES` (25 MiB). Anything in
 * that band is small enough to serve and is a video somebody already encoded
 * for a purpose, so re-packing it would cost quality and time for nothing.
 */
export const VIDEO_COMPRESS_ABOVE = 20 * 1024 * 1024;

/**
 * The size a re-encoded video has to land under: `HOST_FILE_MAX_BYTES`, the
 * deploying host's per-asset ceiling, defined once in `lib/site-links.js`
 * next to the origin it belongs to.
 *
 * The first version of this file targeted GitHub's 100 MB limit and produced
 * a 36.8 MB MP4: pushable, and refused by Pages, which never published the
 * deployment at all. There is deliberately no second constant here - two
 * numbers for one limit is how the two halves drifted apart.
 */
const VIDEO_MAX_BYTES = HOST_FILE_MAX_BYTES;

const CRF = '26';
const MAX_HEIGHT = 1080;
const AUDIO_KBPS = 96;
// Headroom for container overhead, GOP spikes and x264's own estimate of the
// rate ceiling; `-maxrate` is a VBV cap, so 0.9 of the byte budget is what
// reliably lands under it rather than 1.0 of it landing just over.
const BUDGET_SAFETY = 0.9;
// `medium`, not `slow`: the encode runs again after every `wipePrevious()`,
// and 10-15% fewer bytes is not worth turning `npm run verify` into a
// several-minute wait. The cache below is what keeps the repeat cost down.
const PRESET = 'medium';

/**
 * Duration in seconds, from the container. Needed to turn a byte budget into
 * a bitrate cap; `null` when ffprobe is missing, in which case the encode
 * runs unconstrained on quality and the size is checked afterwards.
 */
function probeDuration(src) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src,
    ], { encoding: 'utf8' });
    const seconds = Number.parseFloat(out.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

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
 * Re-encode `src` into `dst` so the result fits in `maxBytes`, keeping the
 * source's own resolution (never upscaling: `min(1080,ih)`) and its audio.
 *
 * The budget is turned into a rate cap rather than a lower quality number:
 * CRF alone is a quality promise with no size promise, which is exactly how
 * the 36.8 MB file that Pages refused was produced. `-crf 26` still decides
 * quality frame by frame, and `-maxrate` / `-bufsize` (a VBV cap) keep the
 * total under `BUDGET_SAFETY` of the byte budget minus the audio track. When
 * `ffprobe` cannot give a duration the cap is omitted and the size is
 * verified afterwards instead - a video that fails that check is not shipped
 * and the build says so, rather than shipping something the host will reject.
 *
 * Returns `{ ok, fromBytes, toBytes, note, cached }` and never throws - the
 * caller decides what a failure means for that product page, and
 * `execFileSync` hands back ffmpeg's whole stderr, which is 40 lines of
 * banner and progress and is not something to put in a build report.
 *
 * The encode is cached under `work/video-cache/` keyed by name, size, source
 * mtime and the byte budget, because `build.mjs` wipes
 * `dist/uploads/new-releases/` on every run and a 1080p re-encode must not be
 * the price of editing one headline. The budget is part of the key so a cache
 * entry written under a looser limit (the 100 MB-era 36.8 MB file is exactly
 * that) can never be replayed as if it satisfied the current one. It is still
 * a cache, not an input: deleting `work/` costs a few minutes, and a source
 * file the owner re-exported has a new mtime, so it re-encodes.
 */
export function compressVideo(src, dst, maxBytes = VIDEO_MAX_BYTES) {
  const source = statSync(src);
  const fromBytes = source.size;
  if (!hasFfmpeg()) {
    return { ok: false, fromBytes, toBytes: 0, note: 'ffmpeg not installed' };
  }

  const cacheDir = join(paths.work, 'video-cache');
  const key = `${basename(src, extname(src))}-${fromBytes}-${Math.round(source.mtimeMs)}-${maxBytes}`
    .replace(/[^A-Za-z0-9._-]/g, '_') + '.mp4';
  const cached = join(cacheDir, key);

  if (existsSync(cached) && statSync(cached).size <= maxBytes) {
    copyFileSync(cached, dst);
    return { ok: true, fromBytes, toBytes: statSync(dst).size, cached: true };
  }

  const duration = probeDuration(src);
  const videoKbps = duration
    ? Math.max(300, Math.floor((maxBytes * 8 * BUDGET_SAFETY) / duration / 1000) - AUDIO_KBPS)
    : 0;

  const encode = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-vf', `scale=-2:'min(${MAX_HEIGHT},ih)'`,
    '-c:v', 'libx264', '-crf', CRF, '-preset', PRESET, '-pix_fmt', 'yuv420p'];
  if (videoKbps) encode.push('-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`);
  encode.push('-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`,
    // Faststart puts the moov atom first, which is what lets the browser
    // begin playback before the file has finished downloading. A demo
    // video the visitor has to wait out entirely is not a demo video.
    '-movflags', '+faststart', dst);

  try {
    execFileSync('ffmpeg', encode, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    const first = String(error.stderr ?? error.message).split('\n').filter(Boolean).pop() ?? '';
    return { ok: false, fromBytes, toBytes: 0, note: first.slice(0, 90) };
  }

  if (!existsSync(dst)) {
    return { ok: false, fromBytes, toBytes: 0, note: 'ffmpeg wrote nothing' };
  }
  const toBytes = statSync(dst).size;
  if (toBytes > maxBytes) {
    return { ok: false, fromBytes, toBytes: 0, note: `re-encode still ${MB(toBytes)}, over the ${MB(maxBytes)} host limit` };
  }
  if (toBytes >= fromBytes) {
    // Rare (an already-maxed encode), but the fallback must not be "shipped
    // a bigger file": drop the output and let the caller report the skip.
    return { ok: false, fromBytes, toBytes: 0, note: 're-encode not smaller' };
  }

  mkdirSync(cacheDir, { recursive: true });
  copyFileSync(dst, cached);
  return { ok: true, fromBytes, toBytes };
}

/** A byte count in the unit the host states its limits in. */
export const MB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;