/**
 * Minimal static file server — no framework dependency.
 *
 * Serves both clients from ONE origin (spec section 7.1): the viewer at `/`,
 * the phone at `/phone`. Same-origin matters because the WS endpoint lives here
 * too; splitting them buys a CORS and mixed-content surface for no benefit.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Resolve a URL path inside a root, refusing anything that escapes it. */
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = resolve(join(root, rel));
  const rootResolved = resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null;
  return full;
}

/** Resolve to a readable file path, following directories to index.html. */
async function resolveFile(path) {
  try {
    const st = await stat(path);
    if (st.isFile()) return path;
    if (st.isDirectory()) {
      const idx = join(path, 'index.html');
      if ((await stat(idx)).isFile()) return idx;
    }
  } catch { /* miss */ }
  return null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/**
 * @param {{viewerDist: string, phoneDist: string}} roots
 */
export function makeStaticHandler({ viewerDist, phoneDist }) {
  return async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed');
    }

    const url = req.url || '/';
    const pathOnly = url.split('?')[0];

    if (pathOnly === '/healthz') {
      return send(res, 200, 'ok');
    }

    // Route: /phone and everything under it comes from the phone bundle.
    // The room code arrives as a query param (?room=418306) and is read by the
    // client, so it must survive here untouched — a redirect that drops the
    // query string is exactly the "QR opens the page unpaired" failure.
    let root = viewerDist;
    let rel = pathOnly;
    if (pathOnly === '/phone' || pathOnly.startsWith('/phone/')) {
      root = phoneDist;
      rel = pathOnly.slice('/phone'.length) || '/';
    }

    const target = safeJoin(root, rel);
    if (!target) return send(res, 403, 'forbidden');

    // Fall back to the bundle's index.html so deep links work.
    const filePath = (await resolveFile(target)) ?? (await resolveFile(join(root, 'index.html')));
    if (!filePath) {
      return send(
        res,
        404,
        `No build found at ${root}.\nRun: npm run build\n(or use the Vite dev servers via scripts/dev.sh)`,
      );
    }

    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    const immutable = /\.[0-9a-f]{8,}\./i.test(filePath);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      // The viewer loads only its own assets; keep the surface tight.
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(filePath).pipe(res);
  };
}
