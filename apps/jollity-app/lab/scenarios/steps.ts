// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { pendingWrapper, markPending, resetPending, permissionRefusalReason, playReason, prizeReason } from './pending.ts';
import { Before, After, setDefinitionFunctionWrapper } from '@cucumber/cucumber';
import { step } from '@parity/product-lab/steps';
import { scenario } from './session.ts';
import { homeSetup, wrappingReason, blockFreeSeat, fundGame } from './setup.ts';
import { observeHome, assertHome, assertHomeChain, awaitRegisteredHome } from './home.ts';
import { registerWhenReady, sentRegistrationClick } from '../../../../lab/shared/registration.ts';
import { fundNameLink } from '../../../../lab/shared/name-funding.ts';
import { seatRoute, assertRegistrationTable, readRegistrationRoute, readFreeRouteReserve } from './registration.ts';
import { seedResults, resultsCredits, assertCredits, assertChestOpened, assertChestContinue, assertCreditsKept, readVesselOpening, awaitVesselOpening, type VesselOpening } from './results.ts';
import { viewGameResults, readChest } from '../../../../lab/shared/post-game.ts';
import type { CreditReading } from '../../../../lab/shared/upstream/three-apps/chain.ts';
import { fail } from '@parity/product-lab';
import { jsonEvidence } from '../../../../lab/shared/observations.ts';

if (process.env.PRODUCT_LAB_RUNTIME_MODULE) {
  setDefinitionFunctionWrapper(pendingWrapper);
  Before({ timeout: 600_000 }, async function ({ pickle }) { resetPending(); missedFixture = false; seats.clear(); registrations.clear(); registeredHomes.clear(); kept.clear(); chests.clear(); scenario().network.beginTag(pickle.tags.map(tag => tag.name)); await scenario().reset(); });
  After({ timeout: 600_000 }, async function () {
    const state = scenario();
    // Finish the lab-owned missed-game fixture before the next outline row. Imported games are never reported for.
    if (missedFixture && state.chain.current) {
      const current = await state.chain.read('Game', 'Game');
      const game = current.value as { index: number; state: { type: string } } | undefined;
      if (game?.index !== state.chain.current.index || game.state.type !== 'Reporting') throw Error('Missed-game cleanup lost its owned Reporting game');
      const group = await state.chain.games.shuffledGroup(state.bots);
      await Promise.all(state.bots.slice(0, 2).map(bot => state.chain.games.reportFrom(bot, group)));
      await state.chain.transactions.finalizePending(); await state.chain.games.complete(true, game.index);
      state.chain.current = undefined;
    }
    await this.attach(JSON.stringify(await state.network.snapshot()), 'application/json');
  });
}
const timeout = { timeoutMs: 600_000 };
let missedFixture = false;
step('the lab sets the DIM2 game state to {string}', async ({ lab }, setup) => {
  const state = scenario(), actor = state.player('Ada'), expected = homeSetup(String(setup));
  if (expected === 'wrapping-up') { markPending('the lab sets the DIM2 game state to {string}'); await lab.attach({ pending: wrappingReason }); return; }
  if (expected !== 'no-game') {
    if (expected === 'unfunded') await blockFreeSeat(state.chain, actor.game.address);
    else await fundGame(state.chain, actor.game.address);
    await state.chain.schedule(600);
    if (expected === 'registered') await state.chain.enroll([actor.game], [actor.game, ...state.bots.slice(0, 2)]);
    if (expected === 'missed') { await state.chain.enroll(state.bots); await state.chain.startReporting(state.chain.current!.index, state.bots); missedFixture = true; }
  }
  await lab.attach(jsonEvidence({ setup, expected, evidence: state.evidence }));
}, timeout);
step('{actor} sees DIM2 home in state {string}', async ({ lab }, name, expected) => {
  const state = scenario(), actor = state.player(String(name));
  const proof = await state.chain.until('finalized DIM2 home state', async () => {
    const g = await state.chain.read('Game', 'Game'), at = g.at.hash;
    const { flowStorage } = await import('../../../../lab/shared/storage.ts');
    const [player, schedules, balance, deposit] = await Promise.all([
      flowStorage(state.people.access, 'Game', 'Players', [{ type: 'Account', value: actor.game.address }], at),
      flowStorage(state.people.access, 'Game', 'GameSchedules', [], at), flowStorage(state.people.access, 'System', 'Account', [actor.game.address], at),
      flowStorage(state.people.access, 'Game', 'PlayDepositAmount', [], at),
    ]);
    assertHomeChain(String(expected), g.value, player, schedules, balance, deposit);
    const seen = await observeHome(actor.view.page);
    try { assertHome(seen, actor.game.address, String(expected)); } catch { return undefined; }
    return { at: g.at, game: g.value, player, schedules, balance, deposit, seen };
  }, 120_000);
  await lab.attach(jsonEvidence(proof));
}, timeout);

