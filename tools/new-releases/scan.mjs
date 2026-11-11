/**
 * tools/new-releases/scan.mjs
 *
 * Reads one subfolder per new-release product under `新品发布/`, extracts the
 * metadata that is actually present in the folder name and PDF file names, and
 * writes two things:
 *
 *   data/new-products.json       the structured record, checked in, read by the
 *                                render step and the deployment gate.
 *   work/new-products-review.csv a human-facing table for the owner to eyeball
 *                                before pages are generated: which fields came
 *                                out, which did not, what the title looks like,
 *                                and which images/videos/PDFs the record picks up.
 *
 * Never runs in a build. Pages does not need it - `mirror` reads data/new-products.json
 * directly once it exists - so this is the wp:data equivalent for the new-release
 * pipeline: an authoring-time tool on the owner's machine, whose output is the
 * committed source of truth.
 *
 * The 新品发布 folder itself is gitignored (573 MB of inputs). Losing it does not
 * lose any information that data/new-products.json does not already carry.
 *
 *   node tools/new-releases/scan.mjs
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../lib/paths.js';
import { exists, writeFile } from '../lib/fs-utils.js';
import {
  extractInterfaces,
  extractModel,
  extractPanel,
  extractPins,
  extractResolution,
  extractShapes,
  extractSize,
  extractTouch,
  extractVoltage,
  makeSlug,
  makeTitles,
  SHAPE_BY_CN,
  SKIP_FOLDERS,
} from './rules.mjs';
import { applyCompat, buildLibrary, loadExistingCompat } from './compat.mjs';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const PDF_EXT = new Set(['.pdf']);
const CAD_EXT = new Set(['.dwg', '.dxf', '.step', '.stp']);

if (!exists(paths.newReleases)) {
  console.error(`\n  new-release source folder not found: ${paths.newReleases}`);
  console.error('  restore it from the owner archive before running this scan.\n');
  process.exit(1);
}

const folders = readdirSync(paths.newReleases, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort(compareFolder);

const products = folders.map((folder, index) => scan(folder, index + 1));

// Compatibility pass: fill missing fields for the 50 folders without a PDF
// from the 34 products the site already publishes, plus from the new-release
// rows that did yield a value. Titles are regenerated afterwards so a filled
// resolution shows up on the page without the owner editing anything.
//
// The library expects a flat `{ sizeInch, resolution, interfaces, panel,
// shapes }` shape, because that is what `loadExistingCompat()` emits from
// the SQL-derived product rows. New-release records nest the same five
// fields under `specs`, so they are flattened here rather than forcing the
// library to know two shapes.
const newReleaseSources = products
  .filter((p) => !p.skip)
  .map((p) => ({
    sizeInch: p.specs.sizeInch,
    resolution: p.specs.resolution,
    interfaces: p.specs.interfaces,
    panel: p.specs.panel,
    shapes: p.specs.shapes,
  }));
const library = buildLibrary([...loadExistingCompat(), ...newReleaseSources]);
const compatTouched = applyCompat(products, library);
for (const record of products) {
  if (record.compatFilled?.length) {
    record.title = makeTitles({
      folder: record.folder,
      sizeInch: record.specs.sizeInch,
      shapes: record.specs.shapes.map((cn) => SHAPE_BY_CN[cn]).filter(Boolean),
      interfaces: record.specs.interfaces,
      panel: record.specs.panel,
      resolution: record.specs.resolution,
      model: record.specs.model,
    });
  }
}

writeFile(join(paths.data, 'new-products.json'), `${JSON.stringify(products, null, 2)}\n`);
writeFile(join(paths.work, 'new-products-review.csv'), toCsv(products));

report(products);

/**
 * Folders whose name begins with a number are sorted numerically on that leading
 * size, so "2.8寸" precedes "10.1寸". Non-numeric folders sort by name after all
 * numeric ones, which puts `串口板` and `旋钮屏规格书` at the bottom and keeps
 * the sequence a human would read.
 */
function compareFolder(a, b) {
  const na = /^\d+(?:\.\d+)?/.exec(a)?.[0];
  const nb = /^\d+(?:\.\d+)?/.exec(b)?.[0];
  if (na && nb) return Number.parseFloat(na) - Number.parseFloat(nb) || a.localeCompare(b, 'zh');
  if (na) return -1;
  if (nb) return 1;
  return a.localeCompare(b, 'zh');
}

function scan(folder, index) {
  const dir = join(paths.newReleases, folder);
  const files = listFiles(dir);

  const images = files.filter((f) => IMAGE_EXT.has(f.ext));
  const videos = files.filter((f) => VIDEO_EXT.has(f.ext));
  const pdfs = files.filter((f) => f.ext === '.pdf');
  const extras = files.filter((f) => CAD_EXT.has(f.ext));

  // The corpus for text extraction is the folder name plus every PDF file name.
  // Folder name is first so its fields take precedence when both name a value;
  // PDF names are joined in sorted order so extraction is deterministic.
  const corpus = [folder, ...pdfs.map((f) => f.name).sort()].join('  ');

  const sizeInch = extractSize(corpus, folder);
  const shapes = extractShapes(corpus);
  const panel = extractPanel(corpus);
  const interfaces = extractInterfaces(corpus);
  const resolution = extractResolution(corpus);
  const pins = extractPins(corpus);
  const voltage = extractVoltage(corpus);
  const touch = extractTouch(corpus);
  const model = extractModel(corpus, folder);

  const slug = makeSlug(folder, index);
  const titles = makeTitles({ folder, sizeInch, shapes, interfaces, panel, resolution, model });

  return {
    index,
    folder,
    slug,
    skip: SKIP_FOLDERS.has(folder),
    url: `/product/${slug}/`,
    urlEn: `/en/product/${slug}/`,
    title: { zh: titles.zh, en: titles.en },
    specs: {
      sizeInch,
      shapes: shapes.map((s) => s.cn),
      panel,
      resolution,
      interfaces,
      pins,
      voltage,
      touch,
      model,
    },
    media: {
      images: images.map(toMedia).sort(bySizeDesc),
      videos: videos.map(toMedia).sort(bySizeDesc),
      pdfs: pdfs.map(toMedia),
      extras: extras.map(toMedia),
    },
    counts: {
      images: images.length,
      videos: videos.length,
      pdfs: pdfs.length,
      extras: extras.length,
    },
    gaps: fieldGaps({ sizeInch, shapes, panel, resolution, interfaces, model, pdfs }),
  };
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const abs = join(dir, entry.name);
      const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
      return { name: entry.name, abs, ext, size: statSync(abs).size };
    });
}

