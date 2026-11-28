// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE SIGNING HOST LOSES ITS CHAIN (platform-bugs #76): the host-chain-lost persona's cut, scoped to ONE PROCESS. The Polkadot
// app's cached follow subscription dies ("cannot get the current block … subscription dropped"), so every createTransaction
// and ring-VRF proof fails while the app's own chain reads go on. truapi-host has no RPC override (its --network is an enum),
// so the cut is made at the OS level by netem.sh host-chain-cut: the host's pid moves into its own cgroup v2, iptables
// -m cgroup REJECTs its new connects for `holdS`, ss -K kills its established sockets, then the probes watch the rest of the
// window for its reconnect. Nothing else on the runner is cut.
//
// WHICH APP MATTERS. app=local (next dev) bakes NEXT_PUBLIC_PEOPLE_WS, so the browser holds its own socket to the People RPC and
// keeps reading through the cut: that is the #76 split, and netem.sh proves the browser's socket survived. The DEPLOYED app reads
// the chain THROUGH the host (getHostProvider; devlog "People chain genesis" via discovery, game a live run), so there the
// cut takes the app's reads too, and netem.sh says the browser held no socket of its own instead of calling that a pass.
//
// THE SEAM. boot.mts holds the host process; the journey knows WHEN (the sign-up, the confirm stage). boot writes the host's pid
// to <out>/host-pid-<n> once the host is ready (only for a plan that has a host-chain cut); the journey's netem runner appends
// that file, the host's log and an in-force marker to the call, and waits for the marker before it taps Register. Pure helpers
// here are vitest-pinned (host-chain-cut.test.ts).
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Check } from "./chain-checks"
import type { NetemCall, NetworkPlan } from "./network"

export const hostPidFile = (out: string, n: number): string => join(out, `host-pid-${n}`)
export const hostLogFile = (out: string, n: number): string => join(out, `slot-${n}.log`)
export const inForceFile = (out: string, n: number): string => join(out, `host-chain-cut-${n}.in-force`)

export const isHostChainCut = (call: NetemCall): boolean => call[0] === "host-chain-cut"
export const isHostChainHang = (call: NetemCall): boolean => call[0] === "host-chain-hang"
export const isHostChainOperation = (call: NetemCall): boolean => isHostChainCut(call) || isHostChainHang(call)

/** The plan with every host-chain cut dropped (a step left with no call goes too): what a run on a deployed app plays, so the
 *  network-timeline proof never waits for a cut that must not fire there. */
export function withoutHostChainCuts(plan: NetworkPlan): NetworkPlan {
  const keep = (steps: NetworkPlan["timeline"]) => steps.flatMap((s) => {
    const calls = s.calls.filter((c) => !isHostChainCut(c))
    return calls.length ? [{ ...s, calls }] : []
  })
  return { start: plan.start, timeline: keep(plan.timeline), atOpen: keep(plan.atOpen) }
}

/** Whether any step uses the legacy socket-killing host-chain cut. */
export const planHasHostChainCut = (plan: NetworkPlan): boolean => [...plan.timeline, ...plan.atOpen].some((s) => s.calls.some(isHostChainCut))

/** Whether any step targets the host process's chain. boot.mts writes the pid file for both the legacy cut and a true hang. */
export const planHasHostChainOperation = (plan: NetworkPlan): boolean => [...plan.timeline, ...plan.atOpen].some((s) => s.calls.some(isHostChainOperation))

/** The call as netem.sh takes it: the plan's [verb, windowS, holdS, host] plus the slot's pid file, host log and in-force marker.
 *  One slot per CI runner; a desk with several slots cuts the first one's host. Any other call passes through unchanged. */
export function withHostTargets(call: NetemCall, out: string, slot: number): NetemCall {
  if (!isHostChainOperation(call)) return call
  return [...call, hostPidFile(out, slot), hostLogFile(out, slot), inForceFile(out, slot)] as NetemCall
}

