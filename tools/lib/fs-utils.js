/**
 * Thin filesystem helpers. Sync on purpose: the build is a short,
 * linear script and sync code keeps the step order obvious.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export function readFile(absPath) {
  return readFileSync(absPath, 'utf8');
}

export function readJson(absPath) {
  try {
    return JSON.parse(readFile(absPath));
  } catch (error) {
    error.message = `${relative(process.cwd(), absPath)}: ${error.message}`;
    throw error;
  }
}

export function writeFile(absPath, contents) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents, 'utf8');
}

export function exists(absPath) {
  try {
    statSync(absPath);
    return true;
  } catch {
    return false;
  }
}

export function removeTree(absPath) {
  rmSync(absPath, { recursive: true, force: true });
}

/** Recursive file list, paths relative to `dir` and always forward-slashed. */
export function walk(dir, base = dir) {
  if (!exists(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(abs, base));
    } else {
      found.push({ abs, rel: relative(base, abs).split('\\').join('/') });
    }
  }
  return found;
}

/** Copy a directory tree, skipping files whose name starts with a dot. */
export function copyTree(from, to, { skipDotfiles = false } = {}) {
  const files = walk(from);
  for (const file of files) {
    if (skipDotfiles && file.rel.startsWith('.')) continue;
    writeFile(join(to, file.rel), readFileSync(file.abs));
  }
  return files.length;
}

export { mkdirSync };
