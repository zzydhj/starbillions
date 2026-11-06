/**
 * Tests for the mirror's URL logic.
 *
 *   npm test
 *
 * These run with no server and no database, which is the point: where a URL lands
 * on disk, which links must disappear, and how head metadata differs from an
 * ordinary link are the expensive decisions to get wrong, and all three are pure.
 * A mirror of a few hundred pages cannot be debugged by eye afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fileReferencesIn,
  internalUrl,
  isAssetPath,
  isExcluded,
  isOwnerRemoved,
  jsChunkNames,
  localizeCssAssetUrls,
  moveLanguageFloater,
  originSet,
  removeDeadAjaxScripts,
  removeDeadAjaxWidgets,
  removeDeadShopControls,
  removeDeadTabsNavigation,
  removeOwnerMenuItems,
  rebaseIdentityUrls,
  referencesIn,
  resolvesInOutput,
  rewriteReferences,
  rootifyOrigins,
  stripLanguagePrefix,
  toOutputPath,
  toRootAbsolute,
} from './staticize.js';

const origins = originSet();
const LOCAL = 'https://tftstar.com/';
const url = (path) => new URL(`https://tftstar.com${path}`);
const everything = () => 'copy';

test('pages become directory documents, assets keep their file path', () => {
  assert.equal(toOutputPath(url('/')), 'index.html');
  assert.equal(toOutputPath(url('/en/')), 'en/index.html');
  assert.equal(toOutputPath(url('/product/x/')), 'product/x/index.html');
  assert.equal(toOutputPath(url('/contact')), 'contact/index.html');
  assert.equal(toOutputPath(url('/2021-08-26-a-post/')), '2021-08-26-a-post/index.html');
  assert.equal(toOutputPath(url('/wp-content/themes/woodmart/css/main.css?ver=7.3.3')), 'wp-content/themes/woodmart/css/main.css');
});

test('percent-encoded upload names become the real file name', () => {
  const encoded = url(`/wp-content/uploads/2024/01/${encodeURIComponent('图片-拷贝.jpg')}`);
  assert.equal(toOutputPath(encoded), 'wp-content/uploads/2024/01/图片-拷贝.jpg');
});

test('a mirror-served link is root-absolute and keeps its cache buster', () => {
  assert.equal(toRootAbsolute(url('/wp-content/uploads/a.jpg?ver=2')), '/wp-content/uploads/a.jpg?ver=2');
  assert.equal(toRootAbsolute(url('/product/x/')), '/product/x/');
});

test('excluded endpoints are the WooCommerce and WordPress machinery', () => {
  for (const path of ['/cart/', '/checkout/', '/my-account/', '/wp-admin/index.php', '/admin-ajax.php', '/xmlrpc.php', '/wp-comments-post.php']) {
    assert.equal(isExcluded(url(path)), true, `${path} should be excluded`);
  }
  assert.equal(isExcluded(url('/product/x/')), false);
});

test('any query string on a page means a request-specific render, so it is not a page', () => {
  assert.equal(isExcluded(url('/?s=screen')), true);
  assert.equal(isExcluded(url('/product-category/a/?filter_color=red')), true);
  assert.equal(isExcluded(url('/product-category/a/')), false);
});

test('a cache buster on an asset is not a request-specific render', () => {
  // WordPress appends ?ver= to every script and stylesheet. Treating that as "not a
  // page" stripped the attribute from all of them, and the site rendered unstyled
  // with no JS while every source-level check still passed.
  assert.equal(isExcluded(url('/wp-includes/js/jquery/jquery.min.js?ver=3.7.1')), false);
  assert.equal(isExcluded(url('/wp-content/themes/woodmart/css/main.css?ver=7.3.3')), false);
  assert.equal(isExcluded(url('/wp-content/uploads/elementor/css/post-16065.css?ver=1234')), false);
  assert.equal(isAssetPath('/wp-content/uploads/a.svg.png'), true);
  assert.equal(isAssetPath('/product/x/'), false);
});

test('foreign and non-http references are left alone entirely', () => {
  assert.equal(internalUrl('https://example.com/x', origins), null);
  assert.equal(internalUrl('data:image/png;base64,AAA', origins), null);
  assert.equal(internalUrl('mailto:hi@tftstar.com', origins), null);
  assert.equal(internalUrl('tel:+8613800000000', origins), null);
  assert.equal(internalUrl('#anchor', origins), null);
});

test('protocol-relative and root-relative forms are both internal', () => {
  assert.ok(internalUrl('//tftstar.com/wp-content/a.js', origins));
  assert.ok(internalUrl('/product/x/', origins));
  assert.ok(internalUrl('https://tftstar.com/product/x/', origins));
});

test('a bare relative reference resolves against the page it was found on', () => {
  const found = internalUrl('../y/', origins, 'https://tftstar.com/product/x/');
  assert.equal(found.pathname, '/product/y/');
});

test('rewrite: internal URLs become root-absolute, excluded links lose the attribute', () => {
  const html = [
    '<a href="https://tftstar.com/cart/">Cart</a>',
    '<a href="https://tftstar.com/product/x/">X</a>',
    '<a href="https://example.com/out">ext</a>',
  ].join('');

  const out = rewriteReferences(html, { pageUrl: LOCAL, origins, classify: (u) => (u.pathname === '/product/x/' ? 'page' : 'copy') });

  assert.match(out.html, /<a>Cart<\/a>/, 'the cart link must not survive as a href');
  assert.match(out.html, /href="\/product\/x\/"/);
  assert.match(out.html, /href="https:\/\/example\.com\/out"/, 'external links are untouched');
  assert.equal(out.rewritten, 1);
  assert.equal(out.dropped, 1);
});

test('rewrite: an unclassified URL is kept and reported, never silently dropped', () => {
  const out = rewriteReferences('<img src="https://tftstar.com/wp-content/uploads/ghost.png">', {
    pageUrl: LOCAL,
    origins,
    classify: () => undefined,
  });

  assert.match(out.html, /ghost\.png/, 'unknown assets stay referenced');
  assert.equal(out.missing.size, 1, 'but the builder learns the count');
});

test('rewrite: srcset keeps its descriptors and drops only the removed candidate', () => {
  const html = '<img src="https://tftstar.com/wp-content/uploads/a.jpg" srcset="https://tftstar.com/wp-content/uploads/a-150x150.jpg 150w, https://tftstar.com/cart/ 300w">';
  const out = rewriteReferences(html, { pageUrl: LOCAL, origins, classify: everything });

  assert.match(out.html, /src="\/wp-content\/uploads\/a\.jpg"/);
  assert.match(out.html, /srcset="\/wp-content\/uploads\/a-150x150\.jpg 150w"/, 'descriptor kept, bad candidate removed');
});

test('rewrite: css urls inside style attributes and inline blocks are handled', () => {
  const html = '<div style="background-image:url(https://tftstar.com/wp-content/uploads/bg.jpg)"></div>';
  const out = rewriteReferences(html, { pageUrl: LOCAL, origins, classify: everything });

  assert.match(out.html, /url\("\/wp-content\/uploads\/bg\.jpg"\)/);
});

test('rewrite: the lazy-load and delay-JS placeholders are treated as references', () => {
  // WP Rocket's delay-JS moved 14793 script src values into data-rocket-src and
  // lazy-load moved 23236 image src values into data-src. Missing either one ships
  // a page with blank images and no behaviour, which is why they are named here.
  const html = '<img data-src="https://tftstar.com/wp-content/uploads/lazy.jpg">' +
    '<script data-rocket-src="https://tftstar.com/wp-content/themes/woodmart/js/wd.js"></script>';

  const out = rewriteReferences(html, { pageUrl: LOCAL, origins, classify: everything });

  assert.match(out.html, /data-src="\/wp-content\/uploads\/lazy\.jpg"/);
  assert.match(out.html, /data-rocket-src="\/wp-content\/themes\/woodmart\/js\/wd\.js"/);
});

test('a <base> element is removed whole, not emptied into an invalid tag', () => {
  const out = rewriteReferences('<base href="https://tftstar.com/"><p>hi</p>', {
    pageUrl: LOCAL,
    origins,
    classify: () => 'drop',
  });

  assert.equal(out.html, '<p>hi</p>');
});

test('identity metadata keeps an absolute URL, on the new origin', () => {
  const html = [
    '<link rel="canonical" href="https://tftstar.com/product/x/">',
    '<link rel="alternate" hreflang="en" href="https://tftstar.com/en/product/x/">',
    '<meta property="og:url" content="https://tftstar.com/product/x/">',
    '<script type="application/ld+json">{"@id":"https://tftstar.com/#site","image":"https://tftstar.com/logo.png"}</script>',
    '<a href="https://tftstar.com/product/x/">link</a>',
  ].join('');

  const rebased = rebaseIdentityUrls(html, origins, 'https://starbillions.com');

  assert.match(rebased, /rel="canonical" href="https:\/\/starbillions\.com\/product\/x\/"/);
  assert.match(rebased, /hreflang="en" href="https:\/\/starbillions\.com\/en\/product\/x\/"/);
  assert.match(rebased, /og:url" content="https:\/\/starbillions\.com/);
  assert.match(rebased, /"@id":"https:\/\/starbillions\.com\/#site"/, 'JSON-LD ids move too');
  assert.match(rebased, /<a href="https:\/\/tftstar\.com\/product\/x\/">/, 'an ordinary link is left for the other pass');
});

test('referencesIn returns raw values, for the builder to classify', () => {
  const found = referencesIn(
    '<link href="https://tftstar.com/a.css"><img src="/b.jpg" srcset="/c.jpg 2x" data-rocket-src="/d.js">' +
      '<div style="background:url(/e.png)"><video poster="/f.mp4"></video><form action="/g/"></form>',
  );

  // Raw, not rewritten: this function reports what the document says, and the
  // decision about each one belongs to rewriteReferences.
  for (const expected of ['https://tftstar.com/a.css', '/b.jpg', '/c.jpg', '/d.js', '/e.png', '/f.mp4', '/g/']) {
    assert.ok(found.includes(expected), `missing ${expected}`);
  }
});

test('the src pass does not reach into data-src, which the anchor guarantees', () => {
  const html = '<img src="https://tftstar.com/a.jpg" data-src="https://tftstar.com/b.jpg">';
  const out = rewriteReferences(html, { pageUrl: LOCAL, origins, classify: everything });

  assert.match(out.html, /src="\/a\.jpg"/);
  assert.match(out.html, /data-src="\/b\.jpg"/);
});

test('rootifyOrigins: every spelling of a same-site URL becomes a same-site path', () => {
  const html = [
    '<link rel="stylesheet" href="https://tftstar.com/wp-content/themes/woodmart/css/main.css?ver=1">',
    // Elementor writes its widget JSON with escaped slashes, and this is where a
    // homepage keeps its slideshow images.
    '<div data-settings="{&quot;slideshow&quot;:&quot;https:\\/\\/tftstar.com\\/wp-content\\/uploads\\/a.jpg&quot;}"></div>',
    '<script>var m={"baseUrl":"https://tftstar.com","ajax":"http://tftstar.com/wp-admin/admin-ajax.php"};</script>',
    '<img src="//tftstar.com/wp-content/uploads/b.png">',
    '<a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Ftftstar.com%2Fproduct%2Fx%2F">share</a>',
  ].join('');

  // Both functions return a plain string, unlike rewriteReferences, which reports
  // counts alongside its html.
  const out = rootifyOrigins(html, origins, 'https://starbillions.com');

  assert.match(out, /href="\/wp-content\/themes\/woodmart\/css\/main\.css\?ver=1"/, 'plain URL with query');
  assert.match(out, /"slideshow":"\/wp-content\/uploads\/a\.jpg"|slideshow&quot;:&quot;\/wp-content\/uploads\/a\.jpg/,
    'escaped JSON spelling, still valid JSON');
  assert.match(out, /"baseUrl":"https:\/\/starbillions\.com"/, 'a bare origin stays absolute for concatenation');
  assert.match(out, /"ajax":"\/wp-admin\/admin-ajax\.php"/, 'the http:// variant is not left as http:/');
  assert.match(out, /src="\/wp-content\/uploads\/b\.png"/, 'protocol-relative');
  assert.match(out, /u=https%3A%2F%2Fstarbillions\.com/, 'share links keep a full URL');
  assert.ok(!out.includes('tftstar.com'), 'nothing may still name the old host');
  assert.ok(!/http:\/\/[a-z]/i.test(out.match(/"ajax":"[^"]*"/)[0]), 'no corrupted scheme left behind');
});

test('fileReferencesIn finds files in syntaxes the attribute list cannot see', () => {
  const html = [
    '<img data-wood-src="https://tftstar.com/wp-content/uploads/2024/01/round.png">',
    '<div data-settings="{&quot;image&quot;:&quot;https:\\/\\/tftstar.com\\/wp-content\\/uploads\\/esc.jpg&quot;}"></div>',
    '<style>.x{background:url(/wp-content/uploads/css-bg.png)}</style>',
    '<script>var lazy="\/wp-content\/uploads\/via-js.webp";</script>',
    '<link rel="stylesheet" href="/wp-content/themes/woodmart/css/main.css?ver=7.3.3">',
  ].join('');

  const found = fileReferencesIn(html);

  assert.ok(found.has('/wp-content/uploads/2024/01/round.png'), 'Woodmart lazy attribute');
  assert.ok(found.has('/wp-content/uploads/esc.jpg'), 'escaped JSON');
  assert.ok(found.has('/wp-content/uploads/css-bg.png'), 'inline CSS url()');
  assert.ok(found.has('/wp-content/uploads/via-js.webp'), 'string inside a script');
  assert.ok(found.has('/wp-content/themes/woodmart/css/main.css'), 'query string stripped');
});

test('fileReferencesIn keeps double extensions whole', () => {
  // Real names in this site's uploads: a logo stored as .svg.png. Cutting at the
  // first extension records a nonexistent file as missing and never copies the one
  // the page actually needs.
  const found = fileReferencesIn('<img src="/wp-content/uploads/2023/11/Emerson_Electric_Company.svg.png">');

  assert.ok(found.has('/wp-content/uploads/2023/11/Emerson_Electric_Company.svg.png'), 'both extensions retained');
  assert.ok(!found.has('/wp-content/uploads/2023/11/Emerson_Electric_Company.svg'), 'no truncated name');
});

test('stripLanguagePrefix turns TranslatePress hardcoding into real mirror paths', () => {
  const html = '<a href="/zh_cn/contact/">CN</a><a href="/en/zh_cn/contact/">EN</a><span>zh_cn</span>';
  const out = stripLanguagePrefix(html);

  assert.match(out, /href="\/contact\/"/);
  assert.match(out, /href="\/en\/contact\/"/);
  assert.match(out, />zh_cn</, 'a bare language code with no path shape is content, and stays');
});

test('resolvesInOutput matches the built tree on forward-slash keys only', () => {
  const known = new Set(['index.html', 'en/index.html', 'wp-content/uploads/a.jpg', 'product/x/index.html']);

  assert.equal(resolvesInOutput(known, '/'), true);
  assert.equal(resolvesInOutput(known, '/product/x/'), true);
  assert.equal(resolvesInOutput(known, '/product/x'), true);
  assert.equal(resolvesInOutput(known, '/wp-content/uploads/a.jpg'), true);
  assert.equal(resolvesInOutput(known, '/%E4%BA%A7%E5%93%81/'), false);
  assert.equal(resolvesInOutput(new Set(['product/产品中心/index.html']), '/product/%E4%BA%A7%E5%93%81%E4%B8%AD%E5%BF%83/'), true);
});

test('moveLanguageFloater swaps the position class the plugin itself defines', () => {
  const html = '<div id="trp-floater-ls" class="trp-language-switcher-container trp-floater-ls-names trp-bottom-right trp-color-dark flags-full-names">' +
    '<a href="/en/">English</a></div>' +
    '<script>var tp={"ls_position":"bottom_right"};</script>';

  const moved = moveLanguageFloater(html, 'top-right');

  assert.match(moved, /class="[^"]*trp-top-right[^"]*"/, 'the floater element takes the new corner class');
  assert.ok(!moved.includes('trp-bottom-right'), 'the old corner class is gone');
  assert.match(moved, /"ls_position":"bottom_right"/, 'the stored setting, which uses an underscore, is left alone');
  assert.equal(moveLanguageFloater(html, 'bottom-right'), html, 'the default position is a no-op');
  assert.throws(() => moveLanguageFloater(html, 'middle'), /unknown language switcher position/);
});

test('removeDeadShopControls cuts the whole widget and nothing around it', () => {
  const html = [
    '<div class="wd-toolbar">',
    '<div class="elementor-element elementor-widget-wd_shop_archive_per_page" data-id="a">',
    '<div class="elementor-widget-container"><div class="wd-products-per-page">',
    '<a class="per-page-variation"><span>9</span></a><a class="per-page-variation"><span>12</span></a>',
    '</div></div></div>',
    '<div class="elementor-element elementor-widget-wd_shop_archive_view" data-id="b">',
    '<div class="elementor-widget-container"><div class="wd-products-shop-view products-view-grid">',
    '<a class="shop-view per-row-2"></a>',
    '</div></div></div>',
    '<div class="elementor-element elementor-widget-wd_wc_sorting"><select><option>默认排序</option></select></div>',
    '</div>',
    '<div class="products wd-products-holder" data-source="main_loop"><li class="product-grid-item">x</li></div>',
  ].join('');

  const { html: out, removed } = removeDeadShopControls(html);

  assert.equal(removed.wd_shop_archive_per_page, 1);
  assert.equal(removed.wd_shop_archive_view, 1);
  assert.ok(!out.includes('per-page-variation'), 'the per-page anchors are gone');
  assert.ok(!out.includes('per-row-2'), 'the column icons are gone');
  assert.ok(!out.includes('wd-products-per-page'), 'no emptied shell is left behind');
  assert.match(out, /elementor-widget-wd_wc_sorting/, 'the sorting control beside them survives');
  assert.match(out, /product-grid-item/, 'the product loop survives');
});

test('removeDeadShopControls refuses to cut on a CSS mention of the class', () => {
  // The names really do appear in inline style blocks: 268 mentions of
  // wd-products-per-page against 51 elements in the built mirror. A text match would
  // delete the markup that happens to precede the rule.
  const html = '<div>keep me</div><style>.elementor-widget-wd_shop_archive_per_page{display:inline-flex}</style>' +
    '<div class="elementor-element elementor-widget-wd_shop_archive_per_page"><a class="per-page-variation">9</a></div>';

  const { html: out, removed } = removeDeadShopControls(html);

  assert.equal(removed.wd_shop_archive_per_page, 1, 'only the element counts');
  assert.match(out, /keep me/, 'the preceding element is untouched');
  assert.match(out, /display:inline-flex/, 'the rule text stays where it was');
});

test('removeDeadShopControls is idempotent and quiet when the page has no toolbar', () => {
  const page = '<main><h1>关于</h1></main>';
  assert.equal(removeDeadShopControls(page).html, page);
  assert.equal(removeDeadShopControls(page).removed.wd_shop_archive_view, 0);

  const withTwo = '<div class="elementor-element elementor-widget-wd_shop_archive_view"><a class="shop-view per-row-3"></a></div>';
  const once = removeDeadShopControls(withTwo).html;
  assert.equal(removeDeadShopControls(once).html, once, 'running it twice changes nothing further');
});

test('isOwnerRemoved catches the demo posts and the archives that only listed them', () => {
  // The post paths are the shape the cache directory tree actually has, taken from
  // the mirror's own input rather than written from memory of a permalink setting.
  for (const path of ['/blog/', '/blog', '/category/furniture/', '/tag/x/', '/author/starbillions/',
    '/2021/08/26/minimalist-japanese-inspired-furniture/',
    '/2021/08/27/exploring-atlantas-modern-homes/',
    '/2021/', '/2021/08/', '/2021/08/26/',
    '/en/blog/', '/en/category/furniture/', '/en/2021/08/26/some-post/', '/en/2024/',
    '/portfolio/a-lacus-bibendum-pulvinar/', '/en/portfolio/', '/project-cat/furniture/',
    '/sample-page/', '/en/sample-page/', '/woodmart_slider/123/']) {
    assert.equal(isOwnerRemoved(path), true, `${path} is demo content`);
  }

  // The shop's own categories are the business of the site. So is an upload path,
  // which carries year and month segments of its own - the date rule is anchored at
  // the start of the path for exactly that reason. And so are the WooCommerce tool
  // pages, which are features with a purpose rather than theme filler.
  for (const path of ['/', '/en/', '/product/x/', '/product-category/furniture/',
    '/en/product-category/串口屏/', '/产品中心/', '/联系我们/',
    '/metform-form/在线留言/',
    '/compare/', '/wishlist/', '/en/compare/',
    '/wp-content/uploads/2021/08/26/pic.png', '/2020-tft-display/', '/product-category/2021-line/',
    '/en/product-category/2024/']) {
    assert.equal(isOwnerRemoved(path), false, `${path} is not demo content`);
  }

  // A section is removed as a section: its bare index goes as well as its items, so
  // an archive listing the same filler cannot survive behind the item that left it.
  assert.equal(isOwnerRemoved('/woodmart_slider/'), true);
  assert.equal(isOwnerRemoved('/portfolio/'), true);

  // The exclusion is one list, so the page builder and the link rewriter agree.
  assert.equal(isExcluded(new URL('https://tftstar.com/blog/')), true);
  assert.equal(isExcluded(new URL('https://tftstar.com/2021/08/26/minimalist-japanese-inspired-furniture/')), true);
  assert.equal(isExcluded(new URL('https://tftstar.com/product-category/x/')), false);
});

test('jsChunkNames finds the hashed chunk files a loader asks for, and nothing else', () => {
  const runtime = 'webpackChunkElementorFrontend.push([[""],{123:(e,t,n)=>{'
    + 'n.p+="text-editor.2c35aafbe5bf0e127950.bundle.min.js";'
    + 'n.p+="text-editor.2c35aafbe5bf0e127950.bundle.min.js";'
    + 'n.p+="lightbox.776e1a0c9c991a41f1c6.bundle.min.js";'
    + '}}]);';

  assert.deepEqual(jsChunkNames(runtime), [
    'text-editor.2c35aafbe5bf0e127950.bundle.min.js',
    'lightbox.776e1a0c9c991a41f1c6.bundle.min.js',
  ], 'duplicated names collapse, unhashed code does not become an asset');

  // A plain ".js" string is ordinary code - a plugin name, a message - and copying on
  // the strength of it would put files in the output nothing ever asked for.
  assert.deepEqual(jsChunkNames('var a = "jquery.min.js";'), []);
});

test('localizeCssAssetUrls points at a local copy only when the bytes are here', () => {
  const css = '.el-1{background:url("https://starbillions.cn/wp-content/uploads/2023/11/10001.png")} '
    + '.el-2{background:url(https://starbillions.cn/wp-content/uploads/2023/11/gone.png)} '
    + '.el-3{background:url(https://example.com/wp-content/uploads/2023/11/10001.png)} '
    + '.el-4{background:url(/wp-content/uploads/2023/11/local.png)}';

  const { text, local } = localizeCssAssetUrls(css, { available: (rel) => rel.endsWith('10001.png') });

  assert.ok(text.includes('url(/wp-content/uploads/2023/11/10001.png)'), 'the file we hold is pointed locally');
  assert.ok(text.includes('starbillions.cn/wp-content/uploads/2023/11/gone.png'), 'one we do not hold keeps its original text');
  assert.ok(text.includes('example.com'), 'a host that is not the owner\'s other domain is not touched');
  assert.ok(text.includes('url(/wp-content/uploads/2023/11/local.png)'), 'an already-local url is untouched');
  assert.deepEqual(local, ['/wp-content/uploads/2023/11/10001.png']);

  // Idempotence is asserted against the same availability: with an anything-goes
  // predicate the second pass would rewrite the URL the first one deliberately left
  // alone, which is not a change the function made but a change the fixture made.
  const again = localizeCssAssetUrls(text, { available: (rel) => rel.endsWith('10001.png') });
  assert.equal(again.text, text, 'running it twice changes nothing further');
  assert.deepEqual(again.local, [], 'and the second pass finds nothing left to point');
});

test('removeOwnerMenuItems takes the dead entry with its subtree and keeps a live parent', () => {
  const html = '<ul id="menu-main">' +
    '<li class="menu-item menu-item-1"><a href="https://tftstar.com/blog/">博客</a></li>' +
    '<li class="menu-item menu-item-2"><a href="https://tftstar.com/产品中心/">产品中心</a></li>' +
    '<li class="menu-item menu-item-3 menu-item-has-children"><a href="/blog/">博客带子菜单</a>' +
    '<ul class="sub-menu"><li class="menu-item"><a href="/2021/08/26/a">文章</a></li></ul></li>' +
    '<li class="menu-item menu-item-4 menu-item-has-children"><a href="/产品中心/">真父项</a>' +
    '<ul class="sub-menu"><li class="menu-item"><a href="/2021/08/26/b">混进来的文章</a></li>' +
    '<li class="menu-item"><a href="/product-category/串口屏/">串口屏</a></li></ul></li>' +
    '</ul>';

  const { html: out, removed } = removeOwnerMenuItems(html);

  // Two blog entries, each taking whatever hangs off them - leaving an empty submenu
  // behind would be half an edit. Plus the one dead child under a parent that is
  // itself live, which goes alone.
  assert.equal(removed, 3);
  assert.ok(!out.includes('博客'), 'the nav label is gone, not merely unlinked');
  assert.ok(!out.includes('文章'), 'and the post links went with it');
  assert.ok(!out.includes('混进来的文章'), 'a dead child under a live parent is still removed');
  assert.match(out, /产品中心/, 'the real item is untouched');
  assert.match(out, /串口屏/, 'and so are its live children');
});

/**
 * The two front-page blocks as the cache holds them, each inside the Elementor section
 * that wraps it. The tabs widget's nav item carries the query it would have sent to
 * admin-ajax.php, its first pane is server-rendered, and the other panes are an empty
 * shell behind a spinner.
 */
