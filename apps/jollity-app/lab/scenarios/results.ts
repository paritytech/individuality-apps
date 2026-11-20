// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PapiChainAccess } from '@parity/product-lab/chain-papi';
import { fail } from '@parity/product-lab';
import { flowStorage } from '../../../../lab/shared/storage.ts';
import { readCredits, mintable, type ChainReads, type CreditReading } from '../../../../lab/shared/upstream/three-apps/chain.ts';
import type { ScenarioChain } from '../../../../lab/shared/chain.ts';
import type { GameParticipant } from '../../../../lab/shared/upstream/lab/steps/games/participant.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { readWatchedText } from '../../../../lab/shared/watched-text.ts';
import { CHEST_BACKSTOP_MS, CHEST_EXITS, type ChestReveal, type ChestView } from '../../../../lab/shared/post-game.ts';
/** Storage and runtime API calls use the same independently acquired finalized hashes. */
export function creditReader(access: PapiChainAccess<unknown>): ChainReads {
  return { finalized: () => access.finalizedHead(), blockAt: number => access.blockAt(number),
    storage: (pallet, item, keys, at) => flowStorage(access, pallet, item, [...keys], at),
    async runtimeCall(api, method, args, at) {
      const apis = access.client.getUnsafeApi().apis, call = apis[api]?.[method];
      if (!call) throw Error('Missing credit runtime API');
      return Reflect.apply(call, apis[api], [...args, { at }]);
    },
  };
}
export async function seedResults(chain: ScenarioChain, actor: GameParticipant, bots: readonly GameParticipant[]) {
  if (bots.length !== 2) throw Error('The results fixture needs exactly two reporting peers');
  await chain.schedule(600); const game = chain.current!;
  const players = [actor, ...bots]; await chain.enroll(players); await chain.startReporting(game.index, players);
  const group = await chain.games.shuffledGroup(players);
  // Both bots vote Person for Ada. Ada needs no /game UI or synthetic report.
  await Promise.all(bots.map(bot => chain.games.reportFrom(bot, group)));
  await chain.transactions.finalizePending(); await chain.games.complete(true, game.index);
  const ended = await chain.until('finalized results game ended', () => chain.findEvent(game.fromBlock, event => {
    const e = event as { type: string; value: { type: string; value: { index: number } } };
    return e.type === 'Game' && e.value.type === 'GameEnded' && e.value.value.index === game.index;
  }));
  chain.ended = game; chain.current = undefined; return { game, ended };
}
export function assertCredits(reading: CreditReading, expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 0 || mintable(reading).length !== expected) fail('not-on-chain', `DIM2 credits to keep do not equal ${expected}`);
}
export async function resultsCredits(chain: ScenarioChain, hub: PapiChainAccess<unknown>, actor: GameParticipant, peers: readonly GameParticipant[]) {
  if (!chain.ended) throw Error('No completed results game');
  return readCredits({ people: creditReader(chain.people.access), assetHub: creditReader(hub), account: actor.address,
    game: chain.ended.index, peers: peers.map(peer => peer.address) });
}
/** The app's own record that the chest opened: the dev build's E2E log hook (lib/telemetry/harness.ts,
 *  `window.__jollityHarness.exportLogs()`) holds the chest screen's `the vessel opened` line (lib/chest/chest-screen.ts),
 *  which it logs only when the vessel opens with something collected. Only declared facts leave the page, never log lines. */
export interface VesselOpening { hook: boolean; opened: { at: number; by: string; collected: number; shown: number } | null }
export async function readVesselOpening(page: Pick<BrowserPage, 'evaluate'>): Promise<VesselOpening | null> {
  return readWatchedText(page, async () => {
    const hook = (window as unknown as { __jollityHarness?: { exportLogs(): Promise<string> } }).__jollityHarness;
    if (!hook) return { hook: false, opened: null };
    const log = JSON.parse(await hook.exportLogs()) as { meta?: { sessionId?: string };
      entries?: { ts?: number; sessionId?: string; tag?: string; message?: string; data?: { by?: unknown; collected?: unknown; shown?: unknown } }[] };
    const session = log.meta?.sessionId;
    if (typeof session !== 'string' || !session) return { hook: true, opened: null };
    // The latest opening in this page session: an earlier chest in the same session must not stand in for this one.
    const line = (log.entries ?? []).filter(entry => entry.sessionId === session && entry.tag === 'chest' && entry.message === 'the vessel opened').at(-1);
    if (!line) return { hook: true, opened: null };
    const by = String(line.data?.by), collected = line.data?.collected, shown = line.data?.shown;
    return { hook: true, opened: { at: Number(line.ts), by: ['all in', 'the wait', 'a tap'].includes(by) ? by : 'other',
      collected: typeof collected === 'number' && Number.isSafeInteger(collected) ? collected : -1,
      shown: typeof shown === 'number' && Number.isSafeInteger(shown) ? shown : -1 } };
  });
}
/** Read the app log until it shows the opening, or until an opening could no longer come before the backstop. */
export async function awaitVesselOpening(read: () => Promise<VesselOpening | null>, entered: number, options: { signal?: AbortSignal; graceMs?: number } = {}) {
  const until = entered + CHEST_BACKSTOP_MS + (options.graceMs ?? 5_000);
  for (;;) {
    options.signal?.throwIfAborted();
    const seen = await read();
    if (seen && (!seen.hook || seen.opened)) return seen;
    if (Date.now() >= until) return seen;
    await delay(1_000, undefined, { signal: options.signal });
  }
}
/** The chest opened with at least one collectable before its backstop. The DOM has no opened marker, and after the
 *  long-wait notice its Continue may come on a bubble that never opened, so the app's own log decides: a
 *  `the vessel opened` line within the backstop window of the lab's entry. A nothing screen proves no reveal. */
export function assertChestOpened(walk: { reveal: ChestReveal }, opening: VesselOpening | null, entered: number) {
  if (walk.reveal === 'nothing-screen') fail('screen-mismatch', 'DIM2 chest did not open before its backstop (nothing-screen)');
  if (!opening) fail('screen-mismatch', 'DIM2 chest opening is unreadable: the app log could not be read (the page kept navigating)');
  if (!opening.hook) fail('screen-mismatch', 'DIM2 chest opening is unreadable: the dev build has no E2E log hook');
  const opened = opening.opened;
  if (!opened || !Number.isFinite(opened.at) || opened.at < entered || opened.at - entered >= CHEST_BACKSTOP_MS || opened.collected < 1)
    fail('screen-mismatch', `DIM2 chest did not open before its backstop (${walk.reveal}, ${opened ? `app log opened ${opened.at - entered} ms after entry` : 'no opening in the app log'})`);
}
/** The opened chest still offers an enabled Continue, or the Pocket's Claim all. Either leads on, so the lab never takes it. */
export function assertChestContinue(view: ChestView | null, game: number) {
  if (!view || view.path !== '/chest' || view.game !== String(game) || !view.scene || view.closing || view.noIdentity || view.slow || view.restart ||
    !view.buttons.some(button => CHEST_EXITS.includes(button.name) && button.enabled)) fail('screen-mismatch', 'DIM2 chest does not show the opened chest with an enabled Continue or Claim all');
}
/** The chest only reads and animates claims; the same unspent claims must remain after it. */
export function assertCreditsKept(before: CreditReading, after: CreditReading) {
  const ids = (reading: CreditReading) => mintable(reading).map(c => `${c.awardBlock}:${c.game}:${c.leaf}:${c.credit}`).sort().join(',');
  if (ids(before) !== ids(after)) fail('not-on-chain', 'DIM2 credits to keep changed after the chest');
}