/** Why a cut of `windowS` starting now cannot fit before `endsAt` with `marginS` to spare (chain seconds), or null when it fits.
 *  The sign-up window must leave time to sign up after the cut; the confirm window must end before the reports close. */
export function cutDoesNotFit(windowS: number, chainNowS: number, endsAt: number, marginS: number, what: string): string | null {
  const left = endsAt - chainNowS
  return left >= windowS + marginS ? null : `${what} closes in ${Math.round(left)} s, a ${windowS} s host-chain cut needs ${windowS + marginS} s (${marginS} s to spare)`
}

/** The hold of the first host-chain cut among `calls` (its holdS argument), or null. */
export const cutHoldS = (calls: readonly NetemCall[]): number | null => {
  const c = calls.find(isHostChainCut)
  return c ? Number(c[2]) : null
}

/** THE CONFIRM CUT'S TRIGGER: the start of the SECOND-TO-LAST turn the page shows. Votes are local, so nothing in a turn needs the
 *  signing host's chain; a turn earlier than the last puts the cut in force well before the app's own auto-confirm builds the
 *  report (confirm stage + CONFIRM_SETTLE 1.5 s + AUTO_CONFIRM_SEC 7 s, lib/game-session.ts), with no race. From the earlier
 *  start (confirm - 2 turns = confirm - 24 s, in force a few seconds later) the 45 s refusal reaches about confirm + 21..25 s and
 *  the 60 s window about confirm + 36..40 s, so both span the report's first build at about confirm + 9 s. */
export const confirmCutDue = (turn: number, turnsInGame: number): boolean => turn >= turnsInGame - 1
/** The chain-clock fallback for the same moment: the second-to-last turn starts two turns before the last one ends. */
export const confirmCutChainAt = (gameEnd: number, turnS: number): number => gameEnd - 2 * turnS

/** The window of the first host-chain cut among `calls` (its windowS argument), or null. */
export const cutWindowS = (calls: readonly NetemCall[]): number | null => {
  const c = calls.find(isHostChainCut)
  return c ? Number(c[1]) : null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait until netem.sh says the cut is in force (its marker file), at most `timeoutMs`. False on timeout. */
export async function waitInForce(out: string, slot: number, timeoutMs: number, exists: (p: string) => boolean = existsSync, pollMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exists(inForceFile(out, slot))) return true
    await sleep(pollMs)
  }
  return exists(inForceFile(out, slot))
}

/** How long netem.sh may take from its start to the kill (three DNS lookups, a 4 s before-probe, sudo, the cgroup move and the
 *  rules). A LOCAL wait on the runner's own tooling, not a game time: it bounds how long a tap waits for the marker, and the
 *  game's own deadline (the registration close, the report close) still caps it. */
export const CUT_SETUP_MS = 20_000

/** The app under test reads the chain over its OWN socket only as app=local (next dev bakes NEXT_PUBLIC_PEOPLE_WS). A deployed
 *  bundle reads THROUGH the host, so cutting the host cuts the app too: the persona proves nothing there. Null when it applies. */
export function hostChainInapplicable(app: string): string | null {
  return app === "local" ? null : `the app under test is ${app}, which reads the chain THROUGH the host (getHostProvider), so a host-chain cut also cuts the app's reads: host-chain-lost is only meaningful with app=local`
}

