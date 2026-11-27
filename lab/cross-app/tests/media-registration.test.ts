// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
/** The media peer registration check counts only clicks the page may have received, and its failure names the cause:
 * the account, the registration and its sender, every read with its head and block, the clicks and each page's screen.
 * The diagnosis is bounded and never hides the original failure. The thrown message is that failure and one neutral
 * pointer, so product-lab classifies it as it would the failure alone; the evidence is attached beside it. */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { Sr25519KeyDerivation } from '@parity/product-lab/keys-sr25519';
import { classifyFailure } from '@parity/product-lab/application';
import { MediaRegistrationError, attachMediaRegistrationFailure, diagnosisBudget, diagnosisMarginMs, diagnosisMs, diagnosisReadMs, mediaRegistrationPointer, registerMediaPlayer, registrationSender, recordingFailure, signUpCall, withMediaRegistrationEvidence } from '../media-registration.ts';
import { sentRegistrationClick, type RegistrationInput } from '../../shared/registration.ts';

// Pass-through by default; one test replaces the helper to report two sent clicks.
const helper = vi.hoisted(() => ({ fake: undefined as undefined | ((options: { input?: (i: unknown) => void; registered: () => Promise<unknown> }) => Promise<unknown>) }));
vi.mock('../../shared/registration.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../../shared/registration.ts')>();
  return { ...real, registerWhenReady: (page: BrowserPage, options: Parameters<typeof real.registerWhenReady>[1]) =>
    helper.fake ? helper.fake(options as never) : real.registerWhenReady(page, options) };
});

const keys = new Sr25519KeyDerivation();
const [lab1, lab2, authority, stranger] = ['Bob', 'Charlie', 'Alice', 'Dave'].map(name => keys.derive('//' + name).address) as [string, string, string, string];
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

