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
npm test            URL 改写逻辑的单元测试
npm run preview     本地起 dist/
npm run deploy      verify 后用 wrangler 发布到 Cloudflare Pages
```

`node tools/mirror.mjs --site-origin https://your-domain.com` 换目标域名；`--dry` 只统计不写盘。

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
