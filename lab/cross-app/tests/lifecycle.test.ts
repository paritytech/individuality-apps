// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { browserAvailable } from '../../../apps/humanity-app/tests/chromium.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
interface TestSocket { send(value: string): void }
interface TestSocketServer { once(event: 'connection', listener: (socket: TestSocket) => void): void; close(callback: (error?: Error) => void): void }
// The lab already installs ws; bind only this test's used surface without adding application dependencies.
const { WebSocketServer } = createRequire(import.meta.url)('ws') as { WebSocketServer: new(options: { server: Server }) => TestSocketServer };
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { ScenarioNetwork } from '../../shared/network.ts';
import { freezeLocalPage } from '../lifecycle.ts';

it.skipIf(!browserAvailable(chromium.executablePath()))('suspends real timers, preserves queued socket data and refuses a foreign page', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifecycle-test-')), browser = await chromium.launch({ headless: true });
  const http = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<body><span id="count">0</span><span id="state">old</span></body>'); });
  const sockets = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw Error('No local socket port');
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    const network = new ScenarioNetwork(directory), context = await browser.newContext(); await network.install(context);
    const page = await context.newPage(); await page.goto(url);
    const connected = new Promise<TestSocket>(resolve => sockets.once('connection', resolve));
    await page.evaluate(() => {
      setInterval(() => { const count = document.querySelector('#count')!; count.textContent = String(Number(count.textContent) + 1); }, 20);
      const socket = new WebSocket(location.origin.replace('http:', 'ws:'));
      socket.onmessage = event => { document.querySelector('#state')!.textContent = event.data; };
    });
    const socket = await connected;
    expect(() => network.localPage('https://example.com')).toThrow('loopback');
    expect(() => network.localPage('http://127.0.0.1:1')).toThrow('No guarded page');
    const before = Number(await page.locator('#count').textContent()), frozen = await freezeLocalPage(network, url, 'test');
    socket.send('fresh while suspended'); await new Promise(resolve => setTimeout(resolve, 200));
    const resumed = await frozen.resume();
    expect(Number(await page.locator('#count').textContent()) - before).toBeLessThan(6);
    await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'fresh while suspended');
    expect(resumed.lifecycle.visibility).toBe('visible');
    expect(resumed.mechanism).toContain('Debugger.pause/resume');
    await expect(frozen.resume()).rejects.toThrow('Already resumed'); await frozen.close();
    // Negative control: disabling execution drops a socket event instead of queuing it.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: true }); socket.send('must be dropped');
    await new Promise(resolve => setTimeout(resolve, 100)); await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });
    expect(await page.locator('#state').textContent()).toBe('fresh while suspended');
    await cdp.detach();
  } finally {
    await browser.close(); await new Promise<void>(resolve => sockets.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
