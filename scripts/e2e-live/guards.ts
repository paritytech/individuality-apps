// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE GUARD EVALUATOR, pure (vitest pins it in guards.test.ts). A profile's
// `expect` guards (profile.ts) are evaluated per bot against up to three
// sources of evidence, and every guard ends in one of FOUR states, never two:
//
//   pass           the evidence says it holds
//   fail           the evidence says it does not (turns the bot's result red)
//   pending        the guard is flagged `pending` in profiles.json: never
//                  evaluated, never a pass
//   not-evaluated  the evidence source was not available: no Sentry token, no
//                  vote trail, the page was gone. Said plainly, never a pass
//
// SOURCES. Page evidence (text guards), chain evidence (chain-report), wire
// evidence (store-rejection: the host's replies on the page's websocket,
// store-wire.ts) and devLog evidence (devlog: the app's own log lines, the
// page's export and the snapshots before a kill or reload) are gathered by the
// journey while the bot is alive; Sentry evidence (metric and
// event guards) after settlement by guards-cli.mts from a Sentry evidence reader's
// pull. A guard whose source is missing is "not-evaluated" with the reason.
import { describeGuard, type Guard, type Profile } from "./profile"
import { reportVerdicts, type Check, type FiledReport } from "./chain-checks"
import type { VoteTrail } from "./record"
import type { NetworkCallRun } from "./network"
import { detectSynchronizedPcFailure, parsePcTimeline, type PcTimelineLine } from "./pc-timeline"
import { priorityRefusals, rejectionsOf, wireSummary, type WireEvidence } from "./store-wire"

export type GuardStatus = "pass" | "fail" | "pending" | "not-evaluated"
export interface GuardResult {
  kind: Guard["kind"]
  description: string
  status: GuardStatus
  evidence: string
  note?: string
}

/** What one bot sent to Sentry, per name a guard asks about (a Sentry evidence reader; none is in this repository yet). */
export interface SentryEvidence {
  /** metric name -> every recorded point. Older evidence contains bare values. */
  metrics: Record<string, Array<number | { value: number; attrs: Record<string, string> }>>
  /** span name (journey or step) -> one attribute map per span seen */
  events: Record<string, Record<string, string>[]>
}
export type SentrySource = { ok: true; evidence: SentryEvidence } | { ok: false; reason: string }

const logFields = (message: string): Record<string, string> =>
  Object.fromEntries([...message.matchAll(/(?:^|\s)([A-Za-z][\w.-]*)=([^\s]+)/g)].map((match) => [match[1], match[2]]))

/** What the page showed: the guard texts that appeared at any moment (an observer, so a text that
 *  came and went is still caught), what it said at the end, and (when a network-switch persona
 *  takes one) the immediate post-switch sample. null = the page was gone. */
export interface PageEvidence {
  seen: string[]
  /** Every complete visible interval, on the page wall clock. Older
   * artifacts omit this and therefore cannot claim a timed exemption. */
  appearances?: { text: string; fromMs: number; toMs: number }[]
  /** Persona-scripted windows in which one exact negative text is expected.
   * An appearance outside every matching window still fails closed. */
  ignoreNeverTextWindows?: { text: string; fromMs: number; toMs: number }[]
  finalText: string
  afterNetworkText?: string
}

/** A warning can clear just after netem restores the link and the browser
 * receives the recovery edge. Keep that allowance explicit and small: text
 * which survives this margin still fails the ordinary never-shows guard. */
export const SCRIPTED_WARNING_RECOVERY_MARGIN_MS = 5_000
export const EXPECTED_NETWORK_ISOLATION_TEXT = "We couldn't connect you to anyone."
const SWITCHER_SCRIPTED_NEVER_TEXTS = new Set(["Your Polkadot app is stuck, restart it", "We couldn't connect you to anyone."])
const UDP_CUT_SCRIPTED_NEVER_TEXTS = new Set([EXPECTED_NETWORK_ISOLATION_TEXT])
const NO_SCRIPTED_NEVER_TEXTS = new Set<string>()

