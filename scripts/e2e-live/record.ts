// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// What the live bots SAW and DID, as pure helpers (no playwright, no DOM), so
// vitest can pin them. The Playwright glue that feeds them is in
// journey.pw.ts; the diagnosis they serve is "why did the bots tap so little
// that most co-players were filed NotPerson" (paseo game 163).
//
// Three jobs:
//   - the tile row of one 250 ms tick (JSONL line) and the stage the page shows
//   - the app's devLog, read back from its IndexedDB mirror, and the vote trail
//     in it ("report built" carries filedBy and a verdict per co-player)
//   - the assertion on that trail: every co-player filed Person
import { HOST_ACTIVE_MINIMUM, HOST_ENDING } from "../../packages/jollity-game-chain/src/game/constants"
import type { Check } from "./chain-checks"

/** `rotateY(<deg>deg)` out of a CSS transform, as an absolute angle. */
export function parseRotateY(transform: string | null | undefined): number | null {
  const deg = parseRotY(transform)
  return deg === null ? null : Math.abs(deg)
}

/** `rotateY(<deg>deg)` with its SIGN, which is the verdict: the tile is a coin
 *  whose rotY is cumulative (components/game/tile/final-tile.tsx), +180 for an
 *  approve, −180 for a reject, and a change of mind turns it back to 0. */
export function parseRotY(transform: string | null | undefined): number | null {
  const m = /rotateY\((-?[\d.]+)deg\)/.exec(transform ?? "")
  return m ? Number(m[1]) : null
}

export type GameStage = "waiting" | "intro" | "play" | "confirm" | "other"

/** What the page exposes of the clock: there is no stage attribute, so it is
 *  read off the pill bar (aria-label "Turn N of M"), the intro headlines and
 *  the Confirm button. `ending` is not separable in the DOM and shows as play. */
export interface StageFacts {
  url: string
  pillLabel: string | null
  introHeadline: boolean
  confirmButton: boolean
  /** the page's own data-stage / data-turn (app/game/page.tsx), absent on a build that predates them */
  sessionStage?: string | null
  sessionTurn?: number | null
}
export interface StageRead {
  stage: GameStage
  /** 1-based turn inside the round, as the pill bar says it */
  turn: number | null
  turnsPerRound: number | null
}
export function readStage(f: StageFacts): StageRead {
  const m = /^Turn (\d+) of (\d+)$/.exec(f.pillLabel ?? "")
  const turn = m ? Number(m[1]) : null
  const turnsPerRound = m ? Number(m[2]) : null
  if (!f.url.includes("/game")) return { stage: "other", turn, turnsPerRound }
  if (f.confirmButton) return { stage: "confirm", turn, turnsPerRound }
  if (turn === null) return { stage: "waiting", turn, turnsPerRound }
  return { stage: f.introHeadline ? "intro" : "play", turn, turnsPerRound }
}

/** The session stages in which the app RECORDS a tap on a votable tile: lib/game-session.ts voteFor has no stage check,
 *  and the introduction's turnKey is already the new turn's, so an intro tap counts for that turn. "ending" is left out:
 *  the auto-reject flash is turning the tiles there, and the tile refuses a gesture while it turns (#398, game 61). */
export const VOTABLE_STAGES: ReadonlySet<string> = new Set(["introduction", "gameplay"])

/** What the page said about itself when a tap was decided: the session's own stage ("introduction", "gameplay",
 *  "ending", or "none"), which is the one fact that tells the ending (where the auto-reject flash turns the tiles and a
 *  tap is ignored) from play. "unknown" on a build with no data-stage: no guess is made from the DOM. */
export interface TapStamp {
  stage: string
  turn: number | null
}
export function stampOf(f: StageFacts): TapStamp {
  return { stage: f.sessionStage ?? "unknown", turn: f.sessionTurn ?? readStage(f).turn }
}

/** Where a click LANDED, from the stamp taken when it was decided and the one read after it returned: "ok" while the
 *  page is still in a votable stage of the same turn (an intro click that returns in gameplay is a tap the app records),
 *  "late: <stage>, turn N" once the turn changed or the page reached a stage that takes no tap (ending, none), or when
 *  the page could not be read. A late tap leaves the oracle no side to take on that co-player (down-turns.ts). */
export function landedResult(decided: TapStamp, after: TapStamp | null): string {
  return after && after.turn === decided.turn && VOTABLE_STAGES.has(after.stage) ? "ok" : `late: ${after?.stage ?? "unknown"}, turn ${after?.turn ?? "unknown"}`
}

/** A line of the bot's own tap log (taps-N.log, written by journey.pw.ts): `at` is when the click returned; `stage` and
 *  `turn` are the page's stamp when the click was decided (absent in logs written before the stamp). A skipped click
 *  carries the stage and turn it found, and a result starting "skipped". */
export interface TapRecord {
  at: string
  turn: number | null
  id: string
  result: string
  stage?: string
}
/** taps-N.log as records; a torn line drops only itself, like parseRows. */
export function parseTaps(text: string): TapRecord[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as TapRecord]
      } catch {
        return []
      }
    })
}

/** Follows the pill bar across rounds: a turn number that goes back down is
 *  a new round. */
export class RoundTracker {
  private round = 0
  private last: number | null = null
  /** the round index now (0-based), without advancing it */
  get current(): number {
    return this.round
  }
  next(turn: number | null): number {
    if (turn !== null) {
      if (this.last !== null && turn < this.last) this.round++
      this.last = turn
    }
    return this.round
  }
}

/** `c-r<round>-t<turn>-<stage>-<N>.png` */
export function shotName(round: number, turn: number | null, stage: GameStage, n: number): string {
  return `c-r${round}-t${turn ?? 0}-${stage}-${n}.png`
}

/** One tile at one tick. */
export interface TileRow {
  id: string
  /** Product role at this tick. Absent in retained pre-#426 artifacts. */
  role?: "host" | "you" | "empty" | "unseen" | "coplayer"
  /** Stable eligibility. Absent in retained artifacts from older app builds. */
  votable?: boolean
  /** Instantaneous gesture readiness. Absent in retained artifacts from older app builds. */
  tapReady?: boolean
  /** Controlled verdict exposed by current builds; rotation is the legacy fallback. */
  verdict?: string
  cursorPointer: boolean
  /** |rotY|, kept for the rows recorded before `rotY` existed */
  rotateY: number | null
  /** the signed angle: ≥ 90 is approved (see parseRotY) */
  rotY?: number | null
  /** data-tile-* attributes of the slot and everything inside it */
  attrs: Record<string, string>
  text: string
  aria: string[]
  box: { x: number; y: number; w: number; h: number } | null
  visible: boolean
  /** what a click at the tile's centre would hit: "self" or the element on top */
  hit: string | null
  tapped: boolean
  click: string | null
}

// ── the app's devLog ───────────────────────────────────────────────────────
/** A stored devLog row (lib/debug/telemetry.ts StoredEntry): `data` is JSON
 *  text, truncated past 4 KB. */
export interface StoredLog {
  ts: number
  sessionId?: string
  level?: string
  tag: string
  message: string
  data?: string
}
export interface LogLine extends Omit<StoredLog, "data"> {
  data?: unknown
}
export function parseLog(rows: readonly StoredLog[]): LogLine[] {
  return rows.map(({ data, ...rest }) => {
    if (data === undefined) return rest
    try {
      return { ...rest, data: JSON.parse(data) as unknown }
    } catch {
      return { ...rest, data }
    }
  })
}

/** The page's own export (window.__jollityHarness.exportLogs: the debug
 *  sheet's JSON, `{meta, entries}` with each entry's data already parsed).
 *  Read this way because no host has IndexedDB: the log is in the page's
 *  memory. Anything else reads as empty. */
