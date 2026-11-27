// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import type { FileSystem, OwnedProcesses } from '@parity/product-lab/ports/system';

it('keeps the cached bundle without fetching or staging an archive', async () => {
  vi.resetModules();
  vi.stubEnv('PRODUCT_LAB_FORK_BUNDLE', 'keep');
  const metadataUrl = 'https://api.github.com/repos/paritytech/previewnet-engine/releases/tags/bites';
  const assetUrl = 'https://github.com/paritytech/previewnet-engine/releases/download/bites/fork-bundle-paseo-next-v2.tar.gz';
  // A valid, newer manifest makes this a download candidate if the config omits the guard.
  const manifest = Buffer.from(JSON.stringify({ network: 'paseo-next-v2', bittenAt: '2026-11-04T18:44:00Z', biteBlocks: { people: 20 } }));
  const header = Buffer.alloc(512);
  header.write('manifest.json'); header.write(manifest.length.toString(8).padStart(11, '0'), 124);
  const archive = gzipSync(Buffer.concat([header, manifest, Buffer.alloc(1024)]));
  const transport = vi.fn<typeof fetch>(async input => {
    if (String(input) === metadataUrl) return Response.json({ assets: [{ name: 'fork-bundle-paseo-next-v2.tar.gz', browser_download_url: assetUrl, size: archive.length }] });
    if (String(input) === assetUrl) return new Response(archive, { status: 206 });
    throw Error(`Unexpected offline fetch: ${String(input)}`);
  });
  vi.stubGlobal('fetch', transport);
  // No real files, processes, fork, host or network adapter is used.
  const files = { readText: vi.fn(() => undefined), exists: vi.fn(() => false), listDirectory: vi.fn(() => undefined), remove: vi.fn() };
  const registry = { start: vi.fn(async () => { throw Error('Offline process tripwire'); }) };
  const logger = { info: vi.fn(), warn: vi.fn() };
  try {
    await import('../../lab.scenarios.config.ts');
    // Exercise the exact 0.1.0 updater used after a published Paseo-copy start.
    const engineEntry = import.meta.resolve('@parity/product-lab/env-engine');
    const { prefetchNewerState } = await import(new URL('./engine/fork-refresh.js', engineEntry).href);
    const result = await prefetchNewerState({ bittenAt: '2026-10-28T18:38:00Z' }, {
      engine: { checkout: 'offline-engine', workspace: 'offline-workspace', extraPath: [] }, network: 'paseo-next-v2',
      files: files as unknown as FileSystem, registry: registry as unknown as OwnedProcesses,
      environment: { all: () => ({ PRODUCT_LAB_FORK_BUNDLE: 'keep' }), get: (key: string) => key === 'PRODUCT_LAB_FORK_BUNDLE' ? 'keep' : undefined }, logger, notice: vi.fn(), stopping: () => false,
    });
    expect.soft(result).toBeUndefined();
    expect.soft(transport.mock.calls.map(([input]) => String(input))).toEqual([metadataUrl]);
    expect.soft(registry.start).not.toHaveBeenCalled();
    expect.soft(files.remove).not.toHaveBeenCalled();
    expect.soft(logger.info.mock.calls.flat().join('\n')).toContain('Keeping the fork bundle');
  } finally {
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules();
  }
});
