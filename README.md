# starbillions.cn — tftstar.com 的静态复刻

原站是 WordPress + WooCommerce + Woodmart + Elementor + TranslatePress 的定制显示屏（TFT，薄膜晶体管）厂商站，中英双语。本仓库把它**原样复刻**成纯静态站点，部署到 Cloudflare Pages。

关键事实：复刻的输入不是重建，而是**原站自己的产物**。备份 `24.4.22-tftstar/` 里有 `wp-content/cache/wp-rocket/` —— WP Rocket 的页面渲染缓存，存的是 PHP 执行**之后**的完整文档（217 页，含主题 header/footer、双语版本）。因此不需要跑 PHP 或 MySQL 就能得到 1:1 结果。

镜像本身零运行时依赖，只用 Node 内置模块（要求 Node ≥ 20）。唯一的例外是可选的 `npm run images`，它需要 devDependency `sharp`（视频首帧还需本机 `ffmpeg`），只跑在开发机上：Pages 不构建，产物里的 WebP 就是普通文件。

## 命令

```
npm run wp:data     备份的 SQL dump  -> data/wp-*.json（结构化内容）
npm run images      大图转 WebP + 视频首帧当 poster -> work/media/（可选，见下）
npm run mirror      页面缓存 + 归档资源 -> dist/
npm run check       校验产物（部署门禁，失败退出码 1）
npm run verify      mirror + check
npm test            URL 改写与内容改动的单元测试
npm run preview     本地起 dist/
```

没有 `deploy` 脚本：发布靠推到 GitHub，Pages 从仓库取产物（见下）。

`npm run images` 是**唯一需要依赖与本地工具的命令**（`sharp` + `ffmpeg`），且只在开发机上跑：
它写的 `work/media/manifest.json` 不入库，Pages 也不跑构建，所以没跑过这条命令时镜像照旧发原站的字节——
**慢一点，不是坏掉**。跑过一遍之后，`npm run mirror` 才会把引用改成 WebP。

`node tools/mirror.mjs --site-origin https://your-domain.com` 换目标域名；
`--language-floater top-right|top-left|bottom-right|bottom-left` 换语言浮层位置；
`--whatsapp 13714286517` 换询盘按钮的号码（传空串则不改这些按钮）；`--dry` 只统计不写盘。

## 目录

```
tools/mirror.mjs            构建器：缓存页发现 -> URL 改写 -> 资源入库 -> sitemap/404
tools/check.mjs             产物校验器（部署前跑）
tools/serve.mjs             静态预览服务器
tools/lib/paths.js          所有路径的唯一来源
tools/lib/fs-utils.js       文件遍历与删除
tools/media/convert.mjs     npm run images：转 WebP / 视频首帧，写 work/media/manifest.json
tools/media/apply.js        把那张表落到一份成品文档上（唯一有单测的媒体层）
tools/ingest/wp/            WordPress 备份的读取与探测
  sql-dump.js               MySQL dump 状态机解析器（不能用行正则：post_content 含 \n 与 );）
  model.js                  行 -> 对象、postmeta 按 post 聚合
  extract-catalog.js        产品 / 规格面 / 分类（绕开 PHP 序列化）
  staticize.js              URL 分类与改写：整个复刻逻辑里唯一有单测的纯函数层
  index.mjs                 抽取入口
  probe-*.mjs               各项清点（内容、构建器、Elementor、缓存、覆盖率、变体、规格完整性…）
  untar.mjs                 零依赖 tar+gzip 抽取（bsdtar 解不了这里的 UTF-8 中文文件名）
data/                       数据库抽出的结构化内容（入库）
public/                     直接放 Pages 根的文件：_headers、_redirects、robots.txt
docs/fixes.md               原站固有问题清单（按你的决定：先 1:1 原样保留）
dist/                       产物，不入库
work/                       临时物：解包的 1 GB docroot、解压后的 SQL、探测报告，不入库
```

