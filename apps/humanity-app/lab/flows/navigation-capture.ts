// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { BrowserPage } from '@parity/product-lab/ports/browser';

/** Self-contained for browser serialization. Phase 0 reads; 1 installs at payoff; 2 installs after reopen. */
export function navigationCaptureInPage(input: unknown) {
  const key = 'product-lab:dim2-navigation:v1', marker = Symbol.for(key), limit = 64;
  const phase = input === 1 || input === 2 ? input : 0;
  type Row = { kind: number; at: number; origin: number; phase: number; path: number; navigationType: number;
    userInitiated: boolean; hashChange: boolean; persisted: boolean; sameOrigin: boolean; navigationAvailable: boolean };
  type Store = { version: number; dropped: number; damaged: boolean; writeFailures: number; records: Row[] };
  type State = { phase: number; navigationAvailable: boolean; pagehideAvailable: boolean; writable: boolean;
    log: Store; append: (kind: number, event?: Event) => void };
  const owner = window as unknown as Record<symbol, State | undefined>;
  const helpers = {
    finite(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n) && n >= 0; },
    now(): number { const at = Date.now(); return helpers.finite(at) ? at : -1; },
    integer(n: unknown): n is number { return helpers.finite(n) && Number.isSafeInteger(n); },
    route(url: string): { path: number; sameOrigin: boolean } {
      if (!url) return { path: 0, sameOrigin: false };
      try {
        const parsed = new URL(url, location.href), sameOrigin = parsed.origin === location.origin;
        const path = !sameOrigin ? 0 : parsed.pathname === '/' ? 1 : parsed.pathname === '/chest' ? 2 : parsed.pathname === '/prize-draw' ? 3 : 0;
        return { path, sameOrigin };
      } catch { return { path: 0, sameOrigin: false }; }
    },
    origin(): number { try { return helpers.finite(performance.timeOrigin) ? performance.timeOrigin : -1; } catch { return -1; } },
    project(raw: unknown): Row | null {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      if (![r.kind, r.phase, r.path, r.navigationType].every(helpers.integer) || !helpers.finite(r.at) || !(r.origin === -1 || helpers.finite(r.origin))
        || ![0, 1, 2].includes(r.kind as number) || ![1, 2].includes(r.phase as number)
        || ![0, 1, 2, 3].includes(r.path as number) || ![0, 1, 2, 3, 4].includes(r.navigationType as number)
        || ![r.userInitiated, r.hashChange, r.persisted, r.sameOrigin, r.navigationAvailable].every(v => typeof v === 'boolean')) return null;
      return { kind: r.kind as number, at: r.at, origin: r.origin as number, phase: r.phase as number, path: r.path as number,
        navigationType: r.navigationType as number, userInitiated: r.userInitiated as boolean, hashChange: r.hashChange as boolean,
        persisted: r.persisted as boolean, sameOrigin: r.sameOrigin as boolean, navigationAvailable: r.navigationAvailable as boolean };
    },
    read(): { readable: boolean; present: boolean; valid: boolean; log: Store } {
      let readable = false, present = false, valid = false;
      let log: Store = { version: 1, dropped: 0, damaged: false, writeFailures: 0, records: [] };
      try {
        const raw = sessionStorage.getItem(key); readable = true; present = raw !== null;
        if (raw !== null && raw.length <= 32_768) {
          const data: unknown = JSON.parse(raw);
          if (data && typeof data === 'object') {
            const s = data as Record<string, unknown>;
            if (s.version === 1 && helpers.integer(s.dropped) && helpers.integer(s.writeFailures) && typeof s.damaged === 'boolean' && Array.isArray(s.records)) {
              const rows = s.records.map(helpers.project), accepted = rows.filter((r): r is Row => r !== null);
              valid = accepted.length === rows.length;
              log = { version: 1, dropped: s.dropped + Math.max(0, accepted.length - limit), writeFailures: s.writeFailures,
                damaged: s.damaged || !valid, records: accepted.slice(-limit) };
            }
          }
        }
      } catch { /* missing/blocked/malformed remains explicitly unavailable or invalid */ }
      if (present && !valid) log.damaged = true;
      return { readable, present, valid: valid && !log.damaged, log };
    },
  };
  let state = owner[marker];
  if (phase) {
    const previous = state?.phase, wasAvailable = state?.navigationAvailable;
    if (!state) {
      const stored = helpers.read();
      state = { phase, navigationAvailable: false, pagehideAvailable: false, writable: false, log: stored.log, append() {} };
      const active = state;
      active.append = (kind, event) => {
        const e = event as Event & { destination?: { url?: string }; navigationType?: string; userInitiated?: boolean; hashChange?: boolean; persisted?: boolean };
        const destination = kind === 1 ? helpers.route(typeof e?.destination?.url === 'string' ? e.destination.url : '') : helpers.route(location.href);
        const row: Row = { kind, at: helpers.now(), origin: helpers.origin(), phase: active.phase, ...destination,
          navigationType: kind !== 1 ? 0 : e.navigationType === 'push' ? 1 : e.navigationType === 'replace' ? 2 : e.navigationType === 'reload' ? 3 : e.navigationType === 'traverse' ? 4 : 0,
          userInitiated: e?.userInitiated === true, hashChange: e?.hashChange === true, persisted: e?.persisted === true,
          navigationAvailable: active.navigationAvailable };
        active.log.records.push(row);
        if (active.log.records.length > limit) { active.log.records.shift(); active.log.dropped++; }
        try { sessionStorage.setItem(key, JSON.stringify(active.log)); active.writable = true; }
        catch { active.writable = false; active.log.writeFailures++; }
      };
      owner[marker] = active;
    }
    state.phase = phase;
    if (!state.navigationAvailable) {
      try {
        const navigation = (window as unknown as { navigation?: { addEventListener: (name: string, listener: (event: Event) => void) => void } }).navigation;
        if (navigation && typeof navigation.addEventListener === 'function') {
          const active = state; navigation.addEventListener('navigate', event => active.append(1, event)); state.navigationAvailable = true;
        }
      } catch { /* API absent or unusable: pagehide still records that coverage is unavailable */ }
    }
    if (!state.pagehideAvailable) {
      try { const active = state; window.addEventListener('pagehide', event => active.append(2, event)); state.pagehideAvailable = true; }
      catch { /* explicit coverage flag */ }
    }
    if (previous !== phase || wasAvailable !== state.navigationAvailable) state.append(0);
  }
  const stored = helpers.read();
  return { documentAvailable: true, observedAt: helpers.now(), origin: helpers.origin(), ...helpers.route(location.href),
    installedHere: state !== undefined, navigationAvailable: state?.navigationAvailable ?? false, pagehideAvailable: state?.pagehideAvailable ?? false,
    storageReadable: stored.readable, storagePresent: stored.present, dataValid: stored.valid,
    storageWritable: state?.writable ?? false, writeFailedHere: state !== undefined && !state.writable,
    dropped: stored.log.dropped, damaged: stored.log.damaged, writeFailures: stored.log.writeFailures, records: stored.log.records };
}
/** No raw URL, query, error text or storage payload crosses this boundary. */
export async function captureNavigationEvents(page: BrowserPage, phase: 0 | 1 | 2 = 0) {
  try { return await page.evaluate(navigationCaptureInPage, phase); }
  catch (error) {
    if (error instanceof Error && /^page\.evaluate: Execution context was destroyed, most likely because of a navigation/.test(error.message))
      return { documentAvailable: false };
    throw error;
  }
}