export function parseExport(json: string): { meta: Record<string, unknown> | null; lines: LogLine[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { meta: null, lines: [] }
  }
  const raw = parsed as { meta?: unknown; entries?: unknown } | null
  if (!raw || !Array.isArray(raw.entries)) return { meta: null, lines: [] }
  const lines = raw.entries.flatMap((e): LogLine[] => {
    const entry = e as Partial<LogLine>
    if (typeof entry?.ts !== "number" || typeof entry.tag !== "string" || typeof entry.message !== "string") return []
    const line: LogLine = { ts: entry.ts, tag: entry.tag, message: entry.message }
    if (typeof entry.sessionId === "string") line.sessionId = entry.sessionId
    if (typeof entry.level === "string") line.level = entry.level
    if (entry.data !== undefined) line.data = entry.data
    return [line]
  })
  const meta = raw.meta && typeof raw.meta === "object" ? (raw.meta as Record<string, unknown>) : null
  return { meta, lines }
}

export interface Verdict {
  verdict?: string
  personTurns?: number
  notPersonTurns?: number
  autoTurns?: number
  source?: string
  unseenChoice?: "default-notperson" | "flipped-person"
  unseenEverFlipped?: boolean
}
export interface VoteTrail {
  /** every "report built" line, oldest first (a retry builds another) */
  reports: { ts: number; filedBy: string | null; players: Record<string, Verdict> }[]
  taps: number
  sealed: number
  /** confirm-stage verdict changes ("override" lines): a change and its change back are two */
  overrides: number
  /** the app's own "auto-confirm off" line: why no countdown ran (games 196, 197: the page stalled, so it counted itself away) */
  autoConfirmOff?: { ts: number; reason: string }
}
export function voteTrail(lines: readonly LogLine[]): VoteTrail {
  const trail: VoteTrail = { reports: [], taps: 0, sealed: 0, overrides: 0 }
  for (const l of lines) {
    if (l.tag !== "vote") continue
    if (l.message === "tap") trail.taps++
    else if (l.message === "override") trail.overrides++
    else if (l.message === "turn sealed") trail.sealed++
    else if (l.message === "auto-confirm off" && trail.autoConfirmOff === undefined) {
      const reason = (l.data as { reason?: unknown } | undefined)?.reason
      trail.autoConfirmOff = { ts: l.ts, reason: typeof reason === "string" ? reason : "unknown" }
    }
    else if (l.message === "report built" && typeof l.data === "object" && l.data !== null) {
      const { filedBy, players } = l.data as { filedBy?: string; players?: Record<string, Verdict> }
      trail.reports.push({ ts: l.ts, filedBy: filedBy ?? null, players: players ?? {} })
    }
  }
  return trail
}

/** Every co-player of the bot must be filed Person (the last report is the
 *  one on chain). With `diagnose` a miss is a WARN, so a diagnosis run
 *  completes; without it the same miss FAILS. */
export function checkVotes(name: string, trail: VoteTrail, diagnose: boolean): Check {
  const miss = diagnose ? "warn" : "fail"
  const report = trail.reports.at(-1)
  if (!report) return { name, status: miss, detail: "no 'report built' line in the devLog (the report was never built)" }
  const rows = Object.entries(report.players)
  const bad = rows.filter(([, v]) => v.verdict !== "person")
  const detail = `filedBy=${report.filedBy}, ${rows.length - bad.length}/${rows.length} co-players filed Person, ${trail.taps} taps, ${trail.sealed} turns sealed${bad.length ? `; not Person: ${bad.map(([id, v]) => `${id.slice(0, 8)}=${v.verdict} (${v.source}, ${v.personTurns}P/${v.notPersonTurns}N, ${v.autoTurns} auto)`).join(", ")}` : ""}`
  if (rows.length === 0) return { name, status: miss, detail: `no co-players in the report; ${detail}` }
  return { name, status: bad.length ? miss : "pass", detail }
}

/** Summary lines: each bot's filed verdict per co-player. */
export function voteTable(rows: { user: string; trail: VoteTrail }[], names: Record<string, string> = {}): string {
  const out = ["| bot | filed by | co-player | verdict | source | never-seen choice | person turns | notperson turns | auto-sealed turns |", "|---|---|---|---|---|---|---|---|---|"]
  for (const { user, trail } of rows) {
    const r = trail.reports.at(-1)
    if (!r) {
      out.push(`| ${user} | (no report built) | | | | | | | |`)
      continue
    }
    for (const [id, v] of Object.entries(r.players))
      out.push(`| ${user} | ${r.filedBy} | ${names[id] ?? id.slice(0, 8)} | ${v.verdict} | ${v.source} | ${v.unseenChoice ?? ""} | ${v.personTurns} | ${v.notPersonTurns} | ${v.autoTurns} |`)
  }
  return out.join("\n")
}

// ── the tap, and what each turn ended on ───────────────────────────────────
export interface Box {
  x: number
  y: number
  w: number
  h: number
}
export interface Viewport {
  width: number
  height: number
}

/** The whole box inside the viewport. A tile flying in from off-screen (x
 *  about −232 or 439 on a 390-wide phone) is not, and a click on it fails
 *  with "Element is outside of the viewport". */
export function fullyInView(box: Box | null | undefined, vp: Viewport): boolean {
  if (!box || box.w <= 0 || box.h <= 0) return false
  return box.x >= 0 && box.y >= 0 && box.x + box.w <= vp.width && box.y + box.h <= vp.height
}

/** The page at one tick, as the tap loop needs it. */
export interface TapFrame {
  stage: GameStage
  /** the pill bar is ducked: the intro, or the round change after a round's
   *  last turn (the pill still names that turn while the tiles reset) */
  ducked: boolean
}

/** Approved: the signed angle when the row has it, else the old absolute one
 *  (rows recorded before rotY; a reject reads as approved there). */
export function isApproved(tile: Pick<TileRow, "rotateY" | "rotY" | "verdict">): boolean {
  if (tile.verdict !== undefined) return tile.verdict === "approve"
  const deg = tile.rotY !== undefined ? tile.rotY : tile.rotateY
  return deg !== null && deg >= 90
}

/** Old artifacts exposed eligibility and readiness only through the cursor class. */
export const tileVotable = (tile: Pick<TileRow, "votable" | "cursorPointer">): boolean =>
  tile.votable ?? tile.cursorPointer
export const tileTapReady = (tile: Pick<TileRow, "tapReady" | "cursorPointer">): boolean =>
  tile.tapReady ?? tile.cursorPointer
export const tileRole = (tile: Pick<TileRow, "role" | "attrs">): TileRow["role"] =>
  tile.role ?? (tile.attrs?.["data-tile-role"] as TileRow["role"] | undefined)

/** Why the loop will not tap this tile now, or null when it may: only a
 *  votable, undecided tile, in the play stage with the pill up, its whole box
 *  on screen, its centre hitting the tile itself, and standing still since
 *  the last tick (`prevBox`). */
export function tapBlocker(
  tile: Pick<TileRow, "role" | "attrs" | "votable" | "tapReady" | "cursorPointer" | "verdict" | "rotateY" | "rotY" | "box" | "hit">,
  frame: TapFrame,
  vp: Viewport,
  prevBox?: Box | null,
): string | null {
  const role = tileRole(tile)
  if (role === "unseen" || role === "host" || role === "you" || role === "empty") return `role ${role}`
  if (!tileVotable(tile)) return "not votable"
  if (isApproved(tile)) return "approved"
  if (!tileTapReady(tile)) return "not ready"
  if (frame.stage !== "play") return `stage ${frame.stage}`
  if (frame.ducked) return "pill ducked (intro or round change)"
  if (!fullyInView(tile.box, vp)) return "outside the viewport"
  if (tile.hit !== "self") return `centre hits ${tile.hit ?? "nothing"}`
  if (prevBox !== undefined) {
    const b = tile.box as Box
    if (!prevBox || Math.abs(prevBox.x - b.x) > 1 || Math.abs(prevBox.y - b.y) > 1) return "moving"
  }
  return null
}

/** A completed pass gets a few immediate browser-time rescans before the
 * actor yields back to slower role work. A receiver can become a legal
 * Co-player just after the pass (game 135); 25 ms polling catches both that
 * transition and the first task after a long main-thread stall without
 * carrying eligibility across a stage or turn. */
export const POST_PASS_RESCAN_ATTEMPTS = 5
export const POST_PASS_RESCAN_MS = 25
export interface PostPassRescan {
  turn: number
  remaining: number
}

