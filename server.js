// Run Swarna Live locally with Node.js (for development or a single-computer
// setup). On Cloudflare, src/worker.js is used instead.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp, SECURITY_HEADERS } from './src/app.js';
import { sqliteDb, folderFiles } from './src/node-adapters.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

export function createServer({ db, files, secureCookies = false, setupCode = null }) {
  const api = createApp({ db, files, secureCookies, setupCode });
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) for (const x of [].concat(v)) headers.append(k, x);
        const hasBody = !['GET', 'HEAD'].includes(req.method);
        const request = new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
        const response = await api(request, { ip: req.socket.remoteAddress });
        const out = {};
        response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) out['set-cookie'] = cookies;
        res.writeHead(response.status, out);
        if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const file = path.join(publicDir, path.normalize(rel));
      if (!file.startsWith(publicDir + path.sep) || path.basename(file).startsWith('_') || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500).end('Server error');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.SWARNA_DATA || path.join(root, 'data');
  const server = createServer({
    db: sqliteDb(process.env.SWARNA_DB || path.join(dataDir, 'swarna.db')),
    files: folderFiles(path.join(dataDir, 'files')),
    secureCookies: process.env.COOKIE_SECURE === '1',
    setupCode: process.env.SETUP_CODE || null,
  });
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`Swarna Live running at http://${host}:${port}`));
}
