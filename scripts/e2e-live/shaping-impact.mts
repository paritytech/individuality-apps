// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// DID THE SHAPING REACH THE APP? One downloaded run of artifacts in, one
// markdown table out: per persona, what its profile was SUPPOSED to apply
// (netem profile with its rate/delay/loss, the UDP block, the timeline's
// outages and blackouts, the CPU throttle) next to what the APP itself
// measured in the same windows (rtt, loss, jitter, path, send-ladder rung,
// low power, fps/height, freezes, self-heals, connection help).
//
//   npx tsx scripts/e2e-live/shaping-impact.mts <dir of downloaded artifacts> [--run <id>]
//
// <dir> is a `gh run download <id> -R paritytech/individuality-apps -D <dir>` tree:
// one subdirectory per artifact; the bot-NN artifacts hold profile.json,
// netem.log and devlog-N.json, the bot-NN-result artifacts hold result-N.json.
// The run id is read from the artifact names when not given. Read-only: no
// network, no chain, no live run.
//
// THE INTENT comes from each runner's own profile.json (`definition`), which is
// the profile the run actually gave that bot — including the acceptance
// profiles that are not in profiles.json at all. profiles.json is only the
// fallback for a runner whose profile.json is missing.
//
// THE WINDOWS come from netem.log, which the runner writes as it applies each
// call (`<ISO> netem <call>`, or `<ISO> shared netem <call>` when the group
// supervisor shapes a shared runner). Steps are read off the log rather than
// re-planned, so a step that never fired shows as a missing window instead of
// an invented one.
//
// WHAT COUNTS AS EVIDENCE is the app's own record, never the runner's:
//   rtt          devLog `rtcp-clock-offset` observation.medianRttMs (per peer,
//                per mesh generation) — the app's RTCP round trip
//   loss/jitter  every OTHER bot's devLog `receiver-quality` counters for this
//                account, per observer/link, last cumulative reading: netem
//                shapes egress, so peers see this persona's loss and jitter
//   fps/height   the same records' width/height/fps, per link maximum
//   freezes      the same records' freezeCount / totalFreezesDuration
//   path         devLog `[jollity-rtc] path <peer> <local>/<remote> <protocol>`
//   send rung    result-N.json `adaptiveUpload.page`: rung, transitions with
//                the pressure that caused each, seconds spent on each rung
//   low power    `adaptiveUpload.page.lowPower` plus the `low-power` devLog lines
//   heals        devLog `self-heal: ICE restart|rebuild`, `media-stall`, `unseen:`
//   connection   `connection_stalled:` / `connection_recovered:` lines and the
//                /connection-help redirect, if the app took it
//   cpu          `profile.cpuThrottle` next to the app's own frame record: the
//                device probe's `low-power` `device check (...)` lines (p95 and
//                median frame time, frames per sample, the rule that decided
//                and the mode it applied) and the devLog's top-level `longTasks`
//                snapshot. That snapshot keeps ONLY tasks >=1000 ms, so an empty
//                one is a reading (no second-long stall), not a missing field.
//                ui.frame_ms / ui.slow_frame_pct / ui.long_task_ms are Sentry
//                METRICS: they never appear in a devLog export, so a CPU persona
//                says that in a flag instead of inventing a slow-frame share.
//   receiver     every OTHER bot's devLog in the same attempt, `receiver-quality`
//                records whose observation.peerId is THIS bot: derivedFps,
//                framesDecodedDelta (a window with 0 frames is the closest the
//                artifacts come to a black tile), freezeCount and the path
//                protocol. Accounts come from result-N.json; a bot with no
//                result cannot be attributed and the report says so.
//
// EVERY INJECTED STEP gets one row: what was injected, the window, and the
// app's own measurements in it — rtt p50, loss, path relay vs direct, the send
// rung at the window's end (a transition's atMs is the page's monotonic clock,
// mapped to wall through the devLog's own timing.wallMs - timing.monotonicMs),
// heals, the connection notices shown, and what the run's other bots recorded
// about this one in that window.
//
// THE BASELINE is the run itself: the wifi personas that carry no stress
// shaping and exported a devLog give the run's own rtt/loss/rung reference, so
// a shaped persona is compared with its siblings in the same run, not with a
// number from another night.
//
// A VERDICT is deliberately conservative:
//   impact seen   the app's measurement moves, in the window the shaping was in
//                 force, in the direction that shaping predicts
//   no impact     the shaping was in force (the log proves the call ran) and
//                 the app's measurement does not move
//   cannot tell   no app-side record covers the window, or the shaping itself
//                 never took effect, or the profile has no stress shaping to
//                 detect (a control link: nothing was meant to change)
// "cannot tell" is never a pass, and every verdict carries the lines behind it.
//
// THE RUN'S OWN WORD WINS when it has one: a journey.log `INCONCLUSIVE …
// applies to this run` means the persona's fault was never played (a deployed
// build that reads the chain through the host cannot be cut from it), so the
// row says "cannot tell" and quotes the run, instead of reading an unplayed
// fault as one that had no effect.
//
// A PERSONA'S STRESS IS NOT ONLY THE NETEM. A clock offset or a clock jump
// (clock-jumps, clock-wrong-then-corrected) and a role kind are stress the
// network record cannot score: they read "cannot tell" and are kept out of the
// control set, so a control reference stays a reference.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { loadNetemProfiles, type NetemProfile, type Profile } from "./profile"
import { loadProfiles } from "./profile"
import type { ShapingSourceRow } from "./crew/shaping-summary"

const MS = (iso: string): number => Date.parse(iso)
const round = (n: number, digits = 0): number => Math.round(n * 10 ** digits) / 10 ** digits

/** The zone's own abbreviation for that instant, never a hard-coded one: Berlin
 *  is CEST (UTC+2) in summer and CET (UTC+1) in winter, and the switch happens
 *  in late October — a run on 25 Oct is CET while a run on 24 Oct is CEST. The
 *  stamps were always right; printing "CEST" beside a CET time was not. */
const zoneAbbr = (ms: number): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", timeZoneName: "short" })
    .formatToParts(new Date(ms))
    .find((p) => p.type === "timeZoneName")?.value ?? "local"

/** Berlin local time, labelled with that instant's real abbreviation. */
const at = (ms: number): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(ms))

/** `at()` plus the zone's abbreviation for that instant, for a time a reader may convert. */
const atZ = (ms: number): string => `${at(ms)} ${zoneAbbr(ms)}`

const pct = (values: readonly number[], q: number): number | null => {
  const xs = [...values].sort((a, b) => a - b)
  if (xs.length === 0) return null
  const k = (xs.length - 1) * q
  const lo = Math.floor(k)
  const hi = Math.min(lo + 1, xs.length - 1)
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (k - lo)
}

// ── what the app said ────────────────────────────────────────────────────────

interface LogLine {
  ts: number
  tag: string
  message: string
  data?: Record<string, unknown>
}

/** One long task the page kept: the harness's `smoothness()` snapshot (lib/telemetry/smoothness.ts).
 *  It keeps only tasks of at least 1000 ms, so an empty list is a reading, not a missing field. */
interface LongTask {
  ms: number
  endedAt: number
  scene: string
}

interface DevLog {
  lines: LogLine[]
  /** the harness's long-task snapshot: `{ ms, endedAt, scene }`, oldest first */
  longTasks: LongTask[]
  /** why the export is empty, when it is: the app's own words, quoted in the report */
  why: string | null
}

/** The final devLog export, or null when the artifact has none. `devlog-N-post-checkpoint-flush.json`
 *  is a truncated copy of the same document; `devlog-N.json` is the final one. */
function readDevLog(dir: string, slot: number): DevLog | null {
  const final = join(dir, `devlog-${slot}.json`)
  if (!existsSync(final)) return null
  const doc = JSON.parse(readFileSync(final, "utf8")) as { lines?: LogLine[]; longTasks?: LongTask[]; why?: string }
  const longTasks = Array.isArray(doc.longTasks)
    ? doc.longTasks.filter((t): t is LongTask => typeof t?.ms === "number" && typeof t?.endedAt === "number").map((t) => ({ ms: t.ms, endedAt: t.endedAt, scene: typeof t.scene === "string" ? t.scene : "?" }))
    : []
  return { lines: doc.lines ?? [], longTasks, why: typeof doc.why === "string" ? doc.why : null }
}

interface RtcStats {
  links: number
  received: number
  lost: number
  jitterMs: number
  freezes: number
  freezeSeconds: number
  maxHeight: number
  maxFps: number
  /** every path line seen in the window, as `<local>/<remote> <protocol>` */
  paths: string[]
}

const inWindow = (l: LogLine, from: number, to: number): boolean => l.ts >= from && l.ts <= to

function rtcStats(log: DevLog, from: number, to: number): RtcStats {
  const last = new Map<number, Record<string, number>>()
  let maxHeight = 0
  let maxFps = 0
  const paths: string[] = []
  for (const line of log.lines) {
    if (!inWindow(line, from, to)) continue
    if (line.message === "receiver-quality") {
      const observation = (line.data as { observation?: Record<string, unknown> } | undefined)?.observation
      if (!observation) continue
      const link = Number(observation.link ?? -1)
      const counters = (observation.counters ?? {}) as Record<string, number>
      if (Object.keys(counters).length > 0) last.set(link, { ...(last.get(link) ?? {}), ...counters })
      const height = Number(observation.height ?? 0)
      const fps = Number(observation.fps ?? 0)
      if (height > maxHeight) maxHeight = height
      if (fps > maxFps) maxFps = fps
    }
    const path = /^\[jollity-rtc\] path \S+ (.+)$/.exec(line.message)
    if (path) paths.push(path[1]!)
  }
  let received = 0
  let lost = 0
  let jitterMs = 0
  let freezes = 0
  let freezeSeconds = 0
  for (const c of last.values()) {
    received += c.packetsReceived ?? 0
    lost += c.packetsLost ?? 0
    jitterMs = Math.max(jitterMs, c.jitterMs ?? 0)
    freezes += c.freezeCount ?? 0
    freezeSeconds += c.totalFreezesDuration ?? 0
  }
  return { links: last.size, received, lost, jitterMs, freezes, freezeSeconds, maxHeight, maxFps, paths }
}