const scriptedNeverTexts = (profileName: string | undefined): ReadonlySet<string> => {
  if (profileName === "switcher-pixel6a-wifi-to-cell") return SWITCHER_SCRIPTED_NEVER_TEXTS
  // A 40 s transport cut deliberately outlasts the product's 30 s recovery
  // grace. The isolation notice is therefore correct during this one exact
  // fault, while host-restart advice remains a strict negative control.
  if (profileName === "udp-cut-40s") return UDP_CUT_SCRIPTED_NEVER_TEXTS
  return NO_SCRIPTED_NEVER_TEXTS
}

export const allowsScriptedNeverTextWindow = (profileName: string | undefined, text: string): boolean =>
  scriptedNeverTexts(profileName).has(text)

export function scriptedNeverTextWindows(profileName: string | undefined, runs: readonly NetworkCallRun[]): NonNullable<PageEvidence["ignoreNeverTextWindows"]> {
  const texts = scriptedNeverTexts(profileName)
  const verb = profileName === "switcher-pixel6a-wifi-to-cell" ? "blackout" : profileName === "udp-cut-40s" ? "udp-cut" : null
  if (verb === null || texts.size === 0) return []
  return runs
    .filter((run) => run.call[0] === verb && run.ok && !run.inconclusive)
    .flatMap((run) => [...texts].map((text) => ({ text, fromMs: run.startMs, toMs: run.endMs + SCRIPTED_WARNING_RECOVERY_MARGIN_MS })))
}
export interface ChainEvidence {
  account: string
  filed: FiledReport | undefined
  trail: VoteTrail | null
  /** The role-aware, per-turn stage-(d) oracle. Dynamic video roles cannot be
   * reduced to the last aggregate tile verdict without changing semantics. */
  oracle?: Check
  /** what the devLog export found, or why it found nothing (recorder.ts devLogNote): the reason a missing trail gives */
  trailNote?: string
}

/** The app's devLog lines the bot's page exported (recorder.ts), snapshots before a kill or reload merged in. */
export interface DevlogEvidence {
  lines: PcTimelineLine[]
  /** what the export found, or why it found nothing */
  note: string
}

const base = (g: Guard) => ({ kind: g.kind, description: describeGuard(g), ...(g.note ? { note: g.note } : {}) })
const range = (n: number, g: { min?: number; max?: number }) => (g.min === undefined || n >= g.min) && (g.max === undefined || n <= g.max)

