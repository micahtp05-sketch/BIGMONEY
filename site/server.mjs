// Zero-dependency static file server for the site/ scaffold.
// Serves public/ with extensionless URLs (/about -> public/about.html).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Map a request path to a file inside ROOT, or null if it escapes ROOT.
function resolvePath(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const candidate = resolve(join(ROOT, rel));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
  return candidate;
}

async function tryRead(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }

  const base = resolvePath(req.url ?? '/');
  if (base === null) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }

  // Exact file, then the .html twin, then index.html inside a directory.
  const attempts = extname(base) ? [base] : [`${base}.html`, join(base, 'index.html'), base];

  for (const path of attempts) {
    const body = await tryRead(path);
    if (body === null) continue;
    const type = MIME[extname(path)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  const notFound = (await tryRead(join(ROOT, '404.html'))) ?? Buffer.from('Not Found');
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.method === 'HEAD' ? undefined : notFound);
});

server.listen(PORT, HOST, () => {
  console.log(`site → http://localhost:${PORT}`);
});