/** Advance by observed browser snapshots, never wall time. A same-Page long
 * task may delay the next snapshot by seconds; it must not spend the bounded
 * rescan attempts while the actor could not inspect the page. */
export const nextPostPassRescan = (
  current: PostPassRescan | null,
  turn: number | null,
  stage: GameStage,
  verified: number,
  alreadyArmed: boolean,
): PostPassRescan | null => {
  if (turn === null || stage !== "play") return null
  if (verified > 0 && !alreadyArmed) return { turn, remaining: POST_PASS_RESCAN_ATTEMPTS }
  if (!current || current.turn !== turn || current.remaining <= 1) return null
  return { turn, remaining: current.remaining - 1 }
}

/** Keep a tile that moved since the previous outer read in this pass, but
 * defer the decision to the fresh per-click read. Other tiles in the pass can
 * consume enough time for a just-transitioned Host-to-Co-player tile to
 * settle; dropping it here can otherwise leave the final turn untapped. */
export const tapPassPriority = (blocker: string | null): 0 | 1 | null =>
  blocker === null ? 0 : blocker === "moving" ? 1 : null

/** Tap-storm settlement historically revisits every stable pass candidate.
 * Only the new deferred candidates need the full candidate-snapshot guard;
 * priority zero preserves the established settlement path byte-for-byte. */
export const tapPassSettlementBlocker = (
  priority: 0 | 1,
  tile: Parameters<typeof tapBlocker>[0],
  frame: TapFrame,
  vp: Viewport,
  passBox: Box | null | undefined,
): string | null => (priority === 1 ? tapBlocker(tile, frame, vp, passBox) : null)

/** A coordinate click is evidence only after the same turn shows the tile as
 * approved. While that turn can still take input, an unchanged or temporarily
 * unavailable tile is retried; stage/turn closure stays late. */
export function tapResult(
  decided: TapStamp,
  after: TapStamp | null,
  tile: Pick<TileRow, "verdict" | "rotateY" | "rotY"> | null,
): string {
  const landed = landedResult(decided, after)
  if (landed !== "ok") return landed
  if (!tile) return "retry: tile unavailable"
  return isApproved(tile) ? "ok" : "retry: verdict unchanged"
}

/** Retries are recorded as skipped diagnostics: `note()` therefore adds
 * neither clickErrors nor successful-tap evidence for a swallowed click. */
export function tapLogResult(result: string): { logged: string; retry: boolean } {
  return result.startsWith("retry:")
    ? { logged: `skipped: ${result}; retrying`, retry: true }
    : { logged: result, retry: false }
}

/** A tick of tiles-N.jsonl (or an error line the recorder wrote). */
export interface TickRow {
  /** Discriminates retained non-observation evidence from DOM snapshots. */
  recordType?: "observation" | "role-action"
  /** Structured role action. Present only when recordType is role-action. */
  roleAction?: { id: string; detail: string }
  /** Retained human-readable role-action text used by existing artifacts. */
  role?: string
  /** Historical scheduler timestamp. New readers must use the bracket below
   * when deciding when the DOM snapshot was actually observed. */
  t?: string
  ms?: number
  readStartedAt?: string
  /** In-page timestamp captured in the same evaluation as stage/tiles. */
  snapshotAt?: string
  readCompletedAt?: string
  /** Increments when the recorder is rebound to a replacement page. */
  pageGeneration?: number
  /** Per-document identity; changes on reload even when Page does not. */
  documentIdentity?: string
  url?: string
  stage?: GameStage
  turn?: number | null
  round?: number
  ducked?: boolean
  sessionStage?: string | null
  sessionTurn?: number | null
  viewport?: Viewport
  tiles?: TileRow[]
  error?: string
}
export function parseRows(jsonl: string): TickRow[] {
  return jsonl
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as TickRow]
      } catch {
        return []
      }
    })
}

/** The frame each turn ENDED on: per pill turn, the last tick in the play
 *  stage with the pill up. The ducked stretch after a round's last turn (the
 *  pill still says that turn, the tiles have already reset to 0° for the next
 *  round) is the round change, never the turn's end state. */
export function turnEnds(rows: readonly TickRow[]): Map<number, TickRow> {
  const ends = new Map<number, TickRow>()
  for (const r of rows) {
    if (r.error || r.stage !== "play" || r.ducked || r.turn == null || !r.tiles) continue
    ends.set(r.turn, r)
  }
  return ends
}

export type TurnVerdict = "approved" | "missed" | "no-opportunity" | "late-tap-ready" | "unknown" | "not-votable" | "unseen" | "late"
export const isGhost = (id: string) => id.startsWith("ghost:")

/** May the tap storm's settle loop re-tap this tile? A running turn ignores the finger (final-tile.tsx), so a tap on a
 *  tile mid-flip is lost or undoes its verdict. Current builds expose the verdict and tapReady already excludes a
 *  turning tile, so the angle does not matter (game 1601 bot 17: low power drops rotateY and every reading was null).
 *  Without a verdict (old builds) the angle decides: 0 or a half turn, never an unreadable one. */
export const settleRetappable = (tile: { verdict?: string; rotateY: number | null; rotY?: number | null }): boolean => {
  if (tile.verdict !== undefined) return true
  const deg = tile.rotY ?? tile.rotateY
  return deg !== null && Math.abs(Math.abs(deg) % 180) < 1
}

const parsedTime = (value: string | undefined): number | null => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Current recorder provenance. Old artifacts deliberately fail this check:
 * their scheduling timestamp cannot prove the phase of a later DOM read. */
const authoritativeRow = (row: TickRow): boolean => {
  const started = parsedTime(row.readStartedAt)
  const snapshot = parsedTime(row.snapshotAt)
  const completed = parsedTime(row.readCompletedAt)
  return (
    started !== null &&
    snapshot !== null &&
    completed !== null &&
    started <= completed &&
    typeof row.sessionStage === "string" &&
    typeof row.sessionTurn === "number" &&
    typeof row.ducked === "boolean" &&
    Number.isSafeInteger(row.pageGeneration) &&
    typeof row.documentIdentity === "string" &&
    row.documentIdentity.length > 0 &&
    !!row.viewport &&
    row.viewport.width > 0 &&
    row.viewport.height > 0
  )
}

/** A cutoff ordering additionally needs the browser clock reconciled with
 * the Node read bracket. A legal ready frame is direct evidence even when a
 * clock profile is active, but clock-skewed absence cannot prove a no-op. */
const reconciledRow = (row: TickRow): boolean => {
  if (!authoritativeRow(row)) return false
  const started = parsedTime(row.readStartedAt)!
  const snapshot = parsedTime(row.snapshotAt)!
  const completed = parsedTime(row.readCompletedAt)!
  return started <= snapshot && snapshot <= completed
}

const tileOf = (row: TickRow, id: string): TileRow | undefined => row.tiles?.find((tile) => tile.id === id)

/** Only the recorder's complete structured annotation is non-observational.
 * Untyped historical markers and malformed/ambiguous rows remain part of the
 * fail-closed continuity audit. */
export const isRoleActionAnnotation = (row: TickRow): boolean =>
  Object.keys(row).sort().join("|") === "recordType|role|roleAction|t" &&
  typeof row.t === "string" &&
  parsedTime(row.t) !== null &&
  row.recordType === "role-action" &&
  typeof row.roleAction === "object" &&
  row.roleAction !== null &&
  Object.keys(row.roleAction).sort().join("|") === "detail|id" &&
  typeof row.roleAction.id === "string" &&
  row.roleAction.id.length > 0 &&
  typeof row.roleAction.detail === "string" &&
  row.role === `${row.roleAction.id}: ${row.roleAction.detail}`

/** A legal opportunity uses the same guards as the tap loop, including a
 * stable box from an immediately preceding authoritative sample. */
