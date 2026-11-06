/**
 * Downloads the Google Fonts the mirror actually asks for, into public/fonts/.
 *
 *   npm run fonts      then      npm run mirror
 *
 * Run it once, and again if the site's typography settings change. It needs network
 * access, which the mirror itself never does - that separation is why it is a
 * separate command rather than a build step: a build that reaches the internet
 * succeeds today and fails in a month, and nothing in the output says which.
 *
 * What to fetch is read from the built pages, not written down here, so the site
 * stays the authority on its own families: change the theme's font option and the
 * next run picks up the new family by itself.
 *
 * Font files land under a name derived from their URL. Google's basenames are short
 * hashes that collide across families once you strip the directory, and two fonts
 * silently overwriting each other is the kind of defect that shows up as one odd
 * glyph on one browser, months later.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './lib/paths.js';
import { googleFontStylesheetUrls } from './lib/site-links.js';

/** A browser UA, because Google serves ttf to agents that do not advertise woff2. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const outDir = join(paths.public, 'fonts');

/**
 * Every distinct Google Fonts stylesheet URL the built pages ask for.
 *
 * The finder is the one the rewriter uses, on purpose: if this list were built by its
 * own pattern, a difference in quoting or parameter order would produce manifest keys
 * the build never looks up, and the site would keep calling Google quietly.
 */
function collectUrls() {
  const found = new Set();

  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        if (entry !== '_next') walk(abs);
        continue;
      }
      if (!entry.endsWith('.html')) continue;

      for (const url of googleFontStylesheetUrls(readFileSync(abs, 'utf8'))) found.add(url);
    }
  })(paths.dist);

  return [...found];
}

async function getText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function getBinary(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const name = (url) => `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.woff2`;

mkdirSync(outDir, { recursive: true });

const urls = collectUrls();
if (urls.length === 0) {
  console.log('\n  fonts: no Google Fonts references in dist/ - run npm run mirror first\n');
  process.exit(0);
}

console.log(`\n  fonts: ${urls.length} stylesheet(s)\n`);

const manifest = {};
const wanted = new Map();

for (const url of urls) {
  const css = await getText(url);

  // Google's response is a list of @font-face blocks, one per unicode-range slice.
  // Each src is rewritten to the local name; the URL is remembered so it can be
  // downloaded once, however many blocks ask for it.
  const local = css.replace(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g, (_all, fontUrl) => {
    wanted.set(fontUrl, name(fontUrl));
    return `url(/fonts/${name(fontUrl)})`;
  });

  const slug = createHash('sha1').update(url).digest('hex').slice(0, 12);
  manifest[url] = `/fonts/${slug}.css`;
  writeFileSync(join(outDir, `${slug}.css`), local, 'utf8');

  const faces = (local.match(/@font-face/g) || []).length;
  console.log(`  ${manifest[url]}  ${faces} face(s)  <- ${url.slice(0, 72)}`);
}

let bytes = 0;
for (const [fontUrl, file] of wanted) {
  const body = await getBinary(fontUrl);
  writeFileSync(join(outDir, file), body);
  bytes += body.length;
}

writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`\n  fonts: ${wanted.size} file(s), ${(bytes / 1048576).toFixed(1)} MB -> public/fonts/`);
console.log('  now run: npm run mirror && npm run verify\n');
