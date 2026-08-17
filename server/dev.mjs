/**
 * Yerel gelistirme sunucusu: Netlify'daki islevin ayni cekirdegini calistirir.
 * Veriler data/store icinde JSON dosyalari olarak tutulur. Ek bagimlilik yok.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../core/api.mjs';
import { autoStore } from '../core/store.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
  "style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";

const api = createApi(await autoStore());

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) reject(new Error('Request body is too large.'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const target = path.join(publicDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(publicDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) throw new Error('dizin');
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] || 'application/octet-stream',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache'
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    // Tek sayfa uygulamasi: davet linkleri de index.html'i acar.
    const html = await fsp.readFile(path.join(publicDir, 'index.html'));
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff'
    });
    res.end(html);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const raw = await readBody(req).catch(() => '');
      if (raw) {
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'Invalid JSON.' }));
          return;
        }
      }
    }
    const result = await api(req.method, req.url, body, { authorization: req.headers.authorization || '' });
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(result.body));
    return;
  }

  await serveStatic(res, url.pathname);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`Edge http://localhost:${port} adresinde calisiyor`));
