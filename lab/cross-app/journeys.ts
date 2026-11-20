// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { step } from '@parity/product-lab/steps';
import type { HostSession } from '@parity/product-lab';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { returnToHomeFromNameClaim } from '../shared/home.ts';
import { scenario } from '../shared/session.ts';
import { nextGame, attendanceView, formattedDate, jsonEvidence } from '../shared/observations.ts';
import { readRegistrationView } from '../shared/registration.ts';
import { readWatchedText } from '../shared/watched-text.ts';
import { flowStorage } from '../shared/storage.ts';
import { playMediaGroup } from './real-play.ts';
import { backgroundVerification } from './verification.ts';
import { registerMediaPlayer, withMediaRegistrationEvidence } from './media-registration.ts';
import { readDim2Votes, assertDim2Votes } from '../shared/upstream/lab/steps/dim2/finalized-votes.ts';
import { playDim2InApp, readDim2Report, readReportDeadline, isShutOut } from '../shared/upstream/lab/steps/dim2/live-game.ts';
import { continueToDim2Results, returnFromDim2 } from '../shared/upstream/lab/steps/dim2/results.ts';
import { earliestPlay } from '../shared/upstream/lab/steps/games/game-retime.ts';
import { shortPhases, call } from '../shared/chain-plan.ts';
import { RegistrationWatch, FrameProbe } from './chain-watch.ts';
import { journeyBreakdown, commentSection } from './timing.ts';
import { navigationPath, isHumanityNavigation, sameTime, sharedDateTimeline, returnedCardMark, returnedCardReady, returnedCardResult, firstPlayCandidate, observedCandidate, currentDateCoverage, type DocumentMarks } from './journey-observations.ts';
import { backgroundHumanityAfterGame } from './recovery.ts';
import { save, output, capMs } from './steps.ts';
import { jollityGameAt } from './jollity-time.ts';