function observedOpportunity(rows: readonly TickRow[], turn: number, id: string): boolean {
  let previous: TickRow | undefined
  for (const row of rows) {
    if (isRoleActionAnnotation(row)) continue
    if (!authoritativeRow(row) || row.sessionTurn !== turn || row.stage !== "play" || row.ducked || !VOTABLE_STAGES.has(row.sessionStage!)) {
      previous = undefined
      continue
    }
    const tile = tileOf(row, id)
    const prior = previous && previous.pageGeneration === row.pageGeneration && previous.documentIdentity === row.documentIdentity ? tileOf(previous, id) : undefined
    previous = row
    // A prior approval is itself direct proof that the gesture existed, even
    // if a later override/reset leaves the end row rejected.
    if (tile && isApproved(tile)) return true
    if (!tile || !prior || row.viewport === undefined) continue
    if (tapBlocker(tile, { stage: row.stage, ducked: false }, row.viewport, prior.box) === null) return true
  }
  return false
}

/** A proof gap may not outlive the product's entire ending phase. This is an
 * evidence-freshness ceiling, never a grace period: any directly observed
 * legal opportunity still wins before this proof is considered. */
const MAX_CUTOFF_EVIDENCE_GAP_MS = HOST_ENDING * 1000

/** The ordering no-opportunity proof (tooLateToTap is the other, from the tap log): the same page/session observes
 * this peer Unseen in the authoritative ending phase, then first observes it
 * as Co-player after that cutoff. Absence, false readiness, elapsed time, or
 * a reload never substitutes for this ordering. */
function arrivedAfterCutoff(rows: readonly TickRow[], turn: number, id: string): boolean {
  // Locate the first possible Co-player evidence before filtering. A legacy
  // or clock-unreconciled Co-player cannot be laundered away into a later
  // "first" arrival; only a different authoritative turn is unrelated.
  const arrivalIndex = rows.findIndex((row) => {
    const tile = tileOf(row, id)
    if (!tile) return false
    if (authoritativeRow(row) && row.sessionTurn !== turn) return false
    return tileRole(tile) === "coplayer" || (tileRole(tile) === undefined && tileVotable(tile))
  })
  if (arrivalIndex <= 0) return false
  const arrival = rows[arrivalIndex]
  if (
    !reconciledRow(arrival) ||
    arrival.sessionTurn !== turn ||
    arrival.stage !== "play" ||
    arrival.ducked ||
    arrival.sessionStage !== "ending" ||
    tileRole(tileOf(arrival, id)!) !== "coplayer"
  ) return false

  const sameAttachment = (row: TickRow) => sameDocument(row, arrival)
  const cutoffIndex = rows.slice(0, arrivalIndex).findLastIndex((row) => {
    const tile = tileOf(row, id)
    return reconciledRow(row) && sameAttachment(row) && row.sessionTurn === turn && row.stage === "play" && !row.ducked && row.sessionStage === "ending" && !!tile && tileRole(tile) === "unseen"
  })
  if (cutoffIndex < 0) return false
  // Start at the first target evidence for this turn, before filtering, but only after the last authoritative row of
  // ANOTHER turn: connect-phase rows (no session turn) that precede the game's earlier turns are not part of this
  // turn's proof. A reload or legacy/partial prefix inside this turn is still audited, never discarded.
  const lowerBound = rows.slice(0, cutoffIndex + 1).findLastIndex((row) => authoritativeRow(row) && row.sessionTurn !== turn) + 1
  // The page's waiting room draws the tile Unseen before the turn begins (game 1592, bots 4 and 12): those rows are
  // skipped, but only while no row of this turn has been seen. A waiting row after the turn began is still audited.
  let turnBegan = false
  const startIndex = rows.slice(lowerBound, cutoffIndex + 1).findIndex((row) => {
    const tile = tileOf(row, id)
    if (authoritativeRow(row) && row.sessionTurn === turn) turnBegan = true
    if (!turnBegan && !row.error && waitingRowOn(row, arrival) && tile && tileRole(tile) === "unseen") return false
    return !!tile && (!authoritativeRow(row) || row.sessionTurn === turn)
  }) + lowerBound
  if (startIndex < lowerBound || startIndex > cutoffIndex) return false

  // The freshness ceiling runs from the turn's last gameplay row on: that row, the ending rows and the arrival. Before
  // it, every row still has to read Unseen on the same document, and the seen bit is one-way within a document
  // (lib/video-role-history.ts), so a slow read there cannot hide a Co-player window: a frame decoded during it would
  // read Co-player in every later row. Game 334, bot 6: a 3.5 s read stall in turn 4's gameplay, then 5CigJEmw Unseen
  // through the ending and Co-player in its last row, which the app sealed NotPerson.
  const freshFrom = rows.slice(0, cutoffIndex + 1).findLastIndex((row, index) => index >= startIndex && !isRoleActionAnnotation(row) && row.sessionStage === "gameplay")
  let previousCompleted: number | null = null
  let previousSnapshot: number | null = null
  let phase = -1
  let sawGameplay = false
  for (let index = startIndex; index <= arrivalIndex; index++) {
    const row = rows[index]
    if (isRoleActionAnnotation(row)) continue
    const tile = tileOf(row, id)
    const nextPhase = row.sessionStage === "introduction" ? 0 : row.sessionStage === "gameplay" ? 1 : row.sessionStage === "ending" ? 2 : -1
    // An introduction with no headline (a vacant or feedless host seat, noHostIntro) reads stage "play" in the DOM.
    const coarseStageMatches =
      (row.sessionStage === "introduction" && (row.stage === "intro" || row.stage === "play")) ||
      ((row.sessionStage === "gameplay" || row.sessionStage === "ending") && row.stage === "play")
    if (
      !reconciledRow(row) ||
      !sameAttachment(row) ||
      row.sessionTurn !== turn ||
      !coarseStageMatches ||
      (row.ducked && row.sessionStage !== "introduction") ||
      !tile
    ) return false
    if (nextPhase < phase) return false
    phase = nextPhase
    if (row.sessionStage === "gameplay") sawGameplay = true
    if (index < arrivalIndex && tileRole(tile) !== "unseen") return false
    if (index === arrivalIndex && tileRole(tile) !== "coplayer") return false

    if (index < freshFrom) continue
    const started = parsedTime(row.readStartedAt)!
    const snapshot = parsedTime(row.snapshotAt)!
    const completed = parsedTime(row.readCompletedAt)!
    if (
      completed - started > MAX_CUTOFF_EVIDENCE_GAP_MS ||
      (previousCompleted !== null && (started < previousCompleted || started - previousCompleted > MAX_CUTOFF_EVIDENCE_GAP_MS)) ||
      (previousSnapshot !== null && (snapshot < previousSnapshot || snapshot - previousSnapshot > MAX_CUTOFF_EVIDENCE_GAP_MS))
    ) return false
    previousCompleted = completed
    previousSnapshot = snapshot
  }
  // A real gameplay→ending transition is the event witness that the session
  // clock advanced through this turn; agreeing wall clocks alone do not prove
  // that a cold/stale product snapshot was ready.
  return sawGameplay && phase === 2 && cutoffIndex >= startIndex && cutoffIndex < arrivalIndex
}

/** The same loaded page: one generation of one document. */
const sameDocument = (a: TickRow, b: TickRow): boolean => a.pageGeneration === b.pageGeneration && a.documentIdentity === b.documentIdentity

/** A row's snapshot lies inside its own runner read bracket. reconciledRow needs a session stage, which a waiting-room
 *  row does not have, so this is the same check on the timestamps alone. */
const snapshotInBracket = (row: TickRow): boolean => {
  const started = parsedTime(row.readStartedAt)
  const snapshot = parsedTime(row.snapshotAt)
  const completed = parsedTime(row.readCompletedAt)
  return started !== null && snapshot !== null && completed !== null && started <= snapshot && snapshot <= completed
}

/** A waiting-room row of the given page: the stage is waiting and the snapshot lies inside the read bracket. Callers
 *  add their own conditions on the row's error and tiles. */
const waitingRowOn = (row: TickRow, page: TickRow): boolean => row.stage === "waiting" && sameDocument(row, page) && snapshotInBracket(row)