function toMedia(f) {
  return { name: f.name, ext: f.ext, bytes: f.size };
}

function bySizeDesc(a, b) {
  return b.bytes - a.bytes;
}

/** Which fields the extractor could not fill from folder + PDF names. */
function fieldGaps(record) {
  const gaps = [];
  if (record.sizeInch === null) gaps.push('sizeInch');
  if (record.shapes.length === 0) gaps.push('shape');
  if (record.panel === null) gaps.push('panel');
  if (record.resolution === null) gaps.push('resolution');
  if (record.interfaces.length === 0) gaps.push('interfaces');
  if (record.model === null) gaps.push('model');
  if (record.pdfs.length === 0) gaps.push('pdf');
  return gaps;
}

/**
 * The reviewer's sheet. One row per product, fields laid out so the eye can
 * scan a column of the same kind. CSV because it opens in Excel directly and
 * the owner can edit it; the scanner is idempotent so a hand edit here only
 * needs to be reflected back into the JSON after we agree on the diff.
 */
function toCsv(products) {
  const header = [
    'index', 'folder', 'slug', 'skip', 'title-zh', 'title-en',
    'sizeInch', 'shape', 'panel', 'resolution', 'interfaces',
    'pins', 'voltage', 'touch', 'model',
    'images', 'videos', 'pdfs', 'compatFilled', 'gaps',
  ];
  const rows = products.map((p) => [
    p.index,
    p.folder,
    p.slug,
    p.skip ? 'skip' : '',
    p.title.zh,
    p.title.en,
    p.specs.sizeInch ?? '',
    p.specs.shapes.join('|'),
    p.specs.panel ?? '',
    p.specs.resolution ?? '',
    p.specs.interfaces.join('|'),
    p.specs.pins ?? '',
    p.specs.voltage ?? '',
    p.specs.touch ?? '',
    p.specs.model ?? '',
    p.counts.images,
    p.counts.videos,
    p.counts.pdfs,
    p.compatFilled?.join('|') ?? '',
    p.gaps.join('|'),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function report(products) {
  const skipped = products.filter((p) => p.skip);
  const built = products.filter((p) => !p.skip);

  console.log(`\n  new-release scan -> data/new-products.json`
    + `  (${built.length} built, ${skipped.length} skipped, ${products.length} total)\n`);

  const totals = {
    images: 0, videos: 0, pdfs: 0,
    withModel: 0, withResolution: 0, withPanel: 0, withInterface: 0,
    withSize: 0, withTouch: 0, noPdf: 0, compatFilled: 0,
  };
  const gapBuckets = new Map();

  for (const p of built) {
    totals.images += p.counts.images;
    totals.videos += p.counts.videos;
    totals.pdfs += p.counts.pdfs;
    if (p.specs.model) totals.withModel += 1;
    if (p.specs.resolution) totals.withResolution += 1;
    if (p.specs.panel) totals.withPanel += 1;
    if (p.specs.interfaces.length) totals.withInterface += 1;
    if (p.specs.sizeInch !== null) totals.withSize += 1;
    if (p.specs.touch) totals.withTouch += 1;
    if (p.counts.pdfs === 0) totals.noPdf += 1;
    if (p.compatFilled?.length) totals.compatFilled += 1;

    for (const g of p.gaps) gapBuckets.set(g, (gapBuckets.get(g) ?? 0) + 1);
  }

  console.log(`  media      images ${totals.images}, videos ${totals.videos}, pdfs ${totals.pdfs}`);
  console.log(`  extracted  size ${totals.withSize}, model ${totals.withModel}, resolution ${totals.withResolution},`);
  console.log(`             panel ${totals.withPanel}, interface ${totals.withInterface}, touch ${totals.withTouch}`);
  console.log(`  filled by compat library: ${totals.compatFilled} rows`);
  console.log(`  folders without a spec PDF: ${totals.noPdf}`);

  console.log('\n  gap tally (before compat):');
  const sorted = [...gapBuckets.entries()].sort((a, b) => b[1] - a[1]);
  for (const [field, count] of sorted) {
    console.log(`    ${field.padEnd(12)} ${count}`);
  }

  if (skipped.length > 0) {
    console.log('\n  skipped rows:');
    for (const p of skipped) console.log(`    ${String(p.index).padStart(2)}  ${p.folder}`);
  }

  console.log('\n  full review sheet: work/new-products-review.csv');
  console.log(`  structured source of truth: data/new-products.json\n`);
}
