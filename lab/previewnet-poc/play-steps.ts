// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The play lab's own sentences: the people of one game play it in Jollity, and each one's report is read back from the
// finalized People chain. The lab taps what a person taps (a co-player's tile, Confirm) and files nothing itself:
// `Game.report` is the app's, signed by the person's host.
//
// Written for a page and no more (locators, and scripts that close over nothing), so that the same sentences can run
// where the page is a phone's. What is only Chromium's is optional evidence: the console lines the session keeps.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from '@parity/product-lab';
import { findEvent, type RuntimeEvent } from '@parity/product-lab/chain';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { step, type StepLab } from '@parity/product-lab/steps';
import { jsonEvidence } from '../shared/observations.ts';
import { ConfirmTogether } from '../shared/upstream/lab/steps/dim2/confirm-together.ts';
import { eventBelongsToAccount, playDim2InApp, type Dim2VoteDiagnostics } from '../shared/upstream/lab/steps/dim2/live-game.ts';
import { goOnAfterGame } from './after-game.ts';
import { camera, playerOf, world, type Player } from './people.ts';
import { chainedNth } from './rules.ts';
import { CONSOLE_ALL, CONSOLE_KEY } from './session.ts';

type Game = { index: number; game_date: number; state: { type: string } };
const read = async (pallet: string, item: string, keys: unknown[], hash: string) =>
  world().people.historicalStorage(pallet, item, keys, hash, { orDefault: true });

/** The helper gives a game 12 minutes from its play time to reach the screen after it; the wait to play time is on top. */
const PLAY_ALLOWS_MS = 12 * 60_000;
/** How long a report may take to be finalized after the play loop ended: live Previewnet reports for 12 minutes. */
const REPORT_WAIT_MS = 15 * 60_000;

/** How long her collectables may take to come after the game: they wait for the votes of the others in her group. */
const AFTER_GAME_WAIT_MS = Math.max(1, Number(process.env.PREVIEWNET_POC_AFTER_GAME_MINUTES ?? 10) || 10) * 60_000;
// Her collectables say "players are still voting" until the game is settled, which is after its `report_ends` on chain
// (an hour after the game on Paseo Next V2): a person who earned nothing reads the page's last word only then.
const SETTLE_NEEDS_MS = 5 * 60_000, AFTER_GAME_LIMIT_MS = 80 * 60_000;

/** One person at the game: her page and her game account, asked for once. */
type Seat = { player: Player; name: string; id: string; page: BrowserPage; account: string };

/** The game the people of this scenario played, and the block the lab started watching from. */
let played: { index: number; gameDate: number; fromBlock: number; accounts: string[] } | undefined;
/**
 * The scan for the game's reports, shared by every person's "report is finalized": each block is read once, and a
 * report found while looking for one person is kept for the next. A public node keeps a block's state for a few
 * minutes only (live Previewnet, 24 November 2026: "State already discarded" for a block twenty minutes old), so the
 * scan starts where the game began, a block that cannot be read is counted and passed over, and nobody reads a block
 * a second time, later, when it may be gone.
 */
let scan: { next: number; reports: Map<string, Record<string, unknown>>; unreadable: number } | undefined;

/** Where a person's Jollity stands, read from the page alone. The script closes over nothing and names no function of
 *  its own: it is sent to the page as source, where the TS runner's helpers do not exist. */
async function screen(page: Pick<BrowserPage, 'evaluate'>) {
  return page.evaluate(() => {
    const home = document.querySelector('[data-testid="home"]'), game = document.querySelector('[data-stage]');
    const shown: string[] = [];
    for (const id of ['camera-tap', 'camera-tap-notice', 'camera-restart-notice', 'waiting-network-blocked', 'chain-restart', 'home-update', 'webrtc-restart-notice', 'joining-in-progress', 'device-probe-screen', 'home-register'])
      if (document.querySelector(`[data-testid="${id}"]`)) shown.push(id);
    return { path: location.pathname + location.search,
      home: home ? { state: home.getAttribute('data-state'), registered: home.getAttribute('data-registered'), networkCheck: home.getAttribute('data-waiting-network-check'),
        status: document.querySelector('[data-testid="home-status"]')?.textContent?.trim() ?? null } : null,
      game: game ? { stage: game.getAttribute('data-stage'), turn: game.getAttribute('data-turn'), tiles: document.querySelectorAll('[data-id][data-tile-slot]').length } : null,
      shown, text: document.body.innerText.replace(/\s+/g, ' ').replace(/\b\d{1,2}:\d{2}\b|\b\d{1,2}\b(?= Waiting)/g, '#').slice(0, 240) };
  }, undefined).catch(error => ({ unreadable: String(error).slice(0, 200) }));
}

