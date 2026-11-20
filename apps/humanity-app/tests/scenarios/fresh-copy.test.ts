// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EnvironmentStartContext } from '@parity/product-lab';
import type { SyncCommandRequest } from '@parity/product-lab/ports/system';
import type { NetworkCopyOptions } from '@parity/product-lab/composition';
import { engineConfiguration, engineRun, forkBundleManifestPath, markForkBundle, preparedEngine } from '@parity/product-lab/env-engine';
import { freshPaseoCopy } from '../../../../lab/shared/fresh-copy.ts';

const harness = vi.hoisted(() => ({ workspace: '', prepare: vi.fn(), start: vi.fn(async (_options: unknown, _context: unknown) => ({ close: vi.fn(async () => undefined) })) }));
vi.mock('@parity/product-lab/env-engine', async original => ({ ...await original<object>(), preparedEngine: vi.fn(() => ({ workspace: harness.workspace })) }));
vi.mock('@parity/product-lab/composition', async original => ({ ...await original<object>(), paseoCopy: vi.fn((options?: NetworkCopyOptions) => ({
  'paseo-copy': { choices: [{ id: 'full', environment: { offer: { chains: ['people', 'asset-hub', 'bulletin'], local: true },
    tooling: { id: 'engine', kind: 'engine', label: 'Engine', check: () => ({ ready: true, detail: 'fixture' }), prepare: harness.prepare },
    start: (context: unknown) => harness.start(options, context),
  } }] },
})) }));
const commands = { run: vi.fn((_request: SyncCommandRequest) => ({ code: 0, stdout: '', stderr: '' })) };
const transport = vi.fn<typeof fetch>(async () => new Response('unexpected transport'));
let root: string, bundle: string, context: EnvironmentStartContext;
beforeEach(() => {
  vi.clearAllMocks(); commands.run.mockReset(); commands.run.mockReturnValue({ code: 0, stdout: '', stderr: '' });
  root = mkdtempSync(join(process.cwd(), '.fresh-copy-test-')); harness.workspace = join(root, 'cached-workspace');
  bundle = dirname(forkBundleManifestPath(harness.workspace, 'paseo-next-v2'));
  expect(bundle).toBe(join(harness.workspace, 'fork-bundle-paseo-next-v2')); mkdirSync(join(bundle, 'snapshots'), { recursive: true });
  const bytes = gzipSync(Buffer.from('offline snapshot')), snapshots = Object.fromEntries(['relay', '1500', '1501', '1502'].map(id => [`${id}.tgz`, bytes.length]));
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({ network: 'paseo-next-v2', snapshotBytes: snapshots }));
  for (const name of Object.keys(snapshots)) writeFileSync(join(bundle, 'snapshots', name), bytes);
  markForkBundle(bundle, snapshots, 'offline-fixture');
  vi.stubEnv('PRODUCT_LAB_CACHE_DIR', join(root, 'cache')); vi.stubEnv('PRODUCT_LAB_FORK_BUNDLE', 'keep');
  vi.stubEnv('HUMANITY_SCENARIOS_FORK_DIRECTORY', join(root, 'copies')); vi.stubGlobal('fetch', transport);
  context = { root, signal: new AbortController().signal, environmentId: 'paseo-copy', system: { syncCommands: commands } } as EnvironmentStartContext;
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it('starts every run in a distinct empty copy and seed directory while reusing the marked cached bundle', async () => {
  const old = join(root, 'copies', 'paseo-copy'); mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'network.json'), 'old prize asset');
  const marker = readFileSync(join(bundle, '.product-lab-complete'));
  const starts: string[] = [];
  harness.start.mockImplementation(async options => {
    const settings = options as NetworkCopyOptions;
    expect(settings.cacheDir).toBe(join(root, 'cache'));
    expect(settings.seedsDir).toBe(join(settings.directory!, 'seeds')); expect(existsSync(settings.seedsDir!)).toBe(false);
    const directory = join(settings.directory!, 'paseo-copy'); expect(existsSync(join(directory, 'network.json'))).toBe(false);
    mkdirSync(directory); writeFileSync(join(directory, 'network.json'), JSON.stringify({ runId: basename(settings.directory!), prizeAsset: true }));
    starts.push(settings.directory!); return { close: vi.fn(async () => undefined) };
  });
  const provider = freshPaseoCopy();
  await (await provider.start(context)).close(); await (await provider.start(context)).close();
  expect(preparedEngine).toHaveBeenCalledWith(join(root, 'cache', 'engine'), expect.objectContaining({ stateDirectory: '.', patch: 'as-prepared', commands }));
  expect(starts).toHaveLength(2); expect(starts[0]).not.toBe(starts[1]);
  expect(readFileSync(join(old, 'network.json'), 'utf8')).toBe('old prize asset');
  expect(readFileSync(join(bundle, '.product-lab-complete'))).toEqual(marker);
  await expect(fetch('https://github.com/paritytech/previewnet-engine/releases/download/bites/new.tar.gz')).rejects.toThrow('Kept Engine bundle');
  expect(transport).not.toHaveBeenCalled();
});
it.each(['missing', 'damaged'])('refuses a %s cached bundle before any provider start', async state => {
  if (state === 'missing') rmSync(join(bundle, '.product-lab-complete'));
  else writeFileSync(join(bundle, 'snapshots', 'relay.tgz'), 'damaged size');
  await expect(freshPaseoCopy().start(context)).rejects.toThrow('Cached Paseo bundle is missing or incomplete; download refused');
  expect(harness.start).not.toHaveBeenCalled(); expect(existsSync(join(root, 'copies'))).toBe(false);
});
it('refuses non-keep starts, update/keep requests and automatic tooling preparation', async () => {
  const provider = freshPaseoCopy();
  vi.stubEnv('PRODUCT_LAB_FORK_BUNDLE', 'refresh'); await expect(provider.start(context)).rejects.toThrow('PRODUCT_LAB_FORK_BUNDLE=keep');
  vi.stubEnv('PRODUCT_LAB_FORK_BUNDLE', 'keep');
  await expect(provider.start({ ...context, keep: true })).rejects.toThrow('fresh cached copy');
  await expect(provider.start({ ...context, update: 'refresh' })).rejects.toThrow('fresh cached copy');
  await expect(provider.tooling!.prepare({ system: {} })).rejects.toThrow('automatic preparation is refused');
  expect(harness.prepare).not.toHaveBeenCalled(); expect(harness.start).not.toHaveBeenCalled();
});