const sectionAround = (widget) =>
  '<div class="site"><p>above</p>' +
  '<div class="elementor-element elementor-element-aa3639c e-flex e-con-boxed e-con e-parent" data-id="aa3639c">' +
  '<div class="e-con-inner">' + widget + '</div></div><p>below</p></div>';

const tabsWidget =
  '<div class="elementor-element elementor-widget elementor-widget-wd_products_tabs" data-id="1b2d3dd">' +
  '<div class="elementor-widget-container"><div class="wd-tabs wd-products-tabs">' +
  '<div class="wd-tabs-header">' +
  '<div class="wd-tabs-loader"><span class="wd-loader"></span></div>' +
  '<div class="tabs-name title"><span class="tabs-text">热门产品分类</span></div>' +
  '<div class="wd-nav-wrapper wd-nav-tabs-wrapper tabs-navigation-wrapper"><ul class="wd-nav wd-nav-tabs">' +
  '<li data-atts="{&quot;taxonomies&quot;:[&quot;462&quot;,&quot;456&quot;]}"><a href="#" class="wd-nav-link"><span class="tab-label">液晶板</span></a></li>' +
  '<li data-atts="{&quot;taxonomies&quot;:[&quot;525&quot;]}"><a href="#" class="wd-nav-link"><span class="tab-label">串口屏</span></a></li>' +
  '</ul></div></div>' +
  '<div class="wd-tab-content-wrapper"><div class="wd-products-element"><ul class="products elements-grid row">' +
  '<li class="product"><div class="product-grid-item"><a href="/product/a/">A</a></div></li>' +
  '</ul></div></div>' +
  '</div></div></div>';