/**
 * Everything the page has said since it was last asked, written to a file of the run: its console, and Jollity's debug
 * log where the session's page script could reach it (session.ts). Asked every few seconds, so that a page that dies
 * leaves all but its last seconds. A page without the script (a phone's) gives nothing.
 */
const collected = new Map<string, number>();
function consoleFile(name: string) { return join(world().directory, 'console', `${name}.log`); }
async function collect(person: { name: string; page: Pick<BrowserPage, 'evaluate'> }) {
  const lines = await person.page.evaluate((key: string) => {
    const all = (window as unknown as Record<string, unknown>)[key];
    return Array.isArray(all) ? all.splice(0, all.length) as string[] : [];
  }, CONSOLE_ALL).catch(() => [] as string[]);
  if (!lines.length) return;
  mkdirSync(join(world().directory, 'console'), { recursive: true });
  appendFileSync(consoleFile(person.name), lines.join('\n') + '\n', { mode: 0o600 });
  collected.set(person.name, (collected.get(person.name) ?? 0) + lines.length);
}
/** What the collected lines say about each connection, counted: a first reading before anyone opens the file. */
function connections(name: string) {
  let text = ''; try { text = readFileSync(consoleFile(name), 'utf8'); } catch { return { file: null, lines: 0 }; }
  const count = (pattern: RegExp) => (text.match(pattern) ?? []).length;
  return { file: consoleFile(name), lines: collected.get(name) ?? 0, debugLogSink: /debug log sink installed/.test(text),
    turnServers: [...new Set([...text.matchAll(/turn_servers=(\d+)/g)].map(found => found[1]))],
    offersOut: count(/ log \[jollity-rtc\] → offer to /g), signalsIn: count(/ log \[jollity-rtc\] ← signal from /g),
    iceConnected: count(/ log \[jollity-rtc\] ice \S+ connected/g), firstVideo: count(/ log \[jollity-rtc\] first video after/g),
    deadlines: count(/ log \[jollity-rtc\] connect-by deadline expired/g),
    // How each link that came up was made, from the debug log's pair lines: "relay>srflx" is our relay to their public address.
    pairs: [...new Set([...text.matchAll(/"state":"succeeded","nominated":true,"local":"(\w+)","remote":"(\w+)"/g)].map(found => `${found[1]}>${found[2]}`))] };
}

/**
 * The page as the shared play loop gets it. The loop finds a tile with Playwright's `>> nth=0` inside the selector;
 * a phone's page hands the selector to the document as CSS, which refuses it, so a phone bot saw a votable tile and
 * could not tap it (Paseo game 363, 22 November 2026; paritytech/product-lab#193). Here the chain leaves the selector
 * and the locator is asked for the index, which every page can do. Everything else is the page's own.
 */
function cssOnly(page: BrowserPage): BrowserPage {
  return new Proxy(page, { get(target, key) {
    const value = Reflect.get(target, key, target) as unknown;
    if (key === 'locator') return (selector: string) => { const chain = chainedNth(selector); return chain ? target.locator(chain.css).nth(chain.nth) : target.locator(selector); };
    return typeof value === 'function' ? (value as (...values: unknown[]) => unknown).bind(target) : value;
  } });
}