`work/archive/friway/` 是被替换掉的早期方案（自己写的设计系统与模板），留在磁盘上仅作历史参考，不参与构建。

## 复刻的几条硬规则

这些规则每一条都对应一次实测踩坑，改动前请先读 `tools/ingest/wp/staticize.test.mjs`：

1. **页面 URL 取自缓存目录路径，不取 canonical。** 217 页里有 **97 页没有 canonical**（全部归档页、商店页、分类页、作者页、分页），按 canonical 会丢掉 45% 的页面。有 canonical 的 120 页与目录路径**零冲突**。
2. **站内资源一律根绝对路径（`/wp-content/...`），不相对化、也不用新域名绝对地址。** 页面深度参差（`/product/x/` 与 `/2021-08-26-y/`），且 CSS 内部也有绝对 URL；绝对域名会让本地预览全量失败（曾导致 67 个 CSS 打不开、页面完全无样式）。唯一例外是 canonical / hreflang / og:url / JSON-LD `@id` 这些**身份 URL**，它们必须保持绝对且指向新域名，否则等于告诉搜索引擎这份副本是别人的站点。
3. **资源按路径形态发现，不按属性名枚举。** 属性名单曾漏掉 `data-wood-src`，导致 118 张产品图既没改写也没拷贝，全站图片停在 1×1 占位符上、首页被撑到 201161px 高。
4. **CSS 内部的 `url()` 要再跟一跳。** 只扫页面会漏掉整套 Font Awesome 字体（23 个文件），图标不显示。
5. **`?ver=` 不是"请求特定 URL"。** 把"带 query 就剔除"用在资源上，会删掉每页 69 个脚本的 `data-rocket-src` 和 13 个样式表的 `href`，jQuery 从不加载 —— 而只检查"引用是否指向存在的文件"的校验器会认为这很完美。
6. **`<base>` 必须整块删除**，不能只清空它的 `href`：属性改写会先把 `href` 掏空，之后要求 `href="..."` 的正则再也匹配不到那个空元素，留下的 `<base>` 会毁掉全站相对链接。
7. **TranslatePress 的 `/zh_cn/` 前缀要剥掉**（`/zh_cn/P` → `/P`，`/en/zh_cn/P` → `/en/P`）。原站由插件在请求时改写；静态树没有。实测剥完指向的页面**确实存在**，不是把 404 挪个地方。
8. **资源发现要走三跳，且只对“本地确实有”的跨域地址动手。** 第一跳是页面里的引用（按路径形态而非属性名），第二跳是已拷 CSS 的 `url()`（不然整套 Font Awesome 字体丢），第三跳是已拷 JS 里**按名字要到**的 webpack 分块（`名字.哈希.bundle.min.js` 只存在于 Elementor 的 runtime 表里，前两跳永远看不到）。跳不过去的时候宁可保留原样：CSS 里指向旧域的绝对地址**只在备份里有同一相对路径的字节时**才改指向本地——指到一个自己造的空路径比指到一个至少有图的旧域更难解释，也更快使门禁变成假报告。
9. **媒体改写是最后一道工序，而且它判“还需要拷什么”看的是产物、不是缓存。** 一张图的引用在同一页里可能有四种写法（绝对域名、根绝对、百分号编码、原样中文），而编码形状要到 URL 改写之后才定下来，所以加 `.webp` 这一刀必须在最后，且要同时命中两种拼法：只按文件系统的拼法去匹配，会漏掉一个 `srcset`——而漏掉的那一半在原图被剪掉之后就是一个 404。剪不剪同理：页面过了改写，拷出去的 CSS 没有，所以“这张原图还有人提吗”只能在写完之后扫 dist 来回答（扫的时候锚在清单自己的目录上，不靠“长得像个文件名”：`x(1).jpg`、`Picture topaz.png`、`微信图片_2023111.jpg` 都会挫败一个过于宽的文件名模式，而错方向的代价是一个图打不开）。

