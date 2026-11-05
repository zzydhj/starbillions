/**
 * Every call-to-action in the mirror, grouped by its label and destination.
 *
 *   node tools/inspect-buttons.mjs
 *
 * Asked to send all enquiry buttons to one WhatsApp link, the only safe way to do it
 * is to enumerate what is actually on the site first. "Inquire about this product" is
 * one Elementor button on product pages, but a site like this usually has several
 * doors to the same place - header buttons, contact banners, floating chat widgets,
 * Chinese-labelled equivalents of the English ones - and a change that catches only
 * the visible one leaves a half-migrated site that looks deliberate.
 *
 * Grouping by (label, href) rather than listing occurrences is what makes the answer
 * readable: 34 identical buttons are one row, and one row per distinct destination.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './lib/paths.js';
import { walk } from './lib/fs-utils.js';

const documents = walk(paths.dist)
  .filter((file) => file.rel.endsWith('.html'))
  .map((file) => ({ ...file, text: readFileSync(file.abs, 'utf8') }));

/**
 * Elementor renders a button as <a class="elementor-button elementor-button-link"
 * href="..."> wrapping <span class="elementor-button-text">label</span>. Other themes
 * use plain anchors with a button class, so the match is on the class and the label is
 * taken from whatever text the anchor holds.
 */
const BUTTON_ANCHOR = /<a\b[^>]*class="[^"]*(?:elementor-button|btn|button|wd-button)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
const HREF = /\bhref="([^"]*)"/i;
const LABEL = />([^<>{}]{2,60})</;

const groups = new Map();
const chaty = new Map();

for (const doc of documents) {
  for (const match of doc.text.matchAll(BUTTON_ANCHOR)) {
    const inner = match[1];
    const href = HREF.exec(match[0])?.[1] ?? '(no href)';
    const label = stripTags(inner).slice(0, 46) || '(empty)';

    if (label === '(empty)' && href === '(no href)') continue;

    const key = `${label}  ->  ${hostOf(href)}${shorten(href)}`;
    const entry = groups.get(key) ?? { count: 0, label, href, pages: new Set() };
    entry.count += 1;
    entry.pages.add(bucket(doc.rel));
    groups.set(key, entry);
  }

  // The Chaty floating widget is a separate mechanism with its own settings blob;
  // it already points somewhere, and that destination matters for consistency.
  for (const match of doc.text.matchAll(/chaty[^\n]{0,400}?wa\.me\/(\d{6,15})/gi)) {
    chaty.set(match[1], (chaty.get(match[1]) ?? 0) + 1);
  }
  for (const match of doc.text.matchAll(/(?:wa\.me|api\.whatsapp\.com\/send)\?phone=(\d{6,15})|(?:wa\.me|api\.whatsapp\.com\/send)\/(\d{6,15})/gi)) {
    const number = match[1] ?? match[2];
    chaty.set(number, (chaty.get(number) ?? 0) + 1);
  }
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function hostOf(href) {
  try {
    const url = new URL(href, 'https://tftstar.com');
    return url.hostname === 'tftstar.com' ? '' : `${url.hostname} `;
  } catch {
    return '';
  }
}

function shorten(href) {
  const decoded = decodeURIComponent(href);
  return decoded.length > 64 ? `${decoded.slice(0, 61)}...` : decoded;
}

/** Group pages so the output says where, not every file name. */
function bucket(rel) {
  if (rel.startsWith('en/')) return 'en/*';
  if (rel.includes('product/')) return 'product/*';
  if (rel.includes('2021/')) return 'blog/*';
  return rel.split('/')[0] || 'root';
}

const rows = [...groups.values()].sort((a, b) => b.count - a.count);

console.log(`\n  全站按钮类链接，按（文案, 目标）归组  ——  扫描 ${documents.length} 页\n`);

for (const row of rows) {
  console.log(`  ${String(row.count).padStart(4)} x  "${row.label}"`);
  console.log(`         -> ${row.href}`);
  console.log(`         页面: ${[...row.pages].join(', ')}`);
}

console.log(`\n  站内已有的 WhatsApp 号码（Chaty 等浮动组件）\n`);
if (chaty.size === 0) console.log('    （未发现）');
for (const [number, count] of chaty) console.log(`    ${number}   出现 ${count} 次`);
