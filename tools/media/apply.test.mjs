/**
 * Tests for the media manifest's effect on a document.
 *
 *   npm test
 *
 * These are the only place the WebP rule can be examined honestly. A wrong substitution
 * is invisible in a browser: the page still shows a picture, because the original is
 * usually still on the host - it just is not the file the build intended, or it is a
 * 404 the moment the original gets pruned. So the fixtures are the site's real bytes,
 * taken from work/media/manifest.json and the shipped documents: the same image spelled
 * raw and percent-encoded in one document, a filename with a space, a <video> whose
 * source sits in data-lazy-load rather than src, and one converted picture no shipped
 * page asks for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addVideoPosters,
  applyMediaManifest,
  keyForReference,
  mediaOutputs,
  namedAssetPaths,
  pathPattern,
  prunableOriginals,
  spellingsOf,
  substituteImages,
  unaskedOutputs,
} from './apply.js';

const WECHAT = '/wp-content/uploads/2023/11/微信图片_2023111.jpg';
const WECHAT_WEBP = `${WECHAT}.webp`;
const BLOG = '/wp-content/uploads/2021/08/wd-blog-2.jpg';
const SPACE = '/wp-content/uploads/2023/12/Picture-topaz copy.png';
const VIDEO = '/wp-content/uploads/2023/12/Main-video.mp4';
// A stand-in for "the host this site is served from". Deliberately not one of the two
// real domains: a fixture that looks like a deployment invites the reader to ask which
// site it is, and a test whose input is a real address of a real site is a test that can
// only pass in one of the two repositories that share this code.
const SITE = 'https://mirror.example.test';

const manifest = {
  images: {
    [WECHAT]: { to: WECHAT_WEBP, fromKb: 201, toKb: 75 },
    [BLOG]: { to: `${BLOG}.webp`, fromKb: 177, toKb: 108 },
    [SPACE]: { to: `${SPACE}.webp`, fromKb: 512, toKb: 35 },
  },
  posters: {
    [VIDEO]: { to: '/wp-content/uploads/2023/12/Main-video.poster.webp', toKb: 46 },
  },
};

/* ---------------------------------------------------------------- images --- */

test('substituteImages rewrites every spelling one document uses for one picture', () => {
  // The raw and the percent-encoded spelling of the same file both occur in this site's
  // shipped pages - measured on the built documents, 6,206 raw and 14,185 encoded hits.
  const html = [
    `<img src="/wp-content/uploads/2023/11/${encodeURIComponent('微信图片_2023111.jpg')}" />`,
    `<img src="${WECHAT}" />`,
    `<meta property="og:image" content="${SITE}${WECHAT}" />`,
    `<img src="/wp-content/uploads/2023/12/lazy.png" data-wood-src="${SPACE}?ver=6.2" srcset="/wp-content/uploads/2023/12/Picture-topaz%20copy.png 400w, ${SPACE} 800w" />`,
    '<div data-settings=\'{"bg":"/wp-content/uploads/2023/11/微信图片_2023111.jpg"}\'></div>',
    '<style>.x{background-image:url(/wp-content/uploads/2023/11/微信图片_2023111.jpg)}</style>',
  ].join('\n');

  const out = substituteImages(html, manifest);

  assert.equal(out.replaced, 8, 'five on the WeChat picture and three on the space-named file, whichever attribute they sit in');
  assert.ok(out.html.includes(`/wp-content/uploads/2023/11/${encodeURIComponent('微信图片_2023111.jpg')}.webp`), 'the encoded spelling stays encoded and gains the suffix');
  assert.ok(out.html.includes(`${WECHAT}.webp`), 'the raw spelling gains it too');
  assert.ok(out.html.includes(`${SITE}${WECHAT}.webp`), 'an absolute identity url is rewritten by the same rule');
  assert.ok(out.html.includes(`${SPACE}.webp?ver=6.2`), 'a query string survives after the new extension');
  assert.ok(out.html.includes('Picture-topaz%20copy.png.webp 400w'), 'each srcset candidate keeps its descriptor');
  assert.ok(out.html.includes('url(/wp-content/uploads/2023/11/微信图片_2023111.jpg.webp)'), 'inline CSS url() is not a special case');
  assert.ok(out.html.includes('/wp-content/uploads/2023/12/lazy.png'), 'a file that is not in the manifest is left alone');
});

