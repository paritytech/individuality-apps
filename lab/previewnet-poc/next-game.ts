// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// "the next game is open for sign-up". On live Previewnet games come by themselves and the lab only waits. A local
// copy carries the games that were scheduled when it was copied, a few hours' worth: once those are past nothing adds
// another (20 November 2026: a copy bitten six hours earlier had no game and no schedule). There the lab schedules one
// itself, as Root through the copy's own Sudo pallet: product-lab hands an action `rootCall` only on an environment
// the lab declares root calls for (`rootCalls` in the config: local copies), and never on a live network. The run
// must confirm them (`product-lab test --root-calls`).
//
// The sentence is an action, not a custom step, because only an action is handed `rootCall`. It does not declare
// `rootCalls: true`: that would keep the scenario off live Previewnet, where it has to run too.
import { setTimeout as delay } from 'node:timers/promises';
import { defineAction, fail } from '@parity/product-lab';
import type { PapiChainAccess } from '@parity/product-lab/chain-papi';
import { call } from '../shared/chain-plan.ts';
import { OWN_GAME_PLAYS_IN_S, SIGN_UP_NEEDS_S, ownGamePlayTime, type Phases } from './rules.ts';
import { world } from './people.ts';

type Game = { index: number; game_date: number; state: { type: string } };
type Schedule = { game_play_time: number };
/** Live games come every 20 minutes, and a window opens when the previous game clears. */
const NEXT_GAME_WAIT_MS = 25 * 60_000;

const read = async (access: PapiChainAccess, item: string, pallet: string, hash: string) =>
  access.historicalStorage(pallet, item, [], hash, { orDefault: true });

/** The sentence, with how far ahead the lab's own game plays on a copy: at least `SIGN_UP_NEEDS_S` plus the time the
 *  game takes to open, so that the lab does not turn its own game down. */
export const nextGameIn = (playsInS: number) => defineAction({
  actor: 'none',
  title: 'The next game is open for sign-up',
  description: 'Waits for a game in Registration with time to sign up; on a local copy with none coming, schedules one as Root.',
  via: 'chain',
  sentences: ['the next game is open for sign-up'],
  async run(context) {
    const state = world(), deadline = Date.now() + NEXT_GAME_WAIT_MS;
    let last: Record<string, unknown> = {}, scheduled: Record<string, unknown> | undefined;
    let said = '';
    for (;;) {
      context.signal.throwIfAborted();
      const head = await state.people.finalizedHead();
      const [game, schedules, now, phases] = await Promise.all([
        read(state.people, 'Game', 'Game', head.hash) as Promise<Game | undefined>,
        read(state.people, 'GameSchedules', 'Game', head.hash) as Promise<Schedule[] | undefined>,
        read(state.people, 'Now', 'Timestamp', head.hash) as Promise<bigint>,
        read(state.people, 'StoredPhaseDurations', 'Game', head.hash) as Promise<Phases>,
      ]);
      const chainNow = Number(now / 1000n), left = game ? game.game_date - chainNow : undefined;
      last = { head, game, schedules, chainTime: now, secondsToGame: left, ...(scheduled ? { scheduledByTheLab: scheduled } : {}) };
      const seen = `game ${game ? `${game.index} ${game.state.type}, plays in ${left} s` : 'none'}; ${(schedules ?? []).length} scheduled`;
      if (seen !== said) context.progress(`People #${head.number}: ${said = seen}`);
      if (game?.state.type === 'Registration' && left !== undefined && left >= SIGN_UP_NEEDS_S) {
        state.evidence.push({ nextGame: last });
        return last;
      }
      // A game with room to sign up is on its way when a schedule entry plays late enough; only without one does a
      // copy need the lab's own. Once is enough: the entry stays until its game opens.
      const coming = (schedules ?? []).some(entry => entry.game_play_time - chainNow >= SIGN_UP_NEEDS_S);
      if (context.rootCall && !scheduled && !coming) {
        const game_play_time = ownGamePlayTime(Math.max(chainNow, Date.now() / 1000), game?.game_date, phases, playsInS);
        context.progress(`No game is coming on this copy: scheduling one for ${new Date(game_play_time * 1000).toISOString()}`);
        const sent = await context.rootCall('people',
          // The entry's shape is runtime 3005000's, which added `tenure_claim_window`; without it the call does not encode.
          { decodedCall: call('Game', 'schedule_games', { games_schedules: [{ game_play_time, rounds: 1, max_group_size: 4, airdrops: [], tenure_claim_window: 0 }] }) },
          { reason: 'The local copy has no game coming, and the scenario signs up for the next one' });
        scheduled = { game_play_time, phases, block: sent.evidence.block, txHash: sent.evidence.txHash };
        continue;
      }
      if (Date.now() >= deadline) break;
      await delay(6_000, undefined, { signal: context.signal });
    }
    state.evidence.push({ nextGame: last });
    fail('not-on-chain', `No game opened for sign-up with ${SIGN_UP_NEEDS_S} s to spare within ${NEXT_GAME_WAIT_MS / 60_000} minutes: ${JSON.stringify(last, (_, value) => typeof value === 'bigint' ? value.toString() : value).slice(0, 600)}`);
  },
});

/** Live's 20 minutes, so that the sign-up window is as long as a live one. */
export const nextGame = nextGameIn(OWN_GAME_PLAYS_IN_S);
