/**
 * Which structural markers the mirror can reuse, and whether language-prefixed
 * links have a real target.
 *
 *   node tools/ingest/wp/probe-skeleton.mjs
 *
 * Two questions the mirror cannot answer from the database. Whether the theme's
 * header and footer can be lifted out of an existing page to build a 404 page - the
 * site never cached a 404, so one has to be assembled from its own chrome - and
 * whether TranslatePress's hardcoded /zh_cn/ links have a counterpart in the mirror
 * once the prefix is stripped, which decides if stripping it fixes 5199 links or
 * merely moves the 404 somewhere else.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../lib/paths.js';

const MARKERS = [
  'id="site-header"',
  '<header',
  '</header>',
  'id="main"',
  'id="footer-warp"',
  '<footer',
  '</footer>',
  'data-settings',
  'wp-admin/admin-ajax',
  '/en/zh_cn/',
  '/zh_cn/',
];

function count(text, needle) {
  return text.split(needle).length - 1;
}

for (const [label, file] of [['zh home', 'index.html'], ['en home', 'en/index.html']]) {
  const abs = join(paths.dist, file);
  if (!existsSync(abs)) {
    console.log(`  ${label}: dist/${file} missing`);
    continue;
  }

  const text = readFileSync(abs, 'utf8');
  console.log(`\n  ${label}  (${(text.length / 1024).toFixed(0)} KB)`);
  for (const marker of MARKERS) console.log(`    ${String(count(text, marker)).padStart(5)}  ${marker}`);
}

const candidates = [
  '联系我们/index.html',
  'en/联系我们/index.html',
  'en/contact-us/index.html',
  'contact-us/index.html',
  '产品中心/index.html',
  'en/产品中心/index.html',
];

console.log('\n  language-prefixed link targets, after stripping /zh_cn/\n');
for (const candidate of candidates) {
  console.log(`    ${existsSync(join(paths.dist, candidate)) ? '存在  ' : '缺失  '}  /${candidate.replace('/index.html', '/').replace(/^$/, '/')}`);
}
