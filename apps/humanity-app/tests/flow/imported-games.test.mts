// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Offline finalized-chain controls; no network, signer, browser or fork is started.
import { it, expect } from 'vitest';
import { customSteps } from '@parity/product-lab/steps';
import { clearImportedGames, IMPORTED_GAME_WAIT_MS, IMPORTED_GAME_FINALITY_STALL_MS, importedGameWaitMs } from '../../../../lab/shared/upstream/lab/steps/humanity/bootstrap/imported-games.ts';
import { planForkCleanup, planForkSetup } from '../../../../lab/shared/upstream/lab/steps/games/fork-setup-plan.ts';
import '../../lab/flows/steps.ts';
import { vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const address = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const endpoint = 'ws://127.0.0.1:27010';
const chainTime = 1793790252000, reportEnds = 1793793600;
const scheduledDates = [1793800800, 1793804400, 1793808000];
type Game = { index: number; game_date: number; report_ends: number; pending_attendance: number;
  state: { type: string; value?: { next_player_index?: number } } };
type Mode = 'advances' | 'early' | 'stuck-head' | 'stuck-time' | 'processing' | 'cancelling' | 'Registration' | 'Shuffle' | 'unknown' | 'replacement' | 'invalid' | 'abort' | 'long-window' | 'promotion' | 'mid-loop-promotion' | 'no-import' | 'late-stall' | 'boundary-stall' | 'recent-head';
function fixture(mode: Mode, withSchedules = false, override: Partial<Game> = {}) {
  let now = 0, cancelled = false, sleeps = 0, wrongAuthority = false, promoted: Game | undefined;
  const promotes = mode === 'promotion' || mode === 'mid-loop-promotion';
  let schedules = (withSchedules ? promotes ? scheduledDates : scheduledDates.slice(0, 1) : []).map(game_play_time => ({ game_play_time }));
  const events: Array<{ kind: string; game?: Game; outcome?: string }> = [], submissions: string[] = [], submissionStates: Array<string | undefined> = [], controller = new AbortController();
  const target = { offer: { local: true }, endpoints: { people: endpoint }, humanity: { network: { kind: 'owned', session: { schemaVersion: 1, mode: 'fork', ownership: 'owned', chains: { people: { ws: endpoint } } } } } };
  function promote() {
    if (promotes && !promoted && now >= 2000 && schedules.length) {
      const schedule = schedules[0]!;
      schedules = schedules.slice(1);
      promoted = { index: 308, game_date: schedule.game_play_time, report_ends: reportEnds, pending_attendance: 0,
        state: { type: 'Registration', value: { next_player_index: 0 } }, ...override };
    }
  }
  function game(): Game | undefined {
    if (promoted) return promoted;
    if (mode === 'no-import') return undefined;
    if (cancelled) return now < 2000 ? { index: 307, game_date: reportEnds - 3600, report_ends: reportEnds, pending_attendance: 7, state: { type: 'Cancelling' } } : undefined;
    if (mode === 'early' && now >= 1000 || mode === 'advances' && now >= 2000 || mode === 'cancelling' && now >= 1000 || mode === 'mid-loop-promotion' && now >= 1000) return undefined;
    const state = ['Registration','Shuffle'].includes(mode) ? mode : mode === 'unknown' ? 'Unknown' : mode === 'processing' ? 'PlayerProcess' : mode === 'cancelling' ? 'Cancelling' : ['advances','promotion'].includes(mode) && now >= 1000 ? 'PlayerProcess' : mode === 'replacement' && now >= 1000 ? 'Registration' : 'Reporting';
    return { index: mode === 'replacement' && now >= 1000 ? 308 : 307, game_date: reportEnds - 3600, pending_attendance: 7,
      report_ends: mode === 'long-window' ? reportEnds + 10000 : reportEnds, state: { type: state } };
  }
  const finalizedTime = () => mode === 'stuck-head' ? 0 : mode === 'late-stall' ? Math.min(now, 1000)
    : mode === 'boundary-stall' ? Math.min(now, 540000) : mode === 'recent-head' ? Math.min(now, 541000) : now;
  const chain = { signal: controller.signal, clock: { now: () => now, sleep: async (ms: number, signal: AbortSignal) => {
    signal.throwIfAborted(); expect(ms).toBeGreaterThan(0); expect(ms).toBeLessThanOrEqual(1000); now += ms; sleeps++; promote();
    if (mode === 'abort') controller.abort(new Error('offline cancellation')); signal.throwIfAborted();
  } }, access: { url: endpoint,
    finalizedHead: async () => ({ hash: `h${finalizedTime()}`, number: 2645525 + finalizedTime() / 1000 }),
    storage: async (pallet: string, item: string, _keys: unknown[], at: string) => {
      expect(at).toBe(`h${finalizedTime()}`);
      if (pallet === 'Timestamp' && item === 'Now') return mode === 'invalid' ? undefined : BigInt(chainTime + (['stuck-head','stuck-time','long-window'].includes(mode) ? 0 : finalizedTime()));
      if (pallet === 'Game' && item === 'Game') return game();
      if (pallet === 'Game' && item === 'GameSchedules') return schedules;
      throw new Error(`Unexpected read ${pallet}.${item}`);
    } }, api: { query: { Sudo: { Key: { getValue: async () => wrongAuthority ? undefined : address } } }, tx: {
      Sudo: { sudo: (value: unknown) => value }, Game: {
        remove_scheduled_game: (args: { game_play_time: number }) => ({ decodedCall: { type: 'remove', ...args } }),
        cancel_game: () => ({ decodedCall: 'cancel' }),
      },
    } } };
  const invoke = (waitMs?: number) => clearImportedGames({ waitMs, target: target as never, chain: chain as never, root: { address, signer: {} } as never, record: event => events.push(event as never),
    transactions: { submit: async (_label: string, transaction) => {
      const tx = transaction as unknown as { call: 'cancel' | { type: 'remove'; game_play_time: number } };
      submissionStates.push(game()?.state.type);
      if (tx.call === 'cancel') {
        submissions.push('cancel'); expect(['Registration','Shuffle']).toContain(game()?.state.type); cancelled = true;
      } else {
        submissions.push('remove');
        const date = tx.call.game_play_time;
        expect(schedules.some(s => s.game_play_time === date)).toBe(true);
        schedules = schedules.filter(s => s.game_play_time !== date);
        // A finalized call takes a block. The runtime may end the import and promote
        // the first remaining schedule while the removal loop is in progress.
        if (promotes) { now += 1000; promote(); }
      }
      return {} as never;
    } } });
  return { invoke, target, chain, events, submissions, submissionStates, get game() { return game(); }, get schedules() { return schedules; },
    get now() { return now; }, get sleeps() { return sleeps; }, refuseAuthority: () => { wrongAuthority = true; } };
}
it('imported Reporting advances within the bound through PlayerProcess and passes without cancellation', async () => {
  const f = fixture('advances', true); const result = await f.invoke();
  expect(result).toMatchObject({ removed: 1, cancelled: null }); expect(f.submissions).toEqual(['remove']); expect(f.submissionStates).toEqual([undefined]); expect(f.now).toBe(2000);
  expect(f.events.filter(e => e.kind === 'imported-games-state').map(e => e.game?.state.type)).toEqual(['Reporting','PlayerProcess',undefined]);
  expect(f.events.find(e => e.kind === 'imported-games-completion-wait')).toMatchObject({ outcome: 'completed', limitMs: 3_528_000 });
});
it('returns immediately when attendance settles early; no fixed reporting-window delay', async () => {
  const f = fixture('early'); await f.invoke(); expect(f.now).toBe(1000); expect(f.submissions).toEqual([]);
});
it.each(['stuck-head','stuck-time','processing','long-window'] as const)('@negative-control: %s times out with a specific reason and no cancellation', async mode => {
  const f = fixture(mode);
  const reason = mode === 'stuck-head' ? 'finalized People head did not advance' : mode === 'processing' ? 'runtime block processing has not removed' : 'finalized chain time has not reached report_ends';
  await expect(f.invoke()).rejects.toThrow(reason); expect(f.submissions).toEqual([]);
  expect(f.now).toBe(mode === 'processing' ? 180000 : mode === 'long-window' ? IMPORTED_GAME_WAIT_MS : 3_528_000);
  expect(f.events.at(-1)).toMatchObject({ kind: 'imported-games-completion-wait', outcome: 'timeout' });
});
it('an already Cancelling import drains without another cancellation call', async () => {
  const f = fixture('cancelling'); await f.invoke(); expect(f.submissions).toEqual([]); expect(f.now).toBe(1000);
});
it.each(['Registration','Shuffle'] as const)('keeps %s cancellation and the original bounded own-cancellation drain', async mode => {
  const f = fixture(mode); await f.invoke(); expect(f.submissions).toEqual(['cancel']); expect(f.now).toBe(2000);
  expect(f.events.at(-2)).toMatchObject({ kind: 'imported-games-cancellation-wait', outcome: 'completed' });
});
it('@negative-control: refuses a replacement game rather than cancelling newly created state', async () => {
  const f = fixture('replacement'); await expect(f.invoke()).rejects.toThrow('refused replacement game #308'); expect(f.submissions).toEqual([]);
});
it('@negative-control: unknown states retain the immediate guard and original error wording', async () => {
  const f = fixture('unknown'); await expect(f.invoke()).rejects.toThrow('Imported DIM2 game #307 is in Unknown at finalized #2645525; cancel_game only permits Registration or Shuffle. Stop for a decision; no storage edits are allowed'); expect(f.sleeps).toBe(0); expect(f.submissions).toEqual([]);
});
it('@negative-control: rejects malformed chain time rather than guessing a bound', async () => {
  const f = fixture('invalid'); await expect(f.invoke()).rejects.toThrow('cannot bound the completion wait'); expect(f.sleeps).toBe(0); expect(f.submissions).toEqual([]);
});
it('@negative-control: propagates cancellation and records an aborted wait', async () => {
  const f = fixture('abort'); await expect(f.invoke()).rejects.toThrow('offline cancellation'); expect(f.events.at(-1)!.outcome).toBe('aborted'); expect(f.submissions).toEqual([]);
});
it('@negative-control: ownership, endpoint and Sudo checks still refuse before any submission', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.target.humanity.network.kind = 'attached'; },
    (f: ReturnType<typeof fixture>) => { f.chain.access.url = 'ws://127.0.0.1:27011'; },
    (f: ReturnType<typeof fixture>) => { f.target.endpoints.people = 'wss://public.invalid'; },
    (f: ReturnType<typeof fixture>) => f.refuseAuthority()]) {
    const f = fixture('Registration', true); change(f); await expect(f.invoke()).rejects.toThrow(/refuse|requires/); expect(f.submissions).toEqual([]);
  }
});
it('the actual step permits completion plus cleanup; other step budgets remain fifteen minutes', () => {
  const steps = customSteps();
  expect(steps.find(s => s.pattern.text === 'the three fresh fork players have zero PAS and no prior credits')?.timeoutMs).toBe(75 * 60000);
  expect(steps.find(s => s.pattern.text === 'the lab atomically prepares one local DIM2 game')?.timeoutMs).toBe(15 * 60000);
});

