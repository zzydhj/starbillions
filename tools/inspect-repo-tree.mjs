/**
 * Does the committed artifact actually match the built one?
 *
 *   node tools/inspect-repo-tree.mjs [ref]
 *
 * This exists because a shell comparison said the two differed. On Windows the
 * console decodes a child process's stdout with the OEM codepage (936 here), so a
 * repository holding correct UTF-8 names reads back as mojibake and a genuinely
 * broken repository reads back exactly the same way. The two cases are
 * indistinguishable through the shell, and one of them means every Chinese URL 404s
 * after deploy while the other means nothing is wrong at all.
 *
 * So the bytes are read directly and decoded as UTF-8 explicitly, then compared
 * against the filesystem. Nothing about the terminal's settings can influence it.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './lib/paths.js';

const ref = process.argv[2] ?? 'origin/main';

const listed = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', ref], {
  cwd: paths.root,
  maxBuffer: 64 * 1024 * 1024,
  encoding: 'utf8',
})
  .split('\n')
  .filter((line) => line.startsWith('dist/'))
  .map((line) => line.slice('dist/'.length));

const onDisk = [];
collect(paths.dist, '');
function collect(dir, prefix) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) collect(abs, rel);
    else onDisk.push(rel);
  }
}

const inRepo = new Set(listed);
const onDiskSet = new Set(onDisk);

const missingFromRepo = onDisk.filter((rel) => !inRepo.has(rel));
const extraInRepo = listed.filter((rel) => !onDiskSet.has(rel));

console.log(`\n  ${ref}:dist  vs  disk dist\n`);
console.log(`  committed   ${listed.length}`);
console.log(`  built       ${onDisk.length}`);
console.log(`  只在磁盘    ${missingFromRepo.length}`);
console.log(`  只在仓库    ${extraInRepo.length}`);

for (const rel of missingFromRepo.slice(0, 5)) console.log(`    - ${rel}`);
for (const rel of extraInRepo.slice(0, 5)) console.log(`    + ${rel}`);

/**
 * Chinese-named entries are the interesting ones: if they survived the commit as
 * correct UTF-8, the deploy serves them; if not, they 404 and only a live request
 * would say so. Report a couple of decoded names so the answer is visible, not just
 * a count.
 */
const cjk = listed.filter((rel) => /[\u4e00-\u9fff]/.test(rel));
console.log(`\n  仓库里含中文的路径 ${cjk.length} 条，解码后示例：`);
for (const rel of cjk.slice(0, 3)) console.log(`    ${rel}`);

const nonAscii = execFileSync('git', ['ls-tree', '-r', '--name-only', ref], {
  cwd: paths.root,
  maxBuffer: 64 * 1024 * 1024,
}).length;
console.log(`\n  (字节数 ${nonAscii}，说明读取绕过了终端编码)\n`);

process.exit(missingFromRepo.length + extraInRepo.length === 0 ? 0 : 1);
