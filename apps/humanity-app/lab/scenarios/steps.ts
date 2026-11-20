// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { Binary } from 'polkadot-api';
import { Before, After, AfterStep, BeforeStep, setDefinitionFunctionWrapper } from '@cucumber/cucumber';
import { step as registerStep, type StepArgument, type StepFunction } from '@parity/product-lab/steps';
import { fail } from '@parity/product-lab';
import { scenario } from '../../../../lab/shared/session.ts';
import { nextGame, attendanceView, assertAttendanceView, attendanceMatchesChain, claimedCardName, watchNextGame, watchedNextGame, assertNextGameHistory, formattedDate, fullUsernameMatches, jsonEvidence, hasCautionDeadline } from '../../../../lab/shared/observations.ts';
import { readWatchedText } from '../../../../lab/shared/watched-text.ts';
import { prizeAsset, thresholdPlan, assertUnsupportedPurse, assertPayoutIncrease } from '../../../../lab/shared/chain-plan.ts';
import { drainStep, ImportedGameNotRun } from '../../../../lab/shared/imported-game-admission.ts';
import { failureEvidenceHook } from './failure-evidence.ts';
import { dismissCautionSheet, returnToHomeFromNameClaim, confirmNameClaim } from '../../../../lab/shared/home.ts';
import { purseStep, purseReason, pendingPurseWrapper } from './pending-purse.ts';
import { retryUnpinned } from '../../../../lab/shared/setup-mode.ts';
import type { Call } from '../../../../lab/shared/upstream/lab/steps/games/fork-setup-plan.ts';

