// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Bot profiles: THE extension point for "guard against a known failure".
//
// MODEL. A profile = device + network + role + expect. One profile per runner:
// the workflow matrix runs bot N with profileFor(N), the two one-bot checks
// (bot: null) run on their own. profiles.json is data; nothing here or in the
// journey knows a profile by name.
//
//   device   a Playwright `devices` key (viewport, DPR, UA, touch), plus CPU
//            throttle, camera delay/resolution and a wall-clock offset
//   network  a netem profile (netem-profiles.json, shared with netem.sh),
//            relay-only, and an optional mid-game switch / blackout
//   role     what the bot DOES in the game (baseline, late-join, background,
//            kill-relaunch, seat-preparing, tap-storm, host-crash,
//            reload, hidden-step, freeze); params are the
//            role's knobs and are read by the journey
//   env      bounded NEXT_PUBLIC_ build values; `{{fixture.url}}` is the only
//            runtime token
//   fixture  one profile-defined JSON response served by boot for local apps
//   expect   GUARDS: named assertions over what the bot's own telemetry
//            recorded. The vocabulary is closed and small, so a new failure
//            pattern is a new profile entry, not new code:
//              metric      { name, min?, max? }        a recorded metric point; EVERY point
//                                                      must sit in the bound, and at least one
//                                                      must exist (no bound = "was recorded")
//              event       { name, attrs?, min?, max? } a journey or step span seen min..max times
//                                                      (default min 1; max 0 = never seen)
//              text        { text, never? }            visible on the page at the end, or
//                                                      (never) at no point during the run
//              chain-report { matchesVoteTrail }       chain report == the votes the bot cast
//              store-rejection { reason, min?, max? }  the statement store refused a submit with this
//                                                      node reason (alreadyExpired, channelPriorityTooLow ...)
//                                                      min..max times, read off the host's own replies on
//                                                      the page's websocket (store-wire.ts); default min 1,
//                                                      max 0 = never
//              devlog      { match, matchAny?, tag?, min?, max? } lines of the app's own devLog (the page's export,
//                                                      snapshots before a kill or reload included) whose
//                                                      message contains `match` (and whose tag is `tag`),
//                                                      min..max times; default min 1, max 0 = never. Needs
//                                                      no Sentry: the mesh's [jollity-rtc] lines say what
//                                                      the self-heal did
//            Every guard may carry "note" (why it exists) and "pending": true.
//
// NAMES ARE THE APP'S OWN. `metric` names are the tracemetrics the app emits
// (lib/telemetry, lib/journeys);
// `event` names are a journey (app-open, join, game ...) or one of its step
// names (rtc.heal, camera.acquire ...). Span attributes are STRINGS in Sentry,
// so event attrs are strings too: { "rtc.healed": "true" }, never true.
//
// PENDING. A guard whose signal the app does not emit yet is written down with
// "pending": true and a note naming the nearest real signal. It is validated
// but NEVER evaluated, never counted as a pass: the evaluator must report it as
// skipped (pendingGuards() lists them), so a guard can not pass vacuously. When
// the app emits the signal, rename it and drop the flag.
//
// ADD A PROFILE: append an object to profiles.json (copy the closest one),
// give it a unique name and, for a game bot, an unused `bot` number 1-6 (null
// for a one-bot check). `npm run test:e2e-live` validates it: unknown network
// profile, role or guard kind fails with the profile and field named (and the
// test also checks the device is a real Playwright one: this module reads names
// and shape WITHOUT importing @playwright/test, so a plain JSON consumer can
// share it). A new guard KIND is the only thing that needs code (here and in
// the evaluator); a new network preset is data (netem-profiles.json).

// The two JSON files are imported statically (no import.meta, no fs): this
// module also runs inside Playwright's CommonJS loader (playwright.config.ts
// and the journey import it), where import.meta is a SyntaxError.
import netemJson from "./netem-profiles.json"
import profilesJson from "./profiles.json"
import { USERNAME_RE } from "./players"

export const UPLINK_LIFT_PROFILE = "uplink-lift-pixel6a"

export const ROLE_KINDS = ["baseline", "late-join", "video-return", "background", "kill-relaunch", "seat-preparing", "tap-storm", "host-crash", "reload", "hidden-step", "freeze"] as const
export type RoleKind = (typeof ROLE_KINDS)[number]
export const GUARD_KINDS = ["metric", "event", "text", "text-cleared-any", "chain-report", "store-rejection", "devlog", "late-join-proof", "synchronized-pc-failure", "reload-video-back"] as const
export type GuardKind = (typeof GUARD_KINDS)[number]

/** Guards every profile carries unless it lists the same guard itself. */
export const DEFAULT_GUARDS: Guard[] = [
  { kind: "text", text: "Voting has closed", never: true, note: "no bot may default its votes by missing the report window" },
]
const HOST_HEALTH_NEGATIVE_GUARDS: Guard[] = [
  { kind: "text", text: "Restart the Polkadot app", never: true, note: "negative control: this persona must not show restart advice" },
  { kind: "text", text: "Your Polkadot app is stuck, restart it", never: true, note: "negative control: this persona must not show the stuck-host bar" },
]
/** The blocked-player-network copy. NOT applied to a persona whose own timeline takes the
 *  RELAY down: for a player whose only path is the relay, that screen is the correct thing
 *  to show when the relay is down, so treating it as a mislabel fails the persona for
 *  being right. It was failing `relay-outage` on a live run for exactly that.
 *
 *  The test is `outage: "turn-relay"`, not `relayOnly`. Being relay-only is not enough:
 *  `relay-iphonese-fastclock` is relay-only and TURN works fine there (that is the guard
 *  that exposed the #1397 clock bug), and the TURN-cache personas' outages are on the
 *  credential ISSUER, after which the relay still works. Only a relay outage makes this
 *  screen correct, so only a relay outage excuses it. */
const BLOCKED_NETWORK_NEGATIVE_GUARD: Guard = {
  kind: "text",
  text: "We couldn't connect you to anyone.",
  never: true,
  note: "negative control: a host fault must not be mislabeled as a blocked player network",
}

interface GuardBase {
  /** only meaningful when the profile's ROLE is played (E2E_ROLES=1): with roles off it is "not evaluated: roles off", never a pass or a fail */
  rolesOnly?: true
  /** why the guard exists; shown with the failure */
  note?: string
  /** the app does not emit this signal yet: validated, never evaluated, reported as skipped */
  pending?: true
}
export type Guard = GuardBase &
  (
    | { kind: "metric"; name: string; attrs?: Record<string, string>; min?: number; max?: number; minBlocks?: number; maxBlocks?: number; minPoints?: number }
    | { kind: "event"; name: string; attrs?: Record<string, string>; min?: number; max?: number }
    | { kind: "text"; text: string; never?: true }
    | { kind: "text-cleared-any"; texts: string[] }
    | { kind: "chain-report"; matchesVoteTrail: true }
    | { kind: "store-rejection"; reason: string; min?: number; max?: number }
    | { kind: "devlog"; match: string; matchAny?: string[]; tag?: string; fields?: Record<string, string>; has?: string[]; min?: number; max?: number }
    | { kind: "late-join-proof"; round: number; maxFirstVideoMs: number }
    | { kind: "synchronized-pc-failure"; withinMs: number; minPeers?: number }
    | { kind: "reload-video-back"; maxVideoBackMs: number }
  )

export interface NetemProfile {
  delayMs: number
  jitterMs: number
  lossPct: number
  /** 0 = unlimited. */
  rateMbit: number
}

