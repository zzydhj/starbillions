/**
 * What the odd external hosts in the cached pages actually are.
 *
 *   node tools/ingest/wp/probe-strange-hosts.mjs
 *
 * The asset check said every local file is present, but the same pass counted
 * 1477 references to `0.0.0.1`, 422 to `0.0.0.3` and 693 to
 * `starbillions.savetime.work`. Those are not plausible content hosts: an address
 * like 0.0.0.1 usually means a value that was substituted into a template
 * incorrectly, and a `.work` domain suggests a preview or backup service. Which
 * one it is decides whether the mirror has to replace them, so the raw references
 * are printed rather than theorised about.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../../lib/paths.js';
import { walk } from '../../lib/fs-utils.js';

const CACHE = join(root, 'work', 'wp', 'tftstar.com', 'wp-content', 'cache', 'wp-rocket', 'tftstar.com');
const WANTED = ['0.0.0.1', '0.0.0.3', 'starbillions.savetime.work', 'xn--wlqy7if5af60e', 'gmpg.org'];

const samples = new Map(WANTED.map((host) => [host, []]));
const contexts = new Map(WANTED.map((host) => [host, []]));
const counts = new Map(WANTED.map((host) => [host, 0]));

for (const file of walk(CACHE)) {
  if (!file.abs.toLowerCase().endsWith('.html')) continue;

  const text = readFileSync(file.abs, 'utf8');

  for (const host of WANTED) {
    // The scheme is optional: a protocol-relative //0.0.0.1/... is what the URL
    // parse in the asset probe reported, and requiring https?:// here found none
    // of it, which is how the two counts disagreed.
    const pattern = new RegExp(`(?:https?:)?//${host.replace(/\./g, '\\.')}[^"'\\s<>]*`, 'g');

    for (const match of text.matchAll(pattern)) {
      counts.set(host, counts.get(host) + 1);
      if (samples.get(host).length < 4) samples.get(host).push(match[0]);
      if (contexts.get(host).length < 2) {
        const start = Math.max(0, match.index - 120);
        contexts.get(host).push(text.slice(start, match.index + 160).replace(/\s+/g, ' '));
      }
    }
  }
}

for (const host of WANTED) {
  console.log(`\n  ${host}  -  ${counts.get(host)} reference(s)`);
  for (const url of samples.get(host)) console.log(`    ${url.slice(0, 160)}`);
  for (const snippet of contexts.get(host).slice(0, 1)) {
    console.log(`    context: ${snippet.slice(0, 240)}`);
  }
}