const filterWidget =
  '<div class="elementor-element elementor-widget elementor-widget-wd_product_filters" data-id="037853e">' +
  '<div class="elementor-widget-container"><form class="wd-product-filters">' +
  '<span class="wd-filter-lable">产品</span><ul class="wd-swatches-filter"><li><a href="/?filter_size=1-54">1.54″ TFT</a></li></ul>' +
  '</form></div></div>';

test('removeDeadTabsNavigation cuts the spinner and the tab row, keeps the rendered grid', () => {
  const { html: out, removed } = removeDeadTabsNavigation(sectionAround(tabsWidget));

  assert.equal(removed, 2, 'the loader and the nav wrapper');
  assert.ok(!out.includes('wd-tabs-loader'), 'no spinner waiting for a reply that cannot come');
  assert.ok(!out.includes('wd-nav-wrapper'), 'no row of labels that cannot switch anything');
  assert.ok(!out.includes('data-atts'), 'and none of the query JSON that went with them');
  assert.ok(out.includes('热门产品分类'), 'the heading stays - it names what is below it');
  assert.ok(out.includes('product-grid-item'), 'and so do the products that were already rendered');
  assert.ok(out.includes('wd_products_tabs'), 'the widget element stays: its classes style that grid');
  assert.ok(out.includes('e-con e-parent'), 'and so does its section, which still has content');
});