## 校验器断言什么

`npm run check` 不只是"构建成功了"，它断言：

- 页面里不残留旧域名引用；同源资源**不得**以绝对 URL 出现
- 每个被引用的资源都能在 `dist/` 里解析到（未缓存的**页面**目标只报告、不算失败，因为那是原站从未渲染，不是构建错误）
- **引用数量不得凭空减少**：与源缓存逐项对数（延迟脚本源、样式表 `href`、懒加载图源），源计数为 0 视为断言本身失效而非通过
- 拷贝出去的 CSS 内部不含旧域名，也不含站主另一个域（`starbillions.cn`）的地址 —— 后者现在全部指向本站副本，而且被指到的文件**必须在产物里**
- 每个已拷脚本按名字要的分块都真的在产物里（`ChunkLoadError` 的唯一可行前置检查，因为它只在浏览器控制台里出现）
- 删掉的演示内容：无文件、无链接、无空菜单项，且留下的主菜单仍是四项
- 字体自托管后的三层一致性：页面不再叫 Google、保存下来的 CSS 所点名的 woff2 **必须在产物里**、CSS 内部不再含 `gstatic`（没跑 `npm run fonts` 时这三条降级为一条 info，不算失败）
- 只能 AJAX 的组件：整块删的删到了、只删控件的挖不出东西了，且**每页产品卡片数与缓存页相等**（删控件不许带走内容）
- `tel:` 链接全站只能有一个号码，且必须等于 `ENQUIRY_PHONE`
- 只能 AJAX 的脚本：页面不加载它、重跑规则挖不出东西，且**语言切换相关四组计数逐页与缓存页相等**（防的是删的时候把旁边的切换器一并带走）
- 媒体改写两边都对得上：产物点名的转换文件**必须在产物里**、产物**不得还点原图**（页面级）、不得带着没人要的转换文件，而带视频的页必须真的写了 poster；没跑 `npm run images` 时这一组降级为一条 info
- 双语结构齐备（根文档、`/en/`、sitemap、`_headers`、`404.html`）

`404.html` 用首页自己的 header/footer 拼装（原站从未缓存 404 页），因此它不是复刻、是补作 —— 站点名从首页 `<title>` 后缀取，不硬编码。

## 部署（GitHub → Cloudflare Pages）

Pages 直接发布仓库里的 `dist/`，**不跑构建**。这不是偷工，而是唯一选项：mirror 的输入是 `work/` 里解包的 1.9 GB 站点目录和 `24.4.22-tftstar/` 里 396 MB 的备份，两者都不能也不应进仓库，所以 Pages 上无米可炊。

因此 `dist/` 是**纳入版本控制的生成物**，发布流程就三步：

```bash
npm run verify            # 重建 + 门禁（失败就别推）
git add -A && git commit  # 产物与工具一起提交
git push                  # Pages 检测到新提交后自动部署
```

Pages 项目的设置（Create project → Git → 选 `zzydhj/starbillions`）：

| 项 | 值 |
| --- | --- |
| Root directory | 仓库根（留空） |
| **Build command** | **留空**（不能填 `npm run mirror`，那里没有构建输入） |
| Output directory | `dist` |

`_headers`、`_redirects`、`sitemap.xml`、`404.html` 都在 `dist/` 里，Pages 会直接生效；深层页面的 `…/index.html` 会自动去后缀，所以链接写 `/product/xxx/` 形式即可。

### 域名：每个站就是它自己，不做任何跳转

站主 2026-11-07 最终确认：**没有重定向规则**。`starbillions.cn` 就是 `starbillions.cn`，`tftstar.com` 就是 `tftstar.com`；两者共用一套代码但分开部署，各自服务自己的域名。因此：

