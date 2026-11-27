// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// A probe, not a scenario of the product: does the lab's Jollity (a development server behind the lab's proxy) complete
// a move from one of its pages to another inside the app? The game is entered by such a move, and on 20 November 2026
// it never completed. No game and no chain is needed to ask.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { step } from '@parity/product-lab/steps';
import { jsonEvidence } from '../shared/observations.ts';
import { poc } from './session.ts';

type Watched = {
  onConsole?: (listener: (message: { type: string; text: string }) => void) => () => void;
  onPageError?: (listener: (message: string) => void) => () => void;
  onWebSocket?: (listener: (socket: { url(): string; onClose(listener: () => void): void }) => void) => void;
  screenshot?: (options: { type: 'png'; timeout?: number }) => Promise<Uint8Array>;
};

step("{actor}'s Jollity moves to its {word} page by itself", async ({ lab }, name, target) => {
  const state = poc(), who = state.actor(lab.actor(String(name)).id), { page } = await who.jollity();
  const tab = page as unknown as Watched, log: string[] = [], stamp = () => new Date().toISOString().slice(11, 23);
  const keep = (line: string) => { if (log.length < 500) log.push(`${stamp()} ${line.slice(0, 400)}`); };
  const offConsole = tab.onConsole?.(message => keep(`console.${message.type} ${message.text}`));
  const offError = tab.onPageError?.(message => keep(`pageerror ${message}`));
  tab.onWebSocket?.(socket => { keep(`websocket opened ${socket.url()}`); socket.onClose(() => keep(`websocket closed ${socket.url()}`)); });
  const shots = join(state.directory, 'screens'); mkdirSync(shots, { recursive: true });
  const shoot = async (label: string) => { const png = await tab.screenshot?.({ type: 'png', timeout: 4_000 }).catch(() => undefined); if (png) writeFileSync(join(shots, `probe-${label}.png`), png); };
  // The development server tells the page about its builds over this socket.
  const updates = await page.evaluate(() => new Promise<string>(resolve => {
    try {
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/_next/webpack-hmr`);
      const limit = setTimeout(() => resolve('no answer in 8 s'), 8_000);
      socket.onopen = () => { clearTimeout(limit); resolve('opened'); socket.close(); };
      socket.onerror = () => { clearTimeout(limit); resolve('refused'); };
    } catch (error) { resolve(`threw ${String(error)}`); }
  }), undefined).catch(error => `unreadable: ${String(error).slice(0, 200)}`);
  const before = await page.evaluate(() => ({ path: location.pathname, router: typeof (window as unknown as { next?: { router?: { push?: unknown } } }).next?.router?.push }), undefined);
  await shoot('before');
  const path = `/${String(target)}`, asked = Date.now();
  await page.evaluate((to: string) => { (window as unknown as { next: { router: { push(path: string): void } } }).next.router.push(to); }, path);
  let landed: number | undefined, seen = before.path;
  while (Date.now() - asked < 45_000) {
    seen = await page.evaluate(() => location.pathname, undefined).catch(() => seen);
    if (seen.replace(/\/$/, '') === path) { landed = Date.now() - asked; break; }
    if (Date.now() - asked > 5_000 && Date.now() - asked < 6_200) await shoot('after-5s');
    await delay(1_000, undefined, { signal: state.context.signal });
  }
  await shoot('end');
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200), undefined).catch(() => 'unreadable');
  offConsole?.(); offError?.();
  await lab.attach(jsonEvidence({ probe: { updatesSocket: updates, before, asked: path, landedAfterMs: landed ?? null, lastPath: seen, text, screens: shots }, log }));
  if (landed === undefined) throw Error(`Jollity did not reach ${path} within 45 s of asking (still on ${seen}; the server's update socket: ${updates})`);
}, { timeoutMs: 120_000 });
