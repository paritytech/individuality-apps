// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { setTimeout as delay } from 'node:timers/promises';
import { fail } from '@parity/product-lab';
import { step as registerStep, type StepFunction } from '@parity/product-lab/steps';
import { flow } from './session.ts';
import { zeroPasAccount, flowStorage, creditBlocks, requiredGame, registrationGame } from '../../../../lab/shared/storage.ts';
import { names, requireThree } from './contract.ts';
import { cardReady, firstAppFailure, bindRetryWatch, holdBindRetries } from './guards.mjs';
import { readFlowView as view } from '../../../../lab/shared/watched-text.ts';
import { earliestPlay } from '../../../../lab/shared/upstream/lab/steps/games/game-retime.ts';
import { clearImportedGames, importedGameWaitMs } from '../../../../lab/shared/upstream/lab/steps/humanity/bootstrap/imported-games.ts';
import { visiblePhases } from '../../../../lab/shared/upstream/lab/steps/games/fork-setup-plan.ts';
import { readCredits, mintable } from '../../../../lab/shared/upstream/three-apps/chain.ts';
import { ConfirmTogether } from '../../../../lab/shared/upstream/lab/steps/dim2/confirm-together.ts';
import { playDim2InApp, readDim2Report, readReportDeadline, isShutOut } from '../../../../lab/shared/upstream/lab/steps/dim2/live-game.ts';
import { assertDim2Votes, readDim2Votes } from '../../../../lab/shared/upstream/lab/steps/dim2/finalized-votes.ts';
import { viewGameResults } from './post-game.ts';
import { capturePostGameEntry } from './post-game-capture.ts';
import { registerWhenReady } from '../../../../lab/shared/registration.ts';
import { captureNavigationEvents } from './navigation-capture.ts';

// Preserve real custom-step timing for the app-owned demo record; keep all business assertions intact.
function step(pattern: string, run: StepFunction, options?: Parameters<typeof registerStep>[2]) {
  return registerStep(pattern, async (...args: Parameters<StepFunction>) => {
    const capture = flow().capture;
    if (!capture) return run(...args);
    const startedAt = Date.now();
    try { return await run(...args); }
    finally { capture.step(pattern, startedAt, Date.now()); }
  }, options);
}