- **本站声明裸域**：`SITE_ORIGIN = https://starbillions.cn`。这不是新偏好，而是原站自己的写法——构建器读的那份缓存首页里 `canonical = https://tftstar.com/`、hreflang 也是裸域，全篇没有 `www`。镜像不去发明一个原站没用的写法。
- **构建负责不写错 host**。`SITE_ORIGIN`（`tools/lib/site-links.js`）是唯一一处，每页的 `rel="canonical"`、hreflang、`og:url`、`sitemap.xml` 的 `<loc>`、`robots.txt` 的 `Sitemap:` 行都**由它**派生（最后这一行以前手写，文件里还留着一句“改这里记得改那里”——现在由构建覆写，耦合消失）。改这个常量后必须重跑 `npm run mirror`。
- **不配跳转也能跑**，因为产物里所有内部链接都是根绝对路径（`/product/x/`），不依赖访客输的是哪种写法。`www.` 与裸域都打得开、内容一致；只有身份字段选一边，选的是裸域。

**本站只有 `.cn` 这一个后缀。** `starbillions.com` 不是本站地址，也不是将来要收拢的别名。仓库本地目录名叫 `starbillions.com` 只是历史包名，与域名无关（曾导致我把 `.com` 当目标域名写进 canonical/sitemap/robots，已全部纠正，门禁现在守这一条）。

Pages 侧要做的是把域名挂上项：Custom domains 里 `starbillions.cn`（建议连 `www.starbillions.cn` 一起挂，两边内容相同、不会报错）。**不需要 Bulk Redirects 列表**。

将来要换域名时，改动只有一处：`SITE_ORIGIN` 改成新主机，重跑 `npm run mirror`。这个常量是答案的唯一定义处，产物里不会残留另一个 host（门禁会比对两种写法，只允许声明的那一种）。

## 与原站不同的十五处（均为有意）

复刻之外，站主明确要求过、或原站自身写错而必须偏离的共十五处。它们全部集中在 `tools/lib/site-links.js`、`tools/ingest/wp/staticize.js` 与 `tools/media/apply.js`（偏好只写一份，构建器与门禁读同一处）：

- **语言浮层**：原位置 `trp-bottom-right` 在手机上正好盖住底部菜单项，改为 `trp-top-right`。做法是换 TranslatePress 自己的位置类，不是写 CSS 覆盖 —— 插件的 `.trp-top-right` 规则在源码顺序上晚于 `:hover` 规则，同特异度下后来者赢，不需要 `!important`。
- **询盘按钮**：产品页那 68 个（中英各 34）原本指向 `starbillions.cn` 的联系页（第三个域名），改为 `https://wa.me/8613714286517`。只按按钮可见文案匹配，所以改文案就会安全地不再命中；其余“联系我们”类链接一律未动。

这两条在 `npm run check` 里有对应断言，且**源计数为 0 直接算失败**，免得重建把它们弄丢后门禁反而绿灯。

**3. 产品搜索改为纯静态。** 原站搜索是 Woodmart 的 AJAX 自动完成，POST 到 `/wp-admin/admin-ajax.php?action=woodmart_ajax_search`；静态主机没有 PHP，所以它只会转圈。回车则提交 `GET /?s=关键词`，Pages 把 `/` 解成首页文件、丢弃查询串，于是访客回到自己刚出发的地方。

现在：构建时从**已发布的产品页**生成 `dist/search.json`（68 条 = 34 产品 × 双语），`public/site-search.js` 在浏览器本地匹配，结果填进主题原有的下拉结构（`.autocomplete-suggestions` 等类名原样复用，所以样式是主题的）。不依赖 jQuery，不请求任何服务端。

索引为什么从渲染页抽而不是从 `data/wp-products.json` 抽：后者来自 SQL，`sku` 与 `price` 是空的（原站开了 YITH 目录模式），而页面上的**规格表**（分辨率、接口、尺寸、型号）才是买家真正会搜的东西。另外两项回灌必不可少：

