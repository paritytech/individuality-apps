// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { assertCredits, assertCreditsKept, assertChestOpened, assertChestContinue, awaitVesselOpening, creditReader, readVesselOpening, seedResults, type VesselOpening } from '../../lab/scenarios/results.ts';
import type { ChestView } from '../../../../lab/shared/post-game.ts';
import type { CreditReading } from '../../../../lab/shared/upstream/three-apps/chain.ts';
import type { ScenarioChain } from '../../../../lab/shared/chain.ts';
import type { GameParticipant } from '../../../../lab/shared/upstream/lab/steps/games/participant.ts';
import type { PapiChainAccess } from '@parity/product-lab/chain-papi';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { playReason, prizeReason } from '../../lab/scenarios/pending.ts';
it('negative control requires exactly two delivered and unspent credits', () => {
  const reading = { credits: [{ delivered: true, claimed: false }, { delivered: true, claimed: false }] } as unknown as CreditReading;
  expect(() => assertCredits(reading, 2)).not.toThrow();
  expect(() => assertCredits(reading, 3)).toThrow('do not equal');
  expect(() => assertCredits({ ...reading, credits: reading.credits.map(c => ({ ...c, claimed: true })) }, 2)).toThrow('do not equal');
  expect(() => assertCredits({ ...reading, credits: reading.credits.map(c => ({ ...c, delivered: false })) }, 2)).toThrow('do not equal');
});
it('pins the runtime API to the same finalized hash as the credit read', async () => {
  const requests: unknown[] = [];
  const access = { client: { getUnsafeApi: () => ({ apis: { NftCreditsApi: { nft_claim_credit_proofs: async (...args: unknown[]) => { requests.push(args); return { success: true, value: [] }; } } } }) } } as unknown as PapiChainAccess;
  await creditReader(access).runtimeCall!('NftCreditsApi', 'nft_claim_credit_proofs', [7, 'Ada'], '0xff');
  expect(requests).toEqual([[7, 'Ada', { at: '0xff' }]]);
  await expect(creditReader(access).runtimeCall!('Missing', 'missing', [], '0xff')).rejects.toThrow('Missing credit runtime API');
});
it('seeds both Person reports without submitting a synthetic report for Ada', async () => {
  const reports: unknown[] = [], game = { index: 8, playsAt: 1, fromBlock: 3 };
  const actor = { address: 'Ada' } as GameParticipant, bots = [{ address: 'Bob' }, { address: 'Carol' }] as GameParticipant[];
  const chain = { current: game, schedule: async () => undefined, enroll: async () => undefined, startReporting: async () => undefined,
    games: { shuffledGroup: async () => ['Ada', 'Bob', 'Carol'], reportFrom: async (...args: unknown[]) => { reports.push(args); }, complete: async () => undefined },
    transactions: { finalizePending: async () => undefined }, until: async (_label: string, read: () => Promise<unknown>) => read(),
    findEvent: async (_from: number, matches: (event: unknown) => boolean) => { expect(matches({ type: 'Game', value: { type: 'GameEnded', value: { index: 8 } } })).toBe(true); return { block: 9 }; },
  } as unknown as ScenarioChain;
  await seedResults(chain, actor, bots);
  expect(reports).toEqual(bots.map(bot => [bot, ['Ada', 'Bob', 'Carol']]));
  expect(chain.current).toBeUndefined(); expect(chain.ended).toEqual(game);
  await expect(seedResults(chain, actor, [])).rejects.toThrow('exactly two reporting peers');
});
it('records precise missing capabilities for the two unimplemented game actions', () => {
  expect(playReason).toContain('matching private key');
  expect(prizeReason).toContain('not Game.claim_airdrop');
});
it('negative control accepts only a chest the app logged opening with collectables before its backstop', () => {
  const entered = 1_000_000, opened = (afterEntryMs: number, collected = 2): VesselOpening => ({ hook: true, opened: { at: entered + afterEntryMs, by: 'the wait', collected, shown: 2 } });
  // The app log decides, so a Continue after the long-wait notice still passes when the vessel opened in time.
  for (const reveal of ['opened', 'backstop-or-late'] as const) expect(() => assertChestOpened({ reveal }, opened(23_000), entered), reveal).not.toThrow();
  expect(() => assertChestOpened({ reveal: 'nothing-screen' }, opened(23_000), entered)).toThrow('did not open before its backstop (nothing-screen)');
  expect(() => assertChestOpened({ reveal: 'opened' }, { hook: true, opened: null }, entered)).toThrow('no opening in the app log');
  expect(() => assertChestOpened({ reveal: 'backstop-or-late' }, opened(60_000), entered)).toThrow('did not open before its backstop');
  expect(() => assertChestOpened({ reveal: 'opened' }, opened(5_000, 0), entered)).toThrow('did not open before its backstop');
  expect(() => assertChestOpened({ reveal: 'opened' }, opened(Number.NaN), entered)).toThrow('did not open before its backstop');
  // A line stamped before the lab entered belongs to an earlier chest, never this one.
  expect(() => assertChestOpened({ reveal: 'opened' }, opened(-1), entered)).toThrow('did not open before its backstop');
  expect(() => assertChestOpened({ reveal: 'opened' }, { hook: false, opened: null }, entered)).toThrow('no E2E log hook');
  expect(() => assertChestOpened({ reveal: 'opened' }, null, entered)).toThrow('page kept navigating');
});
function logPage(window: object) {
  return { evaluate: async (fn: (arg: undefined) => unknown) => runInNewContext(`(${fn.toString()})(undefined)`, { window, JSON, String, Number }) } as unknown as BrowserPage;
}
it('reads only declared facts of this session\'s chest opening from the app log hook', async () => {
  const line = (sessionId: string, tag: string, message: string, data: object) => ({ ts: 42, sessionId, version: 'x', level: 'info', tag, message, data });
  const hook = (entries: object[], meta: object = { sessionId: 'now' }) => ({ __jollityHarness: { exportLogs: async () => JSON.stringify({ meta, entries }) } });
  expect(await readVesselOpening(logPage({}))).toEqual({ hook: false, opened: null });
  expect(await readVesselOpening(logPage(hook([line('earlier', 'chest', 'the vessel opened', { by: 'a tap', collected: 2 }), line('now', 'chest', 'collecting', {})]))))
    .toEqual({ hook: true, opened: null });
  expect(await readVesselOpening(logPage(hook([line('now', 'chest', 'the vessel opened', { by: 'the wait', collected: 2, shown: 'secret' })]))))
    .toEqual({ hook: true, opened: { at: 42, by: 'the wait', collected: 2, shown: -1 } });
  // Only declared integers leave the page, and the latest opening in the session wins.
  expect(await readVesselOpening(logPage(hook([line('now', 'chest', 'the vessel opened', { by: 'a tap', collected: 1, shown: 2 }),
    { ...line('now', 'chest', 'the vessel opened', { by: 'all in', collected: 2, shown: 2 }), ts: 50 }]))))
    .toEqual({ hook: true, opened: { at: 50, by: 'all in', collected: 2, shown: 2 } });
  // An export without its own session id cannot be matched to this page.
  const sessionless = { ts: 42, version: 'x', level: 'info', tag: 'chest', message: 'the vessel opened', data: { by: 'all in', collected: 1 } };
  expect(await readVesselOpening(logPage(hook([sessionless], {})))).toEqual({ hook: true, opened: null });
  expect(await readVesselOpening(logPage(hook([line('now', 'chest', 'the vessel opened', { by: 'free text', collected: '2' })]))))
    .toEqual({ hook: true, opened: { at: 42, by: 'other', collected: -1, shown: -1 } });
});
it('waits for the opening only while it could still come before the backstop', async () => {
  const none: VesselOpening = { hook: true, opened: null }, seen: VesselOpening = { hook: true, opened: { at: 1, by: 'all in', collected: 1, shown: 1 } };
  let reads = 0;
  expect(await awaitVesselOpening(async () => (++reads < 2 ? none : seen), Date.now())).toEqual(seen);
  expect(reads).toBe(2);
  reads = 0;
  expect(await awaitVesselOpening(async () => { reads++; return none; }, Date.now() - 120_000)).toEqual(none);
  expect(reads).toBe(1);
  expect(await awaitVesselOpening(async () => ({ hook: false, opened: null }), Date.now())).toEqual({ hook: false, opened: null });
});
it('negative control requires the opened chest of this game with an enabled, untapped Continue', () => {
  const open: ChestView = { path: '/chest', game: '8', noIdentity: false, slow: false, restart: false, heading: true, gameLabel: true, scene: true, closing: false,
    buttons: [{ name: 'Continue', enabled: true }] };
  expect(() => assertChestContinue(open, 8)).not.toThrow();
  expect(() => assertChestContinue({ ...open, buttons: [{ name: 'Claim all', enabled: true }] }, 8)).not.toThrow();
  for (const change of [{ game: '9' }, { path: '/' }, { scene: false }, { closing: true }, { slow: true }, { restart: true }, { noIdentity: true },
    { buttons: [{ name: 'Continue', enabled: false }] }, { buttons: [{ name: 'Claim all', enabled: false }] }, { buttons: [{ name: 'Done', enabled: true }] }])
    expect(() => assertChestContinue({ ...open, ...change }, 8), JSON.stringify(change)).toThrow('enabled Continue');
  expect(() => assertChestContinue(null, 8)).toThrow('enabled Continue');
});
it('negative control rejects credits that changed across the chest', () => {
  const credit = { awardBlock: 4, game: 8, leaf: 0, credit: '0x01', delivered: true, claimed: false };
  const reading = (credits: object[]) => ({ credits }) as unknown as CreditReading;
  expect(() => assertCreditsKept(reading([credit, { ...credit, leaf: 1 }]), reading([{ ...credit, leaf: 1 }, credit]))).not.toThrow();
  expect(() => assertCreditsKept(reading([credit, { ...credit, leaf: 1 }]), reading([credit, { ...credit, leaf: 1, claimed: true }]))).toThrow('changed after the chest');
  expect(() => assertCreditsKept(reading([credit]), reading([{ ...credit, leaf: 2 }]))).toThrow('changed after the chest');
});
