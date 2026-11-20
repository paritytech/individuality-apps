// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import type { FinalizedExtrinsic } from '@parity/product-lab/ports/chain';
import type { ScenarioChain } from '../shared/chain.ts';
import type { GameParticipant } from '../shared/upstream/lab/steps/games/participant.ts';
import { accountKey } from '../shared/upstream/lab/full-journey/identity.ts';
import { readRegistrationView, registerWhenReady, sentRegistrationClick, type RegistrationInput, type RegistrationView } from '../shared/registration.ts';
import { jsonEvidence } from '../shared/observations.ts';
import { flowStorage } from '../shared/storage.ts';
import { readWatchedText } from '../shared/watched-text.ts';

/** A real media peer of the same step: read beside the one being registered, so a failure names every peer's state. */
export interface MediaPeerView { name: string; account: string; page: BrowserPage }
/** One Game.Players read: which read, which head, the block it looked at and whether the row said registered. */
export interface PlayersRead { read: 'setupRead' | 'read' | 'best head'; head: 'best' | 'finalized'; block: number; hash: string; registered: boolean; at: number }
/**
 * The extrinsic whose Game events name the account, with who sent it. `registration` when its event is Game.SignedUp or
 * its call is a sign-up; otherwise the latest Game event naming the account in the searched window, which may be a later one.
 */
export interface FoundRegistration {
  kind: 'registration' | 'latest Game event naming the account';
  block: number; hash: string; index: number; extrinsic?: string; call: string; signer?: string; sender: string; events: string[];
}
export interface MediaRegistrationEvidence {
  peer: string; order: string; account: string; accountHex: string; failure: string;
  clicks: number; inputs: RegistrationInput[];
  reads: { before: PlayersRead; checks: number; first?: PlayersRead; lastUnregistered?: PlayersRead; found?: PlayersRead };
  registration: { found?: FoundRegistration; searched?: { from: number; to: number }; error?: string };
  peers: Array<{ name: string; account: string; best?: PlayersRead; finalized?: PlayersRead; error?: string; screen: RegistrationView | null | 'unreadable' | 'unread' }>;
  /** Why the diagnosis ended early (its budget, the step's end or an abort); what it had gathered is kept. */
  stopped?: string;
}
/** The one line the thrown message adds to the original failure: where the evidence is. It names no chain, environment or UI word. */
export const mediaRegistrationPointer = 'evidence: media registration, in observations.jsonl and the step attachment';
/**
 * The failure carries its evidence beside the message, never in it: product-lab classifies a failed step by its whole
 * error text, so evidence words ("finalized", "extrinsic", an RPC error's "WebSocket") would change the verdict. The
 * message is the original failure and one neutral pointer; `report` is the readable evidence the step attaches.
 */
export class MediaRegistrationError extends Error {
  readonly report: string[];
  constructor(readonly evidence: MediaRegistrationEvidence, cause?: unknown) {
    super(`${evidence.failure}\n${mediaRegistrationPointer}`, cause === undefined ? undefined : { cause });
    this.report = describeMediaRegistration(evidence).split('\n');
  }
}
/**
 * Records a media registration failure's evidence. Step attachments stay in CI's private report, so the readable lines
 * and the evidence also go to `observations.jsonl` in `CROSS_APP_TIMINGS_DIR`, which the cross-app workflow uploads with
 * every run. Then the step gets the readable lines and the same evidence as JSON. A failed write does not stop the others.
 */
export async function attachMediaRegistrationFailure(attach: (evidence: unknown) => Promise<void>, error: unknown, directory = process.env.CROSS_APP_TIMINGS_DIR) {
  if (!(error instanceof MediaRegistrationError)) return;
  let failed: unknown;
  if (directory) {
    try {
      mkdirSync(directory, { recursive: true });
      appendFileSync(join(directory, 'observations.jsonl'), JSON.stringify(jsonEvidence({ kind: 'media-registration', mediaRegistration: error.report, evidence: error.evidence })) + '\n');
    } catch (write) { failed = write; }
  }
  await attach({ mediaRegistration: error.report });
  await attach(jsonEvidence(error.evidence));
  if (failed !== undefined) throw failed;
}
/** Why recording failed, without local paths: a system error's code and call, or the message with any path taken out. */
export function recordingFailure(error: unknown) {
  const e = error as { code?: unknown; syscall?: unknown; message?: unknown } | null | undefined;
  if (typeof e?.code === 'string') return `${e.code}${typeof e.syscall === 'string' ? ` (${e.syscall})` : ''}`;
  return (typeof e?.message === 'string' ? e.message : String(error)).replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"`,:;()]+){2,}/g, '<path>');
}
/**
 * Runs one media registration. On failure the evidence is recorded best effort and the failure itself is rethrown:
 * a write or attach that fails never replaces it, and leaves one stderr line saying why the evidence is missing.
 */
