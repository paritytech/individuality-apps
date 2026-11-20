// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { fundNameLink } from './funding.ts';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { step as registerStep, type StepArgument, type StepFunction } from '@parity/product-lab/steps';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import type { HostSession } from '@parity/product-lab';
import { scenario } from '../shared/session.ts';
import { nextGame, jsonEvidence } from '../shared/observations.ts';
import { readRegistrationView } from '../shared/registration.ts';
import { readWatchedText } from '../shared/watched-text.ts';
import { RegistrationWatch, FrameProbe } from './chain-watch.ts';
import { handoffIsUnregistered, confirmsRegistrationHandoff } from './handoff.ts';
import { breakdown, assertAddsUp, assertFiniteNumbers, commentSection, type Breakdown, type Reader } from './timing.ts';

function step(pattern: string, run: StepFunction, options?: Parameters<typeof registerStep>[2]) {
  registerStep(pattern, ({ lab }, ...args) => run({ lab: { ...lab, attach: value => lab.attach(jsonEvidence(value)) } }, ...args), options);
}
const s = scenario;
/** The end state must appear within this cap; a label never fails the run, only a missing end state or a broken step does. */
export const capMs = 10 * 60_000;

/** How each reading app learns of the registration, from its source (see the job's diagnosis for file:line). */
export const readers: Record<'C1' | 'C2', Reader> = {
  C1: { app: 'Humanity', head: 'best', how: 'finalized game read plus a best-block Game.Players read, polled every 30 s (3 s with a live, non-failed own or host-shared sign-up record)' },
  C2: { app: 'Jollity', head: 'best', how: 'Game.Players subscription (watchPlayer) on the best head, pushed per block' },
};
function ada(name: StepArgument) { if (name !== 'Ada') throw Error('Only Ada has app pages'); return s().actor(); }
function jollity() { const page = s().actor().jollity?.page; if (!page) throw Error('No Jollity page: use the cross-app config'); return page; }
function humanity() { return s().actor().view.page; }

const shows = {
  /** Humanity's next-game block offers "Registered, open the game". */
  humanityRegistered: () => Boolean(document.querySelector('section[aria-label="Next game"] button[aria-label="Registered, open the game"]')),
  /** Jollity's home status badge reads the app's own "You're in". */
  jollityRegistered: () => document.querySelector('[data-testid="home-status"]')?.textContent?.trim() === "You're in",
  jollityStatus: () => document.querySelector('[data-testid="home-status"]')?.textContent?.trim() ?? null,
};

/** A DOM mark from the page clock: a MutationObserver installed before the tap, and a node-side poll as a backstop. */
async function watchDom(page: BrowserPage, which: 'humanity' | 'jollity') {
  await readWatchedText(page, which === 'humanity'
    ? () => { (window as unknown as { __crossAppSeen?: number }).__crossAppSeen = undefined;
      new MutationObserver(() => { const w = window as unknown as { __crossAppSeen?: number };
        if (w.__crossAppSeen === undefined && document.querySelector('section[aria-label="Next game"] button[aria-label="Registered, open the game"]')) w.__crossAppSeen = Date.now(); })
        .observe(document, { subtree: true, childList: true, characterData: true, attributes: true }); return true; }
    : () => { (window as unknown as { __crossAppSeen?: number }).__crossAppSeen = undefined;
      new MutationObserver(() => { const w = window as unknown as { __crossAppSeen?: number };
        if (w.__crossAppSeen === undefined && document.querySelector('[data-testid="home-status"]')?.textContent?.trim() === "You're in") w.__crossAppSeen = Date.now(); })
        .observe(document, { subtree: true, childList: true, characterData: true, attributes: true }); return true; });
}
async function rendered(page: BrowserPage, which: 'humanity' | 'jollity', signal: AbortSignal): Promise<{ at: number; source: 'mutation-observer' | 'poll' }> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const polledAt = Date.now();
    const seen = await readWatchedText(page, which === 'humanity' ? shows.humanityRegistered : shows.jollityRegistered);
    if (seen) {
      const observed = await readWatchedText(page, () => (window as unknown as { __crossAppSeen?: number }).__crossAppSeen ?? null);
      return typeof observed === 'number' && observed <= Date.now() ? { at: observed, source: 'mutation-observer' } : { at: polledAt, source: 'poll' };
    }
    await delay(100, undefined, { signal });
  }
  throw Error(`${which === 'humanity' ? 'Humanity' : 'Jollity'} never showed the registration within ${capMs / 60_000} min`);
}