const rtts = (log: DevLog, from: number, to: number): number[] =>
  log.lines.flatMap((l) => {
    if (!inWindow(l, from, to) || l.message !== "rtcp-clock-offset") return []
    const rtt = (l.data as { observation?: { medianRttMs?: number } } | undefined)?.observation?.medianRttMs
    return typeof rtt === "number" ? [rtt] : []
  })

const countMatching = (log: DevLog, from: number, to: number, match: RegExp): number =>
  log.lines.filter((l) => inWindow(l, from, to) && match.test(l.message)).length

/** The app's own repair: the mesh self-heals, and the chain health notices. */
const HEAL = /self-heal: (ICE restart|rebuild)|media-stall|unseen: /
/** Chain-side trouble the app recorded: a lost/failed chain read, a restart card, a stale watch.
 *
 *  The restart card is TWO lines and only one of them is trouble: `restart card
 *  shown` and `restart card's next probe did not succeed` are the card being
 *  raised, while `restart card cleared after a healthy probe` is the routine
 *  clear the health ladder writes ~2×/min on EVERY persona, controls included
 *  (1860 of them across one run). A bare `/restart card/` therefore made every
 *  persona look like it had chain trouble, which is how a window of pure boot
 *  noise scored "answered" (lane S2). Match the raised forms only. */
const CHAIN_TROUBLE = /chain (read|lost|retry|unreachable|probe failed)|restart card shown|restart card's next probe did not succeed|health (open|waiting|recheck|handover|signup): (degraded|unreachable|lost)|watch silent|read where the watch was silent/
/** The two lines the health ladder writes when it shows and clears a connection notice. */
const STALLED = /^connection_stalled: /
const RECOVERED = /^connection_recovered: /

/** TURN credentials the app gave up on: the issuer itself failed, or the fetch ended
 *  with no list at all. Only those two forms count.
 *
 *  `TURN: try N failed … trying again` is deliberately NOT here. ice.ts writes it only
 *  when ANOTHER try follows (MAX_TRIES 3), so a healthy cold start that succeeds on try
 *  3 writes it too: in a live run it appears on 24 of the run's 58 bot exports, the
 *  pure wifi control `locale-la-enus` among them. `ICE: STUN-only` is the interim state
 *  while a retry is still pending, and the recovery (`ICE: relayed — N TURN servers
 *  configured`, `TURN: client response received`) is written on every persona. Counting
 *  any of those made every persona report "TURN trouble" — the same shape of mistake as
 *  the bare `/restart card/` that once made every persona look like it had chain trouble.
 *
 *  What the two remaining forms buy: a TURN-issuer outage produces no heal, no stall and
 *  no chain line — the mesh simply cannot relay, and these are the only lines that say
 *  so. Before this, `turn-issuer-outage` scored "no impact" in 8 of 8 runs. */
export const TURN_TROUBLE = /TURN: (?:issuer \d+ failed|failed to fetch credentials)/

/** Every repair/trouble signal the report counts, in the order it prints them. One list
 *  feeds both the shaped-span summary and the per-window breakdown, so a new signal is
 *  one entry here and cannot reach one without the other. */
const SIGNALS: { label: string; re: RegExp; answers: boolean }[] = [
  { label: "heal(s)", re: HEAL, answers: true },
  { label: "connection stall(s)", re: STALLED, answers: true },
  // A recovery line is the app coming BACK from something, not reacting to this window:
  // it was counted and never used as evidence before, and folding it in here silently
  // started promoting windows to "answered" on a recovery alone.
  { label: "recovered", re: RECOVERED, answers: false },
  { label: "chain health line(s)", re: CHAIN_TROUBLE, answers: true },
  { label: "TURN trouble line(s)", re: TURN_TROUBLE, answers: true },
]

// ── the run's own verdict on a persona, when it made one ────────────────────

/** `host-chain-lost applies to this run` — the check name, with or without the game stage's
 *  `player 30 ` prefix, in the typed `inconclusive` name and in the printed line alike. */
const INCONCLUSIVE_CHECK = /(?:^|\s)([a-z0-9][a-z0-9-]*) applies to this run$/
const JOURNEY_INCONCLUSIVE = /^\s*INCONCLUSIVE\s+(?:player \d+ )?([a-z0-9][a-z0-9-]*) applies to this run\s+—\s+(.*)$/

/** The run's own "this persona could not fire" verdicts, keyed by persona name.
 *
 *  A persona can be declared impossible for the build under test — `host-chain-lost`
 *  is only meaningful with `app=local`, because the deployed app reads the chain
 *  THROUGH the host and a cut would take its own reads with it, so the journey drops
 *  the cuts and says so. The netem log then shows a plain wifi apply and nothing
 *  moving, which the reader used to score as "no impact" — a fault that was never
 *  attempted, reported as a fault that had no effect. The run's own word is the only
 *  honest reading, and it is a "cannot tell", never a pass.
 *
 *  The TYPED form (`SlotResult.inconclusive`) lives in `result-N.json`, which ships in
 *  the separate `-result` artifact directory — NOT the bot directory this function is
 *  handed — so it is read from the already-loaded `entry.result` in `assess`
 *  (`runVerdict`). This function reads only the printed line, which the boot-only stage
 *  needs because it records its checks in `journey.json` instead. */
export function readJourneyLog(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const path = join(dir, "journey.log")
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = JOURNEY_INCONCLUSIVE.exec(line)
    if (m) out.set(m[1]!, m[2]!.trim())
  }
  return out
}

/** The run's verdict for one persona, from both places it is recorded: the typed
 *  `SlotResult.inconclusive` of the `-result` artifact (authoritative, no format to
 *  parse) and the printed `journey.log` line (the boot-only stage's own record). */
export function runVerdict(result: Pick<Result, "inconclusive"> | null, journey: Map<string, string>, persona: string): string | undefined {
  for (const entry of result?.inconclusive ?? []) {
    if (INCONCLUSIVE_CHECK.exec(entry.name)?.[1] === persona) return entry.detail
  }
  return journey.get(persona)
}

// ── the app's frame record, next to the CPU throttle ────────────────────────

/** One frame-time sample the device probe took (lib/device-probe.ts `applyProbe`), parsed
 *  from the app's own `low-power` `device check (…)` line. */
interface ProbeSample {
  at: number
  stage: string
  /** p95 of the frame deltas in this sample, milliseconds */
  p95Ms: number
  /** median of the same deltas: the frame time's p50 */
  medianMs: number
  frames: number
  /** which rule decided, when this sample is the deciding one (the line carries one rule) */
  rule: string
  /** what the line says the probe applied: `low power on (probe-weak)` or `full mode kept` */
  mode: string
}

/** `device check (countdown, 0 hidden): #1 p95 367 ms, median 33 ms, 28 frames; rule weak, low power on (probe-weak)` */
const DEVICE_CHECK = /^device check \(([a-z]+), \d+ hidden\): (.*); rule ([a-z-]+), (.*)$/
const PROBE_SAMPLE = /#(\d+) p95 (\d+) ms, median (\d+) ms, (\d+) frames/g

/** Every frame-time sample the device probe logged, oldest first. Empty when the app never probed. */
function probeSamples(log: DevLog): ProbeSample[] {
  const out: ProbeSample[] = []
  for (const line of log.lines) {
    if (line.tag !== "low-power") continue
    const head = DEVICE_CHECK.exec(line.message)
    if (!head) continue
    for (const m of head[2]!.matchAll(PROBE_SAMPLE)) {
      out.push({ at: line.ts, stage: head[1]!, p95Ms: Number(m[2]), medianMs: Number(m[3]), frames: Number(m[4]), rule: head[3]!, mode: head[4]! })
    }
  }
  return out
}

/** The app's own low-power transitions, as the `low-power` lines record them. */
interface LowPowerChange {
  at: number
  on: boolean
  reason: string
}

const LOW_POWER = /^low power (on|off)(?: \((.+)\))?$/

function lowPowerChanges(log: DevLog): LowPowerChange[] {
  return log.lines.flatMap((l) => {
    if (l.tag !== "low-power") return []
    const m = LOW_POWER.exec(l.message)
    if (!m) return []
    return [{ at: l.ts, on: m[1] === "on", reason: m[2] ?? "none" }]
  })
}

/** The page's monotonic clock as wall time. `adaptiveUpload.page.transitions[].atMs` is
 *  monotonic; the devLog's own `timing` block carries both readings on each line, so the
 *  difference between them is the page's wall origin. Null when no line carries both. */
function wallOrigin(log: DevLog): number | null {
  const offsets = log.lines.flatMap((l) => {
    const t = (l.data as { timing?: { wallMs?: number; monotonicMs?: number } } | undefined)?.timing
    return typeof t?.wallMs === "number" && typeof t?.monotonicMs === "number" ? [t.wallMs - t.monotonicMs] : []
  })
  return offsets.length ? pct(offsets, 0.5) : null
}