/** The session's console lines about the game, where the page keeps them (Chromium): optional evidence. */
async function gameLog(page: Pick<BrowserPage, 'evaluate'>) {
  return page.evaluate((key: string) => {
    let lines: string[] = [];
    try { lines = JSON.parse(sessionStorage.getItem(key) ?? '[]') as string[]; } catch { lines = []; }
    return lines.filter(line => /rtc|\bice\b|turn|camera|peer|mesh|report|vote|verdict|waiting|joined|front-door|handover|build|error|fail|uncaught|unhandled|chunk|suspend/i.test(line)).slice(-160);
  }, CONSOLE_KEY).catch(error => [`unreadable: ${String(error).slice(0, 200)}`]);
}

/**
 * Jollity's own debug log, read from its debug sheet as a person can open it (Ctrl+D, or five taps at the top on a
 * phone): why the app did or did not go into a game is said there and nowhere on screen. The sheet holds the last
 * 250 entries. It is closed again: the play loop refuses to tap under it.
 */
async function debugLog(page: Pick<BrowserPage, 'evaluate'>) {
  try {
    await page.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true })); }, undefined);
    await delay(1_500);
    // One line per entry: its time, tag and message, and the start of its data. The sheet draws each entry as a row
    // of three spans over an optional <pre>.
    const lines = await page.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Debug logs"]');
      if (!sheet) return null;
      const out: string[] = [];
      for (const row of Array.from(sheet.querySelectorAll('div'))) {
        const spans = row.querySelectorAll(':scope > div > span');
        if (spans.length < 3) continue;
        const data = row.querySelector(':scope > pre')?.textContent?.replace(/\s+/g, ' ').slice(0, 280) ?? '';
        out.push(`${spans[0]!.textContent} ${spans[1]!.textContent} ${spans[2]!.textContent} ${data}`.trim());
      }
      return out;
    }, undefined);
    await page.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }, undefined);
    if (!lines) return ['the debug sheet did not open'];
    return lines.slice(-250);
  } catch (error) { return [`unreadable: ${String(error).slice(0, 200)}`]; }
}

/** What changed while the people waited and played: the game on the best block and each person's screen, read every
 *  ten seconds and kept when it differs from the read before. Why a game was never entered is in here. */