/** A role's knobs: key -> type, `?` = optional. A stray key fails validation, so a typo in a param can not silently do nothing. */
export const ROLE_PARAMS: Record<RoleKind, Record<string, "number" | "boolean" | "string" | "number?" | "boolean?" | "string?">> = {
  baseline: { changeVerdictThenConfirm: "boolean?", note: "string?" },
  "late-join": { joinAfterTurn: "number", note: "string?" },
  "video-return": { joinAfterTurn: "number", enableAtTurn: "number?", disableAtTurn: "number?", note: "string?" },
  background: { backgroundFromGameEndS: "number", backgroundUntilGameEndS: "number", note: "string?" },
  "kill-relaunch": { killInRound: "number", backgroundFromGameEndS: "number?", backgroundUntilGameEndS: "number?", note: "string?" },
  "seat-preparing": { freshLitePerson: "boolean?", note: "string?" },
  "tap-storm": { flips: "number", note: "string?" },
  "host-crash": { crashInRound: "number", downS: "number?", note: "string?" },
  reload: { reloadAtTurn: "number", note: "string?" },
  "hidden-step": { hideAtTurn: "number", showAtTurn: "number", stepS: "number", note: "string?" },
  freeze: { freezeAtTurn: "number", freezeS: "number", monotonicStops: "boolean?", note: "string?" },
}
/** Params that are a signed clock step in seconds, not a count: any whole non-zero number. */
const SIGNED_PARAMS = new Set(["stepS"])
export interface RoundChannelGate {
  round: number
  count: number
  /** fail closed when the distinct channel count is still short this many seconds after game start */
  byGameS: number
}
/** One change to the link during the game. WHEN: `atTurn` (the game's turn count, 1-based), `atS`
 *  (seconds after the game starts), `atRoundChannelsOpen` (a bounded distinct-peer devLog gate), or `atOpen`
 *  (the moment the journey opens the app, off the play loop), exactly one. WHAT: a named `profile`, and/or ad-hoc `delayMs` / `jitterMs` /
 *  `lossPct` / `rateMbit` (a loss spike is `{ atTurn: 4, lossPct: 30, forS: 10 }` then `{ atTurn: 5, profile: "wifi" }`),
 *  and/or a `blackoutS` (everything dropped, then the step's link is back). `forS` restores the previous link after that long. */
export interface TimelineStep {
  atTurn?: number
  atS?: number
  /** seconds before game_date, after registration has landed (waiting-room faults such as #726) */
  atBeforeGameS?: number
  atRoundChannelsOpen?: RoundChannelGate
  atOpen?: true
  /** just before the journey taps Register (stage (b)); the tap waits until the step is in force */
  atSignUp?: true
  /** when the confirm stage opens: the last turn's end on the chain clock (roles.ts gameEndAt) */
  atConfirm?: true
  profile?: string
  /** named base restored after a bounded named `profile` burst (`forS` is required) */
  restoreProfile?: string
  delayMs?: number
  jitterMs?: number
  lossPct?: number
  rateMbit?: number
  blackoutS?: number
  forS?: number
  /** a TARGETED outage: all traffic to and from one endpoint drops for `forS` (needs forS). A name from OUTAGE_TARGETS
   *  (people-rpc, statement-store, turn-issuer, turn-relay) or a hostname. Separates signalling, media and credential failures. */
  outage?: string
  /** the WebRTC path cut for this many seconds while signalling stays up: UDP (DNS aside) and the TURN relay drop, both
   *  directions, and the People RPC must stay reachable throughout, so presence (hellos) keeps flowing. A link that drops
   *  while its player is still heard (#245's deadlock) */
  udpCutS?: number
  /** video blackholed on a link that stays connected, for this many seconds: UDP packets of 300 bytes or more drop, both
   *  directions, while the small ICE consent checks pass (rank 9 of the game logs: the media-stall heal) */
  videoStallS?: number
  /** the SIGNING HOST's chain connection alone is cut (platform-bugs #76, host-chain-cut.ts): its established sockets to the
   *  People RPC are killed and its new connects refused for `hostChainHoldS` (default: the whole window), then the probes watch
   *  this many seconds in all for its reconnect. The rest of the runner, the browser included, is never cut */
  hostChainCutS?: number
  /** how long, within hostChainCutS, the host's new connects are refused (at least 3) */
  hostChainHoldS?: number
  /** the SIGNING HOST's traffic to the People RPC is silently dropped for this many seconds, including packets on already
   *  established sockets. Unlike hostChainCutS, this deliberately leaves those sockets open to reproduce a wedged host. */
  hostChainHangS?: number
  /** remove the relay-only UDP block at a real Wi-Fi/mobile-data switch */
  allowUdp?: true
  /** run this long blocking call beside later timed steps instead of serializing them behind it */
  concurrent?: true
}
export const CAMERA_MODES = ["ok", "denied", "missing"] as const
export type CameraUnavailableReason = "denied" | "no-camera"
export interface CameraUnavailableExpectation { kind: "camera-unavailable"; reason: CameraUnavailableReason }
export type ExpectedOutcome = CameraUnavailableExpectation

export const TELEMETRY_TORTURE_IDS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12"] as const
export type TelemetryTortureId = (typeof TELEMETRY_TORTURE_IDS)[number]
export const TELEMETRY_FAULTS = ["none", "host-storage-hang", "ios-fetch-gate", "sentry-block", "sentry-429", "no-localstorage"] as const
export type TelemetryFault = (typeof TELEMETRY_FAULTS)[number]
export const PEER_FAULT_KINDS = ["glare-forcer", "late-signal", "one-way-video", "dropped-answer"] as const
export type PeerFaultKind = (typeof PEER_FAULT_KINDS)[number]
export const PEER_FAULT_DESCRIPTIONS: Record<PeerFaultKind, string> = {
  "glare-forcer": "force simultaneous local and remote offers on the polite side after sendrecv video is negotiated",
  "late-signal": "deliver an older inbound statement-store page after its newer replacement",
  "one-way-video": "suppress only this bot's outbound video",
  "dropped-answer": "drop one lane answer after the same peer link is rebuilt",
}
export interface TelemetryTorture {
  id: TelemetryTortureId
  fault: TelemetryFault
  /** Zero-based document generations which receive the fault. */
  pageLoads?: number[]
  /** T4/T5 combine a document-scoped host-storage hang with a fetch gate on
   * these document generations. */
  fetchGatePageLoads?: number[]
  fetchGateS?: number
  /** Activate transport faults when the page first shows this game turn. */
  activateAtTurn?: number
  durationS?: number
  retryAfterS?: number
  /** T6: after the report UI completes, freeze, kill, and reopen. */
  freezeAfterReportS?: number
}

/** The networks an identity can be pinned to (host-slot.mjs NETWORKS keys; this module must stay free of that ES import). */
const IDENTITY_NETWORKS: readonly string[] = ["previewnet", "paseo-next-v2"]

/** The lite username `profile` plays as on `network`, or undefined when it has none there (a plain string is paseo-next-v2's). */
export function identityFor(profile: Pick<Profile, "identity">, network: string): string | undefined {
  const id = profile.identity
  if (id === undefined) return undefined
  return typeof id === "string" ? (network === "paseo-next-v2" ? id : undefined) : id[network]
}