// ── what the OTHER bots recorded about this one ──────────────────────────────

/** One `receiver-quality` record a bot wrote about a PEER: its own view of that peer's video. */
interface PeerReading {
  /** the observing bot's slot */
  observer: number
  /** the observer's receiver link for this peer */
  link: number
  at: number
  /** the peer's decoded frames per second over the record's window (the app's derivedFps) */
  fps: number | null
  /** frames decoded in the window; 0 is the closest these artifacts come to a black tile */
  framesDecodedDelta: number | null
  /** cumulative freeze count on the peer's link */
  freezeCount: number | null
  /** cumulative packets received and lost on the peer's link */
  packetsReceived: number | null
  packetsLost: number | null
  /** receiver jitter for the peer's link, in milliseconds */
  jitterMs: number | null
  /** the selected path's protocol and legs, e.g. `udp host/host` */
  path: string | null
}

/** What the run's other bots recorded about one account. */
interface PeerEvidence {
  /** the slots that observed this account */
  observers: Set<number>
  readings: PeerReading[]
}

/** Build the run-wide peer index once: account → what the OTHER bots said about it.
 *  Accounts come from each bot's own result-N.json; a bot with no result has no account,
 *  so its observations still count for whoever it watched but nothing can be attributed TO it. */
function buildPeerIndex(artifacts: readonly Artifact[]): Map<string, PeerEvidence> {
  const index = new Map<string, PeerEvidence>()
  for (const a of artifacts) {
    if (!a.log) continue
    for (const line of a.log.lines) {
      if (line.message !== "receiver-quality") continue
      const o = (line.data as { observation?: Record<string, unknown> } | undefined)?.observation
      if (!o || typeof o.peerId !== "string") continue
      const counters = (o.counters ?? {}) as Record<string, number>
      const path = (o.path ?? {}) as { protocol?: string; localType?: string; remoteType?: string }
      const reading: PeerReading = {
        observer: a.slot,
        link: Number(o.link ?? -1),
        at: line.ts,
        fps: typeof o.derivedFps === "number" ? o.derivedFps : null,
        framesDecodedDelta: typeof o.framesDecodedDelta === "number" ? o.framesDecodedDelta : null,
        freezeCount: typeof counters.freezeCount === "number" ? counters.freezeCount : null,
        packetsReceived: typeof counters.packetsReceived === "number" ? counters.packetsReceived : null,
        packetsLost: typeof counters.packetsLost === "number" ? counters.packetsLost : null,
        jitterMs: typeof counters.jitterMs === "number" ? counters.jitterMs : null,
        path: path.protocol ? `${path.protocol} ${path.localType ?? "?"}/${path.remoteType ?? "?"}` : null,
      }
      const entry = index.get(o.peerId) ?? { observers: new Set<number>(), readings: [] }
      entry.observers.add(a.slot)
      entry.readings.push(reading)
      index.set(o.peerId, entry)
    }
  }
  return index
}

/** What the other bots saw of one account in [from, to], or null when nobody watched it there. */
function peerEvidenceIn(index: Map<string, PeerEvidence>, account: string | null, from: number, to: number): { observers: number; readings: PeerReading[] } | null {
  if (!account) return null
  const entry = index.get(account)
  if (!entry) return null
  const readings = entry.readings.filter((r) => r.at >= from && r.at <= to)
  if (readings.length === 0) return null
  return { observers: new Set(readings.map((r) => r.observer)).size, readings }
}

/** The last cumulative receiver counters each observer/link recorded for this
 *  account in the window. Netem shapes a runner's egress, so these peer-side
 *  counters — not the runner's own inbound counters — are its loss/jitter axis. */
function peerNetworkStatsIn(
  index: Map<string, PeerEvidence>,
  account: string | null,
  from: number,
  to: number,
): { observers: number; links: number; received: number; lost: number; jitterMs: number } | null {
  const seen = peerEvidenceIn(index, account, from, to)
  if (!seen) return null
  const last = new Map<string, PeerReading>()
  for (const reading of seen.readings) {
    const key = `${reading.observer}:${reading.link}`
    const previous = last.get(key)
    if (!previous || previous.at < reading.at) last.set(key, reading)
  }
  let received = 0
  let lost = 0
  let jitterMs = 0
  for (const reading of last.values()) {
    received += reading.packetsReceived ?? 0
    lost += reading.packetsLost ?? 0
    jitterMs = Math.max(jitterMs, reading.jitterMs ?? 0)
  }
  return { observers: seen.observers, links: last.size, received, lost, jitterMs }
}

/** The relay/direct split of a set of path strings. `rtcStats.paths` holds the app's
 *  `[jollity-rtc] path <peer> <local>/<remote> <protocol>` line minus the peer, so the
 *  first token is the legs (`relay/relay`, `host/host`, `relay/srflx`) and the second the
 *  transport. A relay leg means the media went through TURN; host/host means direct. */
function pathSplit(paths: readonly string[]): string | null {
  if (paths.length === 0) return null
  const counts = new Map<string, number>()
  for (const p of paths) {
    const legs = p.split(" ")[0] ?? ""
    const kind = legs.includes("relay") ? "relay" : legs.includes("srflx") || legs.includes("prflx") ? "srflx" : "direct"
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts].map(([kind, n]) => `${kind} ${n}`).join("/")
}

// ── what the runner applied ──────────────────────────────────────────────────

/** One netem call as the log recorded it. */
interface NetemCall {
  at: number
  call: string
  /** the script's own transcript lines, for the readback and the proof lines */
  output: string[]
  /** the group supervisor shaped a shared runner rather than this bot's own link */
  shared: boolean
}

interface Phase {
  at: number
  state: string
  detail: string
}

const HEAD = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (shared )?netem (.*)$/
const STEP = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (?:shared )?network step (\d+) at .*?: (.*)$/
const PHASE = /^E2E_NETEM_PHASE\t(\w+)\t(\S+)/

/** netem.log is `<ISO> netem <call>` (or `shared netem`) followed by the script's own
 *  `[netem] …` transcript and its `E2E_NETEM_PHASE` lines. */
function readNetemLog(dir: string): { calls: NetemCall[]; phases: Phase[] } {
  const path = join(dir, "netem.log")
  if (!existsSync(path)) return { calls: [], phases: [] }
  const calls: NetemCall[] = []
  const phases: Phase[] = []
  let current: NetemCall | null = null
  let lastAt = 0
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const head = HEAD.exec(line)
    if (head) {
      lastAt = MS(head[1]!)
      current = { at: lastAt, call: head[3]!, output: [], shared: Boolean(head[2]) }
      calls.push(current)
      continue
    }
    const step = STEP.exec(line)
    if (step) {
      lastAt = MS(step[1]!)
      current = { at: lastAt, call: `step ${step[2]}: ${step[3]}`, output: [], shared: false }
      calls.push(current)
      continue
    }
    const phase = PHASE.exec(line)
    if (phase) {
      phases.push({ at: lastAt, state: phase[1]!, detail: phase[2]! })
      continue
    }
    if (current) current.output.push(line)
  }
  return { calls, phases }
}

/** A window the shaping was in force: [start, end] plus what it was. */
interface Window {
  from: number
  to: number
  label: string
  verb: string
  /** what the app should have seen, in words, for the report's first column */
  expect: string
}

/** How long each sleeping verb holds, by argument index. Everything else lasts until the next call. */
const SLEEP_ARG: Record<string, number> = { blackout: 0, "udp-cut": 0, outage: 1, "video-stall": 0, "host-chain-cut": 0, "host-chain-hang": 0, spike: 0 }

/** Calls whose effect lasts until another call undoes it rather than until the next call. */
const ONE_SHOT = new Set(["block-udp"])
const UNDOES: Record<string, string> = { "block-udp": "allow-udp" }

/** The calls that ARE a fault, as the netem log writes them. The profile's own
 *  timeline is what was PLANNED; these are what the runner actually applied, and
 *  they are the ground truth this report reads (see the header). A profile can
 *  carry a fault outside `timeline` too — `switcher`'s blackout rides its network
 *  switch — so the log, not the profile, decides whether a fault was in force. */
const FAULT_VERBS = new Set([
  "block-udp",
  "udp-cut",
  "outage",
  "blackout",
  "video-stall",
  "host-chain-cut",
  "host-chain-hang",
  "spike",
  "custom",
])

/** Every fault call the log records, in order. */
const faultCalls = (calls: readonly NetemCall[]): NetemCall[] =>
  calls.filter((c) => FAULT_VERBS.has(c.call.split(" ")[0]!))

/** When a one-shot call is undone: the undoing call, or the run's own clear. */
function untilUndone(calls: readonly NetemCall[], from: number, verb: string): number | undefined {
  const undo = UNDOES[verb]
  const after = calls.slice(from + 1)
  return after.find((c) => c.call.startsWith(undo ?? "\0"))?.at ?? after.find((c) => c.call.startsWith("clear"))?.at
}

/** The label a window is reported under: the call, minus the runner's own file paths (the host-hook calls carry them). */
const windowLabel = (call: string): string =>
  call
    .split(" ")
    .filter((part) => !part.startsWith("/tmp/"))
    .join(" ")