beforeEach(() => {
  // No test writes CI evidence unless it sets its own folder.
  vi.stubEnv('CROSS_APP_TIMINGS_DIR', '');
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  Object.defineProperty(document.body, 'innerText', { configurable: true, get() { return this.textContent; } });
  window.history.replaceState(null, '', '/'); document.body.innerHTML = '';
});
afterEach(() => { helper.fake = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const home = (button: string, disabled = false, status = 'Next game', extra = '') => {
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = `${extra}<span data-testid="home-status">${status}</span><button ${disabled ? 'disabled' : ''}>${button}</button>`;
};
const permissions = () => { window.history.replaceState(null, '', '/permissions'); document.body.innerHTML = '<p>Camera &amp; connection</p><button>Allow access</button>'; };
/** Both pages share the one jsdom document; the other peer's page reports a fixed screen. */
function pageOf(clicks: string[], onClick: (name: string) => void = () => {}) {
  return { evaluate: async (read: () => unknown) => new Function(`return (${read.toString()})()`)(),
    getByRole: vi.fn((_role: string, options: { name: string }) => ({ click: async () => { clicks.push(options.name); onClick(options.name); } })) } as unknown as BrowserPage;
}
const otherPage = { evaluate: async () => ({ path: '/permissions', nativePasRequested: false, buttons: [{ name: 'Allow access', disabled: false }] }) } as unknown as BrowserPage;
const never = () => new Promise<never>(() => {});

type BlockScript = { event?: string; call?: { pallet: string; name: string }; callArguments?: unknown; signer?: string; resourceClaim?: { extension: string; claim: string; beneficiary?: string } };
/**
 * A chain whose heads move one block per finalized read. `registered(account, read)` decides each row; `blocks` holds the
 * blocks whose Game events name the account. Block reads can stall (all, or those below a block), fail with an RPC
 * error, or each take `blockDelayMs`; `stalled.all` stalls every diagnostic read.
 */
function chainFor(options: { registered: (account: string, read: number) => boolean; blocks?: Record<number, BlockScript>;
  stalled?: { blockAt?: boolean; blocksBelow?: number; all?: boolean }; failing?: string; blockDelayMs?: number; signal?: AbortSignal }) {
  let reads = 0;
  const head = { best: { number: 105, hash: hash(105) }, finalized: { number: 100, hash: hash(100) } };
  const at = (blockHash: string) => Object.entries(options.blocks ?? {}).find(([n]) => hash(Number(n)) === blockHash)?.[1];
  const stall = <T,>(value: () => T) => options.stalled?.all ? never() : Promise.resolve(value());
  const block = (number: number) => options.stalled?.all || options.stalled?.blockAt || number < (options.stalled?.blocksBelow ?? -1) ? never()
    : options.failing ? Promise.reject(new Error(options.failing))
      : options.blockDelayMs ? new Promise<{ number: number; hash: string }>(resolve => setTimeout(() => resolve({ number, hash: hash(number) }), options.blockDelayMs))
        : Promise.resolve({ number, hash: hash(number) });
  const access = {
    bestHead: () => stall(() => head.best), finalizedHead: () => stall(() => head.finalized),
    historicalStorage: (_pallet: string, _item: string, key: Array<{ value: string }>) => stall(() => ({ registered: options.registered(key[0]!.value, reads) })),
    blockAt: block,
    blockEvents: (blockHash: string, accounts: string[]) => stall(() => { const b = at(blockHash); return b
      ? [{ phase: 'ApplyExtrinsic', extrinsic: 2, pallet: 'Game', name: b.event ?? 'SignedUp', value: {}, accounts }, { phase: 'ApplyExtrinsic', extrinsic: 2, pallet: 'System', name: 'ExtrinsicSuccess', value: {}, accounts: [] }] : []; }),
    extrinsics: (blockHash: string) => stall(() => { const b = at(blockHash); return b
      ? [{ index: 2, hash: hash(0xabc), signer: b.signer, resourceClaim: b.resourceClaim, call: b.call ?? { pallet: 'Game', name: 'sign_up_with_account' }, callArguments: b.callArguments, decoded: 'complete' }] : []; }),
  };
  const row = async (atBlock: { number: number; hash: string }, account: string) => ({ at: atBlock, value: await access.historicalStorage('Game', 'Players', [{ value: account }]) });
  return { fast: true, authority: { address: authority }, people: { signal: options.signal ?? new AbortController().signal, access },
    setupRead: async (_p: string, _i: string, key: Array<{ value: string }>) => row(head.best, key[0]!.value),
    read: async (_p: string, _i: string, key: Array<{ value: string }>) => { reads++; head.finalized = { number: 100 + reads, hash: hash(100 + reads) }; head.best = { number: 105 + reads, hash: hash(105 + reads) }; return row(head.finalized, key[0]!.value); },
    until: async <T,>(label: string, read: () => Promise<T | undefined>) => { for (let i = 0; i < 20; i++) { const value = await read(); if (value !== undefined) return value; } throw Error(`Timed out: ${label}`); } };
}
const peers = (page: BrowserPage) => [{ name: 'Lab1', account: lab1, page }, { name: 'Lab2', account: lab2, page: otherPage }];
const player = { name: 'Lab1', address: lab1 } as never;
const settle = (task: Promise<unknown>) => task.then(() => undefined, (e: unknown) => e);
/** The readable evidence the step attaches. */
const text = (error: MediaRegistrationError) => error.report.join('\n');
/** The "registration no click caused" setup: Lab1's row is registered at the first check, on a permission screen. */
const noClick = (extra: Partial<Parameters<typeof chainFor>[0]> = {}) => {
  permissions();
  return chainFor({ registered: (account, read) => account === lab1 && read >= 1, blocks: { 101: { signer: authority } }, ...extra });
};

it('replays #1961 B2 attempt 2: an attempt withheld after the view changed, then one real click, passes with one click', async () => {
  const clicks: string[] = []; let proven = false;
  home('Register');
  const page = pageOf(clicks, () => { proven = true; home('Saving your seat…', true); });
  // The view changes between the lab's first look and its re-check (read 2), then the control comes back (read 3).
  const chain = chainFor({ registered: (account, read) => {
    if (read === 2) home('Register', true); if (read === 3) home('Register');
    if (proven && account === lab1 && read >= 6) { home('Saving your seat…', true, "You're in"); return true; }
    return false;
  } });
  const task = registerMediaPlayer(page, player, chain as never, peers(page));
  await vi.advanceTimersByTimeAsync(2_000);
  const result = await task;
  expect(clicks).toEqual(['Register']);
  expect(result.uiClicks).toBe(1);
  expect(result.inputs.map(i => [i.control, i.sent, i.reason])).toEqual([['Register', 'withheld', 'view changed before the click'], ['Register', 'clicked', undefined]]);
  // The counter that failed #1961 counted both attempts: two, for one real click.
  expect(result.inputs.filter(i => i.control === 'Register')).toHaveLength(2);
  expect(result.finalized.number).toBe(result.reads.found!.block);
});

it('passes the permission click and one Register click, and records both inputs with their screens', async () => {
  const clicks: string[] = []; let proven = false; permissions();
  const page = pageOf(clicks, name => { if (name === 'Allow access') home('Register'); else { proven = true; home('Saving your seat…', true, "You're in"); } });
  const chain = chainFor({ registered: () => proven });
  const task = registerMediaPlayer(page, player, chain as never, peers(page)); await vi.advanceTimersByTimeAsync(2_000);
  const result = await task;
  expect(clicks).toEqual(['Allow access', 'Register']); expect(result.uiClicks).toBe(1);
  expect(result.inputs.map(i => `${i.control} ${i.sent} ${i.view?.path}`)).toEqual(['Allow access clicked /permissions', 'Register clicked /']);
});

it('@negative-control: a registration no click caused fails on its own message, and its evidence names the account, the registration, its sender, every read and both screens', async () => {
  const clicks: string[] = [], page = pageOf(clicks);
  const error = await settle(registerMediaPlayer(page, player, noClick() as never, peers(page))) as MediaRegistrationError;
  expect(error).toBeInstanceOf(MediaRegistrationError);
  expect(error.message).toBe(`Media player registration needs exactly one real UI click\n${mediaRegistrationPointer}`);
  const lines = error.report;
  expect(lines[0]).toBe('Media player registration needs exactly one real UI click');
  expect(lines[1]).toBe(`Lab1, peer 1 of 2, account ${lab1} (${error.evidence.accountHex}); registration clicks sent: 0`);
  expect(error.evidence.accountHex).toMatch(/^0x[0-9a-f]{64}$/);
  expect(lines[2]).toBe(`registration: Game.sign_up_with_account in block #101 ${hash(101)}, extrinsic 2 ${hash(0xabc)}, events Game.SignedUp; sender: the lab's root authority (a lab setup transaction)`);
  expect(text(error)).toContain(`reads: before setupRead best #105 ${hash(105)} registered=false; checks 1: first read finalized #101 ${hash(101)} registered=true; last unregistered none; registered read finalized #101`);
  expect(text(error)).toMatch(/peers now: Lab1 best #\d+ registered=true, finalized #\d+ registered=true, screen \/permissions \[Allow access\]; Lab2 best #\d+ registered=false, finalized #\d+ registered=false, screen \/permissions \[Allow access\]/);
  expect(text(error)).toContain('inputs: none');
  expect(text(error)).not.toContain('diagnosis stopped');
  expect(clicks).toEqual([]);
});

it('@negative-control: a row already registered before the UI action names who registered it', async () => {
  home('Register');
  const chain = chainFor({ registered: account => account === lab1, blocks: { 104: { signer: lab1 } } });
  const error = await settle(registerMediaPlayer(pageOf([]), player, chain as never, peers(pageOf([])))) as MediaRegistrationError;
  expect(error.message.split('\n')[0]).toBe('Media player was registered before the UI action');
  expect(text(error)).toContain('registration: Game.sign_up_with_account in block #104');
  expect(text(error)).toContain('sender: the account itself (signed with its own key)');
  expect(error.evidence.reads.before).toMatchObject({ read: 'setupRead', head: 'best', registered: true });
});

it('prefers the registration over a later Game event, and words a non-registration event as the latest Game event', async () => {
  home('Register');
  const chain = chainFor({ registered: account => account === lab1, blocks: { 104: { event: 'Reported', call: { pallet: 'Game', name: 'report' }, signer: lab1 }, 90: { signer: lab1 } } });
  const found = await settle(registerMediaPlayer(pageOf([]), player, chain as never)) as MediaRegistrationError;
  expect(text(found)).toContain('registration: Game.sign_up_with_account in block #90');
  const later = chainFor({ registered: account => account === lab1, blocks: { 104: { event: 'Reported', call: { pallet: 'Game', name: 'report' }, signer: lab1 } } });
  const latest = await settle(registerMediaPlayer(pageOf([]), player, later as never)) as MediaRegistrationError;
  expect(text(latest)).toContain(`latest Game event naming the account (no registration event or sign-up call in #0..#105): Game.report in block #104 ${hash(104)}`);
  expect(text(latest)).not.toMatch(/^registration:/m);
});

it('@negative-control: a permission gate that never completes times out with the inputs and screens, its own message first', async () => {
  const clicks: string[] = []; permissions();
  const page = pageOf(clicks);
  const failure = settle(registerMediaPlayer(page, player, chainFor({ registered: () => false }) as never, peers(page)));
  await vi.advanceTimersByTimeAsync(181_000);
  const error = await failure as MediaRegistrationError;
  expect(error).toBeInstanceOf(MediaRegistrationError);
  expect(error.message.split('\n')[0]).toBe('Lab1: DIM2 registration timed out after 180000 ms: permission click attempted; permission gate has not completed');
  expect(text(error)).toContain('registration: not searched: no registered read');
  expect(text(error)).toContain('inputs: Allow access clicked at +0.0 s on /permissions [Allow access]');
  expect(clicks).toEqual(['Allow access']);
});

it('@negative-control: two sent registration clicks fail with "registration clicks sent: 2"', async () => {
  home('Register');
  helper.fake = async options => {
    for (let n = 0; n < 2; n++) options.input?.({ control: 'Register', at: Date.now(), sent: 'clicked', view: null });
    return options.registered();
  };
  const chain = chainFor({ registered: (account, read) => account === lab1 && read >= 1, blocks: { 101: { signer: lab1 } } });
  const error = await settle(registerMediaPlayer(pageOf([]), player, chain as never, peers(pageOf([])))) as MediaRegistrationError;
  expect(error.message.split('\n')[0]).toBe('Media player registration needs exactly one real UI click');
  expect(error.report[1]).toContain('registration clicks sent: 2');
  expect(error.evidence.clicks).toBe(2);
});

it.each([
  ['native PAS requested', () => home('Register', false, 'Next game', '<p>deposit required</p>'), 'Lab1: Native PAS was requested', 0],
  ['the update screen', () => home('Register', false, 'Next game', '<p>A new version is out</p>'), 'Update screen: stop without interacting', 0],
  ['a non-race click error', () => home('Register'), 'Target page has been closed', 1],
] as const)('@negative-control: %s fails with the same evidence, its own message first', async (_name, screenSetup, first, clicks) => {
  screenSetup();
  const page = pageOf([], () => { throw new Error('Target page has been closed'); });
  const error = await settle(registerMediaPlayer(page, player, chainFor({ registered: () => false }) as never, peers(page))) as MediaRegistrationError;
  expect(error).toBeInstanceOf(MediaRegistrationError);
  expect(error.message.split('\n')[0]).toBe(first);
  expect(error.report[1]).toBe(`Lab1, peer 1 of 2, account ${lab1} (${error.evidence.accountHex}); registration clicks sent: ${clicks}`);
  expect(text(error)).toMatch(/peers now: Lab1 best #\d+ registered=false, finalized #\d+ registered=false, screen \/ \[Register\]; Lab2 .*screen \/permissions \[Allow access\]/);
  expect((error as Error & { cause?: Error }).cause?.message).toBe(first);
});

it('@negative-control: a check() failure and a seat that never shows fail with the same evidence, their own message first', async () => {
  home('Register');
  const broken = { ...pageOf([]), evaluate: async (read: () => unknown) => {
    if (read.toString().includes('document.body.innerText')) throw new Error('page.evaluate: Target crashed');
    return new Function(`return (${read.toString()})()`)();
  } } as unknown as BrowserPage;
  const checkError = await settle(registerMediaPlayer(broken, player, chainFor({ registered: () => false }) as never, peers(broken))) as MediaRegistrationError;
  expect(checkError.message.split('\n')[0]).toBe('page.evaluate: Target crashed');
  expect(text(checkError)).toContain('registration clicks sent: 0');
  // One real click and a finalized row, but the page never says "You're in".
  let proven = false; home('Register');
  const page = pageOf([], () => { proven = true; home('Saving your seat…', true); });
  // Check 1 (#101) and the re-check (#102) are unregistered; the click lands; check 3 (#103) finds the row.
  const task = settle(registerMediaPlayer(page, player, chainFor({ registered: account => proven && account === lab1, blocks: { 103: { signer: lab1 } } }) as never, peers(page)));
  await vi.advanceTimersByTimeAsync(2_000);
  const seat = await task as MediaRegistrationError;
  expect(seat.message.split('\n')[0]).toBe('Timed out: Lab1 Jollity registered seat');
  expect(text(seat)).toContain('registration clicks sent: 1');
  expect(text(seat)).toContain(`registration: Game.sign_up_with_account in block #103 ${hash(103)}, extrinsic 2 ${hash(0xabc)}, events Game.SignedUp; sender: the account itself (signed with its own key)`);
  expect(text(seat)).toContain('last unregistered read finalized #102');
});

it('@negative-control: a block read that never answers still yields the original failure within the diagnosis budget', async () => {
  const page = pageOf([]);
  const task = settle(registerMediaPlayer(page, player, noClick({ stalled: { blockAt: true } }) as never, peers(page)));
  const started = Date.now();
  await vi.advanceTimersByTimeAsync(diagnosisReadMs + 100);
  const error = await task as MediaRegistrationError;
  expect(error).toBeInstanceOf(MediaRegistrationError);
  expect(Date.now() - started).toBeLessThanOrEqual(diagnosisMs);
  expect(error.message.split('\n')[0]).toBe('Media player registration needs exactly one real UI click');
  expect(text(error)).toContain(`registration: search failed in #0..#101: reading block #101 took longer than ${diagnosisReadMs} ms`);
  expect(text(error)).toMatch(/peers now: Lab1 best #\d+ registered=true/);
});

it('@negative-control: an abort during the search still yields the original failure, not the abort', async () => {
  const run = new AbortController(), page = pageOf([]);
  const task = settle(registerMediaPlayer(page, player, noClick({ stalled: { blockAt: true }, signal: run.signal }) as never, peers(page)));
  await vi.advanceTimersByTimeAsync(1_000); run.abort(new Error('step timed out'));
  await vi.advanceTimersByTimeAsync(0);
  const error = await task as MediaRegistrationError;
  expect(error).toBeInstanceOf(MediaRegistrationError);
  expect(error.message.split('\n')[0]).toBe('Media player registration needs exactly one real UI click');
  expect(error.message).toBe(`Media player registration needs exactly one real UI click\n${mediaRegistrationPointer}`);
  expect(text(error)).toContain('registration: search failed in #0..#101: diagnosis stopped: the run was aborted');
  // The peers were read alongside the search, before the abort.
  expect(text(error)).toMatch(/peers now: Lab1 best #\d+ registered=true, finalized #\d+ registered=true, screen \/permissions \[Allow access\]; Lab2 best #\d+ registered=false/);
  expect(error.report.at(-1)).toBe('diagnosis stopped: the run was aborted');
  expect(text(error)).not.toContain('step timed out');
});

it("@negative-control: a step near its end stops the diagnosis before the step's own timeout and still yields the original failure", async () => {
  // The step has 2 s left before its margin: less than one read's bound, so the step's end stops the stalled block read.
  const page = pageOf([]), stepLeft = 2_000;
  const task = settle(registerMediaPlayer(page, player, noClick({ stalled: { blockAt: true } }) as never, peers(page), { endsAt: Date.now() + stepLeft + diagnosisMarginMs }));
  const started = Date.now();
  await vi.advanceTimersByTimeAsync(stepLeft + 100);
  const error = await task as MediaRegistrationError;
  expect(error).toBeInstanceOf(MediaRegistrationError);
  expect(Date.now() - started).toBeLessThanOrEqual(stepLeft + 100);
  expect(error.message.split('\n')[0]).toBe('Media player registration needs exactly one real UI click');
  const why = `the step's remaining ${stepLeft} ms ran out during reading block #101`;
  expect(text(error)).toContain(`registration: search failed in #0..#101: diagnosis stopped: ${why}`);
  expect(text(error)).toMatch(/peers now: Lab1 best #\d+ registered=true, finalized #\d+ registered=true, screen \/permissions/);
  expect(error.report.at(-1)).toBe(`diagnosis stopped: ${why}`);
});

it('@negative-control: a run that is stopping passes its abort on unwrapped', async () => {
  const run = new AbortController(); home('Register', true);
  const task = settle(registerMediaPlayer(pageOf([]), player, chainFor({ registered: () => false, signal: run.signal }) as never, peers(pageOf([]))));
  await vi.advanceTimersByTimeAsync(1_000); run.abort(new Error('step timed out')); await vi.advanceTimersByTimeAsync(500);
  const error = await task as Error;
  // The helper's wait ends on the abort; the step's runner reports the stop, not a registration failure.
  expect(error).not.toBeInstanceOf(MediaRegistrationError);
  expect(error.name).toBe('AbortError');
});

it('bounds each diagnostic read, the whole budget and an abort', async () => {
  const run = new AbortController(), budget = diagnosisBudget(run.signal, diagnosisMs);
  const slow = settle(budget.read('a stalled read', never)); await vi.advanceTimersByTimeAsync(diagnosisReadMs);
  expect(String(await slow)).toBe(`Error: a stalled read took longer than ${diagnosisReadMs} ms`); expect(budget.state.stopped).toBeUndefined();
  // Reads that each take 4 s use up the rest of the 30 s budget; the read that would cross it stops the diagnosis.
  const outcomes: string[] = [];
  for (let n = 0; n < 8; n++) {
    const task = budget.read(`read ${n}`, () => new Promise(resolve => setTimeout(() => resolve('ok'), 4_000))).then(String, String);
    await vi.advanceTimersByTimeAsync(4_000); outcomes.push(String(await task));
  }
  expect(outcomes.slice(0, 6)).toEqual(Array(6).fill('ok'));
  expect(outcomes.at(-1)).toContain(`diagnosis stopped: its ${diagnosisMs} ms budget ran out`);
  expect(String(await settle(budget.read('after', async () => 'late')))).toContain('diagnosis stopped');
  const aborted = diagnosisBudget(run.signal, diagnosisMs), pending = settle(aborted.read('a read', never));
  run.abort(); await vi.advanceTimersByTimeAsync(0);
  expect(String(await pending)).toBe('Error: diagnosis stopped: the run was aborted');
});

it('names the sender of a registration in plain words, and finds a sign-up call inside a batch', () => {
  const others = [{ name: 'Lab1', account: lab1 }, { name: 'Lab2', account: lab2 }];
  expect(registrationSender({ signer: lab2 }, lab2, authority, others)).toBe('the account itself (signed with its own key)');
  expect(registrationSender({ signer: authority }, lab2, authority, others)).toBe("the lab's root authority (a lab setup transaction)");
  expect(registrationSender({ signer: lab1 }, lab2, authority, others)).toBe("Lab1's account");
  expect(registrationSender({ signer: stranger }, lab2, authority, others)).toBe(`another account ${stranger}`);
  expect(registrationSender({ resourceClaim: { extension: 'AsResources', claim: 'lite', beneficiary: '0x01' } }, lab2, authority, others)).toBe('no signer: resource claim AsResources for 0x01');
  expect(registrationSender({}, lab2, authority, others)).toBe('no signer');
  expect(registrationSender(undefined, lab2, authority, others)).toBe('unknown: the extrinsic did not decode');
  const batch = (name: string) => ({ call: { pallet: 'Utility', name: 'batch_all' }, callArguments: { calls: [{ type: 'Game', value: { type: name, value: {} } }] } });
  expect(signUpCall(batch('sign_up_with_account_lite_invite'))).toBe(true);
  expect(signUpCall(batch('report'))).toBe(false);
  // An unsigned or extension-authorized extrinsic is `partial`, but its call decodes in full: it still counts.
  expect(signUpCall({ ...batch('sign_up_with_account'), decoded: 'partial' } as Parameters<typeof signUpCall>[0])).toBe(true);
  expect(signUpCall({ call: { pallet: 'Game', name: 'sign_up_with_alias' }, callArguments: undefined })).toBe(true);
  expect(signUpCall({ call: { pallet: 'Utility', name: 'batch_all' }, callArguments: undefined })).toBe(false);
  expect(signUpCall({ call: { pallet: 'Game', name: 'register' }, callArguments: undefined })).toBe(false);
  expect(signUpCall(undefined)).toBe(false);
});

it('@negative-control: a withheld attempt and the permission click are not registration clicks', () => {
  const input = (control: string, sent: RegistrationInput['sent']): RegistrationInput => ({ control, sent, at: 0, view: null });
  expect([input('Register', 'clicked'), input('Register', 'maybe'), input('Register', 'withheld'), input('Allow access', 'clicked')].map(sentRegistrationClick))
    .toEqual([true, true, false, false]);
});

it('@negative-control: transaction registration cannot stand in for the app retaining its own communication key', async () => {
  await expect(registerMediaPlayer(pageOf([]), { name: 'Ada', address: lab1 } as never, chainFor({ registered: () => true }) as never)).rejects.toThrow('registered before the UI action');
});

it('reads the peers alongside a slow search, so a search that uses the whole budget still leaves their rows and screens', async () => {
  // 106 blocks at 300 ms each outlast the 30 s budget.
  home('Register');
  const page = pageOf([]), chain = chainFor({ registered: account => account === lab1, blockDelayMs: 300 });
  const task = settle(registerMediaPlayer(page, player, chain as never, peers(page)));
  await vi.advanceTimersByTimeAsync(diagnosisMs + 100);
  const error = await task as MediaRegistrationError;
  expect(error.message).toBe(`Media player was registered before the UI action\n${mediaRegistrationPointer}`);
  expect(text(error)).toMatch(new RegExp(`registration: search failed in #0..#105: diagnosis stopped: its ${diagnosisMs} ms budget ran out (before|during) reading (the events of )?block #\\d+`));
  expect(text(error)).toMatch(/peers now: Lab1 best #\d+ registered=true, finalized #\d+ registered=true, screen \/ \[Register\]; Lab2 best #\d+ registered=false, finalized #\d+ registered=false, screen \/permissions \[Allow access\]/);
});

it('keeps the latest Game event it found when the search is stopped', async () => {
  home('Register');
  const chain = chainFor({ registered: account => account === lab1, stalled: { blocksBelow: 104 },
    blocks: { 104: { event: 'ReportSubmitted', call: { pallet: 'Game', name: 'submit_report' }, signer: lab1 } } });
  const task = settle(registerMediaPlayer(pageOf([]), player, chain as never));
  await vi.advanceTimersByTimeAsync(diagnosisReadMs + 100);
  const error = await task as MediaRegistrationError;
  expect(text(error)).toContain(`latest Game event naming the account (the search of #0..#105 ended before a registration event or sign-up call: reading block #103 took longer than ${diagnosisReadMs} ms): Game.submit_report in block #104 ${hash(104)}`);
});

it('attaches the readable evidence and the JSON evidence of a media registration failure, and nothing for any other error', async () => {
  const page = pageOf([]), error = await settle(registerMediaPlayer(page, player, noClick() as never, peers(page))) as MediaRegistrationError;
  const attached: unknown[] = [];
  await attachMediaRegistrationFailure(async value => { attached.push(value); }, error);
  expect(attached).toEqual([{ mediaRegistration: error.report }, JSON.parse(JSON.stringify(error.evidence))]);
  await attachMediaRegistrationFailure(async value => { attached.push(value); }, new Error('other'));
  expect(attached).toHaveLength(2);
});

/** A media registration failure, as the no-click path throws it. */
const noClickFailure = async () => { const page = pageOf([]); return await settle(registerMediaPlayer(page, player, noClick() as never, peers(page))) as MediaRegistrationError; };
/** A temporary CI timings folder for one test, removed afterwards. */
async function inTimings(run: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'media-registration-timings-'));
  try { vi.stubEnv('CROSS_APP_TIMINGS_DIR', directory); await run(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

it('@negative-control: a failure writes its evidence to the uploaded observations.jsonl when CROSS_APP_TIMINGS_DIR is set', async () => {
  const error = await noClickFailure();
  await inTimings(async directory => {
    // An earlier observation in the same file stays; the failure adds one line.
    appendFileSync(join(directory, 'observations.jsonl'), JSON.stringify({ kind: 'funding-readiness' }) + '\n');
    const attached: unknown[] = [];
    await attachMediaRegistrationFailure(async value => { attached.push(value); }, error);
    const lines = readFileSync(join(directory, 'observations.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual({ kind: 'media-registration', mediaRegistration: error.report, evidence: JSON.parse(JSON.stringify(error.evidence)) });
    expect(lines[1]).toContain(`registration: Game.sign_up_with_account in block #101 ${hash(101)}`);
    expect(attached).toEqual([{ mediaRegistration: error.report }, JSON.parse(JSON.stringify(error.evidence))]);
  });
  expect(error.message).toBe(`Media player registration needs exactly one real UI click\n${mediaRegistrationPointer}`);
});

it('@negative-control: an evidence write or attach that fails never replaces the media registration failure', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = await noClickFailure(), attached: unknown[] = [];
  const rejecting = async () => { throw new Error('attach refused'); };
  await expect(withMediaRegistrationEvidence(rejecting, async () => { throw error; })).rejects.toBe(error);
  await inTimings(async directory => {
    // The timings path is a file, so the folder cannot be made: the attachments still go, and the failure stays.
    const blocked = join(directory, 'not-a-folder'); writeFileSync(blocked, '');
    vi.stubEnv('CROSS_APP_TIMINGS_DIR', join(blocked, 'timings'));
    await expect(withMediaRegistrationEvidence(async value => { attached.push(value); }, async () => { throw error; })).rejects.toBe(error);
    expect(attached).toHaveLength(2);
    // Both at once: still the failure.
    await expect(withMediaRegistrationEvidence(rejecting, async () => { throw error; })).rejects.toBe(error);
  });
  // Any other error passes through untouched, and a registration that succeeds returns its result.
  const other = new Error('Target page has been closed');
  await expect(withMediaRegistrationEvidence(rejecting, async () => { throw other; })).rejects.toBe(other);
  await expect(withMediaRegistrationEvidence(rejecting, async () => 'registered')).resolves.toBe('registered');
});

/**
 * Guard: product-lab classifies a failed step by its whole error text, rule by rule. The thrown message must get the
 * same rule and layer as its first line alone on every wrapped path, including evidence that names "finalized",
 * "extrinsic", "events" or an RPC error's "WebSocket". The readable evidence would not (checked as the control).
 */
const stepTitle = '2 real Jollity media peers register through their own screens';
const failurePaths: Array<[string, () => Promise<unknown>, string?]> = [
  ['no click', async () => { const page = pageOf([]); return settle(registerMediaPlayer(page, player, noClick() as never, peers(page))); }, 'chain-keywords'],
  ['registered before the UI action', async () => { home('Register');
    return settle(registerMediaPlayer(pageOf([]), player, chainFor({ registered: account => account === lab1, blocks: { 104: { signer: lab1 } } }) as never, peers(pageOf([])))); }],
  ['the helper timeout', async () => { permissions(); const page = pageOf([]);
    const task = settle(registerMediaPlayer(page, player, chainFor({ registered: () => false }) as never, peers(page))); await vi.advanceTimersByTimeAsync(181_000); return task; }],
  ['native PAS requested', async () => { home('Register', false, 'Next game', '<p>deposit required</p>');
    return settle(registerMediaPlayer(pageOf([]), player, chainFor({ registered: () => false }) as never, peers(pageOf([])))); }],
  ['the update screen', async () => { home('Register', false, 'Next game', '<p>A new version is out</p>');
    return settle(registerMediaPlayer(pageOf([]), player, chainFor({ registered: () => false }) as never, peers(pageOf([])))); }],
  ['a page check failure', async () => { home('Register');
    const broken = { ...pageOf([]), evaluate: async (read: () => unknown) => {
      if (read.toString().includes('document.body.innerText')) throw new Error('page.evaluate: Target crashed');
      return new Function(`return (${read.toString()})()`)();
    } } as unknown as BrowserPage;
    return settle(registerMediaPlayer(broken, player, chainFor({ registered: () => false }) as never, peers(broken))); }],
  ['a click error', async () => { home('Register'); const page = pageOf([], () => { throw new Error('Target page has been closed'); });
    return settle(registerMediaPlayer(page, player, chainFor({ registered: () => false }) as never, peers(page))); }],
  ['a seat that never shows', async () => { let proven = false; home('Register');
    const page = pageOf([], () => { proven = true; home('Saving your seat…', true); });
    const task = settle(registerMediaPlayer(page, player, chainFor({ registered: account => proven && account === lab1, blocks: { 103: { signer: lab1 } } }) as never, peers(page)));
    await vi.advanceTimersByTimeAsync(2_000); return task; }],
  ['two sent clicks', async () => { home('Register');
    helper.fake = async options => { for (let n = 0; n < 2; n++) options.input?.({ control: 'Register', at: Date.now(), sent: 'clicked', view: null }); return options.registered(); };
    return settle(registerMediaPlayer(pageOf([]), player, chainFor({ registered: (account, read) => account === lab1 && read >= 1, blocks: { 101: { signer: lab1 } } }) as never, peers(pageOf([])))); }],
  ['an RPC error in the evidence', async () => { const page = pageOf([]);
    return settle(registerMediaPlayer(page, player, noClick({ failing: 'WebSocket is not open: readyState 3 (CLOSED)' }) as never, peers(page))); }, 'environment-unreachable'],
  ['a stalled read in the evidence', async () => { const page = pageOf([]);
    const task = settle(registerMediaPlayer(page, player, noClick({ stalled: { blockAt: true } }) as never, peers(page))); await vi.advanceTimersByTimeAsync(diagnosisReadMs + 100); return task; }],
];
it.each(failurePaths)('@negative-control: the classifier gives %s the verdict of its first line alone', async (_name, path, evidenceRule) => {
  const error = await path() as MediaRegistrationError;
  const first = error.message.split('\n')[0]!;
  const whole = classifyFailure(error.message, stepTitle), alone = classifyFailure(first, stepTitle);
  expect({ rule: whole.rule, layer: whole.layer }).toEqual({ rule: alone.rule, layer: alone.layer });
  expect(error).toBeInstanceOf(MediaRegistrationError);
  expect(error.message).toBe(`${first}\n${mediaRegistrationPointer}`);
  expect(error.report[0]).toBe(first);
  // Control: the readable evidence, thrown as the message, would have changed the verdict.
  if (evidenceRule) expect(classifyFailure(error.report.join('\n'), stepTitle).rule).toBe(evidenceRule);
});
it('the pointer line matches no classifier rule', () => {
  expect(classifyFailure(mediaRegistrationPointer, stepTitle).rule).toBe('unclassified');
});

it('@negative-control: a failed evidence write leaves one stderr line without local paths, and the failure unchanged', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = await noClickFailure(), message = error.message;
  await inTimings(async directory => {
    const blocked = join(directory, 'not-a-folder'); writeFileSync(blocked, '');
    vi.stubEnv('CROSS_APP_TIMINGS_DIR', join(blocked, 'timings'));
    await expect(withMediaRegistrationEvidence(async () => {}, async () => { throw error; })).rejects.toBe(error);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(['media registration evidence not recorded:', 'ENOTDIR (mkdir)']);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(directory);
  });
  expect(error.message).toBe(message);
  expect(classifyFailure(error.message, stepTitle).rule).toBe(classifyFailure(error.message.split('\n')[0]!, stepTitle).rule);
  // Another failure's message keeps its words and loses only its paths.
  expect(recordingFailure(new Error("attach refused: cannot write /home/runner/work/x/report.json or C:\\lab\\out.json"))).toBe('attach refused: cannot write <path> or <path>');
  expect(recordingFailure(new Error('screen /permissions refused'))).toBe('screen /permissions refused');
  // A recording that succeeds writes nothing to stderr.
  warn.mockClear();
  await expect(withMediaRegistrationEvidence(async () => {}, async () => { throw error; })).rejects.toBe(error);
  expect(warn).not.toHaveBeenCalled();
});

/**
 * Source guard: both media steps must run registerMediaPlayer inside withMediaRegistrationEvidence, so a failed evidence
 * write or attach cannot replace the registration failure; journeys.ts records evidence only through that wrapper.
 */
it('@negative-control: every registerMediaPlayer call in journeys.ts runs inside withMediaRegistrationEvidence', () => {
  // jsdom gives import.meta.url a non-file scheme; the folder still resolves.
  const file = join(import.meta.dirname, '..', 'journeys.ts'), source = ts.createSourceFile('journeys.ts', readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const calls: Array<{ line: number; wrapped: boolean }> = [];
  const isCall = (node: ts.Node, name: string) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
  const visit = (node: ts.Node) => {
    if (isCall(node, 'registerMediaPlayer')) {
      let up: ts.Node | undefined = node.parent, wrapped = false;
      for (; up && !wrapped; up = up.parent) wrapped = isCall(up, 'withMediaRegistrationEvidence');
      calls.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, wrapped });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(calls.filter(call => !call.wrapped), 'registerMediaPlayer outside withMediaRegistrationEvidence').toEqual([]);
  const imported = source.statements.filter(ts.isImportDeclaration).flatMap(d => d.importClause?.namedBindings && ts.isNamedImports(d.importClause.namedBindings)
    ? d.importClause.namedBindings.elements.map(e => (e.propertyName ?? e.name).text) : []);
  expect(imported).toContain('withMediaRegistrationEvidence');
  expect(imported).not.toContain('attachMediaRegistrationFailure');
});
