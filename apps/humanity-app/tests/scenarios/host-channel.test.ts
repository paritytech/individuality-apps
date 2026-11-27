// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { browserAvailable } from '../chromium.ts';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
interface FixtureSocket {
  on(event: 'message', listener: (bytes: Buffer, binary: boolean) => void): void;
  close(code: number): void; terminate(): void;
  send(bytes: Uint8Array, options: { binary: boolean }): void;
}
const { WebSocketServer } = createRequire(import.meta.url)('ws') as { WebSocketServer: new (options: { server: Server }) => {
  on(event: 'connection', listener: (socket: FixtureSocket) => void): void;
  clients: Set<FixtureSocket>; close(done: () => void): void;
} };
import { expect, it } from 'vitest';
import { PlaywrightBrowserLauncher } from '@parity/product-lab/browser-playwright';
import { chromium } from 'playwright';
import { decodeWireMessage, encodeWireMessage, scale, VersionedHostGetUserIdResponse, VersionedHostGetUserIdError,
  VersionedHostHandshakeResponse, VersionedHostHandshakeError } from '@parity/truapi';
import { ACCOUNT_GET_USER_ID, SYSTEM_HANDSHAKE } from '@parity/truapi/wire-table';
import { ScenarioNetwork } from '../../../../lab/shared/network.ts';