/** The turn's first row is its ending, read by the page whose waiting-room snapshot came less than TAP_REACTION_MS before: it had no
 *  votable stage of this turn to vote in. Game 399, bot 28. Anything else keeps the other proofs: a votable-stage row of the
 *  turn on any page, a tap on the tile, a reload (another document), or a longer span between the snapshots (even one
 *  stalled read), which may hide the stages the page played. */
function joinedInEnding(rows: readonly TickRow[], end: TickRow, turn: number, id: string, taps: readonly TapRecord[]): boolean {
  if (taps.some((t) => t.turn === turn && t.id === id)) return false
  if (!reconciledRow(end) || end.sessionStage !== "ending" || end.sessionTurn !== turn) return false
  const observed = rows.filter((row) => !isRoleActionAnnotation(row))
  if (observed.some((row) => row.sessionTurn === turn && VOTABLE_STAGES.has(row.sessionStage!))) return false
  const first = observed.findIndex((row) => row.sessionTurn === turn)
  if (first <= 0) return false
  const [entered, before] = [observed[first], observed[first - 1]]
  if (!reconciledRow(entered) || !sameDocument(entered, end) || !waitingRowOn(before, end)) return false
  // The page can only have been in a votable stage between its last waiting snapshot and its first ending snapshot.
  // A stalled read inside that span is no excuse (stalledWithin is not subtracted, as tooLateToTap does): the page kept
  // playing while the recorder waited, so the span has to be shorter than the bot's reaction time on its own.
  const span = parsedTime(entered.snapshotAt)! - (parsedTime(before.snapshotAt) ?? Number.NaN)
  return span >= 0 && span < TAP_REACTION_MS
}

/** The last authoritative gameplay snapshot still reads Unseen and the next
 * authoritative snapshot, less than one reaction window later on the same
 * page, is already in the ending and reads Co-player. Even if the frame landed
 * immediately after the gameplay snapshot, the bot had too little legal time
 * to act before the product closed voting. A longer gap, an interrupted read,
 * a reload or any earlier Co-player evidence remains unknown. */
function arrivedAcrossEndingBoundary(rows: readonly TickRow[], end: TickRow, turn: number, id: string, taps: readonly TapRecord[]): boolean {
  if (taps.some((tap) => tap.turn === turn && tap.id === id && !tap.result.startsWith("skipped: page showed"))) return false
  const endIndex = rows.indexOf(end)
  if (endIndex < 0) return false
  const lowerBound = rows.slice(0, endIndex + 1).findLastIndex((row) => authoritativeRow(row) && row.sessionTurn !== turn) + 1
  const relativeArrivalIndex = rows.slice(lowerBound, endIndex + 1).findIndex((row) => {
    const tile = tileOf(row, id)
    return authoritativeRow(row) && row.sessionTurn === turn && !!tile && tileRole(tile) === "coplayer"
  })
  if (relativeArrivalIndex < 0) return false
  const arrivalIndex = lowerBound + relativeArrivalIndex
  const arrival = rows[arrivalIndex]
  const arrivalTile = tileOf(arrival, id)!
  if (
    !reconciledRow(arrival) ||
    arrival.sessionStage !== "ending" ||
    arrival.stage !== "play" ||
    arrival.ducked ||
    !tileTapReady(arrivalTile)
  ) return false

  let beforeIndex = arrivalIndex - 1
  while (beforeIndex >= 0 && isRoleActionAnnotation(rows[beforeIndex])) beforeIndex--
  if (beforeIndex < 0) return false
  const before = rows[beforeIndex]
  const beforeTile = tileOf(before, id)
  if (
    !reconciledRow(before) ||
    !sameDocument(before, arrival) ||
    before.sessionTurn !== turn ||
    before.sessionStage !== "gameplay" ||
    before.stage !== "play" ||
    before.ducked ||
    !beforeTile ||
    tileRole(beforeTile) !== "unseen"
  ) return false

  // An untyped/malformed row between the two observations is an evidence gap,
  // not a reason to treat the later Co-player row as the first arrival.
  if (rows.slice(beforeIndex + 1, arrivalIndex).some((row) => !isRoleActionAnnotation(row))) return false
  if (rows.slice(lowerBound, beforeIndex + 1).some((row) => authoritativeRow(row) && row.sessionStage === "ending")) return false
  // The page's waiting-room rows before its first play row (a late join or a rejoin) carry no tiles, so they sit inside
  // the turn's lower bound and are not evidence of the tile. hostedFirstFrame's absentBefore takes the same rows but
  // does not ask for a bracketed snapshot, because it does not bound a time span; this proof does.
  let played = false
  for (const row of rows.slice(lowerBound, beforeIndex + 1)) {
    if (isRoleActionAnnotation(row)) continue
    if (!played && waitingRowOn(row, arrival) && !row.error && !row.tiles?.length) continue
    played = true
    const tile = tileOf(row, id)
    if (!reconciledRow(row) || !sameDocument(row, arrival) || row.sessionTurn !== turn || !tile || tileRole(tile) !== "unseen") return false
  }
  const span = parsedTime(arrival.snapshotAt)! - parsedTime(before.snapshotAt)!
  return span >= 0 && span < TAP_REACTION_MS
}

/** The app's own stage (sessionStage) leads the DOM stage the end row is picked by (turnEnds), so a turn's end row can
 *  already be in the ending, where a votable undecided tile is the app's own auto-sealed NotPerson. When every gameplay
 *  row of the turn shows the tile not votable and the page's next row, less than TAP_REACTION_MS later, is the ending,
 *  the tile first turned votable after the app closed voting: no opportunity. Rows without sessionStage never match, so
 *  older artifacts read as before. */
function votableOnlyAfterCutoff(rows: readonly TickRow[], turn: number, id: string, taps: readonly TapRecord[]): boolean {
  if (taps.some((t) => t.turn === turn && t.id === id && !t.result.startsWith("skipped: page showed"))) return false
  const observed = rows.filter((row) => !isRoleActionAnnotation(row))
  const inTurn = observed.filter((row) => authoritativeRow(row) && row.sessionTurn === turn)
  const lastGameplay = inTurn.findLast((row) => row.sessionStage === "gameplay")
  if (!lastGameplay) return false
  const next = observed[observed.indexOf(lastGameplay) + 1]
  if (!next || next.sessionTurn !== turn || next.sessionStage !== "ending" || !reconciledRow(next)) return false
  // the votable stages and the ending are read in the play stage with the pill up, as the sibling proofs require
  if ([lastGameplay, next].some((row) => row.stage !== "play" || row.ducked)) return false
  // the ending's first row shows the tile Co-player and either not votable yet or votable and ready: it opened after
  // the app closed voting. A row that is votable but not tap-ready, or ready but not votable, is contradictory and
  // proves nothing (game 280, bot 26).
  const arrival = tileOf(next, id)
  if (!arrival || tileRole(arrival) !== "coplayer" || tileVotable(arrival) !== tileTapReady(arrival)) return false
  // the same page watched the tile, from the turn's first row, never votable in gameplay: Unseen, then at most the
  // last TAP_REACTION_MS of it Co-player but not yet votable
  const run = inTurn.slice(0, inTurn.indexOf(next) + 1)
  // nothing in between is filtered away: the run is the page's unbroken rows, and none of them is already an ending
  const first = observed.indexOf(run[0])
  if (observed.slice(first, observed.indexOf(next) + 1).length !== run.length) return false
  if (run.slice(0, -1).some((row) => !VOTABLE_STAGES.has(row.sessionStage!))) return false
  const unseenRun = run.slice(0, -1).every((row) => {
    const tile = tileOf(row, id)
    if (!reconciledRow(row) || !sameDocument(row, next) || !tile || tileVotable(tile)) return false
    if (row.sessionStage !== "gameplay") return true
    const role = tileRole(tile)
    return role === "unseen" || (role === "coplayer" && parsedTime(next.snapshotAt)! - parsedTime(row.snapshotAt)! < TAP_REACTION_MS)
  })
  // only the two rows either side of the cutoff must be prompt: a stall elsewhere cannot hide a votable stretch there
  const prompt = (row: TickRow) => parsedTime(row.snapshotAt)! - parsedTime(row.readStartedAt)! <= RECORDER_TICK_MS
  if (!unseenRun || !prompt(next) || !prompt(lastGameplay)) return false
  // Votability is not one-way, so the whole Co-player stretch is bounded from the last Unseen row, not row by row: a
  // recorder gap after it could hide a votable stretch the bot missed.
  const lastUnseen = run.findLast((row) => row.sessionStage === "gameplay" && tileRole(tileOf(row, id)!) === "unseen")
  if (lastUnseen && !(parsedTime(next.snapshotAt)! - parsedTime(lastUnseen.snapshotAt)! < TAP_REACTION_MS)) return false
  const span = parsedTime(next.snapshotAt)! - parsedTime(lastGameplay.snapshotAt)!
  return span >= 0 && span < TAP_REACTION_MS
}