const heldDuration = (call: NetemCall): number | undefined => {
  const verb = call.call.split(" ")[0]!
  const sleepIndex = SLEEP_ARG[verb]
  const seconds = sleepIndex === undefined ? NaN : Number(call.call.split(" ").slice(1)[sleepIndex])
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

/** The transcript stamps a sleeping call when it finishes, so its real start
 *  is its stamp minus the duration it held the runner. */
const callStart = (call: NetemCall): number => call.at - (heldDuration(call) ?? 0)

function shapingWindows(calls: readonly NetemCall[], spanEnd?: number): Window[] {
  const windows: Window[] = []
  for (const [i, call] of calls.entries()) {
    const verb = call.call.split(" ")[0]!
    if (["show", "stats", "clear", "profile-args"].includes(verb) || verb.startsWith("step")) continue
    const held = heldDuration(call)
    // netem.log stamps a call when it FINISHES (network.ts writes the line after the child exits), so a
    // sleeping call's window runs BACKWARDS from its stamp. A quick call's stamp is its start.
    if (held !== undefined) {
      windows.push({ from: call.at - held, to: call.at, label: windowLabel(call.call), verb, expect: describeCall(call.call) })
      continue
    }
    // A one-shot hook (the UDP block) stays in force until the call that undoes it, not until the next call.
    const oneShot = ONE_SHOT.has(verb)
    const nextCall = calls.slice(i + 1).find((candidate) => {
      const nextVerb = candidate.call.split(" ")[0]!
      return !["show", "stats", "clear", "profile-args"].includes(nextVerb) && !nextVerb.startsWith("step")
    })
    const nextStart = nextCall ? callStart(nextCall) : undefined
    const to = (oneShot ? untilUndone(calls, i, verb) : nextStart) ?? Math.max(call.at, spanEnd ?? call.at)
    windows.push({ from: call.at, to, label: windowLabel(call.call), verb, expect: describeCall(call.call) })
  }
  return windows
}

const describeCall = (call: string): string => {
  const [verb, ...args] = call.split(" ")
  switch (verb) {
    case "apply":
    case "swap":
      return `netem ${args[0]} in force`
    case "custom":
      return `ad-hoc ${args[0]}ms/${args[1]}ms/${args[2]}%/${args[3]}Mbit`
    case "spike":
      return `${args[1]}ms/${args[2]}ms/${args[3]}%/${args[4]}Mbit for ${args[0]}s`
    case "block-udp":
      return "outbound UDP blocked except DNS (relay only)"
    case "allow-udp":
      return "UDP block lifted"
    case "udp-cut":
      return `UDP + relay cut ${args[0]}s, People RPC kept up`
    case "outage":
      return `${args[0]} unreachable ${args[1]}s`
    case "blackout":
      return `everything dropped ${args[0]}s`
    case "video-stall":
      return `video packets >=300B dropped ${args[0]}s`
    case "host-chain-cut":
      return `signing host's chain link cut ${args[0]}s`
    case "host-chain-hang":
      return `signing host's chain link hung ${args[0]}s`
    default:
      return call
  }
}

// ── what the persona was supposed to get ────────────────────────────────────

const netemLine = (p: NetemProfile | undefined): string =>
  p ? `${p.rateMbit > 0 ? `${p.rateMbit} Mbit` : "unlimited"}, ${p.delayMs}ms${p.jitterMs > 0 ? ` ±${p.jitterMs}ms` : ""}, ${p.lossPct}% loss` : "unknown netem profile"

const describeStep = (step: Profile["network"]["timeline"] extends (infer T)[] | undefined ? T : never): string => {
  const when =
    step.atTurn !== undefined
      ? `turn ${step.atTurn}`
      : step.atS !== undefined
        ? `T+${step.atS}s`
        : step.atBeforeGameS !== undefined
          ? `T-${step.atBeforeGameS}s`
          : step.atSignUp
            ? "sign-up"
            : step.atConfirm
              ? "confirm"
              : step.atOpen
                ? "open"
                : "round channels"
  const what = [
    step.profile && `netem ${step.profile}`,
    step.delayMs !== undefined && `${step.delayMs}ms`,
    step.jitterMs !== undefined && `±${step.jitterMs}ms`,
    step.lossPct !== undefined && `${step.lossPct}%`,
    step.rateMbit !== undefined && `${step.rateMbit} Mbit`,
    step.blackoutS && `blackout ${step.blackoutS}s`,
    step.outage && `${step.outage} outage`,
    step.udpCutS && `UDP cut ${step.udpCutS}s`,
    step.videoStallS && `video stall ${step.videoStallS}s`,
    step.hostChainCutS && `host chain cut ${step.hostChainCutS}s`,
    step.hostChainHangS && `host chain hang ${step.hostChainHangS}s`,
    step.allowUdp && "UDP block lifted",
    step.forS !== undefined && `for ${step.forS}s`,
  ].filter(Boolean)
  return `${when}: ${what.join(", ")}`
}

/** How many steps the app's own `fired` counter covers: the TIMELINE steps (by turn or by second),
 *  plus the switch sugar. `atOpen` / `atSignUp` / `atConfirm` steps ride their own hooks and are
 *  never in that count, so they must not be compared with it. */
const plannedSteps = (profile: Profile): number =>
  (profile.network.timeline ?? []).filter((s) => !s.atOpen && !s.atSignUp && !s.atConfirm).length +
  (profile.network.switchAtTurn !== undefined && profile.network.switchTo !== undefined ? 1 : 0)

/** Does this profile apply anything a phone should notice? A wifi link with no timeline is a control. */
/** Does this profile apply NETWORK/DEVICE shaping this reader can judge? A wifi
 *  link with no timeline, no role and no camera delay is a control.
 *
 *  The role is deliberately NOT here: this reader reads network and app records,
 *  and a role is a different kind of stress (see `roleStressed`). Keeping the
 *  two apart is what lets a persona that carries BOTH — `late-join-…-lte-good`,
 *  `slow-pixel7` (lte-poor, ×4) — still be judged on the network axis instead of
 *  being written off as "cannot tell". */
const isStress = (profile: Profile): boolean =>
  profile.network.profile !== "wifi" ||
  profile.network.relayOnly ||
  (profile.network.timeline?.length ?? 0) > 0 ||
  (profile.network.switchAtTurn !== undefined && profile.network.switchTo !== undefined) ||
  profile.cpuThrottle > 1

/** Stressed by what the bot DOES rather than by what the netem applied:
 *  freezing the page, killing the host, storming taps, stepping the clock, a
 *  delayed camera. The journey's own guards judge these; this reader cannot, so
 *  it must not score them as "no impact" either (lane S2: 15 such personas were
 *  being called controls while their journey.log proved the act fired).
 *
 *  The clock is the case that hid behind `role.kind: baseline`: `clock-jumps`,
 *  `clock-wrong-then-corrected` and `clock-ahead-then-corrected` carry their fault
 *  in `clockOffsetS` / `clockJumps`, which nothing here looked at, so they were
 *  printed as plain controls ("nothing was applied that should change the app")
 *  while their journey logged `ROLE ACT … page clock set to +30 s, read back +30 s`.
 *  They were also counted in the run's control reference, which shifted it. */
export const unmeasuredStress = (profile: Profile): string[] => {
  const reasons: string[] = []
  if (profile.role.kind !== "baseline") reasons.push(`role ${profile.role.kind}`)
  // Faults injected INSIDE the peer connection rather than on the link: the page drops
  // offers, replaces a video track, or serves a telemetry torture. None of them moves
  // the network record this reader reads, and all of them were being scored as plain
  // "no impact" controls — feeding the run's own rtt/loss/frame reference.
  if (profile.peerFault) reasons.push(`peer fault ${profile.peerFault.kind}`)
  if (profile.dataChannelFault) reasons.push(`data-channel fault: ${profile.dataChannelFault.dropRenegotiationOffers} dropped offer(s)`)
  if (profile.telemetryTorture) reasons.push("telemetry torture")
  if ((profile.camera?.delayMs ?? 0) > 0) reasons.push(`camera delay ${profile.camera.delayMs}ms`)
  const clock = profile.clockOffsetS ?? 0
  if (clock !== 0) reasons.push(`clock ${clock > 0 ? "+" : ""}${clock} s from boot`)
  if (profile.clockJumps?.length) reasons.push(`clock jumps at turns ${profile.clockJumps.map((j) => j.atTurn).join(", ")}`)
  return reasons
}

/** Stressed by something this reader does not measure. The control set and the verdict
 *  both ask this ONE question, so neither can drift from the other, and the verdict
 *  quotes the same reasons rather than re-describing the predicate by hand — which is
 *  how a clock persona came to be explained as a role persona. */
export const roleStressed = (profile: Profile): boolean => unmeasuredStress(profile).length > 0

const intendedShaping = (profile: Profile, netem: Record<string, NetemProfile>): string => {
  const n = profile.network
  const parts = [netemLine(netem[n.profile])]
  if (n.relayOnly) parts.push("UDP blocked (relay only)")
  if (n.switchAtTurn !== undefined && n.switchTo) parts.push(`turn ${n.switchAtTurn}: → ${n.switchTo}${n.blackoutS ? ` + blackout ${n.blackoutS}s` : ""}`)
  for (const step of n.timeline ?? []) parts.push(describeStep(step))
  if (profile.cpuThrottle > 1) parts.push(`CPU ×${profile.cpuThrottle}`)
  return parts.join("; ")
}

// ── the run ─────────────────────────────────────────────────────────────────

interface Result {
  profile?: string
  startedAt?: string
  finishedAt?: string
  /** acts the bot could not do for a reason that is not its fault, as the journey typed them
   *  (result.ts `SlotResult.inconclusive`): the run's own verdict, in the run's own words */
  inconclusive?: { name: string; detail: string }[]
  /** the account this bot played as; the key that ties another bot's receiver-quality records to it */
  account?: string
  adaptiveUpload?: {
    page?: {
      rung?: number
      transitions?: {
        direction: string
        cause: string
        from: number
        to: number
        /** the page's MONOTONIC clock; see `wallOrigin` */
        atMs: number
        before?: { rttMs?: number; availableKbps?: number; cpuShare?: number; encodeMsPerFrame?: number; route?: string; pressure?: string }
      }[]
      roundSecondsByRung?: Record<string, number>
      lowPower?: boolean
      lowPowerReason?: string
    } | null
    network?: { runs?: { call: string[]; startMs: number; endMs: number; ok: boolean; inconclusive: boolean }[]; problems?: string[]; fired?: number; planned?: number }
  } | null
  telemetryGroundTruth?: { unavailable?: string }
}

interface Artifact {
  dir: string
  profile: string
  /** the definition the run itself recorded for this runner */
  definition: Profile | null
  slot: number
  runId: string
  attempt: number
  phase: string
  result: Result | null
  log: DevLog | null
  netem: ReturnType<typeof readNetemLog>
  /** the run's own `INCONCLUSIVE … applies to this run` reasons, keyed by persona */
  journey: Map<string, string>
}

const ARTIFACT = /^e2e-live-(\d+)-attempt-(\d+)-(.+?)-bot(\d+)(-result)?$/

function readArtifacts(root: string): Artifact[] {
  const found = new Map<string, Artifact>()
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (!statSync(path).isDirectory()) continue
    const m = ARTIFACT.exec(name)
    if (!m) continue
    const [, runId, attempt, phase, bot, isResult] = m
    const slot = Number(bot)
    const key = `${runId}-${attempt}-${phase}-${slot}`
    const entry: Artifact =
      found.get(key) ?? { dir: path, profile: "?", definition: null, slot, runId: runId!, attempt: Number(attempt), phase: phase!, result: null, log: null, netem: { calls: [], phases: [] }, journey: new Map() }
    if (isResult) {
      const file = join(path, `result-${slot}.json`)
      if (existsSync(file)) entry.result = JSON.parse(readFileSync(file, "utf8")) as Result
    } else {
      entry.dir = path
      const profileFile = join(path, "profile.json")
      if (existsSync(profileFile)) {
        const doc = JSON.parse(readFileSync(profileFile, "utf8")) as { profile?: string; definition?: Profile }
        entry.profile = doc.profile ?? doc.definition?.name ?? "?"
        entry.definition = doc.definition ?? null
      }
      entry.log = readDevLog(path, slot)
      entry.netem = readNetemLog(path)
      entry.journey = readJourneyLog(path)
    }
    found.set(key, entry)
  }
  return [...found.values()].sort((a, b) => a.attempt - b.attempt || a.slot - b.slot || a.phase.localeCompare(b.phase))
}