// Real 0.27.0 npm transport/client and binary SCALE frames, with a synthetic identity and loopback
// frame server. No signing host, chain, wallet or remote endpoint is opened.
// These need the lab's Chromium and the cached locked CLI host (0.31.0). Humanity CI's unit job has neither, so they skip there and
// run where the lab is prepared.
const lock = JSON.parse(readFileSync(new URL('../../lab/opening/host.lock.json', import.meta.url), 'utf8')) as { official: { version: string } };
const containerPath = process.env.HUMANITY_SCENARIOS_HOST_CONTAINER ?? join(homedir(), '.cache', 'e2e-nightly', 'hosts', 'truapi-cli', lock.official.version, 'bin', 'sandbox-assets', 'container.js');
const browser = browserAvailable(chromium.executablePath());
it.skipIf(!browser)('preserves the real binary host identity channel through the guarded browser', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.scenario-host-channel-'));
  const bundled = await build({ stdin: { contents: `
    import { createHostConnection } from '@parity/truapi/internal';
    const connection = createHostConnection(window.__truapi_localhost.url);
    window.__HOST_API_CLIENT__ = { get client() { return connection.client; } };
    window.readIdentity = async () => (await window.__HOST_API_CLIENT__.client.account.getUserId()).match(
      value => value.primaryUsername, error => { throw error; });
    window.addEventListener('pagehide', () => connection.dispose());
  `, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const server = createServer((request, response) => {
    response.setHeader('content-type', request.url === '/bootstrap.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/bootstrap.js' ? bundled.outputFiles[0]!.text :
      `<!doctype html><script>window.__truapi_localhost={url:'ws://127.0.0.1:${port}/?bridge_token=redact-me'};</script><script src="/bootstrap.js"></script>`);
  });
  const sockets = new WebSocketServer({ server });
  const calls: string[] = [];
  sockets.on('connection', socket => socket.on('message', (bytes, binary) => {
    if (!binary) { socket.close(1008); return; }
    const frame = decodeWireMessage(new Uint8Array(bytes as Buffer))._unsafeUnwrap();
    const { traitId, methodId } = frame.payload;
    let value: Uint8Array;
    if (traitId === SYSTEM_HANDSHAKE.trait && methodId === SYSTEM_HANDSHAKE.method) {
      calls.push('system.handshake');
      value = scale.Result(VersionedHostHandshakeResponse, scale.CallError(VersionedHostHandshakeError)).enc({ success: true, value: { tag: 'V1', value: undefined } });
    } else if (traitId === ACCOUNT_GET_USER_ID.trait && methodId === ACCOUNT_GET_USER_ID.method) {
      calls.push('account.getUserId');
      value = scale.Result(VersionedHostGetUserIdResponse, scale.CallError(VersionedHostGetUserIdError)).enc({ success: true, value: { tag: 'V1', value: { primaryUsername: 'fixture.01' } } });
    } else { socket.close(1008); return; }
    socket.send(encodeWireMessage({ requestId: frame.requestId, payload: { traitId, methodId, messageType: 1, value } })._unsafeUnwrap(), { binary: true });
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture port missing');
  const port = address.port;
  const guard = new ScenarioNetwork(directory); guard.beginTag(['@A1']); guard.forActor('ada-1');
  const browser = await guard.launch(new PlaywrightBrowserLauncher());
  try {
    const page = await browser.newPage();
    const errors: string[] = []; page.onPageError?.(error => errors.push(error));
    await page.goto(`http://127.0.0.1:${port}/`);
    const shape = await page.evaluate(() => ({
      binaryTypeSetter: typeof Object.getOwnPropertyDescriptor(WebSocket.prototype, 'binaryType')?.set,
      identityBridge: '__HOST_API_CLIENT__' in window,
    }), undefined);
    expect({ shape, errors }).toEqual({ shape: { binaryTypeSetter: 'function', identityBridge: true }, errors: [] });
    const identity = await page.evaluate(async () => (window as typeof window & { readIdentity(): Promise<string> }).readIdentity(), undefined);
    expect(identity).toBe('fixture.01'); expect(calls).toEqual(['system.handshake', 'account.getUserId']);
    const summary = await guard.snapshot();
    expect(summary.requests.find(e => e.host === `ws://127.0.0.1:${port}`)).toMatchObject({ outside: false, decision: 'loopback' });
    expect(JSON.stringify(summary)).not.toContain('redact-me');
    if (process.env.HUMANITY_SCENARIOS_HOST_FIXTURE_REPORT) writeFileSync(process.env.HUMANITY_SCENARIOS_HOST_FIXTURE_REPORT, JSON.stringify({ shape, identity, calls, summary }, null, 2) + '\n');
  } finally {
    await browser.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

// Adapted from the coordinator's reviewer control. Read the locked container asset in place;
// serve it only on loopback. A local sink counts binary frames and never runs a signing host.
it('locks the 0.31.0 host', () => { expect(lock.official.version).toBe('0.31.0'); });

it.skipIf(!browser || !existsSync(containerPath))('loads the real cached host container and opens exactly one native loopback socket', async () => {
  const container = readFileSync(containerPath, 'utf8');
  const sha256 = createHash('sha256').update(container).digest('hex');
  const directory = mkdtempSync(join(process.cwd(), '.scenario-host-container-'));
  let port = 0, serverSockets = 0, serverFrames = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', request.url === '/bootstrap.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/bootstrap.js' ? `window.__truapi_localhost={url:'ws://127.0.0.1:${port}/'};\n${container}` :
      '<!doctype html><script src="/bootstrap.js"></script><p>offline host container</p>');
  });
  const sockets = new WebSocketServer({ server });
  let firstFrame!: () => void;
  const frameSeen = new Promise<void>(resolve => { firstFrame = resolve; });
  sockets.on('connection', socket => { serverSockets++; socket.on('message', (_frame, binary) => { if (binary) { serverFrames++; firstFrame(); } }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture port missing'); port = address.port;
  const guard = new ScenarioNetwork(directory); guard.beginTag(['@A1']); guard.forActor('ada-1');
  const browser = await guard.launch(new PlaywrightBrowserLauncher());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const page = await browser.newPage(), pageErrors: string[] = [];
    page.onPageError?.(error => pageErrors.push(error)); await page.goto(`http://127.0.0.1:${port}/`);
    const shape = await page.evaluate(() => {
      const host = window as typeof window & { __HOST_API_CLIENT__?: { readonly client: unknown; subscribeConnectionStatus(listener: (status: string) => void): () => void }; __HOST_WEBVIEW_MARK__?: boolean };
      const statuses: string[] = [];
      const unsubscribe = host.__HOST_API_CLIENT__?.subscribeConnectionStatus(status => statuses.push(status));
      void host.__HOST_API_CLIENT__?.client; unsubscribe?.();
      return { client: typeof host.__HOST_API_CLIENT__, port: '__HOST_API_PORT__' in window, mark: host.__HOST_WEBVIEW_MARK__ === true, statuses };
    }, undefined);
    expect({ shape, pageErrors }).toMatchObject({ shape: { client: 'object', port: true, mark: true }, pageErrors: [] });
    await Promise.race([frameSeen, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('Host container sent no binary frame')), 5000); })]);
    expect(serverSockets).toBe(1); expect(serverFrames).toBeGreaterThanOrEqual(1);
    // The server can see the first frame before Playwright delivers the page's websocket event to the guard.
    const socketRecords = (value: Awaited<ReturnType<typeof guard.snapshot>>) => value.requests.filter(e => e.method === 'WEBSOCKET' && e.host === `ws://127.0.0.1:${port}`);
    let summary = await guard.snapshot();
    for (const deadline = Date.now() + 5000; !socketRecords(summary).length && Date.now() < deadline; summary = await guard.snapshot()) await new Promise(resolve => setTimeout(resolve, 50));
    expect(socketRecords(summary)).toHaveLength(1);
    expect(summary.outsideSocketFrameViolations).toBe(0);
    if (process.env.HUMANITY_SCENARIOS_CONTAINER_FIXTURE_REPORT) writeFileSync(process.env.HUMANITY_SCENARIOS_CONTAINER_FIXTURE_REPORT, JSON.stringify({ version: lock.official.version, sha256, shape, pageErrors, serverSockets, serverFrames, summary }, null, 2) + '\n');
    expect(createHash('sha256').update(readFileSync(containerPath)).digest('hex')).toBe(sha256);
  } finally {
    clearTimeout(timer); await browser.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
