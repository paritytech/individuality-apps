// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { Browser as RawBrowser, BrowserContext, BrowserContextOptions, Request } from 'playwright';
import type { Browser, BrowserLauncher, BrowserTab } from '@parity/product-lab/ports/browser';
import { PlaywrightBrowserContext } from '@parity/product-lab/browser-playwright';
import { ConsoleHistory, pathClass } from './console-history.ts';

/** Retain only an origin and a finite path class, never URL credentials, query or path identifiers. */
export function requestAddress(value: string) {
  try {
    const url = new URL(value);
    return { host: url.origin, pathClass: pathClass(url.pathname),
    loopback: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    sentry: /^(?:[a-z0-9-]+\.)*ingest(?:\.[a-z0-9-]+)*\.sentry\.io$/.test(url.hostname),
    network: ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) };
  } catch { return { host: 'invalid', pathClass: '/<unknown>', loopback: false, sentry: false, network: true }; }
}
type Label = { tag: string; actor: string; app: string };
/** Which lab's scenarios this evidence labels: the scenario tag, the actor ids and the app under test. */
export type NetworkScope = { tag: RegExp; actor: RegExp; app: string; name: string; describe: string };
/** Humanity's scenarios and the cross-app lab: one A/B/C/U scenario tag, actors ada-N, the Humanity app. */
export const humanityNetworkScope: NetworkScope = { tag: /^@(?:A[1-6](?:-control)?|C[1-6]|B[1-3]|U[34])$/, actor: /^ada-\d+(?:-lab-[12])?$/,
  app: 'peopl', name: 'humanity-scenario-network', describe: 'Humanity scenario' };
/** The proxy's request-target syntax, retaining only a scheme class and canonical authority.
 * Origin-form has no scheme/authority in the target; only its sanitized Host authority is used.
 * No target path, credentials, query string or raw header is retained. */