- **分类归档页标题** —— 中文术语名（串口屏、转接板）只出现在分类页上，产品页里一个都没有
- **mega menu 分组标签** —— “圆形&长条形显示屏”不是术语名，只是菜单标签，不抽它就搜不到

搜索范围只含产品（与原站 `data-post_type="product"` 一致）。打分权重把标题排在规格之上，因为本站有个已知数据缺陷：所有产品页的“产品尺寸”恒为 `2.1"TFT round display`，裸搜 `2.1` 会命中全部 68 条。

两个实现约束，都是实测踩出来的，改代码前请先读：

- `public/site-search.js` **不得 import 任何东西**。它被浏览器当模块加载，`import '../tools/...'` 是仓库路径不是 URL，会 404 导致整个模块不执行——单测全绿而线上功能为 0%。`npm run check` 已断言这一点。
- `wd-opened` 必须加在 `.wd-dropdown-results` **元素自身**，主题的规则是 `.wd-dropdown.wd-opened{visibility:visible;opacity:1}`；只加在 form 上会匹配不上，结果进了 DOM 但屏幕上看不见。

**4. 分类页那两组死控件删掉了。** 工具栏上的「展示：9 / 12 / 18 / 24」和右侧四个列数切换图标，锚点**连 href 都没有**；把备份里主题 322 个 JS 加全部插件 JS 全搜了一遍，没有任何文件提到 `per-page-variation` / `shop-view` / `per-row-`，所以没有代码在听这个点击 —— 原站上它们也一样点不动，不是复刻弄坏的。另外「每页 24 个」也兑现不了：WP Rocket 只缓存过每个分类的第 1 页，`product-category/*/page/2/` 在镜像里不存在。

删的是整个 Elementor widget 而不是里面的控件（空壳会继续占自己的 margin），并且**按标签配对切，不按文本切**：同一串类名在行内 CSS 里也出现（`wd-products-per-page` 提及 268 次但只有 51 个元素），按文本匹配会凭一个选择器删掉真内容。构建器现在会在自己改动使某页产品卡片数发生移动时直接报错。

**5. 手机端底部栏改成三个真入口，且三个图标共用一个颜色来源。** 原本 3 项标签全是字面 `123`，链接全指向建站期的临时域名。现在是电话（`tel:+8613714286517`）/ 产品中心 / 联系我们，英文页对应 Call / Products / Contact。英文项指向 `/en/产品中心/` 这种中文路径而不是好看的英文 slug，因为那才是镜像**真正写出**的文件位置 —— TranslatePress 对默认语言保留中文 slug，自己编一个英文 slug 只会 404。

图标不用图片文件而用**内联 SVG + `fill="currentColor"`**：站点自己的 `uploads/2023/11/phone.svg` 把 `#0066b6` 烤进了文件且不读 currentColor，而手绘图标文件是深色 —— 三个并排就变成一蓝两黑，且 **CSS 无法调与**（文件内部颜色不由外部样式接管）。现在三个图标都继承链接自己的文字色，hover 与配色方案切换也一致。门禁断言：栏内 `fill="currentColor"` 必须等于项数，且**不得出现任何烤进去的十六进制色**。

（顺带说明一个原本的怪现象：第 2、3 项那个齿轮不是人选的图标，而是 `.wd-toolbar-link .wd-tools-icon:before{content:"\f140"}` 在图标容器为空时的默认字形；`wd-tools-custom-icon` 会压制它，而原标记只给第 1 项加了这个类。）

**6. 页脚版权年份从 2024 改到当下。** 原站写死了 `© 2024`，全站 212 处、无一例外。年份是 `site-links.js` 里的 `COPYRIGHT_YEAR` 常量，不是运行时算的——版权行是对内容的陈述，不是访客时钟。门禁两个方向都断：不许有页还写着 2024，**且必须有页写着新年份**，否则规则失配时“零残留”会被当成通过。