const seats = new Map<string, 'free' | 'deposit'>();
const registrations = new Map<string, { from: number; clicks: number }>();
// The registered home is read as soon as the registration is final: the window closes about 270 s after scheduling,
// after which the home becomes the waiting room and hands over to /game, so a later read would race it.
const registeredHomes = new Map<string, unknown>();
step('the lab gives {actor} the {string} seat', async ({ lab }, name, value) => {
  const state = scenario(), player = state.player(String(name)), route = seatRoute(String(value));
  seats.set(player.actor.id, route);
  if (route === 'deposit') await lab.attach(jsonEvidence(await blockFreeSeat(state.chain, player.game.address)));
  // The free seat gets fee headroom only: it cannot pay the deposit, so a deposit fallback cannot register.
  await lab.attach(jsonEvidence(await fundGame(state.chain, player.game.address, route === 'free' ? 'fees' : 'deposit')));
  await lab.attach(jsonEvidence(await fundNameLink({ ...state, actor: () => ({ game: player.game }) }, { actor: player.actor.name, journal: 'Jollity scenarios Asset Hub funding' })));
}, timeout);
step('the lab schedules a game opening in {int} seconds with short phases', async ({ lab }, seconds) => {
  if (Number(seconds) !== 300) throw Error('Jollity registration plan requires 300 seconds');
  await lab.attach(jsonEvidence(await scenario().chain.schedule(Number(seconds))));
}, timeout);
step('{actor} registers for the game in DIM2', async ({ lab }, name) => {
  const state = scenario(), player = state.player(String(name)), key = [{ type: 'Account', value: player.game.address }];
  const before = await state.chain.read('Game', 'Players', key);
  if ((before.value as { registered?: boolean } | undefined)?.registered) throw Error('UI registration requires an unregistered actor');
  const click = { from: before.at.number, clicks: 0 }; registrations.set(player.actor.id, click);
  await registerWhenReady(player.view.page, { actor: player.actor.name, signal: state.people.signal,
    // Count clicks the page may have received; the guard also runs before an attempt the helper then withholds.
    check: () => state.chain.transactions.assertHealthy(), beforeClick: async () => {}, input: sent => { if (sentRegistrationClick(sent)) click.clicks++; },
    attach: view => lab.attach({ registration: view }),
    registered: async () => { const row = await state.chain.read('Game', 'Players', key); return (row.value as { registered?: boolean } | undefined)?.registered ? row : undefined; },
  });
  if (click.clicks !== 1) throw Error('DIM2 registration needs exactly one UI click');
  const seen = await awaitRegisteredHome(() => observeHome(player.view.page), player.game.address, { signal: state.people.signal });
  registeredHomes.set(player.game.address, seen);
}, timeout);
step("{actor}'s DIM2 registration on chain is:", async ({ lab }, name, table) => {
  if (!Array.isArray(table)) throw Error('Missing DIM2 registration table');
  assertRegistrationTable(table);
  const state = scenario(), player = state.player(String(name)), click = registrations.get(player.actor.id), route = seats.get(player.actor.id);
  if (!click || click.clicks !== 1 || !route) throw Error('No recorded UI registration or selected seat route');
  const row = await state.chain.read('Game', 'Players', [{ type: 'Account', value: player.game.address }]);
  if ((row.value as { registered?: boolean } | undefined)?.registered !== true) fail('not-on-chain', 'DIM2 registration is not finalized');
  const call = await readRegistrationRoute(state.chain, player.game.address, route, click.from);
  const reserve = route === 'free' ? await readFreeRouteReserve(state.chain, player.game.address, call.block) : undefined;
  await lab.attach(jsonEvidence({ row, route, call, reserve }));
}, timeout);
step('{actor} sees the registered DIM2 home', async ({ lab }, name) => {
  const state = scenario(), player = state.player(String(name));
  // Registered through the UI in this scenario: assert the home observed right after the registration was final.
  // Otherwise (no UI registration recorded) read the home now.
  const seen = registeredHomes.get(player.game.address)
    ?? await awaitRegisteredHome(() => observeHome(player.view.page), player.game.address, { signal: state.people.signal });
  await lab.attach(jsonEvidence({ registeredHome: seen }));
}, timeout);

step('{actor} opens dim2 at / and refuses access once', async ({ lab }) => {
  markPending('{actor} opens dim2 at / and refuses access once');
  await lab.attach({ pending: permissionRefusalReason });
}, timeout);
step('{actor} sees {string}', async (_context, name, value) => {
  await scenario().player(String(name)).view.page.getByText(String(value), { exact: true }).waitFor({ state: 'visible', timeout: 120_000 });
}, timeout);
step('{actor} allows access', async (_context, name) => {
  // If the refusal capability is added later, recovery follows the app's own control.
  await scenario().player(String(name)).view.page.getByRole('button', { name: 'Try again', exact: true }).click();
}, timeout);

