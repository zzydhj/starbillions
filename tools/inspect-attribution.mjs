/**
 * Did the mirror create a defect, or inherit it?
 *
 *   node tools/inspect-attribution.mjs
 *
 * Two findings from a browser check needed attributing before any fix, because they
 * lead to opposite work. The browser reported href="http://1" style links as damage
 * done by the staticisation, yet the same strings had already been counted in the
 * site's own cached HTML - only a source-versus-output comparison can say which is
 * true. And Font Awesome's web fonts returned 404, the likeliest cause being that the
 * mirror scans pages for assets but never follows a url() inside a stylesheet.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { paths } from './lib/paths.js';
import { walk } from './lib/fs-utils.js';

const source = readFileSync(join(paths.pageCache, 'index-https.html'), 'utf8');
const built = readFileSync(join(paths.dist, 'index.html'), 'utf8');

const count = (text, needle) => text.split(needle).length - 1;

console.log('\n  首页：可疑 href 在源缓存与产物里各出现几次\n');

for (const needle of ['href="http://1"', 'href="http://3"', 'href="http://\u70ed\u5356\u4ea7\u54c1"', 'href="//']) {
  const before = count(source, needle);
  const after = count(built, needle);

  const verdict = before === after
    ? '数量一致，原样继承，非镜像所造'
    : before < after
      ? '产物里更多，是镜像造成的'
      : '产物里更少，改写过程中被消化';

  console.log(`    ${String(before).padStart(5)} -> ${String(after).padStart(5)}   ${needle}   ${verdict}`);
}

/**
 * Assets reachable only from inside a stylesheet.
 *
 * The mirror's asset scan reads the pages, so a font or image named only by a copied
 * .css file never gets copied. Each url() is resolved the way a browser resolves it -
 * against the stylesheet's own directory, unless it starts at the site root - because
 * getting that wrong would report as missing files the site actually loads fine.
 */
const CSS_URL = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;

const present = new Set();
const missing = new Map();

const cssFiles = walk(join(paths.dist, 'wp-content')).filter((file) => file.rel.endsWith('.css'));

for (const file of cssFiles) {
  const text = readFileSync(file.abs, 'utf8');

  for (const match of text.matchAll(CSS_URL)) {
    const raw = safeDecode(match[1].split('?')[0].split('#')[0]);
    if (raw.startsWith('data:')) continue;

    const target = raw.startsWith('/')
      ? join(paths.dist, raw.replace(/^\/+/, ''))
      : resolve(dirname(file.abs), raw);

    if (!target.startsWith(paths.dist)) continue;

    const rel = target.slice(paths.dist.length + 1).split('\\').join('/');
    if (!/^wp-(?:content|includes)\//.test(rel)) continue;

    if (existsSync(target)) present.add(rel);
    else missing.set(rel, existsSync(join(paths.docroot, rel)));
  }
}

console.log(`\n  样式表内部引用的同源文件（扫描 ${cssFiles.length} 个已拷贝的 CSS）\n`);
console.log(`    产物中已存在     ${present.size}`);
console.log(`    产物中缺失       ${missing.size}，其中备份里其实有文件、镜像漏拷的 ${[...missing.values()].filter(Boolean).length} 个\n`);

for (const [rel, inBackup] of [...missing].slice(0, 14)) {
  console.log(`    ${inBackup ? '备份里有，镜像漏拷  ' : '备份里也没有        '}  /${rel}`);
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
