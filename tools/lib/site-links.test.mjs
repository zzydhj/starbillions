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

import { COPYRIGHT_YEAR, EN_PAGE_TITLES, MOBILE_TOOLBAR, localizeGoogleFonts, normalizeFontUrl, replaceContactForm, replaceMapWithAddress, repairMenuLinks, replaceMobileToolbar, rewriteInquireButtons, translateEnglishTitle, updateCopyrightYear, whatsappUrlFor } from './site-links.js';

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

test('replaceMobileToolbar gives all three icons the same colour source', () => {
  const { html } = replaceMobileToolbar(BAR, MOBILE_TOOLBAR.zh);

  // The site's own phone.svg carries #0066b6 and ignores currentColor, which is why
  // one item rendered blue beside two dark ones. Nothing in CSS can reconcile baked
  // file colours, so the bar must not contain a baked colour at all.
  assert.equal((html.match(/fill="currentColor"/g) || []).length, MOBILE_TOOLBAR.zh.length, 'every icon inherits the link colour');
  assert.ok(!/#0066b6/i.test(html), 'no icon brings its own colour');
  assert.ok(!html.includes('<img'), 'no image file to go out of date');
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

test('repairMenuLinks takes an unmapped heading from its own dropdown panel', () => {
  // A size range has no page of its own, but the panel under it already lists the
  // site's ordering for that range, so the first entry there is the site's answer and
  // not this file's guess. A category is preferred to a product: a heading should
  // open a list.
  const html = '<li id="menu-item-9"><a href="http://1" class="woodmart-nav-link">' +
    '<span class="nav-link-text">1.28-2.1英寸液晶显示屏</span></a>' +
    '<div class="wd-dropdown"><ul><li><a href="/product/xby128/">1.28″ TFT</a></li>' +
    '<li><a href="/product-category/1-28-inch-lcd-display/">1.28 inch</a></li></ul></div></li>';

  const { html: out, repaired, dropped } = repairMenuLinks(html);

  assert.equal(repaired, 1);
  assert.equal(dropped, 0);
  assert.match(out, /href="\/product-category\/1-28-inch-lcd-display\/"/, 'the listing, not the single product');
});

test('repairMenuLinks unlinks a heading with nowhere honest to go', () => {
  const html = '<li id="menu-item-9"><a href="http://1" class="woodmart-nav-link">' +
    '<span class="nav-link-text">圆形&#038;长条形显示屏</span></a><div class="wd-dropdown">（空面板）</div></li>';

  const { html: out, repaired, dropped } = repairMenuLinks(html);

  assert.equal(repaired, 0);
  assert.equal(dropped, 1);
  assert.ok(!out.includes('http://1'), 'the dead origin is gone');
  assert.match(out, /<a class="woodmart-nav-link">/, 'the heading survives, without a link');
});

test('repairMenuLinks never touches a real external link', () => {
  const html = '<li><a href="https://twitter.com/starbillions" class="woodmart-nav-link">' +
    '<span class="nav-link-text">Twitter</span></a></li>';

  const { html: out, repaired, dropped } = repairMenuLinks(html);

  assert.equal(repaired + dropped, 0);
  assert.equal(out, html);
});

test('replaceContactForm swaps the metform widget for the site\'s own button', () => {
  const widget = '<div class="elementor-element elementor-widget elementor-widget-metform" data-widget_type="metform.default">' +
    '<div class="elementor-widget-container"><div class="mf-form-wrapper" data-action="/wp-json/metform/v1/entries/insert/16312">' +
    '<script type="text/mf" class="mf-template">{"fields":[]}</script></div></div></div>';
  const html = `<section>${widget}<p class="address">深圳市</p></section>`;

  const { html: out, replaced } = replaceContactForm(html, { whatsappUrl: URL, label: '通过 WhatsApp 联系我们' });

  assert.equal(replaced, 1);
  assert.ok(!out.includes('metform'), 'the widget and the endpoint it could never reach are gone');
  assert.ok(!out.includes('mf-form-wrapper'));
  // The replacement reuses the theme's own button classes, so its appearance is the
  // site's rather than something this file invented alongside it.
  assert.match(out, /class="elementor-button elementor-button-link elementor-size-sm"/);
  assert.match(out, new RegExp(`href="${URL}" target="_blank"`));
  assert.match(out, /<p class="address">深圳市<\/p>/, 'the content beside it survives');

  assert.equal(replaceContactForm(out, { whatsappUrl: URL, label: 'x' }).replaced, 0, 'running it again changes nothing');
  const untouched = replaceContactForm(html, { whatsappUrl: '', label: 'x' });
  assert.equal(untouched.html, html, 'no number configured means no edit at all');
});

test('replaceMapWithAddress keeps the address the iframe already carries', () => {
  const widget = '<div class="elementor-element elementor-widget elementor-widget-google_maps" data-widget_type="google_maps.default">' +
    '<div class="elementor-widget-container"><div class="elementor-custom-embed">' +
    '<iframe loading="lazy" src="https://maps.google.com/maps?q=x&#038;output=embed" ' +
    'title="深圳市宝安区洲石路739号恒丰工业城" aria-label="深圳市宝安区洲石路739号恒丰工业城"></iframe>' +
    '</div></div></div>';

  const { html: out, replaced } = replaceMapWithAddress(`<section>${widget}<p>电话</p></section>`);

  assert.equal(replaced, 1);
  assert.ok(!out.includes('maps.google.com'), 'the embed is gone');
  assert.ok(!out.includes('elementor-custom-embed'), 'and its overlay link with it');
  assert.match(out, /<p>深圳市宝安区洲石路739号恒丰工业城<\/p>/, 'the address comes from the markup, not from a table');
  assert.match(out, /elementor-widget-text-editor/, 'in the theme\'s own text widget, so it is styled');
  assert.match(out, /<p>电话<\/p>/, 'the rest of the section survives');
});

test('replaceMapWithAddress refuses to empty a map it cannot read an address from', () => {
  const widget = '<div class="elementor-element elementor-widget elementor-widget-google_maps"><div class="elementor-widget-container">' +
    '<div class="elementor-custom-embed"><img src="static-map.png"></div></div></div>';

  const { html: out, replaced } = replaceMapWithAddress(widget);

  assert.equal(replaced, 0, 'no iframe with an address means no edit');
  assert.equal(out, widget);
});

test('normalizeFontUrl is the one rule both the fetcher and the rewriter use', () => {
  const raw = 'https://fonts.googleapis.com/css?family=Hind%3A400%2C600%7COpen+Sans%3A400&#038;ver=7.3.3';

  assert.equal(normalizeFontUrl(raw), 'https://fonts.googleapis.com/css?family=Hind%3A400%2C600%7COpen+Sans%3A400');
  assert.equal(normalizeFontUrl('https://fonts.googleapis.com/css?family=Roboto&ver=1'), 'https://fonts.googleapis.com/css?family=Roboto');
  assert.equal(normalizeFontUrl('https://fonts.googleapis.com/css?family=Roboto'), 'https://fonts.googleapis.com/css?family=Roboto');
});

test('localizeGoogleFonts rewrites only what the manifest actually names', () => {
  const manifest = { 'https://fonts.googleapis.com/css?family=Hind%3A400': '/fonts/ab12.css' };
  const html = '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Hind%3A400&#038;ver=7.3.3">' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto&#038;ver=7.3.3">';

  const { html: out, replaced, missing } = localizeGoogleFonts(html, manifest);

  assert.equal(replaced, 1);
  assert.equal(missing, 1, 'a family the manifest does not have is left pointing at Google, not at nothing');
  assert.match(out, /href="\/fonts\/ab12\.css"/);
  assert.match(out, /family=Roboto/, 'the unfetched one keeps working the old way');
  assert.ok(!out.includes('fonts.gstatic.com'), 'the preconnect goes once a local file is used');

  const untouched = localizeGoogleFonts(html, {});
  assert.equal(untouched.html, html, 'no manifest means no rewrite at all - npm run fonts has not been run');
  assert.equal(untouched.replaced, 0);
});

test('translateEnglishTitle replaces the page name and keeps the company suffix', () => {
  const html = '<title>联系我们 &#8211; 深圳市星百亿电子有限公司</title>';
  const { html: out, changed } = translateEnglishTitle(html, 'en/联系我们/index.html');

  assert.equal(changed, true);
  assert.match(out, /^<title>Contact Us &#8211; 深圳市星百亿电子有限公司<\/title>/);

  // The homepage is titled nothing but the registered name, so it is given the brand
  // the site already publishes in English as its page name, keeping the Chinese legal
  // name as the suffix - the same shape every other English page has.
  const home = '<title>深圳市星百亿电子有限公司</title>';
  const titled = translateEnglishTitle(home, 'en/index.html');
  assert.equal(titled.changed, true);
  assert.match(titled.html, /^<title>Starbillions &#8211; 深圳市星百亿电子有限公司<\/title>/);
  assert.equal(translateEnglishTitle(titled.html, 'en/index.html').changed, false, 'running it again does not stack a second brand');

  const already = '<title>Contact Us &#8211; 深圳市星百亿电子有限公司</title>';
  assert.equal(translateEnglishTitle(already, 'en/联系我们/index.html').changed, false, 'someone fixing it upstream stops the edit');

  assert.ok(Object.keys(EN_PAGE_TITLES).every((path) => path.startsWith('en/')), 'the table only names English pages');
});
