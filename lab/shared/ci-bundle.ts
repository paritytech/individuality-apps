// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// One verified Paseo bundle per workflow run, shared by both products. No work occurs on import.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import type { ReadableStream } from 'node:stream/web';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const NETWORK = 'paseo-next-v2';
const PIN = /^[0-9a-f]{64}$/;
const row = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
export async function engineBundle() {
  const { NodeSystem, processEnvironment } = await import('@parity/product-lab/composition');
  const env = await import('@parity/product-lab/env-engine');
  const cache = process.env.PRODUCT_LAB_CACHE_DIR;
  if (!cache) throw Error('PRODUCT_LAB_CACHE_DIR is required');
  const system = new NodeSystem(processEnvironment());
  const engine = env.preparedEngine(env.savedForkEngineState(cache), { stateDirectory: '.', fix: 'Prepare the locked Engine before pinning scenario bundles', commands: system.syncCommands, patch: 'as-prepared' });
  const target = dirname(env.forkBundleManifestPath(engine.workspace, NETWORK));
  const marked = () => env.markedComplete(target) ? String(row(JSON.parse(readFileSync(join(target, env.BUNDLE_MARKER), 'utf8'))).manifestSha256) : null;
  return { env, engine, target, marked };
}
function output(values: Record<string, string | number>) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, ' ')}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  console.log(text.trimEnd());
}

/** GitHub's SHA-256 of the complete tarball names the asset cache entry. Missing digests fail closed. */
export function assetKey(asset: { digest?: unknown }): string {
  const digest = typeof asset.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1] : undefined;
  if (!digest) throw Error('The published bundle requires a sha256: digest from GitHub; no valid SHA-256 digest was published');
  return digest;
}
interface ReleaseSettings { repository: string; tag: string }
async function releaseSettings(): Promise<ReleaseSettings> {
  const { env, engine } = await engineBundle();
  const { NodeSystem, processEnvironment } = await import('@parity/product-lab/composition');
  return env.engineReleaseSettings(new NodeSystem(processEnvironment()).files, engine.checkout, process.env);
}
const bundleAsset = `fork-bundle-${NETWORK}.tar.gz`;
const bundleUrl = ({ repository, tag }: ReleaseSettings) => `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${bundleAsset}`;

/** Read only the release's asset list. Never request the archive, even a range of it. */
export async function lookupBundle(settings?: ReleaseSettings, fetchImpl: typeof fetch = fetch) {
  const { repository, tag } = settings ?? await releaseSettings();
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'humanity-lab' };
  if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, { headers, signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw Error(`GitHub answered ${response.status} for ${repository}@${tag}`);
  const release = row(await response.json());
  const asset = list(release.assets).map(row).find(entry => entry.name === bundleAsset);
  if (!asset) throw Error(`${repository}@${tag} publishes no ${bundleAsset}`);
  output({ 'asset-key': assetKey(asset), asset: `${repository}@${tag} ${bundleAsset}` });
}

/** What the setup job pinned, kept beside the bundle's cache entry so a cached run can name it without the bundle. */
export interface BundlePin { manifestSha256: string; source: string; bittenAt: string; assetKey: string }
export function readPin(text: string, key: string): BundlePin {
  const pin = row(JSON.parse(text));
  if (typeof pin.manifestSha256 !== 'string' || !PIN.test(pin.manifestSha256) || pin.assetKey !== key || typeof pin.source !== 'string' || typeof pin.bittenAt !== 'string') throw Error('The cached bundle pin is not this bundle\'s');
  return pin as unknown as BundlePin;
}