/** Why a Co-player tile could not be voted on: proven orderings/timings that leave the bot no legal tap. */
function noOpportunityProof(rows: readonly TickRow[], end: TickRow, turn: number, id: string, taps: readonly TapRecord[]): boolean {
  return arrivedAfterCutoff(rows, turn, id) || arrivedAcrossEndingBoundary(rows, end, turn, id, taps) || tooLateToTap(rows, turn, id, taps) || joinedInEnding(rows, end, turn, id, taps)
}

/** How long the bot's tap loop may take to act on a tile that just became votable: one pass read, the per-click
 *  guard's fresh read and the click (journey.pw.ts, 250-500 ms a pass on a loaded runner). A person needs as long. */
export const TAP_REACTION_MS = 1000
/** The recorder's sampling tick (recorder.ts): a read slower than this to reach its snapshot is a stall, not a sample. */
const RECORDER_TICK_MS = 250

/** Two recorder ticks let one sample observe votable before the next observes readiness without blaming the product.
 * Beyond that, even after subtracting page-read stalls, delayed readiness is a product defect rather than a reason to
 * excuse a missed vote. */
const LATE_TAP_READY_MS = RECORDER_TICK_MS * 2

/** Timing evidence for a co-player that arrived late: the preceding Unseen row proves the arrival, firstVotable starts
 *  the product-readiness clock, and openedAt is the first frame that is both votable and tap-ready. If readiness is
 *  prompt, the close can prove that no actionable window existed; if readiness itself is late, the caller reports the
 *  product defect instead. The close is proven by either
 *  - the bot's own refused tap ("skipped: page showed ..."; it ends the pass, so it speaks for the whole turn), or
 *  - the same page's first snapshot showing this turn's ending (endingSeenAt): the votable stages had closed by then.
 *  Both ends are on the runner's clock (a reconciled row's snapshotAt, the tap's `at`), and the span over-estimates
 *  the window, since the frame arrived after that Unseen snapshot. Game 272: bots 2 and 26 saw it in the last gameplay
 *  tick, bot 20 first in the ending with no Unseen ending row to anchor arrivedAfterCutoff. Game 280: bot 26 first saw
 *  it in the ending after a 1.3 s read stall, and its loop never got to refuse a tap. The app seals it NotPerson, and
 *  the oracle counts it so (no-opportunity). */
function lateArrivalTiming(rows: readonly TickRow[], turn: number, id: string): { openedAt: number; readyDelayMs: number; arrival: TickRow } | null {
  const arrivalIndex = rows.findIndex((row) => {
    const tile = tileOf(row, id)
    return authoritativeRow(row) && row.sessionTurn === turn && !!tile && tileRole(tile) === "coplayer"
  })
  if (arrivalIndex <= 0) return null
  const arrival = rows[arrivalIndex]
  const before = rows.slice(0, arrivalIndex).findLast((row) => !isRoleActionAnnotation(row))
  const tile = before && tileOf(before, id)
  if (
    !before ||
    !tile ||
    tileRole(tile) !== "unseen" ||
    !reconciledRow(before) ||
    before.pageGeneration !== arrival.pageGeneration ||
    before.documentIdentity !== arrival.documentIdentity ||
    before.sessionTurn !== turn ||
    !VOTABLE_STAGES.has(before.sessionStage!)
  ) return null
  const candidates = rows.slice(arrivalIndex).filter((row) => {
    const candidate = tileOf(row, id)
    return (
      reconciledRow(row) &&
      sameDocument(row, arrival) &&
      row.sessionTurn === turn &&
      row.stage === "play" &&
      !row.ducked &&
      VOTABLE_STAGES.has(row.sessionStage!) &&
      !!candidate &&
      tileRole(candidate) === "coplayer" &&
      tileVotable(candidate)
    )
  })
  const firstVotable = candidates[0]
  const ready = candidates.find((row) => tileTapReady(tileOf(row, id)!))
  if (!firstVotable || !ready) return null
  const firstVotableAt = parsedTime(firstVotable.snapshotAt)!
  const openedAt = parsedTime(ready.snapshotAt)!
  return {
    arrival,
    openedAt,
    readyDelayMs: Math.max(0, openedAt - firstVotableAt - stalledWithin(rows, firstVotableAt, openedAt)),
  }
}

function lateTapReady(rows: readonly TickRow[], turn: number, id: string): boolean {
  const timing = lateArrivalTiming(rows, turn, id)
  return !!timing && timing.readyDelayMs > LATE_TAP_READY_MS
}

function tooLateToTap(rows: readonly TickRow[], turn: number, id: string, taps: readonly TapRecord[]): boolean {
  if (taps.some((t) => t.turn === turn && t.id === id && !t.result.startsWith("skipped: page showed"))) return false
  const timing = lateArrivalTiming(rows, turn, id)
  if (!timing || timing.readyDelayMs > LATE_TAP_READY_MS) return false
  const refusals = taps.filter((t) => t.turn === turn && t.result.startsWith("skipped: page showed")).map((t) => Date.parse(t.at))
  // A bound before the first real opportunity says nothing about how long the
  // bot had to act; the earliest bound at or after that ready snapshot does.
  const { arrival, openedAt } = timing
  const bounds = [...refusals, endingSeenAt(rows, arrival, turn)].filter((bound) => bound >= openedAt)
  const closedAt = Math.min(...bounds)
  const window = closedAt - openedAt
  return Number.isFinite(window) && window >= 0 && window - stalledWithin(rows, openedAt, closedAt) < TAP_REACTION_MS
}

/** How long, inside [from, to], the page sat on a recorder read that took longer than one tick to answer: the page
 *  was not answering then, so the bot's tap loop, which reads the same page, could not act either (game 287, bot 26:
 *  a read that started 0.27 s before the votable stages closed answered 1.45 s later, in the ending). */
function stalledWithin(rows: readonly TickRow[], from: number, to: number): number {
  let stalled = 0
  for (const row of rows) {
    if (isRoleActionAnnotation(row) || !reconciledRow(row)) continue
    const started = parsedTime(row.readStartedAt)!
    const snapshot = parsedTime(row.snapshotAt)!
    if (snapshot - started <= RECORDER_TICK_MS) continue
    stalled += Math.max(0, Math.min(snapshot, to) - Math.max(started, from))
  }
  return stalled
}

/** The snapshot time of the same page's first reconciled row showing this turn's ending: the votable stages had
 *  closed by then. An ending row before the tile's last votable-stage read is a reversal and bounds nothing there
 *  (tooLateToTap drops bounds before that read). Infinity when the page never showed the ending. */
function endingSeenAt(rows: readonly TickRow[], arrival: TickRow, turn: number): number {
  const ending = rows.find(
    (row) =>
      !isRoleActionAnnotation(row) &&
      reconciledRow(row) &&
      row.pageGeneration === arrival.pageGeneration &&
      row.documentIdentity === arrival.documentIdentity &&
      row.sessionTurn === turn &&
      row.sessionStage === "ending",
  )
  return ending ? parsedTime(ending.snapshotAt)! : Number.POSITIVE_INFINITY
}

/** The (turn, tile) pairs the bot clicked AFTER the last frame of that turn's timeline: the frame is older than the
 *  click, so what it shows says nothing about it (game 194: the recorder's awaited screenshots stretch its 250 ms
 *  tick to 2-3 s, the storm's last settling taps landed 20 ms after the final frame and the turn sealed 2 s later).
 *  Keys are `${turn}:${id}`. A click that failed is no tap. */
