/**
 * Tar + gzip extractor that keeps UTF-8 entry names intact.
 *
 *   node tools/ingest/wp/untar.mjs <archive.tar.gz> <dest-dir>
 *
 * Why not `tar -xzf`: the Windows bsdtar build decodes entry names through the
 * console codepage, so the Chinese filenames in wp-content/uploads/ came out as
 * mojibake and the run aborted with "Invalid empty pathname" partway through.
 * WordPress resolves an attachment through `_wp_attached_file`, so a file written
 * under a mangled name is an image that 404s on every page using it — a silent,
 * one-sided failure. A tar member name is bytes declared to be UTF-8, so this
 * reader decodes them as UTF-8 and hands the string to fs, which on Windows goes
 * through UTF-16 without consulting any codepage.
 *
 * Long names are honoured because the 100-byte header field cannot hold
 * `tftstar.com/wp-content/uploads/2023/11/图片-topaz-enhance-4x-1024x574.png`:
 * both the GNU `L` record and the pax `path` record are supported.
 *
 * One entry is handled at a time and its payload is streamed to disk, so memory
 * tracks the largest file rather than the ~1 GB the archive unpacks to.
 */
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { dirname, join, sep } from 'node:path';

const BLOCK = 512;
const CHUNK = 1 << 20;

