# 复刻后仍需处理的问题清单

镜像是**原样复刻**（按你的决定：先 1:1，问题另出清单），所以以下缺陷全部来自 `24.4.22-tftstar/` 这份备份本身，镜像只是忠实保留。每条都标注了实测证据与出处，便于你逐项核对。

排查方式：`node tools/inspect-attribution.mjs`（区分"镜像造成的"与"原站固有的"）、`node tools/ingest/wp/probe-spec-integrity.mjs`、`node tools/ingest/wp/probe-cache-collision.mjs`。

---

## 一、内容数据错误（优先级最高）

### 1. 每个产品页的"产品尺寸"都写着 2.1″

`work/wp/.../index-https.html` 起，**所有**产品详情页规格表的"产品尺寸"单元格内容都是 `2.1"TFT round display`，与页面自身的产品不符。

抽查 4 页，`title`、`h1`、`canonical` 都是各自正确的产品，只有这一行恒定：

| 页面 | title / h1 | 产品尺寸 |
| --- | --- | --- |
| `product/starbillions-2-1″-round-tft-xby21fhd/` | 2.1″ round TFT XBY21FHD | 2.1″（恰好正确） |
| `product/starbillions-3-5″-hmi-lcd-module-xby035r320480-01/` | 3.5″ | 2.1″ ← 错 |
| `product/xby035mga310/` | 3.5″ XBY035MGA310 | 2.1″ ← 错 |
| `product/xby035mie660/` | 3.5″ XBY035MIE660 | 2.1″ ← 错 |

已排除两种误判：产物路径**零冲突**（不存在两个页面写进同一文件），且 `probe-spec-integrity.mjs` 逐行比对 15 个可比页面中 15 个不一致，其中分辨率、连接方式（PCB / FPC）、观看方向（IPS / 12 o'clock(TN)）、液晶屏品牌等项差异是实质性的，不是标点或实体编码差异。

**建议**：在 WordPress 后台检查该属性字段是否被写进了共享模板 / 全局默认值，而不是各产品各自填写。修数据后重跑 `npm run mirror` 即可。

### 2. 英文页面的 `<title>` 仍是中文

`dist/en/index.html` 的标题是"深圳市星百亿电子有限公司"，而页面正文已正确切到英文（`h1` = "Professional LCD display"）。属 TranslatePress 的 SEO 标题未翻译，影响英文页的搜索结果展示。

---

## 二、坏链接（原站菜单数据本身是坏的）

`href="http://1"`、`href="http://3"`、`href="http://热卖产品"` 三类，集中在页头"全部产品分类"下拉。已用源/产物计数确认**不是镜像造成的**：

```
href="http://1"        源缓存 7  ->  产物 7
href="http://3"        源缓存 2  ->  产物 2
href="http://热卖产品"  源缓存 1  ->  产物 1
```

浏览器把它们解析成 `http://0.0.0.1/`、`http://0.0.0.3/`、`http://xn--wlqy7if5af60e/`。根因是 WordPress 菜单里这些项的 URL 被填成了裸数字/中文（原形应为 `/产品中心/xxx`），WordPress 补上了 `http://` 协议。全站范围内这类坏 href 的出现量远大于首页（早先统计 `http://1` 1477 处、`http://3` 422 处、`http://热卖产品` 211 处），**建议在后台用"菜单"编辑器逐项修正**。

**2026-11-06 进展现状（已闭合）**：实测确认这些项全部是 `menu-item-type-custom` 的 mega menu 父项，标签在 `<span class="nav-link-text">` 里。**全站 2110 条此类链接已全部修完**（`repairMenuLinks`），目标按两个来源取：① 标签表（串口屏 / 转接板 / Serial screen / adapter board → 各自分类页）；② 否则取**该分组自己面板里的第一个链接**，优先 `/product-category/`、其次 `/product/`（探针：8/8 均能取到，0 取不到）。两者都取不到则摘掉 href（当前 0 例）。门禁现在绝对断言“no menu link points at an origin that is not a real site”，不再把残留当作 info——之前的 info 写法让 1696 条死链以“提示”形式通过了。

（早期版本曾写“16 个分组标题故意没动”，理由是删 href 可能影响手机端展开。该结论已被推翻：面板里本就有真实链接，不需要删 href。另外实测也确认 markup 里没有 `wd-submenu-toggle`、主题 JS 不引用 `woodmart-nav-link`，所以展开行为本来就靠这个链接本身——保留可点击链接才是保留原行为。）

