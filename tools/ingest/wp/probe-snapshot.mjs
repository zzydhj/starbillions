/**
 * Does the backup already hold rendered page snapshots?
 *
 *   node tools/ingest/wp/probe-snapshot.mjs
 *
 * If post_content carried complete documents, a pixel-level static mirror would
 * need no PHP at all — copy the markup, localise the asset URLs, done. This
 * settles that instead of assuming either way, because only 3 of the 12 pages
 * even have Elementor data, which made a snapshot export plausible enough to test.
 */
import { readDump } from './sql-dump.js';
import { toObjects } from './model.js';

const dump = readDump('work/tftstar.sql', ['wp_posts']);
const rows = toObjects(dump, 'wp_posts').filter((row) => row.post_status === 'publish');

const has = (pattern) => rows.filter((row) => pattern.test(String(row.post_content)));

for (const [label, pattern] of [
  ['<!DOCTYPE', /<!DOCTYPE/i],
  ['<html', /<html[\s>]/i],
  ['<header', /<header[\s>]/i],
  ['<footer', /<footer[\s>]/i],
  ['stylesheet link', /<link[^>]+rel=["']stylesheet/i],
  ['woodmart wd- class', /class=["'][^"']*\bwd-/],
  ['elementor section', /class=["'][^"']*\be-elementor\b/],
]) {
  const found = has(pattern);
  console.log(`  ${label.padEnd(22)} ${String(found.length).padStart(4)}  ${found.slice(0, 3).map((row) => `${row.post_type}:${short(row)}`).join('  ')}`);
}

function short(row) {
  return String(row.post_name).slice(0, 26);
}