test('removeDeadTabsNavigation stops after one pass, so a kept widget cannot spin the build', () => {
  const once = removeDeadTabsNavigation(sectionAround(tabsWidget));
  const twice = removeDeadTabsNavigation(once.html);

  assert.equal(twice.removed, 0, 'nothing left to cut, even though the marker is still there');
  assert.equal(twice.html, once.html);
});

test('removeDeadAjaxWidgets leaves the tabs widget alone, because cutting it deletes the page', () => {
  const page = sectionAround(tabsWidget);
  const { html: out, count } = removeDeadAjaxWidgets(page);

  assert.equal(count, 0);
  assert.equal(out, page, 'the two lists are separate on purpose: this widget holds the only products in the body');
});

test('removeDeadAjaxWidgets cuts the swatch filter form and the section left empty behind it', () => {
  const { html: out, count } = removeDeadAjaxWidgets(sectionAround(filterWidget));

  assert.equal(count, 1);
  assert.ok(!out.includes('wd-product-filters'), 'the form is gone');
  assert.ok(!out.includes('filter_size'), 'with links that only ever asked for an AJAX result');
  assert.ok(!out.includes('e-con e-parent'), 'and no blank band keeps its padding');
  assert.match(out, /<p>above<\/p><p>below<\/p>/, 'the page closes up behind it');
});