/** One moment's cut as the journey sees it: armed (it will fire), fired, in force (netem.sh's marker seen). */
export class CutWatch {
  firedAtMs: number | null = null
  inForceAtMs: number | null = null
  constructor(
    /** the cut will fire this game (the plan has it, the app is local, the runner is shaped); disarm() when it will not */
    public armed: boolean,
    /** wall ms of the game's own deadline (registration close, report close minus a turn): a tap stops waiting there, and the
     *  in-force marker is polled until then (the 20 s CUT_SETUP_MS bounds the TAP only, never the marker watch) */
    readonly deadlineMs: number,
    /** how long netem.sh refuses the host's connects once in force (the cut's holdS), when known */
    readonly holdMs: number | null = null,
  ) {}
  /** the cut will not fire after all (it does not fit the game's window): stop holding taps for it */
  disarm(): void {
    if (this.firedAtMs === null) this.armed = false
  }
  fired(nowMs: number): void {
    this.firedAtMs ??= nowMs
  }
  inForce(nowMs: number): void {
    this.inForceAtMs ??= nowMs
  }
  /** How long, from `nowMs`, to keep polling for the in-force marker: until the game's own deadline, never the setup bound. */
  markerWaitMs(nowMs: number): number {
    return Math.max(0, this.deadlineMs - nowMs)
  }
  /** May the bot tap now? Unarmed: always. Armed: once the cut is in force, or once it has had CUT_SETUP_MS since firing, or
   *  at the game's deadline (a tap that would miss the window is worse than an untested one, and the check says which). */
  gateOpen(nowMs: number): boolean {
    if (!this.armed || this.inForceAtMs !== null) return true
    if (nowMs >= this.deadlineMs) return true
    return this.firedAtMs !== null && nowMs - this.firedAtMs >= CUT_SETUP_MS
  }
}

/** The devLog line shape the checks read (record.ts LogLine, narrowed to what they need). */
export interface CutLogLine {
  ts: number
  tag: string
  message: string
}
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19)

/** CRITERION 3, LIVE: the first report attempt (the app's "report built" vote-trail line, the moment the report is built and
 *  handed to the signer) began AFTER the confirm cut was in force; otherwise the report was never tested against a lost chain.
 *  The chain's ReportSubmitted in (d) says whether it then landed. #491's "report retry" lines are counted when the build has them. */
export function reportAfterCutCheck(n: number, lines: readonly CutLogLine[], watch: CutWatch): Check {
  const name = `player ${n} host-chain cut: the report was filed under the cut`
  if (!watch.armed) return { name, status: "unchecked", detail: "the confirm cut was not armed this game" }
  if (watch.inForceAtMs === null) return { name, status: "fail", detail: watch.firedAtMs === null ? "the confirm cut never fired" : `the confirm cut fired at ${hhmmss(watch.firedAtMs)} UTC but never came into force` }
  if (lines.length === 0) return { name, status: "unchecked", detail: "no devLog lines exported: the report attempt's time is unknown" }
  const built = lines.filter((l) => l.tag === "vote" && l.message === "report built").sort((a, b) => a.ts - b.ts)
  const retries = lines.filter((l) => l.tag === "vote" && l.message === "report retry").length
  const failed = lines.filter((l) => l.tag === "vote" && l.message === "report attempt failed").length
  if (!built.length) return { name, status: "fail", detail: `no "report built" line: the app never built its report (cut in force at ${hhmmss(watch.inForceAtMs)} UTC)` }
  const first = built[0].ts
  const gap = Math.round((first - watch.inForceAtMs) / 100) / 10
  if (first < watch.inForceAtMs) return { name, status: "fail", detail: `the first report attempt (${hhmmss(first)} UTC) came ${-gap} s BEFORE the cut was in force: the report was not tested against a lost chain` }
  if (watch.holdMs !== null && first > watch.inForceAtMs + watch.holdMs) return { name, status: "fail", detail: `the first report attempt came ${gap} s after the cut was in force, after its ${watch.holdMs / 1000} s refusal ended: the host could already reconnect, so the report was not tested against a lost chain` }
  return { name, status: "pass", detail: `the first report attempt came ${gap} s after the cut was in force; ${failed} failed attempt(s), ${retries} retry(ies) logged${retries === 0 && failed === 0 ? " (this build may predate #491's report retry lines)" : ""}` }
}

/** A sign-up ATTEMPT starting, in the app's devLog: each attempt reads its route first (game-source.ts devLog("signup",
 *  `route: <path>`)), and a retry says so ("sign-up goes again (attempt N)"). */
const isSignUpAttempt = (l: CutLogLine) => l.tag === "signup" && (l.message.startsWith("route: ") || l.message.startsWith("sign-up goes again"))