export async function withMediaRegistrationEvidence<T>(attach: (evidence: unknown) => Promise<void>, register: () => Promise<T>): Promise<T> {
  try { return await register(); }
  catch (error) {
    try { await attachMediaRegistrationFailure(attach, error); }
    catch (failure) { console.warn('media registration evidence not recorded:', recordingFailure(failure)); }
    throw error;
  }
}

const players = (account: string) => [{ type: 'Account', value: account }];
const registeredRow = (value: unknown) => Boolean((value as { registered?: boolean } | undefined)?.registered);
const hexOf = (account: string) => { try { return accountKey(account); } catch { return 'unreadable'; } };
const sameAccount = (a: string, b: string) => a === b || (hexOf(a) !== 'unreadable' && hexOf(a) === hexOf(b));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Blocks searched back from the registered read; a local copy authors one every six seconds. */
export const registrationSearchBlocks = 200;
/** The whole diagnosis, capped again by the step's own end; and each read inside it, as product-lab's pause inspection does. */
export const diagnosisMs = 30_000, diagnosisReadMs = 5_000;
/** Time kept between the diagnosis and the step's own timeout, so the step fails on its own error. */
export const diagnosisMarginMs = 3_000;

/** Ends every read once the run aborts or the budget runs out. */
class DiagnosisStopped extends Error {}
/** A timer that resolves after `ms`, or never once `cancel` aborts; it never rejects, so a settled race leaves nothing behind. */
const timer = (ms: number, cancel: AbortSignal) => new Promise<void>(resolve => {
  const id = setTimeout(resolve, ms);
  cancel.addEventListener('abort', () => clearTimeout(id), { once: true });
});
type BoundedRead = <T>(what: string, work: () => Promise<T>) => Promise<T>;
/** One budget for a diagnosis: each read races a timer and the run's abort, and none starts after either ends it. */
export function diagnosisBudget(signal: AbortSignal, ms: number, name = `its ${ms} ms budget`, readMs = diagnosisReadMs) {
  const ends = Date.now() + ms;
  const state: { stopped?: string } = {};
  const stop = (why: string) => { state.stopped ??= why; return new DiagnosisStopped(`diagnosis stopped: ${state.stopped}`); };
  const read: BoundedRead = async (what, work) => {
    if (state.stopped) throw stop(state.stopped);
    if (signal.aborted) throw stop('the run was aborted');
    const left = ends - Date.now();
    if (left <= 0) throw stop(`${name} ran out before ${what}`);
    const done = new AbortController();
    try {
      return await Promise.race([
        work(),
        timer(Math.min(readMs, left), done.signal).then(() => {
          throw left <= readMs ? stop(`${name} ran out during ${what}`) : new Error(`${what} took longer than ${readMs} ms`);
        }),
        new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(stop('the run was aborted')), { once: true, signal: done.signal })),
      ]);
    } finally { done.abort(); }
  };
  return { read, state };
}

async function playersRead(chain: ScenarioChain, account: string, read: 'setupRead' | 'read'): Promise<PlayersRead> {
  const row = await chain[read]('Game', 'Players', players(account));
  return { read, head: read === 'setupRead' && chain.fast ? 'best' : 'finalized', block: row.at.number, hash: row.at.hash, registered: registeredRow(row.value), at: Date.now() };
}
async function bestRead(chain: ScenarioChain, account: string): Promise<PlayersRead> {
  const at = await chain.people.access.bestHead();
  const value = await flowStorage(chain.people.access, 'Game', 'Players', players(account), at.hash);
  return { read: 'best head', head: 'best', block: at.number, hash: at.hash, registered: registeredRow(value), at: Date.now() };
}

