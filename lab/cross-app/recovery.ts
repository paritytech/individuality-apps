// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { step } from '@parity/product-lab/steps';
import { scenario } from '../shared/session.ts';
import { flowStorage } from '../shared/storage.ts';
import { readWatchedText } from '../shared/watched-text.ts';
import { formattedDate, jsonEvidence } from '../shared/observations.ts';
import { call } from '../shared/chain-plan.ts';
import { dismissCautionSheet } from '../shared/home.ts';
import { FrameProbe, RegistrationWatch } from './chain-watch.ts';
import type { DocumentMarks } from './journey-observations.ts';
import { sharedDateTimeline } from './journey-observations.ts';
import { currentReady, missedView, registeredView, fixtureAttendanceIndex, relativeObservation, jollityNextDate } from './recovery-observations.ts';
import { freezeApp } from './lifecycle.ts';
import { journeyBreakdown, label } from './timing.ts';
import { save, output, capMs } from './steps.ts';
import { jollityGameAt } from './jollity-time.ts';

const s = scenario;
const page = (app: 'humanity' | 'jollity') => app === 'humanity' ? s().actor().view.page : s().actor().jollity!.page;
const marks = (app: 'humanity' | 'jollity') => readWatchedText(page(app), () => (window as unknown as { __crossJourney: DocumentMarks }).__crossJourney);
async function guard() {
  for (const app of ['humanity', 'jollity'] as const) {
    const text = await readWatchedText(page(app), () => document.body.innerText);
    if (/A new version is out|native PAS|request.*PAS/i.test(text ?? '')) throw Error('Unexpected update or native PAS request');
  }
}
async function keyProbe(app: 'humanity' | 'jollity', pallet: string, item: string) {
  const query = s().people.access.client.getUnsafeApi().query as unknown as Record<string, Record<string, { getKey(key: unknown): Promise<string> }>>;
  const key = await query[pallet][item].getKey({ type: 'Account', value: s().actor().game.address });
  const probe = new FrameProbe(new URL(s().apps[app]!).origin, key); s().network.frameProbes.add(probe.listener); return probe;
}
async function ready(app: 'humanity' | 'jollity', from: number, matches: Parameters<typeof currentReady>[2], actions: Array<{ at: number; done: number; name: string }> = [], dismiss = false) {
  let candidate: number | undefined, seen = 0;
  return s().chain.until(`${app} correct stable view`, async () => {
    await guard();
    if (app === 'humanity' && dismiss) {
      const at = Date.now();
      if (await dismissCautionSheet(page(app))) actions.push({ at, done: Date.now(), name: 'lab caution sheet Not this week' });
    }
    const document = await marks(app), at = document ? currentReady(document.views, from, matches) : undefined;
    if (at === undefined) { candidate = undefined; return undefined; }
    if (at !== candidate) { candidate = at; seen = Date.now(); }
    return Date.now() - seen >= 1000 ? { at, document: document! } : undefined;
  }, capMs);
}