export interface Profile {
  name: string
  bot: number | null
  /** the lite username this profile plays as (the identity pool, players.ts); botMatrix needs it in the network's pool.
   *  Identities are PER CHAIN: a string means paseo-next-v2 (the old shape), an object maps network -> username. */
  identity?: string | Record<string, string>
  /** the profile plays as a FRESH, still-unbound lite person drawn from the fresh pool (fresh-pool.ts) instead of a fixed identity */
  freshIdentity?: true
  /** the profile can not run yet; the reason. botMatrix refuses to schedule it and says why. */
  pending?: string
  /** Explicit-dispatch acceptance persona. It is known and runnable, but is
   * excluded from broad all/rotate schedules so its reused identity never
   * overlaps an ordinary game run. */
  acceptanceOnly?: true
  /** Explicit-dispatch proof that is also excluded from the complete-suite
   * planner because its topology must be assembled deliberately. */
  manualOnly?: true
  /** Minimum number of participants needed for this scenario's topology.
   * The complete-suite planner supplies benign companions when a serial
   * identity split would otherwise make the evidence impossible. */
  minPlayers?: number
  /** a Playwright `devices` key; the test checks it, this module does not import Playwright */
  device: string
  cpuThrottle: number
  /** `mode`: ok (default), denied (no camera permission; getUserMedia rejects NotAllowedError) or missing (NotFoundError) */
  camera: { delayMs: number; resolution: "360p" | "720p"; mode?: (typeof CAMERA_MODES)[number]; muteLoop?: true }
  /** A deliberately terminal pre-game state. It is data, rather than inferred
   *  from camera.mode, so an ordinary permission profile must still leave the gate. */
  expectedOutcome?: ExpectedOutcome
  clockOffsetS: number
  /** the device's clock jumps during the game: at game turn `atTurn` the page clock offset becomes `offsetS` */
  clockJumps?: { atTurn: number; offsetS: number }[]
  /** the device's locale and IANA time zone (Playwright context options) */
  locale?: string
  timezoneId?: string
  network: { profile: string; relayOnly: boolean; switchAtTurn?: number; switchTo?: string; blackoutS?: number; timeline?: TimelineStep[] }
  /** Public build-time values for this profile's app process. Secret/process-control variables are deliberately forbidden. */
  env?: Record<string, string>
  /** One JSON response served by boot for profiles that need a local fixture. `{{fixture.url}}` in env resolves to it. */
  fixture?: { path: string; body: unknown }
  /** Previewnet-only #723 fault choreography. Explicit-dispatch profiles only. */
  telemetryTorture?: TelemetryTorture
  /** Previewnet-only WebRTC fault injection. The page init script drops this
   * many outbound renegotiation offers, then becomes transparent. */
  dataChannelFault?: { dropRenegotiationOffers: number }
  /** Previewnet-only peer recovery fault. Each kind is document-local and
   * emits its own page-owned proof only after the fault actually fires. */
  peerFault?: { kind: PeerFaultKind }
  role: { kind: RoleKind; params: Record<string, unknown>; label?: string }
  expect: Guard[]
}

/** Only the explicit #723 matrix promises the fleet-wide harness hook and
 * page-owned truth needed by the completeness oracle. */
export const needsTelemetryOracle = (profile: Profile | null): boolean => profile?.name.startsWith("telemetry-t") ?? false

const DIRECT_PAGE_EVIDENCE_PROFILES = new Set([
  "uplink-lift-pixel6a",
  "turn-warm-returning",
  "network-blocked",
])

/** A production bundle exposes its in-page evidence bridge only when its
 * patchable test tag is set. Devlog and late-join proof guards, and explicit
 * profiles that inspect page-owned evidence use that bridge; metric/event
 * guards otherwise remain Sentry opt-in. */
export const needsDevlogHarness = (profile: Profile | null): boolean => {
  if (!profile) return false
  return profile.expect.some((guard) => guard.kind === "devlog" || guard.kind === "late-join-proof" || guard.kind === "reload-video-back")
    || DIRECT_PAGE_EVIDENCE_PROFILES.has(profile.name)
}

/** Every game run needs the page harness: sign-up schedules on the app's
 * GameSource clock (window.__jollityHarness.gameClock, journey (b)). A matrix
 * with no devlog-guard profile used to boot without it and failed every
 * sign-up ("sign-up scheduling needs the app's GameSource clock"). */
export const matrixNeedsDevlogHarness = (profiles: readonly (Profile | null)[]): boolean => profiles.length > 0

export const shouldEnforceDevlogHarness = (eventName: string | undefined, stage: string): boolean => eventName === "workflow_dispatch" && stage !== "boot"

/** Fail only at the dispatched play boundary. Pull-request/schedule runs and
 * boot-only dispatches do not execute the guarded journey. */
export function assertDevlogHarness(profile: Profile | null, enabled: boolean, enforce: boolean): void {
  if (!enforce || !profile || !needsDevlogHarness(profile) || enabled) return
  throw new Error(`profile ${profile.name} requires the page harness (E2E_DEVLOG_HARNESS=1)`)
}

/** Local bots normally bypass the one-time gate. A profile whose expected
 * outcome is the gate itself must exercise it, or its proof is impossible. */
export const localPermissionGateEnv = (profile: Pick<Profile, "expectedOutcome"> | null): Record<string, string> =>
  profile?.expectedOutcome?.kind === "camera-unavailable" ? {} : { SKIP_PERMISSION_GATE: "1" }

/** One-bot checks are data profiles with no numbered bot and the established check-* name. Other bot-null profiles are optional game personas. */
export const isCheckProfile = (profile: Pick<Profile, "bot" | "name"> | null): boolean => profile?.bot === null && profile.name.startsWith("check-")

const FIXTURE_URL_TOKEN = "{{fixture.url}}"

/** Match fixture requests on the URL path; the app appends a minute-bucket cache buster. */
export const fixtureRequestPath = (requestUrl: string | undefined): string => new URL(requestUrl ?? "/", "http://127.0.0.1").pathname

/** Resolve the one bounded runtime value profile JSON may refer to, without exposing the runner's process environment. */
export function materializeProfileEnv(profile: Pick<Profile, "env" | "fixture">, fixtureUrl?: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(profile.env ?? {}).map(([key, value]) => {
      if (!value.includes(FIXTURE_URL_TOKEN)) return [key, value]
      if (!profile.fixture || !fixtureUrl) throw new Error(`profile env ${key} uses ${FIXTURE_URL_TOKEN}, but no fixture URL was provided`)
      return [key, value.replaceAll(FIXTURE_URL_TOKEN, fixtureUrl)]
    }),
  )
}

const fail = (where: string, msg: string): never => {
  throw new Error(`${where}: ${msg}`)
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const num = (where: string, v: unknown, min = -Infinity): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) fail(where, `expected a number >= ${min}, got ${JSON.stringify(v)}`)
  return v as number
}
const str = (where: string, v: unknown): string => {
  if (typeof v !== "string" || v === "") fail(where, `expected a non-empty string, got ${JSON.stringify(v)}`)
  return v as string
}
const oneOf = <T extends string>(where: string, v: unknown, allowed: readonly T[]): T => {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) fail(where, `unknown value ${JSON.stringify(v)}; allowed: ${allowed.join(", ")}`)
  return v as T
}

export function validateNetemProfiles(raw: unknown): Record<string, NetemProfile> {
  if (!isObj(raw)) return fail("netem-profiles.json", "expected an object of profiles")
  return Object.fromEntries(
    Object.entries(raw).map(([name, v]) => {
      const w = `netem-profiles.json[${name}]`
      if (!isObj(v)) return fail(w, "expected an object")
      return [name, { delayMs: num(`${w}.delayMs`, v.delayMs, 0), jitterMs: num(`${w}.jitterMs`, v.jitterMs, 0), lossPct: num(`${w}.lossPct`, v.lossPct, 0), rateMbit: num(`${w}.rateMbit`, v.rateMbit, 0) }]
    }),
  )
}

