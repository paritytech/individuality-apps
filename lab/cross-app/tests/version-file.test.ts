// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { serveVersionFile, versionLabBuild } from '../version-file.ts';
it('serves the current build and then a newer local file, with reset and wrong-path controls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'version-file-test-')), server = await serveVersionFile(directory);
  try {
    const current = await (await fetch(server.url)).json();
    expect(current['dim2.paseo']).toEqual(versionLabBuild && { version: versionLabBuild.version, time: 1 });
    server.set(true); const next = await (await fetch(server.url)).json();
    expect(next['dim2.paseo'].time).toBeGreaterThan(current['dim2.paseo'].time);
    expect(next['dim2.paseo'].version).not.toBe(current['dim2.paseo'].version);
    server.set(false); expect(await (await fetch(server.url)).json()).toEqual(current);
    expect((await fetch(new URL('/unrelated', server.url))).status).toBe(404);
    expect(server.requests.map(r => r.newer)).toEqual([false, true, false]);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});
