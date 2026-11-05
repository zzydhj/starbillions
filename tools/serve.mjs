/**
 * Static preview server for dist/. Zero dependencies, node:http only.
 *
 *   node tools/serve.mjs
 *
 * It no longer builds or watches: the mirror is produced by one deliberate command
 * rather than on file saved, so there is no second writer racing for dist/ and the
 * lock that guarded that race went with it.
 *
 * It mimics the two Cloudflare Pages behaviours worth catching locally:
 *   - a directory request serves its index.html
 *   - an unknown path serves 404.html with a 404 status
 * It does not reimplement _headers or _redirects; test those with `wrangler pages dev`.
 */
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { paths } from './lib/paths.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
};

const port = Number(process.env.PORT ?? 8788);

/** Resolve a URL path to a file inside dist, or null if it escapes the root. */
function resolveTarget(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([\\/])/, '');
  const abs = resolve(paths.dist, rel);

  // Directory containment check: a crafted path must not read outside dist.
  if (abs !== paths.dist && !abs.startsWith(paths.dist + sep)) return null;

  if (existsSync(abs) && statSync(abs).isDirectory()) {
    return firstExisting(join(abs, 'index.html'));
  }
  return firstExisting(abs);
}

function firstExisting(candidate) {
  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
}

function send404(res, pathname) {
  // A missing CSS or image gets an empty 404 rather than the site's 404 page: serving
  // 700 KB of HTML in answer to a stylesheet request makes a broken build look like a
  // working one, and the browser then applies HTML as CSS.
  if (/\.[a-z0-9]{2,5}$/i.test(pathname)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('');
    return;
  }

  const body = firstExisting(join(paths.dist, '404.html'));

  res.writeHead(404, { 'content-type': TYPES['.html'] });
  if (body) createReadStream(body).pipe(res);
  else res.end('404');
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${port}`);
  const target = resolveTarget(pathname);

  if (!target) return send404(res, pathname);

  const type = TYPES[extname(target)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(target).pipe(res);
});

if (!existsSync(join(paths.dist, 'index.html'))) {
  console.error(`\n  ${paths.dist} has no index.html - build the mirror first.\n`);
  process.exit(1);
}

server.listen(port, () => {
  console.log(`  serving dist/ at http://localhost:${port}\n`);
});

// Without this handler a busy port surfaces as an unhandled 'error' event plus
// a stack-trace wall. Say what is blocking and how to pick another port.
server.on('error', (error) => {
  const hint = error.code === 'EADDRINUSE'
    ? `port ${port} is taken - stop the other server, or run: PORT=8790 node tools/serve.mjs`
    : error.message;
  console.error(`\n  server could not start: ${hint}\n`);
  process.exit(1);
});
