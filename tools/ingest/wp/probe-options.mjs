/**
 * The site's own settings, read from the dump.
 *
 *   node tools/ingest/wp/probe-options.mjs
 *
 * Needed to run the site locally: the permalink structure decides the URL shape
 * the crawler must reproduce, `trp_*` decides how the two languages are
 * addressed, and a blank .htaccess means nothing in the archive states the
 * rewrite rules — so the database is the only place left to ask.
 */
import { readDump } from './sql-dump.js';
import { toObjects } from './model.js';

const dump = readDump('work/tftstar.sql', ['wp_options']);
const rows = toObjects(dump, 'wp_options');

const WANTED = [
  'siteurl', 'home', 'permalink_structure', 'category_base', 'tag_base',
  'stylesheet', 'template', 'show_on_front', 'page_on_front', 'page_for_posts',
  'woocommerce_shop_page_id', 'woocommerce_cart_page_id', 'woocommerce_checkout_page_id',
  'woocommerce_myaccount_page_id', 'trp_languages', 'trp_enabled_languages',
  'trp_force_admin_language', 'trp_disable_title_rewrite', 'trp_translatedSlugs_en_us',
  'active_plugins', 'blogname', 'blogdescription', 'gmt_offset', 'time_format',
  'wd_theme_options', 'woodmart_options',
];

for (const name of WANTED) {
  const row = rows.find((option) => option.option_name === name);
  if (!row) {
    console.log(`  ${name.padEnd(30)} -ABSENT-`);
    continue;
  }
  const value = String(row.option_value);
  console.log(`  ${name.padEnd(30)} ${value.length > 300 ? value.slice(0, 300) + ' …(' + value.length + ')' : value}`);
}

console.log('\n  trp / translatepress option names present\n');
for (const row of rows) {
  if (/^trp/i.test(String(row.option_name))) console.log(`    ${row.option_name}`);
}

console.log('\n  rewrite rules: sample of keys\n');
const rewrite = rows.find((row) => row.option_name === 'rewrite_rules');
if (rewrite) {
  const keys = [...String(rewrite.option_value).matchAll(/\[([^\]]+)\]/g)].map(([, key]) => key);
  console.log(`    ${keys.length} rules, first 12: ${keys.slice(0, 12).join(' | ')}`);
}