export function lateTaps(rows: readonly TickRow[], taps: readonly TapRecord[]): Set<string> {
  const ends = turnEnds(rows)
  const late = new Set<string>()
  for (const tap of taps) {
    if (tap.result !== "ok" || tap.turn === null) continue
    const end = ends.get(tap.turn)
    if (end?.t && Date.parse(tap.at) > Date.parse(end.t)) late.add(`${tap.turn}:${tap.id}`)
  }
  return late
}

/** Shortest span of gameplay reads that can show a tile on No signal for the whole turn: the stage is HOST_ACTIVE_MINIMUM
 *  long and the recorder ticks every 250 ms, so reads across half of it leave no room for a legal opportunity to hide. */
const NO_SIGNAL_MIN_SPAN_MS = (HOST_ACTIVE_MINIMUM * 1000) / 2

/** A co-player the page showed present in this turn (a Co-player tile, never the host or an empty chair) whose tile took
 *  no gesture in any gameplay read of it, the reads spanning the stage. A seat showing only static (No signal, Can't
 *  connect) is exactly that: seatTakesTap closes the gesture, never the vote. The tile reads Co-player, so the app counts
 *  the co-player as seen and its seal files the untapped turn NotPerson (#574); the oracle counts it so
 *  (no-opportunity). The oracle cannot read the seat's label, only that the tile never became votable, so every hit is
 *  also reported (TurnVerdict table `noSignal`) for the gather RESULT. */
function noSignalAllTurn(rows: readonly TickRow[], turn: number, id: string): boolean {
  const reads = rows.filter((row) => authoritativeRow(row) && row.sessionTurn === turn && row.sessionStage === "gameplay" && !row.ducked)
  if (reads.length < 2) return false
  const tiles = reads.map((row) => tileOf(row, id))
  if (!tiles.every((tile) => !!tile && tileRole(tile) === "coplayer" && !tileVotable(tile) && !tileTapReady(tile) && !isApproved(tile))) return false
  const at = reads.map((row) => parsedTime(row.snapshotAt)!)
  return Math.max(...at) - Math.min(...at) >= NO_SIGNAL_MIN_SPAN_MS
}

/** A co-player this turn's last row still showed Unseen, whose first frame may have decoded after that row and before
 *  the turn ended: the same page's next row that can tell (a Host tile hides it, so those are skipped) already reads
 *  Co-player, and the bot made no tap on it in this turn. The app binds a frame to the turn it decoded in, the ending
 *  included (#602), and seals that turn NotPerson for a co-player seen but untapped, so the turn is either no
 *  opportunity (NotPerson) or not this co-player's at all (Unseen): the timeline cannot say which. Game 323, bot 6: the
 *  last row of turn 4 was a read stalled 888 ms that snapshotted Unseen 46 ms before the app sealed the turn with the
 *  co-player in it; the next row was turn 5's intro, where the co-player hosts. checkChainVotes holds such a verdict
 *  open (unseenTail), never Person, never NotPerson. A gap in the page (another page, a row the recorder could not
 *  read, a row without the tile) proves nothing, so it is never a tail. */
function unseenTail(rows: readonly TickRow[], end: TickRow, turn: number, id: string, taps: readonly TapRecord[]): boolean {
  if (taps.some((t) => t.turn === turn && t.id === id && t.result === "ok")) return false
  const at = rows.indexOf(end)
  if (at < 0 || !authoritativeRow(end)) return false
  for (const row of rows.slice(at + 1)) {
    if (isRoleActionAnnotation(row)) continue
    if (!authoritativeRow(row) || row.pageGeneration !== end.pageGeneration || row.documentIdentity !== end.documentIdentity) return false
    const tile = tileOf(row, id)
    if (!tile) return false
    const role = tileRole(tile)
    if (role === "host") continue
    return role === "coplayer"
  }
  return false
}

/** The longest the recorder may have gone dark between a hosted turn's last row and the row that reads the host's
 *  tile Co-player (hostedFirstFrame). The frame has to have decoded before the turn sealed, which is about one tick
 *  past that last row; a longer hole leaves room for it to have arrived after the seal, where the app files a seat it
 *  can no longer vote NotPerson, so the timeline then proves nothing. */
const HOSTED_ARRIVAL_MAX_GAP_MS = 1500

/** A co-player that hosted this turn, whose first decoded frame may have landed inside it. A Host tile hides whether
 *  its video plays, so the timeline reads the host as Unseen up to the turn and as Host through it, but the app binds
 *  a frame to the turn it decoded in (#602): seen in a shared open turn, never votable afterwards (a host takes no
 *  vote, the next round regroups), it files the default Person, where a never-seen co-player is NotPerson (#445).
 *  The same page's row before the turn that can tell (host rows skipped) reads Unseen, and its next row that can
 *  tell, within HOSTED_ARRIVAL_MAX_GAP_MS of the turn's last row, reads Co-player. On the bot's first played turn the
 *  page never showed the player before (only waiting-room rows, which carry no tiles precede it), and that absence
 *  stands in for the Unseen row ("absent-before"). Game 327, bot 27: 5EFNJJ8n read
 *  Unseen through turn 5, Host through turn 6 (its first frame decoded 1 s before the seal) and Co-player at the
 *  round change. checkChainVotes holds the verdict open when this reading is the only thing that explains it
 *  (hostedFirstFrame), never Person, never NotPerson. A gap in the page (another page, a row the recorder could not
 *  read, a row without the tile) proves nothing, so it is never an arrival. */
function hostedFirstFrame(rows: readonly TickRow[], end: TickRow, id: string): false | "unseen-before" | "absent-before" {
  const at = rows.indexOf(end)
  const endTile = tileOf(end, id)
  if (at < 0 || !authoritativeRow(end) || !endTile || tileRole(endTile) !== "host") return false
  const samePage = (row: TickRow) => sameDocument(row, end)
  // the tell: the nearest row on this page, in the direction given, that does not read Host
  const tell = (candidates: Iterable<TickRow>): { row: TickRow; role: TileRow["role"] } | null => {
    for (const row of candidates) {
      if (isRoleActionAnnotation(row)) continue
      if (!authoritativeRow(row) || !samePage(row)) return null
      const tile = tileOf(row, id)
      if (!tile) return null
      const role = tileRole(tile)
      if (role !== "host") return { row, role }
    }
    return null
  }
  const before = tell(rows.slice(0, at).reverse())
  const after = tell(rows.slice(at + 1))
  // Absent before is proof only for the bot's first played turn: every earlier row is a waiting-room row of this
  // page (which carries no tiles) or a Host row of this very turn. A play row without the tile, or an error row, is a
  // recording gap and proves nothing.
  const absentBefore =
    !before &&
    rows.slice(0, at).every((row) => {
      if (isRoleActionAnnotation(row)) return true
      if (row.error) return false
      const tile = tileOf(row, id)
      if (tile) return tileRole(tile) === "host" && row.sessionTurn === end.sessionTurn
      return row.stage === "waiting" ? sameDocument(row, end) : row.stage === undefined && !row.tiles?.length
    })
  if ((before?.role !== "unseen" && !absentBefore) || after?.role !== "coplayer") return false
  const gap = parsedTime(after.row.readStartedAt)! - parsedTime(end.snapshotAt)!
  if (!Number.isFinite(gap) || gap > HOSTED_ARRIVAL_MAX_GAP_MS) return false
  return before ? "unseen-before" : "absent-before"
}

/** One bot's turns: turn → co-player → approved / missed / not-votable, read
 *  off each turn's end frame. Co-players are every non-ghost tile but `self`.
 *  Not votable: the co-player hosts the turn, or is not on the grid.
 *  `late` (lateTaps): a tile the frame shows undecided but the bot tapped after that frame is "late" (unobserved), not
 *  "missed"; for the game's last turn the confirm stage that follows reads it.
 *  `taps` (the bot's tap log): a tile that first decoded inside the bot's reaction window before the turn left its
 *  votable stages is "no-opportunity", never "missed" or "unknown" (tooLateToTap).
 *  `late-tap-ready`: the product exposed a votable tile but took too long to make it actionable; this remains red.
 *  `unseenTail`: the Unseen co-players whose first frame may have decoded after the turn's last row (unseenTail).
 *  `hostedFirstFrame`: the hosts of this turn whose first frame may have decoded inside it (hostedFirstFrame);
 *  `hostedAbsentBefore` is the subset the page had not shown at all before the turn. */
