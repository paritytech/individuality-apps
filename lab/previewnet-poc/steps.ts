// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The PoC's own sentences. Every read is of the finalized chain, and nothing here signs: Ada's host signs her
// sign-up, and the lab only watches. Opening Humanity and showing its card are the opening lab's sentences, and "the
// next game is open for sign-up" is an action (next-game.ts).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from '@parity/product-lab';
import { step } from '@parity/product-lab/steps';
import type { PapiChainAccess } from '@parity/product-lab/chain-papi';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { registerWhenReady, sentRegistrationClick } from '../shared/registration.ts';
import { jsonEvidence, nextGame } from '../shared/observations.ts';
import type { ScenarioChain } from '../shared/chain.ts';
import { assertRegistrationTable, readRegistrationRoute } from '../../apps/jollity-app/lab/scenarios/registration.ts';
import { awaitRegisteredHome, observeHome } from '../../apps/jollity-app/lab/scenarios/home.ts';
import { assertOpening, observeOpening } from '../../apps/humanity-app/lab/opening/steps.ts';
import { standingLabel, type Participant } from './rules.ts';
import { reachHome } from '../../apps/jollity-app/lab/opening/gate.ts';
import { camera, playerOf, world } from './people.ts';
import { CONSOLE_KEY } from './session.ts';

type Account = { data?: { free?: bigint; reserved?: bigint } } | undefined;
const at = async (access: PapiChainAccess) => access.finalizedHead();
const read = async (access: PapiChainAccess, pallet: string, item: string, keys: unknown[], hash: string) =>
  access.historicalStorage(pallet, item, keys, hash, { orDefault: true });
const player = (account: string) => [{ type: 'Account', value: account }];
/** What an account holds; an account the chain has no record of holds nothing. */
const held = (account: Account) => ({ free: account?.data?.free ?? 0n, reserved: account?.data?.reserved ?? 0n });

step("{actor}'s Humanity card shows her standing on chain", async ({ lab }, name) => {
  const state = world(), who = playerOf(lab.actor(String(name))), account = await who.account();
  const head = await at(state.people);
  const participant = await read(state.people, 'Score', 'Participants', player(account), head.hash) as Participant | undefined;
  const expected = standingLabel(participant);
  await lab.attach(jsonEvidence({ standing: { at: head, account, participant: participant ?? null, expected: expected ?? null } }));
  if (!expected) throw Error(`${who.name} has reached personhood: this scenario is for a lite person, before or after her first sign-up`);
  const view = who.own?.inHumanity?.view; if (!view) throw Error(`${who.name} has no Humanity in this lab`);
  const page = view.page;
  await page.getByTestId('humanity-home').waitFor({ state: 'visible', timeout: 120_000 });
  await page.getByTestId('membership-card').waitFor({ state: 'visible', timeout: 120_000 });
  const seen = await observeOpening(page);
  await lab.attach({ opening: seen, expected });
  assertOpening(seen, view.username, expected);
}, { timeoutMs: 260_000 });

/**
 * Jollity asks for what it needs when it is first opened: its permissions screen, then the host's sheets and the
 * device's. The camera is the one a game cannot do without, and the place to be asked is here, at sign-up, hours
 * before game time. The step walks the screen to the home, then opens the camera once and closes it, which raises any
 * sheet still unanswered; product-lab answers the host's.
 */
step('{actor} allows DIM2 its permissions', async ({ lab }, name) => {
  const state = world(), who = playerOf(lab.actor(String(name))), page = await who.page();
  await reachHome(page, state.signal);
  const seen = await camera(page, true);
  // A picture of the home she ended on, where one can be taken: on a phone the first proof that the page is hers.
  const png = await who.screenshot(), shots = join(state.directory, 'screens');
  if (png) { mkdirSync(shots, { recursive: true }); writeFileSync(join(shots, `permissions-${who.name}.png`), png); }
  await lab.attach(jsonEvidence({ camera: seen, account: await who.account().catch(error => `unreadable: ${String(error).slice(0, 120)}`), screenshot: png ? join(shots, `permissions-${who.name}.png`) : null }));
  const opened = 'opened' in seen ? seen.opened : undefined;
  if (!opened?.live) fail('unsupported-here', `${who.name}'s camera did not open at sign-up: ${JSON.stringify(seen)}`);
}, { timeoutMs: 420_000 });

/** What Jollity's console said about the sign-up: the reason a sign-up waits is there and nowhere on screen. Only the
 *  lines about the seat, the name link and the sign-up leave the page. */
