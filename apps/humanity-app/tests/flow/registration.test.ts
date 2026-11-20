// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { readRegistrationView, registerWhenReady, sentRegistrationClick, type RegistrationInput } from '../../../../lab/shared/registration.ts';

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  Object.defineProperty(document.body, 'innerText', { configurable: true, get() { return this.textContent; } });
  window.history.replaceState(null, '', '/'); document.body.innerHTML = '';
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function harness() {
  const controller = new AbortController(), attached: unknown[] = [];
  let proven = false;
  const click = vi.fn(async () => { proven = true; });
  const page = { evaluate: async (read: () => unknown) => new Function(`return (${read.toString()})()`)(),
    getByRole: vi.fn(() => ({ click })) } as unknown as BrowserPage;
  const options = { actor: 'Alice', signal: controller.signal, check: vi.fn(), beforeClick: vi.fn(async () => {}),
    registered: vi.fn(async () => proven ? { finalized: true } : undefined), attach: async (v: unknown) => { attached.push(v); }, timeoutMs: 1000, pollMs: 100 };
  return { page, options, click, attached, controller, prove: () => { proven = true; } };
}
const button = (disabled = false) => { document.body.innerHTML = `<button ${disabled ? 'disabled' : ''}>Register</button>`; };
it('waits for a delayed enabled control, with no input while it is absent or disabled', async () => {
  const h = harness(); button(true); const task = registerWhenReady(h.page, h.options);
  await vi.advanceTimersByTimeAsync(300); expect(h.click).not.toHaveBeenCalled();
  button(); await vi.advanceTimersByTimeAsync(100);
  await expect(task).resolves.toEqual({ finalized: true }); expect(h.click).toHaveBeenCalledTimes(1);
});
it('@negative-control reproduces the exact original fail-fast error on a readable disabled view', async () => {
  const h = harness(); button(true); const current = await readRegistrationView(h.page);
  expect(() => { const control = current?.buttons.find(b => !b.disabled && /^(Register|Sign up|Join game)$/.test(b.name));
    if (!control) throw new Error('No enabled lite registration control'); }).toThrow('No enabled lite registration control');
});
it.each([false, true])('@negative-control times out with an explicit absent/disabled reason (%s)', async disabled => {
  const h = harness(); if (disabled) button(true);
  const task = expect(registerWhenReady(h.page, h.options)).rejects.toThrow(disabled ? 'lite registration control is still disabled' : 'no enabled lite registration control on DIM2 home');
  await vi.advanceTimersByTimeAsync(1000); await task;
  expect(h.click).not.toHaveBeenCalled(); expect(h.attached).toHaveLength(1);
});
it('handles the late permission redirect, then waits for Register, and clicks each control once', async () => {
  const h = harness(); window.history.replaceState(null, '', '/permissions'); document.body.innerHTML = '<button>Allow access</button>';
  h.page.getByRole = vi.fn((_role, options) => ({ click: async () => {
    if (options?.name === 'Allow access') { window.history.replaceState(null, '', '/'); button(); }
    else { await h.click(); }
  } })) as unknown as typeof h.page.getByRole;
  const task = registerWhenReady(h.page, h.options); await vi.advanceTimersByTimeAsync(300); await task;
  expect(h.page.getByRole).toHaveBeenCalledTimes(2); expect(h.click).toHaveBeenCalledTimes(1);
});
it('never retries an ambiguous registration click, even when Register reappears before finality', async () => {
  const h = harness(); button(); h.click.mockImplementation(async () => { throw Object.assign(new Error('input outcome unknown'), { name: 'TimeoutError' }); });
  const task = registerWhenReady(h.page, h.options); await vi.advanceTimersByTimeAsync(400);
  expect(h.click).toHaveBeenCalledTimes(1); h.prove(); await vi.advanceTimersByTimeAsync(100); await task;
  expect(h.click).toHaveBeenCalledTimes(1);
});
it('@negative-control never treats an ambiguous click as registration without finalized proof', async () => {
  const h = harness(); button(); h.click.mockImplementation(async () => { button(true); throw Object.assign(new Error('changed UI'), { name: 'TimeoutError' }); });
  const task = expect(registerWhenReady(h.page, h.options)).rejects.toThrow('registration click attempted; no finalized registration (no second click)');
  await vi.advanceTimersByTimeAsync(1000); await task; expect(h.click).toHaveBeenCalledTimes(1);
});
it('waits for an existing in-progress signup without clicking again', async () => {
  const h = harness(); document.body.innerHTML = '<button disabled>Saving your seat…</button>';
  const task = registerWhenReady(h.page, h.options); await vi.advanceTimersByTimeAsync(200); h.prove(); await vi.advanceTimersByTimeAsync(100); await task;
  expect(h.click).not.toHaveBeenCalled();
});
it('@negative-control preserves native-PAS refusal, game guard, app failure and cancellation', async () => {
  const native = harness(); document.body.innerHTML = '<p>deposit required</p>'; await expect(registerWhenReady(native.page, native.options)).rejects.toThrow('Native PAS was requested');
  const guard = harness(); button(); guard.options.beforeClick.mockRejectedValue(new Error('Wrong game or foreign registration'));
  await expect(registerWhenReady(guard.page, guard.options)).rejects.toThrow('Wrong game or foreign registration'); expect(guard.click).not.toHaveBeenCalled();
  const failure = harness(); failure.options.check.mockImplementation(() => { throw new Error('report failed'); });
  await expect(registerWhenReady(failure.page, failure.options)).rejects.toThrow('report failed');
  const abort = harness(); document.body.innerHTML = ''; const task = expect(registerWhenReady(abort.page, abort.options)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(100); abort.controller.abort(); await vi.advanceTimersByTimeAsync(100); await task;
});
it('rechecks a view changed between the ready observation and input, without clicking its stale control', async () => {
  const h = harness(); button(); let changed = false;
  h.options.beforeClick.mockImplementation(async () => { if (!changed) { changed = true; button(true); } });
  const task = registerWhenReady(h.page, h.options); await vi.advanceTimersByTimeAsync(300); expect(h.click).not.toHaveBeenCalled();
  button(); await vi.advanceTimersByTimeAsync(200); await task; expect(h.click).toHaveBeenCalledTimes(1);
});
it('reports the withheld attempt and the one real click separately, so a guard that ran twice is never two clicks', async () => {
  const h = harness(); button(); let changed = false; const inputs: RegistrationInput[] = [];
  h.options.beforeClick.mockImplementation(async () => { if (!changed) { changed = true; button(true); } });
  const task = registerWhenReady(h.page, { ...h.options, input: (sent: RegistrationInput) => { inputs.push(sent); } });
  await vi.advanceTimersByTimeAsync(300); button(); await vi.advanceTimersByTimeAsync(200); await task;
  expect(h.options.beforeClick).toHaveBeenCalledTimes(2); expect(h.click).toHaveBeenCalledTimes(1);
  expect(inputs.map(i => [i.control, i.sent, i.reason, i.view?.buttons])).toEqual([
    ['Register', 'withheld', 'view changed before the click', [{ name: 'Register', disabled: true }]],
    ['Register', 'clicked', undefined, [{ name: 'Register', disabled: false }]]]);
  expect(inputs.filter(sentRegistrationClick)).toHaveLength(1);
});
it('@negative-control a registration found after the guard and before the click is withheld, not a click', async () => {
  const h = harness(); button(); const inputs: RegistrationInput[] = [];
  h.options.beforeClick.mockImplementation(async () => { h.prove(); });
  await registerWhenReady(h.page, { ...h.options, input: (sent: RegistrationInput) => { inputs.push(sent); } });
  expect(h.click).not.toHaveBeenCalled();
  expect(inputs.map(i => [i.control, i.sent, i.reason])).toEqual([['Register', 'withheld', 'registration found before the click']]);
  expect(inputs.filter(sentRegistrationClick)).toHaveLength(0);
});
it('@negative-control an ambiguous click is reported as maybe sent, and still counts', async () => {
  const h = harness(); button(); const inputs: RegistrationInput[] = [];
  h.click.mockImplementation(async () => { h.prove(); throw Object.assign(new Error('input outcome unknown'), { name: 'TimeoutError' }); });
  await registerWhenReady(h.page, { ...h.options, input: (sent: RegistrationInput) => { inputs.push(sent); } });
  expect(inputs.map(i => [i.control, i.sent])).toEqual([['Register', 'maybe']]); expect(inputs.filter(sentRegistrationClick)).toHaveLength(1);
});
it('@negative-control propagates non-race browser errors instead of waiting them away', async () => {
  const h = harness(); button(); h.click.mockRejectedValue(new Error('Target page has been closed'));
  await expect(registerWhenReady(h.page, h.options)).rejects.toThrow('Target page has been closed');
});
it('@negative-control a permission gate that never completes fails explicitly after one permission attempt', async () => {
  const h = harness(); window.history.replaceState(null, '', '/permissions'); document.body.innerHTML = '<button>Allow access</button>';
  h.click.mockImplementation(async () => {});
  const task = expect(registerWhenReady(h.page, h.options)).rejects.toThrow('permission gate has not completed');
  await vi.advanceTimersByTimeAsync(1000); await task; expect(h.click).toHaveBeenCalledTimes(1);
});
it('@negative-control registration evidence excludes identity, query, arbitrary controls and text', async () => {
  const h = harness(); window.history.replaceState(null, '', '/private-fixture?identity=private-fixture'); document.body.innerHTML = '<p>private-fixture</p><button>private-fixture</button><button disabled>Register</button>';
  const view = await readRegistrationView(h.page); expect(view?.path).toBe('[other route]'); expect(JSON.stringify(view)).not.toContain('private-fixture');
});