function watch(people: readonly Seat[], signal: AbortSignal, gameDate: number) {
  const timeline: unknown[] = [], last = new Map<string, string>();
  // Pictures of each person's screen, where the host session can take them: one when the screen changes, and one at
  // every read from two minutes before the game to five after it, when a change may be between two reads.
  const shots = join(world().directory, 'screens'); mkdirSync(shots, { recursive: true });
  let taken = 0;
  const shoot = async (person: Seat) => {
    if (taken >= 400) return undefined;
    const png = await person.player.screenshot();
    if (!png) return undefined;
    const file = join(shots, `${String(++taken).padStart(3, '0')}-${person.name}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`);
    writeFileSync(file, png);
    return file;
  };
  const note = (who: string, seen: unknown, shot?: string) => {
    const text = JSON.stringify(seen, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
    if (last.get(who) === text && !shot) return;
    last.set(who, text);
    if (timeline.length < 600) timeline.push({ at: new Date().toISOString(), who, seen, ...(shot ? { shot } : {}) });
  };
  const changed = (who: string, seen: unknown) => last.get(who) !== JSON.stringify(seen);
  const stop = new AbortController(), stopped = AbortSignal.any([signal, stop.signal]);
  // The block the chain was at half a minute before the game: no report of this game is in an earlier one.
  let gameBlock: number | undefined;
  // Nobody in the game four minutes after it began: it is lost, and waiting out the play loop's twelve adds nothing.
  const lost = new AbortController();
  let entered = false;
  const done = (async () => {
    while (!stopped.aborted) {
      if (!entered && Date.now() / 1000 > gameDate + 240) lost.abort(Error('Nobody entered the game within four minutes of its start'));
      const best = await world().people.bestHead().catch(() => undefined);
      if (gameBlock === undefined && best && Date.now() / 1000 >= gameDate - 30) gameBlock = best.number;
      const game = best ? await read('Game', 'Game', [], best.hash).catch(() => undefined) as Game | undefined : undefined;
      const rows = best ? await Promise.all(people.map(person => read('Game', 'Players', [{ type: 'Account', value: person.account }], best.hash).catch(() => 'unread'))) : [];
      note('chain', { game: game ? { index: game.index, state: game.state } : null, players: Object.fromEntries(people.map((person, index) => [person.name, rows[index] ?? null])) });
      const near = Date.now() / 1000 > gameDate - 120 && Date.now() / 1000 < gameDate + 300;
      for (const person of people) {
        const seen = await screen(person.page);
        if ('path' in seen && seen.path.startsWith('/game')) entered = true;
        note(person.name, seen, near || changed(person.name, seen) ? await shoot(person) : undefined);
        await collect(person);
      }
      await delay(10_000, undefined, { signal: stopped }).catch(() => undefined);
    }
  })();
  return { timeline, lost: lost.signal, gameBlock: () => gameBlock, async stop() { stop.abort(); await done.catch(() => undefined); } };
}

const playTakes = { timeoutMs: 22 * 60_000 + PLAY_ALLOWS_MS + 120_000 };

/** The people named play the game on the chain: each in their own Jollity, together where there are several. */
async function play(lab: StepLab, names: readonly unknown[]) {
  const state = world(), signal = state.signal;
  const people: Seat[] = await Promise.all(names.map(async name => {
    const player = playerOf(lab.actor(String(name)));
    return { player, name: player.name, id: player.id, page: await player.page(), account: await player.account() };
  }));
  // No camera, no game: Jollity keeps the door shut without one. The permission is given at sign-up; a person who
  // comes to the game without it fails here, with the reason, and not at game time with a still screen. Only "denied"
  // is an answer, though: a phone's WebView may keep no record of a permission and say "prompt" after a camera that
  // opened. So anything else is settled by opening it once more, which also answers a sheet that is still due.
  const cameras = await Promise.all(people.map(async person => {
    const asked = await camera(person.page, false).catch(error => ({ permission: `unreadable: ${String(error).slice(0, 120)}` }));
    if (asked.permission === 'granted' || asked.permission === 'denied') return { name: person.name, ...asked };
    const tried = await camera(person.page, true).catch(error => ({ permission: asked.permission, refused: String(error).slice(0, 200) }));
    return { name: person.name, said: asked.permission, ...tried };
  }));
  await lab.attach(jsonEvidence({ cameras }));
  const without = cameras.find(seen => seen.permission === 'denied' || 'refused' in seen);
  if (without) fail('unsupported-here', `${without.name}'s camera is not allowed (${JSON.stringify(without)}): the permission is given at sign-up`);
  const head = await state.people.finalizedHead();
  const [game, now] = await Promise.all([read('Game', 'Game', [], head.hash) as Promise<Game | undefined>, read('Timestamp', 'Now', [], head.hash) as Promise<bigint>]);
  if (!game) fail('not-on-chain', 'No game is on the chain to play');
  for (const person of people) {
    const row = await read('Game', 'Players', [{ type: 'Account', value: person.account }], head.hash) as { registered?: boolean } | undefined;
    if (row?.registered !== true) fail('not-on-chain', `${person.name} is not registered for game ${game.index}`);
  }
  played = { index: game.index, gameDate: game.game_date, fromBlock: head.number, accounts: people.map(person => person.account) };
  scan = undefined;
  const untilPlay = game.game_date - Number(now / 1000n);
  await lab.attach(jsonEvidence({ game, at: head, secondsToGame: untilPlay, players: people.map(person => ({ name: person.name, account: person.account })) }));
  // A dev server compiles a route when it is first asked for. Jollity moves to /game a minute before play: ask now.
  // Only the lab's own Jollity is a dev server; a published app has its pages built.
  const warmed = await Promise.all(people.map(person => person.player.own ? fetch(new URL('/game', person.player.own.jollityUrl), { signal }).then(answer => answer.status, error => String(error).slice(0, 120)) : 'published'));
  const together = new ConfirmTogether(), watching = watch(people, signal, game.game_date);
  // The play loop ends before the step's own limit does, so that what was seen is always attached.
  const playing = AbortSignal.any([signal, watching.lost, AbortSignal.timeout(playTakes.timeoutMs - 120_000)]);
  // The loop hands over its vote record when it ends, also when it throws: a game that was played and whose page then
  // went quiet (Paseo game 374, 26 November 2026) still says how many taps it made.
  const tallies = new Map<string, Dim2VoteDiagnostics>();
  const outcomes = await Promise.allSettled(people.map(async person => {
    const { page } = person;
    // Alone among strangers there is nobody of the lab's to confirm together with: she confirms when she is ready.
    return playDim2InApp(cssOnly(page), undefined, playing, game.game_date * 1000, undefined, undefined, people.length > 1 ? together.join(person.id) : undefined,
      undefined, undefined, votes => { tallies.set(person.id, votes); });
  }));
  await watching.stop();
  // The reports are looked for from the game on, not from the wait before it: those blocks' state may be gone by now.
  const began = watching.gameBlock();
  if (played && began !== undefined) played.fromBlock = Math.max(played.fromBlock, began);
  await Promise.all(people.map(person => collect(person)));
  const evidence = await Promise.all(people.map(async (person, index) => {
    const outcome = outcomes[index]!, tally = tallies.get(person.id);
    const votes = tally ? { roundTaps: tally.roundTaps, confirmTaps: tally.confirmTaps, reads: tally.reads, clickErrors: tally.clickErrors.length + tally.droppedErrors,
      lastViews: tally.views.slice(-4).map(view => ({ at: new Date(view.at).toISOString(), view: view.view.slice(0, 400) })) } : null;
    return { name: person.name, ...(outcome.status === 'fulfilled' ? { played: { taps: outcome.value.taps, confirmations: outcome.value.confirmations, confirm: outcome.value.confirm } } : { failed: String(outcome.reason).slice(0, 1500), votes }),
      screen: await screen(person.page), console: await gameLog(person.page), debugLog: await debugLog(person.page) };
  }));
  await lab.attach(jsonEvidence({ connections: Object.fromEntries(people.map(person => [person.name, connections(person.name)])) }));
  await lab.attach(jsonEvidence({ warmed, screenshots: join(state.directory, 'screens'), timeline: watching.timeline, play: evidence }));
  const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failed) throw failed.reason;
}
step('{actor} and {actor} play the game and vote for each other', async ({ lab }, first, second) => play(lab, [first, second]), playTakes);
// On a live network the others in her group are whoever signed up: she taps each person her screen shows her.
step('{actor} plays the game and votes for the people she sees', async ({ lab }, name) => play(lab, [name]), playTakes);

