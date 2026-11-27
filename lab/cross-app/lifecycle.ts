// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { CDPSession, Page } from 'playwright';
import type { DocumentMarks } from './journey-observations.ts';
import { scenario } from '../shared/session.ts';

async function bounded<T>(operation: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error(name)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Suspend the guarded local page's JavaScript without dropping queued WebSocket messages. */
export async function freezeApp(app: 'humanity' | 'jollity') {
  const state = scenario(), url = state.apps[app];
  if (!url) throw Error('Missing local app');
  return freezeLocalPage(state.network, url, app);
}
export async function freezeLocalPage(network: { localPage(url: string): Page }, url: string, app: string) {
  const page = network.localPage(url);
  await page.evaluate(() => {
    const events: Array<{ at: number; event: string; visibility: string }> = [];
    (window as unknown as { __lifecycle: typeof events }).__lifecycle = events;
    for (const event of ['visibilitychange', 'freeze', 'resume']) document.addEventListener(event, () => events.push({ at: Date.now(), event, visibility: document.visibilityState }), true);
    events.push({ at: Date.now(), event: 'before-pause', visibility: document.visibilityState });
  });
  const cdp: CDPSession = await page.context().newCDPSession(page);
  let suspended = false, detached = false;
  const close = async () => {
    if (detached) return;
    if (suspended) { await cdp.send('Debugger.resume'); suspended = false; }
    await cdp.send('Debugger.disable'); await cdp.detach(); detached = true;
  };
  let pausedAt = 0;
  const paused = new Promise<void>(resolve => cdp.once('Debugger.paused', () => { pausedAt = Date.now(); resolve(); }));
  const freeze = Date.now();
  try {
    await cdp.send('Debugger.enable'); await cdp.send('Debugger.pause');
    await bounded(paused, 5000, 'CDP debugger did not pause the local app'); suspended = true;
  } catch (error) { await cdp.send('Debugger.resume').catch(() => {}); await close(); throw error; }
  const resume = async () => {
    if (!suspended) throw Error('Already resumed');
    const foreground = Date.now(); await cdp.send('Debugger.resume'); suspended = false;
    const activeAt = Date.now();
    try {
      const lifecycle = await bounded(page.evaluate(() => {
        const record = (window as unknown as { __crossJourney?: DocumentMarks }).__crossJourney;
        const snapshotAt = Date.now(), view = record?.views.at(-1)?.view;
        if (record && view) record.views.push({ at: snapshotAt, view: structuredClone(view) });
        return { events: (window as unknown as { __lifecycle: unknown }).__lifecycle, visibility: document.visibilityState, snapshotAt, firstView: view ?? null };
      }), 15_000, 'Local app did not answer after CDP debugger resume');
      return { mechanism: 'CDP Debugger.pause/resume; actual visibility retained; queued WebSocket messages preserved', app, freeze, pausedAt, foreground, activeAt, lifecycle };
    } finally { await close(); }
  };
  return { freeze, resume, close };
}