let outputDirectory: string | undefined;
export function output() {
  outputDirectory ??= resolve(process.env.CROSS_APP_TIMINGS_DIR ?? join(s().context.root, '.product-lab', 'cross-app', new Date().toISOString().replace(/[:.]/g, '-')));
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  return outputDirectory;
}
/** Every run lands in timings.jsonl; comment.md is rewritten from all of this command's runs. Nothing is posted. */
export function save(value: Breakdown, raw: unknown) {
  assertFiniteNumbers({ value, raw });
  assertAddsUp(value);
  const directory = output();
  appendFileSync(join(directory, 'timings.jsonl'), JSON.stringify(jsonEvidence({ breakdown: value, raw })) + '\n', { mode: 0o600 });
  const all = readFileSync(join(directory, 'timings.jsonl'), 'utf8').trim().split('\n').map(line => (JSON.parse(line) as { breakdown: Breakdown }).breakdown);
  const section = commentSection(all);
  writeFileSync(join(directory, 'comment.md'), section, { mode: 0o600 });
  console.log(commentSection([value]));
}

step("the lab funds {actor}'s game account", async ({ lab }, name) => {
  const c = s().chain, calls = await c.fundingCalls([ada(name).game]);
  if (calls.length) await c.batch("Fund Ada's game account", calls);
  await c.checkpoint('Ada game-account funding');
  await lab.attach({ funded: s().actor().game.address, calls: calls.length });
}, { timeoutMs: 5 * 60_000 });

step("the lab funds Ada's name-link deposit on Asset Hub", async ({ lab }) => {
  const proof = { assetHubFunding: await fundNameLink(s()) };
  await lab.attach(proof);
  if (process.env.CROSS_APP_TIMINGS_DIR) {
    mkdirSync(process.env.CROSS_APP_TIMINGS_DIR, { recursive: true });
    appendFileSync(join(process.env.CROSS_APP_TIMINGS_DIR, 'observations.jsonl'), JSON.stringify(jsonEvidence(proof)) + '\n');
  }
}, { timeoutMs: 5 * 60_000 });