step('Alice, Bob and Carol are new actors registered for the game by transaction', async ({ lab }) => {
  markPending('Alice, Bob and Carol are new actors registered for the game by transaction'); await lab.attach({ pending: playReason });
}, timeout);
step('the lab closes registration one minute after all three players registered', async () => { fail('unsupported-here', playReason); }, timeout);
step('Alice, Bob and Carol play and vote in the DIM2 app together', async () => { fail('unsupported-here', playReason); }, timeout);
step("Alice's finalized DIM2 votes are:", async () => { fail('unsupported-here', playReason); }, timeout);
step("Alice's DIM2 app report is finalized", async () => { fail('unsupported-here', playReason); }, timeout);
step('{actor} played a game in which both other players reported her', async ({ lab }, name) => {
  const state = scenario(), player = state.player(String(name));
  await lab.attach(jsonEvidence(await seedResults(state.chain, player.game, state.bots.slice(0, 2))));
}, timeout);
const kept = new Map<string, CreditReading>();
const chests = new Map<string, { walk: Awaited<ReturnType<typeof viewGameResults>>; opening: VesselOpening | null; entered: number }>();
async function creditsToKeep(name: string) {
  const state = scenario(), player = state.player(name);
  // Below the step timeout, so a slow XCM delivery fails here with its own message.
  return state.chain.until('finalized delivered credits from both reporting peers', async () => {
    const found = await resultsCredits(state.chain, state.hub, player.game, state.bots.slice(0, 2));
    return found.credits.length && found.credits.every(c => c.delivered) ? found : undefined;
  }, 540_000);
}
step('{actor} has {int} DIM2 credits to keep on chain', async ({ lab }, name, expected) => {
  const player = scenario().player(String(name)), reading = await creditsToKeep(String(name));
  await lab.attach(jsonEvidence(reading)); assertCredits(reading, Number(expected)); kept.set(player.actor.id, reading);
}, timeout);
step('{actor} still has {int} DIM2 credits to keep on chain', async ({ lab }, name, expected) => {
  const player = scenario().player(String(name)), before = kept.get(player.actor.id);
  if (!before) throw Error('No credit reading from before the chest');
  const reading = await creditsToKeep(String(name));
  await lab.attach(jsonEvidence(reading)); assertCredits(reading, Number(expected)); assertCreditsKept(before, reading);
}, timeout);
step('{actor} views the DIM2 game results', async ({ lab }, name) => {
  const state = scenario(), player = state.player(String(name)); if (!state.chain.ended) throw Error('No completed DIM2 game');
  // Marked before the walk enters, so an opening inside this window came before the page armed its backstop.
  const entered = Date.now();
  const walk = await viewGameResults(player.view.page, state.chain.ended.index, async path => { await player.session.open!(path); },
    { signal: state.people.signal, attach: seen => lab.attach({ chest: seen }) });
  await lab.attach(jsonEvidence(walk));
  const opening = walk.reveal === 'nothing-screen' ? null
    : await awaitVesselOpening(() => readVesselOpening(player.view.page), entered, { signal: state.people.signal });
  await lab.attach(jsonEvidence({ reveal: walk.reveal, opening: opening && { hook: opening.hook,
    opened: opening.opened && { afterEntryMs: opening.opened.at - entered, by: opening.opened.by, collected: opening.opened.collected, shown: opening.opened.shown } } }));
  assertChestOpened(walk, opening, entered); chests.set(player.actor.id, { walk, opening, entered });
}, timeout);
step("{actor}'s chest opened before its backstop and offers Continue", async ({ lab }, name) => {
  const state = scenario(), player = state.player(String(name)), chest = chests.get(player.actor.id);
  if (!chest || !state.chain.ended) throw Error('No opened DIM2 chest from the results step');
  const { walk } = chest; assertChestOpened(walk, chest.opening, chest.entered);
  // Continue hands over to Humanity's card and leaves Jollity, so it is checked enabled and never tapped.
  const current = await readChest(player.view.page);
  await lab.attach(jsonEvidence({ reveal: walk.reveal, current })); assertChestContinue(current, state.chain.ended.index);
}, timeout);
step('{actor} attended the last game and has reached personhood', async ({ lab }) => {
  markPending('{actor} attended the last game and has reached personhood'); await lab.attach({ pending: prizeReason });
}, timeout);
step('the game paid one airdrop that {actor} won', async () => { fail('unsupported-here', prizeReason); }, timeout);
step('{actor} opens the DIM2 prize draw', async (_context, name) => { await scenario().player(String(name)).session.open!('/prize-draw'); }, timeout);
step('{actor} claims her prize', async () => { fail('unsupported-here', prizeReason); }, timeout);
step("the claim is finalized and {actor}'s prize balance grows", async () => { fail('unsupported-here', prizeReason); }, timeout);