step("{actor}'s report of the game is finalized", async ({ lab }, name) => {
  const state = world(), who = playerOf(lab.actor(String(name))), account = await who.account(), page = await who.page(), game = played;
  if (!game) throw Error('No game was played in this scenario');
  const deadline = Date.now() + REPORT_WAIT_MS, others: unknown[] = [];
  const reading = scan ??= { next: game.fromBlock, reports: new Map(), unreadable: 0 };
  let head = await state.people.finalizedHead();
  for (;;) {
    state.signal.throwIfAborted();
    const mine = reading.reports.get(account);
    if (mine) { await lab.attach(jsonEvidence({ report: mine, finalizedHead: head, blocksNotReadable: reading.unreadable })); return; }
    head = await state.people.finalizedHead();
    for (; reading.next <= head.number; reading.next++) {
      const number = reading.next;
      let block: Awaited<ReturnType<typeof state.people.blockAt>>, events: RuntimeEvent[] | undefined;
      try {
        block = await state.people.blockAt(number); if (!block) continue;
        events = await state.people.historicalStorage('System', 'Events', [], block.hash) as RuntimeEvent[] | undefined;
      } catch { reading.unreadable++; continue; }
      // Every person of this game is looked for in the block, so that it is read once for all of them.
      for (const player of game.accounts.includes(account) ? game.accounts : [...game.accounts, account]) {
        const found = findEvent(events ?? [], 'Game', 'ReportSubmitted', value => eventBelongsToAccount(value, player, game.index));
        if (!found || reading.reports.has(player)) continue;
        const hashes = await state.people.extrinsicHashes(block.hash).catch(() => undefined);
        reading.reports.set(player, { game: game.index, account: player, block: { number, hash: block.hash }, extrinsicIndex: found.extrinsicIndex, txHash: hashes?.[found.extrinsicIndex] ?? null, event: found.value });
      }
      // What other reports the chain took, in case this one is there in a shape the lab does not expect.
      const any = findEvent(events ?? [], 'Game', 'ReportSubmitted');
      if (any && others.length < 10) others.push({ block: number, event: any.value });
    }
    if (reading.reports.has(account)) continue;
    if (Date.now() >= deadline) break;
    await delay(6_000, undefined, { signal: state.signal });
  }
  await lab.attach(jsonEvidence({ noReport: { game: game.index, account, scanned: { from: game.fromBlock, to: head.number }, blocksNotReadable: reading.unreadable, otherReports: others },
    screen: await screen(page) }));
  fail('not-on-chain', `No finalized Game.ReportSubmitted from ${who.name} for game ${game.index} within ${REPORT_WAIT_MS / 60_000} minutes`);
}, { timeoutMs: REPORT_WAIT_MS + 120_000 });