function rows<T>(table: unknown): T[] {
  if (!Array.isArray(table) || !table.length) throw new Error('Missing step table');
  const [headers, ...data] = table as string[][];
  return data.map(row => Object.fromEntries(headers.map((key, i) => [key, row[i]])) as T);
}
const timeout = { timeoutMs: 15 * 60_000 };
async function until<T>(read: () => Promise<T | undefined>, ms = 180_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { flow().context.signal.throwIfAborted(); check(); const value = await read(); if (value !== undefined) return value; await delay(500, undefined, { signal: flow().context.signal }); }
  throw new Error('The bounded flow wait expired');
}
function actor(name: unknown) { const value = flow().actors.find(a => a.name === name); if (!value) throw new Error('Unknown flow player'); return value; }
function page(name: unknown) { const result = flow().pages.get(actor(name).id); if (!result) throw new Error('No active player page'); return result; }
function game() { const value = flow().game; if (!value) throw new Error('No prepared game'); return value; }
async function read(pallet: string, item: string, keys: unknown[] = []) {
  const access = flow().people.access, at = await access.finalizedHead();
  return { at, value: await flowStorage(access, pallet, item, keys, at.hash) };
}
let failure: unknown, timer: ReturnType<typeof setInterval> | undefined, monitoring: Promise<void> | undefined;
let bind: ReturnType<typeof bindRetryWatch> | undefined;
function check() { if (failure) throw failure; bind?.overdue(); }
async function inspect(name: string) {
  const found = await view(page(name));
  if (found === null) return null;
  const text = found.text;
  bind?.observe(text, { actor: name, account: actor(name).account, via: 'flow monitor' });
  const bad = firstAppFailure(text, { actor: name, via: 'flow monitor' });
  if (bad) throw new Error(`${name}: ${bad}`);
  return text;
}
function watch() {
  const f = flow(); failure = undefined;
  bind = bindRetryWatch({ aliasContext: '0x99f1920ec7217a74f0a682b5713af915aea099843bab68e74cd6463e5ec6e842',
    record: f.log, signal: f.context.signal, accountFor: name => f.actors.find(a => a.name === name)?.account,
    async readAlias(account) { const found = await read('PeopleLite','AccountToAlias',[account]); return { value: found.value, block: found.at, readAt: Date.now() }; } });
  holdBindRetries(bind.hold);
  timer = setInterval(() => {
    if (!monitoring) monitoring = (async () => { for (const a of f.actors) if (f.pages.has(a.id)) await inspect(a.name); bind?.overdue(); })()
      .catch(error => { failure = error; }).finally(() => { monitoring = undefined; });
  }, 1000);
  f.cleanups.push(async () => { if (timer) clearInterval(timer); await monitoring; await bind?.idle(); check(); holdBindRetries(null); });
}
async function balances() {
  const f = flow(), at = await f.people.access.finalizedHead(), hub = await f.hub.finalizedHead(), result = [];
  for (const a of f.actors) {
    const identities = f.identities.get(a.id)!;
    for (const address of new Set(Object.values(identities))) for (const [chain, access, head] of [['people', f.people.access, at],['asset-hub', f.hub, hub]] as const) {
      const balance = await zeroPasAccount(access, address, head.hash, `${a.name} on ${chain}`);
      result.push({ actor: a.name, chain, address, at: head, ...balance });
    }
  }
  return result;
}
step('the three fresh fork players have zero PAS and no prior credits', async ({ lab }) => {
  const f = flow();
  for (const a of f.actors) if (creditBlocks((await read('NftCredits','NftClaimCreditBlocks',[{ type: 'Account', value: a.account }])).value).length) throw new Error('Fresh player has prior credits');
  // Empty imported Registration games stay in the atomic batch. Populated or Shuffle imports use
  // bounded completion/cancellation before the one-batch setup; no state edits or funding.
  const importedValue = (await read('Game', 'Game')).value;
  const imported = importedValue === undefined ? undefined : requiredGame(importedValue);
  if (imported && (imported.state.type !== 'Registration' || imported.state.value?.next_player_index !== 0)) {
    const started = performance.now();
    const outcome = await clearImportedGames({ target: f.target, chain: f.people, root: f.root, transactions: f.transactions, record: f.log,
      waitMs: importedGameWaitMs(process.env.HUMANITY_FLOW_IMPORTED_GAME_WAIT_MS) });
    await lab.attach({ importedGameCleanup: { ran: true, elapsedMs: performance.now() - started, outcome } });
  } else await lab.attach({ importedGameCleanup: { ran: false } });
  await lab.attach({ balances: await balances(), recipe: 'dim2-players-ready, created in this run; never imported or exported' }); watch();
}, { timeoutMs: 75 * 60_000 });
step('the lab atomically prepares one local DIM2 game', async ({ lab }) => {
  const f = flow(); const index = await f.games.schedule({ withPrize: true, startsInSeconds: 1200, ownedBatch: f.target, recordSetup: f.log,
    recordSetupFailure: proof => lab.attach({ atomicSetupFailure: proof }) });
  const current = await read('Game','Game'); const value = requiredGame(current.value);
  f.game = { index, fromBlock: current.at.number, playsAt: value.game_date * 1000 }; await lab.attach({ game: f.game, forkSetup: current });
}, timeout);
step('{actor} taps "Open the game" in Humanity', async ({ lab }, name) => {
  const f = flow(), a = actor(name); await f.navigation.open(f.hostActors.get(a.id)!, 'peopl', '/');
  const p = page(name); await p.getByTestId('humanity-home').waitFor({ state: 'visible', timeout: 120_000 });
  // Existing display control only. No simulated membership state or app behavior change.
  const body = p.locator('body'); if (!body.press) throw new Error('Card display requires trusted keyboard input');
  await body.press('ControlOrMeta+d'); await p.locator('#debug-panel').waitFor({ state: 'visible' });
  const controls = p.locator('#debug-panel details:has(button:has-text("Shown"))');
  if (await controls.getAttribute('open') === null) await p.getByText('simulate', { exact: true }).click();
  await p.getByRole('button', { name: 'Shown', exact: true }).click(); await p.getByRole('button', { name: 'Hide', exact: true }).click();
  const card = await until(async () => { const found = await view(p); return found && cardReady(found) ? found : undefined; });
  await lab.attach({ card });
  await p.locator('section[aria-label="Next game"] button[aria-label="Register"], section[aria-label="Next game"] button[aria-label="Open the game"], section[aria-label="Next game"] button[aria-label$=", open the game"]').click();
  await f.navigation.waitFor(rows => rows.some(row => row.actorId === a.id && row.fromApp === 'peopl' && row.toApp === 'dim2' && row.outcome === 'opened'), { timeoutMs: 180_000 });
  await until(async () => f.navigation.activeApplication(a.id)?.appId === 'dim2' ? true : undefined);
  await until(async () => { const text = await inspect(a.name); const current = await view(page(name));
    if (text === null || current === null) return undefined;
    if (current.buttons.some(b => !b.disabled && (b.aria || b.text) === 'Allow access')) await page(name).getByRole('button',{ name: 'Allow access',exact: true }).click();
    if (/insufficient.*PAS|deposit required|fund your/i.test(text)) throw new Error('Native PAS was requested');
    const alias = await read('PeopleLite','AccountToAlias',[a.account]);
    return alias.value && current.buttons.some(b => !b.disabled && /^(Register|Sign up|Join game)$/.test(b.aria || b.text)) ? alias : undefined;
  });
  // Retain the identity, stop the source Humanity host after its real navigation has completed.
  for (const session of f.sessions.filter(s => s.actor.id === a.id && s.app.id === 'peopl')) await session.stop();
  await lab.attach({ navigation: f.navigation.evidence() });
}, timeout);
const registerPlayer: StepFunction = async ({ lab }, name) => {
  const a = actor(name); await inspect(a.name); const state = registrationGame((await read('Game','Game')).value);
  if (state.index !== game().index || state.state.type !== 'Registration' || state.registered >= 3) throw new Error('Wrong game or foreign registration');
  const registered = await registerWhenReady(page(name), {
    actor: a.name, signal: flow().context.signal, check: async () => { await inspect(a.name); check(); },
    registered: async () => { const found = await read('Game','Players',[{ type: 'Account', value: a.account }]); return (found.value as { registered?: boolean } | undefined)?.registered === true ? found : undefined; },
    beforeClick: async () => {
      const current = registrationGame((await read('Game','Game')).value);
      if (current.index !== game().index || current.state.type !== 'Registration' || current.registered >= 3) throw new Error('Wrong game or foreign registration');
    },
    attach: current => lab.attach({ actor: a.name, registrationView: current }),
  });
  await lab.attach({ registered });
};
step('{actor} registers for the game in DIM2', registerPlayer, timeout);
step('the three players register for the game in DIM2 together', async context => { await Promise.all(names.map(name => registerPlayer(context, name))); }, timeout);
step("{actor}'s DIM2 registration on chain is:", async ({ lab }, name, table) => {
  const expected = rows<{ registered: string }>(table);
  if (expected.length !== 1 || expected[0]!.registered !== 'true') throw new Error('This flow requires registration');
  const found = await read('Game','Players',[{ type: 'Account', value: actor(name).account }]);
  if ((found.value as { registered?: boolean } | undefined)?.registered !== true) fail('not-on-chain','Registration absent'); await lab.attach(found);
}, timeout);
step('the lab closes registration one minute after all three players registered', async ({ lab }) => {
  const f = flow(), current = await read('Game','Game'), g = registrationGame(current.value);
  if (g.index !== game().index || g.state.type !== 'Registration' || g.registered !== 3) throw new Error('Registration must contain exactly three players');
  for (const a of f.actors) if (((await read('Game','Players',[{ type: 'Account', value: a.account }])).value as { registered?: boolean } | undefined)?.registered !== true) throw new Error('Missing own registered player');
  const retimed = await f.games.retime(g.index, earliestPlay(visiblePhases)); game().playsAt = retimed.to * 1000;
  await lab.attach({ retimed, changed: 'game and prize dates only; chain time unchanged' });
}, timeout);
let together: ConfirmTogether | undefined;
const playPlayer: StepFunction = async ({ lab }, name) => {
  const f = flow(), a = actor(name); together ??= new ConfirmTogether(); const seat = together.join(a.name);
  await until(async () => {
    const found = await read('Game','Game'), state = requiredGame(found.value);
    if (!state || state.index !== game().index) throw new Error('Selected game ended');
    if (state.state.type === 'Registration' && registrationGame(found.value).registered > 3) throw new Error('Foreign player joined');
    if (state.state.type !== 'Reporting') return undefined;
    const group = await Promise.all([0,1,2,3].map(n => f.people.access.historicalStorage('Game','IndexToPlayer',[[0,n]],found.at.hash))) as Array<{ type: string; value: string } | undefined>;
    requireThree(group.filter(Boolean).map(p => p!.type === 'Account' ? p!.value : ''),f.actors.map(p => p.account)); return group;
  }, 10 * 60_000);
  await inspect(a.name);
  const result = await playDim2InApp(page(name), undefined, f.context.signal, game().playsAt, f.log,
    text => { const bad = firstAppFailure(text,{ actor: a.name, via: 'gameplay' }); if (bad) throw new Error(bad); check(); }, seat, () => readReportDeadline(f.people,game()));
  const payoff = result.votes.views.find(v => /^\/(prize-draw|chest|results),/.test(v.view));
  if (!payoff) throw new Error('No timestamped payoff view was retained');
  f.payoffStartedAt.set(a.id, payoff.at);
  await lab.attach({ gameplay: result, navigationCapture: await captureNavigationEvents(page(name), 1) });
};
step('{actor} plays and votes in the DIM2 app', playPlayer, timeout);
step('the three players play and vote in DIM2 together', async context => { await Promise.all(names.map(name => playPlayer(context, name))); }, timeout);
step("{actor}'s DIM2 app report is finalized", async ({ lab }, name) => {
  const a = actor(name), proof = await readDim2Report(flow().people,game(),a.account);
  if (isShutOut(proof)) fail('not-on-chain','DIM2 report was shut out'); flow().proofs.set(a.id,proof); await lab.attach(proof);
}, timeout);
step("{actor}'s finalized DIM2 votes are:", async ({ lab }, name, table) => {
  const a = actor(name), proof = flow().proofs.get(a.id); if (!proof) throw new Error('Missing finalized report');
  const votes = await readDim2Votes(flow().people.access,proof,game(),a.account);
  assertDim2Votes(votes,rows<{ round: string; person: string; notperson: string }>(table)); await lab.attach(votes);
}, timeout);
const viewResults: StepFunction = async ({ lab }, name) => {
  const f = flow(), a = actor(name), since = f.payoffStartedAt.get(a.id);
  if (since === undefined) throw new Error('Missing observed payoff timestamp');
  // Persist entry evidence before recovery navigation can replace the document or explain it away.
  const entry = await capturePostGameEntry(page(name), a.id, since, f.navigation.evidence());
  await lab.attach({ postGameEntry: { ...entry, navigationSignals: await captureNavigationEvents(page(name)) } });
  // Hold at the opened bubble's Continue; the album/host return belongs to a separate action.
  try {
    await lab.attach(await viewGameResults(page(name), game().index, async path => {
      await f.navigation.open(f.hostActors.get(a.id)!, 'dim2', path);
      await lab.attach({ postGameNavigationInstall: { actor: a.id, signals: await captureNavigationEvents(page(name), 2) } });
    }, { timeoutMs: 180_000, signal: f.context.signal, attach: view => lab.attach({ actor: a.id, visibleChest: view }) })); check();
  } finally {
    await lab.attach({ postGameNavigation: { actor: a.id, signals: await captureNavigationEvents(page(name)) } });
  }
};
step('{actor} views the DIM2 game results', viewResults, timeout);
step('the three players view the DIM2 game results together', async context => { await Promise.all(names.map(name => viewResults(context, name))); }, timeout);
step('{actor} has {int} DIM2 credits to keep on chain', async ({ lab }, name, expected) => {
  const f = flow(), a = actor(name), reading = await until(async () => { const r = await readCredits({ ...f.readers, account: a.account, game: game().index, peers: f.actors.filter(p => p.id !== a.id).map(p => p.account) });
    return r.credits.length && r.credits.every(c => c.delivered) ? r : undefined; }, 10 * 60_000);
  const count = mintable(reading).length; await lab.attach({ count, expected, reading, balances: await balances() }); check();
  if (count !== Number(expected)) fail('not-on-chain',`${count} DIM2 credits to keep, not ${expected}`);
  if (a.name === names.at(-1)) { await bind?.idle(); check(); await lab.attach({ bindWarnings: f.warnings }); together = undefined; }
}, timeout);
