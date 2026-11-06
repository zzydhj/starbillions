# starbillions.com — tftstar.com 的静态复刻

原站是 WordPress + WooCommerce + Woodmart + Elementor + TranslatePress 的定制显示屏（TFT，薄膜晶体管）厂商站，中英双语。本仓库把它**原样复刻**成纯静态站点，部署到 Cloudflare Pages。

关键事实：复刻的输入不是重建，而是**原站自己的产物**。备份 `24.4.22-tftstar/` 里有 `wp-content/cache/wp-rocket/` —— WP Rocket 的页面渲染缓存，存的是 PHP 执行**之后**的完整文档（217 页，含主题 header/footer、双语版本）。因此不需要跑 PHP 或 MySQL 就能得到 1:1 结果。

零运行时依赖，只用 Node 内置模块（要求 Node ≥ 20）。

## 命令

```
npm run wp:data     备份的 SQL dump  -> data/wp-*.json（结构化内容）
npm run mirror      页面缓存 + 归档资源 -> dist/
npm run check       校验产物（部署门禁，失败退出码 1）
npm run verify      mirror + check
npm test            URL 改写与内容改动的单元测试
npm run preview     本地起 dist/
```

没有 `deploy` 脚本：发布靠推到 GitHub，Pages 从仓库取产物（见下）。

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

## 校验器断言什么

`npm run check` 不只是"构建成功了"，它断言：

- 页面里不残留旧域名引用；同源资源**不得**以绝对 URL 出现
- 每个被引用的资源都能在 `dist/` 里解析到（未缓存的**页面**目标只报告、不算失败，因为那是原站从未渲染，不是构建错误）
- **引用数量不得凭空减少**：与源缓存逐项对数（延迟脚本源、样式表 `href`、懒加载图源），源计数为 0 视为断言本身失效而非通过
- 拷贝出去的 CSS 内部不含旧域名
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

## 与原站不同的九处（均为有意）

复刻之外，站主明确要求过、或原站自身写错而必须偏离的共九处。它们全部集中在 `tools/lib/site-links.js` 与 `tools/ingest/wp/staticize.js`（偏好只写一份，构建器与门禁读同一处）：

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

机制上只有一张清单（`staticize.js` 的 `OWNER_REMOVED_SECTIONS` + `isOwnerRemoved`），它**同时**决定“不构建哪些页”和“`isExcluded` 摘掉哪些链接”，所以两半不可能不一致；页头的 博客 / Portfolio 两个菜单项由 `removeOwnerMenuItems` 在 URL 改写**之前**整块 `li` 摘掉（在那之后 href 已没了，认不出来），带死链的子树一起走、自己链接还活着的父项只摘死子项。产物：137 页（原 217）、754 个文件、190 MB，菜单剩 4 项（首页 / 产品中心 / 关于我们 / 联系我们），门禁断言“无文件、无链接、无空标签、留下的菜单确实是这四个”。

一个必须记住的坑：文章 URL 的真实形态是 `/2021/08/26/slug/`（固定链接是 `/%year%/%monthnum%/%day%/%postname%/`，缓存目录层级就是证据），而我第一版规则写成了 `/2021-08-26/slug/`。**控制台与编辑器会把这两种写法渲染成同一串**，所以代码看着对、测试也绿（测试数据是我按同一个误解写的），却一页都没删掉。判定路径形态要用 `split('/')` 看分段，不要看打印出来的字符串。