step('Ada misses the registered game, {word} run {string}', async ({ lab }, mode, run) => {
  if (mode !== 'C5' && mode !== 'B1') throw Error('Unknown no-show mode');
  const state = s(), actor = state.actor(), game = state.chain.current; if (!game) throw Error('No game');
  const priorScore = await state.chain.score(actor.game.address), seed = fixtureAttendanceIndex(game.index, priorScore.value.last_attended_game);
  if (seed !== undefined) {
    await state.chain.batch('Align synthetic member history before measured game', [call('Score', 'force_set_attendance', { who: { type: 'Account', value: actor.game.address }, attended: true, game_index: seed })]);
    await state.chain.checkpoint('synthetic member history aligned');
    if ((await state.chain.score(actor.game.address)).value.last_attended_game !== game.index - 1) throw Error('Synthetic history did not end before the measured game');
  }
  const fixture = { before: priorScore, seededAttendedIndex: seed ?? null, measuredGame: game.index, measuredAbsenceForced: false };
  const actions: Array<{ at: number; done: number; name: string }> = [];
  const humanProbe = await keyProbe('humanity', 'Score', 'Participants'), jollyProbe = await keyProbe('jollity', 'Game', 'Players');
  const baseline = await Promise.all([marks('humanity'), marks('jollity')]);
  const nextDate = Math.floor(Date.now() / 1000) + 3600;
  const setupAt = Date.now();
  await state.chain.batch('Schedule next game before measured no-show', [call('Game', 'schedule_games', { games_schedules: [{ game_play_time: nextDate, rounds: 1, max_group_size: 4, airdrops: [] }] })]);
  await state.chain.checkpoint('next schedule finalized');
  const setupDone = Date.now();
  const watch = new RegistrationWatch(state.people, actor.game.address, 200, async hash => {
    const score = await flowStorage(state.people.access, 'Score', 'Participants', [{ type: 'Account', value: actor.game.address }], hash) as { streak?: { type: string }; last_attended_game?: number } | undefined;
    const current = await flowStorage(state.people.access, 'Game', 'Game', [], hash) as { index: number } | undefined;
    return score?.streak?.type === 'Absent' && score.last_attended_game !== game.index && current?.index !== game.index;
  }).start();
  let frozen: Awaited<ReturnType<typeof freezeApp>> | undefined;
  let raw: Record<string, unknown> = { game: { ...game }, fixture, baseline, nextDate, setupAt, setupDone };
  try {
    const beforePlay = Date.now();
    if (mode === 'B1') frozen = await freezeApp('humanity');
    // Ada sends no game report. Only the two bots report; the repository advances local reporting deadlines.
    const play = (async () => {
      const players = [actor.game, ...state.bots];
      await state.chain.startReporting(game.index, players);
      const group = await state.chain.games.shuffledGroup(players), botReportsAt = Date.now();
      await Promise.all(state.bots.map(bot => state.chain.games.reportFrom(bot, group, [actor.game])));
      await state.chain.transactions.finalizePending();
      const current = (await state.chain.setupRead('Game', 'Game')).value as { index: number; state: { type: string } } | undefined;
      if (current?.index === game.index && current.state.type === 'Reporting')
        await state.chain.batch('End reporting for registered no-show', [call('Game', 'testnet_force_end_reporting')]);
      await state.chain.checkpoint('no-show result finalized');
      // A following game may be promoted in the same block. Requiring Game=None would wait for that following game too.
      const proof = await state.chain.until('indexed finalized no-show GameEnded', () => state.chain.findEvent(game.fromBlock, event => {
        const e = event as { type?: string; value?: { type?: string; value?: { index?: number } } };
        return e.type === 'Game' && e.value?.type === 'GameEnded' && e.value.value?.index === game.index;
      }), capMs);
      state.chain.ended = game; state.chain.current = undefined;
      return { ...proof, botReportsAt, adaReports: 0 };
    })();
    let recovery: Awaited<ReturnType<NonNullable<typeof frozen>['resume']>> | undefined;
    if (frozen) {
      await state.chain.until('best no-show result before foreground', async () => watch.status().includedBlock ? true : undefined, capMs);
      recovery = await frozen.resume();
    }
    Object.assign(raw, { recovery, beforePlay });
    const from = recovery?.foreground ?? beforePlay;
    const humanDate = await formattedDate(page('humanity'), nextDate);
    const jollyDate = await jollityGameAt(page('jollity'), nextDate);
    const humanShown = ready('humanity', from, v => missedView(v, game.index) && v.humanity === humanDate, actions, true);
    // Jollity has no missed-game history on home: it must leave the old registered seat and show the next game.
    const jollyDateShown = ready('jollity', beforePlay, v => jollityNextDate(v, actor.game.address, jollyDate));
    const jollyShown = ready('jollity', beforePlay, v => v.account === actor.game.address && ['Next game', 'Top up to play'].includes(v.status!) && [`Game starts at ${jollyDate}`, `Game at ${jollyDate}`, `at ${jollyDate}`].includes(v.jollity!));
    const humanNext = ready('humanity', from, v => !v.blocked && !v.update && v.humanity === humanDate && Boolean(v.cardName), actions);
    const [gameEnded, chain, humanity, jollity, next, jollityDate] = await Promise.all([play, watch.marks(state.people.signal, capMs), humanShown, jollyShown, humanNext, jollyDateShown]);
    const score = await state.chain.score(actor.game.address);
    if (score.value.streak.type !== 'Absent' || score.value.last_attended_game === game.index) throw Error('Finalized score is not the measured no-show');
    const documents = [humanity.document, jollity.document];
    const oldHuman = await formattedDate(page('humanity'), game.playsAt);
    const oldJolly = baseline[1]?.views.at(-1)?.view.jollity?.replace(/^(?:Game starts at |Game at |at )/, '') ?? '';
    const timeCheck = sharedDateTimeline([...baseline, ...documents].flatMap((d, i) => (d?.views ?? []).map(v => ({ ...v, app: i % 2 === 0 ? 'humanity' as const : 'jollity' as const }))), [{ date: game.playsAt, humanity: oldHuman, jollity: oldJolly }, { date: nextDate, humanity: humanDate, jollity: jollyDate }]);
    raw = { ...raw, beforePlay, gameEnded, chain, humanity, jollity, jollityDate, next, score, actions, recovery, timeCheck, probes: { humanity: humanProbe.hits, jollity: jollyProbe.hits }, jollityMissedView: { source: 'app/page.tsx missed gate is for a nonparticipant, not a persistent history panel', observed: jollity.document.views.filter(v => v.at >= beforePlay && v.view.jollityMissed), endpoint: 'Exact account and next game with its actual available action/funding state' } };
    const endpoints = [
      ['humanity-missed', humanity, 'Humanity', 'finalized', humanProbe], ['humanity-next', next, 'Humanity', 'finalized', humanProbe], ['jollity-next-action', jollity, 'Jollity', 'best', jollyProbe], ['jollity-next-date', jollityDate, 'Jollity', 'best', jollyProbe],
    ] as const;
    const observations = endpoints.map(([endpoint, shown, app]) => ({ endpoint, app, originKind: app === 'Humanity' && recovery ? 'foreground' : 'lab-observed best game-end result', shownAt: shown.at, origin: app === 'Humanity' && recovery ? recovery.foreground : chain.included,
      ...relativeObservation(app === 'Humanity' && recovery ? recovery.foreground : chain.included, shown.at, chain.finalized) }));
    appendFileSync(join(output(), 'observations.jsonl'), JSON.stringify(jsonEvidence({ mode, run, observations, raw })) + '\n');
    const comment = `\n## ${mode} run ${run}, two-host topology signed clocks\n\nLab-observed finality is an upper bound. A negative offset is a visible lead, not a forward latency.\n\n| Endpoint | UI minus origin | Label | UI minus lab finality (upper bound) |\n| --- | ---: | --- | ---: |\n` + observations.map(o => `| ${o.endpoint} | ${(o.offsetMs / 1000).toFixed(3)} s | ${o.forwardMs === null ? 'before lab origin; latency unmeasured' : label(o.forwardMs)} | ${o.finalizedOffsetMs === null ? 'unmeasured' : (o.finalizedOffsetMs / 1000).toFixed(3) + ' s'} |`).join('\n') + '\n';
    appendFileSync(join(output(), 'observations.md'), comment); console.log(comment);
    for (const [endpoint, shown, app, head, probe] of endpoints) {
      const start = app === 'Humanity' && recovery ? recovery.foreground : chain.included;
      if (shown.at < start) continue; // Signed lead is preserved above; there is no forward interval to break down.
      const value = journeyBreakdown({ direction: recovery && app === 'Humanity' ? 'B1' : 'C5', metric: mode === 'B1' && app === 'Jollity' ? `background-companion-${endpoint}` : endpoint, run: `${mode}-${run}-${endpoint}`, reader: { app, head, how: app === 'Humanity' ? 'Score finalized snapshot every 12 s; next-game finalized poll 30 s (3 s with local signup); received-key frame is only a proxy' : 'best-head game/player subscriptions; no missed history on home' }, start, end: shown.at, endName: 'state readiness after data proxy (mixed wait; pure render unmeasured)',
        actions, points: [{ name: 'foreground to active', at: app === 'Humanity' && recovery ? recovery.activeAt : start }, { name: 'data arrival proxy', at: probe.first(start) }],
        beside: [{ name: 'lab-observed finality, upper bound', ms: chain.finalized === undefined ? null : chain.finalized - chain.included },
          { name: 'UI relative to lab-observed finality (upper bound; signed offset in raw)', ms: chain.finalized === undefined || shown.at < chain.finalized ? null : shown.at - chain.finalized },
          { name: 'next schedule setup excluded', ms: setupDone - setupAt }, ...actions.map(a => ({ name: a.name, ms: a.done - a.at }))], includedBlock: chain.includedBlock, includedRetracted: chain.includedRetracted, finalizedBlock: chain.finalizedBlock });
      save(value, raw);
    }
    state.chain.next = { game_play_time: nextDate, finalizedAtMs: setupDone };
    await lab.attach(jsonEvidence(raw));
  } catch (error) {
    await frozen?.close();
    writeFileSync(join(output(), `failed-${mode}-${run}.json`), JSON.stringify(jsonEvidence({ ...raw, error: String(error), watch: watch.status(), documents: await Promise.all([marks('humanity'), marks('jollity')]) }), null, 2)); throw error;
  } finally { await frozen?.close(); watch.stop(); state.network.frameProbes.delete(humanProbe.listener); state.network.frameProbes.delete(jollyProbe.listener); }
}, { timeoutMs: 25 * 60_000 });

