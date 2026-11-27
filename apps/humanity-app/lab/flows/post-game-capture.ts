// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { BrowserPage } from '@parity/product-lab/ports/browser';

const routes = ['/', '/game', '/prize-draw', '/chest', '/permissions'];
export function publicPath(value: unknown): string {
  if (typeof value !== 'string') return '[other route]';
  try { const u = new URL(value, 'http://flow.invalid'); return routes.includes(u.pathname) ? u.pathname : '[other route]'; }
  catch { return '[other route]'; }
}
const messages = ['a page load came in past home — home first', 'reloading the app', 'self-reload needs sessionStorage to count its budget, staying put',
  'self-reload cap reached, staying put', 'self-reload could not record its budget, staying put'];
export function projectEntry(entry: { ts: number; tag: string; message: string; data?: unknown }, since: number) {
  if (entry.ts < since || !['front-door', 'reload'].includes(entry.tag)) return undefined;
  let data: Record<string, unknown> = {};
  try { const decoded = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data; if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) data = decoded as Record<string, unknown>; } catch { /* no arbitrary payload is retained */ }
  return { ts: entry.ts, tag: entry.tag, message: messages.includes(entry.message) ? entry.message : '[other diagnostic message]',
    ...(typeof data.href === 'string' ? { path: publicPath(data.href) } : {}),
    ...(['host-channel', 'long-suspension', 'left-product'].includes(String(data.reason)) ? { reason: String(data.reason) } : {}),
    ...(typeof data.reload === 'number' && Number.isSafeInteger(data.reload) ? { reload: data.reload } : {}),
    ...(typeof data.awayMs === 'number' && Number.isFinite(data.awayMs) ? { awayMs: data.awayMs } : {}) };
}
export function projectNavigations(rows: readonly unknown[], actor: string, since: number) {
  return rows.flatMap(raw => {
    const row = raw as Record<string, unknown>;
    if (row.actorId !== actor || (row.fromApp !== 'dim2' && row.toApp !== 'dim2') || typeof row.requestedAt !== 'number' || row.requestedAt < since) return [];
    return [{ actor, fromApp: ['dim2','peopl'].includes(String(row.fromApp)) ? row.fromApp : '[other app]',
      toApp: ['dim2','peopl'].includes(String(row.toApp)) ? row.toApp : '[other app]',
      outcome: ['opened','focused','failed','ignored'].includes(String(row.outcome)) ? row.outcome : '[other outcome]',
      requestedAt: row.requestedAt, path: publicPath(row.path) }];
  });
}
/** Numeric/boolean-only document evidence, observed atomically with the path. Navigation: 0 unknown, 1 navigate, 2 reload, 3 back_forward. */
export async function readDocumentEvidence(page: BrowserPage, since: number) {
  try {
    return await page.evaluate(from => {
      let timeOrigin = -1, navigationType = 0;
      try { if (Number.isFinite(performance.timeOrigin) && performance.timeOrigin >= 0) timeOrigin = performance.timeOrigin; } catch { /* unavailable */ }
      try { const type = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type;
        navigationType = type === 'navigate' ? 1 : type === 'reload' ? 2 : type === 'back_forward' ? 3 : 0; } catch { /* unavailable */ }
      let reloadStorageReadable = false, reloadDataValid = false, reloadCount = -1, reloadLatest = -1;
      try {
        const raw = sessionStorage.getItem('jollity:host-reloads'); reloadStorageReadable = true;
        try { const parsed: unknown = raw === null ? [] : JSON.parse(raw);
          if (Array.isArray(parsed)) { reloadDataValid = parsed.every(n => typeof n === 'number' && Number.isFinite(n));
            const stamps = parsed.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= from);
            reloadCount = stamps.length; reloadLatest = stamps.length ? Math.max(...stamps) : -1; }
        } catch { /* malformed JSON remains explicitly invalid */ }
      } catch { /* blocked storage */ }
      let postGameStorageReadable = false, postGamePresent = false, crashStorageReadable = false, crashDataValid = false, crashReload = -1;
      try { postGamePresent = sessionStorage.getItem('jollity.postGame') !== null; postGameStorageReadable = true; } catch { /* unavailable */ }
      try { const raw = sessionStorage.getItem('jollity.crash-reload'); crashStorageReadable = true;
        const n = raw === null ? 0 : Number(raw); if (Number.isSafeInteger(n) && n >= 0) { crashReload = n; crashDataValid = true; }
      } catch { /* unavailable */ }
      const sheet = document.querySelector('[role="dialog"][aria-label="Debug logs"]');
      let ringCount = sheet ? 0 : -1, ringOldest = -1;
      if (sheet) for (const line of sheet.querySelectorAll('div.border-b')) {
        const spans = line.querySelectorAll(':scope > div > span');
        if (spans.length !== 3 || !/^\[.*\]$/.test(spans[1]?.textContent?.trim() ?? '')) continue;
        ringCount++;
        const stamp = spans[0]?.textContent?.trim() ?? '';
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}$/.test(stamp)) continue;
        const at = new Date(); at.setHours(Number(stamp.slice(0,2)),Number(stamp.slice(3,5)),Number(stamp.slice(6,8)),Number(stamp.slice(9,12)));
        if (at.getTime() > Date.now()+5000) at.setDate(at.getDate()-1);
        ringOldest = ringOldest < 0 ? at.getTime() : Math.min(ringOldest, at.getTime());
      }
      return { path: location.pathname, signals: { timeOrigin, timeOriginValid: timeOrigin >= 0,
        documentBeforePayoff: timeOrigin >= 0 && timeOrigin < from, navigationType,
        reloadStorageReadable, reloadDataValid, reloadCount, reloadLatest, postGameStorageReadable, postGamePresent,
        crashStorageReadable, crashDataValid, crashReload, ringReadable: sheet !== null, ringCount, ringOldest } };
    }, since);
  } catch (error) {
    if (error instanceof Error && /^page\.evaluate: Execution context was destroyed, most likely because of a navigation/.test(error.message)) return null;
    throw error;
  }
}
/** Read the shipped debug UI's current-page ring. The copied IndexedDB reader cannot read this build. */
export async function capturePostGameEntry(page: BrowserPage, actor: string, since: number, rows: readonly unknown[]) {
  if (!Number.isSafeInteger(since) || since < 0) throw new Error('Missing observed payoff timestamp');
  let current: Awaited<ReturnType<typeof readDocumentEvidence>> = null;
  const dialog = page.getByRole('dialog', { name: 'Debug logs' });
  let wasOpen = false, opened = false;
  let entries: Array<{ ts: number; tag: string; message: string; data?: unknown }> = [], coverage = 'current-page debug ring (250 entries); earlier-page host ring not exported';
  try {
    wasOpen = await page.locator('body').evaluate(body => body.querySelector('[role="dialog"][aria-label="Debug logs"]') !== null);
    if (!wasOpen) await page.locator('body').press!('ControlOrMeta+d');
    await dialog.waitFor({ timeout: 1500 }); opened = true;
    entries = await dialog.evaluate((sheet, from) => {
      const out: Array<{ ts: number; tag: string; message: string; data?: unknown }> = [];
      for (const line of sheet.querySelectorAll('div.border-b')) {
        const spans = line.querySelectorAll(':scope > div > span');
        const stamp = spans[0]?.textContent?.trim() ?? '', tag = spans[1]?.textContent?.trim().replace(/^\[|\]$/g, '') ?? '';
        if (!/^(front-door|reload)$/.test(tag) || !/^\d\d:\d\d:\d\d\.\d{3}$/.test(stamp)) continue;
        const at = new Date(from as number); at.setHours(Number(stamp.slice(0,2)),Number(stamp.slice(3,5)),Number(stamp.slice(6,8)),Number(stamp.slice(9,12)));
        if (at.getTime() < (from as number) - 43_200_000) at.setDate(at.getDate()+1);
        if (at.getTime() > Date.now()+5000) at.setDate(at.getDate()-1);
        out.push({ ts: at.getTime(), tag, message: spans[2]?.textContent ?? '', data: line.querySelector('pre')?.textContent });
      }
      return out;
    }, since);
  } catch { coverage = 'debug UI unavailable; no inference of absent reload events'; }
  finally { try { current = await readDocumentEvidence(page, since); } finally { if (!wasOpen && opened) await page.locator('body').press!('Escape'); } }
  return { actor, observedAt: Date.now(), since, path: current === null ? '[document replacing]' : publicPath(current.path), documentSignalsAvailable: current !== null, documentSignals: current?.signals,
    devLog: { coverage, entries: entries.flatMap(e => { const projected = projectEntry(e, since); return projected ? [projected] : []; }) },
    selfReloadMetrics: { names: ['app.self_reload','app.self_reload_away_ms','app.self_reload_suppressed'], status: 'unavailable: Sentry metrics only; source profile disables telemetry', evidence: 'reload devLog records carry the corresponding reason when retained' },
    hostNavigations: projectNavigations(rows, actor, since) };
}
