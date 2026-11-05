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

---

## 三、外部依赖（部署后会打不开或变慢）

镜像保留了原站全部外链，未擅自改动：

| 引用位置 | 域名 | 问题 |
| --- | --- | --- |
| 3 个 `<link>` 字体 | `fonts.googleapis.com` / `fonts.gstatic.com` | 中国大陆无法访问，字体退化到 Arial |
| 首页地图 `<iframe>` | `maps.google.com` | 大陆打不开，该区域空白 |
| 首页 Elementor 横幅背景图 | `starbillions.cn/wp-content/uploads/2023-11-10001*.png` | 证书 `ERR_CERT_COMMON_NAME_INVALID`，且该文件在本备份里不存在 → 横幅无背景 |
| 手机端底部工具栏 | `starbillions.savetime.work` | **每页 3 项，标签全是字面 `123`，3 项链接全指向建站期临时域名**（全站 725 处，217/217 页）。数据来自 Woodmart 主题选项“Bottom toolbar”，不是镜像造成。只有第 1 项有图标（`uploads/2023/11/phone.svg`），第 2、3 项图标容器为空 |

**建议**：字体改为自托管（备份里 `wp-content/uploads/` 有 google-fonts 缓存目录可考虑启用）、地图换高德/百度静态图或直接删掉 iframe、两处残留域名替换为正式域名。

底部工具栏那一行补一句：正确的修法是在 WordPress 后台主题选项里改标签与链接（改成电话 / WhatsApp / 联系我们），因为在镜像里改会在下次重建时被洗掉。站主 2026-11-05 选择暂不动它，只先处理了产品页询盘按钮（见 README“与原站不同的两处”）。

---

## 四、演示内容未替换

- 博客 8 篇为 Woodmart 主题示例文章（"Minimalist Japanese Inspired Furniture"、"New Home Decor from John Doerson" 等），与显示屏业务无关。中英各一份，共 16 页。
- Instagram 链接指向 `instagram.com/ozdesignfurniture`（主题演示账号，全站约 180 处）。

---

## 五、结构性缺口（镜像已尽力，但源数据不全）

### 1. 104 个链接目标原站从未渲染过

`wp-content/cache/wp-rocket/` 只存**有人访问过**的页面。归档页、标签页、搜索结果页、部分分类分页没被缓存，镜像里指向它们的链接会落到 `404.html`。当前 104 个不同目标，明细见 `work/mirror-report.json` 的 `uncachedLinkTargets` 字段。

### 2. 博客文章共 16 页（中英各 8），全部是演示内容

镜像产物里博客位于 `/2021/08/26/<slug>/` 与 `/en/2021/08/26/<slug>/`。已核实三者一致：页面 `canonical`、镜像目录结构、数据库当前 permalink `/%year%/%monthnum%/%day%/%postname%/` **都是同一形式**，所以不存在"改过固定链接导致旧链接 404"的问题，`_redirects` 不需要为博客加任何映射。（早期我按一份探测输出的横杠式路径写下过相反结论，那是错的，已用产物实测纠正。）

要处理的只是内容本身：这 8 篇文章是 Woodmart 主题示例（家具、家居装饰、亚特兰大住宅…），与显示屏业务无关，建议删除或换成真实内容。

### 3. 购物车、结算、登录、评论提交已按你的决定移除

静态主机无法承载，镜像删除了这些链接的属性（按钮外观保留，点击无动作）。共 2106 处。同时 `admin-ajax.php`、`wp-json/*` 请求会 404，`chaty-pro` 插件的 error 回调引用了未定义函数 `monitorErrorLog`，会在控制台报一条 error —— 那是插件自身缺陷，只在动态端点缺失时暴露。

### 4. WP Rocket 的手机版缓存其实没生效

217 个页面里 **214 个**的桌面版与手机版缓存文件**字节数完全相同**，只有 3 个页面（`/产品中心/page/2`、`/page/3` 等分页）仅存在手机版。说明原站的"独立移动端缓存"开关实质没产生差异。镜像统一取桌面版；静态主机也无法按 User-Agent 分发。

---

## 六、YITH 目录模式（说明，非缺陷）

产品页**没有价格和"加入购物车"按钮**，这是原站启用 `yith-woocommerce-catalog-mode-premium` 的设计（纯展示目录），不是复刻遗漏。