/** Who sent the registration, in the words the failure needs: the account, the lab's root authority, a peer, or no signer. */
export function registrationSender(entry: Pick<FinalizedExtrinsic, 'signer' | 'resourceClaim' | 'chainOrigin'> | undefined, account: string, authority: string, peers: readonly { name: string; account: string }[]) {
  if (!entry) return 'unknown: the extrinsic did not decode';
  const signer = entry.signer;
  if (signer) {
    if (sameAccount(signer, account)) return 'the account itself (signed with its own key)';
    if (sameAccount(signer, authority)) return "the lab's root authority (a lab setup transaction)";
    const peer = peers.find(p => sameAccount(p.account, signer));
    return peer ? `${peer.name}'s account` : `another account ${signer}`;
  }
  if (entry.resourceClaim) return `no signer: resource claim ${entry.resourceClaim.extension} for ${entry.resourceClaim.beneficiary ?? 'no named beneficiary'}`;
  return entry.chainOrigin ? `chain origin ${entry.chainOrigin}` : 'no signer';
}
/** This runtime's Game pallet emits SignedUp on every sign-up call. */
const registrationEvent = /^Game\.SignedUp$/;
/**
 * A Game sign-up call, directly or inside a Utility batch. The call decodes even when the extrinsic is `partial` (unsigned,
 * or authorized by an extension the lab does not read), so only the call and, for a batch, its arguments are needed.
 */
export function signUpCall(entry: Pick<FinalizedExtrinsic, 'call' | 'callArguments'> | undefined) {
  if (!entry?.call) return false;
  const contains = (pallet: string, name: string, args: unknown, depth: number): boolean => {
    if (pallet === 'Game') return /^sign_up/.test(name);
    const calls = (args as { calls?: Array<{ type?: string; value?: { type?: string; value?: unknown } }> } | undefined)?.calls;
    return depth < 4 && pallet === 'Utility' && /^(batch|batch_all|force_batch)$/.test(name) && Array.isArray(calls) &&
      calls.some(call => typeof call.type === 'string' && typeof call.value?.type === 'string' && contains(call.type, call.value.type, call.value.value, depth + 1));
  };
  return contains(entry.call.pallet, entry.call.name, entry.callArguments, 0);
}

/**
 * Search back from `to` for the extrinsic whose Game events name the account, preferring one whose event or call says
 * sign-up. Read-only; each read goes through `read`, so a stalled node or an abort ends the search. The latest other
 * Game event found so far stays in `progress`, so a search that is stopped still reports it.
 */
export async function findRegistration(chain: ScenarioChain, account: string, from: number, to: number,
  peers: readonly { name: string; account: string }[], read: BoundedRead, progress: { latest?: FoundRegistration } = {}): Promise<FoundRegistration | undefined> {
  const access = chain.people.access;
  for (let number = to; number >= Math.max(from, to - registrationSearchBlocks + 1, 0); number--) {
    const block = await read(`reading block #${number}`, () => access.blockAt(number)); if (!block) continue;
    const events = (await read(`reading the events of block #${number}`, () => access.blockEvents(block.hash, [account])) ?? [])
      .filter(e => e.pallet === 'Game' && e.accounts.length && e.extrinsic !== undefined);
    if (!events.length) continue;
    const entries = await read(`reading the extrinsics of block #${number}`, () => access.extrinsics(block.hash, { includeCallArguments: true })) ?? [];
    for (const index of [...new Set(events.map(e => e.extrinsic!))]) {
      const entry = entries.find(e => e.index === index), names = events.filter(e => e.extrinsic === index).map(e => `${e.pallet}.${e.name}`);
      const found: FoundRegistration = { kind: names.some(n => registrationEvent.test(n)) || signUpCall(entry) ? 'registration' : 'latest Game event naming the account',
        block: number, hash: block.hash, index, extrinsic: entry?.hash, call: entry?.call ? `${entry.call.pallet}.${entry.call.name}` : 'undecoded call',
        signer: entry?.signer, sender: registrationSender(entry, account, chain.authority.address, peers), events: names };
      if (found.kind === 'registration') return found;
      progress.latest ??= found;
    }
  }
  return progress.latest;
}