---

## 三、外部依赖（部署后会打不开或变慢）

镜像保留了原站全部外链，未擅自改动：

| 引用位置 | 域名 | 问题 |
| --- | --- | --- |
| ~~3 个 `<link>` 字体~~ | `fonts.googleapis.com` / `fonts.gstatic.com` | **已于 2026-11-06 自托管**（`npm run fonts`）。浏览器实测：首页与产品页指向两个 Google 域的请求均为 **0**，3 个 CSS 与 68 个 woff2 全部本站 200，页面真正在用的 Hind 已 `status: loaded`。未跑该命令时构建保留原链接（镜像不联网）。注：**Hind 不含 CJK 子集**（Google 本来也没提），中文在改造前后都回落到系统字体，不是本次引入的问题 |
| 首页地图 `<iframe>` | `maps.google.com` | 大陆打不开，该区域空白 |
| ~~首页 Elementor 横幅背景图~~ | `starbillions.cn/wp-content/uploads/2023/11/10001*` | **已于 2026-11-06 修好**（`localizeCssAssetUrls`）。本文早前说“该文件在本备份里不存在”是错的（错因见下）：四个文件（`10001.jpg` 92 KB、`10001.png` 29 KB、`10001-1.png` 29 KB、`10001-2.jpg` 19 KB）都在 `wp-content/uploads/2023/11/` 里，**相对路径完全相同**，所以这不是换图，是把指针从证书无效的旧域收回本站。4 个 Elementor 生成的 CSS 被重写，拷进产物的是重写后的文本而不是原件 |
| ~~手机端底部工具栏~~ | `starbillions.savetime.work` | **已于 2026-11-06 在构建期重写**（`tools/lib/site-links.js` 的 `replaceMobileToolbar`）：3 项改为 电话 `tel:+8613714286517` / 产品中心 `/产品中心/` / 联系我们 `/联系我们/`，英文页对应 Call / Products / Contact。第 2、3 项原本图标容器为空（齿轮是 `.wd-toolbar-link .wd-tools-icon:before{content:"\f140"}` 在空容器上的默认字形），**图标现为内联 SVG + `fill="currentColor"`**（不是 `public/icons/` 里的文件，那两个已删——文件内部烤进去的颜色 CSS 无法调与）。原数据来自 Woodmart 主题选项“Bottom toolbar”，不是镜像造成 |

**建议**：地图已换为文字地址；字体自托管脚本已跑过并已提交产物（重跑只会拉新字体）。旧域两处残留已分别处理：底部栏重写、横幅背景图指向本地副本（见上）。

---

### 动态功能在静态站上的现状（2026-11-06 实测）

原站是 WordPress，下面这些功能依赖 PHP。它们的**外观**都在，行为各不相同：

