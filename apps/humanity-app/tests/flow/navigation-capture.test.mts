// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, expect, it, vi } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { captureNavigationEvents } from '../../lab/flows/navigation-capture.ts';
const key = 'product-lab:dim2-navigation:v1';
afterEach(() => vi.restoreAllMocks());
function surface(available = true, path = '/prize-draw?identity=private-fixture', origin = 100) {
  // Real EventTargets and a VM document realm; storage is a same-tab Map fixture, not product state.
  const data = new Map<string, string>();
  const w = Object.assign(new EventTarget(), { location: new URL('http://flow.invalid' + path), performance: { timeOrigin: origin },
    sessionStorage: { getItem: (name: string) => data.get(name) ?? null, setItem: (name: string, value: string) => { data.set(name, String(value)); } } });
  const navigation = new EventTarget();
  if (available) Object.defineProperty(w, 'navigation', { value: navigation });
  const globals = { window: w, location: w.location, performance: w.performance, URL, Date, Symbol };
  Object.defineProperty(globals, 'sessionStorage', { get: () => w.sessionStorage });
  const realm = createContext(globals);
  const evaluate = vi.fn(async (read: (arg: unknown) => unknown, arg: unknown) => runInContext(`(${read.toString()})(${JSON.stringify(arg)})`, realm));
  const page = { evaluate } as unknown as BrowserPage;
  const navigate = (path: string, type = 'replace', flags = { userInitiated: false, hashChange: false }) => {
    const event = new Event('navigate');
    Object.defineProperties(event, { destination: { value: { url: new URL(path, w.location.href).href } }, navigationType: { value: type },
      userInitiated: { value: flags.userInitiated }, hashChange: { value: flags.hashChange } });
    navigation.dispatchEvent(event);
  };
  const hide = (persisted = false) => { const event = new Event('pagehide'); Object.defineProperty(event, 'persisted', { value: persisted }); return w.dispatchEvent(event); };
  return { w, page, evaluate, navigation, navigate, hide };
}
async function snapshot(h: ReturnType<typeof surface>) {
  const value = await captureNavigationEvents(h.page);
  if (!('records' in value)) throw new Error('Expected readable document');
  return value;
}
it.each([['push', 1], ['replace', 2], ['reload', 3], ['traverse', 4]] as const)('records %s navigate before pagehide with numeric kind/path and boolean flags', async (type, kind) => {
  const h = surface(); await captureNavigationEvents(h.page, 1); expect(h.evaluate).toHaveBeenCalledTimes(1);
  h.navigate('/?password=private-fixture', type, { userInitiated: true, hashChange: true }); h.hide(true);
  const result = await snapshot(h); expect(result.records.map(r => r.kind)).toEqual([0, 1, 2]);
  expect(result.records[1]).toMatchObject({ path: 1, sameOrigin: true, navigationType: kind, userInitiated: true, hashChange: true, phase: 1, navigationAvailable: true });
  expect(result.records[2]).toMatchObject({ persisted: true, navigationType: 0 });
  expect(result.records[1].at).toBeLessThanOrEqual(result.records[2].at);
  expect(result).toMatchObject({ storageReadable: true, storagePresent: true, dataValid: true });
});
it('records pagehide without a navigate event, with an explicit available installation and no invented event', async () => {
  const h = surface(); await captureNavigationEvents(h.page, 1); h.hide();
  const result = await snapshot(h); expect(result.records.map(r => r.kind)).toEqual([0, 2]);
  expect(result.records[0]).toMatchObject({ navigationAvailable: true }); expect(result.records[1].persisted).toBe(false);
});
it('records Navigation API unavailability while keeping pagehide evidence and the flow usable', async () => {
  const h = surface(false); const installed = await captureNavigationEvents(h.page, 1); h.hide();
  expect(installed).toMatchObject({ installedHere: true, navigationAvailable: false, pagehideAvailable: true });
  expect((await snapshot(h)).records.map(r => [r.kind, r.navigationAvailable])).toEqual([[0, false], [2, false]]);
});
it('@negative-control blocked storage is unavailable, never empty successful evidence', async () => {
  const h = surface(); Object.defineProperty(h.w, 'sessionStorage', { get: () => { throw new Error('private-fixture'); } });
  const installed = await captureNavigationEvents(h.page, 1); h.navigate('/'); h.hide();
  expect(installed).toMatchObject({ storageReadable: false, storageWritable: false, writeFailedHere: true, dataValid: false });
  expect(await snapshot(h)).toMatchObject({ storageReadable: false, storagePresent: false, dataValid: false, records: [] });
});
it('preserves failed-write coverage when storage becomes writable again', async () => {
  const h = surface(); const set = vi.spyOn(h.w.sessionStorage, 'setItem').mockImplementation(() => { throw new Error('private-fixture'); });
  expect(await captureNavigationEvents(h.page, 1)).toMatchObject({ storageReadable: true, storageWritable: false, writeFailedHere: true });
  set.mockRestore(); h.navigate('/'); h.hide();
  expect(await snapshot(h)).toMatchObject({ writeFailures: 1, dataValid: true, storageWritable: true });
});
it('is idempotent across repeated installs, updates phase, and writes exactly one namespaced key', async () => {
  const h = surface(); h.w.sessionStorage.setItem('jollity.postGame', 'private-fixture');
  const add = vi.spyOn(h.navigation, 'addEventListener'), writes = vi.spyOn(h.w.sessionStorage, 'setItem');
  for (const phase of [1, 1, 2, 2] as const) await captureNavigationEvents(h.page, phase);
  h.navigate('/chest?game=308'); h.hide();
  const result = await snapshot(h); expect(add).toHaveBeenCalledTimes(1);
  expect(result.records.map(r => [r.kind, r.phase])).toEqual([[0, 1], [0, 2], [1, 2], [2, 2]]);
  expect(writes.mock.calls.every(([name]) => name === key)).toBe(true); expect(h.w.sessionStorage.getItem('jollity.postGame')).toBe('private-fixture');
});
it('retains the first document trail across a same-tab replacement and distinguishes the post-reopen phase', async () => {
  const first = surface(); await captureNavigationEvents(first.page, 1); first.navigate('/'); first.hide();
  const next = surface(true, '/', 200); next.w.sessionStorage.setItem(key, first.w.sessionStorage.getItem(key)!);
  expect(await snapshot(next)).toMatchObject({ installedHere: false, origin: 200 });
  await captureNavigationEvents(next.page, 2); next.navigate('/chest?game=308', 'replace'); next.navigate('/', 'replace'); next.hide();
  const result = await snapshot(next);
  expect(result.records.map(r => [r.kind, r.phase, r.path, r.origin])).toEqual([
    [0, 1, 3, 100], [1, 1, 1, 100], [2, 1, 3, 100], [0, 2, 1, 200], [1, 2, 2, 200], [1, 2, 1, 200], [2, 2, 1, 200],
  ]);
});
it('bounds the persisted ring to 64 rows and records lost coverage', async () => {
  const h = surface(); await captureNavigationEvents(h.page, 1);
  for (let i = 0; i < 100; i++) h.navigate('/chest?game=' + i);
  const result = await snapshot(h); expect(result.records).toHaveLength(64); expect(result.dropped).toBe(37);
  expect(h.w.sessionStorage.getItem(key)!.length).toBeLessThan(32_768);
});
it('@negative-control projects only finite numbers and booleans, never raw URLs, query or injected storage text', async () => {
  const h = surface(); await captureNavigationEvents(h.page, 1); h.navigate('https://private-fixture.invalid/?password=private-fixture', 'unknown');
  const stored = JSON.parse(h.w.sessionStorage.getItem(key)!); stored.unsafe = 'private-fixture'; stored.records[1].url = 'private-fixture';
  h.w.sessionStorage.setItem(key, JSON.stringify(stored));
  const result = await snapshot(h); expect(result.records[1]).toMatchObject({ path: 0, sameOrigin: false, navigationType: 0 });
  expect(result.records.every(row => Object.values(row).every(v => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))))).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private-fixture|password|https|unsafe|"url"/);
  await captureNavigationEvents(h.page, 2); expect(h.w.sessionStorage.getItem(key)).not.toContain('private-fixture');
});
it.each(['{', 'x'.repeat(40_000), JSON.stringify({ version: 1, dropped: 0, damaged: false, writeFailures: 0, records: [{ at: null, kind: 99, url: 'private-fixture' }] })])('@negative-control malformed/oversized storage remains damaged, including after reinstallation (%#)', async raw => {
  const h = surface(); h.w.sessionStorage.setItem(key, raw);
  expect(await snapshot(h)).toMatchObject({ storageReadable: true, storagePresent: true, dataValid: false, damaged: true });
  expect(await captureNavigationEvents(h.page, 1)).toMatchObject({ dataValid: false, damaged: true });
  expect(JSON.stringify(await snapshot(h))).not.toContain('private-fixture');
});
it('handles an unusable Navigation API as unavailable instead of failing the scenario', async () => {
  const h = surface(); vi.spyOn(h.navigation, 'addEventListener').mockImplementation(() => { throw new Error('private-fixture'); });
  expect(await captureNavigationEvents(h.page, 1)).toMatchObject({ navigationAvailable: false, pagehideAvailable: true });
});
it('marks a document replacement unavailable and preserves other browser errors', async () => {
  const page = { evaluate: vi.fn().mockRejectedValueOnce(new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')).mockRejectedValueOnce(new Error('Target page has been closed')) } as unknown as BrowserPage;
  expect(await captureNavigationEvents(page, 1)).toEqual({ documentAvailable: false });
  await expect(captureNavigationEvents(page)).rejects.toThrow('Target page has been closed');
});
it('installs once per actor after payoff in the actual step-12 group', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const fixture = fileURLToPath(new URL('./fixtures/payoff-navigation-sequence.mts', import.meta.url));
  expect(execFileSync('node', ['--import', 'tsx', fixture], { encoding: 'utf8', timeout: 30_000 })).toContain('actual step 12 installs once per actor after payoff');
}, 35_000);
