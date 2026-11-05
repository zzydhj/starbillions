/**
 * MySQL dump reader.
 *
 * A phpMyAdmin/mysqldump export is a sequence of
 *   CREATE TABLE `t` ( ... );
 *   INSERT INTO `t` [(`col`,...)] VALUES (...),(...),(...);
 * with row values allowed to span lines and to contain escaped quotes, literal
 * backslashes and embedded newlines. That combination is why this cannot be a
 * regex over lines: a post_content field routinely contains both `\n` and a
 * `');` sequence.
 *
 * So the reader is a small state machine over the raw text, and it only ever
 * materialises the tables you ask for. On a 40 MB dump, parsing everything would
 * hold the whole site in memory for no reason.
 */
import { readFileSync } from 'node:fs';

/** Byte-heavy tables that are never part of the site's content; skipped. */
const HEAVY_SKIP = new Set([
  'wp_wfknownfilelist',
  'wp_wffilechanges',
  'wp_wfwaffailures',
  'wp_trp_gettext_en_us',
  'wp_trp_gettext_zh_cn',
  'wp_revslider_css',
  'wp_revslider_css_bkp',
  'wp_wpr_rucss_used_css',
]);

/**
 * Read `tables` from the dump at `file`.
 * Returns { table: { columns, rows } }, rows being arrays aligned to `columns`.
 * `columns` come from the INSERT when the dump states them; mysqldump omits them
 * for some tables, so a caller that needs one of those must supply the order.
 */
export function readDump(file, tables) {
  const wanted = new Set(tables);
  const source = readFileSync(file, 'utf8');
  const declared = readColumnOrder(source);
  const out = {};

  for (const table of wanted) out[table] = { columns: declared.get(table) ?? null, rows: [] };

  const statementStart = /^INSERT INTO `([^`]+)`/gm;
  let match;

  while ((match = statementStart.exec(source)) !== null) {
    const table = match[1];
    if (!wanted.has(table) || HEAVY_SKIP.has(table)) continue;

    // A statement ends at `;` followed by a newline: inside a quoted value a
    // semicolon can appear anywhere, but never as the last character of a line
    // that also terminates the statement.
    const bodyStart = match.index + match[0].length;
    const bodyEnd = source.indexOf(';\n', bodyStart);
    if (bodyEnd === -1) continue;

    const head = source.slice(bodyStart, bodyEnd);
    const valuesAt = head.search(/VALUES\b/i);
    if (valuesAt === -1) continue;

    const columns = parseColumnList(head.slice(0, valuesAt));
    const rows = parseRowList(head.slice(valuesAt + 'VALUES'.length));

    if (!out[table].columns && columns) out[table].columns = columns;
    out[table].rows.push(...rows);

    // A column list on a later INSERT for the same table overrides nothing but
    // is worth trusting when CREATE TABLE was not found.
    if (columns && out[table].columns && columns.length !== out[table].columns.length) {
      throw new Error(`[sql-dump] ${table}: CREATE TABLE declares ${out[table].columns.length} columns, an INSERT declares ${columns.length}`);
    }

    // Resume after the rows just consumed, so the outer scan never re-reads
    // megabytes of post_content hunting for the next INSERT.
    statementStart.lastIndex = bodyEnd;
  }

  return out;
}

/**
 * Column order taken from each CREATE TABLE, in declaration order.
 *
 * Needed because this dump writes `INSERT INTO t VALUES (...)` with no column
 * list, so the only place the order is stated is the table definition. Keys are
 * the backticked identifiers, in file order, with no reordering.
 */
function readColumnOrder(source) {
  const order = new Map();
  const create = /^CREATE TABLE `([^`]+)` \(([\s\S]*?\n\)[\s\S]*?;)/gm;

  for (const match of source.matchAll(create)) {
    const body = match[2];
    const columns = [];

    for (const line of body.split('\n')) {
      const column = line.match(/^\s*`([^`]+)`\s+[A-Za-z]/);
      // A KEY/PRIMARY/INDEX line starts with an identifier too, so requiring a
      // type-looking word after the name is what separates them apart.
      if (!column || /^(primary|unique|key|index|constraint|fulltext|spatial)$/i.test(column[1])) continue;
      columns.push(column[1]);
    }

    order.set(match[1], columns);
  }

  return order;
}

function parseColumnList(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('(')) return null;
  const inner = trimmed.slice(1, trimmed.lastIndexOf(')'));
  return inner.split(',').map((column) => column.trim().replace(/`/g, ''));
}

/**
 * Split `(a,b),(c,d)...` into rows. Quote and escape tracking is the whole job:
 * inside a single-quoted string, a backslash escapes the next character and `''`
 * is a literal quote, so parentheses and commas there are data, not structure.
 */
function parseRowList(text) {
  const rows = [];
  let i = 0;

  while (i < text.length) {
    const open = text.indexOf('(', i);
    if (open === -1) break;

    const { row, end } = readRow(text, open + 1);
    rows.push(row);
    i = end + 1;
  }

  return rows;
}

function readRow(text, from) {
  const values = [];
  let current = '';
  let inString = false;
  let depth = 0;
  let i = from;

  const push = () => {
    values.push(valueOf(current));
    current = '';
  };

  while (i < text.length) {
    const char = text[i];

    if (inString) {
      if (char === '\\') {
        // Keep the pair intact; unescapeValue decides what it means.
        current += char + (text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (char === "'") {
        if (text[i + 1] === "'") {
          current += "''";
          i += 2;
          continue;
        }
        inString = false;
      }
      current += char;
      i += 1;
      continue;
    }

    if (char === "'") {
      inString = true;
      current += char;
      i += 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (char === ')') {
      if (depth === 0) {
        push();
        return { row: values, end: i };
      }
      depth -= 1;
    }
    if (char === ',' && depth === 0) {
      push();
      i += 1;
      continue;
    }
    current += char;
    i += 1;
  }

  return { row: values, end: text.length };
}

/**
 * Turn one raw token into a JS value, deciding by its own shape rather than by
 * parser state: a quoted value arrives here already closed.
 */
function valueOf(raw) {
  const token = String(raw).trim();

  if (token.toUpperCase() === 'NULL') return null;
  if (!token.startsWith("'")) return /^-?\d+(\.\d+)?$/.test(token) ? Number(token) : token;

  const body = token.slice(1, token.lastIndexOf("'"));
  // One pass, so `\\n` (escaped backslash then n) yields `\n` as text and is not
  // re-read as a newline escape by a second replace.
  return body.replace(/\\([\s\S])|('')/g, (_, escaped, doubled) => {
    if (doubled) return "'";
    if (escaped === 'n') return '\n';
    if (escaped === 't') return '\t';
    if (escaped === 'r') return '';
    return escaped;
  });
}
