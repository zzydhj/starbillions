/**
 * Why the desktop cache variant sometimes has no canonical link.
 *
 *   node tools/ingest/wp/probe-variants.mjs
 *
 * The mirror builder prefers index-https.html over index-mobile-https.html, and 97
 * of 217 directories then reported no canonical URL, while an earlier pass that read
 * the larger of the two found a canonical in all 217. One of those two facts is
 * wrong, and which one decides whether the builder picks the right file or needs a
 * different rule. So each pair is inspected: size, canonical presence, the exact
 * markup of the canonical tag, and how the two variants differ.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../lib/paths.js';

const DESKTOP = 'index-https.html';
const MOBILE = 'index-mobile-https.html';

const directories = [];
const visit = (dir, rel) => {
  const entries = readdirSync(dir, { withFileTypes: true });
  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));

  if (names.has(DESKTOP) || names.has(MOBILE)) directories.push({ dir, rel, names });
  for (const entry of entries) if (entry.isDirectory()) visit(join(dir, entry.name), `${rel}/${entry.name}`);
};
visit(paths.pageCache, '');

const patterns = {
  doubleQuoted: /<link rel="canonical" href="([^"]+)"/,
  anyLink: /<link[^>]*rel=["']?canonical["']?[^>]*>/i,
  hrefAnywhere: /href=["']([^"']+)["'][^>]*rel=["']?canonical/i,
};

const tally = { desktop: 0, mobile: 0, both: 0, neither: 0 };
const failures = [];

for (const entry of directories) {
  const read = (name) => {
    if (!entry.names.has(name)) return null;
    return readFileSync(join(entry.dir, name), 'utf8');
  };

  const desktop = read(DESKTOP);
  const mobile = read(MOBILE);

  const has = (text) => {
    if (text === null) return 'absent';
    if (patterns.doubleQuoted.test(text)) return 'double';
    if (patterns.anyLink.test(text)) return 'other-form';
    return 'none';
  };

  const d = has(desktop);
  const m = has(mobile);

  if (d !== 'absent' && m !== 'absent') tally.both += 1;
  else if (d !== 'absent') tally.desktop += 1;
  else if (m !== 'absent') tally.mobile += 1;
  else tally.neither += 1;

  if (d === 'none' || d === 'other-form' || d === 'absent') {
    failures.push({ rel: entry.rel, desktop: d, mobile: m, desktopBytes: desktop?.length ?? 0, mobileBytes: mobile?.length ?? 0 });
  }
}

console.log(`\n  cache directories: ${directories.length}\n`);
console.log(`  both variants carry a canonical   ${tally.both}`);
console.log(`  desktop only                      ${tally.desktop}`);
console.log(`  mobile only                       ${tally.mobile}`);
console.log(`  neither carries one               ${tally.neither}\n`);

console.log(`  directories whose desktop file did not match the simple pattern: ${failures.length}\n`);
for (const item of failures.slice(0, 10)) {
  console.log(`    ${item.desktop.padEnd(11)} desktop=${String(item.desktopBytes).padStart(8)}  mobile=${String(item.mobileBytes).padStart(8)}  ${item.rel.slice(0, 56)}`);
}

if (failures.length > 0) {
  const sample = join(paths.pageCache, failures[0].rel.replace(/^\/+/, ''), DESKTOP);
  const text = readFileSync(sample, 'utf8');
  const head = text.slice(0, 700).replace(/\s+/g, ' ');
  console.log(`\n  first 700 chars of ${failures[0].rel}\n`);
  console.log(`    ${head}\n`);
}