const s = scenario;
const human = () => s().actor().view.page;
const jolly = () => { const value = s().actor().jollity; if (!value) throw Error('No Jollity host'); return value; };
const documentMarks = (page: BrowserPage) => readWatchedText(page, () => (window as unknown as { __crossJourney: DocumentMarks }).__crossJourney);
function navigations(session: HostSession, from: number) {
  const directory = (session.evidence as { runDir?: string }).runDir;
  if (!directory) throw Error('No host navigation evidence');
  try { return readFileSync(join(directory, 'navigations.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { at: number; url: string }).filter(n => n.at >= from); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function guard() {
  for (const page of [human(), jolly().page]) {
    const text = await readWatchedText(page, () => document.body.innerText);
    if (/A new version is out/i.test(text ?? '')) throw Error('Update screen: stop without interacting');
    if (/native PAS|request.*PAS/i.test(text ?? '')) throw Error('Native PAS request: stop');
  }
}
async function diagnostics() {
  const dispatch = await (async () => {
    const at = await s().people.access.bestHead();
    const events = await flowStorage(s().people.access, 'System', 'Events', [], at.hash) as Array<{ event: { type: string } }>;
    return { at, events: events.filter(e => ['Sudo', 'Utility'].includes(e.event.type)) };
  })().catch(error => ({ error: String(error) }));
  return { dispatch, ...await viewDiagnostics() };
}
async function mediaDiagnostics() {
  return Promise.all([jolly().page, ...s().mediaPeers.map(peer => peer.page)].map(async page => {
    const body = page.locator('body'); if (!body.press) return { unavailable: true };
    await body.press('ControlOrMeta+d');
    try {
      await page.getByRole('dialog', { name: 'Debug logs' }).waitFor({ state: 'visible', timeout: 5000 });
      return await readWatchedText(page, () => [...document.querySelectorAll('[role="dialog"] div.flex.gap-2')].flatMap(row => {
        const spans = row.querySelectorAll('span'), tag = spans[1]?.textContent ?? '', message = spans[2]?.textContent ?? '';
        if (!/^\[(?:rtc|statement|health)\]$/.test(tag) || /candidate:|remote cand|stats cand|ice-pwd|ice-ufrag|credential/i.test(message)) return [];
        return [{ tag, message: message.slice(0, 600) }];
      }));
    } finally { await page.getByRole('button', { name: 'Close', exact: true }).click().catch(() => undefined); }
  }));
}
async function viewDiagnostics() {
  return { humanity: await nextGame(human()).catch(() => null), attendance: await attendanceView(human()).catch(() => null),
    jollity: await readRegistrationView(jolly().page).catch(() => null),
    documents: await Promise.all([human(), jolly().page].map(page => documentMarks(page).catch(() => null))) };
}
async function until<T>(name: string, read: () => Promise<T | undefined>, ms = capMs) {
  return s().chain.until(name, async () => { await guard(); return read(); }, ms);
}
async function probe(page: 'humanity' | 'jollity', pallet: string, item: string, keys: unknown[]) {
  const state = s();
  const query = state.people.access.client.getUnsafeApi().query as unknown as Record<string, Record<string, { getKey(...keys: unknown[]): Promise<string> }>>;
  const key = await query[pallet]![item]!.getKey(...keys);
  const result = new FrameProbe(new URL(state.apps[page]!).origin, key);
  state.network.frameProbes.add(result.listener); return result;
}
async function follow(session: HostSession, url: string, product: 'dim2' | 'peopl') {
  await guard(); const start = Date.now(), path = navigationPath(url, product);
  if (!session.open) throw Error('Host cannot open navigation');
  await session.open(path); const page = await session.page();
  if (product === 'dim2') jolly().page = page; else s().actor().view.page = page;
  return { start, opened: Date.now(), path, target: url.startsWith('polkadotapp:') ? 'Pocket card request followed by full Humanity app in lab' : 'product page' };
}

async function checkTimes(date: number, from = 0, history = true) {
  const h = await formattedDate(human(), date);
  const j = await jollityGameAt(jolly().page, date);
  const marks = await Promise.all([documentMarks(human()), documentMarks(jolly().page)]);
  const samples = marks.flatMap(m => m?.views ?? []).filter(v => v.at >= from);
  const current = marks.flatMap(m => m?.views.slice(-1) ?? []);
  const result = { date, expectedHumanity: h, expectedJollity: j, ...sameTime(history ? samples : current, h, j), samples, current };
  if (!history && (!current.some(s => s.view.humanity === h) || !current.some(s => s.view.jollity === `Game starts at ${j}` || s.view.jollity === `Game at ${j}` || s.view.jollity === `at ${j}`))) throw Error('Both current dates not ready');
  if (!result.checked || result.wrong.length) throw Error(`Same-next-game-time check failed: ${JSON.stringify(result)}`);
  return result;
}

step('Ada enters Jollity from Humanity, C3 run {string}', async ({ lab }, run) => {
  const state = s(), game = state.chain.current; if (!game) throw Error('No game');
  const p = await probe('jollity', 'Game', 'Players', [{ type: 'Account', value: state.actor().game.address }]);
  let tap = 0;
  try {
    await until('Humanity hand-off prerequisite', async () => state.crossAppLog.some(m => new URL(m.url).origin === new URL(state.apps.humanity).origin && /name link.*(?:unfunded|skipped)|no sign-up:|the sign-up could not start/i.test(m.text)) ? true : undefined, 120_000);
    const before = await checkTimes(game.playsAt);
    await guard(); tap = Date.now();
    await human().getByRole('button', { name: 'Register', exact: true }).click({ timeout: 5000 });
    const registerClick = { name: 'lab Register click', at: tap, done: Date.now() };
    const navigation = await until('Humanity host navigation to Jollity', async () => navigations(state.actor().session, tap)[0]);
    const followMark = await follow(jolly().session, navigation.url, 'dim2');
    const labActions: Array<{ name: string; at: number; done: number }> = [registerClick, { name: 'lab navigation follow', at: followMark.start, done: followMark.opened }];
    let allowed = false, candidate: number | undefined, candidateSeen = 0;
    const shown = await until('Ada seat shown with next action enabled', async () => {
      const path = await readWatchedText(jolly().page, () => location.pathname);
      if (path === '/permissions' && !allowed) { allowed = true; const at = Date.now(); await jolly().page.getByRole('button', { name: 'Allow access', exact: true }).click({ timeout: 5000 }); labActions.push({ name: 'lab permission click', at, done: Date.now() }); }
      const m = await documentMarks(jolly().page), view = await readRegistrationView(jolly().page);
      const account = await readWatchedText(jolly().page, () => document.querySelector('[data-testid="home"]')?.getAttribute('data-account'));
      if (!m?.usable || view?.path !== '/' || !view.buttons.some(b => b.name === 'Register' && !b.disabled) || account !== state.actor().game.address) { candidate = undefined; return undefined; }
      if (candidate !== m.usable) { candidate = m.usable; candidateSeen = Date.now(); }
      return Date.now() - candidateSeen >= 1000 ? m : undefined;
    });
    const loaded = shown.loaded ?? undefined, data = p.first(loaded ?? followMark.start);
    const times = { before, after: await checkTimes(game.playsAt, tap, false) };
    const value = journeyBreakdown({ direction: 'C3', run: String(run), reader: { app: 'Jollity', head: 'best', how: 'watchPlayer subscription; socket key is a data-arrival proxy' },
      start: tap, end: shown.usable!, actions: labActions, points: [{ name: 'tap to navigation', at: navigation.at }, { name: 'lab overhead', at: followMark.start },
        { name: 'navigation to load', at: loaded }, { name: 'load to data', at: data }] });
    const raw = { tap, navigation, labActions, follow: followMark, loaded, data: data ?? null, rendered: shown.usable, times, document: shown };
    save(value, raw); await lab.attach(jsonEvidence({ breakdown: value, raw }));
  } catch (error) { writeFileSync(join(output(), `failed-C3-${run}.json`), JSON.stringify({ ...await diagnostics(), tap, error: String(error), startupLog: state.crossAppLog }, null, 2)); throw error; }
  finally { state.network.frameProbes.delete(p.listener); }
}, { timeoutMs: capMs + 180_000 });

step('Ada plays in Jollity and returns to her updated Humanity card, C4 run {string}', async ({ lab }, run) => {
  const state = s(), game = state.chain.current; if (!game) throw Error('No game');
  const actor = state.actor();
  const scoreProbe = await probe('humanity', 'Score', 'Participants', [{ type: 'Account', value: actor.game.address }]);
  // Times from Ada's own report block, what the card shows; the game's end is checked after timing (GameEnded).
  const watch = new RegistrationWatch(state.people, actor.game.address, 200, async hash => returnedCardResult(
    await flowStorage(state.people.access, 'Score', 'Participants', [{ type: 'Account', value: actor.game.address }], hash) as { last_attended_game?: number } | undefined, game.index)).start();
  let raw: Record<string, unknown> = {};
  try {
    // The member fixture had its own cancelled game; start the game-date check at the measured game.
    const firstPlayBefore = String(run).startsWith('C6-') ? await state.chain.read('Score', 'Participants', [{ type: 'Account', value: actor.game.address }]) : undefined;
    const beforeTimes = await until('both apps show the measured game before play', async () => {
      try { return await checkTimes(game.playsAt, Date.now(), false); }
      catch (error) {
        if (error instanceof Error && /Both current dates not ready|Same-next-game-time check failed/.test(error.message)) return undefined;
        throw error;
      }
    }, 90_000);
    const scheduleStart = Date.now();
    const expectedDate = Math.floor(Date.now() / 1000) + 3600;
    // Keep the next registration window clear of the current game and its long setup registration phase.
    const schedule = await state.chain.batch('Schedule following game before play', [call('Game', 'schedule_games', { games_schedules: [{ game_play_time: expectedDate, rounds: 1, max_group_size: 4, airdrops: [] }] })]);
    await state.chain.checkpoint('following game scheduled before play'); const scheduleEnd = Date.now();
    const retimed = await state.chain.games.retime(game.index, Math.max(180, earliestPlay(shortPhases))); game.playsAt = retimed.to;
    await state.chain.checkpoint('game re-timed for real play');
    // Both products must learn the changed date before the actual handover into play.
    const retimedTimes = await until('both apps show re-timed game', async () => { try { return await checkTimes(game.playsAt, 0, false); } catch { return undefined; } }, 60_000);
    raw = { game: { ...game }, beforeTimes, retimed, retimedTimes, scheduleStart, scheduleEnd };
    const peers = state.mediaPeers;
    const group = [actor.game, ...peers.map(peer => peer.game)];
    const pages = [jolly().page, ...peers.map(peer => peer.page)];
    const peerStart = Date.now();
    const results = await playMediaGroup(group, state.people.signal, (player, seat, signal) => {
      const n = group.findIndex(p => p.address === player.address);
      return playDim2InApp(pages[n]!, undefined, signal, game.playsAt * 1000, undefined,
        view => { if (/A new version is out/i.test(view)) throw Error('Update screen: stop without interacting'); },
        seat, () => readReportDeadline(state.people, game), undefined,
        votes => { raw.uiVotes ??= {}; (raw.uiVotes as Record<string, unknown>)[player.name] = votes; });
    });
    const play = results[0]!;
    const pendingVerification = backgroundVerification(async () => {
      const reports = await Promise.all(group.map(async player => {
        const proof = await readDim2Report(state.people, game, player.address);
        if (isShutOut(proof)) throw Error('A media player was shut out before its UI report finalized');
        const votes = await readDim2Votes(state.people.access, proof, game, player.address);
        assertDim2Votes(votes, [{ round: '1', person: '2', notperson: '0' }]);
        return { name: player.name, proof, votes };
      }));
      let firstPlayReturn;
      if (firstPlayBefore) {
        await watch.marks(state.people.signal, capMs);
        const after = await state.chain.score(actor.game.address);
        const threshold = Number(await flowStorage(state.people.access, 'Score', 'PersonhoodThreshold', [], after.at.hash));
        const expected = firstPlayCandidate(firstPlayBefore.value as { score: number; last_attended_game?: number } | undefined,
          after.value, game.index, threshold, actor.identityAddress);
        firstPlayReturn = { before: firstPlayBefore, after, threshold, expected };
      }
      return { reports, firstPlayReturn };
    });
    Object.assign(raw, { play });
    const resultAt = play.votes.views.find(v => /^\/(chest|results|prize-draw),/.test(v.view))?.at;
    if (!resultAt) throw Error('Missing Jollity result-screen mark');
    if (String(run).startsWith('B2-')) raw.background = await backgroundHumanityAfterGame(game.index, expectedDate, watch, scoreProbe, String(run));
    const preparedAt = Date.now();
    const prepared = await continueToDim2Results(jolly().page, undefined, { timeoutMs: 180_000 });
    const preparedDone = Date.now();
    const returnFlowStart = Date.now(), returnControls: Array<{ at: number; path: string; name: string }> = [];
    const returned = await returnFromDim2(jolly().page, () => navigations(jolly().session, returnFlowStart).some(n => isHumanityNavigation(n.url)), undefined, { timeoutMs: 180_000, onControl: control => returnControls.push(control) });
    const navigation = navigations(jolly().session, returnFlowStart).find(n => isHumanityNavigation(n.url)); if (!navigation) throw Error('Missing return navigation');
    const exitControl = returnControls.filter(c => c.at <= navigation.at).at(-1); if (!exitControl) throw Error('No trusted return CTA mark before navigation');
    const exitTap = exitControl.at;
    if (String(run).startsWith('U4-')) {
      if (!state.versionFile) throw Error('U4 requires the local version server');
      const at = Date.now(); state.versionFile.set(true); raw.updatePromotion = { at, done: Date.now(), requestsBefore: [...state.versionFile.requests] };
    }
    const beforeReturnDocuments = await Promise.all([documentMarks(human()), documentMarks(jolly().page)]);
    const followMark = await follow(actor.session, navigation.url, 'peopl');
    Object.assign(raw, { resultAt, prepared, returnFlowStart, returnControls, exitControl, exitTap, returned, navigation, beforeReturnDocuments, follow: followMark });
    const expectedHumanityDate = await formattedDate(human(), expectedDate);
    let nameClaimAction: { at: number; done: number; control: string } | undefined;
    let readyAt: number | undefined, readySeen = 0;
    let labCardDisplay: { at: number; done: number } | undefined;
    const shownPromise = until('attendance, card and next game updated', async () => {
      const claim = await readWatchedText(human(), () => [...document.querySelectorAll('h1, h2, [role=heading]')].some(h => h.getClientRects().length > 0 && h.textContent?.trim() === 'Choose your name'));
      if (claim && !nameClaimAction) {
        await guard(); const at = Date.now(); await returnToHomeFromNameClaim(human());
        nameClaimAction = { at, done: Date.now(), control: 'Not now on Choose your name' }; raw.nameClaimAction = nameClaimAction;
        return undefined;
      }
      const m = await documentMarks(human()), attendance = await attendanceView(human()), next = await nextGame(human());
      const card = await readWatchedText(human(), () => ({ name: document.querySelector('[data-testid="card-username"]')?.textContent?.trim(), text: document.querySelector('main')?.textContent ?? '' }));
      const latest = m?.views.at(-1)?.view;
      const candidateReturn = firstPlayBefore && latest ? observedCandidate(latest,
        (firstPlayBefore.value as { score?: number } | undefined)?.score ?? 0, actor.identityAddress) : undefined;
      let mark = m ? returnedCardMark(m.views, game.index, expectedHumanityDate, nameClaimAction?.at ?? followMark.start, candidateReturn) : undefined;
      const home = await readWatchedText(human(), () => Boolean(document.querySelector('[data-testid="humanity-home"]')?.getClientRects().length));
      const hiddenCard = home && await readWatchedText(human(), () => !document.querySelector('[data-testid="humanity-home"] .card-wrap'));
      if (hiddenCard && !labCardDisplay) {
        // The same existing plain-host display control used at actor startup. No chain state is simulated.
        await guard(); const at = Date.now(); await actor.view.showCard();
        labCardDisplay = { at, done: Date.now() }; raw.labCardDisplay = labCardDisplay; return undefined;
      }
      if (mark !== undefined && labCardDisplay) mark = Math.max(mark, labCardDisplay.done);
      const gameShown = candidateReturn ? Boolean(m?.views.at(-1) && returnedCardReady(m.views.at(-1)!.view, game.index, expectedHumanityDate, candidateReturn)) : m?.attendance.some(a => a.game === game.index) && attendance?.marks.some(a => a.title.endsWith(`(game ${game.index})`) && a.classes.includes('is-attended'));
      const ready = gameShown && card?.name && next && ['registration-open', 'upcoming'].includes(next.mode) && next.value === expectedHumanityDate && home;
      if (!ready || mark === undefined) { readyAt = undefined; return undefined; }
      if (readyAt !== mark) { readyAt = mark; readySeen = Date.now(); }
      return Date.now() - readySeen >= 1000 ? { at: mark, source: labCardDisplay ? 'poll-after-lab-display' : 'mutation-observer', document: m!, attendance: attendance!, next: next!, card: { name: card!.name }, candidateReturn } : undefined;
    });
    const [chain, shown] = await Promise.all([watch.marks(state.people.signal, capMs), shownPromise]);
    Object.assign(raw, { chain });
    // All endpoint timestamps are captured before awaiting immutable correctness evidence.
    const windows = [{ start: chain.included, end: shown.at }, { start: exitTap, end: shown.at }];
    const background = raw.background as { recovery: { foreground: number }; shown: { at: number } } | undefined;
    if (background) windows.push({ start: background.recovery.foreground, end: background.shown.at });
    const checked = await pendingVerification.after(windows);
    const { reports, firstPlayReturn } = checked.value;
    if (firstPlayReturn && !returnedCardReady(shown.document.views.at(-1)!.view, game.index, expectedHumanityDate, firstPlayReturn.expected))
      throw Error('Measured first-game card differs from the exact finalized score, threshold or owner');
    const peerPlay = { started: peerStart, verification: checked.verification,
      results: peers.map((peer, n) => ({ name: peer.name, play: results[n + 1]! })), reports };
    Object.assign(raw, { peerPlay, firstPlayReturn });
    // The clock starts at Ada's report, before the game ends, so the game's end may not be final yet: wait for it,
    // after timing and verification, as the no-show step does.
    const gameEnded = await state.chain.until('indexed finalized GameEnded for measured game', () => state.chain.findEvent(game.fromBlock, event => {
      const e = event as { type?: string; value?: { type?: string; value?: { index?: number } } };
      return e.type === 'Game' && e.value?.type === 'GameEnded' && e.value.value?.index === game.index;
    }), capMs);
    state.chain.ended = game; state.chain.current = undefined;
    state.chain.next = { game_play_time: expectedDate, finalizedAtMs: scheduleEnd };
    const updateReturn = String(run).startsWith('U4-');
    // An ordinary comparison opens Jollity home. With a promoted local file, leave its real post-game page alone:
    // an extra reopen would create a new stale-build gate after the measured return, not test Humanity's return gate.
    if (!updateReturn) { await jolly().session.open!('/'); jolly().page = await jolly().session.page(); }
    const times = updateReturn ? {
      date: expectedDate, expectedHumanity: expectedHumanityDate,
      expectedJollity: await jollityGameAt(jolly().page, expectedDate),
      reason: 'Jollity remains on its real dateless post-game page; no extra reopen or gate bypass',
    } : await until('same next-game time after return', async () => { try { return await checkTimes(expectedDate, scheduleEnd, false); } catch { return undefined; } }, 90_000);
    const afterReturnDocuments = await Promise.all([documentMarks(human()), documentMarks(jolly().page)]);
    const comparisonCoverage = currentDateCoverage(afterReturnDocuments[0], afterReturnDocuments[1], times.expectedHumanity, times.expectedJollity);
    const timeCheck = sharedDateTimeline([...beforeReturnDocuments, ...afterReturnDocuments].flatMap((m, i) => (m?.views ?? []).map(v => ({ ...v, app: i % 2 === 0 ? 'humanity' as const : 'jollity' as const }))), [beforeTimes, retimedTimes, times].map(t => ({ date: t.date, humanity: t.expectedHumanity, jollity: t.expectedJollity })));
    const endOfPlay = play.confirm.pressedAt;
    if (endOfPlay === undefined) throw Error('Missing measured UI confirm tap');
    const start = chain.included;
    const data = scoreProbe.first(chain.finalized ?? chain.included);
    const labActions = [...(raw.updatePromotion ? [{ name: 'lab version file promotion', at: (raw.updatePromotion as { at: number }).at, done: (raw.updatePromotion as { done: number }).done }] : []), { name: 'lab prepare payoff walk', at: preparedAt, done: preparedDone }, { name: 'lab return payoff walk before CTA', at: returnFlowStart, done: exitTap },
      { name: 'lab navigation follow', at: followMark.start, done: followMark.opened },
      ...(nameClaimAction ? [{ name: 'lab name prompt Not now', at: nameClaimAction.at, done: nameClaimAction.done }] : []),
      ...(labCardDisplay ? [{ name: 'lab card-display control', at: labCardDisplay.at, done: labCardDisplay.done }] : []),
      ...(raw.background ? [{ name: 'lab page frozen while waiting for result', at: (raw.background as { recovery: { freeze: number } }).recovery.freeze, done: (raw.background as { recovery: { foreground: number } }).recovery.foreground }] : [])];
    const returnBreakdown = journeyBreakdown({ direction: String(run).startsWith('U4-') ? 'U4' : 'C4', run: `${run}-return-cta`, reader: { app: 'Humanity', head: 'finalized', how: 'return CTA; same recorder; separate from score-row total' },
      start: exitTap, end: shown.at, actions: labActions, verification: checked.verification, points: [{ name: 'tap to navigation', at: navigation.at }, { name: 'lab overhead', at: followMark.start },
        { name: 'navigation to load', at: shown.document.loaded ?? undefined }, { name: 'load to data', at: scoreProbe.first(Math.max(shown.document.loaded ?? followMark.start, chain.finalized ?? chain.included)) }] });
    const value = journeyBreakdown({ direction: String(run).startsWith('U4-') ? 'U4' : 'C4', run: String(run), reader: { app: 'Humanity', head: 'finalized', how: 'card/Score read every 12 s; current-game finalized poll 30 s (3 s with live sign-up record); socket key is data-arrival proxy' },
      start, end: shown.at, actions: labActions, verification: checked.verification, includedBlock: chain.includedBlock, includedRetracted: chain.includedRetracted, finalizedBlock: chain.finalizedBlock,
      points: [{ name: 'best attendance record', at: chain.included }, { name: 'lab-observed finality, upper bound', at: chain.finalized }, { name: 'chain to data', at: data }],
      beside: [{ name: 'best to lab-observed finality, upper bound (full clock)', ms: chain.finalized === undefined ? null : chain.finalized - chain.included }, { name: 'end of play to best attendance record', ms: chain.included - endOfPlay }, { name: 'end of play to lab-observed finalized attendance record, upper bound', ms: chain.finalized === undefined ? null : chain.finalized - endOfPlay }, { name: 'best attendance record to Humanity', ms: shown.at - chain.included }, { name: 'Jollity result screen to Humanity', ms: shown.at - resultAt },
        { name: 'return tap to navigation', ms: navigation.at - exitTap }, { name: 'lab navigation overhead', ms: followMark.start - navigation.at },
        { name: 'lab next-game setup before play (excluded)', ms: scheduleEnd - scheduleStart },
        ...(labCardDisplay ? [{ name: 'lab card-display control', ms: labCardDisplay.done - labCardDisplay.at }] : [])] });
    raw = { firstPlayReturn, comparisonCoverage, updatePromotion: raw.updatePromotion, versionRequestsAfter: state.versionFile ? [...state.versionFile.requests] : undefined, background: raw.background, labActions, nameClaimAction, labCardDisplay, gameEnded, timeCheck, retimedTimes, beforeReturnDocuments, start, endOfPlay, returnBreakdown, chain, peerPlay, play, resultAt, prepared, returnFlowStart, returnControls, exitControl, exitTap, returned, navigation, follow: followMark, scheduleStart, scheduleEnd, schedule,
      rendered: shown, data: data ?? null, times, beforeTimes, score: await state.chain.score(actor.game.address) };
    save(value, raw);
    console.log(commentSection([returnBreakdown]));
    writeFileSync(join(output(), `return-C4-${run}.md`), commentSection([returnBreakdown]));
    await lab.attach(jsonEvidence({ breakdown: value, raw }));
  } catch (error) { writeFileSync(join(output(), `failed-C4-${run}.json`), JSON.stringify(jsonEvidence({ ...raw, media: /Every media player must vote/.test(String(error)) ? await mediaDiagnostics().catch(() => null) : null, ...await diagnostics(), error: String(error), chainStatus: watch.status(), startupLog: state.crossAppLog }), null, 2)); throw error; }
  finally { watch.stop(); state.network.frameProbes.delete(scoreProbe.listener); }
}, { timeoutMs: 25 * 60_000 });

step('Ada sees Jollity show her registered seat', async ({ lab }) => {
  let allowed = false;
  const seen = await until('Jollity registered seat', async () => {
    const path = await readWatchedText(jolly().page, () => location.pathname);
    if (path === '/permissions' && !allowed) { allowed = true; await jolly().page.getByRole('button', { name: 'Allow access', exact: true }).click({ timeout: 5000 }); }
    const m = await documentMarks(jolly().page);
    const registered = await readWatchedText(jolly().page, () => document.querySelector('[data-testid="home-status"]')?.textContent?.trim() === "You're in");
    return registered ? m : undefined;
  }, 300_000);
  await lab.attach(jsonEvidence(seen));
}, { timeoutMs: 320_000 });


const mediaPeersStepMs = 10 * 60_000, adaMediaRegistrationStepMs = 5 * 60_000;
step('2 real Jollity media peers register through their own screens', async ({ lab }) => {
  // A failed check's diagnosis ends before this step's own timeout, so the step fails on the check's error.
  const endsAt = Date.now() + mediaPeersStepMs, state = s(), peers = await state.createMediaPeers();
  const views = peers.map(peer => ({ name: peer.name, account: peer.game.address, page: peer.page }));
  for (const peer of peers) {
    await lab.attach(await withMediaRegistrationEvidence(evidence => lab.attach(evidence), () => registerMediaPlayer(peer.page, peer.game, state.chain, views, { endsAt })));
  }
}, { timeoutMs: mediaPeersStepMs });

step('Ada registers for the game through her Jollity screen', async ({ lab }) => {
  const endsAt = Date.now() + adaMediaRegistrationStepMs, state = s(), actor = state.actor(), funding = await state.chain.fundingCalls([actor.game]);
  if (funding.length) await state.chain.batch('Fund Ada before her media game UI registration', funding);
  await state.chain.checkpoint('Ada funding before media game registration');
  await lab.attach(await withMediaRegistrationEvidence(evidence => lab.attach(evidence), () => registerMediaPlayer(jolly().page, actor.game, state.chain, [], { endsAt })));
}, { timeoutMs: adaMediaRegistrationStepMs });
