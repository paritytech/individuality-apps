// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { staticHandler } from './fixtures/static-handler.ts';
import { nextAcceptsRsc } from './fixtures/next-rsc-acceptance.ts';
const source = readFileSync(new URL('../../../../lab/shared/static-server.mjs', import.meta.url), 'utf8');
it('serves Next navigation and segment-prefetch payloads as UTF-8 text accepted by the actual Next client gate', async () => {
  const serve = staticHandler(source, { 'chest.txt': '0:RSC chest', 'index.txt': '0:RSC home', 'chest/__next._tree.txt': '0:RSC tree' });
  for (const path of ['/chest.txt?game=1&_rsc=k3x9a', '/index.txt?_rsc=h1', '/chest/__next._tree.txt?_rsc=p1']) {
    const response = await serve(path); expect(response.status).toBe(200);
    expect(response.headers?.['content-type']).toBe('text/plain; charset=utf-8');
    expect(nextAcceptsRsc(response.headers?.['content-type'] ?? '')).toBe(true);
  }
});
it('@negative-control removing the txt entry restores octet-stream and the Next MPA decision', async () => {
  const old = source.replace("'.txt': 'text/plain; charset=utf-8', ", ''); expect(old).not.toBe(source);
  const response = await staticHandler(old, { 'chest.txt': '0:RSC chest' })('/chest.txt?game=1&_rsc=k3x9a');
  expect(response.status).toBe(200); expect(response.headers?.['content-type']).toBe('application/octet-stream');
  expect(nextAcceptsRsc(response.headers?.['content-type'] ?? '')).toBe(false);
});
it.each([
  ['.gif', 'image/gif'], ['.gz', 'application/gzip'], ['.ico', 'image/vnd.microsoft.icon'], ['.map', 'application/json'],
  ['.mov', 'video/quicktime'], ['.mp4', 'video/mp4'], ['.otf', 'font/otf'], ['.webm', 'video/webm'], ['.yaml', 'application/yaml'],
  ['.json', 'application/json'], ['.mjs', 'text/javascript'], ['.svg', 'image/svg+xml'], ['.woff2', 'font/woff2'], ['.wasm', 'application/wasm'],
])('serves %s with its declared media type', async (extension, type) => {
  const response = await staticHandler(source, { ['asset' + extension]: Buffer.from([0, 1, 255]) })('/asset' + extension);
  expect(response.status).toBe(200); expect(response.headers?.['content-type']).toBe(type);
});
it('@negative-control preserves unknown-source fallback and missing-file refusal', async () => {
  expect((await staticHandler(source, { 'worker.ts': 'interface SourceOnly {}' })('/worker.ts')).headers?.['content-type']).toBe('application/octet-stream');
  expect((await staticHandler(source, {})('/missing.txt?_rsc=1')).status).toBe(404);
  expect(nextAcceptsRsc('text/html')).toBe(false); expect(nextAcceptsRsc('text/plain', 404)).toBe(false);
});
