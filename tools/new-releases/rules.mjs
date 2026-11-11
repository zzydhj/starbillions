/**
 * New-release metadata extraction. Pure functions, no fs.
 *
 * The scanner reads one subfolder per product and has no structured authoring
 * behind it (unlike `data/wp-*.json`, which comes from the SQL dump). Everything
 * it knows comes from two text sources - the folder name and the PDF file names
 * inside it - so this file's job is to squeeze those two lines of ASCII/CJK as
 * far as they go, and to be honest when they do not go further.
 *
 * Every extractor returns `null` (or `[]`) rather than a guess. The build never
 * sees an invented resolution; the review CSV shows exactly which fields are
 * missing so the owner can either fill them in or accept the generic fallback.
 *
 * Two rules to keep:
 *   1. Never match a substring that could plausibly mean two things. `1024 600`
 *      in a file name is resolution; `1024600` in a model string is not. Only
 *      pairs that appear in `RESOLUTION_PAIRS` are accepted, and only when the
 *      digits are separated or form an unambiguous split.
 *   2. Do not import anything beyond Node builtins. The scanner is dev-only,
 *      but so is every other file under `tools/`, and adding a dependency for
 *      text matching is not what the shape of this repo is for.
 */

/** TFT panel resolutions this site actually ships. Extended as scan reports misses. */
const RESOLUTION_PAIRS = [
  [240, 240], [240, 280], [240, 320], [240, 240], [240, 960],
  [272, 480], [280, 360], [280, 760], [320, 240], [320, 320], [320, 480],
  [360, 360], [360, 480], [360, 640], [371, 371], [376, 376], [416, 416], [480, 272],
  [480, 320], [480, 360], [480, 480], [480, 640], [480, 800], [480, 854],
  [640, 480], [640, 960], [720, 720], [720, 1280], [720, 1440],
  [768, 1024], [800, 480], [800, 600], [800, 1280],
  [854, 480], [1024, 600], [1024, 768], [1080, 1080], [1080, 1920],
  [1280, 800], [1920, 1080],
];

/**
 * Diagonal-inch patterns, in preference order.
 *
 * Chinese writes the size in three shapes this site uses:
 *   `1.28寸`   short form, most common
 *   `2.7英寸`  full form (英寸), only appears in one folder name
 *   `十寸`     CJK numeral, one folder (十 = 10)
 * ASCII form covers `inch`/`inches`/`"`/`″` (the last two are typographic
 * double primes seen on some file names exported from CAD).
 *
 * The bare-number form (`2.4`) lives in `extractSize`'s folder-only fallback,
 * not in the pattern list, because the pattern needs `^…$` and the corpus the
 * scanner hands to the extractors is folder-name + every PDF file-name
 * concatenated - anchoring to end-of-string on that blob would never fire.
 */