**7. 菜单里 2110 条指向本站之外页面的链接全部修完。** 原站菜单把 URL 字段填成了裸数字或标签本身（`http://1`、`http://3`、`http://热卖产品`），浏览器会解成 `0.0.0.1`。目标按两个来源取，**都不是我编的**：先查标签表（串口屏 / 转接板 → 各自的分类页），否则取**该分组自己面板里的第一个链接**（优分类列表，因为标题应该打开列表）；两者都取不到则摘掉 href，留下一个诚实的标题而不是一个骗人的链接。删掉演示页之后，产物里实际路由的是 1310 条。

**8. 每个英文页都以英文名开头。** 原站 10 个英文页的 `<title>` 页面名部分是中文（`en/联系我们/`、`en/串口屏/`…）。这些英文大多不是翻译而是**抄站点自己已经发布的东西**（英文菜单里就写着 “Serial screen”、“adapter board”）。公司中文注册名保留在后缀（镜像里没有英文名可替代）；`en/index.html` 标题只有公司名，给它加了站点在英文产品名里已在用的品牌 `Starbillions` 领头，避免首页成为全站唯一例外。其中两个（示例页、横幅归档）属于下面第 9 条删掉的演示内容，所以现在实际改的是 8 页。

**9. 主题自带的演示内容整片删掉，共 80 页。** 站主要求“删掉最干净”。删的是四类同一性质的东西：

- **演示文章与其归档**（`/2021/08/26/…` 中英各 8 篇 + `/blog/`、`/category/`、`/tag/`、`/author/`）—— Woodmart 示例文（日本家具、John Doerson、亚特兰大住宅），与显示屏业务无关；文章一走，只用来列它们的归档就是空壳
- **演示案例**（`/portfolio/` 中英各 10 页 + `/project-cat/` 各 5 页）—— 标题全是拉丁填充（“A lacus bibendum pulvinar”），而且它们是**全站仅剩 40 处 `starbillions.savetime.work` 引用**的宿主（图片指向建站期预览域名），其中 8 页还把 PHP 的 `file_get_contents` Warning 直接打进了自己的正文
- **WordPress 示例页** `/sample-page/`（“我白天是个邮递员，晚上就是个有抱负的演员”）与 `/woodmart_slider/123/`（渲染出来是“什么都没找到”）—— 两者都在 sitemap 里，且无任何链接指向

机制上只有一张清单（`staticize.js` 的 `OWNER_REMOVED_SECTIONS` + `isOwnerRemoved`），它**同时**决定“不构建哪些页”和“`isExcluded` 摘掉哪些链接”，所以两半不可能不一致；页头的 博客 / Portfolio 两个菜单项由 `removeOwnerMenuItems` 在 URL 改写**之前**整块 `li` 摘掉（在那之后 href 已没了，认不出来），带死链的子树一起走、自己链接还活着的父项只摘死子项。产物：137 页（原 217），菜单剩 4 项（首页 / 产品中心 / 关于我们 / 联系我们），门禁断言“无文件、无链接、无空标签、留下的菜单确实是这四个”。（当时的文件数/体积不写在这里：字体与 WebP 两轮各自又改过它，当前值只看 `npm run check` 的 `dist:` 行。）

一个必须记住的坑：文章 URL 的真实形态是 `/2021/08/26/slug/`（固定链接是 `/%year%/%monthnum%/%day%/%postname%/`，缓存目录层级就是证据），而我第一版规则写成了 `/2021-08-26/slug/`。**控制台与编辑器会把这两种写法渲染成同一串**，所以代码看着对、测试也绿（测试数据是我按同一个误解写的），却一页都没删掉。判定路径形态要用 `split('/')` 看分段，不要看打印出来的字符串。