/** The sign-up cut, judged after the fact: it came into force (by the registration close, not by the tap's 20 s bound), and an
 *  attempt met it. A Register tap after the marker meets it by construction. A tap BEFORE the marker is INCONCLUSIVE unless the
 *  devLog shows a sign-up attempt (the first one, or a retry) starting at or after the marker and inside its refusal; the same
 *  standard reportAfterCutCheck holds the report to. */
export function signUpCutCheck(n: number, watch: CutWatch, tapAtMs: number | null, lines: readonly CutLogLine[] = []): Check {
  const name = `player ${n} host-chain cut: the sign-up cut came into force`
  if (!watch.armed) return { name, status: "unchecked", detail: "the sign-up cut was not armed this game" }
  if (watch.firedAtMs === null) return { name, status: "fail", detail: "the sign-up cut never fired" }
  if (watch.inForceAtMs === null) return { name, status: "fail", detail: `the sign-up cut fired at ${hhmmss(watch.firedAtMs)} UTC but was not in force before registration closed` }
  const inForce = watch.inForceAtMs
  const s = (ms: number) => Math.round(ms / 100) / 10
  const setup = `in force ${s(inForce - watch.firedAtMs)} s after it fired`
  if (tapAtMs === null) return { name, status: "inconclusive", detail: `${setup}; no Register tap recorded` }
  if (tapAtMs >= inForce) return { name, status: "pass", detail: `${setup}; Register tapped ${s(tapAtMs - inForce)} s after it` }
  const attempts = lines.filter(isSignUpAttempt).sort((a, b) => a.ts - b.ts)
  const until = watch.holdMs === null ? Infinity : inForce + watch.holdMs
  const met = attempts.find((l) => l.ts >= inForce && l.ts <= until)
  const before = `Register tapped ${s(inForce - tapAtMs)} s BEFORE it`
  if (!met) return { name, status: "inconclusive", detail: `${setup}; ${before}, and ${attempts.length ? `none of the ${attempts.length} sign-up attempt(s) in the devLog started under the refusal` : "the devLog shows no sign-up attempt"}: no evidence any attempt met the lost chain` }
  const which = met === attempts[0] ? "the first sign-up attempt" : `a retry (attempt ${attempts.indexOf(met) + 1} of ${attempts.length})`
  return { name, status: "pass", detail: `${setup}; ${before}, but ${which} started ${s(met.ts - inForce)} s after it, under the refusal` }
}

/** CRITERION 2's "never during a round", LIVE: no "restart card shown" (tag chain, #491/#492) between the first and the last turn
 *  the page showed. A build without the pre-game chain check logs no "health <where>: <outcome>" line at all, and then this is
 *  UNCHECKED, never a vacuous pass. */
export function cardNeverInRoundCheck(n: number, lines: readonly CutLogLine[], round: { fromMs: number; toMs: number } | null): Check {
  const name = `player ${n} host-chain cut: the restart card never shows during a round`
  const health = lines.filter((l) => l.tag === "chain" && l.message.startsWith("health "))
  if (!health.length) return { name, status: "unchecked", detail: lines.length ? "this build logs no pre-game chain check (#491/#492 are not in it)" : "no devLog lines exported" }
  if (!round) return { name, status: "unchecked", detail: "the page never showed a turn" }
  const cards = lines.filter((l) => l.tag === "chain" && l.message === "restart card shown")
  const inRound = cards.filter((l) => l.ts >= round.fromMs && l.ts <= round.toMs)
  if (inRound.length) return { name, status: "fail", detail: `${inRound.length} restart card(s) shown during the round, first at ${hhmmss(inRound[0].ts)} UTC` }
  return { name, status: "pass", detail: `${health.length} chain check(s), ${cards.length} restart card(s), none between ${hhmmss(round.fromMs)} and ${hhmmss(round.toMs)} UTC` }
}

