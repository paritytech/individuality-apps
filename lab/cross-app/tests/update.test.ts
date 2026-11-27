// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { customSteps, type StepContext } from '@parity/product-lab/steps';

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, save: vi.fn(), output: '', clock: 1000 }));
vi.mock('../../shared/session.ts', () => ({ scenario: () => f.state }));
vi.mock('../steps.ts', () => ({ save: f.save, output: () => f.output, capMs: 180_000 }));
vi.mock('../../shared/storage.ts', () => ({ flowStorage: async (_a: unknown, _p: string, item: string) => item === 'Game' ? { index: 42, game_date: 2000 } : { registered: false } }));
import '../update.ts';

beforeEach(() => {
  vi.clearAllMocks(); f.clock = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => f.clock);
  f.output = mkdtempSync(join(tmpdir(), 'update-gate-'));
  writeFileSync(join(f.output, 'navigations.jsonl'), JSON.stringify({ at: 1000, url: 'polkadot://dim2.paseo' }) + '\n');
});
afterEach(() => { vi.restoreAllMocks(); rmSync(f.output, { recursive: true, force: true }); document.body.innerHTML = ''; });

function harness(problem?: 'permissions' | 'account' | 'flash' | 'redrop' | 'glitch' | 'glitch-register') {
  const clicks: string[] = [];
  let phase = '', poll = 0, initialClicks = 0, recoveryClicks = 0, gateAt = 0, redropped = false, redropAt = 0, glitchPoll = 0, glitchAt = 0;
  const render = () => {
    const permission = phase === 'real local update gate' ? initialClicks === 0 : recoveryClicks === 0 || problem === 'permissions';
    const flash = problem === 'flash' && poll % 2 === 0;
    // 'glitch' / 'glitch-register': for one poll partway through the hold the account is wrong or Register is enabled,
    // while the page's update mark stays put.
    if ((problem === 'glitch' || problem === 'glitch-register') && !glitchPoll && gateAt && phase !== 'real local update gate' && f.clock - gateAt >= 500) { glitchPoll = poll; glitchAt = f.clock; }
    const glitching = glitchPoll !== 0 && poll === glitchPoll;
    const account = problem === 'account' || (glitching && problem === 'glitch') ? 'Eve' : 'Ada';
    const register = glitching && problem === 'glitch-register' ? '<button>Register</button>' : '';
    const path = permission ? '/permissions' : '/';
    window.history.replaceState(null, '', path);
    document.body.innerHTML = permission ? '<button>Allow access</button>' : flash ? '' : `<main data-testid="home-update" data-account="${account}">A new version is out${register}</main>`;
    Object.defineProperty(document.body, 'innerText', { configurable: true, get: () => document.body.textContent ?? '' });
    const update = !permission && !flash;
    if (update && !gateAt) gateAt = f.clock;
    if (!update) gateAt = 0;
    // 'redrop': the screen keeps the gate, but the page's marks show it dropped and returned between two polls.
    if (problem === 'redrop' && update && phase !== 'real local update gate' && f.clock - gateAt >= 500 && !redropped) { redropped = true; gateAt = redropAt = f.clock; }
    Object.assign(window, { __crossJourney: { loaded: 1000, views: [{ at: gateAt || f.clock, view: { update } }] } });
  };
  const page = {
    evaluate: async (read: () => unknown) => { render(); return new Function(`return (${read.toString()})()`)(); },
    getByRole: (_role: string, options: { name: string }) => ({ click: async () => {
      clicks.push(options.name);
      if (options.name === 'Allow access') { if (phase === 'real local update gate') initialClicks++; else recoveryClicks++; }
    } }),
  };
  const actor = { game: { address: 'Ada' }, view: { page }, session: { evidence: { runDir: f.output } }, jollity: { page, session: { open: vi.fn(), page: async () => page } } };
  f.state = { actor: () => actor, apps: { humanity: 'http://127.0.0.1:1', jollity: 'http://127.0.0.1:2' },
    versionFile: { url: 'http://127.0.0.1:3/version', set: vi.fn(), requests: [] },
    crossAppLog: [{ url: 'http://127.0.0.1:1', text: 'name link unfunded' }],
    people: { access: { bestHead: async () => ({ hash: 'best' }) } },
    chain: { current: { index: 42, playsAt: 2000 }, until: async (label: string, read: () => Promise<unknown>, ms: number) => {
      phase = label; poll = 0;
      const end = f.clock + ms;
      while (f.clock <= end) { poll++; const value = await read(); if (value !== undefined) return value; f.clock += 250; }
      throw Error(`Timed out: ${label}`);
    } },
  };
  return { clicks, recoveryClicks: () => recoveryClicks, redropAt: () => redropAt, glitchAt: () => glitchAt };
}
const run = () => customSteps().find(s => s.pattern.text === 'Ada meets the local update gate during entry, U3 run {string}')!
  .run({ lab: { attach: vi.fn() } } as unknown as StepContext, '1');

it('allows permissions once more after the first update gate, then waits for the same-account gate to hold', async () => {
  const h = harness();
  await run();
  expect(h.clicks).toEqual(['Register', 'Allow access', 'Allow access']);
  expect(f.save).toHaveBeenCalledOnce();
  const [value, raw] = f.save.mock.calls[0]!;
  expect(raw.gate).toMatchObject({ path: '/', account: 'Ada', register: false });
  expect(raw.actions.filter((a: { name: string }) => a.name.includes('permission'))).toHaveLength(2);
  expect(value.totalMs).toBe(raw.shown.at - raw.tap);
  expect(f.clock - raw.shown.at).toBeGreaterThanOrEqual(1000);
  const recovery = raw.actions.find((a: { name: string }) => a.name === 'lab permission click after gate');
  expect(raw.shown.at).toBeGreaterThan(recovery.done);
});
it('restarts the one-second hold when the gate dropped and came back between polls', async () => {
  const h = harness('redrop');
  await run();
  const [, raw] = f.save.mock.calls[0]!;
  // The page re-marked the gate partway through the hold; the endpoint is the later mark and it must still hold a full second.
  expect(raw.shown.at).toBe(h.redropAt());
  expect(f.clock - raw.shown.at).toBeGreaterThanOrEqual(1000);
});
it.each(['glitch', 'glitch-register'] as const)('restarts the one-second hold after a one-poll %s while the update mark stays', async problem => {
  const h = harness(problem);
  await run();
  const [, raw] = f.save.mock.calls[0]!;
  expect(h.glitchAt()).toBeGreaterThan(0);
  // The hold restarts on the poll after the bad one, so a full second of good polls ends after glitch + 1000.
  expect(f.clock - h.glitchAt()).toBeGreaterThan(1000);
  // The page's update mark did not move, so neither does the endpoint.
  expect(raw.shown.at).toBe(h.glitchAt() - 500);
});
it.each(['permissions', 'account', 'flash'] as const)('@negative-control: a returning %s screen cannot pass or cause repeated permission clicks', async problem => {
  const h = harness(problem);
  await expect(run()).rejects.toThrow('Timed out: blocked local entry retains Ada account');
  expect(h.recoveryClicks()).toBe(1); expect(f.save).not.toHaveBeenCalled();
});