| 功能 | 机制 | 现状 |
| --- | --- | --- |
| 产品搜索 | `admin-ajax.php?action=woodmart_ajax_search` | **已重建为纯静态**：`dist/search.json` + `public/site-search.js`，本地匹配，实测可用（见 README） |
| ~~首页“热门产品分类”4 个页签~~ | `admin-ajax.php?action=woodmart_get_products_tab_shortcode` | **已于 2026-11-06 修好**（`removeDeadTabsNavigation`）：页签行与 spinner 删掉，**已渲染好的第一个面板（10 张产品卡）与标题保留**。不能整块删，原因见八 |
| ~~首页色块筛选表单~~ | `wd_product_filters` + `/?filter_size=` | **已于 2026-11-06 删干净**（`removeDeadAjaxWidgets`）：选项 href 指向查询页，而静态站不存在查询页 |
| ~~分类页价格筛选~~ | `?min_price=&max_price=` + AJAX | **不存在——本文此前写错了**。实测：`wd-ajax-filters-widget` / `wd_filters_full` / `wd-slider-range` 出现 **0** 次，`<input type=range>`、`name="min_price"` 也 **0** 个。所谓“9 处控件”是我数子串数出来的误判：那 9 次 `price-filter` 全部在样式表句柄与文件名里（`woo-widget-price-filter.min.css`、一段 CSS 选择器列表、`woodmart_page_css` 这个 JSON 映射），没有一个在页面上 |
| ~~加载更多 / 产品轮播分页~~ | `woodmart_get_products_*` | **分类页上也没有**（`load-more` / `infinite` 元素 0 个）；商店页的分页是真实的三个缓存页（`/产品中心/`、`page/2/`、`page/3/`），本来就能点 |
| 分类页的汉堡侧栏 | `offCanvasColumnBtn.min.js`（本地 jQuery） | **能用的，保留**：按钮 `.wd-off-canvas-btn` 在窄屏可见（实测 rect 103×15），面板 `wd-col-offcanvas-sm` 已在 DOM 里（默认 `transform: translateX(-300px)` + `wd-side-hidden`），脚本只做 addClass/removeClass/preventDefault，**不请求任何服务端**；面板里是 25 条真实分类与联系链接。注意：本次会话浏览器窗口隐藏，click 事件派发不下去，所以这一项的证据是“监听代码 + DOM 现状”，不是真点了一下 |
| ~~英文页动态翻译~~ | `trp-translate-dom-changes.js` → `trp-ajax.php` → `admin-ajax.php` | **已于 2026-11-07 删除**（`removeDeadAjaxScripts`，见八）：英文首页由 2 条 console error 变 0，英文产品页由 4 条变 0 |
| ~~联系表单（metform）~~ | `POST /wp-json/metform/v1/entries/insert/16312` | **已修（2026-11-06）**：表单删除，每页统一换成跳 WhatsApp 的按钮（当前 137 页，删演示内容前是 217 页，见下）|
| 加入购物车 / 收藏 / 对比 | `?wc-ajax=`、`admin-ajax.php` | 按站主决定主动去除（仅界面，无后端） |

页签若要“真的可用”（而不只是不坏），做法与搜索同理：构建时把各页签/各筛选组合的产品列表预先渲染进去，再把主题 JS 改成本地切换。**但剩下的控件已需先看它是否存在**——上一版表里“价格筛选仍坏”、“加载更多仍坏”两条是我数子串数出来的，现已按实测更正为“不存在”。

**注**：做排行榜榜单不在选项里——`data/wp-products.json` 只有 `order` 一个排序字段，没销量也没评分，任何“热销榜”都是编的。

~~联系表单~~ —— **已于 2026-11-06 移除**（`replaceContactForm`）。原表单 POST 到 `/wp-json/metform/v1/entries/insert/16312`，静态主机无法应答：访客填完、点发送，**既没提示成功也没报错**。现在统一换成一个跳 WhatsApp 的按钮：有页就有一个按钮（构建报告当前计 137 处，删演示内容前是 217 处）。其中绝大多数页是 Elementor widget（`elementor-widget-metform`，来自共享模板），另有几页是 metform 自己的页面（插件直接输出 `mf-form-wrapper`，无 widget 包裹）——只切外层会漏掉这几页。按钮复用站点自己的 `elementor-button elementor-button-link elementor-size-sm` 结构，所以外观由主题拥有。metform 脚本故意保留加载：没容器就不渲染任何东西，删标签会弄动构建器与缓存比对的引用计数，却没有任何可见收益。

底部工具栏那一行：站主 2026-11-05 先选择不动，2026-11-06 改口要求修复，于是做成了构建期规则（`replaceMobileToolbar` + `MOBILE_TOOLBAR` 表），这样重建不会洗掉。后台主题选项里改仍然是更根本的做法——镜像里的规则只是把站主已确认的偏好固化下来。门禁 `check.mjs` 7c 用幂等性断言：对已发布页面重跑一次替换必须**一字不差且仍找到 1 个栏**，这样检查器不需要自己再解析一遍区域就能证明产物等于诉求。

---

## 四、演示内容 —— **已于 2026-11-06 整片删除（共 80 页）**

站主选择“删掉最干净”。一个清单 `OWNER_REMOVED_SECTIONS`（`tools/ingest/wp/staticize.js`）同时决定“不构建”与“摘链接”，另加 `removeOwnerMenuItems` 把页头菜单项整块 `li` 摘掉。删的四类：