function assertStep3Accepts(f: ReturnType<typeof fixture>) {
  const state = { game: f.game, schedules: f.schedules, enabled: false, ownerBalance: 0n, sourceBalance: 0n };
  const cleanupPlan = planForkCleanup(state), cleanup = cleanupPlan.calls;
  expect(() => planForkSetup(state, address, address, Math.ceil(chainTime / 1000))).toThrow("cancellation to finish");
  const plan = planForkSetup({ ...state, game: undefined, schedules: [] }, address, address, Math.ceil(chainTime / 1000));
  expect(cleanup.map(call => `${call.type}.${call.value.type}`)).toEqual([
    ...f.schedules.map(() => 'Game.remove_scheduled_game'), 'Game.cancel_game',
  ]);
  expect(cleanup.slice(0, -1).map(call => call.value.value.game_play_time)).toEqual(f.schedules.map(s => s.game_play_time));
  expect(cleanupPlan.call.value.value.call.value.type).toBe('batch_all');
  expect(plan.call.value.value.call.value.type).toBe('batch_all');
}
it('waits before removing schedules and hands an advancing runtime promotion to the existing step 3 plan', async () => {
  const f = fixture('promotion', true), result = await f.invoke();
  expect(result).toMatchObject({ removed: 0, cancelled: null, promoted: 308 });
  expect(f.submissions).toEqual([]); expect(f.now).toBe(2000);
  expect(f.events.filter(e => e.kind === 'imported-games-state').map(e => e.game?.state.type)).toEqual(['Reporting','PlayerProcess','Registration']);
  expect(f.events.at(-1)).toMatchObject({ kind: 'imported-games-handoff', promoted: 308 });
  expect(f.game).toMatchObject({ game_date: scheduledDates[0], pending_attendance: 0, state: { type: 'Registration', value: { next_player_index: 0 } } });
  expect(f.schedules.map(s => s.game_play_time)).toEqual(scheduledDates.slice(1));
  assertStep3Accepts(f);
});
it('mid-loop promotion stops removals and hands off after an absent observation; no call runs before completion', async () => {
  const f = fixture('mid-loop-promotion', true), result = await f.invoke();
  expect(result).toMatchObject({ removed: 1, cancelled: null, promoted: 308 });
  expect(f.submissions).toEqual(['remove']); expect(f.submissionStates).toEqual([undefined]);
  expect(f.now).toBe(2000); expect(f.game?.game_date).toBe(scheduledDates[1]);
  expect(f.schedules.map(s => s.game_play_time)).toEqual(scheduledDates.slice(2));
  expect(f.events.at(-1)).toMatchObject({ kind: 'imported-games-handoff', removed: 1, promoted: 308 });
  assertStep3Accepts(f);
});
const refusedPromotions: Array<[string, Partial<Game>, string]> = [
  ['players', { state: { type: 'Registration', value: { next_player_index: 1 } } }, 'Registration next_player_index must be 0 (no players)'],
  ['pending attendance', { pending_attendance: 1 }, 'pending_attendance must be 0 (no players)'],
  ['missing registration count', { state: { type: 'Registration' } }, 'Registration next_player_index must be 0 (no players)'],
  ['wrong index', { index: 309 }, 'expected next index #308'],
  ['unsnapshotted date', { game_date: 1793899999 }, 'game_date 1793899999 is not a snapshotted schedule'],
  ['non-Registration state', { state: { type: 'Shuffle' } }, 'state Shuffle is not Registration'],
  ['later waitable state', { state: { type: 'Reporting' } }, 'state Reporting is not Registration'],
];
it.each(refusedPromotions)('@negative-control: promoted %s is refused with its own reason', async (_name, override, reason) => {
  const f = fixture('promotion', true, override);
  await expect(f.invoke()).rejects.toThrow(`Imported DIM2 cleanup refused replacement game #${override.index ?? 308}: ${reason}`);
  expect(f.submissions).toEqual([]); expect(f.events.some(e => e.kind === 'imported-games-handoff')).toBe(false);
  expect(f.events.at(-1)).toMatchObject({ kind: 'imported-games-completion-wait', outcome: 'refused' });
});
it('no imported or promoted game removes the original schedules as before', async () => {
  const f = fixture('no-import', true), result = await f.invoke();
  expect(result).toMatchObject({ removed: 1, cancelled: null }); expect(result).not.toHaveProperty('promoted');
  expect(f.submissions).toEqual(['remove']); expect(f.schedules).toEqual([]);
});