export function evaluateGuard(
  g: Guard,
  src: { sentry?: SentrySource; page?: PageEvidence | null; chain?: ChainEvidence | null; wire?: WireEvidence | null; devlog?: DevlogEvidence | null; rolesOn?: boolean; blockTimeMs?: number },
): GuardResult {
  const b = base(g)
  if (g.pending) return { ...b, status: "pending", evidence: g.note ?? "pending" }
  if (g.rolesOnly && src.rolesOn === false) return { ...b, status: "not-evaluated", evidence: "roles off (E2E_ROLES is not 1): the role this guard checks was not played" }
  switch (g.kind) {
    case "metric": {
      if (!src.sentry) return { ...b, status: "not-evaluated", evidence: "Sentry is evaluated after settlement (guards-cli)" }
      if (!src.sentry.ok) return { ...b, status: "not-evaluated", evidence: src.sentry.reason }
      const all = (src.sentry.evidence.metrics[g.name] ?? []).map((point) => typeof point === "number" ? { value: point, attrs: {} } : point)
      const pts = all.filter((point) => Object.entries(g.attrs ?? {}).every(([key, value]) => point.attrs[key] === value))
      const missingRequiredAttributes = all.filter((point) => Object.keys(g.attrs ?? {}).some((key) => !(key in point.attrs)))
      if (pts.length === 0) return g.max === 0
        ? missingRequiredAttributes.length > 0
          ? { ...b, status: "not-evaluated", evidence: `${missingRequiredAttributes.length} of ${all.length} point(s) omitted required attribute columns` }
          : { ...b, status: "pass", evidence: `0 matching of ${all.length} point(s)` }
        : { ...b, status: "fail", evidence: `no ${g.name} point recorded for this bot` }
      if (g.minPoints !== undefined && pts.length < g.minPoints) return { ...b, status: "fail", evidence: `${pts.length} matching of ${all.length} point(s), expected at least ${g.minPoints}` }
      if ((g.minBlocks !== undefined || g.maxBlocks !== undefined) && (!src.blockTimeMs || src.blockTimeMs <= 0)) return { ...b, status: "not-evaluated", evidence: "the run did not retain a positive observed chain block time" }
      const limits = src.blockTimeMs ? { min: g.min ?? (g.minBlocks === undefined ? undefined : g.minBlocks * src.blockTimeMs), max: g.max ?? (g.maxBlocks === undefined ? undefined : g.maxBlocks * src.blockTimeMs) } : g
      const out = pts.filter((point) => !range(point.value, limits))
      const values = pts.map((point) => point.value)
      const prefix = `${pts.length} matching of ${all.length} point(s)`
      return out.length ? { ...b, status: "fail", evidence: `${prefix}; ${out.length} out of bounds, e.g. ${out[0].value}` } : { ...b, status: "pass", evidence: `${prefix}, min ${Math.min(...values)}, max ${Math.max(...values)}` }
    }
    case "event": {
      if (!src.sentry) return { ...b, status: "not-evaluated", evidence: "Sentry is evaluated after settlement (guards-cli)" }
      if (!src.sentry.ok) return { ...b, status: "not-evaluated", evidence: src.sentry.reason }
      const all = src.sentry.evidence.events[g.name] ?? []
      const hits = all.filter((e) => Object.entries(g.attrs ?? {}).every(([k, v]) => e[k] === v))
      // default: seen at least once; max 0 = never
      const ok = range(hits.length, { min: g.min ?? (g.max === 0 ? undefined : 1), max: g.max })
      return { ...b, status: ok ? "pass" : "fail", evidence: `${hits.length} matching of ${all.length} ${g.name} span(s)` }
    }
    case "text": {
      if (!src.page) return { ...b, status: "not-evaluated", evidence: "the page was gone before the text could be read" }
      const appeared = src.page.seen.includes(g.text)
      const windows = src.page.ignoreNeverTextWindows?.filter((window) => window.text === g.text) ?? []
      const appearances = src.page.appearances?.filter((appearance) => appearance.text === g.text) ?? []
      const ignored = g.never && appeared && windows.length > 0 && appearances.length > 0 && appearances.every((appearance) => windows.some((window) => appearance.fromMs >= window.fromMs && appearance.toMs <= window.toMs))
      const seen = src.page.finalText.includes(g.text) || (appeared && !ignored)
      return g.never
        ? { ...b, status: seen ? "fail" : "pass", evidence: seen ? `"${g.text}" appeared on the page` : ignored ? `${appearances.length} appearance(s) confined to the scripted fault window` : "never appeared (observer on every mutation)" }
        : { ...b, status: seen ? "pass" : "fail", evidence: seen ? "on the page" : `"${g.text}" not on the page at the end` }
    }
    case "text-cleared-any": {
      if (!src.page) return { ...b, status: "not-evaluated", evidence: "the page was gone before the text could be read" }
      const seen = g.texts.find((text) => src.page!.seen.includes(text) || src.page!.finalText.includes(text))
      if (!seen) return { ...b, status: "fail", evidence: `none appeared: ${g.texts.map((text) => JSON.stringify(text)).join(" or ")}` }
      if (src.page.afterNetworkText === undefined) return { ...b, status: "fail", evidence: "no post-switch page sample was captured" }
      const stillShown = g.texts.some((text) => src.page!.afterNetworkText!.includes(text))
      return { ...b, status: stillShown ? "fail" : "pass", evidence: stillShown ? "warning still shown in the post-switch sample" : `${JSON.stringify(seen)} appeared and cleared by the post-switch sample` }
    }
    case "chain-report": {
      const c = src.chain
      if (!c) return { ...b, status: "not-evaluated", evidence: "no chain evidence" }
      if (c.oracle) {
        if (c.oracle.status === "pass") return { ...b, status: "pass", evidence: c.oracle.detail }
        if (c.oracle.status === "fail") return { ...b, status: "fail", evidence: c.oracle.detail }
        return { ...b, status: "not-evaluated", evidence: c.oracle.detail }
      }
      if (!c.trail || c.trail.reports.length === 0) return { ...b, status: "not-evaluated", evidence: `no vote trail: ${c.trailNote ?? "the devLog was not exported"}` }
      if (!c.filed) return { ...b, status: "fail", evidence: "no Game.report extrinsic on chain for this account" }
      const { rows, error } = reportVerdicts(c.filed)
      if (error) return { ...b, status: "fail", evidence: `the filed report does not decode: ${error}` }
      const trail = c.trail.reports.at(-1)!.players
      const chainBy = new Map<string, string[]>()
      for (const r of rows) chainBy.set(r.attestee, [...(chainBy.get(r.attestee) ?? []), r.verdict])
      const diffs: string[] = []
      for (const id of new Set([...Object.keys(trail), ...chainBy.keys()])) {
        const t = trail[id]?.verdict
        const v = chainBy.get(id)
        if (t === undefined) diffs.push(`${id.slice(0, 8)} on chain only`)
        else if (!v) diffs.push(`${id.slice(0, 8)} in the trail only`)
        else if ((t === "person") !== v.every((x) => x === "Person")) diffs.push(`${id.slice(0, 8)} trail ${t}, chain ${v.join("/")}`)
      }
      return diffs.length ? { ...b, status: "fail", evidence: diffs.join("; ") } : { ...b, status: "pass", evidence: `${chainBy.size} co-player(s): the chain report equals the vote trail` }
    }
    case "store-rejection": {
      const w = src.wire
      if (!w) return { ...b, status: "not-evaluated", evidence: "no wire evidence (the host websocket was not tapped)" }
      // nothing read is no evidence of nothing refused
      if (w.frames === 0) return { ...b, status: "not-evaluated", evidence: "the tap read no host frame" }
      // a priority refusal naming the page's own newer frame is the store keeping the right one (store-wire.ts)
      const priority = g.reason === "channelPriorityTooLow" ? priorityRefusals(w) : null
      const hits = priority ? priority.stale : rejectionsOf(w, g.reason)
      const ok = range(hits.length, { min: g.min ?? (g.max === 0 ? undefined : 1), max: g.max })
      const when = hits.length ? `, first at ${hits[0].at.slice(11, 19)} UTC` : ""
      const what = priority ? `${g.reason} refusal(s) naming a statement the saved floor should have cleared${when}; ${priority.superseded.length} superseded by the page's own newer frame` : `${g.reason} refusal(s)${when}`
      return { ...b, status: ok ? "pass" : "fail", evidence: `${hits.length} ${what}; ${wireSummary(w)}` }
    }
    case "devlog": {
      const d = src.devlog
      // no lines read is no evidence of nothing logged
      if (!d || d.lines.length === 0) return { ...b, status: "not-evaluated", evidence: `no devLog lines: ${d?.note ?? "not exported"}` }
      const hits = d.lines.filter((line) => {
        if ((g.tag !== undefined && line.tag !== g.tag) || ![g.match, ...(g.matchAny ?? [])].some((m) => line.message.includes(m))) return false
        const fields = logFields(line.message)
        return Object.entries(g.fields ?? {}).every(([key, value]) => fields[key] === value) && (g.has ?? []).every((key) => fields[key] !== undefined)
      })
      const ok = range(hits.length, { min: g.min ?? (g.max === 0 ? undefined : 1), max: g.max })
      const first = hits[0] ? `, first: ${JSON.stringify(hits[0].message.slice(0, 120))}` : ""
      return { ...b, status: ok ? "pass" : "fail", evidence: `${hits.length} matching of ${d.lines.length} line(s)${first}` }
    }
    case "late-join-proof": {
      const d = src.devlog
      if (!d || d.lines.length === 0) return { ...b, status: "not-evaluated", evidence: `no devLog lines: ${d?.note ?? "not exported"}` }
      const dataOf = (line: PcTimelineLine): Record<string, unknown> => line.data && typeof line.data === "object" ? line.data as Record<string, unknown> : {}
      const starts = d.lines.filter((line) => line.tag === "clock" && line.message === "clock ready" && dataOf(line).late === true && typeof line.sessionId === "string" && line.sessionId.length > 0)
      if (starts.length !== 1) return { ...b, status: "fail", evidence: `${starts.length} late clock ready lines with a sessionId; expected 1` }
      const start = starts[0]
      const lines = d.lines.filter((line) => line.sessionId === start.sessionId).sort((a, z) => (a.ts ?? 0) - (z.ts ?? 0))
      const readyTs = start.ts ?? 0
      const premature = lines.find((line) => line.tag === "vote" && (line.message === "tap" || line.message === "turn sealed") && (line.ts ?? 0) <= readyTs)
      if (premature) return { ...b, status: "fail", evidence: `${premature.message} occurred before clock ready` }
      const rooms = lines.filter((line) => line.tag === "rtc" && line.message === "mesh opening")
      if (rooms.length === 0) return { ...b, status: "fail", evidence: "cold session opened no room" }
      if (rooms.some((line) => dataOf(line).round !== g.round || typeof dataOf(line).room !== "string" || dataOf(line).room === ""))
        return { ...b, status: "fail", evidence: `a cold-session room was keyless or did not match actual round ${g.round}` }
      const openedAt = Math.min(...rooms.map((line) => line.ts ?? 0))
      const videos = lines.filter((line) => {
        if (line.tag !== "rtc" || !line.message.includes("[jollity-rtc] round-link")) return false
        const fields = logFields(line.message)
        return fields.stage === "first-video" && Number(fields.round) === g.round && fields.peer !== undefined
      })
      if (videos.length === 0) return { ...b, status: "fail", evidence: `no co-player first-video evidence for round ${g.round}` }
      const latency = Math.min(...videos.map((line) => (line.ts ?? 0) - openedAt))
      if (latency < 0 || latency > g.maxFirstVideoMs) return { ...b, status: "fail", evidence: `first co-player video took ${latency} ms after room open; limit ${g.maxFirstVideoMs} ms` }
      return { ...b, status: "pass", evidence: `session ${start.sessionId} opened ${rooms.length} round-${g.round} room(s), first video in ${latency} ms, no tap/seal before ready` }
    }
    case "reload-video-back": {
      // #1020 / game 270: after one page reloads mid-round, the link to a
      // co-player it had video from must come back, bounded. The precondition
      // (a reload, video before it) is checked first: a run that did not set
      // it up proves nothing either way.
      const d = src.devlog
      if (!d || d.lines.length === 0) return { ...b, status: "not-evaluated", evidence: `no devLog lines: ${d?.note ?? "not exported"}` }
      const bootOf = new Map<string, number>()
      for (const line of d.lines) if (line.sessionId) bootOf.set(line.sessionId, Math.min(bootOf.get(line.sessionId) ?? Infinity, line.ts ?? Infinity))
      const sessions = [...bootOf.entries()].sort((a, z) => a[1] - z[1])
      if (sessions.length < 2) return { ...b, status: "not-evaluated", evidence: `${sessions.length === 1 ? "one page session" : "no page session"} in the devLog: the reload did not happen` }
      const [[before], [after, bootAt]] = sessions.slice(-2)
      const videos = (sessionId: string) => d.lines.flatMap((line) => {
        if (line.sessionId !== sessionId || line.tag !== "rtc" || !line.message.includes("[jollity-rtc] round-link")) return []
        const fields = logFields(line.message)
        return fields.stage === "first-video" && fields.peer !== undefined ? [{ ts: line.ts ?? 0, round: fields.round, peer: fields.peer }] : []
      })
      const seen = videos(before)
      if (seen.length === 0) return { ...b, status: "not-evaluated", evidence: "no co-player video before the reload: the run did not set up the link it tests" }
      // by peer, not by round: a reloaded page can log its first video before
      // it knows the round (round=none), and the budget ends inside the round
      const round = seen.at(-1)!.round
      const peers = [...new Set(seen.filter((v) => v.round === round).map((v) => v.peer))]
      // EVERY such co-player must come back: game 270 was one pair dark while
      // the others were fine. One whose LAST away/back line after it says they
      // left is excused; "away ... said" is also written on a backgrounding, so
      // a later "peer back" takes the excuse away again.
      const lastPresence = new Map<string, "said" | "back">()
      for (const line of [...d.lines].sort((a, z) => (a.ts ?? 0) - (z.ts ?? 0))) {
        if (line.sessionId !== after || line.tag !== "rtc") continue
        const away = /\[jollity-rtc\] peer away (\S+) said/.exec(line.message)
        const back = /\[jollity-rtc\] peer back (\S+)/.exec(line.message)
        if (away) lastPresence.set(away[1], "said")
        else if (back) lastPresence.set(back[1], "back")
      }
      const left = new Set([...lastPresence].filter(([, last]) => last === "said").map(([peer]) => peer))
      const owed = peers.filter((peer) => !left.has(peer))
      const backAt = new Map<string, number>()
      for (const v of videos(after)) if (owed.includes(v.peer) && v.ts < (backAt.get(v.peer) ?? Infinity)) backAt.set(v.peer, v.ts)
      const never = owed.filter((peer) => !backAt.has(peer))
      if (never.length) return { ...b, status: "fail", evidence: `no video back from ${never.join(", ")} (round ${round} before the reload) after it` }
      const slowest = owed.reduce((a, z) => (backAt.get(z)! > backAt.get(a)! ? z : a), owed[0])
      if (!slowest) return { ...b, status: "not-evaluated", evidence: `every co-player seen before the reload (${peers.join(", ")}) said they left after it` }
      const ms = backAt.get(slowest)! - bootAt
      const excused = left.size ? `; ${[...left].join(", ")} left` : ""
      return ms > g.maxVideoBackMs
        ? { ...b, status: "fail", evidence: `${slowest}'s video back ${ms} ms after the reloaded page booted; limit ${g.maxVideoBackMs} ms${excused}` }
        : { ...b, status: "pass", evidence: `all ${owed.length} co-player(s) back, the last (${slowest}) ${ms} ms after the reloaded page booted${excused}` }
    }
    case "synchronized-pc-failure": {
      const d = src.devlog
      if (!d || d.lines.length === 0) return { ...b, status: "not-evaluated", evidence: `no devLog lines: ${d?.note ?? "not exported"}` }
      const minPeers = g.minPeers ?? 2
      const { collapse, peakPeers } = detectSynchronizedPcFailure(parsePcTimeline(d.lines), { withinMs: g.withinMs, minPeers })
      if (collapse)
        return { ...b, status: "fail", evidence: `${collapse.peers}/${collapse.peers} peers connected at window start failed within ${collapse.span} ms` }
      if (peakPeers < minPeers) return { ...b, status: "not-evaluated", evidence: `${peakPeers} established peer(s), need at least ${minPeers}` }
      return { ...b, status: "pass", evidence: `no synchronized failure across up to ${peakPeers} established peers in ${g.withinMs} ms` }
    }
  }
}