const block = (r: PlayersRead | undefined) => r ? `${r.read} ${r.head} #${r.block} ${r.hash} registered=${r.registered}` : 'none';
const screen = (s: RegistrationView | null | 'unreadable' | 'unread') => s === 'unreadable' || s === 'unread' ? s : s === null ? 'document being replaced'
  : `${s.path} [${s.buttons.map(b => `${b.name}${b.disabled ? ' (disabled)' : ''}`).join(', ') || 'no registration control'}]`;
const input = (i: RegistrationInput, start: number) => `${i.control} ${i.sent}${i.reason ? ` (${i.reason})` : ''} at +${((i.at - start) / 1000).toFixed(1)} s on ${screen(i.view)}`;
const extrinsic = (f: FoundRegistration) => `${f.call} in block #${f.block} ${f.hash}, extrinsic ${f.index}${f.extrinsic ? ` ${f.extrinsic}` : ''}, events ${f.events.join(', ')}; sender: ${f.sender}`;
/**
 * The readable evidence, the original failure first: the account, the registration and its sender, every read, the
 * clicks and the screens. It is attached to the step, never thrown: its words would change the failure's classification.
 */
export function describeMediaRegistration(e: MediaRegistrationEvidence) {
  const found = e.registration.found, searched = e.registration.searched, start = e.reads.before.at;
  const window = searched ? `#${searched.from}..#${searched.to}` : 'no window';
  return [
    e.failure,
    `${e.peer}, ${e.order}, account ${e.account} (${e.accountHex}); registration clicks sent: ${e.clicks}`,
    found?.kind === 'registration' ? `registration: ${extrinsic(found)}`
      : found ? `latest Game event naming the account (${e.registration.error
        ? `the search of ${window} ended before a registration event or sign-up call: ${e.registration.error}`
        : `no registration event or sign-up call in ${window}`}): ${extrinsic(found)}`
        : e.registration.error ? `registration: search failed in ${window}: ${e.registration.error}`
          : searched ? `registration: no Game event names this account in ${window}` : 'registration: not searched: no registered read',
    `reads: before ${block(e.reads.before)}; checks ${e.reads.checks}: first ${block(e.reads.first)}; last unregistered ${block(e.reads.lastUnregistered)}; registered ${block(e.reads.found)}`,
    `peers now: ${e.peers.map(p => `${p.name} best ${p.best ? `#${p.best.block} registered=${p.best.registered}` : 'unread'}, finalized ${p.finalized ? `#${p.finalized.block} registered=${p.finalized.registered}` : 'unread'}${p.error ? ` (${p.error})` : ''}, screen ${screen(p.screen)}`).join('; ')}`,
    `inputs: ${e.inputs.length ? e.inputs.map(i => input(i, start)).join('; ') : 'none'}`,
    ...e.stopped ? [`diagnosis stopped: ${e.stopped}`] : [],
  ].join('\n');
}