| 内容 | 路径 | 证据 |
| --- | --- | --- |
| Woodmart 示例文章 | `/2021/08/26/<slug>/`、`/en/2021/08/27/<slug>/` 中英各 8 | 日本家具 / John Doerson / 亚特兰大住宅，与显示屏无关 |
| 只用来列它们的归档 | `/blog/`、`/category/`、`/tag/`、`/author/` 中英共 30 | 文章一走就是空壳 |
| 示例案例 | `/portfolio/`（中英各 10）+ `/project-cat/`（各 5） | 标题全是拉丁填充；它们是全站仅剩 40 处 `starbillions.savetime.work` 引用的宿主，其中 8 页把 PHP `file_get_contents` Warning 打进了正文 |
| WordPress 示例页 / 横幅归档 | `/sample-page/`、`/woodmart_slider/123/` | 前者是“我白天是个邮递员…”，后者渲染为“什么都没找到”；两者在 sitemap 里且无人链接 |

产物从 217 页降到 **137 页**（754 个文件 / 190 MB），菜单从 6 项降到 **4 项**（首页 / 产品中心 / 关于我们 / 联系我们）。门禁三项绝对断言：无演示页与空归档、无链接指向被删内容且菜单无待切项、留下的主菜单页数与项数均对得上（4 项，无空 href 项）。`savetime` 也从“info 计数”升级为**绝对断言：0 页**。

浏览器实测（只读，未改 DOM）：中英菜单各 4 项且 href 全 200；`/blog/`、`/portfolio/`、`/sample-page/`、示例文章 URL 均返回**站点自有的 404 页**（非空白）；产品中心网格 16 个可见卡片、`wd_shop_archive_*` 零残留；底部栏三个图标 computed color 全为 `rgb(51,51,51)`、尺寸均 20×20。

顺手修正两件事：`starbillions.savetime.work` 现在**零页**（已成绝对断言），演示账号 `instagram.com/ozdesignfurniture` 也随这些页一起消失了——产物里剩下的 “instagram” 字样共 19 处，全部在第三方库内部（`chaty-pro` 的号码→图标映射、Font Awesome 的 `.fa-instagram` 类名），不是链接。

---

## 五、结构性缺口（镜像已尽力，但源数据不全）

### 1. 104 个链接目标原站从未渲染过

`wp-content/cache/wp-rocket/` 只存**有人访问过**的页面。归档页、标签页、搜索结果页、部分分类分页没被缓存，镜像里指向它们的链接会落到 `404.html`。当前 **69** 个不同目标（删掉演示内容前是 104），明细见 `work/mirror-report.json` 的 `uncachedLinkTargets` 字段。

### 2. ~~博客文章共 16 页（中英各 8），全部是演示内容~~ —— 已于 2026-11-06 删除（见上）

镜像产物里博客位于 `/2021/08/26/<slug>/` 与 `/en/2021/08/26/<slug>/`。已核实三者一致：页面 `canonical`、镜像目录结构、数据库当前 permalink `/%year%/%monthnum%/%day%/%postname%/` **都是同一形式**，所以不存在"改过固定链接导致旧链接 404"的问题，`_redirects` 不需要为博客加任何映射。（早期我按一份探测输出的横杠式路径写下过相反结论，那是错的，已用产物实测纠正。）

**这个错我又犯了一次，而且这次更隐蔽。** 写 `isOwnerRemoved` 时我把规则写成了匹配横杠式路径，测试数据也按同一个误解写，于是代码与测试自洽、全绿，**却一页都没删掉**——是构建后拿 `dist` 实测才看到 16 个日期归档页还在。原因：控制台与编辑器会把 `/2021/08/26/` 与 `2021-08-26` **渲染成同一串**，所以光看输出分辨不出来。定形要用 `path.split('/')` 看分段（或写 charCode 构造的 needle），不要看打印出的字符串。

### 3. 购物车、结算、登录、评论提交已按你的决定移除

静态主机无法承载，镜像删除了这些链接的属性（按钮外观保留，点击无动作）。共 2106 处。同时 `admin-ajax.php`、`wp-json/*` 请求会 404，`chaty-pro` 插件的 error 回调引用了未定义函数 `monitorErrorLog`，会在控制台报一条 error —— 那是插件自身缺陷，只在动态端点缺失时暴露。

### 4. WP Rocket 的手机版缓存其实没生效

217 个页面里 **214 个**的桌面版与手机版缓存文件**字节数完全相同**，只有 3 个页面（`/产品中心/page/2`、`/page/3` 等分页）仅存在手机版。说明原站的"独立移动端缓存"开关实质没产生差异。镜像统一取桌面版；静态主机也无法按 User-Agent 分发。

---

## 六、只在浏览器控制台里暴露的三处（均已于 2026-11-06 / 07 修好）

