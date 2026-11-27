// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { chestObservation, LONG_WAIT_BOUND_MS, readChest, viewGameResults } from '../../lab/flows/post-game.ts';
import { continueToDim2Results, returnFromDim2 } from '../../../../lab/shared/upstream/lab/steps/dim2/results.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ''; });
function harness({ empty = false, automatic = false, refuseOnce = false, pocket = false } = {}) {
  let opened = false, closing = false, returned = false, refused = false;
  const clicks: string[] = [];
  const render = () => {
    if (automatic && Date.now() >= 102_000) opened = true;
    window.history.replaceState(null, '', '/chest?game=308');
    document.body.innerHTML = '<canvas role="img" aria-label="Your chest opening"></canvas>'
      + (pocket
        ? (opened ? `<div class="pocket-claim" data-shut="${closing}">${closing ? '<h1>Added to your Pocket</h1><button>Continue</button>' : '<button>Claim all</button>'}</div>` : '')
        : `<footer style="pointer-events:${opened ? 'auto' : 'none'};opacity:${opened ? 1 : 0}"><button>Continue</button></footer>`
          + (closing ? '<div class="album-close"><h1>Added to your Pocket</h1><button>Continue</button></div>' : ''));
    for (const el of document.querySelectorAll('*')) el.getClientRects = () => ({ length: 1 }) as DOMRectList;
    Object.defineProperty(document.body, 'innerText', { configurable: true, get: () => document.body.textContent ?? '' });
  };
  const evaluate = (read: (arg: unknown) => unknown, arg: unknown) => {
    render(); return new Function('arg', `return (${read.toString()})(arg)`)(arg);
  };
  const page = { evaluate: async (read: (arg: unknown) => unknown, arg: unknown) => evaluate(read, arg),
    locator: (selector: string) => ({
      evaluate: async (read: (body: Element, arg: unknown) => unknown, arg: unknown) => {
        render(); return new Function('body', 'arg', `return (${read.toString()})(body,arg)`)(document.body, arg);
      }, click: async () => {
        expect(selector).toBe('.album-close button, .pocket-claim[data-shut="true"] button'); expect(closing).toBe(true); clicks.push('album Continue');
        if (refuseOnce && !refused) refused = true; else returned = true;
      },
    }),
    getByRole: (role: string, options: { name: string; exact: boolean }) => ({ press: async (key: string) => {
      expect([role, options.name, key]).toEqual(['button', 'Claim all', 'Enter']); expect(pocket && opened && !closing).toBe(true);
      clicks.push('Claim all'); closing = true;
    }, click: async () => {
      expect(options.exact).toBe(true);
      if (role === 'img') { expect(options.name).toBe('Your chest opening'); clicks.push('bubble'); if (!empty && !automatic) opened = true; }
      else {
        expect(role).toBe('button'); expect(options.name).toBe('Continue');
        if (closing) throw new Error('Strict locator matched two Continue buttons');
        expect(opened).toBe(true); clicks.push('footer Continue'); closing = true;
      }
    } }),
  } as unknown as BrowserPage;
  return { page, clicks, render, returned: () => returned };
}
async function finish<T>(task: Promise<T>, ms = 3000) {
  const settled = task.then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}
/** Answer only the chest observation with `view`; every other read (telemetry, the final screen) stays real.
 *  Every click attempt is recorded before the harness checks it, so a refused or swallowed click still shows. */