it('CI Reporting stops after the configured ten minutes with the exact non-passing reason', async () => {
  const workflow = parse(readFileSync(new URL('../../../../.github/workflows/humanity-dim2-flow.yml', import.meta.url), 'utf8'));
  const bound = importedGameWaitMs(workflow.jobs.flow.env.HUMANITY_FLOW_IMPORTED_GAME_WAIT_MS);
  expect(bound).toBe(600000);
  const f = fixture('long-window', true);
  await expect(f.invoke(bound)).rejects.toThrow(/^not run: imported game in Reporting$/);
  expect(f.now).toBe(600000);
  expect(f.submissions).toEqual([]);
  expect(f.events.at(-1)).toMatchObject({ outcome: 'timeout', limitMs: 600000, state: 'Reporting' });
});
it('@negative-control invalid bounds refuse and unset preserves the sixty-five-minute local default', async () => {
  expect(importedGameWaitMs(undefined)).toBeUndefined();
  expect(IMPORTED_GAME_WAIT_MS).toBe(65 * 60000);
  for (const value of ['', '0', '-1', '1.5', '600000x', '3900001', 'Infinity']) expect(() => importedGameWaitMs(value)).toThrow('Invalid');
  const f = fixture('long-window');
  await expect(f.invoke()).rejects.toThrow('completion timed out');
  expect(f.now).toBe(65 * 60000);
});
it('the actual zero-PAS step reads the env bound and passes it to imported cleanup', async () => {
  // Reuse the real step with its session lookup replaced, without a browser or RPC.
  const { flowState } = await import('../../lab/flows/session.ts');
  const f = fixture('long-window');
  vi.stubEnv('HUMANITY_FLOW_IMPORTED_GAME_WAIT_MS', '600000');
  const previous = flowState.active;
  flowState.active = { actors: [], people: { ...f.chain, access: { ...f.chain.access, historicalStorage: f.chain.access.storage } }, target: f.target, root: { address, signer: {} }, transactions: {}, log: () => {} } as never;
  const step = customSteps().find(s => s.pattern.text === 'the three fresh fork players have zero PAS and no prior credits')!;
  try {
    await expect(step.run({ lab: { attach: async () => {} } } as never)).rejects.toThrow(/^not run: imported game in Reporting$/);
    expect(f.now).toBe(600000);
  } finally { flowState.active = previous; vi.unstubAllEnvs(); }
});


