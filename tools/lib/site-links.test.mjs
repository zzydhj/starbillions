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

import { COPYRIGHT_YEAR, MOBILE_TOOLBAR, repairMenuLinks, replaceMobileToolbar, rewriteInquireButtons, updateCopyrightYear, whatsappUrlFor } from './site-links.js';

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

/** The bottom bar exactly as the source site's cache writes it, including the dead host. */
const BAR = [
  '<div class="wd-toolbar wd-toolbar-label-show">',
  '  <div class="wd-toolbar-link wd-tools-element wd-toolbar-item wd-tools-custom-icon">',
  '    <a href="http://starbillions.savetime.work/">',
  '      <span class="wd-toolbar-icon wd-tools-icon wd-icon wd-custom-icon">',
  '        <img width="1024" height="1024" src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" data-lazy-src="/wp-content/uploads/2023/11/phone.svg" />',
  '      </span>',
  '      <span class="wd-toolbar-label"> 123 </span>',
  '    </a>',
  '  </div>',
  '  <div class="wd-toolbar-link wd-tools-element wd-toolbar-item">',
  '    <a href="http://starbillions.savetime.work/">',
  '      <span class="wd-toolbar-icon wd-tools-icon wd-icon wd-custom-icon"> </span>',
  '      <span class="wd-toolbar-label"> 123 </span>',
  '    </a>',
  '  </div>',
  '</div>',
].join('\n');

test('replaceMobileToolbar rewrites the bar without leaving the dead host behind', () => {
  const { html, replaced } = replaceMobileToolbar(BAR, MOBILE_TOOLBAR.zh);

  assert.equal(replaced, 1);
  assert.ok(!html.includes('savetime.work'), 'the preview host is gone');
  assert.ok(!html.includes('123'), 'the placeholder labels are gone');
  assert.ok(!html.includes('data-lazy-src'), 'the rebuilt icons are not left to the lazy loader');
  assert.equal((html.match(/wd-toolbar-link/g) || []).length, MOBILE_TOOLBAR.zh.length, 'one item per entry');
  assert.match(html, /^<div class="wd-toolbar wd-toolbar-label-show">/, 'the template\'s own variant class survives');
  assert.match(html, /href="tel:\+8613714286517"/);
  assert.match(html, /href="\/产品中心\/"/);
});

test('replaceMobileToolbar keeps the block balanced when an item nests further divs', () => {
  // The cut is a tag-pair scan, so an unbalanced end would either swallow the rest of
  // the page or leave the closing tag of the bar behind.
  const nested = BAR.replace('<span class="wd-toolbar-label"> 123 </span>',
    '<div class="inner"><span class="wd-toolbar-label"> 123 </span></div>');
  const { html } = replaceMobileToolbar(nested, MOBILE_TOOLBAR.zh);

  assert.ok(!html.includes('savetime.work'));
  assert.ok(!html.includes('class="inner"'), 'the nested element went with the item it belonged to');
  assert.equal((html.match(/<div/g) || []).length, (html.match(/<\/div>/g) || []).length, 'the tags still balance');
});

test('replaceMobileToolbar ignores toolbars that hold no items and repeats nothing', () => {
  const header = '<div class="wd-toolbar wd-header-mobile-nav"><a href="/x/">菜单</a></div>';
  const page = `${header}<main>${BAR}</main>${header}`;

  const once = replaceMobileToolbar(page, MOBILE_TOOLBAR.en);
  assert.equal(once.replaced, 1, 'only the bar with items counts');
  assert.match(once.html, /wd-header-mobile-nav/, 'the header toolbar is untouched');
  assert.match(once.html, /href="\/en\/产品中心\/"/, 'the English entries land on the paths the mirror actually wrote');

  const twice = replaceMobileToolbar(once.html, MOBILE_TOOLBAR.en);
  assert.equal(twice.replaced, 1, 'rebuilding an already-built bar is stable, not additive');
  assert.equal(twice.html, once.html);
});

test('updateCopyrightYear moves the footer without touching dates that are not the footer', () => {
  const html = '<p>© 2024 深圳市星百亿电子有限公司</p>'
    + '<p>Copyright &copy; 2024 Starbillions. All rights reserved</p>'
    + '<time datetime="2021-08-27">2021-08-27</time>'
    + '<a href="/2021/08/27/some-post/">2021 的文章</a>';

  const out = updateCopyrightYear(html);

  assert.ok(out.includes(`© ${COPYRIGHT_YEAR}`));
  assert.ok(out.includes(`&copy; ${COPYRIGHT_YEAR}`));
  assert.match(out, /datetime="2021-08-27"/, 'a publication date is a fact about the post, not a copyright claim');
  assert.match(out, /\/2021\/08\/27\//, 'URLs are not dates in this sense');
  assert.equal(updateCopyrightYear(out), out, 'applying it twice changes nothing further');
});

test('repairMenuLinks routes the bare-number menu items that have a real page', () => {
  const item = (href, label) => `<li id="menu-item-1" class="menu-item"><a href="${href}" class="woodmart-nav-link">` +
    `<img src="/i.svg" /><span class="nav-link-text">${label}</span></a></li>`;
  const html = item('http://3', '串口屏') + item('http://3', '转接板') + item('http://3', 'Serial screen');

  const { html: out, repaired } = repairMenuLinks(html);

  assert.equal(repaired, 3);
  assert.match(out, /href="\/product-category\/串口屏\/"/);
  assert.match(out, /href="\/product-category\/转接板\/"/);
  assert.match(out, /href="\/en\/product-category\/串口屏\/"/, 'the English label lands on the English tree');
  assert.ok(!out.includes('http://3'), 'no bare-number origin survives where a page is known');
});

test('repairMenuLinks leaves alone what it cannot map', () => {
  const group = '<a href="http://1" class="woodmart-nav-link"><span class="nav-link-text">1.28-2.1英寸液晶显示屏</span></a>';
  const entity = '<a href="http://1" class="woodmart-nav-link"><span class="nav-link-text">圆形&#038;长条形显示屏</span></a>';
  const external = '<a href="https://twitter.com/starbillions" class="woodmart-nav-link"><span class="nav-link-text">Twitter</span></a>';
  const bareHost = '<a href="http://example.com" class="woodmart-nav-link"><span class="nav-link-text">Example</span></a>';
  const html = group + entity + external + bareHost;

  const { html: out, repaired } = repairMenuLinks(html);

  // A size range is a heading over several categories and 圆形&长条形显示屏 is a menu
  // label with no page of its own; pointing either at one category would be an
  // invented destination presented as a repair.
  assert.equal(repaired, 0, 'nothing here has a destination the mirror can prove');
  assert.equal(out, html);
});