function chestShows(h: ReturnType<typeof harness>, view: () => unknown) {
  const attempts: string[] = [];
  const realLocator = h.page.locator, realRole = h.page.getByRole;
  h.page.locator = ((selector: string) => {
    const inner = realLocator(selector);
    return { ...inner, evaluate: async (read: unknown, arg: unknown) => read === chestObservation ? view() : inner.evaluate(read as never, arg),
      click: async () => { attempts.push(`locator ${selector}`); return inner.click(); } };
  }) as typeof h.page.locator;
  h.page.getByRole = ((role: string, options: { name: string; exact: boolean }) => {
    const inner = realRole(role, options);
    return { ...inner, click: async () => { attempts.push(`${role} ${options.name}`); return inner.click(); } };
  }) as typeof h.page.getByRole;
  return attempts;
}
it('the copied payoff helper opens the bubble despite a hidden Continue and stops before either exit', async () => {
  const h = harness();
  expect(await finish(continueToDim2Results(h.page, undefined, { timeoutMs: 2500 }))).toMatchObject({ value: { controls: [], returnPath: null } });
  expect(h.clicks).toEqual(['bubble']);
});
it('the copied return helper takes footer Continue, then only the album Continue, and retries a refused hand-off', async () => {
  const h = harness({ refuseOnce: true });
  const result = await finish(returnFromDim2(h.page, h.returned, undefined, { timeoutMs: 10_000 }), 10_000);
  expect(result).toMatchObject({ value: { returnPath: 'chest-continue', controls: [
    { path: '/chest', name: 'Continue' }, { path: '/chest', name: 'Continue' }, { path: '/chest', name: 'Continue' },
  ] } });
  expect(h.clicks).toEqual(['bubble', 'footer Continue', 'album Continue', 'album Continue']); expect(h.returned()).toBe(true);
});
it('the copied return helper presses Claim all on the Pocket, then only the shut Pocket Continue', async () => {
  const h = harness({ pocket: true });
  const result = await finish(returnFromDim2(h.page, h.returned, undefined, { timeoutMs: 10_000 }), 10_000);
  expect(result).toMatchObject({ value: { returnPath: 'chest-continue', controls: [
    { path: '/chest', name: 'Claim all' }, { path: '/chest', name: 'Continue' },
  ] } });
  expect(h.clicks).toEqual(['bubble', 'Claim all', 'album Continue']); expect(h.returned()).toBe(true);
});
it('the copied payoff helper stops at the Pocket without pressing Claim all', async () => {
  const h = harness({ pocket: true });
  expect(await finish(continueToDim2Results(h.page, undefined, { timeoutMs: 2500 }))).toMatchObject({ value: { controls: [], returnPath: null } });
  expect(h.clicks).toEqual(['bubble']);
});
it('waits for automatic opening without ever clicking Continue in the held-results step', async () => {
  const h = harness({ automatic: true });
  expect(await finish(continueToDim2Results(h.page, undefined, { timeoutMs: 2500 }))).toMatchObject({ value: { controls: [] } });
  expect(h.clicks).toEqual(['bubble', 'bubble']);
});
it('@negative-control an empty mounted bubble and its hidden footer never count as results in either driver', async () => {
  const h = harness({ empty: true });
  expect(await finish(continueToDim2Results(h.page, undefined, { timeoutMs: 1200 }))).toMatchObject({
    error: expect.objectContaining({ message: expect.stringContaining("DIM2 did not show /results + Done or the chest's Continue") }),
  });
  expect(h.clicks).toEqual(['bubble', 'bubble']);
  const task = viewGameResults(h.page, 308, async () => {}, { timeoutMs: 20 });
  expect(await finish(task, 100)).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining('waiting for an enabled Continue') }) });
  expect(h.returned()).toBe(false);
});
it.each(['noIdentity', 'restart', 'closing'] as const)('@negative-control the copied preparation rejects %s before tapping the scene or an exit', async marker => {
  const h = harness();
  h.page.locator = (() => ({ evaluate: async () => ({ path: '/chest', game: '308', scene: true, [marker]: true,
    buttons: [{ name: 'Continue', enabled: true }] }) })) as unknown as typeof h.page.locator;
  expect(await finish(continueToDim2Results(h.page, undefined, { timeoutMs: 1000 }))).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/no player identity|connection restart|album is already closing/) }) });
  expect(h.clicks).toEqual([]);
});
it('@negative-control the copied walker never takes the long-wait skip, preparing or returning, and names it at the deadline', async () => {
  for (const returning of [false, true]) {
    const h = harness();
    const attempts = chestShows(h, () => ({ path: '/chest', game: '308', scene: true, slow: true, buttons: [{ name: 'Continue', enabled: true }] }));
    const task = returning ? returnFromDim2(h.page, () => false, undefined, { timeoutMs: 1000 }) : continueToDim2Results(h.page, undefined, { timeoutMs: 1000 });
    // The notice extends the 1 s bound to LONG_WAIT_BOUND_MS: still waiting just before it, failed just after.
    let outcome: unknown = 'pending';
    task.then(value => { outcome = { value }; }, (error: unknown) => { outcome = { error }; });
    await vi.advanceTimersByTimeAsync(LONG_WAIT_BOUND_MS - 2000);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(5000);
    expect(outcome).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining("the chest's long-wait skip was offered") }) });
    expect(attempts).toEqual([]); expect(h.clicks).toEqual([]);
  }
});
it('waits through the long-wait notice until the claims replace it, then stops before Continue', async () => {
  const h = harness();
  let reads = 0;
  const attempts = chestShows(h, () => ({ path: '/chest', game: '308', scene: true, slow: ++reads <= 3, buttons: [{ name: 'Continue', enabled: true }] }));
  const done = await finish(continueToDim2Results(h.page, undefined, { timeoutMs: 2500 }));
  expect(done).toMatchObject({ value: { controls: [], longWait: { shownMs: 0, clearedMs: 750 } } });
  expect(reads).toBe(4); expect(attempts).toEqual([]); expect(h.clicks).toEqual([]);
});
it('@negative-control restarts the long-wait record when the notice shows again after clearing', async () => {
  const h = harness();
  let reads = 0;
  // Up, cleared (bubble not yet usable), then up again until the deadline.
  chestShows(h, () => (++reads === 2
    ? { path: '/chest', game: '308', scene: true, buttons: [{ name: 'Continue', enabled: false }] }
    : { path: '/chest', game: '308', scene: true, slow: true, buttons: [{ name: 'Continue', enabled: true }] }));
  let outcome: unknown = 'pending';
  continueToDim2Results(h.page, undefined, { timeoutMs: 1000 }).then(value => { outcome = { value }; }, (error: unknown) => { outcome = { error }; });
  await vi.advanceTimersByTimeAsync(LONG_WAIT_BOUND_MS + 5000);
  expect(outcome).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/long-wait skip was offered from \d+ s before this and never taken/) }) });
});
it('records the second showing when a cleared long-wait notice returns before claims', async () => {
  const h = harness();
  let reads = 0;
  chestShows(h, () => {
    const read = ++reads;
    return { path: '/chest', game: '308', scene: true, slow: read === 1 || read === 3,
      buttons: [{ name: 'Continue', enabled: read !== 2 }] };
  });
  expect(await finish(continueToDim2Results(h.page, undefined, { timeoutMs: 2500 }))).toMatchObject({
    value: { controls: [], longWait: { shownMs: 500, clearedMs: 750 } },
  });
  expect(reads).toBe(4); expect(h.clicks).toEqual(['bubble']);
});
it('records the notice as cleared when the page leaves the chest', async () => {
  const h = harness();
  let reads = 0;
  chestShows(h, () => (++reads <= 2
    ? { path: '/chest', game: '308', scene: true, slow: true, buttons: [{ name: 'Continue', enabled: true }] }
    : { path: '/results', game: '308', buttons: [{ name: 'Done', enabled: true }] }));
  expect(await finish(continueToDim2Results(h.page, undefined, { timeoutMs: 2500 }))).toMatchObject({ value: { longWait: { shownMs: 0, clearedMs: 500 } } });
});
it('@negative-control observes ancestor opacity and pointer events, then only the album exit when labels duplicate', async () => {
  const h = harness(); h.render();
  expect(await readChest(h.page)).toMatchObject({ scene: true, closing: false, buttons: [{ name: 'Continue', enabled: false }] });
  // Use the serialized production reader on DOM matching the footer and overlay, without the fixture rerender.
  h.page.evaluate = (async (read: () => unknown) => new Function(`return (${read.toString()})()`)()) as unknown as typeof h.page.evaluate;
  const footer = document.querySelector('footer')!;
  footer.style.pointerEvents = 'auto'; footer.style.opacity = '0';
  expect((await readChest(h.page))?.buttons[0]?.enabled).toBe(false);
  footer.style.opacity = '1'; footer.style.pointerEvents = 'none';
  expect((await readChest(h.page))?.buttons[0]?.enabled).toBe(false);
  footer.style.pointerEvents = 'auto';
  expect((await readChest(h.page))?.buttons[0]?.enabled).toBe(true);
  document.body.insertAdjacentHTML('beforeend', '<div class="album-close"><div style="opacity:0"><button>Continue</button></div></div>');
  for (const el of document.querySelectorAll('.album-close, .album-close *')) el.getClientRects = () => ({ length: 1 }) as DOMRectList;
  expect(await readChest(h.page)).toMatchObject({ closing: true, buttons: [{ name: 'Continue', enabled: false }] });
  (document.querySelector('.album-close > div') as HTMLElement).style.opacity = '1';
  expect((await readChest(h.page))?.buttons).toEqual([{ name: 'Continue', enabled: true }]);
});
it('@negative-control the copied preparation never presses the chest Continue, even on an unbacked chest', async () => {
  const h = harness(); const clicks: string[] = [];
  const view = { path: '/chest', game: '308', scene: false, heading: false, gameLabel: false,
    closing: false, buttons: [{ name: 'Continue', enabled: true }] };
  h.page.locator = (() => ({ evaluate: async (_read: unknown, query?: unknown) => query ? [] : view })) as unknown as typeof h.page.locator;
  h.page.getByRole = ((role: string, options: { name: string }) => ({ click: async () => { clicks.push(role + ':' + options.name); } })) as unknown as typeof h.page.getByRole;
  expect(await finish(continueToDim2Results(h.page, undefined, { timeoutMs: 1200 }))).toMatchObject({
    error: expect.objectContaining({ message: expect.stringContaining("DIM2 did not show /results + Done or the chest's Continue") }),
  });
  expect(clicks).toEqual([]);
});