// Bundled Cucumber loads support with an open definition registry. Offline lint/coverage do not.
const pendingBridge = Boolean(process.env.PRODUCT_LAB_RUNTIME_MODULE);
if (pendingBridge) {
  setDefinitionFunctionWrapper(pendingPurseWrapper);
  Before(function ({ pickle }) { s().network.beginTag(pickle.tags.map(tag => tag.name)); });
  After({ timeout: 30_000 }, async function () {
    await this.attach(JSON.stringify(await s().network.snapshot()), 'application/json');
  });
  // Fast setup: the Given block's lab transactions wait only for inclusion. One finality checkpoint precedes the first
  // When or Then step, and each later one that follows a lab write; full setup has nothing pending.
  BeforeStep({ timeout: 240_000 }, async function ({ pickleStep }) {
    if (pickleStep.type !== 'Context') await s().chain.checkpoint(`before "${pickleStep.text}"`);
  });
  const captureFailure = failureEvidenceHook();
  AfterStep({ timeout: 30_000 }, async function (step) {
    await captureFailure.call(this, step);
    await this.attach(JSON.stringify(await s().network.snapshot()), 'application/json');
  });
}
function step(pattern: string, run: StepFunction, options?: Parameters<typeof registerStep>[2]) {
  registerStep(pattern, ({ lab }, ...args) => run({ lab: { ...lab, attach: value => lab.attach(jsonEvidence(value)) } }, ...args), options);
}
const timeout = { timeoutMs: 75 * 60_000 };
const s = scenario;
function ada(name: StepArgument) { if (name !== 'Ada') throw Error('Only Ada has a Humanity page'); return s().actor(); }
function page() { return s().actor().view.page; }
function players() { return [s().actor().game, ...s().bots]; }
async function text() { return readWatchedText(page(), () => document.body.innerText); }
async function waitText(expected: string) { return s().chain.until(`visible ${expected}`, async () => (await text())?.includes(expected) ? true : undefined, 600_000); }
async function waitLabel(label: string) {
  await s().chain.until(`Humanity card ${label}`, async () => {
    const value = await readWatchedText(page(), () => document.querySelector('[data-testid="card-label"]')?.textContent?.trim());
    return value === label ? true : undefined;
  }, 600_000);
}
async function waitForAppRecognition(ms = 600_000) {
  return s().chain.until('app registered personhood recognition', async () => {
    const score = await s().chain.score(s().actor().game.address);
    return score.value.recognition.type === 'Recognized' ? score : undefined;
  }, ms);
}
async function play(attends: boolean, extra: Call[] = []) {
  const c = s().chain;
  if (c.fast) {
    // The funding (and any extra root call) rides in the schedule's batch; a kept fixture game only lacks the bots.
    if (!c.current) await c.schedule(240, false, players(), extra);
    const missing = await c.unregistered(players());
    if (missing.length) await c.enroll(missing, players());
  } else {
    if (!c.current) { await c.schedule(240); await c.enroll(players()); }
    // Reuse the repository's date retime. Only game dates change; chain time follows the wall clock.
    if (c.current && c.current.playsAt - Date.now() / 1000 > 110) {
      const sent = c.transactions.count;
      const moved = await retryUnpinned(() => c.games.retime(c.current!.index, 90), { retryable: () => c.transactions.count === sent, signal: c.people.signal }); c.current.playsAt = moved.to;
    }
  }
  await c.play(players(), attends ? undefined : s().actor().game);
}
async function attend(count: number) {
  for (let i = 0; i < count; i++) await play(true);
}
async function member(attended = 2, keepGame = false) {
  // A fresh Score participant comes from a real sign-up; never send Score.register for the app.
  if (s().chain.fast) await s().chain.memberFixture(s().actor().game, players(), attended, keepGame);
  else { await s().chain.batch('Set deterministic scenario membership threshold', [thresholdPlan()]); await attend(2); }
  await waitForAppRecognition(); await s().chain.membership(s().actor().game.address);
  // Promotion is a real overlay; dismiss it with the existing product control for non-promotion setups.
  await page().getByRole('button', { name: 'Not now', exact: true }).click({ timeout: 120_000 });
  await waitLabel('Member');
  await returnToHomeFromNameClaim(page());
}
step(drainStep, async ({ lab }) => {
  try { await lab.attach({ importedGameAdmission: await s().chain.drainImportedGames() }); }
  catch (error) {
    if (error instanceof ImportedGameNotRun) await lab.attach({ status: 'not-run', reason: error.message });
    throw error;
  }
}, { timeoutMs: 75 * 60_000 });
step('the lab schedules a game playing in {int} seconds with short phases', async ({ lab }, seconds) => {
  await lab.attach(await s().chain.schedule(Number(seconds), false, s().chain.fast ? players() : []));
}, timeout);
step('{actor} is registered for the game by transaction', async ({ lab }, name) => {
  ada(name); await s().chain.enroll([s().actor().game], players());
  await lab.attach(await s().chain.setupRead('Game', 'Players', [{ type: 'Account', value: s().actor().game.address }]));
}, timeout);
step('{int} lab players are registered for the game by transaction', async ({ lab }, count) => {
  if (count !== 2) throw Error('One three-player group requires exactly two lab players');
  await s().chain.enroll(s().bots, players());
  // A finalized assertion after a fast enroll, which waits only for inclusion: the Given block gets no BeforeStep checkpoint.
  await s().chain.checkpoint('before the lab player registration read');
  for (const p of s().bots) {
    const read = await s().chain.read('Game', 'Players', [{ type: 'Account', value: p.address }]);
    if ((read.value as { registered?: boolean } | undefined)?.registered !== true) throw Error('Lab player registration absent'); await lab.attach(read);
  }
}, timeout);
step('{actor} sees the next-game block in mode {string}', async ({ lab }, name, mode) => {
  ada(name); const seen = await s().chain.until(`next game ${mode}`, async () => { const view = await nextGame(page()); return view?.mode === mode ? view : undefined; }, 45_000); await lab.attach(seen);
}, { timeoutMs: 50_000 });
step('{actor} sees the next-game block in mode {string} within {int} seconds', async ({ lab }, name, mode, seconds) => {
  ada(name); const seen = await s().chain.until(`next game ${mode}`, async () => { const view = await nextGame(page()); return view?.mode === mode ? view : undefined; }, Number(seconds) * 1000); await lab.attach(seen);
}, { timeoutMs: 60_000 });
step('the lab watches the next-game block throughout the game', async ({ lab }) => {
  // A schedule can appear as upcoming before the app's next current-game poll. It is still a
  // future game then, not a finished date reappearing. Start the watch from this game's seat.
  await s().chain.checkpoint('before watching the game');
  const date = s().chain.current?.playsAt; if (!date) throw Error('No game prepared for the next-game watch');
  const expected = await formattedDate(page(), date);
  const view = await s().chain.until('app confirmed the watched game', async () => {
    const view = await nextGame(page()); return view?.mode === 'confirmed' && view.value === expected ? view : undefined;
  }, 45_000);
  await watchNextGame(page());
  await lab.attach({ watchedGame: { date, view } });
}, { timeoutMs: 240_000 });
step('the lab plays the game where {actor} attends', async ({ lab }, name) => { ada(name); await play(true); await lab.attach(s().evidence); }, timeout);
step('{actor} sees the next-game block in mode "results-pending" or "closed" or "no-game"', async ({ lab }, name) => {
  ada(name); const view = await s().chain.until('post-game next-game block', async () => { const view = await nextGame(page()); return view && ['results-pending', 'closed', 'no-game'].includes(view.mode) ? view : undefined; }, 45_000); await lab.attach(view);
}, { timeoutMs: 60_000 });
step('the lab schedules the next game in {int} seconds', async ({ lab }, seconds) => { await lab.attach(await s().chain.schedule(Number(seconds), true)); }, timeout);
step('{actor} sees the next-game block in mode "registration-open" with the scheduled time', async ({ lab }, name) => {
  ada(name); const date = s().chain.next?.game_play_time; if (!date) throw Error('No next schedule');
  const game = await s().chain.until('next game entered Registration', async () => {
    const read = await s().chain.read('Game', 'Game');
    const value = read.value as { game_date?: number; state?: { type: string } } | undefined;
    return value?.state?.type === 'Registration' && value.game_date === date ? read : undefined;
  }, 45_000);
  await lab.attach({ nextGameRegistration: game });
  const expected = await formattedDate(page(), date);
  const view = await s().chain.until('next scheduled date', async () => { const view = await nextGame(page()); return view?.mode === 'registration-open' && view.value === expected ? view : undefined; }, 45_000); await lab.attach({ view, date });
}, { timeoutMs: 100_000 });
step('{actor} never saw the finished game\'s time as the next game', async ({ lab }, name) => {
  ada(name); const old = s().chain.ended?.playsAt, next = s().chain.next?.game_play_time;
  if (!old || !next) throw Error('Missing game dates');
  const samples = await watchedNextGame(page()); await lab.attach({ samples });
  assertNextGameHistory(samples, await formattedDate(page(), old), await formattedDate(page(), next), s().chain.next!.finalizedAtMs);
});
step('{actor} attends {int} games played by the lab', async ({ lab }, name, count) => {
  ada(name); if (count !== 2 && count !== 3) throw Error('Promotion requires two or three real games');
  if (s().chain.fast) { await play(true, [thresholdPlan()]); await attend(Number(count) - 1); }
  else { await s().chain.batch('Set scenario personhood threshold', [thresholdPlan()]); await attend(Number(count)); }
  await lab.attach(s().evidence);
}, timeout);
step('{actor}\'s score record on chain shows recognition "Recognized" or reached personhood', async ({ lab }, name) => {
  ada(name); const read = await s().chain.score(s().actor().game.address);
  if (read.value.recognition.type !== 'Recognized' && !read.value.reached_personhood) fail('not-on-chain', 'Personhood threshold was not reached'); await lab.attach(read);
});
step('{actor} sees the promotion screen {string}', async ({ lab }, name, title) => { ada(name); await waitText(String(title)); await lab.attach({ title }); }, timeout);
step('{actor} taps "Choose your name"', async ({ lab }, name) => {
  ada(name); const deadline = Date.now() + 600_000;
  const recognition = await waitForAppRecognition(Math.max(1, deadline - Date.now()));
  const membership = await s().chain.membership(s().actor().game.address, Math.max(1, deadline - Date.now()));
  await lab.attach({ recognition, membership });
  // The button stays absent while the app's member card or membership root is pending.
  await page().getByRole('button', { name: 'Choose your name', exact: true }).click({ timeout: Math.max(1, deadline - Date.now()) });
}, { timeoutMs: 660_000 });
step('{actor} claims her member username', async ({ lab }, name) => {
  ada(name); await waitForAppRecognition();
  await lab.attach({ membership: await s().chain.membership(s().actor().game.address) });
  // A fresh all-letter name avoids depending on whether the offered lite name's bare label is taken.
  // Claiming follows the product's intentional two-tap flow.
  const field = page().getByLabel('Your name', { exact: true }); await field.waitFor({ state: 'visible', timeout: 600_000 });
  const bare = 'adalab' + Array.from(s().actor().game.signer.publicKey.subarray(0, 16), byte => String.fromCharCode(97 + byte % 26)).join('');
  await field.fill(bare);
  if (!/^[a-z]{6,32}$/.test(bare)) throw Error('Invalid offered member username');
  await confirmNameClaim(page(), bare);
  await waitText(`Your name is ${bare}`);
  await page().getByRole('button', { name: 'Back to your card', exact: true }).click();
  const expectedCardName = claimedCardName(s().actor().view.username, bare);
  await s().chain.until('full username card', async () => {
    const value = await readWatchedText(page(), () => document.querySelector('[data-testid="card-username"]')?.textContent?.trim());
    return value === expectedCardName ? true : undefined;
  }, 600_000);
  s().actor().view.username = expectedCardName; await waitLabel('Member'); await lab.attach({ fullUsername: s().actor().view.username });
}, timeout);
step('{actor}\'s card shows her claimed member username', async ({ lab }, name) => {
  ada(name); const username = s().actor().view.username;
  const seen = await readWatchedText(page(), () => document.querySelector('[data-testid="card-username"]')?.textContent?.trim());
  if (!/^[a-z]{6,32}(?:\.(?:dot|paseo|test|testnet))?$/.test(username) || seen !== username) throw Error('Card differs from claimed member username');
  await lab.attach({ username, seen });
});
step('{actor}\'s full username resolves on chain', async ({ lab }, name) => {
  ada(name); const a = s().actor(), full = a.view.username, bare = full.split('.')[0]!;
  const proof = await s().chain.until('finalized Resources and DotNS name', async () => {
    const owner = await s().chain.read('Resources', 'UsernameOwnerOf', [Binary.fromText(bare)]);
    const consumers = await s().chain.read('Resources', 'Consumers', [a.identityAddress]);
    const hub = await s().hub.finalizedHead();
    const names = await s().hub.historicalStorage('DotnsGateway', 'AccountNames', [a.identityAddress], hub.hash) as { full?: { label: unknown } } | undefined;
    return fullUsernameMatches(owner.value, consumers.value, names, a.identityAddress, bare) ? { owner, consumers, hub, names } : undefined;
  }, 600_000); await lab.attach(proof);
}, timeout);
step('{actor} is a member', async ({ lab }, name) => { ada(name); await member(); await lab.attach(await s().chain.score(s().actor().game.address)); }, timeout);
step('{actor} is a member with {int} attended games', async ({ lab }, name, count) => {
  ada(name); if (count !== 3) throw Error('This setup requires three attended games');
  // Fast setup forces all three marks and keeps the fixture's game for A4's real miss.
  if (s().chain.fast) await member(3, true); else { await member(); await play(true); }
  await waitLabel('Member'); await lab.attach(await s().chain.score(s().actor().game.address));
}, timeout);
step('the lab sets the absence grace to {int} miss in a window of {int}', async ({ lab }, misses, window) => { await lab.attach(await s().chain.grace(Number(misses), Number(window))); }, timeout);
step('the lab plays a game where {actor} misses', async ({ lab }, name) => {
  ada(name); await play(false);
  // Caution's deadline note only exists while another game accepts registration; provide that real next game.
  await s().chain.schedule(300); await waitLabel('Member, at risk'); await lab.attach({ cautionSheetDismissed: await dismissCautionSheet(page()) }); await lab.attach(await s().chain.score(s().actor().game.address));
}, timeout);
step('{actor} sees the caution note {string}', async ({ lab }, name, expected) => {
  if (expected !== "Play {when} to keep it.") throw Error("Unexpected caution note template");
  ada(name); await s().chain.until('caution note', async () => hasCautionDeadline((await text()) ?? '') ? true : undefined); await lab.attach({ caution: await text() });
}, timeout);
step('the lab records one further missed game for {actor} by forced attendance', async ({ lab }, name) => {
  ada(name); await lab.attach(await s().chain.attendance(s().actor().game.address, 'M')); await waitLabel('Suspended');
}, timeout);
step('{actor}\'s score record on chain shows recognition {string}', async ({ lab }, name, expected) => {
  ada(name); const read = await s().chain.score(s().actor().game.address); await lab.attach(read); if (read.value.recognition.type !== expected) fail('not-on-chain', `Expected recognition ${expected}`);
});
let attendance: Awaited<ReturnType<ReturnType<typeof scenario>['chain']['attendance']>> | undefined;
step('the lab plays games where {actor}\'s attendance is {string}', async ({ lab }, name, pattern) => {
  ada(name); await s().chain.grace(5, 8);
  // One additional attended game makes the member setup exactly AAA before the five marks: real in full setup, forced
  // in fast setup (the same Score.set_attendance path).
  if (s().chain.fast) await lab.attach({ thirdAttended: await s().chain.attendance(s().actor().game.address, 'A') }); else await play(true);
  attendance = await s().chain.attendance(s().actor().game.address, String(pattern)); await lab.attach(attendance);
}, timeout);
step('{actor}\'s score record on chain has attendance history {string}', async ({ lab }, name, pattern) => {
  ada(name); if (!attendance || attendance.pattern !== pattern) throw Error('No attendance pattern evidence');
  const read = await s().chain.score(s().actor().game.address);
  if (read.value.attendance_history !== attendance.after.value.attendance_history || read.value.streak.type !== attendance.after.value.streak.type || read.value.streak.value !== attendance.after.value.streak.value) fail('not-on-chain', 'Attendance changed after forced pattern'); await lab.attach(read);
});
step('{actor} sees the attendance row:', async ({ lab }, name, table) => {
  ada(name); if (!Array.isArray(table)) throw Error('Missing attendance table');
  const values = Object.fromEntries((table as readonly (readonly string[])[]).map(row => [row[0], row[1]]));
  if (Object.keys(values).sort().join(',') !== 'attended,missed,value') throw Error('Attendance table requires value, attended and missed');
  const record = await s().chain.score(s().actor().game.address);
  const expected = { value: values.value!, attended: Number(values.attended), missed: Number(values.missed) };
  let sheetDismissed = false, sheetChecked = false;
  let lastSeen: Awaited<ReturnType<typeof attendanceView>> = null;
  let seen: NonNullable<Awaited<ReturnType<typeof attendanceView>>>;
  try {
    seen = await s().chain.until('attendance row matches chain', async () => {
      const dismissed = await dismissCautionSheet(page());
      sheetDismissed = sheetDismissed || dismissed;
      if (!sheetChecked || dismissed) await lab.attach({ cautionSheetDismissed: sheetDismissed });
      sheetChecked = true;
      lastSeen = await attendanceView(page());
      return attendanceMatchesChain(lastSeen, record.value) ? lastSeen! : undefined;
    }, 45_000);
  } catch (error) {
    await lab.attach({ lastSeen, record, expected, cautionSheetDismissed: sheetDismissed, attendanceReadiness: 'timed-out-or-failed' });
    throw error;
  }
  await lab.attach({ seen, expected, record, cautionSheetDismissed: sheetDismissed }); assertAttendanceView(seen, expected, record.value.attendance_history, record.value.last_attended_game);
}, { timeoutMs: 60_000 });
step('the lab opens today\'s draw with a 1 dollar prize that {actor} wins', async ({ lab }, name) => {
  ada(name); await s().chain.membership(s().actor().game.address); await lab.attach(await s().chain.prepareDraw(s().actor().product));
  let lastDrawState = '';
  let lastObserved: unknown;
  // The app supplies PeopleAirdrops.register and its ring proof. No lab-side person proof is forged.
  await s().chain.until('one deterministic daily-draw registrant and winner', async () => {
    const draw = s().chain.draw!, event = await s().chain.read('Airdrop', 'Events', [draw.id]);
    const value = event.value as { status?: { type: string; value?: { total_participants?: number; effective_winners?: number } } } | undefined;
    const fingerprint = value === undefined ? 'missing' : JSON.stringify(jsonEvidence(value));
    if (fingerprint !== lastDrawState) { lastDrawState = fingerprint; if (value) lastObserved = event; await lab.attach({ dailyDrawState: event }); }
    if (!value) {
      const cancellation = await s().chain.findEvent(draw.fromBlock, e => {
        const event = e as { type?: string; value?: { type?: string; value?: { event_id?: string } } };
        return event.type === 'Airdrop' && event.value?.type === 'EventCanceled' && event.value.value?.event_id === draw.id;
      }).catch(error => ({ diagnosticError: String(error) }));
      await lab.attach({ dailyDrawMissing: { id: draw.id, lastObserved, cancellation } });
      throw Error('Daily draw disappeared');
    }
    if (value.status?.value?.total_participants !== undefined && value.status.value.total_participants > 1) throw Error('Foreign daily-draw participant');
    // The finalized draw must be claimable, and exactly one actual winner must exist for this event.
    if (value.status?.type !== 'Claiming') return undefined;
    if (value.status.value?.total_participants !== 1 || value.status.value.effective_winners !== 1) throw Error('Draw is not a single registrant win');
    // A typed read at an RPC finalized hash can meet an unpinned block; read again at the newest finalized head.
    const winners = await retryUnpinned(async () => {
      const at = await s().chain.people.access.finalizedHead();
      return s().chain.people.api.query.Airdrop.Winners.getEntries(draw.id, { at: at.hash });
    }, { signal: s().chain.people.signal });
    if (winners.length !== 1) throw Error('Deterministic draw did not produce one winner');
    return { event, winners };
  }, 600_000);
}, timeout);
step('{actor} opens the daily scratch', async (_context, name) => {
  ada(name); await page().getByText('Win a dollar today', { exact: true }).click({ timeout: 120_000 });
  await page().getByRole('button', { name: 'Scratch to reveal', exact: true }).waitFor({ state: 'visible', timeout: 120_000 });
}, timeout);
step('{actor} scratches today\'s ticket', async (_context, name) => {
  ada(name); const foil = page().getByRole('button', { name: 'Scratch to reveal', exact: true }); if (!foil.press) throw Error('Scratch keyboard reveal unsupported'); await foil.press('Enter');
});
step('{actor}\'s prize claim is finalized on chain to product account 0', async ({ lab }, name) => { ada(name); await lab.attach(await s().chain.claim()); }, timeout);
step('product account 0 grew by the PrizeClaimed amount', async ({ lab }) => {
  const chain = s().chain, draw = chain.draw; if (!draw) throw Error('Missing draw balance baseline');
  const claim = await chain.claim();
  const proof = await chain.until('product payout account gained the claim', async () => {
    const read = await chain.read('Assets', 'Account', [prizeAsset, draw.destination]);
    const balance = (read.value as { balance?: bigint } | undefined)?.balance ?? 0n;
    return balance === draw.balanceBefore + claim.prize.amount! ? { read, balanceBefore: draw.balanceBefore, prize: claim.prize } : undefined;
  }, 60_000); assertPayoutIncrease(proof.balanceBefore, (proof.read.value as { balance: bigint }).balance, proof.prize.amount!); await lab.attach(proof);
}, { timeoutMs: 65_000 });
step("{actor}'s host Coinage purse answer is still Unsupported", async ({ lab }, name) => {
  ada(name); const body = page().locator('body'); if (!body.press) throw Error('Trusted debug-panel input required');
  await body.press('ControlOrMeta+d'); await page().locator('#debug-panel').waitFor({ state: 'visible' });
  const answer = await s().chain.until('Coinage purse host answer', async () => {
    const value = await readWatchedText(page(), () => {
      const panel = document.querySelector('#debug-panel');
      const sections = panel ? Array.from(panel.querySelectorAll('section.debug-section')) : [];
      const section = sections.find(s => s.querySelector('h2')?.textContent?.trim() === 'coinage');
      const term = Array.from(section?.querySelectorAll('dt') ?? []).find(t => t.textContent?.trim() === 'payments');
      const answer = term?.nextElementSibling?.textContent?.trim();
      const available = Array.from(section?.querySelectorAll('dt') ?? []).find(t => t.textContent?.trim() === 'available');
      if (answer === 'subscribed' && available?.nextElementSibling?.textContent?.trim() === 'awaiting first balance') return undefined;
      return answer;
    });
    if (!value || /^(pending|unresolved)$/.test(value)) return undefined;
    assertUnsupportedPurse(value);
    return value;
  }, 15_000); await lab.attach({ hostPurseAnswer: answer });
  await page().getByRole('button', { name: 'Hide', exact: true }).click();
}, { timeoutMs: 30_000 });
step(purseStep, async ({ lab }, name) => { ada(name); if (!pendingBridge) throw Error('Pending purse requires the bundled Cucumber runner'); await lab.attach({ status: 'pending', reason: purseReason, probe: 'M3', deadlineSeconds: 60 }); });