/** Only transport failures may restart a download; retry logs use fixed reasons, never error text or URLs. */
function networkFailure(error: unknown): string | undefined {
  const { name, code } = row(error);
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return 'timeout';
  if (error instanceof TypeError || ['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(String(code))) return 'network error';
  return undefined;
}

/** Retain verified bytes only. Restart transient downloads at most twice, each in a new exclusive file. */
export async function downloadArchive(url: string, archive: string, expectedKey?: string, fetchImpl: typeof fetch = fetch, wait: (ms: number) => Promise<unknown> = pause) {
  if (expectedKey !== undefined && !PIN.test(expectedKey)) throw Error('No looked-up bundle SHA-256');
  const directory = mkdtempSync(join(dirname(archive), 'bundle-attempts-'));
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const temporary = join(directory, `attempt-${attempt}.tar.gz`);
      const file = await open(temporary, 'wx');
      let retryReason: string | undefined;
      try {
        try {
          let response: Response;
          try { response = await fetchImpl(url, { signal: AbortSignal.timeout(1_800_000) }); }
          catch (error) { retryReason = networkFailure(error); throw error; }
          if (!response.ok || !response.body) {
            if (response.status === 429 || response.status >= 500 && response.status <= 599) retryReason = `HTTP ${response.status}`;
            await response.body?.cancel().catch(() => {});
            throw Error(`The bundle download answered ${response.status}`);
          }
          const source = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
          source.on('error', error => { retryReason = networkFailure(error); });
          await pipeline(source, file.createWriteStream());
          const digest = createHash('sha256');
          for await (const chunk of createReadStream(temporary)) digest.update(chunk);
          if (expectedKey !== undefined && digest.digest('hex') !== expectedKey) throw Error('The published bundle changed during the download; re-run');
          // Publishing by hard link preserves exclusive creation of the destination, on the same filesystem.
          linkSync(temporary, archive);
          return;
        } finally { await file.close(); }
      } catch (error) {
        rmSync(temporary, { force: true });
        if (!retryReason || attempt === 3) throw error;
        console.log(`Bundle download retry ${attempt + 1}/3: ${retryReason}`);
        await wait(2_000);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Engine's fetch-bundle deletes its tarball without hashing it. Keep our one download until verified, then use
 * the same tar extraction and product-lab's own verified incoming-bundle installation path. */
async function downloadBundle(expectedKey?: string) {
  const { env, target, marked } = await engineBundle();
  if (existsSync(target)) throw Error('A bundle is already in the Engine workspace; the pin must come from one fresh download');
  const settings = await releaseSettings();
  mkdirSync(dirname(target), { recursive: true });
  const temporary = mkdtempSync(join(dirname(target), 'bundle-download-'));
  const archive = join(temporary, bundleAsset), incoming = env.incomingBundle(target);
  try {
    await downloadArchive(bundleUrl(settings), archive, expectedKey);
    if (existsSync(incoming)) throw Error('An incoming bundle is already present; refusing to mix downloads');
    mkdirSync(incoming);
    const extracted = spawnSync('tar', ['-xzf', archive, '-C', incoming], { stdio: 'inherit', timeout: 1_800_000 });
    if (extracted.status !== 0) throw Error(`Bundle extraction failed (${extracted.status ?? extracted.signal})`);
    await env.installIncomingBundle(target, 'download');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const pin = marked();
  if (!pin || !PIN.test(pin) || pin !== sha256(join(target, 'manifest.json'))) throw Error('The downloaded bundle is not marked complete');
  const bittenAt = row(JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'))).bittenAt;
  return { target, pin, source: `${settings.repository}@${settings.tag} ${bundleAsset}`, bittenAt: typeof bittenAt === 'string' ? bittenAt : 'unavailable' };
}

/**
 * The setup job only: the one place a run resolves the published bundle. With this asset's bundle and pin already
 * cached (`CACHED=true`) it only names the cached pin. Otherwise the bundle is downloaded once, checked to be the
 * looked-up asset (its tarball SHA-256), pinned by its manifest SHA-256 and moved to `out` for the cache, its pin to `pins`.
 */
export async function pinBundle(out: string, pins: string, key: string, cached: boolean, download = () => downloadBundle(key)) {
  if (!PIN.test(key)) throw Error('No looked-up bundle asset');
  if (cached) {
    const pin = readPin(readFileSync(join(pins, 'pin.json'), 'utf8'), key);
    output({ 'manifest-sha256': pin.manifestSha256, source: pin.source, 'bitten-at': pin.bittenAt, seconds: 0, cached: 'true' });
    return;
  }
  if (existsSync(out)) throw Error('A bundle is already present; the pin must come from one fresh download');
  const started = Date.now(), fetched = await download();
  mkdirSync(dirname(out), { recursive: true });
  renameSync(fetched.target, out);
  mkdirSync(pins, { recursive: true });
  writeFileSync(join(pins, 'pin.json'), JSON.stringify({ manifestSha256: fetched.pin, source: fetched.source, bittenAt: fetched.bittenAt, assetKey: key } satisfies BundlePin) + '\n');
  output({ 'manifest-sha256': fetched.pin, source: fetched.source, 'bitten-at': fetched.bittenAt, seconds: Math.round((Date.now() - started) / 1000), cached: 'false' });
}

/**
 * A leg whose cache restore missed (an evicted entry, or a re-run after one was pruned) downloads the bundle itself and
 * uses it only if its manifest is the run's pin; a bundle Engine has since replaced fails the leg.
 */
export async function refetchPinnedBundle(out: string, pin: string, download: () => Promise<{ target: string; pin: string }> = downloadBundle) {
  if (!PIN.test(pin)) throw Error('No pinned bundle manifest SHA-256');
  if (existsSync(join(out, 'manifest.json'))) throw Error('A restored bundle is present; nothing to re-fetch');
  const fetched = await download();
  if (fetched.pin !== pin) throw Error(`The published bundle is now ${fetched.pin}, not the run's pinned ${pin}; re-run all jobs to pin the new one`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(dirname(out), { recursive: true });
  renameSync(fetched.target, out);
}

/** Every leg: install only the restored pinned bundle. Nothing here downloads; any other manifest fails the leg. */
export async function installPinnedBundle(restored: string, pin: string, started: number | null) {
  if (!PIN.test(pin)) throw Error('No pinned bundle manifest SHA-256');
  const found = existsSync(join(restored, 'manifest.json')) ? sha256(join(restored, 'manifest.json')) : 'absent';
  if (found !== pin) throw Error(`The restored bundle's manifest is ${found}, not the pinned ${pin}; no other bundle is used`);
  const { env, target, marked } = await engineBundle();
  if (existsSync(target)) throw Error('A bundle is already in the Engine workspace; this leg uses only the pinned one');
  rmSync(env.incomingBundle(target), { recursive: true, force: true });
  renameSync(restored, env.incomingBundle(target));
  await env.installIncomingBundle(target, 'pinned cache');
  if (marked() !== pin) throw Error('The installed bundle is not the pinned one');
  output({ seconds: started === null ? 'unavailable' : Math.round(Date.now() / 1000 - started) });
}