/** WHAT THE HOME SHOWED while a sign-up met the cut, read from the page's text. The restart card is #491's MessageScreen on the home
 *  (data-testid="chain-restart", heading "Restart the Polkadot app"; lib/chain-health.ts, app/page.tsx). */
/** Mirrors the unexported HOST_CHAIN_NOTICE in apps/jollity-app/lib/registration/register-button.ts (host-chain-cut.test.ts reads that file and
 *  fails if the text drifts). */
export const HOST_CHAIN_NOTICE = "The Polkadot app lost its connection to the chain. Close the Polkadot app completely and open Jollity again."
/** The older "taking longer" line under the Join button. The app here has no such line (its "slow" sign-up phase hides the button without a
 *  notice, register-button.ts), so the "slow" screen is not seen against it; the wording stays for apps that still show it. */
export const SLOW_NOTICE = "This is taking longer than usual. We're still trying."
export type SignUpScreen = "restart-card" | "chain-notice" | "missed" | "slow" | "registering" | "other"
export const RESTART_CARD_TESTID = "chain-restart"
/** `text` is the page's body text with whitespace already collapsed (the one place that normalises it is the page read). */
export function classifySignUpScreen(text: string, cardPresent: boolean): SignUpScreen {
  if (cardPresent || /Restart the Polkadot app/i.test(text)) return "restart-card"
  // the in-place line under the Register button (lib/registration/register-button.ts), the same message as the card
  if (text.includes(HOST_CHAIN_NOTICE)) return "chain-notice"
  if (/You missed this one/i.test(text)) return "missed"
  if (text.includes(SLOW_NOTICE)) return "slow"
  if (/Joining…/.test(text)) return "registering"
  return "other"
}

/** The sign-up screens one page showed, with wall times. See() is fed once per poll by the Register loop. */
export class SignUpScreenWatch {
  cardAtMs: number | null = null
  /** first time HOST_CHAIN_NOTICE showed under the Register button, after the cut was in force */
  noticeAtMs: number | null = null
  registeringFirstMs: number | null = null
  registeringLastMs: number | null = null
  slowFirstMs: number | null = null
  slowLastMs: number | null = null
  missedAtMs: number | null = null
  last: SignUpScreen | null = null
  /** `inForceAtMs`: a screen before the cut is in force says nothing about the cut, so a card is counted only from then on. */
  see(nowMs: number, screen: SignUpScreen, inForceAtMs: number | null): void {
    this.last = screen
    if (screen === "restart-card" && inForceAtMs !== null && nowMs >= inForceAtMs) this.cardAtMs ??= nowMs
    if (screen === "chain-notice" && inForceAtMs !== null && nowMs >= inForceAtMs) this.noticeAtMs ??= nowMs
    if (screen === "missed") this.missedAtMs ??= nowMs
    if (screen === "registering" || screen === "slow" || screen === "chain-notice") {
      this.registeringFirstMs ??= nowMs
      this.registeringLastMs = nowMs
    }
    if (screen === "slow") {
      this.slowFirstMs ??= nowMs
      this.slowLastMs = nowMs
    }
  }
}

/** Whether the host came back, from netem.sh's own lines in netem.log (the FIRST cut's outcome, which is the sign-up's). */
export interface HostReconnect {
  reconnected: boolean | null
  afterS: number | null
}
export function hostReconnectFromLog(text: string): HostReconnect {
  for (const line of text.split("\n")) {
    const back = /the host reconnected to \S+ (\d+) s after the kill/.exec(line)
    if (back) return { reconnected: true, afterS: Number(back[1]) }
    if (/the host did NOT reconnect to \S+ within the \d+ s window/.test(line)) return { reconnected: false, afterS: null }
  }
  return { reconnected: null, afterS: null }
}

/** What netem.sh's outcome line says about the host, in words (unknown when it wrote none). */
export const describeHost = (host: HostReconnect): string =>
  host.reconnected === true ? `the host reconnected ${host.afterS} s after the kill` : host.reconnected === false ? "the host did NOT reconnect within the cut's window" : "whether the host reconnected is unknown (no netem outcome line)"