**10. 字体自托管，不再是 Google 提供。** `npm run fonts`（需联网，仅这一条命令联网）从**已构建的页面**里枚举真正被引用的 Google Fonts CSS，把每个 `@font-face` 的 woff2 下到 `public/fonts/`，名字按 URL 的 sha1 取（Google 的 basename 是短哈希，去掉目录后不同家族会碰名），并写 `manifest.json`。`npm run mirror` 按表把页面上的 URL 改成本站 `/fonts/…css`；**没表就一个字不改**，所以镜像本身仍是可离线重现的。改的是指针而不是标签：只替掉 URL 文本，`type`/`media` 和原站的引号形状全部保留。

两个细节都是实测踩出来的坑：（a）这些 `<link>` 在本站标记里用的是**单引号**（`href='https://…'`），而第一版规则要求 `href="…"`，于是一句也没命中，构建却报“0 local, 0 missing”——这看上去像“没东西可做”，而不是“规则看不见自己的输入”；现在取 URL 本身去匹配，不取属性形式。（b）`normalizeFontUrl` 只剔掉 `ver=` 缓存串；早期版本在第一个 `&#038;` 处截断，会连带丢掉 `display=swap`，保存下来的 CSS 就不是站点要的那份。抓取器与重写器共用同一个 finder（`googleFontStylesheetUrls`）和同一个归一化函数，不然清单键对不上就是静默不生效。

产物实测：3 个 CSS + 68 个 woff2（共 1.8 MB），405 个页面链接已本地化，首页与产品页指向两个 Google 域的请求为 0，页面真正在用的 Hind `document.fonts.check` 为 true。注意 **Hind 本身不含 CJK 子集**（Google 也不提供），所以中文一直回落系统字体 —— 自托管不改变这一点，也不是缺陷。

**11. 首页“热门产品分类”只删页签行，不删产品。** 那个组件是 Woodmart 的 `wd_products_tabs`：四个页签里只有第一个的内容是服务端渲染好的，其余三个靠点下去调 `admin-ajax.php`——静态主机上就是三个永转的圈。同一页还有一个 `wd_product_filters` 色块筛选表单，选项的 href 全是 `/?filter_size=…`（查询页根本不存在），删干净。

但这个页签不能整体删，这是我删错一次后浏览器告诉我的：第一版把 widget 连着外层 section 一起取了，结果首页正文**一个产品都不剩**——首页那 56 个 `wd_products` 网格全在页头巨型菜单的下拉里（`visibility: hidden`），正文里唯一的产品网格就是这个页签的第一面板。现在的做法是两份清单分开：`DEAD_AJAX_WIDGETS`（只能 AJAX，整块删 + 空了就删 section）与 `DEAD_TAB_WIDGETS`（只能 AJAX 的是**控件**，只挖掉 spinner 与页签行，标题和已渲染网格留下）。门禁断言三件事：没有页还带着只能 AJAX 的 widget；对产物重跑 `removeDeadTabsNavigation` 必须挖不出东西；**每页产品卡片数与缓存页严格相等**（最后一条就是能发现我那个错误的一般断言）。实测：中英首页标题仍在，正文卡片各 10 张全部可见，标题到卡片只隔 10 px，无空白段。

一个删得对不对的判据：“热门”排行做不了也不做——`data/wp-products.json` 里没有销量、没有评分（只一个 `order` 排序字段），任何榜单都是我编的；而页签自己带的是 `taxonomies` 分类 ID 集合，是原站自定义的分组，不是排行。

**12. 所有 `tel:` 链接改拨公司自己的号码。** 产品页联系行写着 `Phone: (86) 13714286517`，但 Woodmart 盖在整行上的隐形链接是 `<a class="wd-fill" href="tel: (064) 332-1233">`——主题演示的新西兰号码。手机上点那一行就拨到了国外：**可见文字是访客能核的那一半，href 是真正行动的那一半**。全站只有三个不同的 `tel:` 值（真的一个，占位符两种写法：带空格与 `%20`），所以“按位比对、不等于本站号码就改”是安全的（先量后写，不是推论）；共修 121 处。号码取自 `ENQUIRY_PHONE` 常量，与底部栏、WhatsApp 按钮同源。

