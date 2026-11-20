// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { browserAvailable } from '../chromium.ts';
import { createServer, request } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PlaywrightBrowserLauncher } from '@parity/product-lab/browser-playwright';
import { proxyTarget, requestAddress, ScenarioNetwork, scenarioContextOptions, videoFrame } from '../../../../lab/shared/network.ts';
import type { Browser, BrowserLaunchOptions } from '@parity/product-lab/ports/browser';
import type { BrowserContext as RawContext, Page as RawPage } from 'playwright';
import { chromium } from 'playwright';

// The guarded-browser case needs the lab's Chromium; Humanity CI's unit job has none, so it skips there.
const browser = browserAvailable(chromium.executablePath());

it('redacts URL credentials, path identifiers and query values, and refuses lookalike hosts', () => {
  expect(requestAddress('https://key:secret@o123.ingest.de.sentry.io/api/123/envelope/?sentry_key=secret')).toEqual({
    host: 'https://o123.ingest.de.sentry.io', pathClass: '/api/<n>/envelope/', loopback: false, sentry: true, network: true,
  });
  expect(requestAddress('http://localhost.attacker.invalid/')).toMatchObject({ loopback: false, sentry: false });
  expect(requestAddress('https://o1.ingest.sentry.io.attacker.invalid/')).toMatchObject({ sentry: false });
  expect(requestAddress('https://127.0.0.1.attacker.invalid/')).toMatchObject({ loopback: false });
});

it('classifies proxy targets without retaining a raw target or raw headers', () => {
  expect(proxyTarget('GET', 'https://key:redact-me@outside.invalid:8443/private?token=redact-me')).toEqual({ form: 'absolute-form', scheme: 'https', host: 'outside.invalid:8443', hostSource: 'request-target' });
  expect(proxyTarget('CONNECT', 'outside.invalid:443')).toEqual({ form: 'authority-form', scheme: null, host: 'outside.invalid:443', hostSource: 'request-target' });
  expect(proxyTarget('GET', '/private?token=redact-me', 'outside.invalid:80')).toEqual({ form: 'origin-form', scheme: null, host: 'outside.invalid', hostSource: 'host-field' });
  expect(proxyTarget('OPTIONS', '*', '[::1]:1234')).toEqual({ form: 'asterisk-form', scheme: null, host: '[::1]:1234', hostSource: 'host-field' });
  expect(proxyTarget('GET', 'redact-me')).toEqual({ form: 'unrecognized', scheme: null, host: null, hostSource: 'unavailable' });
  expect(proxyTarget('GET', '/', 'redact-me@outside.invalid')).toMatchObject({ host: null });
});