前两处的共同点：**构建产物看起来完整、所有页面断言都绿**，但浏览器一打开就有错。它们都是“资源发现少走一跳”造成的，所以修的是发现器，不是个例文件。第三处不同：它不是资源缺失，是一个在静态主机上永远不该发的请求。

### 1. Elementor 的 webpack 分块从未被拷过

`webpack.runtime.min.js` 里面带一张 chunk id → 文件名的表，因此这些 `名字.哈希.bundle.min.js` **既不出现在任何页面，也不出现在任何 CSS** —— 原有的两跳发现（页面属性、CSS `url()`）永远看不到它们。后果不是静默：浏览器报 `ChunkLoadError`，那个 widget 直接不工作（实测就是 text-editor 的容器块），看起来像主题坏了。现在第三跳会读每个已拷脚本里形如 `name.hash.bundle.min.js` 的字符串，按该脚本自己的目录解析后一并入库。实测：13 个分块全部命中备份，13 个全部拷进产物，控制台 `ChunkLoadError` 为 0。只匹配**带哈希的 `.bundle.min.js`**，因为裸 `"xxx.js"` 字符串在普通代码里太多，照单全收会拷一堆没人要的文件。

### 2. 生成式 CSS 把本站资源写成了另一个域的绝对地址

Elementor 每个 post 生一份 CSS，而 WordPress 写入时用的是**当时那个站的完整 URL**——首页横幅背景图被写成了 `https://starbillions.cn/...`（站主的旧域，证书 `ERR_CERT_COMMON_NAME_INVALID`）。页面级的域名改写看不到 CSS 内部，所以横幅以一块纯色输出。修法是 `localizeCssAssetUrls`：**只在备份里确实有同一相对路径的字节时**才改写，否则保留原样——把指针改到一个自己造的空路径，比指向一个至少有图的旧域更难解释。实测：4 个 CSS 被重写、横幅 `background-image` 已指向本站且 200 / 29 KB、全站 138 张图 0 破图、所有 cssRules 里 `starbillions.cn` 为 0。

上面那行“该文件在备份里不存在”的旧结论，错因与本文第五节的路径坑同一个：`uploads/2023/11/10001.png` 与 `uploads/2023-11-10001.png` 在屏幕上看起来一模一样，而探测脚本按后者拼路径去 `existsSync`，当然找不到。这次是先拿 `split('/')` 看了分段，才发现四个文件一直都在。

### 3. 每个英文页都会 POST 两个不存在的 PHP 端点（**已于 2026-11-07 修好**）

2026-11-06 浏览器实测：`/en/` 首页控制台 2 条 error，英文产品页 4 条；中文页 0 条。请求体是 TranslatePress 自己的：

```
POST /wp-content/plugins/translatepress-multilingual/includes/trp-ajax.php  -> 404
POST /wp-admin/admin-ajax.php                                             -> 404
```

日志里还有一句 `TranslatePress trp-ajax request uses fall back to admin ajax.`——插件先试自己的端点，失败后回退到 admin-ajax，两个都是静态主机上不可能存在的东西。

**怎么定的**（不猜，三个量）：

1. 这个脚本只在英文页加载（中文页只加载 `trp-frontend-compatibility.js`，而中文页 0 个请求）——症状与文件范围完全对齐，所以它就是原因；
2. 它定义的唯一导出符号 `TRP_Translator` 在**任何页面和其他脚本里都没被引用**（只在它自己内部 `new`），删了不会留下一个调用未定义构造函数的脚本；
3. 它的功能（把页面加载后新出现的字符串送去翻译）在镜像上**从来就没成功过**——每个页面的译文已经在 HTML 里，而它的每次请求都是 404。一个从未在这台主机上工作过的功能，不可能因为删了而变坏。

实现是 `removeDeadAjaxScripts`（新清单 `DEAD_AJAX_SCRIPTS`）：只删那个 `<script>` 标签，**保留**语言切换与浮层真正在用的 `trp-frontend-compatibility.js` 和 `trp_data` 配置对象。标签本身有三种写法（WP Rocket 把它改成了 `data-rocket-src` + `type="rocketlazyloadscript"`，本站引号又两种都用），所以规则按文件名匹配整个标签且要求**标签体只能是空白**：内联 JSON 里提到这个文件名的地方因此不会被误删（单测专门守住这一条）。