const SIZE_PATTERNS = [
  /(\d+(?:\.\d+)?)\s*(?:英)?寸/,
  /(\d+(?:\.\d+)?)\s*(?:inch|inches|"|″)/i,
];

const CN_NUMERAL_SIZE = /^([一二三四五六七八九十]+)寸/;
const BARE_NUMBER_SIZE = /^(\d+(?:\.\d+)?)$/;

const CN_NUMERALS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/**
 * Shape keywords, matched against CJK and English together.
 *
 * Order matters: the extractor returns every hit in this order, and the title
 * builder takes the first one. So `旋钮屏` must come before `圆形` (a knob
 * panel is round *and* a knob, and "knob" is the buyer-relevant word), and
 * `正方形` must come before `方形` for the same reason. The deduplication below
 * exists because `方形` is a strict substring of `正方形` and would otherwise
 * fire on every square panel.
 */
const SHAPES = [
  { cn: '旋钮屏', en: 'knob', re: /旋钮|knob/i },
  { cn: '圆形', en: 'round', re: /圆形|round/i },
  { cn: '长条形', en: 'bar', re: /长条|条形|bar/i },
  { cn: '正方形', en: 'square', re: /正方形|square/i },
  { cn: '方形', en: 'rect', re: /方形/ },
  { cn: '双屏', en: 'dual', re: /双屏/ },
  { cn: '双通道/四通道', en: 'dual-quad', re: /双通道|四通道/ },
];

/** Broader shape absorbs its narrower sibling. `方形` is inside `正方形`. */
const SHAPE_SUBSUMES = { 方形: ['正方形'] };

/** Reverse index by Cn label, used by the compat module when it hands a shape
 * back to the record (the record stores only the Cn string to keep the JSON
 * readable, but `makeTitles` needs both forms). */
export const SHAPE_BY_CN = Object.fromEntries(
  SHAPES.map((shape) => [shape.cn, { cn: shape.cn, en: shape.en }]),
);

/** Panel chemistry, matched case-insensitively but returned in upper case. */
const PANELS = ['IPS', 'TN', 'VA', 'OLED', 'AMOLED'];

/** Signal standards the site ships. Order matters only for the review column. */
const INTERFACES = [
  { key: 'QSPI', re: /QSPI/i },
  { key: 'SPI', re: /\bSPI\b/i },
  { key: 'MIPI', re: /MIPI/i },
  { key: 'LVDS', re: /LVDS/i },
  { key: 'RGB', re: /RGB/i },
  { key: 'HDMI', re: /HDMI/i },
  { key: 'UART', re: /串口|UART/i },
  { key: 'I2C', re: /I2C/i },
  { key: 'DB9', re: /DB9/i },
];

/**
 * A signal standard's Chinese display name. The stored `key` is always the
 * ASCII form so English titles and CSV columns stay CJK-free; the zh title
 * builder swaps to this label when one exists. `UART` prints as `串口` in
 * Chinese because that is the term buyers actually search here, even though
 * the underlying standard is UART.
 */
export const INTERFACE_ZH = { UART: '串口' };

/**
 * Panel model number, as printed by the factory. `XBY` prefix, then alphanumerics,
 * dashes and dots, up to the first separator (whitespace, CJK, underscore).
 *
 * Dots inside the class are needed because some product codes literally
 * contain them - `XBY2.1寸` in a PDF file name is a valid model token, and a
 * stricter class missed it. To keep that relaxation from swallowing the
 * file-name extension (`.pdf`), the extractor strips a known trailing
 * extension after the match, which is where `FILE_EXT_SUFFIX` comes in.
 */
const MODEL = /XBY[A-Z0-9._-]+[A-Z0-9]/i;
const FILE_EXT_SUFFIX = /\.(?:PDF|JPE?G|PNG|GIF|BMP|MP4|MOV|WEBM|DWG|DOC|DOCX|XLS|XLSX)$/i;

/** Pin count as `40PIN`, `40 pin`, `40 pin`. */
const PINS = /(\d{1,3})\s*PIN/i;

/**
 * Voltage written as `3.3V` / `2.8V` / `5.0V`. The `[235]` class is deliberate:
 * the site's panels are 2.8-5.0 V logic. Widening to `[1-9]` starts picking up
 * model fragments like `T101` in `XBY-T101S130B-B2`.
 */
const VOLTAGE = /([235]\.\d)\s*V/i;

const TOUCH = [
  { cn: '电阻触摸', re: /RTP|电阻触摸|resistive/i },
  { cn: '电容触摸', re: /电容|PCAP|Capacitive|CTP/i },
  { cn: '触摸', re: /触摸|touch/i },
];

/**
 * Pick the size in inches out of a text blob.
 *
 * `corpus` is scanned with the loose patterns above; `folderName` is tried
 * separately against two anchored forms (pure CJK numeral like `十寸`, pure
 * number like `2.4`), because those must not fire on any digits inside a
 * longer filename.
 */
export function extractSize(corpus, folderName = null) {
  for (const re of SIZE_PATTERNS) {
    const m = re.exec(corpus);
    if (m) return Number.parseFloat(m[1]);
  }
  if (folderName === null) return null;

  const cn = CN_NUMERAL_SIZE.exec(folderName);
  if (cn) return cnNumeral(cn[1]);

  const num = BARE_NUMBER_SIZE.exec(folderName);
  if (num) return Number.parseFloat(num[1]);

  return null;
}

function cnNumeral(text) {
  if (text === '十') return 10;
  const tens = text.indexOf('十');
  if (tens === -1) {
    const ones = CN_NUMERALS[text];
    return ones ?? null;
  }
  const head = tens === 0 ? 1 : CN_NUMERALS[text.slice(0, tens)];
  const tail = tens === text.length - 1 ? 0 : CN_NUMERALS[text.slice(tens + 1)];
  if (head === undefined || tail === undefined) return null;
  return head * 10 + tail;
}

/** First `XBY…` model token in the text, cleaned of trailing file-name noise.
 * Honours `MODEL_OVERRIDES` when the folder is listed there. */
export function extractModel(text, folder = null) {
  if (folder && MODEL_OVERRIDES[folder]) return MODEL_OVERRIDES[folder];
  const m = MODEL.exec(text);
  if (!m) return null;
  return m[0].toUpperCase().replace(FILE_EXT_SUFFIX, '');
}

/**
 * Folder-specific corrections the generic extractor could not know.
 *
 * `1.6寸圆形旋钮` writes its PDF as `XBY-4040 016A-QD-V01矮款旋钮屏规格书(1).pdf`:
 * `XBY-4040` names the outline dimension (40x40 mm) and the actual SKU is
 * `016A-QD-V01` (016 = 1.6", QD = 旋钮, V01 = version). The generic regex
 * matches a single token and stops at the space, so it picked the dimension
 * code. Joining the two is what the source really says, so the entry below
 * writes the joined form. It is one row, deliberately hard-coded, because a
 * second folder with the same pattern would still need a human look at it
 * before the rule generalises.
 */
export const MODEL_OVERRIDES = {
  '1.6寸圆形旋钮': 'XBY-4040 016A-QD-V01',
};

/**
 * Folders the scanner reports on but the render step will not build.
 *
 * Two shapes are excluded:
 *   - multi-size kits whose folder name spans several panels
 *     (`4.3寸-10.1寸显示屏`, `4.3寸-8寸HDMI套件`); these are a category,
 *     not a product, and a page that says "4.3 寸" while showing 4.3 through
 *     10.1 photos is a bait-and-switch. If the owner later wants them back,
 *     they become their own category pages rather than product pages.
 *   - spec-sheet collection folders (`旋钮屏规格书`) whose PDFs are already
 *     covered by the individual knob屏 rows they duplicate.
 *
 * Skipping is not deleting: the row stays in `data/new-products.json` so the
 * CSV keeps a full 67-line history, and the render step filters on `skip`.
 */
export const SKIP_FOLDERS = new Set([
  '4.3寸-10.1寸显示屏',
  '4.3寸-8寸HDMI套件',
  '旋钮屏规格书',
]);

/** Shape labels present in the text, most specific first, subsumed drops. */
export function extractShapes(text) {
  const hits = SHAPES.filter(({ re }) => re.test(text));
  const kept = [];
  for (const shape of hits) {
    const covered = SHAPE_SUBSUMES[shape.cn];
    if (covered && covered.some((cn) => hits.some((h) => h.cn === cn))) continue;
    kept.push(shape);
  }
  return kept;
}

/** The panel technology (IPS / TN / …) if the text names one. */
export function extractPanel(text) {
  for (const p of PANELS) {
    if (new RegExp(`\\b${p}\\b`, 'i').test(text)) return p;
  }
  return null;
}

/** Every signal interface named in the text, de-duplicated in declaration order. */
export function extractInterfaces(text) {
  const out = [];
  for (const { key, re } of INTERFACES) {
    if (re.test(text) && !out.includes(key)) out.push(key);
  }
  return out;
}

/** FPC pin count as an integer, or null. */
export function extractPins(text) {
  const m = PINS.exec(text);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  // Sanity band; anything outside is a mistaken capture.
  return n >= 10 && n <= 100 ? n : null;
}

/** Supply voltage as a plain string like "3.3" (unit added at render time). */
export function extractVoltage(text) {
  const m = VOLTAGE.exec(text);
  return m ? m[1] : null;
}

/** Touch technology, if named. First match wins; resistive before capacitive. */
export function extractTouch(text) {
  for (const { cn, re } of TOUCH) {
    if (re.test(text)) return cn;
  }
  return null;
}

/**
 * Resolution as "WIDTH×HEIGHT", or null.
 *
 * Three shapes are supported:
 *   `1024x600`, `1024×600`, `1024 600`  - separated pair, easy.
 *   `1024600`, `8001280`, `480480`       - concatenated pair, only if the split
 *                                          produces a known resolution.
 *   `1280.800` (typo seen in one PDF)    - separated by a dot.
 *
 * The concatenated form has to go through the pair table, because `240960` could
 * be `240×960` (bar type) or `24×0960` (nonsense), and the split point is not
 * obvious without the reference list.
 */
export function extractResolution(text) {
  // Pattern A: two digit groups separated by whitespace or a symbol (`1024 600`,
  // `1024×600`, `480*272`, `240 x 320`).
  const separated = /(\d{3,4})\s*[x×.*\-\s]\s*(\d{3,4})/.exec(text);
  if (separated) {
    const pair = matchPair(separated[1], separated[2]);
    if (pair) return pair;
  }

  // Pattern B: the signal name intrudes between the digits and the separator,
  // which is how the existing 34 products write their attribute table
  // (`800RGB×480`, `1280(RGB)*800`, `480*800MIPI/RGB`, `640RGB×480`). Without
  // this form, the compat library reads every existing resolution as null and
  // there is nothing to fill into the 50 folders that carry no PDF.
  const withLetters = /(\d{3,4})[^\d]{1,10}[x×.*\-\s][^\d]{0,10}(\d{3,4})/.exec(text);
  if (withLetters) {
    const pair = matchPair(withLetters[1], withLetters[2]);
    if (pair) return pair;
  }

  // Pattern C: concatenated digits with no separator, `480640`, `1024600`,
  // `8001280`. Only accepted when a split at 3/3 or 4/3 hits a known pair,
  // so `24×0960` nonsense is rejected by the pair table.
  for (const m of text.matchAll(/(\d{6,7})(?!\d)/g)) {
    const digits = m[1];
    for (let cut = 3; cut <= 4; cut++) {
      if (cut >= digits.length) break;
      const pair = matchPair(digits.slice(0, cut), digits.slice(cut));
      if (pair) return pair;
    }
  }

  // Pattern D: a round folder named with a single number after the shape
  // word, like `5寸圆形1080 新图`. A round panel has width = height, so the
  // one number stands for both sides. The 15-character gap keeps this from
  // swallowing `XBY040R` in a nearby PDF name - if a real three-digit token
  // appears that far away it is almost never the resolution.
  const round = /(?:圆形|round)[^\d]{0,15}(\d{3,4})(?!\d)/i.exec(text);
  if (round) {
    const pair = matchPair(round[1], round[1]);
    if (pair) return pair;
  }

  return null;
}

function matchPair(a, b) {
  const an = Number.parseInt(a, 10);
  const bn = Number.parseInt(b, 10);
  const hit = RESOLUTION_PAIRS.find(
    ([w, h]) => (w === an && h === bn) || (w === bn && h === an),
  );
  // Return in the order the text wrote them, not in the pair table's canonical
  // order: `4.3寸480x272` is a landscape panel and the source knows it, so
  // rewriting to `272×480` (the table's shape) invents a portrait that was
  // never named. The table is used only to reject nonsense splits like
  // `24×0960`, not to reorder what the file actually said.
  return hit ? `${an}×${bn}` : null;
}

/**
 * URL slug for one product.
 *
 * Two sources, in order: ASCII fragments already in the folder name (so
 * `5inch 800480 IPS RGB 40PIN` becomes `5inch-800480-ips-rgb-40pin`), or a
 * generated `size-shape` hint for pure-CJK folders. The `NN-` prefix is the
 * alphabetical index of the folder, and it is what makes the slug stable when
 * the folder name is edited: rerunning the scan produces the same URL as long
 * as the folder still sorts to the same position.
 */
export function makeSlug(folder, index) {
  const nn = String(index).padStart(2, '0');
  const ascii = folder
    .replace(/[^\x20-\x7e]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  if (ascii.length >= 4 && /\d/.test(ascii)) return `new-${nn}-${ascii}`;

  const size = extractSize(folder, folder);
  const shape = extractShapes(folder)[0];
  const parts = [
    size ? `${String(size).replace('.', '-')}-inch` : null,
    shape ? shape.en : null,
  ].filter(Boolean);

  return `new-${nn}-${parts.join('-') || 'item'}`;
}

/**
 * Human-facing title assembled from the extracted fields.
 *
 * Chinese form is `Starbillions <尺寸> <形状> <接口> <型号>`; English drops to
 * `Starbillions <size>" <panel> <interface> display <model>`. Anything missing
 * drops out of the string rather than being filled with a placeholder, so the
 * title never says something the extraction did not actually see.
 *
 * If a folder yields literally nothing (no size, no shape, no model), the title
 * falls back to the folder name itself, still prefixed by the brand. That way
 * the reviewer's CSV row is obviously wrong rather than silently generic.
 */
export function makeTitles({ folder, sizeInch, shapes, interfaces, panel, resolution, model }) {
  const shapeCn = shapes[0]?.cn ?? null;
  const ifaceEn = interfaces[0] ?? null;
  const ifaceCn = ifaceEn ? (INTERFACE_ZH[ifaceEn] ?? ifaceEn) : null;

  const zhParts = ['Starbillions'];
  if (sizeInch !== null) zhParts.push(`${sizeInch}寸`);
  if (shapeCn) zhParts.push(shapeCn);
  if (panel) zhParts.push(panel);
  if (resolution) zhParts.push(resolution);
  if (ifaceCn) zhParts.push(ifaceCn);
  if (model) zhParts.push(model);
  if (zhParts.length === 1) zhParts.push(folder);

  const enParts = ['Starbillions'];
  if (sizeInch !== null) enParts.push(`${sizeInch}"`);
  if (panel) enParts.push(panel);
  if (resolution) enParts.push(resolution);
  if (ifaceEn) enParts.push(ifaceEn);
  if (shapes[0]) enParts.push(shapes[0].en);
  enParts.push('display');
  if (model) enParts.push(model);
  if (enParts.length <= 2) enParts.push(folder);

  return { zh: zhParts.join(' '), en: enParts.filter(Boolean).join(' ') };
}
