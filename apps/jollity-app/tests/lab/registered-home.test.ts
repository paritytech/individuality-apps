// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { customSteps } from '@parity/product-lab/steps';
import { awaitRegisteredHome, isRegisteredHome, type HomeObservation } from '../../lab/scenarios/home.ts';
import '../../lab/scenarios/steps.ts';
const registered: HomeObservation = { visible: true, source: 'host', account: 'Ada', phase: 'registration', registered: 'true', copy: ["You're in", 'Game starts at 12:05'] };
// What the app shows before sign-up: the Register band, its "Next game" badge and data-registered="false".
const registerScreen: HomeObservation = { ...registered, registered: 'false', copy: ['Next game', 'Game starts at 12:05'] };
it('accepts only the registered home for its own host account', () => {
  expect(isRegisteredHome(registered, 'Ada')).toBe(true);
  for (const change of [{ visible: false }, { source: 'mock' }, { account: 'Bob' }, { registered: 'false' }, { copy: ['Next game'] },
    { copy: ["You're in", 'Next game'] }, { copy: ['Top up to play'] }])
    expect(isRegisteredHome({ ...registered, ...change }, 'Ada'), JSON.stringify(change)).toBe(false);
  expect(isRegisteredHome(null, 'Ada')).toBe(false);
});
it('waits for the registered home after the sign-up lands', async () => {
  const views = [registerScreen, null, registered];
  await expect(awaitRegisteredHome(async () => views.shift() ?? registered, 'Ada', { pollMs: 1, timeoutMs: 5_000 })).resolves.toEqual(registered);
});
const key = Symbol.for('jollity-app.scenarios-b');
const registry = globalThis as typeof globalThis & { [key]?: unknown };
afterEach(() => { delete registry[key]; vi.useRealTimers(); });
async function runStep(view: HomeObservation) {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Each read advances the clock by 50 s, so the step's 120 s wait ends after three reads.
  const page = { evaluate: async () => { vi.setSystemTime(Date.now() + 50_000); return view; } };
  registry[key] = { player: () => ({ game: { address: 'Ada' }, view: { page } }), people: { signal: new AbortController().signal } };
  const definition = customSteps().find(step => step.pattern.text === '{actor} sees the registered DIM2 home');
  if (!definition) throw Error('Missing registered-home step');
  const attached: unknown[] = [];
  await definition.run({ lab: { attach: async (value: unknown) => { attached.push(value); } } } as unknown as Parameters<typeof definition.run>[0], 'Ada');
  return attached;
}
it('the real B2 step passes on the registered home', async () => {
  expect(JSON.stringify(await runStep(registered))).toContain("You're in");
});
it('B2 asserts the home it read as soon as the registration was final, not a later one', () => {
  // After registration closes the home becomes the waiting room and hands over to /game, so a late read would race it.
  const source = readFileSync(new URL('../../lab/scenarios/steps.ts', import.meta.url), 'utf8');
  const register = source.slice(source.indexOf("step('{actor} registers for the game in DIM2'"), source.indexOf("step(\"{actor}'s DIM2 registration on chain is:\""));
  expect(register).toMatch(/clicks !== 1[\s\S]*awaitRegisteredHome[\s\S]*registeredHomes\.set\(player\.game\.address/);
});
it('negative control: the real B2 step pointed at the register screen fails', async () => {
  await expect(runStep(registerScreen)).rejects.toThrow("DIM2 home does not show You're in, registered, for its host account");
});
/**
 * Runs the real B2 step '{actor} registers for the game in DIM2' through the shared helper. Between the helper's guard and
 * its re-check the Register control turns disabled once, so the helper withholds that attempt, then clicks once for real.
 * The step counts sent clicks, so it passes; the old count (one per guard call) made this two and failed #1961's run.
 */
async function runRegisterStep() {
  const clicks: string[] = [], served: string[] = [];
  let registrationViews = 0, clicked = false;
  const view = (button: string, disabled: boolean) => ({ path: '/', nativePasRequested: false, buttons: [{ name: button, disabled }] });
  const page = {
    evaluate: async (read: () => unknown) => {
      const source = read.toString();
      if (source.includes('data-registered')) return registered;
      if (!source.includes('nativePasRequested')) throw Error('Unexpected browser read');
      registrationViews++;
      // Read 1 is the helper's first look, read 2 its re-check after the guard: the control changed in between.
      const seen = clicked ? view('Saving your seat…', true) : registrationViews === 2 ? view('Register', true) : view('Register', false);
      served.push(`${seen.buttons[0]!.name}${seen.buttons[0]!.disabled ? ' (disabled)' : ''}`);
      return seen;
    },
    getByRole: (_role: string, options: { name: string }) => ({ click: async () => { clicks.push(options.name); clicked = true; } }),
  };
  let block = 100;
  const read = async () => ({ at: { number: ++block, hash: `0x${block.toString(16)}` }, value: { registered: clicked } });
  registry[key] = { player: () => ({ actor: { id: 'ada-1', name: 'Ada' }, game: { address: 'Ada' }, view: { page } }),
    people: { signal: new AbortController().signal }, chain: { read, transactions: { assertHealthy: () => {} } } };
  const definition = customSteps().find(step => step.pattern.text === '{actor} registers for the game in DIM2');
  if (!definition) throw Error('Missing DIM2 registration step');
  const attached: unknown[] = [];
  await definition.run({ lab: { attach: async (value: unknown) => { attached.push(value); } } } as unknown as Parameters<typeof definition.run>[0], 'Ada');
  return { clicks, served, attached };
}
it('the real B2 registration step passes when one attempt is withheld after the guard and one click is sent', async () => {
  const { clicks, served, attached } = await runRegisterStep();
  expect(clicks).toEqual(['Register']);
  // First look, re-check (changed: withheld), second look, re-check (clicked), then the seat while the row finalizes.
  expect(served).toEqual(['Register', 'Register (disabled)', 'Register', 'Register', 'Saving your seat… (disabled)']);
  expect(attached).toEqual([]);
}, 10_000);
