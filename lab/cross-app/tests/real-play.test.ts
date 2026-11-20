// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { Sr25519KeyDerivation } from '@parity/product-lab/keys-sr25519';
import { playMediaGroup, requireMediaGroup } from '../real-play.ts';
const keys = new Sr25519KeyDerivation();
const players = ['Alice', 'Bob', 'Charlie'].map((name, n) => ({ name: ['Ada', 'Lab1', 'Lab2'][n]!, address: keys.derive('//' + name).address }));
const result = { taps: 2, confirmations: 1, sawGame: true, sawChest: true, votes: { roundTaps: 2, confirmTaps: 0 } };
it('drives all three independent media players with the shared early-close barrier', async () => {
  const calls: string[] = [];
  const results = await playMediaGroup(players, new AbortController().signal, async (player, seat) => {
    calls.push(player.name); await seat.armed(new AbortController().signal); return result;
  });
  expect(calls).toEqual(['Ada', 'Lab1', 'Lab2']); expect(results).toEqual([result, result, result]);
});
it.each([players.slice(0, 1), [players[0]!, players[0]!, players[2]!]].map(roster => [roster] as const))('@negative-control: transaction-only or duplicate media roster fails before play', roster => {
  expect(() => requireMediaGroup(roster)).toThrow('three distinct media players');
});
it('@negative-control: reaching the payoff, or tapping only an old No video recap, cannot pass real media play', async () => {
  await expect(playMediaGroup(players, new AbortController().signal, async () => ({ ...result, votes: { roundTaps: 0, confirmTaps: 2 } })))
    .rejects.toThrow('real round tile');
});
it('@negative-control: a failed player stops and settles its own peer loops', async () => {
  let stopped = 0;
  await expect(playMediaGroup(players, new AbortController().signal, async (player, _seat, signal) => {
    if (player.name === 'Ada') throw Error('player failed');
    return new Promise<typeof result>((_resolve, reject) => {
      signal.addEventListener('abort', () => { stopped++; reject(signal.reason); }, { once: true });
    });
  })).rejects.toThrow('player failed');
  expect(stopped).toBe(2);
});