// ── the assessment ──────────────────────────────────────────────────────────

type Verdict = "impact seen" | "no impact" | "cannot tell"

const RUNG_NAMES = ["full", "lean", "low", "minimum", "survival"]

interface Row {
  artifact: Artifact
  profile: Profile | null
  intended: string
  verdict: Verdict
  evidence: string[]
  flags: string[]
  /** the run's own reference numbers, filled in for the control personas */
  reference: { rttP50: number | null; lossPct: number | null; rung: number | null } | null
  /** the CPU throttle and the frame record that says whether it was felt */
  cpu: { throttle: number; probeMedianMs: number | null; probeP95Ms: number | null; longTasks: number } | null
}

/** What the run-wide peer index needs to attribute one bot's shaping to the peers that felt it. */
interface PeerContext {
  index: Map<string, PeerEvidence>
  /** which slots' results exist, so a missing account can be reported as missing rather than as unseen */
  accountKnown: boolean
}

function assess(a: Artifact, netemProfiles: Record<string, NetemProfile>, profiles: Profile[], peers: PeerContext): Row {
  const profile = a.definition ?? profiles.find((p) => p.name === a.profile) ?? null
  const intended = profile ? intendedShaping(profile, netemProfiles) : `unknown profile ${a.profile}`
  const evidence: string[] = []
  const flags: string[] = []
  const log = a.log
  const page = a.result?.adaptiveUpload?.page ?? null

  const start = a.netem.calls.find((c) => /^(shared )?netem apply/.test(c.call) || c.call.startsWith("apply"))?.at
  const cleared = a.netem.phases.filter((p) => p.state === "restored" && p.detail === "clear").at(-1)?.at
  const lastLogAt = log?.lines.at(-1)?.ts
  const span = start !== undefined ? { from: start, to: cleared ?? lastLogAt ?? a.netem.calls.at(-1)?.at ?? start } : null
  const windows = shapingWindows(a.netem.calls, span?.to)
  const account = a.result?.account ?? null
  // The run's own word on this persona, read here so BOTH early returns below can use it:
  // a persona the journey declared impossible has a cause, and saying "the app exported
  // nothing" instead names the app for something the run decided.
  const journey = profile ? runVerdict(a.result, a.journey, profile.name) : undefined

  // ---- did the shaping itself take effect? the log's own proof lines ----
  const apply = a.netem.calls.find((c) => c.call.startsWith("apply"))
  const applied = apply !== undefined
  // The apply's own transcript says the qdisc went in (`[netem] ens4: netem delay 10ms (profile wifi)`);
  // a `show` call, when the plan makes one, adds the `tc qdisc` readback on top.
  const wrote = apply?.output.some((l) => /^\[netem\] \S+: netem /.test(l)) ?? false
  const readback = a.netem.calls.find((c) => c.call === "show")?.output.find((l) => /qdisc netem/.test(l))
  if (profile && !applied) flags.push("no netem apply in this runner's log: the profile's link was never shaped")
  else if (profile && !wrote && !readback) flags.push("netem apply ran but wrote no qdisc line: the qdisc is not proven in force")
  if (profile?.network.relayOnly && !a.netem.calls.some((c) => c.call === "block-udp")) flags.push("relayOnly profile but no UDP block in the log")

  // ---- did the plan's timed steps actually fire? the app's own record says ----
  const plan = profile ? plannedSteps(profile) : 0
  const network = a.result?.adaptiveUpload?.network
  if (plan > 0 && network) {
    const fired = network.fired ?? 0
    const problems = network.problems ?? []
    if (fired < plan) flags.push(`${plan} timed step(s) planned, ${fired} fired${problems.length ? `: ${problems.join("; ")}` : ""}`)
  }

  // ---- app-side coverage ----
  if (!log) {
    // A terminal pre-game persona has no game devLog BY DESIGN: it is never handed over,
    // so blaming the export would read as an app defect. Say which it is.
    evidence.push(
      journey
        ? `the run declared this persona inconclusive, so its fault was never played: ${journey}`
        : (profile?.expectedOutcome
            ? `profile ${profile.expectedOutcome.kind} (camera ${profile.camera.mode ?? "ok"}): the bot is deliberately never handed over to the game, so it has no game devLog by design — the journey's own permission-gate stage judges this persona`
            : "no devLog artifact: the app exported nothing for this runner"),
    )
    return { artifact: a, profile, intended, verdict: "cannot tell", evidence, flags, reference: null, cpu: null }
  }
  if (log.lines.length === 0) {
    evidence.push(journey ? `the run declared this persona inconclusive, so its fault was never played: ${journey}` : `devLog is empty${log.why ? ` (${log.why})` : ""}`)
    if (page) evidence.push(`page snapshot survives: rung ${RUNG_NAMES[page.rung ?? 0] ?? page.rung}, ${page.transitions?.length ?? 0} rung change(s), low power ${page.lowPower}`)
    return { artifact: a, profile, intended, verdict: "cannot tell", evidence, flags, reference: null, cpu: null }
  }

  // ---- rtt / loss / jitter over the shaped span ----
  const stats = span ? rtcStats(log, span.from, span.to) : null
  const peerStats = span ? peerNetworkStatsIn(peers.index, account, span.from, span.to) : null
  const spanRtt = span ? rtts(log, span.from, span.to) : []
  const rttP50 = pct(spanRtt, 0.5)
  const rttP95 = pct(spanRtt, 0.95)
  if (rttP50 !== null) evidence.push(`rtt p50 ${round(rttP50)}ms / p95 ${round(rttP95 ?? 0)}ms (${spanRtt.length} samples)`)
  const lossPct = peerStats && peerStats.received + peerStats.lost > 0 ? (peerStats.lost / (peerStats.received + peerStats.lost)) * 100 : null
  if (stats && stats.received > 0) {
    evidence.push(`own inbound (not attributed to this persona's egress shaping): ${stats.lost}/${stats.received + stats.lost} packets lost, jitter max ${stats.jitterMs}ms over ${stats.links} link(s); in ${stats.maxHeight}p at ${stats.maxFps}fps; ${stats.freezes} freeze(s) totalling ${round(stats.freezeSeconds, 1)}s`)
  } else {
    evidence.push("no receiver-quality counters in the shaped span: the app reported no inbound video there")
  }
  if (peerStats && peerStats.received + peerStats.lost > 0) {
    evidence.push(`egress as peers received it: loss ${round(lossPct ?? 0, 2)}% (${peerStats.lost}/${peerStats.received + peerStats.lost} pkts), jitter max ${peerStats.jitterMs}ms over ${peerStats.links} link(s) from ${peerStats.observers} peer(s)`)
  } else {
    evidence.push("no peer receiver-quality counters cover this persona's egress in the shaped span")
  }
  const protocols = [...new Set((stats?.paths ?? []).map((p) => p.split(" ").at(-1)))]
  if (protocols.length) evidence.push(`path ${[...new Set(stats!.paths)].slice(0, 4).join(", ")}`)

  // ---- the send ladder ----
  if (page) {
    const seconds = Object.entries(page.roundSecondsByRung ?? {}).filter(([, s]) => s > 0)
    const transitions = (page.transitions ?? []).map((t) => `${RUNG_NAMES[t.from] ?? t.from}→${RUNG_NAMES[t.to] ?? t.to} (${t.cause})`)
    evidence.push(`send rung ended ${RUNG_NAMES[page.rung ?? 0] ?? page.rung}; ${seconds.map(([n, s]) => `${n} ${round(s)}s`).join(", ") || "no round seconds"}; ${transitions.length ? transitions.join(", ") : "no rung changes"}`)
  }
  if (page?.lowPower !== undefined) evidence.push(`low power ${page.lowPower ? "on" : "off"}${page.lowPowerReason ? ` (${page.lowPowerReason})` : ""}`)

  // ---- the CPU throttle, against the app's own frame record ----
  // `profile.cpuThrottle` is what the run asked CDP for (browser-profile.ts
  // `Emulation.setCPUThrottlingRate`); the app never sees the number, so the only
  // evidence it slowed is the app's own frame times. Two sources carry them: the
  // device probe's `device check (…)` lines (p95 and median frame time, per sample)
  // and the harness's long-task snapshot. The Sentry metrics ui.frame_ms /
  // ui.slow_frame_pct / ui.long_task_ms are NOT in a devLog export, so no slow-frame
  // share is claimed here: a report that printed one would have invented it.
  const cpuThrottle = profile?.cpuThrottle ?? 1
  const probes = probeSamples(log)
  const probeInSpan = span ? probes.filter((s) => inWindow({ ts: s.at, tag: "low-power", message: "" }, span.from, span.to)) : probes
  const tasks = log.longTasks
  const tasksInSpan = span ? tasks.filter((t) => t.endedAt >= span.from && t.endedAt <= span.to) : tasks
  const powerChanges = lowPowerChanges(log)
  /** this persona's frame record, for the verdict and for the table */
  const cpu = {
    throttle: cpuThrottle,
    probeMedianMs: probeInSpan.length ? (pct(probeInSpan.map((s) => s.medianMs), 0.5) ?? null) : null,
    probeP95Ms: probeInSpan.length ? (pct(probeInSpan.map((s) => s.p95Ms), 0.5) ?? null) : null,
    longTasks: tasksInSpan.length,
  }
  if (cpuThrottle > 1) {
    const p95s = probeInSpan.map((s) => s.p95Ms)
    const medians = probeInSpan.map((s) => s.medianMs)
    if (probeInSpan.length) {
      const rules = [...new Set(probeInSpan.map((s) => s.rule))]
      evidence.push(
        `CPU ×${cpuThrottle} asked of the browser; the app's own frame probe measured p95 ${round(pct(p95s, 0.5) ?? 0)}ms / median ${round(pct(medians, 0.5) ?? 0)}ms over ${probeInSpan.length} sample(s) (${probeInSpan.map((s) => `${s.frames} frames, p95 ${s.p95Ms}ms`).join("; ")}; rule ${rules.join("/")})`,
      )
    } else {
      evidence.push(`CPU ×${cpuThrottle} asked of the browser; the app's device probe logged no sample`)
    }
    evidence.push(`${tasksInSpan.length} long task(s) >=1000ms in the shaped span${tasksInSpan.length ? ` (max ${round(Math.max(...tasksInSpan.map((t) => t.ms)))}ms, scenes ${[...new Set(tasksInSpan.map((t) => t.scene))].join("/")})` : ""}`)
    if (powerChanges.length) evidence.push(`low power transitions: ${powerChanges.map((c) => `${at(c.at)} ${c.on ? "on" : "off"} (${c.reason})`).join(", ")}`)
  }

  // ---- what the OTHER bots recorded about this one ----
  // A bot's own devLog shows its own screen; the damage its link does to the
  // peers is only in THEIR receiver-quality records. The account is the key.
  const peerReading = (from: number, to: number): string | null => {
    const seen = peerEvidenceIn(peers.index, account, from, to)
    if (!seen) return null
    const fps = seen.readings.map((r) => r.fps).filter((n): n is number => typeof n === "number")
    const deltas = seen.readings.map((r) => r.framesDecodedDelta).filter((n): n is number => typeof n === "number")
    const freezes = seen.readings.map((r) => r.freezeCount).filter((n): n is number => typeof n === "number")
    const black = deltas.filter((n) => n === 0).length
    const paths = [...new Set(seen.readings.map((r) => r.path).filter((s): s is string => s !== null))]
    const parts = [
      `seen by ${seen.observers} peer(s)`,
      fps.length ? `fps p50 ${round(pct(fps, 0.5) ?? 0, 1)} (min ${round(Math.min(...fps), 1)})` : "",
      deltas.length ? `${deltas.length} window(s), ${black} with 0 frames decoded` : "",
      freezes.length ? `freeze max ${Math.max(...freezes)}` : "",
      paths.length ? `their path ${paths.slice(0, 3).join(", ")}` : "",
    ].filter(Boolean)
    return parts.join(", ")
  }
  if (span) {
    const seen = peerReading(span.from, span.to)
    if (seen) evidence.push(`as its peers saw it: ${seen}`)
    else if (!account) flags.push("no result-N.json for this runner, so no account: the other bots' records of it cannot be attributed")
    else if (!peers.accountKnown) flags.push("no bot's result-N.json carries an account: peer attribution is impossible in this run")
    else evidence.push("no other bot's receiver-quality record names this bot's account: the run gives no peer-side view of it")
  }
  // A CPU persona whose evidence is only the probe must say what it could NOT read: the
  // Sentry metrics that carry the slow-frame share and long-task distribution are not in
  // any devLog export, so their absence is stated, never filled in.
  if (cpuThrottle > 1 && page?.lowPowerReason !== undefined && probes.length === 0)
    flags.push("CPU persona but the app's device probe logged no sample: the frame record is empty, so the throttle's effect cannot be read")

  // ---- the app's own repair signals over the shaped span ----
  // Every signal is counted from ONE list, both here and per window, so a signal added
  // for a window cannot silently stay out of this line: the span summary used to name
  // heals, stalls and chain lines only, and a TURN outage would have read "nothing
  // happened" in the very row it was added to rescue.
  const spanCounts = SIGNALS.map((s) => (span ? countMatching(log, span.from, span.to, s.re) : 0))
  const help = log.lines.some((l) => /connection-help/.test(l.message))
  if (span) {
    const said = SIGNALS.map((s, i) => (spanCounts[i] ? `${spanCounts[i]} ${s.label}` : "")).filter(Boolean)
    evidence.push(`${said.length ? said.join(", ") : "no repair line"} in the shaped span${help ? "; the app went to /connection-help" : ""}`)
  }

  // ---- per-window movement, for the steps that name one ----
  // A fault is a window whose call is one of FAULT_VERBS. The 10 s floor keeps a
  // momentary spike from standing in for a sustained fault, but it must not hide
  // a short one either: `video-stall 10` is 10 s of dropped video packets and
  // the app answers it inside that window. So a fault window is kept down to
  // FAULT_FLOOR_MS and only the non-fault (netem apply/swap) windows keep 10 s.
  const FAULT_FLOOR_MS = 5_000
  const notable = windows.filter((w) =>
    FAULT_VERBS.has(w.verb) ? w.to - w.from >= FAULT_FLOOR_MS : w.verb !== "apply" && w.verb !== "swap" && w.to - w.from >= 10_000,
  )
  /** faults whose window the app answered with a heal or a stall: the evidence the verdict may use */
  const answeredWindows: Window[] = []
  const silentWindows: Window[] = []
  // A transition's atMs is the page's monotonic clock; the devLog's timing block is the
  // only bridge to wall time, so without it no transition can be placed in a window.
  const origin = wallOrigin(log)
  const transitionsAt = (w: Window): { cause: string; to: number }[] =>
    origin === null ? [] : (page?.transitions ?? []).filter((t) => t.atMs + origin >= w.from && t.atMs + origin <= w.to)
  for (const w of notable) {
    const winRtt = rtts(log, w.from, w.to)
    const winCounts = SIGNALS.map((s) => countMatching(log, w.from, w.to, s.re))
    const winAway = countMatching(log, w.from, w.to, /peer away|peer back/)
    const winStats = rtcStats(log, w.from, w.to)
    const winPeerStats = peerNetworkStatsIn(peers.index, account, w.from, w.to)
    const winLoss = winPeerStats && winPeerStats.received + winPeerStats.lost > 0 ? (winPeerStats.lost / (winPeerStats.received + winPeerStats.lost)) * 100 : null
    const winLines = log.lines.filter((l) => inWindow(l, w.from, w.to)).length
    const p = pct(winRtt, 0.5)
    // The send rung in force during the window: the rung a transition moved INTO inside
    // it, or the rung the page ended on when the window holds no transition.
    const winTransitions = transitionsAt(w)
    const rungInWindow = winTransitions.length ? winTransitions.at(-1)!.to : (page?.rung ?? null)
    const parts = [
      `${winLines} app line(s)`,
      winRtt.length ? `rtt p50 ${round(p!)}ms` : "no rtt samples",
      winLoss !== null ? `peer-received loss ${round(winLoss, 2)}%` : "",
      pathSplit(winStats.paths) ? `path ${pathSplit(winStats.paths)}` : "",
      rungInWindow !== null ? `rung ${RUNG_NAMES[rungInWindow] ?? rungInWindow}${winTransitions.length ? ` (${winTransitions.map((t) => t.cause).join(",")})` : ""}` : "",
      ...SIGNALS.map((s, i) => (winCounts[i] ? `${winCounts[i]} ${s.label}` : "")),
      winAway ? `${winAway} away/back` : "",
    ].filter(Boolean)
    // The other bots' view of THIS bot in the same window, when the run carries one and
// the window is not the whole shaped span (that reading is already in the row).
    const winPeers = span && w.to - w.from >= 0.9 * (span.to - span.from) ? null : peerReading(w.from, w.to)
    if (winPeers) parts.push(`peers: ${winPeers}`)
    evidence.push(`window ${at(w.from)}–${atZ(w.to)} (${w.label}): ${parts.join(", ")}`)
    // A fault window is answered when the app moved inside it. Because netem
    // shapes egress, loss belongs here only when the peers recorded it.
    const winLossMoved = winLoss !== null && winLoss >= 1
    if (SIGNALS.some((s, i) => s.answers && winCounts[i]! > 0) || winAway > 0 || winLossMoved) answeredWindows.push(w)
    // A window with no app line at all is the only true silence: an rtt gap alone is not.
    if (winLines === 0) {
      silentWindows.push(w)
      flags.push(`window ${at(w.from)} (${w.label}) has no app-side record at all`)
    }
  }
  // A fault the app answered only through the peers' eyes still counts: the peers saw
  // frames stop. This is a separate read so a persona whose OWN log is quiet but whose
  // peers saw it freeze is not scored "no impact".
  // A whole-game window (a relay-only span lasting the game) would trivially hold a
  // zero-frame reading or two from the video's own start-up, so the bar is a SHARE of
  // the window's readings, not one: at least two readings, and at least a quarter of
  // them showing no frames decoded.
  const peerAnsweredWindows = notable.filter((w) => {
    const seen = peerEvidenceIn(peers.index, account, w.from, w.to)
    if (!seen || seen.readings.length < 2) return false
    const blank = seen.readings.filter((r) => r.framesDecodedDelta === 0 || (r.fps !== null && r.fps < 5)).length
    return blank >= 2 && blank / seen.readings.length >= 0.25
  })

  // ---- the verdict, against what this shaping predicts ----
  const reference = isStress(profile ?? ({ network: { profile: "wifi" } } as Profile)) ? null : { rttP50, lossPct, rung: page?.rung ?? null }
  let verdict: Verdict
  // The run's own word comes FIRST: when the journey declared the persona impossible for
  // this build, its fault was never attempted, and no reading of the netem log can turn
  // that into an impact — or into a pass.
  if (!profile) verdict = "cannot tell"
  else if (journey) {
    verdict = "cannot tell"
    evidence.push(`the run declared this persona inconclusive, so its fault was never played: ${journey}`)
  } else if (!applied) verdict = "cannot tell"
  else if (roleStressed(profile) && !isStress(profile)) {
    // A ROLE persona is stressed by what the bot DOES, not by what the netem
    // applied. This reader only reads network/app records, so it has nothing
    // honest to say about whether a freeze, a SIGKILL or a tap storm reached
    // the app — the journey's own guards answer that. Say so; never score it.
    // This test comes BEFORE the control branch: a role persona is not a
    // control, and reading it as one is the error lane S2 found in 15 rows.
    verdict = "cannot tell"
    evidence.push(
      `${unmeasuredStress(profile).join(" + ")}: this persona is stressed by what the bot DOES, which the journey's own guards judge — the network/app record read here cannot score it`,
    )
  } else if (!isStress(profile)) {
    verdict = "no impact"
    evidence.push("control link: wifi with no faults and a baseline role, so nothing was applied that should change the app")
  } else {
    const netem = netemProfiles[profile.network.profile]
    // A fault was IN FORCE if the log applied one — not if the profile planned
    // one. The profile's `timeline` misses the faults that ride another field
    // (`switcher`'s blackoutS sits on `network`, not in `timeline`) and would
    // also count a step that never fired. The log is the only honest answer,
    // and a persona whose fault fired but whose app left no heal line must not
    // be scored "no impact" for want of a profile field.
    const timelineFault = faultCalls(a.netem.calls).length > 0
    // each prediction: did the app show the thing this shaping should cause?
    const signals: string[] = []
    if (netem && netem.delayMs >= 40 && rttP50 !== null) signals.push(`rtt ${round(rttP50)}ms vs the run's wifi reference ${round(baseline.rttP50 ?? 0)}ms`)
    if (netem && netem.rateMbit > 0 && netem.rateMbit <= 2 && page) signals.push(`rung ${RUNG_NAMES[page.rung ?? 0] ?? page.rung} under a ${netem.rateMbit} Mbit cap`)
    if (netem && netem.lossPct >= 1 && lossPct !== null) signals.push(`loss ${round(lossPct, 2)}% against a ${netem.lossPct}% configured loss`)
    if (profile.network.relayOnly && stats && stats.paths.length > 0) signals.push(`path ${[...new Set(stats.paths)].join(", ")} under a UDP block`)
    if (timelineFault && answeredWindows.length > 0) signals.push(`${answeredWindows.length} fault window(s) answered by the app (${answeredWindows.map((w) => atZ(w.from)).join(", ")})`)
    if (peerAnsweredWindows.length > 0) signals.push(`${peerAnsweredWindows.length} fault window(s) where the PEERS saw this bot's frames stop (${peerAnsweredWindows.map((w) => atZ(w.from)).join(", ")})`)
    // The CPU throttle: the app's own frame probe against the run's unthrottled controls.
    // The app never sees `cpuThrottle`, so the only evidence it was felt is a frame
    // measurement outside the range the run's own control personas produced. Inside
    // that range, the throttle is not separable from the runner's frame budget and the
    // honest reading is "no impact", flagged — never "impact seen" on the profile alone.
    const probeOutsideControls =
      cpuThrottle > 1 && cpu.probeP95Ms !== null && baseline.cpuProbeP95 !== null && (baseline.cpuProbeRange === null || cpu.probeP95Ms > baseline.cpuProbeRange.max)
    if (cpuThrottle > 1) {
      signals.push(`CPU ×${cpuThrottle} with low power ${page ? (page.lowPower ? "on" : "off") : "unreported"}, frame probe p95 ${cpu.probeP95Ms === null ? "unmeasured" : `${round(cpu.probeP95Ms)}ms`}${baseline.cpuProbeP95 === null ? "" : ` vs the run's controls ${round(baseline.cpuProbeP95)}ms${baseline.cpuProbeRange ? ` (${round(baseline.cpuProbeRange.min)}–${round(baseline.cpuProbeRange.max)}ms)` : ""}`}, ${cpu.longTasks} long task(s)`)
    }
    // Half the configured delay, floor 25 ms: the span median mixes the profile's own steps and jitter,
// so a full configured delay is more than the app can be expected to show end to end.
    const moved =
      (netem?.delayMs ?? 0) >= 40 && rttP50 !== null && baseline.rttP50 !== null && rttP50 >= baseline.rttP50 + Math.max(25, netem!.delayMs * 0.5)
    const lagged = (netem?.rateMbit ?? 0) > 0 && (netem?.rateMbit ?? 0) <= 2 && page !== null && (page.rung ?? 0) > 0
    const lossy = (netem?.lossPct ?? 0) >= 1 && lossPct !== null && lossPct >= netem!.lossPct * 0.3
    // With UDP blocked every reported path must carry a relay leg. A merely
    // non-host/host path can still be srflx/prflx without TURN and is not proof.
    const relayed =
      Boolean(profile.network.relayOnly) &&
      (stats?.paths.length ?? 0) > 0 &&
      stats!.paths.every((p) => (p.split(" ")[0] ?? "").split("/").includes("relay"))
    const events = timelineFault && answeredWindows.length > 0
    // The CPU throttle is judged on its own axis, and mostly NEGATIVELY: the export
    // carries no slow-frame share and no long-task distribution for the game span
    // (ui.frame_ms / ui.slow_frame_pct / ui.long_task_ms are Sentry metrics; the
    // long-task snapshot keeps only >=1000 ms tasks), and the device probe samples
    // for ~2 s on the countdown, before the game. So a CPU-only profile can be
    // "cannot tell" and must say so; a CPU profile that ALSO shapes the network is
    // judged on that shaping, with the CPU axis reported as unjudged.
    const cpuOnlyShaping =
      cpuThrottle > 1 && !timelineFault && profile.network.profile === "wifi" && !profile.network.relayOnly && (profile.network.timeline?.length ?? 0) === 0
    if (cpuThrottle > 1) {
      const probeMoved = probeOutsideControls
      flags.push(
        `CPU ×${cpuThrottle} cannot be judged on the game span: the export carries no slow-frame share or long-task distribution (Sentry metrics), and the device probe is one ${cpu.probeP95Ms === null ? "missing" : `${round(cpu.probeP95Ms)}ms p95`} sample taken on the countdown${
          probeMoved ? ", above every unthrottled control — the throttle did reach the page's frame clock" : ", inside the unthrottled controls' range"
        }`,
      )
    }
    if (moved || lagged || lossy || relayed || events) verdict = "impact seen"
    else if (cpuOnlyShaping) verdict = "cannot tell"
    else if (timelineFault && answeredWindows.length === 0) {
      // The fault was in force and the app answered NOTHING in its window. That
      // is either the app ignoring it (a real finding) or the app never
      // exporting inside the window (no evidence). The two must not collapse:
      // a silent window means we cannot tell, and no silent window means the
      // app was running and simply did not react.
      verdict = silentWindows.length > 0 ? "cannot tell" : "no impact"
      if (verdict === "no impact")
        flags.push(`${faultCalls(a.netem.calls).length} fault call(s) in force but no app-side reaction in any window: the app ran and did not move`)
    }
    else if (page || rttP50 !== null) {
      verdict = "no impact"
      if ((netem?.rateMbit ?? 0) > 0 && (netem?.rateMbit ?? 0) <= 2 && page && (page.rung ?? 0) === 0)
        flags.push(`${netem!.rateMbit} Mbit cap but the app stayed on rung full: the cap did not reach the sender`)
    } else verdict = "cannot tell"
    if (signals.length) evidence.push(`predicted by this shaping: ${signals.join("; ")}`)
  }
  return { artifact: a, profile, intended, verdict, evidence, flags, reference, cpu }
}

/** The run's own control reference: the median rtt p50 and loss of the personas with no
 *  stress shaping, plus the frame-probe range those same unthrottled controls produced
 *  (the only honest yardstick for a CPU persona — the app never sees the throttle). */
let baseline: {
  rttP50: number | null
  lossPct: number | null
  rung: number | null
  /** median of the controls' own frame-probe p95 */
  cpuProbeP95: number | null
  /** the controls' own min–max frame-probe p95, so one slow control cannot set the bar */
  cpuProbeRange: { min: number; max: number } | null
} = { rttP50: null, lossPct: null, rung: null, cpuProbeP95: null, cpuProbeRange: null }

// ── the table ───────────────────────────────────────────────────────────────

/** What one invocation reads: the run's id and every persona's assessed row, plus the
 *  controls that set its reference. ONE builder, so the terminal report and a page cannot
 *  drift apart — the whole point of exposing rows at all. */
interface BuiltRows {
  runId: string
  rows: Row[]
  controls: Row[]
}

/** Read a run directory into assessed rows, or an error message the caller prints.
 *  Shared by `main` (the markdown table) and `shapingRows` (the page). */
export function buildRows(argv: readonly string[]): BuiltRows | { error: string } {
  const root = argv[0]
  if (!root) return { error: "usage: npx tsx scripts/e2e-live/shaping-impact.mts <dir of downloaded artifacts> [--run <id>]" }
  const runFlag = argv.indexOf("--run")
  const netemProfiles = loadNetemProfiles()
  const profiles = loadProfiles()
  const artifacts = readArtifacts(root).filter((a) => (runFlag >= 0 ? a.runId === argv[runFlag + 1] : true))
  if (artifacts.length === 0) return { error: `no e2e-live artifacts under ${root}` }
  const runIds = [...new Set(artifacts.map((a) => a.runId))]
  if (runIds.length > 1) return { error: `more than one run under ${root}: ${runIds.join(", ")}; pass --run <id>` }

  // The run-wide peer index: every bot's receiver-quality records, keyed by the peer they
  // describe. Built once, before any persona is judged, because a persona's peer evidence
  // lives in the OTHER artifacts.
  const peers: PeerContext = { index: buildPeerIndex(artifacts), accountKnown: artifacts.some((a) => a.result?.account !== undefined) }

  // The control personas come first: they set the run's own reference before any shaped persona is judged.
  const controls = artifacts.filter((a) => {
    const p = a.definition ?? profiles.find((x) => x.name === a.profile)
    return p !== null && p !== undefined && !isStress(p) && !roleStressed(p) && (a.log?.lines.length ?? 0) > 0
  })
  const controlRows = controls.map((a) => assess(a, netemProfiles, profiles, peers))
  const controlProbe = controlRows.map((r) => r.cpu?.probeP95Ms).filter((n): n is number => typeof n === "number")
  baseline = {
    rttP50: pct(controlRows.map((r) => r.reference?.rttP50).filter((n): n is number => typeof n === "number"), 0.5),
    lossPct: pct(controlRows.map((r) => r.reference?.lossPct).filter((n): n is number => typeof n === "number"), 0.5),
    rung: 0,
    cpuProbeP95: pct(controlProbe, 0.5),
    cpuProbeRange: controlProbe.length ? { min: Math.min(...controlProbe), max: Math.max(...controlProbe) } : null,
  }
  return { runId: runIds[0]!, rows: artifacts.map((a) => assess(a, netemProfiles, profiles, peers)), controls: controlRows }
}

/** The rows as data, for a page: the SAME objects the terminal report renders, built by
 *  the same `buildRows`, so a summary view cannot disagree with the terminal. */
export function shapingRows(argv: readonly string[]): { runId: string; rows: ShapingSourceRow[] } {
  const built = buildRows(argv)
  if ("error" in built) throw new Error(built.error)
  return {
    runId: built.runId,
    rows: built.rows.map((r) => ({
      persona: r.profile?.name ?? r.artifact.profile,
      bot: r.artifact.slot,
      attempt: r.artifact.attempt,
      phase: r.artifact.phase,
      intended: r.intended,
      evidence: r.evidence,
      flags: r.flags,
      verdict: r.verdict,
    })),
  }
}

function render(runId: string, rows: Row[], controls: Row[]): string {
  const out: string[] = []
  out.push(`# Shaping impact — run ${runId}`)
  out.push("")
  out.push("Times are Berlin local, each stamped with its own abbreviation (CEST in summer, CET in winter). Built from the saved artifacts only; the app's own numbers are the evidence.")
  out.push("")
  out.push(
    "CPU columns read the app's own frame record: the device probe's `device check` samples (p50/p95 frame time) and the harness's long-task snapshot (only tasks ≥1000 ms are kept, so 0 means no second-long stall was seen, not that the field was missing). `ui.frame_ms`, `ui.slow_frame_pct` and `ui.long_task_ms` are Sentry metrics and are absent from a devLog export, so no slow-frame share is reported here.",
  )
  out.push("")
  const ctrl = controls.filter((r) => r.reference?.rttP50 !== null)
  if (ctrl.length) {
    out.push(`Run reference (${ctrl.length} control persona${ctrl.length === 1 ? "" : "s"} with no stress shaping): rtt p50 ${round(baseline.rttP50 ?? 0)}ms, loss ${round(baseline.lossPct ?? 0, 2)}%.`)
    if (baseline.cpuProbeP95 !== null) {
      out.push(
        `Their own frame probe: p95 ${round(baseline.cpuProbeP95)}ms${baseline.cpuProbeRange ? ` (${round(baseline.cpuProbeRange.min)}–${round(baseline.cpuProbeRange.max)}ms)` : ""} — the yardstick a CPU persona's frame record is read against.`,
      )
    }
    out.push("")
  }
  out.push("| persona | bot | intended shaping | CPU (asked / measured) | what the app measured | verdict |")
  out.push("|---|---|---|---|---|---|")
  for (const row of rows) {
    const name = row.profile?.name ?? row.artifact.profile
    const measured = row.evidence.join("; ").replace(/\|/g, "\\|")
    const flag = row.flags.length ? ` **flag:** ${row.flags.join("; ").replace(/\|/g, "\\|")}` : ""
    const slot = row.artifact.attempt > 1 ? `${row.artifact.slot} (attempt ${row.artifact.attempt})` : String(row.artifact.slot)
    const cpu = row.cpu
    const cpuCell = !cpu
      ? "not assessed"
      : cpu.throttle <= 1
        ? `×1 (control), probe p95 ${cpu.probeP95Ms === null ? "unmeasured" : `${round(cpu.probeP95Ms)}ms`}, ${cpu.longTasks} long task(s)`
        : `**×${cpu.throttle}**, probe p50 ${cpu.probeMedianMs === null ? "unmeasured" : `${round(cpu.probeMedianMs)}ms`} / p95 ${cpu.probeP95Ms === null ? "unmeasured" : `${round(cpu.probeP95Ms)}ms`}, ${cpu.longTasks} long task(s) ≥1000ms`
    out.push(`| ${name} | ${slot} | ${row.intended.replace(/\|/g, "\\|")} | ${cpuCell} | ${measured}${flag} | **${row.verdict}** |`)
  }
  out.push("")
  const tally = new Map<Verdict, number>()
  for (const r of rows) tally.set(r.verdict, (tally.get(r.verdict) ?? 0) + 1)
  out.push(`Verdicts: ${[...tally].map(([v, n]) => `${n} ${v}`).join(", ")}.`)
  const flagged = rows.filter((r) => r.flags.length > 0)
  if (flagged.length) {
    out.push("")
    out.push("## Flags")
    out.push("")
    for (const r of flagged) out.push(`- ${r.profile?.name ?? r.artifact.profile} (bot ${r.artifact.slot}): ${r.flags.join("; ")}`)
  }
  return out.join("\n")
}

export function main(argv: readonly string[], out: (text: string) => void = (t) => void process.stdout.write(t)): number {
  const built = buildRows(argv)
  if ("error" in built) {
    console.error(built.error)
    return 2
  }
  out(`${render(built.runId, built.rows, built.controls)}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = main(process.argv.slice(2))
  process.stdout.write("", () => process.exit(code))
}