const GUARD_KEYS: Record<GuardKind, string[]> = {
  metric: ["name", "attrs", "min", "max", "minBlocks", "maxBlocks", "minPoints"],
  event: ["name", "attrs", "min", "max"],
  text: ["text", "never"],
  "text-cleared-any": ["texts"],
  "chain-report": ["matchesVoteTrail"],
  "store-rejection": ["reason", "min", "max"],
  devlog: ["match", "matchAny", "tag", "fields", "has", "min", "max"],
  "late-join-proof": ["round", "maxFirstVideoMs"],
  "synchronized-pc-failure": ["withinMs", "minPeers"],
  "reload-video-back": ["maxVideoBackMs"],
}

export function validateGuard(where: string, raw: unknown): Guard {
  if (!isObj(raw)) return fail(where, "a guard must be an object")
  const kind = oneOf(`${where}.kind`, raw.kind, GUARD_KINDS)
  for (const k of Object.keys(raw)) if (!["kind", "note", "pending", "rolesOnly", ...GUARD_KEYS[kind]].includes(k)) fail(where, `guard ${kind} has no field ${k}`)
  const base: GuardBase = {}
  if (raw.rolesOnly !== undefined) {
    if (raw.rolesOnly !== true) fail(`${where}.rolesOnly`, "must be true (or leave it out)")
    base.rolesOnly = true
  }
  if (raw.note !== undefined) base.note = str(`${where}.note`, raw.note)
  if (raw.pending !== undefined) {
    if (raw.pending !== true) fail(`${where}.pending`, "must be true (or leave it out)")
    if (base.note === undefined) fail(where, "a pending guard needs a note naming the nearest real signal")
    base.pending = true
  }
  // `counts`: the bounds are occurrence counts (event), not metric values
  const bounds = (counts = false): { min?: number; max?: number } => {
    const min = raw.min === undefined ? undefined : num(`${where}.min`, raw.min, counts ? 1 : -Infinity)
    const max = raw.max === undefined ? undefined : num(`${where}.max`, raw.max, counts ? 0 : -Infinity)
    if (min !== undefined && max !== undefined && min > max) fail(where, "min is above max")
    return { ...(min !== undefined && { min }), ...(max !== undefined && { max }) }
  }
  switch (kind) {
    case "metric": {
      const g: Guard = { ...base, kind, name: str(`${where}.name`, raw.name), ...bounds() }
      if (raw.attrs !== undefined) {
        if (!isObj(raw.attrs)) fail(`${where}.attrs`, "expected an object")
        for (const [k, v] of Object.entries(raw.attrs as Record<string, unknown>)) if (typeof v !== "string") fail(`${where}.attrs.${k}`, `metric attributes are strings: write ${JSON.stringify(String(v))}`)
        g.attrs = raw.attrs as Record<string, string>
      }
      if (raw.minBlocks !== undefined) g.minBlocks = num(`${where}.minBlocks`, raw.minBlocks, Number.EPSILON)
      if (raw.maxBlocks !== undefined) g.maxBlocks = num(`${where}.maxBlocks`, raw.maxBlocks, Number.EPSILON)
      if (raw.minPoints !== undefined) g.minPoints = num(`${where}.minPoints`, raw.minPoints, 1)
      if (g.minBlocks !== undefined && g.maxBlocks !== undefined && g.minBlocks > g.maxBlocks) fail(where, "minBlocks is above maxBlocks")
      if ((g.min !== undefined || g.max !== undefined) && (g.minBlocks !== undefined || g.maxBlocks !== undefined)) fail(where, "metric bounds must use values or observed chain blocks, not both")
      return g
    }
    case "event": {
      const g: Guard = { ...base, kind, name: str(`${where}.name`, raw.name), ...bounds(true) }
      if (raw.attrs !== undefined) {
        if (!isObj(raw.attrs)) fail(`${where}.attrs`, "expected an object")
        for (const [k, v] of Object.entries(raw.attrs as Record<string, unknown>)) if (typeof v !== "string") fail(`${where}.attrs.${k}`, `span attributes are strings: write ${JSON.stringify(String(v))}`)
        g.attrs = raw.attrs as Record<string, string>
      }
      return g
    }
    case "text":
      if (raw.never !== undefined && raw.never !== true) fail(`${where}.never`, "must be true (or leave it out)")
      return { ...base, kind, text: str(`${where}.text`, raw.text), ...(raw.never === true ? { never: true as const } : {}) }
    case "text-cleared-any": {
      if (!Array.isArray(raw.texts)) fail(`${where}.texts`, "expected an array of alternative strings")
      const texts = raw.texts as unknown[]
      if (texts.length < 2) fail(`${where}.texts`, "expected at least two alternative strings")
      return { ...base, kind, texts: texts.map((text, i) => str(`${where}.texts[${i}]`, text)) }
    }
    case "chain-report":
      if (raw.matchesVoteTrail !== true) fail(`${where}.matchesVoteTrail`, "must be true (the only check chain-report knows)")
      return { ...base, kind, matchesVoteTrail: true }
    case "store-rejection": {
      const reason = str(`${where}.reason`, raw.reason)
      if (!/^[a-zA-Z]+$/.test(reason)) fail(`${where}.reason`, `a node reason is one camelCase word (alreadyExpired, channelPriorityTooLow), got ${JSON.stringify(reason)}`)
      return { ...base, kind, reason, ...bounds(true) }
    }
    case "devlog": {
      const g: Guard = { ...base, kind, match: str(`${where}.match`, raw.match), ...(raw.tag !== undefined && { tag: str(`${where}.tag`, raw.tag) }), ...bounds(true) }
      if (raw.matchAny !== undefined) {
        if (!Array.isArray(raw.matchAny) || raw.matchAny.length === 0) fail(`${where}.matchAny`, "expected a non-empty array of strings")
        g.matchAny = (raw.matchAny as unknown[]).map((m, i) => str(`${where}.matchAny[${i}]`, m))
      }
      if (raw.fields !== undefined) {
        const fields = raw.fields
        if (!isObj(fields)) fail(`${where}.fields`, "expected an object")
        g.fields = Object.fromEntries(Object.entries(fields as Record<string, unknown>).map(([key, value]) => [key, str(`${where}.fields.${key}`, value)]))
      }
      if (raw.has !== undefined) {
        const has = raw.has
        if (!Array.isArray(has)) fail(`${where}.has`, "expected an array")
        g.has = (has as unknown[]).map((key, i) => str(`${where}.has[${i}]`, key))
      }
      return g
    }
    case "late-join-proof": {
      const round = num(`${where}.round`, raw.round, 0)
      const maxFirstVideoMs = num(`${where}.maxFirstVideoMs`, raw.maxFirstVideoMs, 1)
      if (!Number.isInteger(round)) fail(`${where}.round`, "expected an integer")
      return { ...base, kind, round, maxFirstVideoMs }
    }
    case "reload-video-back":
      return { ...base, kind, maxVideoBackMs: num(`${where}.maxVideoBackMs`, raw.maxVideoBackMs, 1) }
    case "synchronized-pc-failure":
      return { ...base, kind, withinMs: num(`${where}.withinMs`, raw.withinMs, 1), ...(raw.minPeers !== undefined && { minPeers: num(`${where}.minPeers`, raw.minPeers, 2) }) }
  }
}

