// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Execute today's DIM2 engine and screen reducer with drawing-only stand-ins. No browser, host or chain.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { expect, it, vi } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { CHEST_BACKSTOP_MS, viewGameResults } from '../../lab/flows/post-game.ts';

// Load pure screen modules without bringing Jollity's app aliases into Humanity's build.
function pureModule(path: URL): Record<string, unknown> {
  const exports = {};
  const source = transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(source, { exports, require: (name: string) => {
    if (name === '@jollity/collectables') return {
      ...pureModule(new URL('../../../../packages/jollity-collectables/src/picks.ts', import.meta.url)),
      ...pureModule(new URL('../../../../packages/jollity-collectables/src/with-picks.ts', import.meta.url)),
    };
    if (!name.startsWith('.')) throw new Error('Unexpected screen dependency: ' + name);
    return pureModule(new URL(name + '.ts', path));
  } });
  return exports;
}
type State = { epoch: number };
type ScreenView = { vessel: { pieces: unknown[]; canOpen: boolean; open: boolean } | null; action: string | null; notice: unknown };
const screen = pureModule(new URL('../../../jollity-app/lib/chest/chest-screen.ts', import.meta.url)) as {
  startChestScreen(): State;
  chestScreenStep(state: State, event: Record<string, unknown>): { state: State; commands: Array<{ kind: string; timer: string; ms: number }> };
  chestScreenView(state: State): ScreenView;
};
function engine() {
  const source = readFileSync(new URL('../../../jollity-app/lib/chest-scene/engine.ts', import.meta.url), 'utf8');
  const context = new Proxy({}, { get: () => () => context });
  const canvas = { clientWidth: 390, clientHeight: 600, getContext: () => context };
  type Scene = { open(): void; addPiece(tint: string): number; press(x: number, y: number): void; release(): void };
  let frame: (now: number) => void = () => {}, now = 0, blend = 0, added = 0, collected = 0, opened = false;
  let state = screen.startChestScreen();
  const timers = new Map<string, number>(), events: string[] = [];
  const view = () => screen.chestScreenView(state);
  const send = (event: Record<string, unknown>) => {
    const result = screen.chestScreenStep(state, event); state = result.state;
    for (const cmd of result.commands) {
      if (cmd.kind === 'arm-timer') timers.set(cmd.timer, now + cmd.ms);
      if (cmd.kind === 'clear-timer') timers.delete(cmd.timer);
    }
  };
  const create = runInNewContext(source.replace('export function createChestScene', 'function createChestScene') + '\ncreateChestScene', {
    document: { createElement: () => canvas }, devicePixelRatio: 1, performance: { now: () => 0 },
    requestAnimationFrame: (next: (now: number) => void) => { frame = next; return 1; }, cancelAnimationFrame: () => {},
  }) as (canvas: unknown, opts: unknown) => Scene;
  const scene = create(canvas, { count: 0, canOpen: () => view().vessel?.canOpen === true,
    onEvent: (name: string) => {
      events.push(name);
      if (name === 'landed') send({ type: 'landed' });
      if (name === 'absorb' || name === 'arrive') send({ type: 'collected', count: ++collected });
      if (name === 'open') { opened = true; send({ type: 'vessel-opened' }); }
    }, onDiscs: (_pieces: unknown, value: number) => { blend = value; } });
  send({ type: 'opened' }); send({ type: 'source', seed: 'offline:308', game: 308 });
  const sync = () => {
    while (added < (view().vessel?.pieces.length ?? 0)) { scene.addPiece('#e3ecff'); added++; }
    if (view().vessel?.open) scene.open();
  };
  const items = [1, 2, 3].map(n => ({ hash: '0x' + String(n).repeat(64), name: 'Piece ' + n, image: '', rarity: 'common', choices: [] }));
  return { scene, events, view, opened: () => opened, staged: () => blend >= 0.999,
    claims(settling = true) { send({ type: 'answered', epoch: state.epoch, tag: { gameIndex: 308, epoch: 1 },
      answer: { kind: 'claims', game: 308, seed: 'offline:308', items: items.slice(0, 2), settling, partial: false } }); sync(); },
    settle() { send({ type: 'settled', epoch: state.epoch, items: items.slice(0, 2), partial: false }); sync(); },
    arrive() { send({ type: 'came', epoch: state.epoch, items: items.slice(2) }); sync(); },
    advance(ms: number) {
      const end = now + ms;
      while (now < end) {
        now += 50; frame(now);
        for (const [timer, at] of timers) if (now >= at) { timers.delete(timer); send({ type: 'timer', timer }); }
        sync();
      }
    } };
}
it('@negative-control keeps an empty mounted bubble shut despite taps and three simulated minutes', () => {
  const e = engine(); e.scene.press(195, 300); e.scene.release(); e.advance(2000);
  e.scene.press(195, 300); e.scene.release(); e.advance(178_000);
  expect(e.events).toContain('landed'); expect(e.events).not.toContain('open'); expect(e.staged()).toBe(false);
  expect(e.view()).toMatchObject({ vessel: { pieces: [], canOpen: false, open: false }, notice: 'slow', action: 'skip' });
});
it('collects claims as orbs and offers Continue on an early tap before the pieces stage', () => {
  const e = engine(); e.claims(); e.advance(2000);
  expect(e.events.filter(name => name === 'absorb')).toHaveLength(2);
  expect(e.view()).toMatchObject({ vessel: { canOpen: true, open: false }, action: null });
  e.scene.press(195, 300); e.scene.release();
  expect(e.view().action).toBe('continue'); expect(e.staged()).toBe(false);
  e.advance(2000); expect(e.staged()).toBe(true);
});
it.each(['all-in', 'collect wait', 'late first claims'] as const)('opens automatically for %s without any tap', kind => {
  const e = engine();
  if (kind === 'late first claims') e.advance(12_000);
  e.claims(kind !== 'all-in'); e.advance(kind === 'collect wait' ? 12_000 : 2000);
  expect(e.opened()).toBe(true); expect(e.view().action).toBe('continue');
});
it('waits for the settled claims to fly in before opening automatically', () => {
  const e = engine(); e.claims(); e.advance(700); e.settle();
  expect(e.opened()).toBe(false); expect(e.view().action).toBeNull();
  e.advance(1500); expect(e.opened()).toBe(true); expect(e.view().action).toBe('continue');
});
it('collects claims arriving after opening without closing the bubble again', () => {
  const e = engine(); e.claims(); e.advance(2000); e.scene.press(195, 300); e.scene.release();
  e.arrive(); e.advance(2000);
  expect(e.view().vessel?.pieces).toHaveLength(3);
  expect(e.events).toContain('arrive'); expect(e.opened()).toBe(true);
});
it.each([true, false])('reveals the selected ready bubble and stops before Continue (tap %s)', async tap => {
  const e = engine(); e.claims(tap); let taps = 0;
  const page = { evaluate: async () => { e.advance(2000); return { path: '/chest', game: '308', scene: true,
    buttons: [{ name: 'Continue', enabled: e.view().action === 'continue' }] }; },
    getByRole: (role: string, options: { name: string; exact: boolean }) => ({ click: async (input: { timeout: number }) => {
      expect(role).toBe('img'); expect(options).toEqual({ name: 'Your chest opening', exact: true });
      expect(input.timeout).toBeGreaterThan(0); expect(input.timeout).toBeLessThanOrEqual(1000);
      taps++; e.scene.press(195, 300); e.scene.release();
    } }) } as unknown as BrowserPage;
  const result = await viewGameResults(page, 308, async () => {}, { timeoutMs: 1200 });
  expect(taps).toBe(tap ? 1 : 0); expect(result.openingTaps).toBe(taps); expect(result.results.controls).toEqual([]);
  expect(result.visibleChest).toMatchObject({ scene: true, buttons: [{ name: 'Continue', enabled: true }] });
  expect(result.reveal).toBe('opened');
});
it('pins the lab backstop window to Jollity\'s own slow-payoff wait', () => {
  const slow = pureModule(new URL('../../../jollity-app/lib/slow-payoff.ts', import.meta.url)) as { SLOW_PAYOFF_MS: number };
  expect(slow.SLOW_PAYOFF_MS).toBe(CHEST_BACKSTOP_MS);
});
it.each([
  ['a real opening at 59 s', 59_000, 'opened'],
  ['the backstop at 61 s on a bubble that never opened', 61_000, 'backstop-or-late'],
] as const)('@negative-control the real reducer\'s Continue from %s (%i ms after entry) is reported as %s', async (_label, at, reveal) => {
  // Claims are read; the vessel either lands and opens at `at`, or never lands and the slow timer fires (C9/C11).
  let state = screen.startChestScreen();
  const step = (event: Record<string, unknown>) => { state = screen.chestScreenStep(state, event).state; };
  step({ type: 'opened' }); step({ type: 'source', seed: 'offline:308', game: 308 });
  step({ type: 'answered', epoch: state.epoch, tag: { gameIndex: 308, epoch: 1 },
    answer: { kind: 'claims', game: 308, seed: 'offline:308', items: [{ hash: '0x' + '1'.repeat(64), name: 'Piece 1', image: '', rarity: 'common', choices: [] }], settling: false, partial: false } });
  let now = 1000, fired = false;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const page = { evaluate: async () => {
      // Jump close to the event, then step finely: the loop sleeps in real time between reads.
      now += now - 1000 < at - 2000 ? at - 2000 - (now - 1000) : 500;
      if (!fired && now - 1000 >= at) {
        fired = true;
        if (reveal === 'opened') { step({ type: 'landed' }); step({ type: 'collected', count: 1 }); step({ type: 'vessel-opened' }); }
        else step({ type: 'timer', timer: 'slow' });
        expect(screen.chestScreenView(state)).toMatchObject({ vessel: { open: reveal === 'opened' }, notice: null, action: 'continue' });
      }
      return { path: '/chest', game: '308', scene: true, buttons: [{ name: 'Continue', enabled: screen.chestScreenView(state).action === 'continue' }] };
    },
    getByRole: () => ({ click: async () => {} }) } as unknown as BrowserPage;
  try {
    const result = await viewGameResults(page, 308, async () => {});
    expect(result.reveal).toBe(reveal); expect(result.results.controls).toEqual([]);
  } finally { clock.mockRestore(); }
});
it('@negative-control marks the entry before navigation, so a slow open counts toward the backstop window', async () => {
  // The page's own backstop starts after it mounts; marking entry after open() would shrink the window.
  let now = 1000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const page = { evaluate: async () => {
      now += now - 1000 < 60_000 ? 60_000 - (now - 1000) : 500;
      return { path: '/chest', game: '308', scene: true, buttons: [{ name: 'Continue', enabled: now - 1000 >= 62_000 }] };
    },
    getByRole: () => ({ click: async () => {} }) } as unknown as BrowserPage;
  try {
    const result = await viewGameResults(page, 308, async () => { now += 5000; });
    expect(result.reveal).toBe('backstop-or-late');
  } finally { clock.mockRestore(); }
});
it('@negative-control keeps a stalled collection bounded instead of accepting its mounted scene', async () => {
  let taps = 0, now = 1000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const page = { evaluate: async () => ({ path: '/chest', game: '308', scene: true, buttons: [{ name: 'Continue', enabled: false }] }),
    getByRole: () => ({ click: async () => { taps++; now += 21; } }) } as unknown as BrowserPage;
  try {
    await expect(viewGameResults(page, 308, async () => {}, { timeoutMs: 20 }))
      .rejects.toThrow('chest is collecting or opening; waiting for an enabled Continue or Claim all (1 opening taps)');
    expect(taps).toBe(1);
  } finally { clock.mockRestore(); }
});
it('retries an ignored early bubble tap with bounded input, then stops when Continue is usable', async () => {
  let taps = 0;
  const page = { evaluate: async () => ({ path: '/chest', game: '308', scene: true, buttons: [{ name: 'Continue', enabled: taps >= 2 }] }),
    getByRole: () => ({ click: async () => { taps++; } }) } as unknown as BrowserPage;
  expect((await viewGameResults(page, 308, async () => {}, { timeoutMs: 2500 })).openingTaps).toBe(2);
});
it.each(['noIdentity', 'restart', 'wrongGame', 'closing'] as const)('@negative-control never taps a ready scene with %s', async marker => {
  const page = { evaluate: async () => ({ path: '/chest', game: marker === 'wrongGame' ? '307' : '308', scene: true,
    [marker]: true, buttons: [{ name: 'Continue', enabled: false }] }),
    getByRole: () => ({ click: async () => { throw new Error('Forbidden scene tap'); } }) } as unknown as BrowserPage;
  await expect(viewGameResults(page, 308, async () => {})).rejects.toThrow(/no player identity|connection restart|different game|album is already closing/);
});
it('@negative-control never taps a scene or the skip while the long-wait notice shows, and names it at the deadline', async () => {
  let now = 1_000_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 10_000));
  try {
    const page = { evaluate: async () => ({ path: '/chest', game: '308', scene: true, slow: true, buttons: [{ name: 'Continue', enabled: true }] }),
      getByRole: () => ({ click: async () => { throw new Error('Forbidden tap'); } }) } as unknown as BrowserPage;
    await expect(viewGameResults(page, 308, async () => {}, { timeoutMs: 30_000 })).rejects.toThrow(/long-wait skip while its results settle.*\(0 opening taps\)/);
  } finally { clock.mockRestore(); }
}, 20_000);
it('the Pocket Claim all proves the opened chest without being pressed', async () => {
  const page = { evaluate: async () => ({ path: '/chest', game: '308', scene: true, buttons: [{ name: 'Claim all', enabled: true }] }),
    getByRole: () => ({ click: async () => { throw new Error('Forbidden tap'); }, press: async () => { throw new Error('Forbidden press'); } }) } as unknown as BrowserPage;
  expect((await viewGameResults(page, 308, async () => {})).reveal).toBe('opened');
});
it('@negative-control a disabled Claim all never proves the current chest is ready', async () => {
  let now = 1000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const page = { evaluate: async () => ({ path: '/chest', game: '308', scene: true, buttons: [{ name: 'Claim all', enabled: false }] }),
    getByRole: () => ({ click: async () => { now += 21; } }) } as unknown as BrowserPage;
  try {
    await expect(viewGameResults(page, 308, async () => {}, { timeoutMs: 20 })).rejects.toThrow('waiting for an enabled Continue');
  } finally { clock.mockRestore(); }
});
it('preserves browser failures and cancellation during scene input', async () => {
  const controller = new AbortController();
  const page = { evaluate: async () => ({ path: '/chest', game: '308', scene: true, buttons: [] }),
    getByRole: () => ({ click: async () => { throw new Error('host input failed'); } }) } as unknown as BrowserPage;
  await expect(viewGameResults(page, 308, async () => {})).rejects.toThrow('host input failed');
  page.getByRole = (() => ({ click: async () => { controller.abort(new Error('cancelled opening')); throw new Error('element was detached'); } })) as unknown as typeof page.getByRole;
  await expect(viewGameResults(page, 308, async () => {}, { signal: controller.signal })).rejects.toThrow('cancelled opening');
});