async function signUpLog(page: Pick<BrowserPage, 'evaluate'>) {
  return page.evaluate((key: string) => {
    let lines: string[] = [];
    try { lines = JSON.parse(sessionStorage.getItem(key) ?? '[]') as string[]; } catch { lines = []; }
    return { kept: lines.length, lines: lines.filter(line => /\[names\]|name|link|sign|seat|bind|allow|regist|pgas|store|note|alias|invite|refus|denied|fail|error/i.test(line)).slice(-150) };
  }, CONSOLE_KEY).catch(error => ({ kept: 0, lines: [`unreadable: ${String(error).slice(0, 200)}`] }));
}

const signUps = new Map<string, { from: number; clicks: number; before: { people: ReturnType<typeof held> } }>();
step('{actor} registers for the game in DIM2', async ({ lab }, name) => {
  const state = world(), who = playerOf(lab.actor(String(name)));
  const page = await who.page(), account = await who.account(), key = player(account);
  const head = await at(state.people);
  const row = await read(state.people, 'Game', 'Players', key, head.hash) as { registered?: boolean } | undefined;
  if (row?.registered) throw Error(`${who.name} is already registered for this game: the scenario needs a game she has not signed up for`);
  const before = { people: held(await read(state.people, 'System', 'Account', [account], head.hash) as Account) };
  const signUp = { from: head.number, clicks: 0, before }; signUps.set(who.id, signUp);
  try {
    await registerWhenReady(page, { actor: who.name, signal: state.signal, timeoutMs: 540_000,
      check: () => {}, beforeClick: async () => {}, input: sent => { if (sentRegistrationClick(sent)) signUp.clicks++; },
      attach: view => lab.attach({ registration: view }),
      registered: async () => {
        const now = await at(state.people), found = await read(state.people, 'Game', 'Players', key, now.hash) as { registered?: boolean } | undefined;
        return found?.registered ? { at: now, value: found } : undefined;
      },
    });
  } finally {
    // What the lab's own network guard kept Jollity's page from reaching: a "Failed to fetch" in the console is the
    // lab's doing when its address is in this list, and the network's when it is not.
    const blocked = await who.own?.inJollity?.session.network?.blocked().catch(error => [{ unreadable: String(error).slice(0, 200) }]);
    await lab.attach(jsonEvidence({ jollityLog: await signUpLog(page), blockedByTheLab: blocked ?? "nothing: this host runs without the lab's network guard" }));
  }
  if (signUp.clicks !== 1) throw Error(`The sign-up took ${signUp.clicks} Register clicks, not one`);
  const home = await awaitRegisteredHome(() => observeHome(page), account, { signal: state.signal });
  await lab.attach(jsonEvidence({ registeredHome: home, before }));
}, { timeoutMs: 660_000 });

/**
 * The other way in: Register on Humanity's next-game block, which signs the DIM2 game account up from Humanity. It is
 * how a person signs up without opening Jollity at all, and the only way on a host where Jollity may not use
 * Humanity's key. Humanity prepares the seat in the background and says so on its console only: "name linked: Register
 * may go". A game account whose name Humanity cannot link (no PGAS: the host gives an allowance to a product for its
 * own accounts only) is handed to Jollity instead of signed up, which is a failure here and named as one.
 */
