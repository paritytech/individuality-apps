// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { addressesEqual } from '@parity/product-sdk/address';
import { ConfirmTogether, type ConfirmSeat } from '../shared/upstream/lab/steps/dim2/confirm-together.ts';

export interface MediaPlayer { name: string; address: string }
export interface MediaPlayResult {
  taps: number; confirmations: number; sawGame: boolean; sawChest: boolean;
  votes: { roundTaps: number; confirmTaps: number };
}
/** Transaction-only peers have no video. The source app may correctly hide every unseen recap tile. */
export function requireMediaGroup(players: readonly MediaPlayer[]) {
  if (players.length !== 3 || new Set(players.map(p => p.name)).size !== 3 ||
    players.some((p, n) => players.slice(0, n).some(other => addressesEqual(p.address, other.address))))
    throw Error('Real cross-app play requires three distinct media players');
}
/** Run the same real UI driver for every player, sharing the existing early-close confirmation barrier. */
export async function playMediaGroup<T extends MediaPlayResult>(players: readonly MediaPlayer[], signal: AbortSignal,
  play: (player: MediaPlayer, seat: ConfirmSeat, signal: AbortSignal) => Promise<T>): Promise<T[]> {
  requireMediaGroup(players);
  const abort = new AbortController(), playing = AbortSignal.any([signal, abort.signal]), together = new ConfirmTogether();
  const seats = players.map(player => together.join(player.name));
  const runs = players.map((player, n) => Promise.resolve().then(() => play(player, seats[n]!, playing)).finally(() => seats[n]!.leave()));
  try {
    const results = await Promise.all(runs);
    if (results.some(result => !result.sawGame || !result.sawChest || !result.taps || !result.votes.roundTaps || !result.confirmations && !result.votes.confirmTaps))
      throw Error('Every media player must vote on a real round tile and finish the game');
    return results;
  } catch (error) {
    abort.abort(error); await Promise.allSettled(runs); throw error;
  }
}
