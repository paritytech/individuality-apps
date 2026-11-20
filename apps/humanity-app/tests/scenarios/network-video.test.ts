// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { paintVideoFrames, waitForVideo } from './video-ready.ts';
import { browserAvailable } from '../chromium.ts';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PageFrameCapture, PlaywrightBrowserLauncher } from '@parity/product-lab/browser-playwright';
import type { BrowserLauncher, BrowserLaunchOptions } from '@parity/product-lab/ports/browser';
import { chromium } from 'playwright';
import { ScenarioNetwork } from '../../../../lab/shared/network.ts';

// Like network.test.ts, this needs the lab's Chromium; Humanity CI's unit job has none, so it skips there.
const browser = browserAvailable(chromium.executablePath());

/** What `product-lab test --video` hands a lab: pinned 0.1.0's recordingBrowsers (not exported)
 * adds recordVideo at `<PRODUCT_LAB_RECORDINGS_DIR>/videos`, the folder the leg uploads. */
function launcher(recordings: string | undefined): BrowserLauncher {
  const playwright = new PlaywrightBrowserLauncher();
  return { launch: (options: BrowserLaunchOptions = {}) => playwright.launch(recordings ? { ...options, recordVideo: options.recordVideo ?? { dir: join(recordings, 'videos') } } : options) };
}

async function guardedRun(recording: boolean, observe: (files: Array<{ name: string; bytes: number }>) => Array<{ name: string; bytes: number }> = files => files) {
  const root = mkdtempSync(join(process.cwd(), '.scenario-video-')), recordings = join(root, 'humanity-scenarios-recordings');
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>offline</title><h1>Ada</h1>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture port missing');
  const guard = new ScenarioNetwork(join(root, 'network')); guard.beginTag(['@A1']); guard.forActor('ada-1');
  const guarded = await guard.launch(launcher(recording ? recordings : undefined));
  let closed = false;
  try {
    const page = await guarded.newPage(); await page.goto(`http://127.0.0.1:${address.port}/`);
    await paintVideoFrames(page);
    const blocked = await page.evaluate(() => fetch('https://outside.invalid/').then(() => false, () => true), undefined);
    // The run's recording asks the session's frame capture for each actor's video while the page is open.
    const linked = await new PageFrameCapture({ pages: id => id === 'ada-1' ? page : undefined }).video('ada-1');
    const summary = await guard.snapshot();
    await guarded.close(); closed = true;
    const videos = join(recordings, 'videos');
    const read = () => observe(existsSync(videos) ? readdirSync(videos).map(name => ({ name, bytes: statSync(join(videos, name)).size })) : []);
    const files = recording ? await waitForVideo(read) : read();
    return { blocked, allowed: summary.outsideHostsAllowed, linked, files };
  } finally {
    if (!closed) await guarded.close();
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  }
}

it.skipIf(!browser)('records one video per guarded page where the leg uploads it, and links it for the summary', async () => {
  const run = await guardedRun(true);
  expect(run.blocked).toBe(true); expect(run.allowed).toEqual([]);
  expect(run.linked).toMatchObject({ mediaType: 'video/webm', name: expect.stringMatching(/\.webm$/) });
  expect(run.files).toEqual([{ name: run.linked!.name, bytes: expect.any(Number) }]);
  expect(run.files[0]!.bytes).toBeGreaterThan(0);
}, 30_000);

it.skipIf(!browser)('negative control: with recording off the same guarded run leaves no video and no link', async () => {
  const run = await guardedRun(false);
  expect(run.blocked).toBe(true); expect(run.allowed).toEqual([]);
  expect(run.linked).toBeUndefined();
  expect(run.files).toEqual([]);
}, 30_000);

it.skipIf(!browser)('@negative-control: a delayed encoder flush must become non-empty before the fixture returns', async () => {
  let reads = 0;
  // Hold the first two filesystem observations at zero, like the captured CI flush race. Keep the
  // actual guarded browser, video path and linked summary media; only the disk-observation delay is controlled.
  const run = await guardedRun(true, files => ++reads <= 2 ? files.map(file => ({ ...file, bytes: 0 })) : files);
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(run.files).toEqual([{ name: run.linked!.name, bytes: expect.any(Number) }]);
  expect(run.files[0]!.bytes).toBeGreaterThan(0);
}, 30_000);
