/**
 * Compatibility library for the new-release scanner.
 *
 * 50 of the 67 new-release folders carry no PDF, so most fields come out
 * null from rules.mjs. Rather than leave the page blank or invent a number,
 * this module fills from what the site already published: the 34 products in
 * `data/wp-products.json`, plus the new-release folders that did yield a
 * spec. The rule is exact size match (1.28" fills 1.28", not 1.3"), and the
 * fill only fires when the source rows agree on the value or one value is
 * clearly dominant. Ambiguity leaves the field alone.
 *
 * This is deliberately narrow, because a spec table on a product page is a
 * factual claim. Filling `resolution = 480×272` into a 4.3" panel whose three
 * existing 4.3" SKUs are all 480×272 is a defensible inference; filling into
 * a 3.5" panel whose existing SKUs are 320×240, 320×480 and 640×480 is a
 * coin flip and would print something a buyer could later hold us to.
 *
 * Fills are recorded on each product as `compatFilled: [field, ...]` so the
 * review CSV and the gate both know which cells came from the folder itself
 * and which came from the library. A page with no `compatFilled` is fully
 * authored by what the folder carried.
 */
import { join } from 'node:path';
import { exists, readJson } from '../lib/fs-utils.js';
import { paths } from '../lib/paths.js';
import {
  extractInterfaces,
  extractPanel,
  extractResolution,
  extractShapes,
} from './rules.mjs';

/** Post-parse regexes for the shape of the values WordPress wrote. */
const SIZE_IN_TITLE = /(\d+(?:\.\d+)?)/;
const RES_LABEL = /分辨率|resolution/i;
const IFACE_LABEL = /连接方式|interface|signal/i;
const PANEL_LABEL = /显示模式|观看方向|viewing|panel/i;

/**
 * The 34 products the site already ships, in a form the new-release scan can
 * consult. Empty when `wp-products.json` is missing (e.g. a fresh checkout
 * before `npm run wp:data` has been run); the scan then falls back to filling
 * only from its own confident rows.
 */
export function loadExistingCompat() {
  const file = join(paths.data, 'wp-products.json');
  if (!exists(file)) return [];

  const rows = readJson(file);
  return rows
    .map((product) => toCompatRow(product))
    .filter((row) => row !== null);
}

function toCompatRow(product) {
  const sizeMatch = SIZE_IN_TITLE.exec(product.title ?? '');
  if (!sizeMatch) return null;
  const sizeInch = Number.parseFloat(sizeMatch[1]);
  if (!(sizeInch >= 0.5 && sizeInch <= 20)) return null;

  const attrs = product.attributes ?? [];
  const resRaw = pick(attrs, RES_LABEL);
  const ifaceRaw = pick(attrs, IFACE_LABEL);
  const panelRaw = pick(attrs, PANEL_LABEL);

  // Interface information on this site lives in two places: the "连接方式"
  // attribute (which mostly says PCB or FPC - packaging, not signal) and the
  // resolution string itself (`480*800MIPI/RGB` names the signal). Take the
  // signal names from both.
  const interfaces = [
    ...extractInterfaces(ifaceRaw ?? ''),
    ...extractInterfaces(resRaw ?? ''),
  ];

  return {
    sizeInch,
    title: product.title,
    resolution: resRaw ? extractResolution(resRaw) : null,
    interfaces: [...new Set(interfaces)],
    panel: panelRaw ? extractPanel(panelRaw) : null,
    shapes: extractShapes(product.title ?? '').map((s) => s.cn),
  };
}

function pick(attrs, re) {
  const hit = attrs.find((a) => re.test(a.label));
  return hit?.value ?? null;
}

/**
 * Per-size roll-up. Each size maps to the modal value of every field.
 *
 * The sources are the existing 34 products plus the new-release rows that
 * produced the field naturally; the library never asks "which field is
 * missing" - it just reports what the pool of same-size products says.
 */
export function buildLibrary(sources) {
  const bySize = new Map();
  for (const row of sources) {
    if (!Number.isFinite(row.sizeInch)) continue;
    const key = String(row.sizeInch);
    if (!bySize.has(key)) bySize.set(key, []);
    bySize.get(key).push(row);
  }

  const library = new Map();
  for (const [key, rows] of bySize) {
    library.set(key, {
      count: rows.length,
      resolution: modal(rows.map((r) => r.resolution).filter(Boolean)),
      panel: modal(rows.map((r) => r.panel).filter(Boolean)),
      interfaces: modalList(rows.map((r) => r.interfaces).filter((l) => l.length > 0)),
      shapes: modalList(rows.map((r) => r.shapes).filter((l) => l.length > 0)),
    });
  }
  return library;
}

/**
 * Unanimous value, or null.
 *
 * Requires every candidate to agree. A majority is not enough: the size-4
 * pool carries one existing 480x480 SKU, two 720x720 square folders and one
 * 720x720 bar panel, and the modal would have printed `720×720` on a
 * round 4" page (row 33) that is almost certainly a 480x480 panel. When the
 * pool disagrees, the honest answer is "we do not know from what the folder
 * carries", and the record shows a blank cell rather than a wrong one.
 *
 * A single candidate fills trivially. That is the intended use - the
 * `1.28寸` folder with no PDF gets its SPI/IPS/240x240 from the one
 * existing 1.28 SKU the site already publishes, and everyone agrees because
 * there is nothing to disagree with.
 */
function modal(values) {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((v) => v === first) ? first : null;
}

/**
 * Values present in **every** candidate group, or null.
 *
 * Sets are used where one row can list several values (interfaces, shapes),
 * and agreement means "we all mention MIPI", not "we all mention the same
 * list and nothing else". Taking the intersection means a `圆形` page gets
 * filled to `圆形` even if the pool also contains a `圆形 + 旋钮屏` row;
 * taking strict equality of joined strings would have rejected the fill for
 * no useful reason.
 */
function modalList(groups) {
  if (groups.length === 0) return null;
  let common = new Set(groups[0]);
  for (const group of groups) {
    common = new Set([...common].filter((item) => group.includes(item)));
    if (common.size === 0) return null;
  }
  return [...common];
}

/**
 * Fill every record's missing fields from the library, and record which
 * fields were filled so the CSV and the page can show their origin.
 *
 * Records that already have a field are never overwritten - the folder's own
 * extraction always beats the library, because the folder is what the owner
 * actually shipped.
 */
export function applyCompat(records, library) {
  let touched = 0;
  for (const record of records) {
    if (record.skip) continue;
    const key = record.specs.sizeInch === null ? null : String(record.specs.sizeInch);
    if (!key) continue;
    const entry = library.get(key);
    if (!entry) continue;

    const filled = [];
    if (!record.specs.resolution && entry.resolution) {
      record.specs.resolution = entry.resolution;
      filled.push('resolution');
    }
    if (record.specs.interfaces.length === 0 && entry.interfaces) {
      record.specs.interfaces = entry.interfaces;
      filled.push('interfaces');
    }
    if (!record.specs.panel && entry.panel) {
      record.specs.panel = entry.panel;
      filled.push('panel');
    }
    if (record.specs.shapes.length === 0 && entry.shapes) {
      record.specs.shapes = entry.shapes;
      filled.push('shapes');
    }

    if (filled.length > 0) {
      record.compatFilled = filled;
      touched += 1;
    }
  }
  return touched;
}