it('CI frozen finality reports the chain stall instead of the Reporting not-run reason', async () => {
  const f = fixture('stuck-head', true);
  let failure: unknown;
  try { await f.invoke(600000); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('finalized People head did not advance');
  expect((failure as Error).message).not.toContain('not run: imported game in Reporting');
  expect(f.now).toBe(600000);
  expect(f.submissions).toEqual([]);
  expect(f.events.at(-1)).toMatchObject({ outcome: 'timeout', limitMs: 600000, state: 'Reporting' });
});


it.each(['late-stall', 'boundary-stall', 'recent-head'] as const)('CI judges %s over the last minute of finalized progress', async mode => {
  expect(IMPORTED_GAME_FINALITY_STALL_MS).toBe(60000);
  const f = fixture(mode, true);
  let failure: unknown;
  try { await f.invoke(600000); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (mode === 'recent-head') expect((failure as Error).message).toBe('not run: imported game in Reporting');
  else {
    expect((failure as Error).message).toContain('finalized People head did not advance for');
    expect((failure as Error).message).not.toContain('not run: imported game in Reporting');
  }
  expect(f.now).toBe(600000);
  expect(f.submissions).toEqual([]);
  expect(f.events.at(-1)).toMatchObject({ outcome: 'timeout', limitMs: 600000, state: 'Reporting' });
});