/** Characters NTFS rejects. An entry naming one cannot be written under that name. */
export const ILLEGAL = /[<>:"|?*\u0000-\u001f]/;

export async function untar(archive, dest, { dry = false, onEntry } = {}) {
  const reader = new StreamReader(createReadStream(archive).pipe(createGunzip()));
  const stats = { files: 0, dirs: 0, links: 0, bytes: 0, unwritable: [], longest: 0 };
  let carried = null;

  for (;;) {
    const header = await reader.next(BLOCK);
    if (header === null) break;
    if (header.every((byte) => byte === 0)) continue;

    const entry = parseHeader(header);

    // GNU and pax long-name records describe the entry that follows them, so
    // their payload is stored and applied to the next real header.
    if (entry.type === 'L' || entry.type === 'K') {
      carried = (await reader.slurp(entry.size)).toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (entry.type === 'x' || entry.type === 'g') {
      const fields = parsePax((await reader.slurp(entry.size)).toString('utf8'));
      if (entry.type === 'x' && fields.path) carried = fields.path;
      continue;
    }

    if (carried !== null) {
      entry.name = carried;
      carried = null;
    }

    if (entry.type === '5') {
      if (!dry) mkdirSync(join(dest, relative(entry.name)), { recursive: true });
      stats.dirs += 1;
      continue;
    }

    // Symlinks point at absolute server paths this checkout cannot resolve, and
    // nothing on a rendered page needs them.
    if (entry.type === '1' || entry.type === '2') {
      stats.links += 1;
      await reader.drain(entry.size);
      continue;
    }

    if (entry.type !== '0' && entry.type !== '') {
      await reader.drain(entry.size);
      continue;
    }

    const path = relative(entry.name);
    stats.longest = Math.max(stats.longest, path.length);
    onEntry?.(entry, stats);

    // Two reasons a member is not written: a name NTFS cannot hold, and a
    // caller that is only measuring the archive. Neither is silent.
    if (ILLEGAL.test(path)) {
      stats.unwritable.push(entry.name);
      await reader.drain(entry.size);
      continue;
    }
    if (dry) {
      await reader.drain(entry.size);
      stats.files += 1;
      stats.bytes += entry.size;
      continue;
    }

    const writable = join(dest, path);
    mkdirSync(dirname(writable), { recursive: true });
    await reader.writeFile(entry.size, writable);
    stats.files += 1;
    stats.bytes += entry.size;
  }

  return stats;
}

/**
 * Reads exact counts from an async byte stream.
 *
 * Tar is a fixed-record format, so "give me 512 bytes" and "give me this member"
 * must be answerable across arbitrary chunk boundaries — including a member whose
 * bytes span many chunks, or several members inside one chunk. Everything here
 * funnels through next(), which is what makes that safe.
 */
class StreamReader {
  constructor(source) {
    this.iterator = source[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }

  async fill(n) {
    while (this.buffer.length < n) {
      const { value, done } = await this.iterator.next();
      if (done) return;
      this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, value]) : value;
    }
  }

  /** @returns the next n bytes, or null if the stream ended before they arrived. */
  async next(n) {
    await this.fill(n);
    if (this.buffer.length < n) return null;

    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** Members are padded to a 512-byte boundary; the pad is never data. */
  async drain(size) {
    await this.skipBytes(size + padOf(size));
  }

  async skipBytes(n) {
    let left = n;
    while (left > 0) {
      const piece = await this.next(Math.min(left, CHUNK));
      if (piece === null) break;
      left -= piece.length;
    }
  }

  /** Whole payload of a metadata record, which is always small. */
  async slurp(size) {
    const out = await this.next(size);
    await this.skipBytes(padOf(size));
    return out ?? Buffer.alloc(0);
  }

  /** Streams a member to disk, waiting on backpressure so RAM does not grow. */
  async writeFile(size, target) {
    const sink = createWriteStream(target);
    let left = size;

    while (left > 0) {
      const piece = await this.next(Math.min(left, CHUNK));
      if (piece === null) break;
      left -= piece.length;
      if (!sink.write(piece)) await new Promise((done) => sink.once('drain', done));
    }

    await this.skipBytes(padOf(size));
    await new Promise((resolve, reject) => {
      sink.end(() => (sink.destroyed ? reject(new Error(`write failed: ${target}`)) : resolve()));
    });
  }
}

/** Padding that follows a record of `size` bytes; counted in exactly one place. */
function padOf(size) {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

function parseHeader(header) {
  const name = cstring(header.subarray(0, 100));
  const prefix = cstring(header.subarray(345, 500));
  const magic = cstring(header.subarray(257, 263));

  return {
    name: magic.startsWith('ustar') && prefix ? `${prefix}/${name}` : name,
    linkname: cstring(header.subarray(157, 257)),
    size: numeric(header.subarray(124, 136)),
    type: String.fromCharCode(header[156]),
  };
}

/** Octal text, or GNU's base-256 encoding for sizes too large for octal. */
function numeric(field) {
  const bytes = trim(field);
  if (bytes.length === 0) return 0;

  if (bytes[0] & 0x80) {
    let value = 0;
    for (const byte of bytes.subarray(1)) value = value * 256 + byte;
    return value;
  }
  return parseInt(bytes.toString('ascii'), 8) || 0;
}

function trim(bytes) {
  let start = 0;
  let end = bytes.length;
  while (end > start && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x00)) end -= 1;
  while (start < end && bytes[start] === 0x00) start += 1;
  return bytes.subarray(start, end);
}

function cstring(bytes) {
  const at = bytes.indexOf(0);
  return bytes.subarray(0, at === -1 ? bytes.length : at).toString('utf8');
}

/** pax records are `N key=value` where N counts the record's own bytes. */
function parsePax(text) {
  const fields = {};
  let cursor = 0;

  while (cursor < text.length) {
    const space = text.indexOf(' ', cursor);
    const newline = text.indexOf('\n', cursor);
    if (space === -1 || newline === -1) break;

    const length = Number(text.slice(cursor, space));
    if (!Number.isFinite(length) || length <= 0) break;

    const record = text.slice(space + 1, newline);
    const equals = record.indexOf('=');
    if (equals !== -1) fields[record.slice(0, equals)] = record.slice(equals + 1);
    cursor += length;
  }

  return fields;
}

/**
 * Archive path to a local one.
 *
 * `..` is refused outright: an extractor that walks upward turns a hostile or
 * merely odd archive into files written outside the destination.
 */
function relative(name) {
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new Error(`[untar] unsafe entry name: ${name}`);
  return parts.join(sep);
}

/* CLI ---------------------------------------------------------------------- */

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const [archive, dest] = args.filter((arg) => !arg.startsWith('--'));

  if (!archive || (!dry && !dest)) {
    console.error('usage: node tools/ingest/wp/untar.mjs <archive.tar.gz> [<dest-dir>] [--dry]');
    process.exit(1);
  }

  const started = Date.now();
  const stats = await untar(archive, dest ?? '.', { dry });

  console.log(
    `\n  ${stats.files} files, ${stats.dirs} dirs, ${stats.links} links skipped, ` +
      `${(stats.bytes / 1048576).toFixed(0)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  console.log(`  longest relative path: ${stats.longest} chars`);
  if (stats.unwritable.length > 0) {
    console.log(`\n  ${stats.unwritable.length} entry name(s) NTFS cannot hold:`);
    for (const name of stats.unwritable.slice(0, 10)) console.log(`    ${name}`);
  }
}