test('substituteImages is idempotent and cannot eat a longer filename', () => {
  const html = `<img src="${WECHAT}" /><img src="${WECHAT}.png" /><img src="${WECHAT}-2.jpg" />`;

  const once = substituteImages(html, manifest);
  const twice = substituteImages(once.html, manifest);

  assert.equal(once.replaced, 1, 'only the exact name matches, not the .png and -2.jpg that start with it');
  assert.equal(twice.replaced, 0, 'a second pass finds nothing, so the count cannot double');
  assert.ok(twice.html.includes(`${WECHAT}.webp`));
  assert.ok(twice.html.includes(`${WECHAT}.png`));
});

test('substituteImages leaves a data: URI and an unrelated file alone', () => {
  const html = '<img src="data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%3E%3C/svg%3E" alt=""/>';

  const out = substituteImages(html, manifest);

  assert.equal(out.replaced, 0);
  assert.equal(out.html, html);
});

/* --------------------------------------------------------------- posters --- */

test('addVideoPosters gives a lazy video the frame of its own first second', () => {
  // The real tag shape: WoodMart defers the source into data-lazy-load, so there is no
  // src attribute at all, and without a poster the browser paints a black box.
  const tag = '<video loop type="video/mp4" playsinline data-lazy-load="/wp-content/uploads/2023/12/Main-video.mp4">';

  const out = addVideoPosters(tag, manifest);

  assert.equal(out.added, 1);
  assert.match(out.html, /poster="\/wp-content\/uploads\/2023\/12\/Main-video\.poster\.webp"/);
  assert.match(out.html, /preload="none"/);
  assert.ok(out.html.startsWith('<video loop type="video/mp4" playsinline data-lazy-load="/wp-content/uploads/2023/12/Main-video.mp4"'), 'the source attribute is untouched');
  assert.ok(out.html.endsWith('>'), 'and the tag stays a tag');
});

test('addVideoPosters takes the source spelling it was given, and never overwrites', () => {
  const encoded = `<video data-lazy-load="/wp-content/uploads/2024/01/${encodeURIComponent('6bca_下午.mp4')}"></video>`;
  const absolute = `<video src="${SITE}${VIDEO}"></video>`;
  const already = `<video poster="/somewhere/else.jpg" src="${VIDEO}"></video>`;

  const withPoster = addVideoPosters(absolute, manifest);
  assert.equal(withPoster.added, 1, 'an absolute source resolves through the same key as a root-relative one');
  assert.equal(keyForReference(`${SITE}${VIDEO}?ver=1`), VIDEO, 'host and query do not change the manifest key');

  assert.ok(
    withPoster.html.includes(`poster="${SITE}${VIDEO.replace(/\.mp4$/i, '')}.poster.webp"`),
    'the poster keeps the source\u2019s own host and spelling, and takes the name the converter wrote',
  );

  const untouched = addVideoPosters(already, manifest);
  assert.equal(untouched.added, 0, 'a poster the source already had is not replaced');

  const noEntry = addVideoPosters(encoded, manifest);
  assert.equal(noEntry.added, 0, 'a video with nothing converted for it stays exactly as it was');
  assert.equal(noEntry.html, encoded);
});

/* ------------------------------------------------------------ the output --- */

test('namedAssetPaths reads a reference in every spelling without stopping halfway through a name', () => {
  const text = [
    `<img src="${WECHAT}.webp" srcset="${encodeURI(SPACE)}.webp 800w">`,
    `<style>.a{background:url(${BLOG})}</style>`,
    '<a href="/product/starbillions-1-28″-tft-xby128fhd/">产品</a>',
  ].join('\n');

  const named = namedAssetPaths(text, manifest);

  assert.ok(named.has('wp-content/uploads/2023/11/微信图片_2023111.jpg.webp'), 'the converted file is what the page names now');
  assert.ok(!named.has('wp-content/uploads/2023/11/微信图片_2023111.jpg'), 'and the original is not - which is what makes it prunable');
  assert.ok(named.has('wp-content/uploads/2023/12/Picture-topaz copy.png.webp'), 'a %20 srcset candidate counts as naming the file the host serves');
  assert.ok(named.has('wp-content/uploads/2021/08/wd-blog-2.jpg'), 'a url() inside a style element is a reference');
  assert.equal(namedAssetPaths('<p>no pictures here</p>', manifest).size, 0);
  assert.equal(namedAssetPaths(`<img src="${WECHAT}">`, { images: {} }).size, 0, 'an empty manifest has no directories to look in, so it finds nothing');
});