step('{actor} registers for the game in Humanity', async ({ lab }, name) => {
  const state = world(), who = playerOf(lab.actor(String(name)));
  const view = who.own?.inHumanity?.view; if (!view) fail('unsupported-here', `${who.name} has no Humanity page in this lab`);
  const page = view.page, account = await who.account(), key = player(account);
  const head = await at(state.people);
  const row = await read(state.people, 'Game', 'Players', key, head.hash) as { registered?: boolean } | undefined;
  if (row?.registered) throw Error(`${who.name} is already registered for this game: the scenario needs a game she has not signed up for`);
  const before = { people: held(await read(state.people, 'System', 'Account', [account], head.hash) as Account) };
  const signUp = { from: head.number, clicks: 0, before }; signUps.set(who.id, signUp);
  const said = async (words: RegExp) => (await signUpLog(page)).lines.filter(line => words.test(line));
  let tappedAt = '';
  try {
    // The block offers Register, and Humanity has said the name is linked. Without that line the tap still goes: what
    // Humanity then does with it is read below.
    const offered = Date.now() + 240_000; let block = await nextGame(page), ready: string[] = [];
    for (;;) {
      state.signal.throwIfAborted();
      block = await nextGame(page); ready = await said(/Register may go/);
      if (block?.mode === 'registration-open' && ready.length) break;
      if (Date.now() >= offered) break;
      await delay(2_000, undefined, { signal: state.signal });
    }
    await lab.attach(jsonEvidence({ humanityBlock: block ?? null, nameReady: ready.slice(-3) }));
    if (block?.mode !== 'registration-open') fail('screen-mismatch', `Humanity does not offer Register: ${JSON.stringify(block ?? null)}`);
    tappedAt = new Date().toISOString();
    await page.getByRole('button', { name: 'Register', exact: true }).click({ timeout: 10_000 });
    signUp.clicks++;
    const landed = Date.now() + 300_000;
    for (;;) {
      state.signal.throwIfAborted();
      const now = await at(state.people), found = await read(state.people, 'Game', 'Players', key, now.hash) as { registered?: boolean } | undefined;
      if (found?.registered) { await lab.attach(jsonEvidence({ registered: { at: now, value: found } })); break; }
      const handed = (await said(/Jollity takes the sign-up/)).filter(line => line.slice(0, 24) >= tappedAt);
      if (handed.length) fail('unsupported-here', `Humanity handed the sign-up to Jollity instead of signing: ${handed.at(-1)}`);
      if (Date.now() >= landed) fail('not-on-chain', `${who.name}'s sign-up from Humanity is not finalized after 5 minutes: ${JSON.stringify(await nextGame(page) ?? null)}`);
      await delay(3_000, undefined, { signal: state.signal });
    }
  } finally {
    const blocked = await who.own?.inHumanity?.session.network?.blocked().catch(error => [{ unreadable: String(error).slice(0, 200) }]);
    await lab.attach(jsonEvidence({ tappedAt, humanityLog: await signUpLog(page), humanityBlock: await nextGame(page).catch(() => null), blockedByTheLab: blocked ?? "nothing: this host runs without the lab's network guard" }));
  }
  // The landed sign-up refreshes Humanity's game read: the block turns to "Registered".
  const shown = Date.now() + 120_000; let block = await nextGame(page);
  while (block?.mode !== 'confirmed' && Date.now() < shown) { await delay(1_000, undefined, { signal: state.signal }); block = await nextGame(page); }
  await lab.attach(jsonEvidence({ humanityAfter: block ?? null, before }));
  if (block?.mode !== 'confirmed') fail('screen-mismatch', `Humanity does not show the sign-up as Registered: ${JSON.stringify(block ?? null)}`);
}, { timeoutMs: 720_000 });

/** A sign-up made elsewhere (in Humanity) reaches Jollity: its home says "You're in" for her game account. */
step("{actor}'s DIM2 home shows her registered", async ({ lab }, name) => {
  const state = world(), who = playerOf(lab.actor(String(name))), page = await who.page(), account = await who.account();
  const home = await awaitRegisteredHome(() => observeHome(page), account, { signal: state.signal, timeoutMs: 180_000 });
  await lab.attach(jsonEvidence({ registeredHome: home, jollityLog: await signUpLog(page) }));
}, { timeoutMs: 240_000 });

const routes = new Map<string, Awaited<ReturnType<typeof readRegistrationRoute>>>();
step("{actor}'s DIM2 registration on chain is:", async ({ lab }, name, table) => {
  if (!Array.isArray(table)) throw Error('Missing DIM2 registration table');
  assertRegistrationTable(table);
  const state = world(), who = playerOf(lab.actor(String(name))), account = await who.account(), signUp = signUps.get(who.id);
  if (!signUp) throw Error('No sign-up recorded in this scenario');
  const head = await at(state.people);
  const row = await read(state.people, 'Game', 'Players', player(account), head.hash) as { registered?: boolean } | undefined;
  if (row?.registered !== true) fail('not-on-chain', 'The sign-up is not finalized');
  // The helper reads through the chain's access only; it sends nothing.
  const route = await readRegistrationRoute({ people: { access: state.people } } as unknown as ScenarioChain, account, 'free', signUp.from);
  routes.set(who.id, route);
  await lab.attach(jsonEvidence({ at: head, row, route }));
}, { timeoutMs: 300_000 });

step("{actor}'s sign-up took the free seat", async ({ lab }, name) => {
  const state = world(), who = playerOf(lab.actor(String(name))), account = await who.account(), route = routes.get(who.id);
  if (!route) throw Error('No finalized free-route sign-up was read in this scenario');
  const parent = await state.people.blockAt(route.block.number - 1); if (!parent) throw Error('Missing the parent of the sign-up block');
  const [before, after, deposit] = await Promise.all([
    read(state.people, 'System', 'Account', [account], parent.hash) as Promise<Account>,
    read(state.people, 'System', 'Account', [account], route.block.hash) as Promise<Account>,
    read(state.people, 'Game', 'PlayDepositAmount', [], parent.hash) as Promise<bigint>,
  ]);
  const was = held(before), now = held(after);
  if (BigInt(deposit) <= 0n) throw Error('The chain names no play deposit');
  if (now.reserved - was.reserved >= BigInt(deposit)) fail('not-on-chain', 'The sign-up reserved the play deposit: it did not take the free seat');
  await lab.attach(jsonEvidence({ block: route.block, deposit, before: was, after: now }));
}, { timeoutMs: 120_000 });