**13. 英文页不再加载 TranslatePress 的动态翻译脚本。** `trp-translate-dom-changes.js` 是个 MutationObserver，把页面加载后新出现的字符串 POST 给 `trp-ajax.php`，失败则回退 `admin-ajax.php`——两个在静态主机上都是 404，实实在在在每个英文页的控制台上留了 2–4 条错误。删它的依据是三个量，不是推测：症状范围与文件范围完全对齐（只有英文页加载它，也只有英文页报错）；它定义的唯一符号 `TRP_Translator` 全仓无任何其他引用；它的功能在这台主机上**一次也没成功过**——从未工作过的东西不会因为删反而变坏。只删标签，语言切换真正在用的 `trp-frontend-compatibility.js` 与 `trp_data` 一个字不改。标签有三种写法（WP Rocket 把它改成 `data-rocket-src`，本站引号两种都用），所以匹配的是整个标签且**要求标签体只能是空白**：内联 JSON 里提到这个文件名的地方不会被误删。另外补了一处基础设施级的认知：资产发现读的是**缓存页**而不是产物页（因为它要看 data 属性与 JSON 里的引用），所以删掉引用并不等于不拷文件——现在按同一张清单 `DEAD_AJAX_SCRIPTS` 剪掉，产物从 843 降到 842 个文件。

**14. 大图发 WebP，不发原站的 PNG/JPG。** 站主问“纯静态应该极快吧”，量出来发现静态描述的是服务器不是重量：首页要拉 327 个请求、15 MB 图。所以 `npm run images` 从**缓存页真正引用的**文件里取 ≥40 KB 的转 WebP（quality 82），构建器把引用改到 `.webp`。**同一张图，不是另一张图**——不重画、不裁、不改文件名里的原扩展名（而是后缀追加），所以一个旧书签指向的还是同一个画面。两次构建实测（把 manifest 临时移开跑一次、放回来跑一次）：**192.6 MB / 842 文件 → 143.9 MB / 844 文件**；本地 HTTP 实访 325–388 个请求，**404 为 0**，`Content-Type: image/webp`。两条门槛都是量过的而不是抄的：11 张转出来省不到 25%，就不转；样式表里**没有任何 ≥150 KB 图**（0 张），所以不动拷出去的 CSS。没跑 `npm run images` 时构建器一个字节不改（Pages 不构建，所以它永远不需要 `sharp`）。

一个必须记的形状：同一文件在一页里**同时**以百分号编码与原样中文两种拼法出现（实测产物：原样 6,206 次、编码 14,185 次），所以改写必须两拼法都命中——只按文件系统拼法匹配会静静漏掉整个 `srcset`，而当原图被剪掉时那就是一片图 404，而门禁如果只读属性列表（`src`/`href`）仍会全绿。

**15. 视频在播放前显示它自己的首帧。** 7 页（中英各 7）共 14 个 `<video>` 没有 `poster`，也没 `src`（源在 Woodmart 的 `data-lazy-load` 里），于是那整块就是一张黑。唯一诚实的候选帧只能从**视频自己**取（本机 `ffmpeg` 取第一帧 → `sharp` 缩到 800px 宽转 WebP），因为产品页的“特色图”14 页全等——都是同一张站内占位图 `62b9cc781cece.png`，拿它当 poster 等于给十四个不同产品贴同一张不相干的图，那比黑块更错。同时补上 `preload="none"`。poster 的名字由**源自己的拼法**把扩展名换掉得到（所以绝对域名与中文文件名都跟着源走），门禁则断言“每个源已转换的视频都写了 poster”并实测 14 个引用全部 `200 image/webp`。没有新增任何内容：那一帧本来就是视频的一部分。
