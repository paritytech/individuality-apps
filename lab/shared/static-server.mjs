// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Serve a source build on loopback only, including static-export route directories.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const [directory, port] = process.argv.slice(2), root = resolve(directory);
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.yaml': 'application/yaml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.ico': 'image/vnd.microsoft.icon', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.otf': 'font/otf', '.wasm': 'application/wasm', '.gz': 'application/gzip',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const file = resolve(root, '.' + path);
    if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    let selected = file;
    try { if ((await stat(file)).isDirectory()) selected = resolve(file, 'index.html'); await stat(selected); }
    catch { selected = extname(file) ? file : file + '.html'; }
    if (selected !== root && !selected.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const body = await readFile(selected);
    response.writeHead(200, { 'content-type': types[extname(selected)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(Number(port), '127.0.0.1');
