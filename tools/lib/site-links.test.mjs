/**
 * Tests for the owner-requested content edits.
 *
 *   node --test tools/lib/site-links.test.mjs
 *
 * These are the one place where the mirror intentionally stops being a mirror, so
 * they are tested harder than their size suggests: the value of a rewrite that fires
 * on 68 buttons is matched by the cost of one that fires on the wrong 10,000.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { rewriteInquireButtons, whatsappUrlFor } from './site-links.js';

const URL = 'https://wa.me/8613714286517';
const LABELS = ['Inquire about this product', '咨询此产品'];

const button = (label, href = 'https://starbillions.cn/%e8%81%94%e7%b3%bb%e6%88%91%e4%bb%ac/') =>
  `<div class="elementor-button-wrapper"><a class="elementor-button elementor-button-link elementor-size-sm" href="${href}">` +
  `<span class="elementor-button-content-wrapper"><span class="elementor-button-text">${label}</span></span></a></div>`;

test('the enquiry button becomes a WhatsApp link, in both languages', () => {
  for (const label of LABELS) {
    const out = rewriteInquireButtons(button(label), URL, LABELS);

    assert.match(out, /href="https:\/\/wa\.me\/8613714286517"/, label);
    assert.ok(!out.includes('starbillions.cn'), `${label}: the third-party domain is gone`);
    assert.ok(out.includes(label), `${label}: the visible text is untouched`);
    assert.match(out, /target="_blank"/, 'opens without losing the product page');
    assert.match(out, /rel="noopener noreferrer"/, 'and does not hand the new window access back');
  }
});

test('a button with any other label is left exactly as it was', () => {
  const others = ['联系我们', 'contact us', '继续阅读', 'Get a quote'];

  for (const label of others) {
    const source = button(label);
    assert.equal(rewriteInquireButtons(source, URL, LABELS), source, `${label} must not be touched`);
  }
});

test('only the matched button changes when several share a page', () => {
  const page = [button('咨询此产品'), button('联系我们'), button('Inquire about this product')].join('\n');
  const out = rewriteInquireButtons(page, URL, LABELS);

  assert.equal(out.split('wa.me').length - 1, 2, 'exactly the two enquiry buttons');
  assert.match(out, /<a class="elementor-button elementor-button-link elementor-size-sm" href="https:\/\/starbillions\.cn/,
    'the contact button keeps its own target');
});

test('an anchor without a button-text span is not rewritten', () => {
  // The label lookup is what makes this edit safe to apply site-wide; without it any
  // Elementor button on the page would be sent to WhatsApp.
  const html = '<a class="elementor-button elementor-button-link" href="/somewhere/"><span>咨询此产品</span></a>';
  assert.equal(rewriteInquireButtons(html, URL, LABELS), html);
});

test('an empty WhatsApp number turns the edit off', () => {
  const source = button('咨询此产品');
  assert.equal(rewriteInquireButtons(source, '', LABELS), source);
});

test('whatsappUrlFor normalises the way the site writes its number', () => {
  assert.equal(whatsappUrlFor('13714286517'), 'https://wa.me/8613714286517');
  assert.equal(whatsappUrlFor('+86 137 1428 6517'), 'https://wa.me/8613714286517');
  assert.equal(whatsappUrlFor('008613714286517'), 'https://wa.me/8613714286517');
  assert.equal(whatsappUrlFor('+86-137-1428-6517'), 'https://wa.me/8613714286517');
  assert.equal(whatsappUrlFor('+1 555 987 6543'), 'https://wa.me/15559876543', 'a written + means the digits are complete');
  assert.equal(whatsappUrlFor('15559876543'), 'https://wa.me/8615559876543', 'a bare 11 digits is read as a China mobile, which is why other numbers must carry a +');
  assert.equal(whatsappUrlFor(''), '', 'blank means no edit');
  assert.throws(() => whatsappUrlFor('12345'), /does not look like a phone number/);
});