test('prunableOriginals drops a replaced original only when nothing names it', () => {
  const rewritten = namedAssetPaths(`<img src="${WECHAT}.webp" srcset="${encodeURI(SPACE)}.webp 800w">`, manifest);
  const cssStillNamesIt = namedAssetPaths(`.hero{background:url(${BLOG})}`, manifest);

  assert.deepEqual(
    prunableOriginals(manifest, new Set([...rewritten, ...cssStillNamesIt])),
    [WECHAT, SPACE],
    'the blog jpg is kept because a stylesheet still points at its original',
  );
  assert.deepEqual(
    prunableOriginals(manifest, new Set([...rewritten, ...cssStillNamesIt, ...namedAssetPaths(`<img src="${SPACE}">`, manifest)])),
    [WECHAT],
    'the moment any text names the original, it ships',
  );
  assert.deepEqual(prunableOriginals({ images: {} }, new Set()), [], 'an empty manifest prunes nothing');
});

test('unaskedOutputs finds a converted file no document mentions', () => {
  const named = namedAssetPaths(`<img src="${WECHAT}.webp">`, manifest);

  assert.deepEqual(unaskedOutputs(manifest, named), [
    `${SPACE}.webp`,
    `${BLOG}.webp`,
    '/wp-content/uploads/2023/12/Main-video.poster.webp',
  ].sort(), 'only the one page asked for ships; the rest stays in work/media/');
});

test('mediaOutputs lists each converted file once, originals and posters together', () => {
  const outputs = mediaOutputs(manifest);

  assert.equal(outputs.length, 4, 'three images and one poster');
  assert.ok(outputs.includes(WECHAT_WEBP));
  assert.ok(outputs.includes('/wp-content/uploads/2023/12/Main-video.poster.webp'));
  assert.deepEqual(outputs, [...outputs].sort(), 'sorted, so a build log reads the same twice');
  assert.deepEqual(mediaOutputs(null), [], 'no manifest, no outputs');
});

test('applyMediaManifest is a no-op without a manifest, and a single pass with one', () => {
  const html = `<img src="${WECHAT}"><video data-lazy-load="${VIDEO}"></video>`;

  const untouched = applyMediaManifest(html, null);
  assert.equal(untouched.applied, false, 'npm run images has not been run: the backup keeps its own bytes');
  assert.equal(untouched.html, html);
  assert.equal(untouched.images, 0);

  const applied = applyMediaManifest(html, manifest);
  assert.equal(applied.applied, true);
  assert.equal(applied.images, 1);
  assert.equal(applied.posters, 1);
  assert.ok(applied.html.includes(`${WECHAT}.webp`));
  assert.ok(applied.html.includes('Main-video.poster.webp'));
});

test('pathPattern and spellingsOf cover both writings of a name, or one when there is only one', () => {
  const [raw, encoded] = spellingsOf(WECHAT);

  assert.equal(raw, WECHAT);
  assert.equal(encoded, `/wp-content/uploads/2023/11/${encodeURIComponent('微信图片_2023111.jpg')}`);
  assert.deepEqual(spellingsOf('/wp-content/uploads/2021/08/plain.jpg'), ['/wp-content/uploads/2021/08/plain.jpg'], 'an ASCII name has one spelling, not two identical branches');

  const pattern = pathPattern(WECHAT);
  assert.ok(`/x ${encoded} `.match(pattern), 'the encoded branch matches');
  assert.ok(`${raw}"`.match(pattern), 'the raw branch matches');
  assert.ok(!`${raw}.webp`.match(pattern), 'a path already converted is not converted again');
});