step("the lab waits for Humanity to see Ada's finalized funding", async ({ lab }) => {
  const state = s(), account = state.actor().game.address, origin = new URL(state.apps.humanity).origin;
  await state.chain.checkpoint('before observing Ada funding in Humanity');
  try {
    const proof = await state.chain.until('Humanity sees finalized Ada funding and a ready name link', async () => {
      const [balance, deposit] = await Promise.all([state.chain.read('System', 'Account', [account]), state.chain.read('Game', 'PlayDepositAmount')]);
      const free = (balance.value as { data?: { free?: bigint } } | undefined)?.data?.free ?? 0n;
      // Only Humanity's own successful gate proves its Asset Hub client has caught up. Keep all earlier
      // unfunded outcomes in startupLog; a finalized People transfer alone cannot prove the other chain's read.
      const ready = [...state.crossAppLog].reverse().find(m => new URL(m.url).origin === origin && /name ["']?(?:already-)?linked["']?: Register may go/i.test(m.text));
      return free >= BigInt(deposit.value as bigint) && ready ? { balance, deposit, humanityReady: ready } : undefined;
    }, 180_000);
    await lab.attach({ fundingReadiness: proof });
  } finally {
    const findings = { kind: 'funding-readiness', startupLog: state.crossAppLog };
    await lab.attach(findings);
    if (process.env.CROSS_APP_TIMINGS_DIR) {
      mkdirSync(process.env.CROSS_APP_TIMINGS_DIR, { recursive: true });
      appendFileSync(join(process.env.CROSS_APP_TIMINGS_DIR, 'observations.jsonl'), JSON.stringify(jsonEvidence(findings)) + '\n');
    }
  }
}, { timeoutMs: 5 * 60_000 });

step('{actor} sees Humanity offer Register for the next game', async ({ lab }, name) => {
  ada(name);
  const seen = await s().chain.until('Humanity registration-open', async () => { const view = await nextGame(humanity()); return view?.mode === 'registration-open' ? view : undefined; }, 180_000);
  await lab.attach(seen);
}, { timeoutMs: 200_000 });

step('{actor} sees Jollity offer Register for the next game', async ({ lab }, name) => {
  ada(name);
  // Optional cause probe, never used for latency comparisons: hold Jollity's permission
  // gate until Humanity has actually found that this fresh game account cannot link its name.
  if (process.env.CROSS_APP_NAME_BEFORE_JOLLITY === '1') {
    const origin = new URL(s().apps.humanity).origin;
    const outcome = await s().chain.until('Humanity hand-off prerequisite before Jollity permissions', async () =>
      s().crossAppLog.find(message => new URL(message.url).origin === origin &&
        /name link.*(?:unfunded|skipped)|no sign-up:|the sign-up could not start/i.test(message.text)), 120_000);
    await lab.attach({ probe: 'Humanity prepared before Jollity permissions', outcome });
  }
  let allowed = false;
  const seen = await s().chain.until('Jollity Register enabled', async () => {
    const view = await readRegistrationView(jollity());
    if (view?.nativePasRequested) throw Error('Jollity requested native PAS');
    if (view?.path === '/permissions' && !allowed && view.buttons.some(b => b.name === 'Allow access' && !b.disabled)) {
      // The product's own permission gate, tapped once, as in the Humanity to DIM2 flow.
      allowed = true; await jollity().getByRole('button', { name: 'Allow access', exact: true }).click({ timeout: 5_000 }); return undefined;
    }
    const status = await readWatchedText(jollity(), shows.jollityStatus);
    return view?.path === '/' && status === 'Next game' && view.buttons.some(b => b.name === 'Register' && !b.disabled) ? { view, status } : undefined;
  }, 300_000);
  await lab.attach(seen);
}, { timeoutMs: 320_000 });

/**
 * The writing app asked its host to open the other app instead of signing (Humanity's Register hands off to Jollity
 * when this host cannot sign the game account up from Humanity). Fail after 15 s without a registered row when
 * either the pool stayed empty or the writing app confirmed the hand-off. Pool entries can be background binds.
 */
async function handedOff(writing: HostSession, tap: number, watch: RegistrationWatch, signal: AbortSignal, confirmed: () => boolean): Promise<never> {
  const runDir = (writing.evidence as { runDir?: unknown }).runDir;
  if (typeof runDir !== 'string') return new Promise<never>(() => {});
  const file = join(runDir, 'navigations.jsonl');
  while (!signal.aborted) {
    try { await delay(1_000, undefined, { signal }); } catch { break; }
    let requests: Array<{ at: number; url: string }> = [];
    try { requests = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { at: number; url: string }); } catch { continue; }
    const request = requests.find(r => r.at >= tap);
    if (request && handoffIsUnregistered({ tap, requestAt: request.at, now: Date.now(), ...watch.status(), confirmedByWriter: confirmed() }))
      throw Error(`The writing app handed the sign-up to another app (host navigation to ${request.url} ${request.at - tap} ms after the tap); the registration is still absent after 15 s`);
  }
  // Ended by the run's own outcome; the race has already settled.
  return new Promise<never>(() => {});
}

/** One direction, end to end: watch the chain and the reading app, tap Register in the writing app, time it all. */
async function timed(direction: 'C1' | 'C2', run: string) {
  const state = s(), actor = state.actor(), signal = state.people.signal;
  const reading = direction === 'C1' ? { page: humanity(), which: 'humanity' as const, origin: state.apps.humanity }
    : { page: jollity(), which: 'jollity' as const, origin: state.apps.jollity };
  if (!reading.origin) throw Error('No Jollity app in this lab');
  const players = state.people.access.client.getUnsafeApi().query.Game?.Players;
  if (!players) throw Error('No Game.Players query on the People chain');
  const key = await players.getKey({ type: 'Account', value: actor.game.address });
  const probe = new FrameProbe(new URL(reading.origin).origin, key);
  state.network.frameProbes.add(probe.listener);
  const watch = new RegistrationWatch(state.people, actor.game.address).start();
  const writing = direction === 'C1' ? actor.jollity!.session : actor.session, appLog: string[] = [];
  const writingOrigin = new URL(direction === 'C1' ? state.apps.jollity! : state.apps.humanity).origin;
  let tap = Number.POSITIVE_INFINITY, confirmedHandoff = false;
  const logged = (message: { at: number; url: string; text: string }) => {
    if (new URL(message.url).origin !== writingOrigin) return;
    if (message.at >= tap && confirmsRegistrationHandoff(message.text)) confirmedHandoff = true;
    // Only the writing app's sign-up lines, cut short; no other console text is kept.
    if (appLog.length < 20 && /sign-up|sign up|Jollity takes|no host|capabilit|seat|name link/i.test(message.text)) appLog.push(message.text.slice(0, 240));
  };
  state.network.consoleProbes.add(logged);
  const done = new AbortController();
  try {
    await watchDom(reading.page, reading.which);
    // Make sure the reading app does not already show it: the tap is the start.
    if (await readWatchedText(reading.page, reading.which === 'humanity' ? shows.humanityRegistered : shows.jollityRegistered)) throw Error('The reading app shows Ada registered before the tap');
    tap = Date.now();
    if (direction === 'C1') await jollity().getByRole('button', { name: 'Register', exact: true }).click({ timeout: 5_000 });
    else await humanity().getByRole('button', { name: 'Register', exact: true }).click({ timeout: 5_000 });
    const registerClick = { name: 'lab Register click', at: tap, done: Date.now() };
    const [shown, chain] = await Promise.race([
      Promise.all([rendered(reading.page, reading.which, signal), watch.marks(signal, capMs)]),
      handedOff(writing, tap, watch, AbortSignal.any([signal, done.signal]), () => confirmedHandoff),
    ]).catch(async (error: unknown) => {
      // Say which side stopped: the chain (never included), the writing app (its view after the tap) or the reading app.
      const views = { chain: watch.status(), writingAppLog: appLog, startupLog: state.crossAppLog, humanity: await nextGame(humanity()).catch(() => null),
        humanityAlerts: await readWatchedText(humanity(), () => Array.from(document.querySelectorAll('[role="alert"], [role="status"]')).map(e => e.textContent?.trim()).filter(Boolean).slice(0, 5)).catch(() => null),
        jollity: await readRegistrationView(jollity()).catch(() => null), jollityStatus: await readWatchedText(jollity(), shows.jollityStatus).catch(() => null) };
      writeFileSync(join(output(), `failed-${direction}-${run.replace(/[^a-z0-9-]/gi, '_')}.json`),
        JSON.stringify({ direction, run, tap, error: error instanceof Error ? error.message : String(error), ...views }, null, 2) + '\n', { mode: 0o600 });
      throw Error(`${error instanceof Error ? error.message : String(error)}; seen: ${JSON.stringify(views)}`, { cause: error });
    });
    const handoff = probe.first(chain.included - 1_000);
    const value = breakdown({ direction, run, reader: readers[direction], tap, included: chain.included, includedBlock: chain.includedBlock, rendered: shown.at, actions: [registerClick],
      ...(chain.submitted === undefined ? {} : { submitted: chain.submitted }), ...(chain.includedRetracted ? { includedRetracted: true as const } : {}),
      ...(chain.finalized === undefined ? {} : { finalized: chain.finalized, finalizedBlock: chain.finalizedBlock! }),
      ...(handoff === undefined ? {} : { handoff }) });
    assertAddsUp(value);
    const raw = { tap, chain, labActions: [registerClick], rendered: shown, handoffFrames: probe.hits.length, handoff: handoff ?? null, writingAppLog: appLog, startupLog: state.crossAppLog };
    save(value, raw);
    return { breakdown: value, raw };
  } finally { done.abort(); watch.stop(); state.network.frameProbes.delete(probe.listener); state.network.consoleProbes.delete(logged); }
}

step('{actor} registers in Jollity, her host signs, and Humanity shows her registered, C1 run {string}', async ({ lab }, name, run) => {
  ada(name); await lab.attach(await timed('C1', String(run)));
}, { timeoutMs: capMs + 5 * 60_000 });

step("{actor} registers in Humanity, her host signs, and Jollity shows You're in, C2 run {string}", async ({ lab }, name, run) => {
  ada(name); await lab.attach(await timed('C2', String(run)));
}, { timeoutMs: capMs + 5 * 60_000 });
