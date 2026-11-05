/**
 * Single source of truth for every path the pipeline touches.
 * Nothing else in tools/ should hardcode directory names.
 *
 * The layout reflects what the project is now: a mirror built from the site's own
 * backup. There is no src/ authored tree any more - the pages come from the WP
 * Rocket cache inside work/wp/, so the only hand-maintained content is data/, the
 * structured rows extracted from the database dump.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// This file lives at <root>/tools/lib/paths.js, so the project root is two levels
// up. One level lands inside tools/, and every path below would then point at a
// directory that does not exist.
const thisDir = dirname(fileURLToPath(import.meta.url));

export const root = resolve(thisDir, '..', '..');

export const paths = {
  root,

  /** Output tree, deployed as-is to Cloudflare Pages. */
  dist: resolve(root, 'dist'),

  /** Files that belong at the Pages root without being generated: _headers, robots.txt. */
  public: resolve(root, 'public'),

  /** Structured content extracted from the database dump. Checked in; the mirror reads it. */
  data: resolve(root, 'data'),

  /**
   * Scratch, gitignored, disposable: the unpacked 1 GB docroot, the decompressed
   * SQL dump, and the probe reports. Everything here is derived from the backup,
   * so deleting it costs nothing but time.
   */
  work: resolve(root, 'work'),

  /** The backup as delivered: a SQL archive and a site tar.gz. Read-only input. */
  backup: resolve(root, '24.4.22-tftstar'),

  sql: resolve(root, 'work/tftstar.sql'),

  /** Unpacked web root of the site. Asset paths in the cached pages resolve against this. */
  docroot: resolve(root, 'work/wp/tftstar.com'),

  /** WP Rocket's rendered HTML, keyed by URL path. The pages the mirror is built from. */
  pageCache: resolve(root, 'work/wp/tftstar.com/wp-content/cache/wp-rocket/tftstar.com'),
};