step('Ada backgrounds Jollity before registration, B3 run {string}', async ({ lab }, run) => {
  const state = s(), actor = state.actor(), probe = await keyProbe('jollity', 'Game', 'Players');
  const before = await marks('jollity'), frozen = await freezeApp('jollity');
  try {
    await state.chain.enroll([actor.game], [actor.game, ...state.bots]); await state.chain.checkpoint('registration included while frozen');
    const recovery = await frozen.resume();
    const shown = await ready('jollity', recovery.foreground, v => registeredView(v, actor.game.address));
    const value = journeyBreakdown({ direction: 'B3', run: String(run), reader: { app: 'Jollity', head: 'best', how: 'watchPlayer best subscription; received-key frame is only a proxy' }, start: recovery.foreground, end: shown.at,
      points: [{ name: 'foreground to active', at: recovery.activeAt }, { name: 'data arrival proxy', at: probe.first(recovery.foreground) }] });
    const raw = { before, recovery, shown, probeHits: probe.hits }; save(value, raw); await lab.attach(jsonEvidence(raw));
  } finally { await frozen.close(); state.network.frameProbes.delete(probe.listener); }
}, { timeoutMs: 15 * 60_000 });

/** Humanity is frozen while Ada is on Jollity's post-game screen, before its return CTA. */
export async function backgroundHumanityAfterGame(game: number, date: number, watch: RegistrationWatch, probe: FrameProbe, run: string) {
  const before = await marks('humanity'), frozen = await freezeApp('humanity');
  try {
    await s().chain.until('lab-observed finalized attendance record while Humanity frozen', async () => watch.status().finalizedBlock ? true : undefined, capMs);
    const recovery = await frozen.resume(), expected = await formattedDate(page('humanity'), date);
    const shown = await ready('humanity', recovery.foreground, v => Boolean(v.cardName && v.humanity === expected && v.attendance?.some(t => t?.endsWith(`(game ${game})`))));
    const value = journeyBreakdown({ direction: 'B2', run, reader: { app: 'Humanity', head: 'finalized', how: 'card 12 s; next-game finalized 30 s (3 s with local signup); received-key frame is only a proxy' }, start: recovery.foreground, end: shown.at,
      points: [{ name: 'foreground to active', at: recovery.activeAt }, { name: 'data arrival proxy', at: probe.first(recovery.foreground) }] });
    const raw = { before, recovery, shown, probeHits: probe.hits }; save(value, raw); return raw;
  } finally { await frozen.close(); }
}