/** The registration closes this long after the journey's own deadline (journey.pw.ts closeAt = registrationEnds - 5 s). */
export const REGISTRATION_CLOSE_LAG_MS = 5000

/** THE SIGN-UP UNDER A DEAD HOST (platform-bugs #76, app issue #507): while registration is open and the signing host has lost its
 *  chain, no retry can sign, so the only useful thing the home can do is show the restart card. PASS: it showed after the cut was in
 *  force. FAIL: registration closed (or the window passed) without it, even when the host provably never reconnected, because that
 *  is the outcome #507 targets: never inconclusive. NOT APPLICABLE ("unchecked"): the cut did not come into force, or the sign-up
 *  landed with no card (the host recovered; signUpCutCheck and the (c) checks cover that path). UNCHECKED too when the stage ended
 *  (timeout, interrupt) at `nowMs` before the registration closed and the page never showed "You missed this one": the window was
 *  still open, so the absence of a card proves nothing. `landed` is THIS slot's own sign-up result, not the stage's. */
export function signUpRestartCardCheck(n: number, i: { watch: CutWatch; landed: boolean; screen: SignUpScreenWatch; host: HostReconnect; nowMs: number }): Check {
  const name = `player ${n} host-chain cut: under a host that lost its chain, the app told the player to restart the Polkadot app before registration closed`
  const { watch, screen: sc, host } = i
  if (!watch.armed) return { name, status: "unchecked", detail: "the sign-up cut was not armed this game" }
  if (watch.inForceAtMs === null) return { name, status: "unchecked", detail: "the sign-up cut never came into force, so the host never lost its chain (the sign-up cut check says why)" }
  const inForce = watch.inForceAtMs
  const s = (ms: number) => Math.round(ms / 100) / 10
  const afterCut = (ms: number) => `${s(ms - inForce)} s after the cut was in force`
  const hostSays = describeHost(host)
  const span = (a: number | null, b: number | null) => (a === null || b === null ? "never showed" : `showed for ${s(b - a)} s (from ${afterCut(a)})`)
  const shown = `"Joining…" ${span(sc.registeringFirstMs, sc.registeringLastMs)}; "taking longer than usual" ${span(sc.slowFirstMs, sc.slowLastMs)}`
  const told = [sc.cardAtMs !== null ? `the restart card (${afterCut(sc.cardAtMs)})` : null, sc.noticeAtMs !== null ? `HOST_CHAIN_NOTICE under the Register button (${afterCut(sc.noticeAtMs)})` : null].filter(Boolean)
  if (told.length) return { name, status: "pass", detail: `the app told the player to restart the Polkadot app: ${told.join(" and ")}; ${hostSays}; sign-up ${i.landed ? "landed" : "did not land"}; ${shown}` }
  if (i.landed) return { name, status: "unchecked", detail: `not applicable: the sign-up landed after the cut and no restart instruction was needed; ${hostSays}` }
  if (sc.missedAtMs === null && i.nowMs < watch.deadlineMs + REGISTRATION_CLOSE_LAG_MS) return { name, status: "unchecked", detail: `the stage ended before registration closed (${s(watch.deadlineMs + REGISTRATION_CLOSE_LAG_MS - i.nowMs)} s left) without the restart card showing: the window was still open; ${hostSays}; ${shown}` }
  const parts = [
    `${sc.missedAtMs !== null ? 'registration closed on "You missed this one"' : `the registration window passed (last screen: ${sc.last ?? "none read"})`} without the restart card or HOST_CHAIN_NOTICE ever showing (#507)`,
    sc.slowFirstMs !== null ? "only SLOW_NOTICE showed, which suggests the attempt hung rather than failing with the chain error" : "not even SLOW_NOTICE showed",
    hostSays,
    "sign-up did not land",
    shown,
  ]
  return { name, status: "fail", detail: parts.join("; ") }
}