export const evaluateGuards = (p: Profile, src: Parameters<typeof evaluateGuard>[1]): GuardResult[] => p.expect.map((g) => evaluateGuard(g, src))

export const isExpectedT9IsolationGuard = (profile: Pick<Profile, "telemetryTorture"> | null | undefined, guard: Guard): boolean =>
  profile?.telemetryTorture?.id === "T9" && guard.kind === "text" && guard.never === true && guard.text === EXPECTED_NETWORK_ISOLATION_TEXT

/** T9 deliberately reaches the network-isolation screen. Preserve every
 * ordinary profile guard while converting only that exact negative control
 * into positive proof, and only when timing, recovery, and visible copy all
 * agree. This keeps a route-only result or an out-of-window notice red. */
export function evaluateT9Guards(
  p: Profile,
  src: Parameters<typeof evaluateGuard>[1],
  proof: { isolationWithinWindow: boolean; faultRecovered: boolean },
): GuardResult[] {
  return p.expect.map((g) => {
    if (g.kind !== "text" || !isExpectedT9IsolationGuard(p, g)) return evaluateGuard(g, src)
    const b = base(g)
    if (!src.page) return { ...b, status: "not-evaluated", evidence: "the page was gone before the expected isolation notice could be read" }
    const appeared = src.page.seen.includes(g.text) || src.page.finalText.includes(g.text)
    const passed = proof.isolationWithinWindow && proof.faultRecovered && appeared
    return {
      ...b,
      status: passed ? "pass" : "fail",
      evidence: passed
        ? "expected T9 isolation notice appeared inside the bounded blackout and recovery was observed"
        : `expected T9 isolation proof incomplete: timing ${proof.isolationWithinWindow ? "valid" : "invalid"}, recovery ${proof.faultRecovered ? "observed" : "missing"}, copy ${appeared ? "seen" : "missing"}`,
    }
  })
}