门禁三条：没有页面还加载它；对产物重跑这条规则必须挖不出东西；**语言切换相关四组计数（兼容脚本、`trp_data`、`trp-floater`、`trp-language`）逐页与缓存页相等**——真正值得担心的不是标签没删掉，而是删的时候把旁边的切换器一并带走了。实测：68 个英文页的标签全部删除，文件不再拷入产物（842 个文件，比之前少一个），英文首页与英文产品页 console error 均为 0、XHR 为 0，`#trp-floater-ls` 浮层仍在且中文链接指回 `/`。

---

## 七、YITH 目录模式（说明，非缺陷）

产品页**没有价格和"加入购物车"按钮**，这是原站启用 `yith-woocommerce-catalog-mode-premium` 的设计（纯展示目录），不是复刻遗漏。

---

## 八、首页只能 AJAX 的组件（2026-11-06 已处理）

站主对这块的原话是“你看有必要吗？没有必要就删了也行，有必要你帮我做成合理的”。量出来的事实：

| 组件 | 内容形态 | 处置 |
| --- | --- | --- |
| `wd_products_tabs`（首页“热门产品分类”） | 4 个页签（液晶板 / 串口屏 / 转接板&测试板 / 圆形&长条形显示屏），只有第一个的面板是服务端渲染好的 10 张卡；其余三个靠 `action=woodmart_get_products_tab_shortcode` | **只删控件**：`wd-tabs-loader` 与 `wd-nav-wrapper` 整块挖掉，标题与 10 张卡保留 |
| `wd_product_filters`（首页色块筛选） | 选项 href 全是 `/?filter_size=…`，而查询 URL 在 `isExcluded` 里已判为非页面 | **整块删**，外层 section 若因此空了一并删（否则留一条带 padding 的空白色带） |

**为什么不能整块删页签（我删错过一次）**：第一版把 widget 连着外层 section 全取了，门禁与单测全绿，浏览器实测才发现首页正文**一个产品卡都不剩**——首页那 56 个 `wd_products` 网格全部在页头巨型菜单的下拉里（`visibility: hidden`、rect 全 0），止于 hover。正文里唯一的产品网格就是这个页签的第一面板。于是拆成两份清单：`DEAD_AJAX_WIDGETS`（整块删）与 `DEAD_TAB_WIDGETS`（只删控件）。

门禁为此加了一条不依赖我记忆的一般断言：**每页产品卡片数必须与缓存页严格相等**（`no page gained or lost a product card`），0 页差异。卡片数比“链接还在不在”更能发现问题——藏在隐藏下拉里的卡片链接也算“可达”，可它们在屏幕上并不存在。

实测（只读浏览器）：中英首页标题仍在（`SPAN.tabs-text`，rect 132×35 / 324×35），正文卡片各 10 张、尺寸均 214.8×217.2，`.wd-nav-tabs .tab-label` = 0、`.wd-tabs-loader` = 0，标题底到卡片顶只隔 9.8–10.0 px，无 >200px 空白段；中文页 console error 0。

### 隐形电话链接拨的是新西兰号码

产品页联系区块写着 `Phone: (86) 13714286517`，而 Woodmart 盖在整行上的 `<a class="wd-fill" href="tel: (064) 332-1233">` 还是主题演示的新西兰号码——手机上点那一行就拨到国外。规则 `repairPhoneLinks`（按位比对，不等于 `ENQUIRY_PHONE` 就改）共修 121 处；先量过：全站只有三个不同的 `tel:` 值（真的一个 + 占位符两种写法），所以“全改”是安全的。实测产物只剩 `+8613714286517`（258 处），`(064)` 为 0。

---

## 九、页面体积：静态不等于快（2026-11-07 实测与处理）

站主的问题是“整个网站是纯静态的吧？速度应该是极快的，是吧”。

**纯静态这一半成立**，而且是实测的：浏览器里中文页与英文页的 XHR 各 0 个、外部请求 0 个，字体全部本地；产物里以 `href`/`src` 形式出现的外部主机只有两个——`wa.me`（询盘按钮，访客点了才走）和 `gmpg.org`（`<link rel="profile">` 的命名空间 URI，浏览器不发请求）。

**但“静态”描述的是服务器，不是页面重量**：镜像把原站的字节一并复刻了过来。原始产物实测：首页拉 83 个样式表、64 个脚本、302 个图片引用（合计 56 MB），产品页 92 / 73 / 363（合计 75 MB）。下面两件事处理后的结果（本地 HTTP 实访）——

