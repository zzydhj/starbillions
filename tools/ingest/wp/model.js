/**
 * Rows to objects, keyed by the column names CREATE TABLE declared.
 *
 * Shared because every extractor needs the same join and the column order is
 * only knowable from the dump itself (this dump's INSERTs omit the list).
 * Keeping it in one place also means a table missing its definition fails here,
 * loudly, instead of producing objects whose values are shifted by one column —
 * which is the kind of corruption that looks like a successful import.
 */
export function toObjects(dump, table) {
  const data = dump[table];
  if (!data) throw new Error(`[wp] table "${table}" was not requested from the dump`);
  if (!data.columns) {
    throw new Error(`[wp] ${table}: no column order found in CREATE TABLE, cannot map ${data.rows.length} rows`);
  }

  const unexpected = data.rows.filter((row) => row.length !== data.columns.length);
  if (unexpected.length > 0) {
    throw new Error(
      `[wp] ${table}: ${unexpected.length} row(s) have ${unexpected[0].length} values against ${data.columns.length} declared columns`,
    );
  }

  return data.rows.map((row) => Object.fromEntries(data.columns.map((column, index) => [column, row[index]])));
}

/** Rows grouped by a column, for the many `id -> children` joins below. */
export function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!grouped.has(value)) grouped.set(value, []);
    grouped.get(value).push(row);
  }
  return grouped;
}

/**
 * Postmeta as a plain object: { postId: { metaKey: metaValue } }.
 *
 * Plain object rather than a Map on purpose. A Map reads perfectly natural as
 * `meta[id]` and silently returns undefined for every id, which is exactly how
 * this lookup lost all 34 product covers; object access cannot make that mistake.
 *
 * Values stay strings, as MySQL gave them: `_thumbnail_id` is the string '17102'
 * against a numeric attachment ID, so callers joining the two must coerce.
 */
export function metaByPost(postmeta) {
  const byPost = {};
  for (const row of postmeta) {
    (byPost[row.post_id] ??= {})[row.meta_key] = row.meta_value;
  }
  return byPost;
}

export function isPublished(row) {
  return row.post_status === 'publish';
}
