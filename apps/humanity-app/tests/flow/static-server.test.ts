// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { staticHandler } from './fixtures/static-handler.ts';
const source = readFileSync(new URL('../../../../lab/shared/static-server.mjs', import.meta.url), 'utf8');
const files = { 'index.html': '<main>home</main>', 'permissions.html': '<main>Allow access</main>',
  'permissions/__next._full.txt': 'RSC payload', 'game.html': '<main>game</main>', 'game/__next._full.txt': 'game RSC',
  'directory/index.html': '<main>directory route</main>', 'assets/logo.png': Buffer.from([0, 1, 255]) };
const serve = staticHandler(source, files);
it('serves flat exported HTML beside RSC directories, including trailing slash and query', async () => {
  for (const path of ['/permissions', '/permissions/', '/permissions?from=humanity', '/game']) {
    const response = await serve(path);
    expect(response.status, path).toBe(200); expect(response.headers?.['content-type']).toBe('text/html');
    expect(response.body).toBe(files[path.startsWith('/game') ? 'game.html' : 'permissions.html']);
  }
});
it('preserves root, directory-index, explicit HTML, RSC and binary asset responses', async () => {
  for (const [path, file] of [['/', 'index.html'], ['/directory', 'directory/index.html'], ['/permissions.html', 'permissions.html'],
    ['/permissions/__next._full.txt', 'permissions/__next._full.txt'], ['/assets/logo.png', 'assets/logo.png']] as const) {
    const response = await serve(path); expect(response.status).toBe(200); expect(response.body).toEqual(files[file]);
  }
});
it('@negative-control keeps missing routes and assets at 404, and rejects encoded traversal', async () => {
  for (const path of ['/missing', '/missing.js', '/assets', '/permissions/missing.txt']) expect((await serve(path)).status).toBe(404);
  expect((await serve('/%2e%2e%2fprivate')).status).toBe(403);
});
it('@negative-control reproduces the exact old Not found response when a route directory shadows its HTML', async () => {
  const old = source.replace("selected = resolve(file, 'index.html'); await stat(selected);", "selected = resolve(file, 'index.html');");
  expect(old).not.toBe(source);
  const response = await staticHandler(old, files)('/permissions');
  expect(response.status).toBe(404); expect(response.body).toBe('Not found');
});
it('runs the actual navigation custom step with the real registry and original-error control', () => {
  const fixture = fileURLToPath(new URL('./fixtures/navigation-sequence.mts', import.meta.url));
  const output = execFileSync('node', ['--import', 'tsx', fixture], { encoding: 'utf8', timeout: 30_000 });
  expect(output).toContain('actual navigation steps pass for Alice, Bob and Carol');
  const broken = execFileSync('node', ['--import', 'tsx', fixture], { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, FLOW_STATIC_MUTATE: '1', FLOW_STATIC_EXPECT_FAILURE: '1' } });
  expect(broken).toContain('The bounded flow wait expired');
}, 65_000);

it('@negative-control never reads a sibling HTML file when the build root has no index', async () => {
  const withoutIndex = staticHandler(source, { '../offline-static-export.html': 'outside the build' });
  expect((await withoutIndex('/')).status).toBe(403);
});
