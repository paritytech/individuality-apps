// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const versionLabUrl = 'http://127.0.0.1:49791/version.json';
export const versionLabBuild = { version: 'cross-app-update-lab', time: 1, product: 'dim2.paseo' };
/** The unchanged app fetches an actual HTTP file on loopback; only the local lab controls that file. */
export async function serveVersionFile(directory: string) {
  const file = join(directory, 'version.json'), requests: Array<{ at: number; newer: boolean }> = [];
  let newer = false;
  const set = (next: boolean) => {
    newer = next;
    writeFileSync(file, JSON.stringify({ [versionLabBuild.product]: { version: next ? 'cross-app-newer-lab' : versionLabBuild.version, time: next ? 2 : versionLabBuild.time } }) + '\n');
  };
  set(false);
  const server = createServer((request, response) => {
    if (new URL(request.url!, versionLabUrl).pathname !== '/version.json') { response.writeHead(404); response.end(); return; }
    requests.push({ at: Date.now(), newer });
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(49791, '127.0.0.1', resolve); });
  return { set, requests, url: versionLabUrl, build: versionLabBuild, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