const sameGuard = (a: Guard, b: Guard): boolean =>
  a.kind === b.kind && (a.kind === "text" && b.kind === "text" ? a.text === b.text : JSON.stringify({ ...a, note: 0 }) === JSON.stringify({ ...b, note: 0 }))
const withDefaultGuards = (own: Guard[], hostHealthNegative: boolean, relayDown: boolean): Guard[] => {
  const hostGuards = relayDown ? HOST_HEALTH_NEGATIVE_GUARDS : [...HOST_HEALTH_NEGATIVE_GUARDS, BLOCKED_NETWORK_NEGATIVE_GUARD]
  const defaults = hostHealthNegative ? [...DEFAULT_GUARDS, ...hostGuards] : DEFAULT_GUARDS
  return [...own, ...defaults.filter((d) => !own.some((g) => sameGuard(g, d)))]
}

export function validateProfile(raw: unknown, i: number, netem: Record<string, NetemProfile>): Profile {
  if (!isObj(raw)) return fail(`profiles[${i}]`, "expected an object")
  const name = str(`profiles[${i}].name`, raw.name)
  const w = `profile ${name}`
  const bot = raw.bot
  if (bot !== null && !(typeof bot === "number" && Number.isInteger(bot) && bot >= 1 && bot <= 6)) fail(`${w}.bot`, "must be 1-6 or null")
  const device = str(`${w}.device`, raw.device)
  const cam = raw.camera
  if (!isObj(cam)) fail(`${w}.camera`, "expected { delayMs, resolution }")
  const camera = cam as Record<string, unknown>
  const netw = raw.network
  if (!isObj(netw)) fail(`${w}.network`, "expected an object")
  const n = netw as Record<string, unknown>
  const netProfile = (field: string, v: unknown): string => {
    if (typeof v !== "string" || !(v in netem)) fail(`${w}.network.${field}`, `unknown network profile ${JSON.stringify(v)}; known: ${Object.keys(netem).join(", ")}`)
    return v as string
  }
  if (typeof n.relayOnly !== "boolean") fail(`${w}.network.relayOnly`, "expected a boolean")
  const network: Profile["network"] = { profile: netProfile("profile", n.profile), relayOnly: n.relayOnly as boolean }
  if (n.switchAtTurn !== undefined) network.switchAtTurn = num(`${w}.network.switchAtTurn`, n.switchAtTurn, 1)
  if (n.switchTo !== undefined) network.switchTo = netProfile("switchTo", n.switchTo)
  if (n.blackoutS !== undefined) network.blackoutS = num(`${w}.network.blackoutS`, n.blackoutS, 0)
  if ((network.switchAtTurn === undefined) !== (network.switchTo === undefined)) fail(`${w}.network`, "switchAtTurn and switchTo go together")
  if (network.blackoutS !== undefined && network.switchAtTurn === undefined) fail(`${w}.network`, "blackoutS needs switchAtTurn")
  if (n.timeline !== undefined) {
    if (!Array.isArray(n.timeline)) fail(`${w}.network.timeline`, "expected an array of steps")
    network.timeline = (n.timeline as unknown[]).map((raw, k): TimelineStep => {
      const sw = `${w}.network.timeline[${k}]`
      if (!isObj(raw)) return fail(sw, "a step must be an object")
      for (const key of Object.keys(raw)) if (!["atTurn", "atS", "atBeforeGameS", "atRoundChannelsOpen", "atOpen", "atSignUp", "atConfirm", "profile", "restoreProfile", "delayMs", "jitterMs", "lossPct", "rateMbit", "blackoutS", "forS", "outage", "udpCutS", "videoStallS", "hostChainCutS", "hostChainHoldS", "hostChainHangS", "allowUdp", "concurrent"].includes(key)) fail(sw, `a step has no field ${key}`)
      if ([raw.atTurn, raw.atS, raw.atBeforeGameS, raw.atRoundChannelsOpen, raw.atOpen, raw.atSignUp, raw.atConfirm].filter((v) => v !== undefined).length !== 1) fail(sw, "give exactly one of atTurn, atS, atBeforeGameS, atRoundChannelsOpen, atOpen, atSignUp and atConfirm")
      const step: TimelineStep = {}
      for (const f of ["atOpen", "atSignUp", "atConfirm"] as const) {
        if (raw[f] === undefined) continue
        if (raw[f] !== true) fail(`${sw}.${f}`, "must be true (or leave it out)")
        step[f] = true
      }
      if (raw.atTurn !== undefined) step.atTurn = num(`${sw}.atTurn`, raw.atTurn, 1)
      if (raw.atS !== undefined) step.atS = num(`${sw}.atS`, raw.atS, 0)
      if (raw.atBeforeGameS !== undefined) step.atBeforeGameS = num(`${sw}.atBeforeGameS`, raw.atBeforeGameS, 1)
      if (raw.atRoundChannelsOpen !== undefined) {
        if (!isObj(raw.atRoundChannelsOpen)) fail(`${sw}.atRoundChannelsOpen`, "expected { round, count, byGameS }")
        const gate = raw.atRoundChannelsOpen as Record<string, unknown>
        for (const key of Object.keys(gate)) if (!["round", "count", "byGameS"].includes(key)) fail(`${sw}.atRoundChannelsOpen`, `has no field ${key}`)
        const round = num(`${sw}.atRoundChannelsOpen.round`, gate.round, 1)
        const count = num(`${sw}.atRoundChannelsOpen.count`, gate.count, 1)
        const byGameS = num(`${sw}.atRoundChannelsOpen.byGameS`, gate.byGameS, 0)
        if (![round, count, byGameS].every(Number.isInteger)) fail(`${sw}.atRoundChannelsOpen`, "round, count and byGameS must be whole numbers")
        step.atRoundChannelsOpen = { round, count, byGameS }
      }
      if (raw.profile !== undefined) step.profile = netProfile(`timeline[${k}].profile`, raw.profile)
      if (raw.restoreProfile !== undefined) step.restoreProfile = netProfile(`timeline[${k}].restoreProfile`, raw.restoreProfile)
      for (const f of ["delayMs", "jitterMs", "lossPct", "rateMbit", "blackoutS", "forS"] as const) if (raw[f] !== undefined) step[f] = num(`${sw}.${f}`, raw[f], 0)
      for (const f of ["udpCutS", "videoStallS"] as const) if (raw[f] !== undefined) step[f] = num(`${sw}.${f}`, raw[f], 1)
      if (raw.hostChainCutS !== undefined) step.hostChainCutS = num(`${sw}.hostChainCutS`, raw.hostChainCutS, 3)
      if (raw.hostChainHangS !== undefined) step.hostChainHangS = num(`${sw}.hostChainHangS`, raw.hostChainHangS, 10)
      if (raw.allowUdp !== undefined) {
        if (raw.allowUdp !== true) fail(`${sw}.allowUdp`, "must be true (or leave it out)")
        step.allowUdp = true
      }
      if (raw.concurrent !== undefined) {
        if (raw.concurrent !== true) fail(`${sw}.concurrent`, "must be true (or leave it out)")
        step.concurrent = true
      }
      if (step.hostChainCutS !== undefined && step.hostChainHangS !== undefined) fail(sw, "hostChainCutS and hostChainHangS are mutually exclusive")
      if (raw.hostChainHoldS !== undefined) {
        if (step.hostChainCutS === undefined) fail(sw, "hostChainHoldS needs hostChainCutS")
        step.hostChainHoldS = num(`${sw}.hostChainHoldS`, raw.hostChainHoldS, 3)
        if (step.hostChainHoldS > step.hostChainCutS!) fail(`${sw}.hostChainHoldS`, "the hold cannot outlast the window (hostChainCutS)")
      }
      // boot runs atOpen steps itself, before the page exists and without the host's pid file, log or marker
      if ((step.hostChainCutS !== undefined || step.hostChainHangS !== undefined) && step.atOpen) fail(sw, "a host-chain operation cannot be an atOpen step: give it atSignUp, atConfirm, atTurn or atS")
      if (raw.outage !== undefined) {
        step.outage = str(`${sw}.outage`, raw.outage)
        if (step.forS === undefined || step.forS <= 0) fail(sw, "an outage needs forS (how long it lasts)")
      }
      if (step.lossPct !== undefined && step.lossPct > 100) fail(`${sw}.lossPct`, "a percentage, 0-100")
      if (step.restoreProfile !== undefined && (step.profile === undefined || step.forS === undefined || step.forS <= 0)) fail(sw, "restoreProfile needs a named profile and positive forS")
      if (step.restoreProfile !== undefined && (step.delayMs !== undefined || step.jitterMs !== undefined || step.lossPct !== undefined || step.rateMbit !== undefined || step.blackoutS !== undefined || step.outage !== undefined || step.udpCutS !== undefined || step.videoStallS !== undefined || step.hostChainCutS !== undefined || step.hostChainHangS !== undefined || step.allowUdp)) fail(sw, "a named bounded burst cannot combine restoreProfile with another effect")
      if (step.profile === undefined && step.delayMs === undefined && step.jitterMs === undefined && step.lossPct === undefined && step.rateMbit === undefined && step.blackoutS === undefined && step.outage === undefined && step.udpCutS === undefined && step.videoStallS === undefined && step.hostChainCutS === undefined && step.hostChainHangS === undefined && !step.allowUdp) fail(sw, "a step must change something: profile, shaping, an outage/cut/hang, or allowUdp")
      return step
    })
  }
  if (raw.locale !== undefined) str(`${w}.locale`, raw.locale)
  if (raw.timezoneId !== undefined) {
    str(`${w}.timezoneId`, raw.timezoneId)
    try {
      new Intl.DateTimeFormat("en", { timeZone: raw.timezoneId as string })
    } catch {
      fail(`${w}.timezoneId`, `${JSON.stringify(raw.timezoneId)} is not an IANA time zone`)
    }
  }
  if (camera.mode !== undefined) oneOf(`${w}.camera.mode`, camera.mode, CAMERA_MODES)
  if (camera.muteLoop !== undefined && camera.muteLoop !== true) fail(`${w}.camera.muteLoop`, "must be true (or leave it out)")
  let expectedOutcome: ExpectedOutcome | undefined
  if (raw.expectedOutcome !== undefined) {
    const outcome = isObj(raw.expectedOutcome) ? raw.expectedOutcome : fail(`${w}.expectedOutcome`, "expected an object")
    const kind = oneOf(`${w}.expectedOutcome.kind`, outcome.kind, ["camera-unavailable"] as const)
    for (const key of Object.keys(outcome)) if (!["kind", "reason"].includes(key)) fail(`${w}.expectedOutcome`, `has no field ${key}`)
    const reason = oneOf(`${w}.expectedOutcome.reason`, outcome.reason, ["denied", "no-camera"] as const)
    const requiredMode = reason === "denied" ? "denied" : "missing"
    if (camera.mode !== requiredMode) fail(`${w}.expectedOutcome.reason`, `${reason} needs camera.mode=${requiredMode}, got ${JSON.stringify(camera.mode ?? "ok")}`)
    expectedOutcome = { kind, reason }
  }
  if (raw.clockJumps !== undefined) {
    if (!Array.isArray(raw.clockJumps)) fail(`${w}.clockJumps`, "expected an array of { atTurn, offsetS }")
    for (const [k, j] of (raw.clockJumps as unknown[]).entries()) {
      if (!isObj(j)) fail(`${w}.clockJumps[${k}]`, "expected { atTurn, offsetS }")
      num(`${w}.clockJumps[${k}].atTurn`, (j as Record<string, unknown>).atTurn, 1)
      num(`${w}.clockJumps[${k}].offsetS`, (j as Record<string, unknown>).offsetS)
    }
  }
  const role = raw.role
  if (!isObj(role)) fail(`${w}.role`, "expected { kind, params }")
  const r = role as Record<string, unknown>
  for (const key of Object.keys(r)) if (!["kind", "params", "label"].includes(key)) fail(`${w}.role`, `has no field ${key}`)
  if (!isObj(r.params)) fail(`${w}.role.params`, "expected an object")
  const roleKind = oneOf(`${w}.role.kind`, r.kind, ROLE_KINDS)
  const params = r.params as Record<string, unknown>
  const spec = ROLE_PARAMS[roleKind]
  for (const k of Object.keys(params)) if (!(k in spec)) fail(`${w}.role.params.${k}`, `the ${roleKind} role has no param ${k}; known: ${Object.keys(spec).join(", ")}`)
  for (const [k, t] of Object.entries(spec)) {
    const v = params[k]
    if (v === undefined) {
      if (!t.endsWith("?")) fail(`${w}.role.params.${k}`, `the ${roleKind} role needs ${k} (${t})`)
      continue
    }
    if (typeof v !== t.replace("?", "")) fail(`${w}.role.params.${k}`, `expected ${t.replace("?", "")}, got ${JSON.stringify(v)}`)
    if (typeof v === "number" && SIGNED_PARAMS.has(k) && (!Number.isInteger(v) || v === 0)) fail(`${w}.role.params.${k}`, "a clock step: a whole number of seconds, not 0")
    if (typeof v === "number" && !SIGNED_PARAMS.has(k) && (!Number.isFinite(v) || v < 1) && !k.startsWith("background")) fail(`${w}.role.params.${k}`, "must be a whole number from 1")
  }
  const roleLabel = r.label === undefined ? undefined : str(`${w}.role.label`, r.label)
  if (roleKind === "kill-relaunch" && (params.backgroundFromGameEndS === undefined) !== (params.backgroundUntilGameEndS === undefined)) fail(`${w}.role.params`, "backgroundFromGameEndS and backgroundUntilGameEndS go together")
  if (typeof params.backgroundFromGameEndS === "number" && typeof params.backgroundUntilGameEndS === "number" && params.backgroundFromGameEndS >= params.backgroundUntilGameEndS) fail(`${w}.role.params`, "the background window ends before it starts")
  if (roleKind === "hidden-step" && (params.showAtTurn as number) <= (params.hideAtTurn as number)) fail(`${w}.role.params`, "showAtTurn must come after hideAtTurn")
  if (raw.pending !== undefined) str(`${w}.pending`, raw.pending)
  if (raw.acceptanceOnly !== undefined && raw.acceptanceOnly !== true) fail(`${w}.acceptanceOnly`, "must be true (or leave it out)")
  if (raw.manualOnly !== undefined && raw.manualOnly !== true) fail(`${w}.manualOnly`, "must be true (or leave it out)")
  if (raw.manualOnly === true && raw.acceptanceOnly !== true) fail(`${w}.manualOnly`, "manual-only profiles must be acceptanceOnly")
  let minPlayers: number | undefined
  if (raw.minPlayers !== undefined) {
    minPlayers = num(`${w}.minPlayers`, raw.minPlayers)
    if (!Number.isInteger(minPlayers)) fail(`${w}.minPlayers`, "must be a whole number")
    if (minPlayers < 2 || minPlayers > 6) fail(`${w}.minPlayers`, "must be 2-6")
  }
  let env: Record<string, string> | undefined
  if (raw.env !== undefined) {
    const envRaw = isObj(raw.env) ? raw.env : fail(`${w}.env`, "expected an object of NEXT_PUBLIC_ strings")
    env = {}
    for (const [key, value] of Object.entries(envRaw)) {
      if (!/^NEXT_PUBLIC_[A-Z0-9_]+$/.test(key)) fail(`${w}.env.${key}`, "only NEXT_PUBLIC_ app variables are allowed")
      const stringValue = typeof value === "string" ? value : fail(`${w}.env.${key}`, `expected a string, got ${JSON.stringify(value)}`)
      const tokens = stringValue.match(/{{[^}]+}}/g) ?? []
      if (tokens.some((token) => token !== FIXTURE_URL_TOKEN)) fail(`${w}.env.${key}`, `unknown runtime token; only ${FIXTURE_URL_TOKEN} is allowed`)
      env[key] = stringValue
    }
  }
  let fixture: Profile["fixture"]
  if (raw.fixture !== undefined) {
    const fixtureRaw = isObj(raw.fixture) ? raw.fixture : fail(`${w}.fixture`, "expected { path, body }")
    for (const key of Object.keys(fixtureRaw)) if (!["path", "body"].includes(key)) fail(`${w}.fixture`, `has no field ${key}`)
    const path = str(`${w}.fixture.path`, fixtureRaw.path)
    if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) fail(`${w}.fixture.path`, "must start with / and contain no traversal")
    if (!("body" in fixtureRaw)) fail(`${w}.fixture.body`, "is required")
    try {
      if (JSON.stringify(fixtureRaw.body) === undefined) fail(`${w}.fixture.body`, "must be JSON-serializable")
    } catch {
      fail(`${w}.fixture.body`, "must be JSON-serializable")
    }
    fixture = { path, body: fixtureRaw.body }
  }
  let telemetryTorture: TelemetryTorture | undefined
  if (raw.telemetryTorture !== undefined) {
    const value = isObj(raw.telemetryTorture) ? raw.telemetryTorture : fail(`${w}.telemetryTorture`, "expected an object")
    for (const key of Object.keys(value)) if (!["id", "fault", "pageLoads", "fetchGatePageLoads", "fetchGateS", "activateAtTurn", "durationS", "retryAfterS", "freezeAfterReportS"].includes(key)) fail(`${w}.telemetryTorture`, `has no field ${key}`)
    telemetryTorture = {
      id: oneOf(`${w}.telemetryTorture.id`, value.id, TELEMETRY_TORTURE_IDS),
      fault: oneOf(`${w}.telemetryTorture.fault`, value.fault, TELEMETRY_FAULTS),
    }
    if (value.pageLoads !== undefined) {
      if (!Array.isArray(value.pageLoads) || value.pageLoads.length === 0) fail(`${w}.telemetryTorture.pageLoads`, "expected at least one zero-based document generation")
      const pageLoads = (value.pageLoads as unknown[]).map((item, k) => num(`${w}.telemetryTorture.pageLoads[${k}]`, item, 0))
      if (pageLoads.some((item) => !Number.isInteger(item))) fail(`${w}.telemetryTorture.pageLoads`, "document generations must be whole numbers")
      telemetryTorture.pageLoads = pageLoads
    }
    if (value.fetchGatePageLoads !== undefined) {
      if (!Array.isArray(value.fetchGatePageLoads) || value.fetchGatePageLoads.length === 0) fail(`${w}.telemetryTorture.fetchGatePageLoads`, "expected at least one zero-based document generation")
      const pageLoads = (value.fetchGatePageLoads as unknown[]).map((item, k) => num(`${w}.telemetryTorture.fetchGatePageLoads[${k}]`, item, 0))
      if (pageLoads.some((item) => !Number.isInteger(item))) fail(`${w}.telemetryTorture.fetchGatePageLoads`, "document generations must be whole numbers")
      telemetryTorture.fetchGatePageLoads = pageLoads
    }
    for (const key of ["fetchGateS", "activateAtTurn", "durationS", "retryAfterS", "freezeAfterReportS"] as const) {
      if (value[key] !== undefined) telemetryTorture[key] = num(`${w}.telemetryTorture.${key}`, value[key], 1)
    }
    if (telemetryTorture.activateAtTurn !== undefined && !Number.isInteger(telemetryTorture.activateAtTurn)) fail(`${w}.telemetryTorture.activateAtTurn`, "game turn must be a whole number")
    if (raw.acceptanceOnly !== true) fail(`${w}.telemetryTorture`, "torture profiles must be acceptanceOnly")
  }
  let dataChannelFault: Profile["dataChannelFault"]
  if (raw.dataChannelFault !== undefined) {
    const value = isObj(raw.dataChannelFault) ? raw.dataChannelFault : fail(`${w}.dataChannelFault`, "expected an object")
    for (const key of Object.keys(value)) if (key !== "dropRenegotiationOffers") fail(`${w}.dataChannelFault`, `has no field ${key}`)
    const dropRenegotiationOffers = num(`${w}.dataChannelFault.dropRenegotiationOffers`, value.dropRenegotiationOffers, 1)
    if (!Number.isInteger(dropRenegotiationOffers)) fail(`${w}.dataChannelFault.dropRenegotiationOffers`, "must be a whole number")
    if (raw.acceptanceOnly !== true) fail(`${w}.dataChannelFault`, "data-channel faults must be acceptanceOnly")
    dataChannelFault = { dropRenegotiationOffers }
  }
  let peerFault: Profile["peerFault"]
  if (raw.peerFault !== undefined) {
    const value = isObj(raw.peerFault) ? raw.peerFault : fail(`${w}.peerFault`, "expected an object")
    for (const key of Object.keys(value)) if (key !== "kind") fail(`${w}.peerFault`, `has no field ${key}`)
    if (raw.acceptanceOnly !== true) fail(`${w}.peerFault`, "peer faults must be acceptanceOnly")
    peerFault = { kind: oneOf(`${w}.peerFault.kind`, value.kind, PEER_FAULT_KINDS) }
  }
  if (env && Object.values(env).some((value) => value.includes(FIXTURE_URL_TOKEN)) && !fixture) fail(`${w}.env`, `${FIXTURE_URL_TOKEN} needs a fixture`)
  if (raw.identity !== undefined) {
    const named = typeof raw.identity === "object" && raw.identity !== null && !Array.isArray(raw.identity)
    const entries: [string, unknown][] = named ? Object.entries(raw.identity as object) : [["", raw.identity]]
    const bad = entries.find(([net, v]) => (named && !IDENTITY_NETWORKS.includes(net)) || !(typeof v === "string" && USERNAME_RE.test(v)))
    if (bad || !entries.length) fail(`${w}.identity`, `must be a lite username like jollityeea.09 (paseo-next-v2), or an object {${IDENTITY_NETWORKS.map((n) => `"${n}"`).join(" | ")}: username}, got ${JSON.stringify(raw.identity)}`)
  }
  if (raw.freshIdentity !== undefined && (raw.freshIdentity !== true || raw.identity !== undefined)) fail(`${w}.freshIdentity`, "must be true, and a profile that draws a fresh person has no fixed identity")
  if (!Array.isArray(raw.expect)) fail(`${w}.expect`, "expected an array of guards")
  const hasHostChainFault = network.timeline?.some(
    (step) =>
      step.hostChainCutS !== undefined ||
      step.hostChainHangS !== undefined ||
      step.outage === "people-rpc" ||
      step.outage === "statement-store",
  ) ?? false
  const hostHealthNegative = !hasHostChainFault && name !== "host-stuck-waiting" && name !== "host-stuck-in-game"
  return {
    name,
    ...(raw.pending !== undefined && { pending: raw.pending as string }),
    ...(raw.acceptanceOnly === true && { acceptanceOnly: true as const }),
    ...(raw.manualOnly === true && { manualOnly: true as const }),
    ...(minPlayers !== undefined && { minPlayers }),
    bot: bot as number | null,
    ...(raw.identity !== undefined && { identity: raw.identity as string | Record<string, string> }),
    ...(raw.freshIdentity === true && { freshIdentity: true as const }),
    device,
    cpuThrottle: num(`${w}.cpuThrottle`, raw.cpuThrottle, 1),
    camera: { delayMs: num(`${w}.camera.delayMs`, camera.delayMs, 0), resolution: oneOf(`${w}.camera.resolution`, camera.resolution, ["360p", "720p"] as const), ...(camera.mode !== undefined && { mode: camera.mode as (typeof CAMERA_MODES)[number] }), ...(camera.muteLoop === true && { muteLoop: true as const }) },
    ...(expectedOutcome && { expectedOutcome }),
    clockOffsetS: num(`${w}.clockOffsetS`, raw.clockOffsetS),
    ...(raw.clockJumps !== undefined && { clockJumps: raw.clockJumps as { atTurn: number; offsetS: number }[] }),
    ...(raw.locale !== undefined && { locale: raw.locale as string }),
    ...(raw.timezoneId !== undefined && { timezoneId: raw.timezoneId as string }),
    network,
    ...(env && { env }),
    ...(fixture && { fixture }),
    ...(telemetryTorture && { telemetryTorture }),
    ...(dataChannelFault && { dataChannelFault }),
    ...(peerFault && { peerFault }),
    role: { kind: roleKind, params, ...(roleLabel && { label: roleLabel }) },
    expect: withDefaultGuards((raw.expect as unknown[]).map((g, gi) => validateGuard(`${w}.expect[${gi}]`, g)), hostHealthNegative, network.relayOnly && (network.timeline ?? []).some((step) => step.outage === "turn-relay")),
  }
}