it('the pinned Engine plan re-forks from a complete cached bundle without fetching or biting', () => {
  const config = engineConfiguration.parse({ checkout: join(root, 'engine'), workspace: harness.workspace, network: 'paseo-next-v2', mode: 'fork', isolate: true });
  const input = { expose: false, directory: join(root, 'isolation'), bundle, bundlePresent: true };
  const run = engineRun(config, join(root, 'new-data'), undefined, input);
  expect(run.prepare.map(command => command.args.slice(0, 2))).toEqual([['fork', 'toml']]);
  expect(run.prepare[0]!.args[2]).toBe(bundle); expect(run.start.args).toContain('--toml');
  const uncached = engineRun(config, join(root, 'new-data'), undefined, { ...input, bundlePresent: false });
  expect(uncached.prepare.some(command => command.args.includes('fetch-bundle'))).toBe(true);
});

it.each(['outside', 'root'])('refuses a copy parent at %s the permitted lab subtree before process inspection or allocation', async kind => {
  if (kind === 'outside') context = { ...context, root: join(root, 'lab') };
  vi.stubEnv('HUMANITY_SCENARIOS_FORK_DIRECTORY', kind === 'root' ? context.root : join(root, 'outside-lab'));
  await expect(freshPaseoCopy().start(context)).rejects.toThrow('Fresh scenario copies must stay below the lab root');
  expect(harness.start).not.toHaveBeenCalled(); expect(commands.run).not.toHaveBeenCalled();
});
it('refuses an older run survivor with its PID and ports before allocating a new copy', async () => {
  commands.run.mockReturnValueOnce({ code: 0, stdout: `4232 node --base-path ${join(root, 'copies', 'run-Ab12Cd', 'paseo-copy', 'network')}\n`, stderr: '' })
    .mockReturnValueOnce({ code: 0, stdout: 'p4232\nn127.0.0.1:9944\nn*:30333\n', stderr: '' });
  await expect(freshPaseoCopy().start(context)).rejects.toThrow(/PID 4232, TCP ports 9944, 30333/);
  expect(harness.start).not.toHaveBeenCalled(); expect(existsSync(join(root, 'copies'))).toBe(false);
  expect(commands.run.mock.calls.map(([request]) => request.command)).toEqual(['ps', 'lsof']);
});