/** Merge a later evaluation over earlier results: only the not-evaluated ones are replaced. */
export function mergeGuards(earlier: GuardResult[], later: GuardResult[]): GuardResult[] {
  return earlier.map((e, i) => (e.status === "not-evaluated" && later[i] ? later[i] : e))
}

export const tally = (gs: readonly GuardResult[]): Record<GuardStatus, number> => ({
  pass: gs.filter((g) => g.status === "pass").length,
  fail: gs.filter((g) => g.status === "fail").length,
  pending: gs.filter((g) => g.status === "pending").length,
  "not-evaluated": gs.filter((g) => g.status === "not-evaluated").length,
})

/** The text guards' strings, for the in-page observer (journey). */
export const textGuardTexts = (p: Profile): string[] => [
  ...new Set(p.expect.flatMap((g) => (g.pending ? [] : g.kind === "text" ? [g.text] : g.kind === "text-cleared-any" ? g.texts : []))),
]

/** A MutationObserver (init script) that records which of `texts` ever appeared, in window.__e2eSeen,
 * and each complete visible interval in __e2eAppearances.
 *  It survives navigations within the page's life, which polling does not. */
export function textWatchScript(texts: readonly string[]): string {
  return `(() => {
  const want = ${JSON.stringify(texts)}
  const seen = (window.__e2eSeen = window.__e2eSeen || [])
  const appearances = (window.__e2eAppearances = window.__e2eAppearances || [])
  const active = new Map()
  const close = () => {
    const now = Date.now()
    for (const interval of active.values()) interval.toMs = now
    active.clear()
  }
  window.__e2eTextWatch = { close }
  const scan = () => {
    const bodyElement = document.body
    const body = bodyElement ? bodyElement.innerText || "" : ""
    for (const t of want) {
      const visible = body.includes(t)
      const interval = active.get(t)
      const now = Date.now()
      if (visible && !interval) {
        const next = { text: t, fromMs: now, toMs: now }
        active.set(t, next)
        if (!seen.includes(t)) seen.push(t)
        appearances.push(next)
      } else if (visible) interval.toMs = now
      else if (interval) {
        interval.toMs = now
        active.delete(t)
      }
    }
  }
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true })
  addEventListener("DOMContentLoaded", scan)
  setInterval(scan, 500)
})()`
}