export function proxyTarget(method: string, target: string, hostField?: string) {
  const form = method === 'CONNECT' ? 'authority-form' : target === '*' ? 'asterisk-form' :
    target.startsWith('/') ? 'origin-form' : /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? 'absolute-form' : 'unrecognized';
  const scheme = form === 'absolute-form' ?
    (/^(https?|wss?):/i.exec(target)?.[1]?.toLowerCase() ?? 'other') : null;
  let host: string | null = null;
  try {
    if (form === 'absolute-form') host = new URL(target).host || null;
    else {
      const authority = form === 'authority-form' ? target : hostField;
      if (authority && !/[\s/@?#\\]/.test(authority)) host = new URL(`http://${authority}`).host || null;
    }
  } catch { /* The form still explains malformed or relative requests without retaining their text. */ }
  return { form, scheme, host, hostSource: form === 'absolute-form' || form === 'authority-form' ? 'request-target' : host ? 'host-field' : 'unavailable' };
}
type Entry = Label & { id: number; at: string; page: string; host: string; pathClass: string; method: string;
  source: string; outside: boolean; decision: 'loopback' | 'blocked' | 'sentry-local' | 'pending';
  status: number | null; failure: string | null; bytesUp: number | null; bytesDown: number | null; socketFramesSent?: number; socketFramesReceived?: number; outsideFrameViolations?: number; target?: ReturnType<typeof proxyTarget> };
const time = () => new Date().toISOString();
const failureCode = (text: string | undefined) => text?.match(/net::[A-Z0-9_]+/)?.[0] ?? (text ? 'request-failed' : null);

/** The adapter's context options the guard passes on: permissions, the recording and the device profile. Anything else
 * (a proxy, extra headers, offline mode, a storage state) could bypass or weaken the guard, so it is dropped. */
const passedContextOptions = ['permissions', 'recordVideo', 'viewport', 'screen', 'deviceScaleFactor', 'isMobile', 'hasTouch', 'userAgent'] as const;
export function scenarioContextOptions(options: BrowserContextOptions, videoSize = process.env.HUMANITY_SCENARIOS_VIDEO_SIZE): BrowserContextOptions {
  const kept = Object.fromEntries(passedContextOptions.filter(key => options[key] !== undefined).map(key => [key, options[key]])) as BrowserContextOptions;
  if (kept.recordVideo && videoSize) kept.recordVideo = { ...kept.recordVideo, size: videoFrame(videoSize) };
  return kept;
}
/** HUMANITY_SCENARIOS_VIDEO_SIZE, "<width>x<height>": Playwright encodes every recorded frame at this size (default: the
 * viewport scaled into 800x800). A smaller frame lowers the encoder's CPU and the file's size; the frame rate is fixed. */
export function videoFrame(value: string) {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(value);
  const width = Number(match?.[1]), height = Number(match?.[2]);
  if (!match || width < 320 || height < 180 || width > 1920 || height > 1080 || width % 2 || height % 2) throw Error('HUMANITY_SCENARIOS_VIDEO_SIZE must be an even <width>x<height> from 320x180 to 1920x1080');
  return { width, height };
}
/** Lab-only adapter for pinned product-lab 0.1.0. Refuse unfamiliar adapters rather than miss early requests. */
export class ScenarioNetwork {
  readonly launchArguments: string[] = [];
  readonly initializers: Array<(context: BrowserContext) => Promise<void>> = [];
  private entries: Entry[] = [];
  private pages = new Map<BrowserTab, Label>();
  private rawPages = new Set<import('playwright').Page>();
  /** Local lab lifecycle driver. Only pages created inside this guarded session are eligible. */
  localPage(url: string) {
    const origin = new URL(url).origin;
    if (!requestAddress(url).loopback) throw Error('Lifecycle control requires a loopback app');
    const page = [...this.rawPages].find(p => !p.isClosed() && new URL(p.url()).origin === origin);
    if (!page) throw Error('No guarded page for local app');
    return page;
  }
  private tasks = new Set<Promise<void>>();
  private gaps = new Set<string>();
  private currentTag = 'unassigned';
  private actor = 'setup';
  private nextId = 0;
  private nextContext = 0;
  private framework = new Map<object, unknown>();
  /** In-memory listeners on received socket frames (the cross-app hand-off probe). Payloads are never saved. */
  readonly frameProbes = new Set<(frame: { at: number; url: string; payload: string | Buffer }) => void>();
  /** In-memory listeners on page console messages (the cross-app hand-off reason). Nothing is saved here. */
  readonly consoleProbes = new Set<(message: { at: number; url: string; text: string }) => void>();
  /** Bounded, sanitized console lines per actor page, in memory only; a failed step attaches them. */
  readonly consoleHistory = new ConsoleHistory();
  constructor(readonly directory: string, readonly scope: NetworkScope = humanityNetworkScope) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  beginTag(tags: readonly string[]) {
    const tag = tags.filter(t => this.scope.tag.test(t));
    if (tag.length !== 1) throw Error(`Network evidence requires exactly one ${this.scope.describe} tag`);
    this.currentTag = tag[0]!;
  }
  forActor(actor: string) { if (!this.scope.actor.test(actor)) throw Error('Invalid network actor'); this.actor = actor; }
  private label(): Label { return { tag: this.currentTag, actor: this.actor, app: this.scope.app }; }
  private save(entry: Entry, event: string) {
    appendFileSync(join(this.directory, `requests-${entry.actor}.jsonl`), JSON.stringify({ event, ...entry }) + '\n', { mode: 0o600 });
  }
  private task(work: Promise<void>) {
    const task = work.catch(() => { this.gaps.add('Request status or byte count unavailable'); }).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }
  async install(context: BrowserContext) {
    if (context.pages().length) throw Error('Network observer must precede every page');
    const label = this.label(), observed = new WeakMap<Request, Entry>(), pages = new Map<object, string>();
    // Page ids restart in each context; the console history is keyed by actor and page, so it prefixes the context
    // (one actor can own several, such as Humanity's and Jollity's in the cross-app lab, or a reopened session).
    const consolePage = (page: object) => `context-${contextNo}/${pages.get(page)!}`, contextNo = ++this.nextContext;
    const pageId = (request: Request) => {
      try { const page = request.frame().page(); if (!pages.has(page)) pages.set(page, `page-${pages.size + 1}`); return pages.get(page)!; }
      catch { return 'worker'; }
    };
    const entry = (request: Request) => {
      let value = observed.get(request);
      if (!value) {
        const address = requestAddress(request.url());
        value = { ...label, id: ++this.nextId, at: time(), page: pageId(request), host: address.host,
          pathClass: address.pathClass, method: request.method(), source: request.serviceWorker() ? 'service-worker' : 'page-or-dedicated-worker',
          outside: address.network && !address.loopback, decision: 'pending', status: null, failure: null, bytesUp: null, bytesDown: null };
        observed.set(request, value); this.entries.push(value);
      }
      return value;
    };
    for (const initialize of this.initializers) await initialize(context);
    context.on('request', request => { this.save(entry(request), 'request'); });
    context.on('requestfinished', request => this.task((async () => {
      const value = entry(request), response = await request.response(); value.status = response?.status() ?? null;
      const sizes = await request.sizes(); value.bytesUp = sizes.requestBodySize; value.bytesDown = sizes.responseBodySize;
      this.save(value, 'finished');
    })()));
    context.on('requestfailed', request => { const value = entry(request); value.failure = failureCode(request.failure()?.errorText); this.save(value, 'failed'); });
    context.on('serviceworker', () => { this.gaps.add('Unexpected service worker: service workers must be blocked'); });
    await context.route('**/*', async route => {
      const request = route.request(), address = requestAddress(request.url()), value = entry(request);
      if (address.loopback) { value.decision = 'loopback'; this.save(value, 'route'); await route.continue(); }
      else if (address.sentry && value.pathClass === '/api/<n>/envelope/' && request.method() === 'OPTIONS') {
        value.decision = 'sentry-local'; value.status = 204; this.save(value, 'sentry-preflight');
        await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
      } else if (address.sentry && value.pathClass === '/api/<n>/envelope/' && request.method() === 'POST') {
        value.decision = 'sentry-local'; value.status = 200;
        // Read bytes only to measure length; neither envelope contents nor DSN/project identifiers are retained.
        value.bytesUp = request.postDataBuffer()?.byteLength ?? 0; value.bytesDown = 2;
        appendFileSync(join(this.directory, 'sentry-envelopes.jsonl'), JSON.stringify({ host: value.host, size: value.bytesUp }) + '\n', { mode: 0o600 });
        this.save(value, 'sentry-local');
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}', headers: { 'access-control-allow-origin': '*' } });
      } else { value.decision = 'blocked'; this.save(value, 'blocked'); await route.abort('blockedbyclient'); }
    });
    // Playwright routing replaces window.WebSocket before the host container starts. Preserve
    // its native binary transport; the resolver and deny proxy enforce the outside policy.
    const refuseRouting = async () => { throw Error('Scenario network guard refuses WebSocket routing: it replaces the native host transport'); };
    context.routeWebSocket = refuseRouting;
    context.on('page', page => {
      this.rawPages.add(page); page.once('close', () => this.rawPages.delete(page));
      page.routeWebSocket = refuseRouting;
      if (!pages.has(page)) pages.set(page, `page-${pages.size + 1}`);
      page.on('console', message => {
        this.consoleHistory.record(label.actor, consolePage(page), message.type(), message.text());
        if (this.consoleProbes.size) { const value = { at: Date.now(), url: page.url(), text: message.text() }; for (const probe of this.consoleProbes) probe(value); }
      });
      page.on('pageerror', error => this.consoleHistory.record(label.actor, consolePage(page), 'pageerror', error?.message ?? error));
      page.on('websocket', socket => {
        const address = requestAddress(socket.url());
        const value: Entry = { ...label, id: ++this.nextId, at: time(), page: pages.get(page)!, host: address.host, pathClass: address.pathClass,
          method: 'WEBSOCKET', source: 'websocket', outside: !address.loopback, decision: address.loopback ? 'loopback' : 'blocked',
          status: null, failure: null, bytesUp: 0, bytesDown: 0, socketFramesSent: 0, socketFramesReceived: 0, outsideFrameViolations: 0 };
        this.entries.push(value); this.save(value, 'websocket');
        const frame = (direction: 'sent' | 'received', payload: string | Buffer) => {
          const size = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
          if (direction === 'sent') { value.socketFramesSent!++; value.bytesUp! += size; }
          else { value.socketFramesReceived!++; value.bytesDown! += size; }
          if (value.outside) value.outsideFrameViolations!++;
          if (direction === 'received' && !value.outside) for (const probe of this.frameProbes) probe({ at: Date.now(), url: page.url(), payload });
          this.save(value, value.outside ? 'outside-socket-frame-violation' : `socket-frame-${direction}`);
        };
        socket.on('framesent', event => frame('sent', event.payload));
        socket.on('framereceived', event => frame('received', event.payload));
        socket.on('socketerror', error => { value.failure = failureCode(error); this.save(value, 'socket-error'); });
        socket.on('close', () => this.save(value, 'socket-closed'));
      });
    });
    const wrapped = await PlaywrightBrowserContext.observe(context);
    wrapped.routeWebSocket = refuseRouting;
    return wrapped;
  }
  async launch(launcher: BrowserLauncher): Promise<Browser> {
    // A real listening deny proxy also covers literal-IP requests and Chromium traffic missed by context routes.
    const proxy = createServer((request, response) => {
      this.backstop(proxyTarget(request.method ?? '', request.url ?? '', request.headers.host));
      response.writeHead(403); response.end();
    });
    proxy.on('connect', (request, socket) => {
      // A peer reset after the refusal must not surface as an uncaught error; the socket is refused either way.
      socket.on('error', () => socket.destroy());
      this.backstop(proxyTarget('CONNECT', request.url ?? '')); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    const address = proxy.address(); if (!address || typeof address === 'string') throw Error('Missing deny proxy port');
    let launched: Browser | undefined;
    try {
      launched = await launcher.launch({ headless: true, holdWorkers: true, args: [...this.launchArguments,
        '--disable-background-networking', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]',
        `--proxy-server=http://127.0.0.1:${address.port}`, '--proxy-bypass-list=localhost;127.0.0.1;[::1]',
      ] });
      // The adapter's own context options and page watch carry --video (recordVideo and page-open
      // times), so each actor's page records like the opening's; the service-worker block stays last.
      const adapter = launched as Browser & { running?: () => RawBrowser; contextOptions?: (options: { permissions?: string[] }) => BrowserContextOptions; recorded?: (context: BrowserContext) => BrowserContext };
      if (typeof adapter.running !== 'function' || typeof adapter.contextOptions !== 'function' || typeof adapter.recorded !== 'function') throw Error('Scenario network guard requires the pinned Playwright adapter');
      const raw = adapter.running(), contextOptions = adapter.contextOptions.bind(adapter), recorded = adapter.recorded.bind(adapter);
      const browser: Browser = {
        newContext: async options => {
          const context = recorded(await raw.newContext({ ...scenarioContextOptions(contextOptions({ permissions: options?.permissions ? [...options.permissions] : [] })), serviceWorkers: 'block' }));
          try {
            const wrapped = await this.install(context), label = this.label();
            const newPage = wrapped.newPage.bind(wrapped);
            wrapped.newPage = async () => { const page = await newPage(); this.pages.set(page, label); return page; };
            return wrapped;
          }
          catch (error) { await context.close(); throw error; }
        },
        newPage: async options => (await browser.newContext(options)).newPage(),
        close: async () => {
          try { await this.snapshot(); }
          finally { try { await launched!.close(); } finally { await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); } }
        },
      };
      return browser;
    } catch (error) { await launched?.close(); await new Promise<void>(resolve => proxy.close(() => resolve())); throw error; }
  }
  private backstop(target: ReturnType<typeof proxyTarget>) {
    // A CONNECT target has no raw scheme; keep that fact in target while grouping its tunnel
    // with HTTPS origins as before. An origin-form Host hint never invents an original scheme.
    const host = target.host ? target.form === 'authority-form' ? new URL(`https://${target.host}`).origin : `${target.scheme ?? 'unknown'}://${target.host}` : 'invalid';
    const value: Entry = { ...this.label(), id: ++this.nextId, at: time(), page: 'browser', host, pathClass: target.form === 'authority-form' ? '/<connect>' : '/<proxy-target>', method: 'PROXY', source: 'deny-proxy', target,
      outside: true, decision: 'blocked', status: 403, failure: 'proxy-denied', bytesUp: null, bytesDown: null };
    this.entries.push(value); this.save(value, 'backstop');
  }
  async snapshot() {
    await Promise.all([...this.tasks]);
    for (const [page, label] of this.pages) {
      try {
        if (!page.networkEvidence) throw Error('Network evidence unavailable');
        // Use the original adapter page adopted before navigation, never re-adopt a loaded raw page.
        const record = await page.networkEvidence();
        this.framework.set(page, { ...label, observations: record.observations.map(item => ({ at: item.at, ...requestAddress(item.endpoint), source: item.source, transport: item.transport, operation: item.operation })),
          coverage: { ...record.coverage, gaps: record.coverage.gaps.map(gap => gap.replace(/(?:https?|wss?):\/\/[^\s)]+/g, url => requestAddress(url).host)) } });
      } catch { this.gaps.add('Framework page network evidence unavailable or page already closed'); }
    }
    const tags = [...new Set(this.entries.map(e => e.tag).concat(this.currentTag))];
    const counts = tags.map(tag => {
      const outside = this.entries.filter(e => e.tag === tag && e.outside);
      return { tag, attempted: outside.length, blocked: outside.filter(e => e.decision === 'blocked').length,
        allowed: 0, sentryLocal: outside.filter(e => e.decision === 'sentry-local').length, pending: outside.filter(e => e.decision === 'pending').length };
    });
    const summary = { productLab: this.scope.name, outsideHostsAllowed: [], counts, outsideSocketFrameViolations: this.entries.reduce((sum, entry) => sum + (entry.outsideFrameViolations ?? 0), 0),
      sentry: 'All *.ingest[.*].sentry.io envelope POSTs answered in-process; no forwarding',
      hosts: [...new Set(this.entries.map(e => e.host))].map(host => ({ host, attempted: this.entries.filter(e => e.host === host).length, blocked: this.entries.filter(e => e.host === host && e.decision === 'blocked').length, envelopes: this.entries.filter(e => e.host === host && e.method === 'POST' && e.decision === 'sentry-local').length })),
      requests: this.entries, framework: [...this.framework.values()],
      coverage: { beforeNavigation: true, contextRequests: true, serviceWorkers: 'blocked',
        gaps: [...this.gaps, 'Native host, chain, app-server and other processes are outside browser coverage',
          'Browser internals, DNS, WebRTC and closed pages may be absent; proxy is a backstop, not full wire observation',
          'Requests after the last After-hook snapshot, including actor stop and browser shutdown, are denied but retained only in the run folder deleted by cleanup; proxy requests while a previous actor stops can carry the next tag',
          'Loopback redirects to outside can appear as pending plus a proxy denial; SharedWorker traffic can appear only as deny-proxy records on page browser',
          'Body and observed WebSocket payload byte counts only; headers excluded. Aborted requests and worker socket sizes may be unavailable'], full: false },
      claim: 'No full-machine or nothing-left-the-machine claim; attempted includes locally handled Sentry envelopes' };
    writeFileSync(join(this.directory, 'network-summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    return summary;
  }
}
