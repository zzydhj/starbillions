/**
 * Ingest: tftstar.com WordPress backup -> data/*.json
 *
 *   node tools/ingest/wp/index.mjs            write collections
 *   node tools/ingest/wp/index.mjs --dry      report only, write nothing
 *
 * Source of truth is the SQL dump, not the live site. The live site was already
 * failing on a database memory error when this started, so a backup is both the
 * only available input and the correct one: it carries the real relations rather
 * than what a rendered page happens to show.
 *
 * Like the Template ingest, this never runs during a build. The dump lives in
 * work/ (gitignored, decompressed from 24.4.22-tftstar/), and after the JSON is
 * written data/ owns the content.
 */
import { join } from 'node:path';
import { paths, root } from '../../lib/paths.js';
import { exists, readFile, walk, writeFile } from '../../lib/fs-utils.js';
import { readDump } from './sql-dump.js';
import { isPublished, toObjects } from './model.js';
import { extractCatalog } from './extract-catalog.js';

const DUMP = join(root, 'work/tftstar.sql');

const TABLES = ['wp_posts', 'wp_postmeta', 'wp_terms', 'wp_term_taxonomy', 'wp_term_relationships'];

const dry = process.argv.includes('--dry');

if (!exists(DUMP)) {
  console.error(`\n  ${DUMP} not found.`);
  console.error('  decompress the backup first:\n');
  console.error('    $src = (Get-ChildItem 24.4.22-tftstar\\*mysql_data.sql.gz).FullName');
  console.error('    $gz = New-Object IO.Compression.GzipStream([IO.File]::OpenRead($src), [IO.Compression.CompressionMode]::Decompress)');
  console.error('    $gz.CopyTo([IO.File]::Create("work\\tftstar.sql"))\n');
  process.exit(1);
}

const dump = readDump(DUMP, TABLES);
const posts = toObjects(dump, 'wp_posts').filter(isPublished);

// An attachment row's guid is an absolute URL. The file itself lives inside the
// site archive under wp-content/uploads/, so map guid -> uploads-relative path
// here, once, and let every consumer use the same value.
const attachments = toObjects(dump, 'wp_posts').filter((row) => row.post_type === 'attachment');
const catalog = extractCatalog(dump, attachments);

const pages = pick(posts, 'page');
const articles = pick(posts, 'post');

const collections = {
  products: catalog.products,
  categories: catalog.categories,
  attributes: catalog.attributes,
  pages,
  posts: articles,
};

console.log('\n  ingest WordPress -> data\n');
console.log(`  products      ${catalog.products.length}`);
console.log(`  categories    ${catalog.categories.length}`);
console.log(`  attributes    ${catalog.attributes.length} facets`);
console.log(`  pages         ${pages.length}`);
console.log(`  posts         ${articles.length}`);
console.log(`  attachments   ${attachments.length} (referenced ones are what matter)`);

const withImage = catalog.products.filter((product) => product.image).length;
console.log(`\n  products with a cover image: ${withImage}/${catalog.products.length}`);
if (withImage < catalog.products.length) {
  console.log('  the rest point at nothing; their cards will render text-only');
}

for (const [name, value] of Object.entries(collections)) {
  if (value.length === 0) throw new Error(`[wp] collection "${name}" came out empty`);
}

if (dry) {
  console.log('\n  --dry: nothing written\n');
  process.exit(0);
}

for (const [name, value] of Object.entries(collections)) {
  writeFile(join(paths.data, `wp-${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`  wrote data/wp-${name}.json`);
}

/**
 * Which uploads files the site actually references. Written out so the image
 * copy step can pull exactly these from the 401 MB archive instead of dragging
 * all 3219 files, most of which are builder-generated size variants.
 */
const referenced = new Set();
for (const product of catalog.products) addImage(referenced, product.image);
for (const page of pages) for (const url of page.images) addImage(referenced, url);
for (const article of articles) for (const url of article.images) addImage(referenced, url);

function addImage(set, guid) {
  if (!guid) return;
  const at = guid.indexOf('/wp-content/uploads/');
  if (at === -1) return;
  set.add(guid.slice(at + '/wp-content/uploads/'.length));
}

writeFile(
  join(root, 'work/referenced-images.json'),
  `${JSON.stringify([...referenced].sort(), null, 2)}\n`,
);
console.log(`\n  referenced uploads files: ${referenced.size} -> work/referenced-images.json`);

function pick(rows, type) {
  return rows
    .filter((row) => row.post_type === type)
    .map((row) => ({
      slug: row.post_name,
      title: row.post_title,
      summary: row.post_excerpt || null,
      body: row.post_content || null,
      // Elementor/Woodmart pages store their real content in meta and shortcodes;
      // post_content is what the classic editor authored. Both are kept so the
      // conversion step can see which kind it is looking at.
      images: [...new Set(imagesIn(row.post_content))],
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function imagesIn(html) {
  if (!html) return [];
  return [...String(html).matchAll(/src="(https?:\/\/[^"]+\/wp-content\/uploads\/[^"]+)"/g)].map(([, url]) => url);
}
