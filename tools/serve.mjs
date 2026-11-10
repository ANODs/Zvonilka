#!/usr/bin/env node
// Раздаёт папку web/ для разработки: node tools/serve.mjs [порт]
// На localhost браузер даёт камеру и микрофон без https.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

// Возвращает { server, port }; порт 0 — любой свободный.
export function serve(root, port = 0) {
  const base = resolve(root);
  const server = http.createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(base, path));
      if (!file.startsWith(base + sep)) throw new Error('за пределами папки');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (_) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
    }
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done({ server, port: server.address().port })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await serve(fileURLToPath(new URL('../web/', import.meta.url)), Number(process.argv[2]) || 8080);
  console.log(`Звонилка: http://localhost:${port}/`);
}