it('counts each sent or received frame on a blocked socket as a violation without saving its payload', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.scenario-socket-violation-'));
  const guard = new ScenarioNetwork(directory); guard.beginTag(['@A1']); guard.forActor('ada-1');
  const context = Object.assign(new EventEmitter(), { pages: () => [], browser: () => null, route: async () => undefined });
  try {
    await guard.install(context as unknown as RawContext);
    const page = new EventEmitter(), socket = Object.assign(new EventEmitter(), { url: () => 'wss://outside.invalid/private?secret=redact-me' });
    context.emit('page', page); page.emit('websocket', socket);
    socket.emit('framesent', { payload: 'redact-me' }); socket.emit('framereceived', { payload: Buffer.from('redact-me') });
    const summary = await guard.snapshot();
    expect(summary.outsideSocketFrameViolations).toBe(2);
    expect(summary.requests[0]).toMatchObject({ decision: 'blocked', socketFramesSent: 1, socketFramesReceived: 1, bytesUp: 9, bytesDown: 9, outsideFrameViolations: 2 });
    expect(JSON.stringify(summary)).not.toContain('redact-me');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('keeps a bounded, sanitized console history per actor page, including uncaught page errors, and never the raw line', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.scenario-console-'));
  const guard = new ScenarioNetwork(directory); guard.beginTag(['@A3']); guard.forActor('ada-1');
  const context = Object.assign(new EventEmitter(), { pages: () => [], browser: () => null, route: async () => undefined });
  try {
    await guard.install(context as unknown as RawContext);
    const page = Object.assign(new EventEmitter(), { url: () => 'http://127.0.0.1:1/?token=redact-me' });
    const probed: string[] = []; guard.consoleProbes.add(message => probed.push(message.text));
    context.emit('page', page);
    page.emit('console', { type: () => 'error', text: () => '[humanity] username upgrade failed; code=lite-owner-unavailable' });
    page.emit('console', { type: () => 'log', text: () => 'fetch https://outside.invalid/x?token=redact-me from /Users/redact-me/app' });
    page.emit('pageerror', Error('boom at http://127.0.0.1:1/app.js?v=redact-me'));
    const [history] = guard.consoleHistory.evidence();
    expect(history).toMatchObject({ actor: 'ada-1', page: 'context-1/page-1', recorded: 3, dropped: 0 });
    expect(history!.entries.map(entry => [entry.type, entry.text])).toEqual([
      ['error', '[humanity] username upgrade failed; code=lite-owner-unavailable'],
      ['log', 'fetch https://outside.invalid/<path>?<query> from <local path>'],
      ['pageerror', 'boom at http://127.0.0.1:1/<asset>?<query>']]);
    expect(JSON.stringify(guard.consoleHistory.evidence())).not.toContain('redact-me');
    // The cross-app probes still see their lines; the history neither replaces nor filters them.
    expect(probed).toHaveLength(2);
    expect(JSON.stringify(await guard.snapshot())).not.toContain('redact-me');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('keeps each context\'s pages apart in one actor\'s console history, though page ids restart per context', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.scenario-console-contexts-'));
  const guard = new ScenarioNetwork(directory); guard.beginTag(['@C1']); guard.forActor('ada-1');
  const context = () => Object.assign(new EventEmitter(), { pages: () => [], browser: () => null, route: async () => undefined });
  try {
    // The cross-app lab opens Humanity's and Jollity's contexts for the same Ada; each has its own page-1.
    const humanity = context(), jollity = context();
    await guard.install(humanity as unknown as RawContext); await guard.install(jollity as unknown as RawContext);
    const first = Object.assign(new EventEmitter(), { url: () => 'http://127.0.0.1:1/' }), second = Object.assign(new EventEmitter(), { url: () => 'http://127.0.0.1:2/' });
    humanity.emit('page', first); jollity.emit('page', second);
    first.emit('console', { type: () => 'log', text: () => 'humanity ready' });
    second.emit('console', { type: () => 'log', text: () => 'jollity ready' });
    expect(guard.consoleHistory.evidence().map(page => [page.actor, page.page, page.entries.map(entry => entry.text)])).toEqual([
      ['ada-1', 'context-1/page-1', ['humanity ready']], ['ada-1', 'context-2/page-1', ['jollity ready']]]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// Run this suite in the report's loopback-only OS sandbox. Every served fixture is loopback;
// all outside test names are intentionally denied, including when a mutation removes a guard.
it.skipIf(!browser)('observes before navigation, blocks outside page/worker/socket requests and locally answers Sentry envelopes', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.scenario-network-'));
  const server = createServer((request, response) => {
    response.setHeader('content-type', request.url?.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(request.url === '/worker.js' ? "fetch('https://worker.invalid/private?secret=redact-me').catch(() => undefined).finally(() => postMessage('done'))" : request.url === '/sw.js' ?
      "self.addEventListener('install', e => e.waitUntil(self.skipWaiting())); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));" : '<!doctype html><title>offline</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture port missing');
  const guard = new ScenarioNetwork(directory); guard.beginTag(['@environment:paseo-copy', '@A5']); guard.forActor('ada-1');
  const launcher = new PlaywrightBrowserLauncher();
  let rawBrowser!: Browser;
  let proxyUrl!: string;
  const browser = await guard.launch({ launch: async (options?: BrowserLaunchOptions) => {
    proxyUrl = options?.args?.find(arg => arg.startsWith('--proxy-server='))?.slice('--proxy-server='.length) ?? '';
    rawBrowser = await launcher.launch(options); return rawBrowser;
  } });
  try {
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${address.port}/`);
    const context = await browser.newContext();
    await expect(context.routeWebSocket('**/*', () => undefined)).rejects.toThrow('refuses WebSocket routing');
    const rawPage = (page as unknown as { page: RawPage }).page;
    await expect(rawPage.context().routeWebSocket('**/*', () => undefined)).rejects.toThrow('refuses WebSocket routing');
    await expect(rawPage.routeWebSocket('**/*', () => undefined)).rejects.toThrow('refuses WebSocket routing');
    await context.close();
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register('/sw.js');
      if (registration) await navigator.serviceWorker.ready;
    }, undefined);
    await page.reload();
    expect(await page.evaluate(() => navigator.serviceWorker.controller === null, undefined)).toBe(true);
    const result = await page.evaluate(async () => {
      const blocked = await fetch('https://outside.invalid/private?secret=redact-me').then(() => false, () => true);
      const sentry = await fetch('https://o123.ingest.de.sentry.io/api/123/envelope/?sentry_key=redact-me', { method: 'POST', body: 'redact-me', headers: { 'content-type': 'text/plain' } }).then(r => r.status);
      const sentryOther = await fetch('https://o456.ingest.sentry.io/api/456/envelope/', { method: 'POST', body: 'fake', headers: { 'content-type': 'text/plain' } }).then(r => r.status);
      await new Promise<void>(resolve => { const worker = new Worker('/worker.js'); worker.onmessage = () => { worker.terminate(); resolve(); }; });
      await new Promise<void>(resolve => { const socket = new WebSocket('wss://socket.invalid/private?secret=redact-me'); socket.onclose = () => resolve(); socket.onerror = () => resolve(); });
      return { blocked, sentry, sentryOther };
    }, undefined);
    expect(result).toEqual({ blocked: true, sentry: 200, sentryOther: 200 });
    // The real page console reaches the bounded history through the guarded context, sanitized.
    await page.evaluate(() => { console.error('[humanity] username upgrade failed; code=lite-owner-unavailable'); console.log('https://outside.invalid/x?token=redact-me'); }, undefined);
    await expect.poll(() => guard.consoleHistory.evidence().flatMap(p => p.entries.map(e => e.text))).toEqual(expect.arrayContaining(['[humanity] username upgrade failed; code=lite-owner-unavailable', 'https://outside.invalid/<path>?<query>']));
    expect(guard.consoleHistory.evidence().every(p => p.actor === 'ada-1')).toBe(true);
    expect(JSON.stringify(guard.consoleHistory.evidence())).not.toContain('redact-me');
    const summary = await guard.snapshot();
    expect(summary.outsideHostsAllowed).toEqual([]);
    const count = summary.counts.find(c => c.tag === '@A5')!;
    expect(count).toMatchObject({ allowed: 0, sentryLocal: 2, pending: 0 });
    expect(count.attempted).toBeGreaterThanOrEqual(5); expect(count.blocked).toBe(count.attempted - 2);
    const fixtures = summary.requests.filter(e => e.source !== 'deny-proxy' && /(?:outside|worker|socket)\.invalid|o(?:123|456)\.ingest/.test(e.host));
    expect(fixtures).toHaveLength(5); expect(fixtures.filter(e => e.decision === 'blocked')).toHaveLength(3);
    expect(summary.requests.find(e => e.host === 'https://outside.invalid')).toMatchObject({ decision: 'blocked', failure: 'net::ERR_BLOCKED_BY_CLIENT', actor: 'ada-1', app: 'peopl', tag: '@A5' });
    expect(summary.requests.find(e => e.host === `http://127.0.0.1:${address.port}`)).toMatchObject({ status: 200 });
    expect(summary.framework.length).toBeGreaterThan(0);
    expect(summary.framework[0]).toMatchObject({ coverage: { beforeNavigation: true, pages: true, workers: true } }); expect(summary.coverage.full).toBe(false);
    const requests = readFileSync(join(directory, 'requests-ada-1.jsonl'), 'utf8');
    expect(requests).toContain('"event":"request"');
    expect(requests).not.toContain('redact-me'); expect(JSON.stringify(summary)).not.toContain('redact-me');
    const envelopes = readFileSync(join(directory, 'sentry-envelopes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(envelopes).toEqual([{ host: 'https://o123.ingest.de.sentry.io', size: 9 }, { host: 'https://o456.ingest.sentry.io', size: 4 }]);
    expect(summary.requests.some(e => e.bytesUp !== null && e.bytesDown !== null)).toBe(true);
    expect(summary.coverage.gaps.some(gap => gap.includes('Unexpected service worker'))).toBe(false);
    expect(summary.outsideSocketFrameViolations).toBe(0);
    expect(summary.coverage.gaps).toContain('Requests after the last After-hook snapshot, including actor stop and browser shutdown, are denied but retained only in the run folder deleted by cleanup; proxy requests while a previous actor stops can carry the next tag');
    expect(summary.coverage.gaps).toContain('Loopback redirects to outside can appear as pending plus a proxy denial; SharedWorker traffic can appear only as deny-proxy records on page browser');
    // Probe the host-level backstop independently of the context policy. This deliberately unobserved
    // fixture page can reach only loopback under the outer OS sandbox, even with a proxy mutation.
    const unguarded = await rawBrowser.newPage();
    await unguarded.goto(`http://127.0.0.1:${address.port}/`);
    expect(await unguarded.evaluate(async () => fetch('https://203.0.113.1/probe').then(() => false, () => true), undefined)).toBe(true);
    await unguarded.close();
    const proxyProof = await guard.snapshot();
    expect(proxyProof.requests.some(e => e.host === 'https://203.0.113.1' && e.source === 'deny-proxy' && e.decision === 'blocked')).toBe(true);
    // A relative target used to become only host "invalid". Keep syntax and the sanitized
    // authority hint, never its path/query or the raw Host/Authorization headers.
    await new Promise<void>((resolve, reject) => {
      const probe = request(proxyUrl, { method: 'GET', path: '/private?token=redact-me', headers: { host: 'origin-form.invalid:443', authorization: 'redact-me' } }, response => {
        expect(response.statusCode).toBe(403); response.resume(); response.on('end', resolve);
      });
      probe.on('error', reject); probe.end();
    });
    const final = await guard.snapshot();
    expect(final.requests.find(e => e.host === 'unknown://origin-form.invalid:443')).toMatchObject({ target: { form: 'origin-form', scheme: null, host: 'origin-form.invalid:443', hostSource: 'host-field' }, decision: 'blocked' });
    expect(JSON.stringify(final)).not.toContain('redact-me');
    if (process.env.HUMANITY_SCENARIOS_NETWORK_FIXTURE_REPORT) writeFileSync(process.env.HUMANITY_SCENARIOS_NETWORK_FIXTURE_REPORT, JSON.stringify({ ...final, fixtureEnvelopes: envelopes, serviceWorker: { controllerAfterReload: null, unexpectedWorkerGap: false } }, null, 2) + '\n');
  } finally {
    await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('passes on only permissions, the recording and the device profile from the adapter', () => {
  const adapter = { permissions: ['clipboard-read'], recordVideo: { dir: 'videos' }, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'ua',
    proxy: { server: 'http://outside.invalid:8080' }, extraHTTPHeaders: { authorization: 'x' }, offline: true, storageState: 'state.json', bypassCSP: true };
  // '' means no size; undefined would fall back to the leg's HUMANITY_SCENARIOS_VIDEO_SIZE, which CI sets.
  expect(scenarioContextOptions(adapter, '')).toEqual({ permissions: ['clipboard-read'], recordVideo: { dir: 'videos' }, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'ua' });
  expect(scenarioContextOptions({ permissions: [] }, '640x360')).toEqual({ permissions: [] });
});
it('caps the recorded frame only when a valid size is configured', () => {
  expect(scenarioContextOptions({ recordVideo: { dir: 'videos' } }, '640x360')).toEqual({ recordVideo: { dir: 'videos', size: { width: 640, height: 360 } } });
  expect(videoFrame('1280x720')).toEqual({ width: 1280, height: 720 });
  for (const bad of ['640', '641x360', '160x90', '3840x2160', '640x360 ', 'x']) expect(() => videoFrame(bad)).toThrow(/HUMANITY_SCENARIOS_VIDEO_SIZE/);
});

it('accepts each cross-app direction and refuses unknown or ambiguous direction tags', () => {
  const directory = mkdtempSync(join(process.cwd(), '.scenario-cross-tags-'));
  try {
    const guard = new ScenarioNetwork(directory);
    for (const tag of ['@C1', '@C2', '@C3', '@C4', '@C5', '@C6', '@B1', '@B2', '@B3', '@U3', '@U4']) expect(() => guard.beginTag(['@environment:paseo-copy', tag])).not.toThrow();
    expect(() => guard.beginTag(['@C7'])).toThrow('exactly one');
    expect(() => guard.beginTag(['@C3', '@C4'])).toThrow('exactly one');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


it('admits only Ada and her two named media-peer labels, with no path-bearing actor identifier', () => {
  const directory = mkdtempSync(join(process.cwd(), '.scenario-media-labels-'));
  try {
    const guard = new ScenarioNetwork(directory);
    for (const actor of ['ada-1', 'ada-10-lab-1', 'ada-10-lab-2']) expect(() => guard.forActor(actor)).not.toThrow();
    for (const actor of ['ada-1-lab-3', '../outside', 'ada-1/../outside', 'foreign-1', 'ada-1-lab-1/'])
      expect(() => guard.forActor(actor)).toThrow('Invalid network actor');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