/** Validate a parsed profiles.json document; throws with the offending path named. */
export function validateProfiles(raw: unknown, netem: Record<string, NetemProfile> = loadNetemProfiles()): Profile[] {
  if (!isObj(raw) || !Array.isArray(raw.profiles)) return fail("profiles.json", "expected { profiles: [...] }")
  const list = (raw.profiles as unknown[]).map((p, i) => validateProfile(p, i, netem))
  const names = new Set<string>()
  const bots = new Set<number>()
  const torture = new Set<TelemetryTortureId>()
  for (const p of list) {
    if (names.has(p.name)) fail(`profile ${p.name}`, "duplicate name")
    names.add(p.name)
    if (p.telemetryTorture) {
      if (torture.has(p.telemetryTorture.id)) fail(`profile ${p.name}`, `duplicate telemetry torture id ${p.telemetryTorture.id}`)
      torture.add(p.telemetryTorture.id)
    }
    if (p.bot !== null) {
      if (bots.has(p.bot)) fail(`profile ${p.name}`, `duplicate bot number ${p.bot}`)
      bots.add(p.bot)
    }
  }
  return list
}

export const loadNetemProfiles = (): Record<string, NetemProfile> => validateNetemProfiles(netemJson)
let loaded: Profile[] | null = null
/** profiles.json, validated once per process (callers never mutate it). */
export const loadProfiles = (): Profile[] => (loaded ??= validateProfiles(profilesJson))