export function verdictTable(
  rows: readonly TickRow[],
  self: string,
  late: ReadonlySet<string> = new Set(),
  taps: readonly TapRecord[] = [],
): {
  coPlayers: string[]
  turns: { turn: number; roles: Record<string, TileRow["role"]>; verdicts: Record<string, TurnVerdict>; noSignal: string[]; unseenTail: string[]; hostedFirstFrame: string[]; hostedAbsentBefore: string[] }[]
} {
  const coPlayers: string[] = []
  for (const r of rows) for (const t of r.tiles ?? []) if (t.id !== self && !isGhost(t.id) && !coPlayers.includes(t.id)) coPlayers.push(t.id)
  const ends = turnEnds(rows)
  const lastTurn = Math.max(0, ...ends.keys())
  const turns = [...ends]
    .sort(([a], [b]) => a - b)
    .map(([turn, row]) => {
      const verdicts: Record<string, TurnVerdict> = {}
      const roles: Record<string, TileRow["role"]> = {}
      const noSignal: string[] = []
      const tail: string[] = []
      const hosted: string[] = []
      const hostedAbsent: string[] = []
      for (const id of coPlayers) {
        const tile = row.tiles?.find((t) => t.id === id)
        const role = tile ? tileRole(tile) : undefined
        roles[id] = role
        const hostedKind = role === "host" ? hostedFirstFrame(rows, row, id) : false
        if (hostedKind) {
          hosted.push(id)
          if (hostedKind === "absent-before") hostedAbsent.push(id)
        }
        let v: TurnVerdict
        if (role === "unseen") {
          v = "unseen"
          if (unseenTail(rows, row, turn, id, taps)) tail.push(id)
        }
        // A Co-player whose first frame decoded in the ending is sealed NotPerson whether or not its tile ever took a
        // gesture: the seal reads the seen bit, the gesture also waits for the seat to show a live feed (game 280,
        // bot 16: the tile read Co-player, not votable, 0.4 s before the seal, and the turn sealed NotPerson).
        else if (noSignalAllTurn(rows, turn, id)) {
          v = "no-opportunity"
          noSignal.push(id)
        } else if (!tile || !tileVotable(tile))
          v = role === "coplayer" && noOpportunityProof(rows, row, turn, id, taps) ? "no-opportunity" : "not-votable"
        else if (isApproved(tile)) v = "approved"
        else if (observedOpportunity(rows, turn, id))
          v = lateTapReady(rows, turn, id) ? "late-tap-ready" : tooLateToTap(rows, turn, id, taps) ? "no-opportunity" : "missed"
        else if (noOpportunityProof(rows, row, turn, id, taps) || votableOnlyAfterCutoff(rows, turn, id, taps)) v = "no-opportunity"
        else v = "unknown"
        if ((v === "missed" || v === "unknown") && late.has(`${turn}:${id}`)) {
          const after = turn === lastTurn ? rows.find((r) => r.stage === "confirm" && (r.t ?? "") > (row.t ?? ""))?.tiles?.find((t) => t.id === id) : undefined
          v = after && tileVotable(after) && isApproved(after) ? "approved" : "late"
        }
        verdicts[id] = v
      }
      return { turn, roles, verdicts, noSignal, unseenTail: tail, hostedFirstFrame: hosted, hostedAbsentBefore: hostedAbsent }
    })
  return { coPlayers, turns }
}

/** Every red missed/product-readiness (turn, co-player) pair. */
export const misses = (table: ReturnType<typeof verdictTable>) =>
  table.turns.flatMap(({ turn, verdicts }) => Object.entries(verdicts).flatMap(([id, v]) => (v === "missed" || v === "late-tap-ready" ? [{ turn, id }] : [])))

/** Every (turn, co-player) pair the end frame could not show (the bot's tap came after it). */
export const unobserved = (table: ReturnType<typeof verdictTable>) =>
  table.turns.flatMap(({ turn, verdicts }) => Object.entries(verdicts).flatMap(([id, v]) => (v === "late" ? [{ turn, id }] : [])))

/** "turn 3: 5HDGmVGv; turn 12: 5G5ADeF3, 5GeMcLaW": the pairs by turn, for a check's detail. */
export function describeMisses(pairs: readonly { turn: number; id: string }[]): string {
  const by = new Map<number, string[]>()
  for (const { turn, id } of pairs) by.set(turn, [...(by.get(turn) ?? []), id.slice(0, 8)])
  return [...by].sort(([a], [b]) => a - b).map(([turn, ids]) => `turn ${turn}: ${ids.join(", ")}`).join("; ")
}

/** Markdown: a row per turn, a column per co-player. */
export function verdictMarkdown(table: ReturnType<typeof verdictTable>, names: Record<string, string> = {}): string {
  const name = (id: string) => names[id] ?? id.slice(0, 8)
  const head = `| turn | ${table.coPlayers.map(name).join(" | ")} |`
  const sep = `|---|${table.coPlayers.map(() => "---").join("|")}|`
  const body = table.turns.map(({ turn, verdicts }) => `| ${turn} | ${table.coPlayers.map((id) => verdicts[id]).join(" | ")} |`)
  return [head, sep, ...body].join("\n")
}

/** The tap-storm role's intent, from its own tile timeline: every votable co-player ended approved. A frame that cannot
 *  show a tile (the bot tapped it after the frame) is settled by the app's own trail of the filed report (the app's
 *  per-co-player count of NotPerson turns), or left unchecked when there is none. The chain-report guard cannot
 *  catch a NotPerson the storm landed (the trail and the chain agree on it), so this is where it is asserted. */
export function stormVerdict(
  missed: readonly { turn: number; id: string }[],
  unobservedPairs: readonly { turn: number; id: string }[],
  trail: Pick<VoteTrail, "reports"> | undefined,
): { status: "pass" | "fail" | "unchecked"; detail: string } {
  if (missed.length > 0) return { status: "fail", detail: `${missed.length} co-player tile(s) ended undecided or rejected after the storm: ${describeMisses(missed)}` }
  if (unobservedPairs.length === 0) return { status: "pass", detail: "no turn ended unapproved on the bot's own timeline" }
  const what = `${unobservedPairs.length} tile(s) tapped after their turn's last frame (${describeMisses(unobservedPairs)})`
  const last = trail?.reports.at(-1)
  if (!last) return { status: "unchecked", detail: `${what}: no devLog trail to read them from` }
  const ids = new Set(unobservedPairs.map((p) => p.id))
  const bad = Object.entries(last.players).filter(([id, v]) => ids.has(id) && ((v.notPersonTurns ?? 0) > 0 || (v.autoTurns ?? 0) > 0))
  if (bad.length > 0) return { status: "fail", detail: `${what}: the app counted NotPerson turns for ${bad.map(([id, v]) => `${id.slice(0, 8)} (${v.notPersonTurns ?? 0}N, ${v.autoTurns ?? 0} auto)`).join(", ")}` }
  return { status: "pass", detail: `${what}: the app's own trail counted no NotPerson turn for them` }
}

/** The bot's own tile when its account is not known (the demo game): the one
 *  non-ghost tile that is never votable in any play frame. */
export function inferSelf(rows: readonly TickRow[]): string | null {
  const seen = new Set<string>()
  const votable = new Set<string>()
  for (const r of rows)
    if (r.stage === "play")
      for (const t of r.tiles ?? []) {
        if (isGhost(t.id)) continue
        seen.add(t.id)
        if (tileVotable(t)) votable.add(t.id)
      }
  const never = [...seen].filter((id) => !votable.has(id))
  return never.length === 1 ? never[0] : null
}