test('removeDeadAjaxWidgets keeps a section that still holds something else', () => {
  const sibling = '<div class="elementor-element elementor-widget elementor-widget-image"><img src="/wp-content/uploads/s.png" alt=""></div>';
  const { html: out, count } = removeDeadAjaxWidgets(sectionAround(sibling + filterWidget));

  assert.equal(count, 1);
  assert.ok(out.includes('e-con e-parent'), 'the section stays because the image is still in it');
  assert.ok(out.includes('/wp-content/uploads/s.png'), 'and its neighbour is untouched');
  assert.ok(!out.includes('wd-product-filters'));
});

test('both passes are a no-op on a page that carries neither control', () => {
  const plain = '<div class="e-con e-parent"><div class="e-con-inner"><p>just text</p></div></div>';

  assert.equal(removeDeadAjaxWidgets(plain).html, plain);
  assert.equal(removeDeadAjaxWidgets(plain).count, 0);
  assert.equal(removeDeadTabsNavigation(plain).html, plain);
  assert.equal(removeDeadTabsNavigation(plain).removed, 0);
});

test('removeDeadAjaxScripts drops the translator tag in every form the site prints it', () => {
  // The first is the real bytes: WP Rocket replaced src with data-rocket-src and set a
  // delay type. The second is the same file unloaded, the third single-quoted, because
  // this site quotes attributes both ways and a rule that only knows one matches nothing.
  const html = '<head>' +
    '<script type="rocketlazyloadscript" data-rocket-type="text/javascript" data-rocket-src="/wp-content/plugins/translatepress-multilingual/assets/js/trp-translate-dom-changes.js?ver=2.6.9" id="trp-dynamic-translator-js" defer></script>' +
    '<script src="/wp-content/plugins/translatepress-multilingual/assets/js/trp-translate-dom-changes.js?ver=2.6.9" id="trp-dynamic-translator-js"></script>' +
    "<script data-rocket-src='/wp-content/plugins/translatepress-multilingual/assets/js/trp-translate-dom-changes.js'></script>" +
    '<script src="/wp-content/plugins/translatepress-multilingual/assets/js/trp-frontend-compatibility.js?ver=2.6.9" id="trp-frontend-compatibility-js"></script>' +
    '<script>var trp_data = {"trp_custom_ajax_url":"/wp-content/plugins/translatepress-multilingual/includes/trp-ajax.php"}; /* trp-translate-dom-changes.js reads this */</script>' +
    '</head>';

  const { html: out, count } = removeDeadAjaxScripts(html);

  assert.equal(count, 3, 'all three spellings of the same file');
  // Asserted on tags, not on the bare filename: the inline config block below mentions
  // that name on purpose, and a "the string is gone" assertion would fail on the part
  // that is supposed to stay.
  assert.equal((out.match(/<script[^>]*trp-translate-dom-changes[^>]*>/g) || []).length, 0,
    'no translator script tag is left, so nothing posts to a PHP endpoint at load');
  assert.ok(out.includes('trp-frontend-compatibility'), 'the script the language switcher uses stays');
  assert.ok(out.includes('trp_data'), 'and so does the config object it reads');
  assert.ok(out.includes('/* trp-translate-dom-changes.js reads this */'), 'an inline block that merely names the file is not a script tag and must survive');

  const again = removeDeadAjaxScripts(out);
  assert.equal(again.count, 0, 'a second pass finds nothing, so the report cannot double');
  assert.equal(again.html, out);
});