// A rehearsal for a host that has not played yet (a phone): everything the play loop asks of a page except a game.
// It reads the screen as this file and the shared loop read it (a script on the page, and one on a locator), opens
// Jollity's debug sheet and closes it, and counts a button by its role. A page that cannot do one of these would fail
// a game at game time; here it fails hours before.
step("{actor}'s Jollity can be read as a game is read", async ({ lab }, name) => {
  const who = playerOf(lab.actor(String(name))), page = await who.page();
  const seen = await screen(page);
  const asTheLoop = await page.locator('body').evaluate((body) => ({
    path: location.pathname,
    headings: [...body.querySelectorAll('h1, h2, [role=heading]')].slice(0, 10).map((node) => (node.textContent ?? '').trim().slice(0, 200)),
    buttons: [...body.querySelectorAll('button')].slice(0, 20).map((node) => (node.textContent ?? '').trim().slice(0, 200)),
    debugOpen: body.querySelector('[role="dialog"][aria-label="Debug logs"]') !== null,
    slots: body.querySelectorAll('[data-id][data-tile-slot]').length,
  })).catch(error => ({ unreadable: String(error).slice(0, 300) }));
  const confirm = await page.getByRole('button', { name: /Confirm votes|Confirming|Vote didn't send/i }).count().catch(error => `unreadable: ${String(error).slice(0, 200)}`);
  // The tile tap's own way to a tile: the loop's selector with its nth chain, through the page the loop is given.
  const indexed = await cssOnly(page).locator('body >> nth=0').count().catch(error => `unreadable: ${String(error).slice(0, 200)}`);
  const log = await debugLog(page);
  const afterSheet = await page.locator('body').evaluate((body) => body.querySelector('[role="dialog"][aria-label="Debug logs"]') !== null).catch(error => `unreadable: ${String(error).slice(0, 200)}`);
  const picture = await who.screenshot();
  // What the page has said so far goes to the run's console file, as it does every few seconds of a game.
  await collect({ name: who.name, page });
  await lab.attach(jsonEvidence({ connections: connections(who.name) }));
  await lab.attach(jsonEvidence({ rehearsal: { screen: seen, asTheLoop, confirmButtons: confirm, indexedLocator: indexed, debugLog: { entries: log.length, last: log.slice(-12) }, sheetLeftOpen: afterSheet, account: await who.account().catch(error => `unreadable: ${String(error).slice(0, 120)}`), picture: picture ? `${picture.length} bytes` : null } }));
  const failed = ['unreadable' in seen ? `the screen: ${seen.unreadable}` : '', 'unreadable' in asTheLoop ? `the loop's read: ${asTheLoop.unreadable}` : '',
    typeof confirm === 'string' ? `the Confirm button: ${confirm}` : '', indexed !== 1 ? `the indexed locator: ${String(indexed)}` : '', log.length === 1 && /unreadable|did not open/.test(log[0] ?? '') ? `the debug sheet: ${log[0]}` : '',
    afterSheet === true ? 'the debug sheet stayed open' : typeof afterSheet === 'string' ? `the sheet check: ${afterSheet}` : ''].filter(Boolean);
  if (failed.length) fail('unsupported-here', `${who.name}'s page cannot be read as a game needs: ${failed.join('; ')}`);
}, { timeoutMs: 180_000 });

// The way on after the game, as a person takes it (after-game.ts): her coin into the draw's slot where she is in the
// draw, a hold on the draw, then the book's cover dragged across. It fails where a gesture was made and the page did
// not answer it, and where her collectables never came to their last word (a book to close, or why there is nothing):
// a page still waiting when the game is settled is a failure, not a pass. A game without a draw passes.
/** How long her collectables may take: the wait a run names (`PREVIEWNET_POC_AFTER_GAME_MINUTES`), else to the game's
 *  `report_ends` on chain and the settle after it, read from the chain since each network has its own. */
async function afterGameWait(state: ReturnType<typeof world>): Promise<{ ms: number; why: string }> {
  if (process.env.PREVIEWNET_POC_AFTER_GAME_MINUTES) return { ms: AFTER_GAME_WAIT_MS, why: 'the wait this run names' };
  try {
    const head = await state.people.finalizedHead();
    const game = await state.people.historicalStorage('Game', 'Game', [], head.hash) as { index?: number; report_ends?: number | bigint } | undefined;
    if (game && played && Number(game.index) === played.index && game.report_ends !== undefined) {
      const ms = Number(game.report_ends) * 1000 + SETTLE_NEEDS_MS - Date.now();
      return { ms: Math.min(AFTER_GAME_LIMIT_MS, Math.max(AFTER_GAME_WAIT_MS, ms)), why: `game ${played.index} takes reports until ${new Date(Number(game.report_ends) * 1000).toISOString()}` };
    }
    return { ms: AFTER_GAME_WAIT_MS, why: 'the chain is past the game that was played' };
  } catch (error) {
    return { ms: AFTER_GAME_WAIT_MS, why: `the game's report_ends could not be read (${String((error as Error)?.message ?? error).slice(0, 120)})` };
  }
}
step('{actor} holds on the draw and closes the book on her collectables', async ({ lab }, name) => {
  const state = world(), who = playerOf(lab.actor(String(name))), page = await who.page();
  const shots = join(state.directory, 'screens'); mkdirSync(shots, { recursive: true });
  let taken = 0;
  const shot = async (label: string) => {
    const png = await who.screenshot();
    if (png) writeFileSync(join(shots, `after-${String(++taken).padStart(2, '0')}-${who.name}-${label}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`), png);
  };
  const wait = await afterGameWait(state);
  const went = await goOnAfterGame(page, { waitMs: wait.ms, signal: state.signal, shot });
  await shot('end');
  await lab.attach(jsonEvidence({ afterGame: went, waited: { minutes: Math.round(wait.ms / 6_000) / 10, why: wait.why }, screenshots: shots }));
  if (went.coin === 'stayed') throw Error(`${who.name}'s drag of her coin into the draw's slot did not start the draw (${went.ended}); trail: ${JSON.stringify(went.trail)}`);
  if (went.hold === 'did-nothing') throw Error(`${who.name}'s hold on the draw did not take the page on (${went.ended}); trail: ${JSON.stringify(went.trail)}`);
  if (went.book === 'still-open') throw Error(`${who.name}'s drag of the book's cover did not shut it (${went.ended}); trail: ${JSON.stringify(went.trail)}`);
  if (went.book === 'not-shown' && 'collectables' in went.last && went.last.collectables === 'waiting')
    throw Error(`${who.name}'s collectables never came to their last word in ${Math.round(wait.ms / 60_000)} minutes (${wait.why}): ${went.ended}; trail: ${JSON.stringify(went.trail)}`);
}, { timeoutMs: Math.max(AFTER_GAME_WAIT_MS, AFTER_GAME_LIMIT_MS) + 3 * 60_000 });