/** Never throws, never outlasts its budget, and never passes an abort on: what it gathered is returned, with why it stopped. */
async function diagnose(chain: ScenarioChain, player: GameParticipant, page: BrowserPage, peers: readonly MediaPeerView[], failure: string,
  inputs: RegistrationInput[], reads: MediaRegistrationEvidence['reads'], endsAt: number): Promise<MediaRegistrationEvidence> {
  const everyone = peers.some(p => sameAccount(p.account, player.address)) ? peers : [{ name: player.name, account: player.address, page }, ...peers];
  const position = everyone.findIndex(p => sameAccount(p.account, player.address));
  const evidence: MediaRegistrationEvidence = { peer: player.name, order: everyone.length > 1 ? `peer ${position + 1} of ${everyone.length}` : 'only peer',
    account: player.address, accountHex: hexOf(player.address), failure, clicks: inputs.filter(sentRegistrationClick).length,
    inputs, reads, registration: {}, peers: everyone.map(p => ({ name: p.name, account: p.account, screen: 'unread' as const })) };
  const stepLeft = Math.max(0, Math.floor(endsAt - diagnosisMarginMs - Date.now()));
  const budget = stepLeft < diagnosisMs ? diagnosisBudget(chain.people.signal, stepLeft, `the step's remaining ${stepLeft} ms`)
    : diagnosisBudget(chain.people.signal, diagnosisMs);
  const search = async () => {
    const registered = reads.found ?? (reads.before.registered ? reads.before : undefined);
    if (!registered) return;
    // The before-read may be a best block ahead of the finalized block the registration was found at: search past it then.
    const unregistered = reads.lastUnregistered?.block ?? (reads.before.registered ? undefined : reads.before.block);
    const floor = Math.max(registered.block - registrationSearchBlocks + 1, 0);
    const searched = { from: unregistered !== undefined && unregistered < registered.block ? Math.max(floor, unregistered + 1) : floor, to: registered.block };
    evidence.registration.searched = searched;
    const progress: { latest?: FoundRegistration } = {};
    try { evidence.registration.found = await findRegistration(chain, player.address, searched.from, searched.to, everyone, budget.read, progress); }
    catch (error) { evidence.registration.found = progress.latest; evidence.registration.error = message(error); }
  };
  try {
    // The peers' rows and screens are read alongside the search, so a slow search cannot leave them unread.
    await Promise.all([search(), ...everyone.map(async (p, n) => {
      const state = evidence.peers[n]!;
      try {
        state.best = await budget.read(`reading ${p.name}'s best row`, () => bestRead(chain, p.account));
        state.finalized = await budget.read(`reading ${p.name}'s finalized row`, () => playersRead(chain, p.account, 'read'));
      } catch (error) { state.error = message(error); }
      try { state.screen = await budget.read(`reading ${p.name}'s screen`, () => readRegistrationView(p.page)); }
      catch (error) { state.screen = error instanceof DiagnosisStopped ? 'unread' : 'unreadable'; }
    })]);
  } catch (error) { budget.state.stopped ??= message(error); }
  if (budget.state.stopped) evidence.stopped = budget.state.stopped;
  return evidence;
}

/** The real app must generate and retain the communication key it registers; a synthetic transaction key cannot signal. */
export async function registerMediaPlayer(page: BrowserPage, player: GameParticipant, chain: ScenarioChain, peers: readonly MediaPeerView[] = [],
  options: { endsAt?: number } = {}) {
  const inputs: RegistrationInput[] = [];
  const reads: MediaRegistrationEvidence['reads'] = { before: await playersRead(chain, player.address, 'setupRead'), checks: 0 };
  const endsAt = options.endsAt ?? Number.POSITIVE_INFINITY;
  const fail = async (failure: string, cause?: unknown) =>
    new MediaRegistrationError(await diagnose(chain, player, page, peers, failure, inputs, reads, endsAt), cause);
  // Every failure of this step carries the evidence beside its own message; a run that is stopping passes its abort on.
  const wrap = async (error: unknown) => chain.people.signal.aborted || error instanceof MediaRegistrationError ? error : fail(message(error), error);
  if (reads.before.registered) throw await fail('Media player was registered before the UI action');
  let proof: PlayersRead;
  try {
    proof = await registerWhenReady(page, { actor: player.name, signal: chain.people.signal,
      check: async () => {
        const text = await readWatchedText(page, () => document.body.innerText);
        if (/A new version is out/i.test(text ?? '')) throw Error('Update screen: stop without interacting');
      },
      beforeClick: async () => {}, attach: async () => {}, input: sent => { inputs.push(sent); },
      registered: async () => {
        const row = await playersRead(chain, player.address, 'read');
        reads.checks++; reads.first ??= row;
        if (!row.registered) { reads.lastUnregistered = row; return undefined; }
        reads.found = row; return row;
      },
    });
  } catch (error) { throw await wrap(error); }
  const clicks = inputs.filter(sentRegistrationClick).length;
  if (clicks !== 1) throw await fail('Media player registration needs exactly one real UI click');
  try {
    await chain.until(`${player.name} Jollity registered seat`, async () =>
      await readWatchedText(page, () => document.querySelector('[data-testid="home-status"]')?.textContent?.trim() === "You're in") ? true : undefined);
  } catch (error) { throw await wrap(error); }
  return { name: player.name, account: player.address, uiClicks: clicks, finalized: { hash: proof.hash, number: proof.block }, inputs, reads };
}