| 页面 | HTML（brotli） | 样式表请求 | 图片请求（webp / 原图） | 该页点名图片总量 | eager 首屏图 | HTTP 失败 |
| --- | --- | --- | --- | --- | --- | --- |
| 中文首页 | 34 KB | **19**（原 83） | 187 / 113 | 56,215 → **11,464 KB** | 18 KB | 0 / 333 |
| 英文首页 | 35 KB | **19** | 187 / 113 | 同上 | 18 KB | 0 / 333 |
| 产品中心 | 35 KB | **20**（原 92） | 185 / 113 | — | 0 KB | 0 / 331 |
| 分类页 | 34 KB | **20** | 185 / 113 | — | 0 KB | 0 / 331 |
| 产品页 | 37 KB | **20** | 227 / 133 | 74,831 → **17,032 KB** | 1,195 KB（上界，见下） | 0 / 394 |

表里“该页点名图片总量”包括懒加载图——它们首屏不下——它存在只是为了说明 45 MB 去了哪里。样式表那一列是另一轮工作的结果（README 第十六处）：全站 17 个内容寻址的 bundle 替掉 12,089 个 link，**消掉 9,432 个请求**，而 CSS 压缩后反而更小（首页 gzip 129 → 114 KB）。

### 做了的两件事

**1. 大图转 WebP（272 张）。** `npm run images`（`tools/media/convert.mjs`，用 devDependency `sharp`）从**缓存页真正引用的**文件里挑出 ≥40 KB 的 PNG/JPG 转 WebP（quality 82），并写 `work/media/manifest.json`；`npm run mirror` 读表把引用改成 `<原名>.webp`。实测 69,723 KB → 17,046 KB。

- 两次构建实测产物：**192.6 MB / 842 文件 → 143.9 MB / 844 文件**（同一台机器、同一份备份，把 manifest 临时移开跑一次、放回来跑一次）。
- 门槛之下不转：11 张转出来省不到 25%（WebP 对某些已高度优化的 JPG 确实几乎无收益），保留原文件；40 KB 以下不转，因为每多一张就多一份清单条目、多一个入库文件。
- 只转页面引用的，不转 CSS 引用的——这不是猜测：实测**样式表里没有任何 ≥150 KB 的图片**（0 张），所以不需要动拷出去的 CSS。
- 原文件在**产物文本不再提它**时才不拷（判定读 dist，不读缓存）：本轮 207 张原图不再入库，65 张转好的因为只被已删除的演示页引用而没入库。

**2. 视频补自己的首帧当 poster（2 个视频、7 页 14 个标签）。** 产品的“特色图”14 页全是同一张站内占位图（`62b9cc781cece.png`），拿它当 poster 等于给十四个不同产品贴同一张不相干的图，比黑块更糟；所以 poster 由 `ffmpeg` 从**视频自己的第一帧**取，并加 `preload="none"`。实测 14 个 poster 引用全部 `200 image/webp`（含带中文的文件名）。

### 没做的，以及为什么

- **`loading=` / `defer` / CSS 内容清理一概没动**。它们属于“改造站点”，而本项目的边界是“复刻 + 站主明确要求的偏离”。
- **脚本还是 64 个**（约 1.4 MB 磁盘量）。合并样式表已把 CSS 请求从 83 降到 19，但 JS 合并会改变执行顺序与依赖（jQuery / WooCommerce hooks），那不是“发什么字节”而是“跑什么代码”，风险与收益不对等。
- 产品页首屏那 3 张 eager 图合计 1,195 KB 是**按 `src` 指向的文件从磁盘量的**；每张都带 `srcset`（含 768w 一档），浏览器按视口宽度选，真实传输多半更小。本机视口 `hidden`，拿不到浏览器实际选中的那一档，所以这里给的是上界而不是实测值。
- 上一版本本节写下过“CSS 只有 24 KB”与“请求数没减”两句错话，都是探测脚本自己的坑：它只认 `href="…"` 双引号，而主题写的是 `href='…'`，于是一页 83 个样式表只读到 3 个。两个教训已归入下面的门槛。

重现方式：`npm run images` → `npm run verify`。没跑过 `images` 时一切照旧（构建器读不到清单就不改引用，门禁降级成一条 info），这也是 Pages 端不需要 `sharp` 的原因。