export function profileFor(bot: number, profiles: Profile[] = loadProfiles()): Profile {
  const p = profiles.find((x) => x.bot === bot)
  if (!p) throw new Error(`no profile for bot ${bot}; bots with one: ${profiles.filter((x) => x.bot !== null).map((x) => x.bot).join(", ")}`)
  return p
}

export function profileByName(name: string, profiles: Profile[] = loadProfiles()): Profile {
  const p = profiles.find((x) => x.name === name)
  if (!p) throw new Error(`no profile named ${JSON.stringify(name)}; known: ${profiles.map((x) => x.name).join(", ")}`)
  return p
}

const bound = (g: { min?: number; max?: number }): string => [g.min !== undefined && `>= ${g.min}`, g.max !== undefined && `<= ${g.max}`].filter(Boolean).join(" and ")

/** One line per guard, for run logs and failure messages. */
export function describeGuard(g: Guard): string {
  const pending = g.pending ? "[pending, not evaluated] " : ""
  switch (g.kind) {
    case "metric":
      return `${pending}metric ${g.name}${g.attrs ? ` with ${JSON.stringify(g.attrs)}` : ""} ${bound(g) ? `every point ${bound(g)}` : g.minBlocks !== undefined || g.maxBlocks !== undefined ? `every point ${[g.minBlocks !== undefined && `>= ${g.minBlocks}`, g.maxBlocks !== undefined && `<= ${g.maxBlocks}`].filter(Boolean).join(" and ")} observed chain block${g.minBlocks === 1 && g.maxBlocks === undefined || g.maxBlocks === 1 && g.minBlocks === undefined ? "" : "s"}` : "is recorded"}${g.minPoints !== undefined ? `, at least ${g.minPoints} point(s)` : ""}`
    case "event": {
      const attrs = g.attrs ? ` with ${JSON.stringify(g.attrs)}` : ""
      const seen = g.max === 0 ? "never seen" : bound(g) ? `seen ${bound(g)} times` : "seen at least once"
      return `${pending}event ${g.name}${attrs} ${seen}`
    }
    case "text":
      return `${pending}page ${g.never ? "never shows" : "shows"} ${JSON.stringify(g.text)}`
    case "text-cleared-any":
      return `${pending}page shows then clears one of ${g.texts.map((text) => JSON.stringify(text)).join(" or ")}`
    case "chain-report":
      return `${pending}chain report matches the bot's vote trail`
    case "store-rejection": {
      const seen = g.max === 0 ? "never refuses a submit" : bound(g) ? `refuses a submit ${bound(g)} times` : "refuses a submit"
      return `${pending}the statement store ${seen} with ${g.reason}`
    }
    case "devlog": {
      const fields = g.fields ? ` with fields ${JSON.stringify(g.fields)}` : ""
      const has = g.has?.length ? ` with ${g.has.map((key) => `${key} present`).join(" and ")}` : ""
      const seen = g.max === 0 ? "never" : bound(g) ? `${bound(g)} times` : "at least once"
      return `${pending}devLog${g.tag ? ` [${g.tag}]` : ""} line containing ${[g.match, ...(g.matchAny ?? [])].map((m) => JSON.stringify(m)).join(" or ")}${fields}${has} ${seen}`
    }
    case "late-join-proof":
      return `${pending}cold late join opens only round ${g.round}, receives co-player video within ${g.maxFirstVideoMs} ms, and never taps or seals before clock ready`
    case "reload-video-back":
      return `${pending}after the reload, every co-player seen before it (and not gone) sends video again within ${g.maxVideoBackMs} ms of the new page booting`
    case "synchronized-pc-failure":
      return `${pending}never has every established peer fail within ${g.withinMs} ms`
  }
}

/** Guards the app has no signal for yet: the evaluator reports them as skipped, never as passed. */
export const pendingGuards = (p: Profile): Guard[] => p.expect.filter((g) => g.pending)
