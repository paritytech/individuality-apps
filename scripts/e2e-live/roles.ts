// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// WHAT A BOT DOES IN THE GAME: the role of its profile (profiles.json
// `role: { kind, params }`), as pure plans the journey and boot.mts execute
// (vitest pins them in roles.test.ts). Playwright-free.
//
//   baseline        register once, approve every tile, let the app file the
//                   report. With `changeVerdictThenConfirm`: in the confirm
//                   stage flip one tile's verdict and flip it back, then TAP
//                   the CTA while it reads "Confirming in N" (#285), so the
//                   report is filed by a tap, never by the auto-confirm
//   late-join       register, then LEAVE the app before the handover (T-64)
//                   and come back `joinAfterTurn` turns into the game: the
//                   app's home (lib/late-join.ts) must route a registered
//                   latecomer into /game, at any turn (#699)
//   video-return    the same late return, with outbound video suppressed before
//                   `enableAtTurn`; an optional `disableAtTurn` removes it again
//   kill-relaunch   crash the page in round `killInRound` (CDP Page.crash: no
//                   pagehide, so the last-session record shows a foreground kill) and
//                   reopen the app on the same host slot; optionally hide the
//                   page from backgroundFromGameEndS to backgroundUntilGameEndS
//                   seconds after the page first shows the confirm stage (the
//                   game's end as the page sees it), so the app files the
//                   report on its own while hidden (backgroundStep)
//   background      only the hide window
//   tap-storm       a voter that flip-flops: on ONE tile a turn (the last it taps, after the others), `flips` pairs of
//                   rapid taps (a tile ignores the finger mid-flip, so some are swallowed), then the bot reads the tile
//                   and taps until it is approved. The chain report must still equal the final trail
//   host-crash      kill the slot's truapi-host process in round `crashInRound` and start it again on the same ports and
//                   session `downS` seconds later (boot.mts does both: it alone holds the host's spawn env), the page
//                   staying open. The app is expected to reconnect, sign, and file the report
//   seat-preparing  plays like the baseline, as a FRESH unbound lite person (profiles.json `freshIdentity`, fresh-pool.ts):
//                   the app's background bind has not finished when the Register tap lands, so the sign-up goes through the
//                   "preparing your seat" path and must still land. Despite its check-* name it IS a game player
//   reload          a plain page RELOAD at game turn `reloadAtTurn`: the same context, so sessionStorage (the store
//                   clock's saved expiry floor, lib/store-clock.ts) survives. Not a kill, not a new browser
//   hidden-step     background the page at game turn `hideAtTurn`, step its clock by `stepS` while it is hidden,
//                   show it again at turn `showAtTurn` (lib/device-clock.ts: a backward move across a hidden page is
//                   never kept, and the game clock never moves back: lib/clock-sync.ts)
//   freeze          the page's JS stops for `freezeS` seconds at game turn `freezeAtTurn` while it stays VISIBLE, with
//                   no visibility event (CDP Debugger.pause: timers stop; the iOS WebView case of #333's review).
//                   `monotonicStops` (default true) also holds performance.now() across it, as the phone's does
//
// CHECK roles never enter the sign-up, whatever their check says: a failed
// check must not fall through into a Register tap.
import type { Profile } from "./profile"
import { wallMsFor } from "./decide"
import { HOST_FULL_CYCLE } from "../../packages/jollity-game-chain/src/game/constants"
import { gameDuration, roundStart } from "../../packages/jollity-game-chain/src/game/stateMachine"

/** One turn of the game (intro + play + ending), the pallet's HOST_FULL_CYCLE. */
export const TURN_S = 12

export type RolePlan = { label?: string } & (
  | { kind: "baseline"; changeVerdictThenConfirm: boolean }
  | { kind: "late-join"; joinAfterTurn: number }
  | { kind: "video-return"; joinAfterTurn: number; enableAtTurn: number | null; disableAtTurn: number | null }
  | { kind: "kill-relaunch"; killInRound: number; background: BackgroundWindow | null }
  | { kind: "background"; background: BackgroundWindow }
  | { kind: "seat-preparing" }
  | { kind: "tap-storm"; flips: number }
  | { kind: "host-crash"; crashInRound: number; downS: number }
  | { kind: "reload"; reloadAtTurn: number }
  | { kind: "hidden-step"; hideAtTurn: number; showAtTurn: number; stepS: number }
  | { kind: "freeze"; freezeAtTurn: number; freezeS: number; holdMonotonic: boolean }
)

/** Stable evidence label; a data-only check may label baseline execution without inventing an executable role kind. */
export const roleName = (role: RolePlan): string => role.label ?? role.kind

/** seconds after the game's start (game_date) */
export interface BackgroundWindow {
  fromS: number
  untilS: number
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)

/** null (the reserved "baseline") plays plainly: no role behaviour at all. Role BEHAVIOUR is opt-in
 *  (`enabled`, E2E_ROLES=1 / the workflow's `roles` input): the game roles are unproven against a live game, so
 *  by default every game bot plays plain baseline and the profile gives only its device and network. The two
 *  check roles are not games and are never gated. */
export function rolePlan(profile: Profile | null, enabled = false): RolePlan {
  if (!profile) return { kind: "baseline", changeVerdictThenConfirm: false }
  const label = profile.role.label ? { label: profile.role.label } : {}
  if (!enabled && profile.role.kind !== "seat-preparing") return { ...label, kind: "baseline", changeVerdictThenConfirm: false }
  const p = profile.role.params
  const window = (): BackgroundWindow | null => {
    const fromS = num(p.backgroundFromGameEndS)
    const untilS = num(p.backgroundUntilGameEndS)
    return fromS !== undefined && untilS !== undefined ? { fromS, untilS } : null
  }
  switch (profile.role.kind) {
    case "baseline":
      return { ...label, kind: "baseline", changeVerdictThenConfirm: p.changeVerdictThenConfirm === true }
    case "late-join":
      return { ...label, kind: "late-join", joinAfterTurn: num(p.joinAfterTurn) as number }
    case "video-return":
      return { ...label, kind: "video-return", joinAfterTurn: num(p.joinAfterTurn) as number, enableAtTurn: num(p.enableAtTurn) ?? null, disableAtTurn: num(p.disableAtTurn) ?? null }
    case "kill-relaunch":
      return { ...label, kind: "kill-relaunch", killInRound: num(p.killInRound) as number, background: window() }
    case "background":
      return { ...label, kind: "background", background: window() as BackgroundWindow }
    case "seat-preparing":
      return { ...label, kind: "seat-preparing" }
    case "tap-storm":
      return { ...label, kind: "tap-storm", flips: num(p.flips) as number }
    case "host-crash":
      return { ...label, kind: "host-crash", crashInRound: num(p.crashInRound) as number, downS: num(p.downS) ?? 8 }
    case "reload":
      return { ...label, kind: "reload", reloadAtTurn: num(p.reloadAtTurn) as number }
    case "hidden-step":
      return { ...label, kind: "hidden-step", hideAtTurn: num(p.hideAtTurn) as number, showAtTurn: num(p.showAtTurn) as number, stepS: num(p.stepS) as number }
    case "freeze":
      return { ...label, kind: "freeze", freezeAtTurn: num(p.freezeAtTurn) as number, freezeS: num(p.freezeS) as number, holdMonotonic: p.monotonicStops !== false }
  }
}

/** The chain second a late joiner returns at: `joinAfterTurn` full turns into the game. */
export const lateJoinAt = (gameAt: number, joinAfterTurn: number): number => gameAt + joinAfterTurn * TURN_S

/** The background window on the chain clock, seconds after the LAST TURN ENDS (`gameEnd`): only roleFeasibility uses it,
 *  to say before the game whether the window fits before report_ends. The act itself runs off the page (backgroundStep).
 *  (It was read as seconds after game_date, 158-180 s, which is after the 144 s game and its auto-confirm: the window
 *  never opened in game 186.) */
export const backgroundAt = (gameEnd: number, w: BackgroundWindow): { from: number; until: number } => ({ from: gameEnd + w.fromS, until: gameEnd + w.untilS })

/** The game's schedule, from the app's own pure state machine (@jollity/game-chain/game): a game_date-relative second */
const timing = (g: { rounds: number; maxGroupSize: number }) => ({ gameDate: 0, reportEnds: 0, rounds: g.rounds, maxGroupSize: g.maxGroupSize })

/** Seconds from game_date to the start of game turn `turn` (1-based): one turn (12 s) per seat, and the ROUND_GAP (7 s)
 *  before every round after the first. Game 199's hidden-step fell back early by leaving the gap out. */
export const turnStartS = (g: { rounds: number; maxGroupSize: number }, turn: number): number => {
  const k = Math.max(0, turn - 1)
  const seats = Math.max(1, g.maxGroupSize)
  return roundStart(timing(g), Math.floor(k / seats)) + (k % seats) * HOST_FULL_CYCLE
}

/** When the last turn ends: game_date + one turn (12 s) per seat per round, plus the gaps between rounds. */
export const gameEndAt = (g: { gameAt: number; rounds: number; maxGroupSize: number }): number => g.gameAt + gameDuration(timing(g))

/** The turn WITHIN its round the kill waits for: past the first, so the bot has played and is mid-round. */
export const KILL_AFTER_TURN = 2

/** The pill reads "Turn n of N" counting the WHOLE game (1..12 for two rounds of six seats), never per round
 *  (game 186's timeline: turns 1-12, round index 0 throughout), so the round comes from n, N and the round count. */
export function roundOf(turn: number, turnsInGame: number, rounds: number): { round: number; turnInRound: number } {
  const per = Math.max(1, Math.round(turnsInGame / Math.max(1, rounds)))
  return { round: Math.min(rounds - 1, Math.floor((turn - 1) / per)), turnInRound: ((turn - 1) % per) + 1 }
}

/** Kill once, in round `killInRound` (1-based), at KILL_AFTER_TURN of that round or later, while the grid is live. */
export function shouldKill(role: RolePlan, at: { turn: number | null; turnsInGame: number | null; rounds: number; stage: string }, alreadyKilled: boolean): boolean {
  if (role.kind !== "kill-relaunch" && role.kind !== "host-crash") return false
  if (alreadyKilled || at.turn === null || at.turnsInGame === null) return false
  const inRound = role.kind === "kill-relaunch" ? role.killInRound : role.crashInRound
  const { round, turnInRound } = roundOf(at.turn, at.turnsInGame, at.rounds)
  return round === inRound - 1 && turnInRound >= KILL_AFTER_TURN && (at.stage === "play" || at.stage === "intro")
}

/** THE BACKGROUND ACT, driven by what the PAGE shows, never by a chain-clock estimate. Game 190: the window was placed on
 *  the chain clock (gameEnd + fromS .. + untilS) from one Timestamp.Now read at the start of (c), and a finalized
 *  timestamp lags the wall by tens of seconds, so the window opened after the bot had tapped Confirm itself and left the
 *  play loop on /prize-draw: "hidden" and "visible" never happened. Now the window's clock starts when the page FIRST
 *  shows the confirm stage (the page's own end of the last turn): `fromS` after it the page is hidden, and it stays
 *  hidden `untilS - fromS` seconds. */
export interface BackgroundState {
  /** wall ms the confirm stage was first seen; null = not yet */
  confirmAtMs: number | null
  /** wall ms the page was hidden; null = not yet */
  hiddenAtMs: number | null
  /** the page was shown again: the act is over */
  shown: boolean
}
export const BACKGROUND_IDLE: BackgroundState = { confirmAtMs: null, hiddenAtMs: null, shown: false }

/** What the background act asks of this moment: hide, show or leave alone. */
export function backgroundStep(w: BackgroundWindow | null, s: BackgroundState, nowMs: number): "hide" | "show" | null {
  if (!w || s.shown || s.confirmAtMs === null) return null
  if (s.hiddenAtMs === null) return nowMs >= s.confirmAtMs + w.fromS * 1000 ? "hide" : null
  return nowMs >= s.hiddenAtMs + (w.untilS - w.fromS) * 1000 ? "show" : null
}

/** From the confirm stage until the page is shown again, the bot neither taps Confirm (the app must file the report on
 *  its own, across the hide) nor leaves the play loop on /prize-draw (the "visible" act is still due). */
export const backgroundPending = (w: BackgroundWindow | null, s: BackgroundState): boolean => !!w && s.confirmAtMs !== null && !s.shown


/** The app opens its hidden debug sheet on 5 taps in the TOP THIRD of the viewport within 1.5 s (components/debug/use-debug-sheet.ts),
 *  and the sheet covers the game. A storm of rapid taps on a top-row tile would summon it and end the bot's game (seen on the demo:
 *  turn 4 on, every tile "missed"), so a tap up there is paced so that no 1.5 s window holds 5 of them. Elsewhere the storm is fast. */
export const STORM_FAST_GAP_MS = 40
export const STORM_TOP_GAP_MS = 400
export const stormGapMs = (centerY: number, viewportH: number): number => (centerY < viewportH / 3 ? STORM_TOP_GAP_MS : STORM_FAST_GAP_MS)

/** THE TAP-STORM, ONCE PER TURN. A tile ignores the finger while it turns (final-tile.tsx: "a running turn ignores the
 *  finger"), so a burst of 40 ms taps loses an arbitrary number of them and the pair-nets-zero parity the storm assumed
 *  does not hold: game 192's bot 8 left 6 tile-turns rejected or undecided (the chain's per-game verdict is the MAJORITY
 *  of the turns' taps, so it still filed Person). The storm now hits ONE tile a turn, the LAST one the pass taps, after
 *  every other tile has had its plain tap, and the bot then settles that tile to approved by reading it. Returns the id
 *  to storm, once per turn (`stormed` holds the turns that had theirs), or null. */
export function stormTarget(tapIds: readonly string[], turn: number | null, flips: number, stormed: Set<number>): string | null {
  if (flips <= 0 || turn === null || tapIds.length === 0 || stormed.has(turn)) return null
  stormed.add(turn)
  return tapIds[tapIds.length - 1]
}

/** The confirm-tap role taps the CTA while it reads "Confirming in N" (#285). The countdown arms a beat after the
 *  confirm stage opens (the app arms it once every verdict is in), and the CTA reads "Confirm votes" until then: game
 *  192's bot 1 tapped that label 1.3 s in, the report was filed by a tap, and the act (recorded only on the countdown
 *  label) never was. So the bare label is left alone for this long after it first shows, then tapped so the report is
 *  still filed (the act then fails, naming what the page showed). */
export const CONFIRM_COUNTDOWN_GRACE_MS = 5000

/** What the loop does with the CTA it reads: tap it or wait. `firstSeenMs` is when the page first showed a confirm CTA. */
export function confirmTapStep(countdownRole: boolean, label: string, firstSeenMs: number, nowMs: number): "tap" | "wait" {
  if (/tap to retry/.test(label)) return "tap"
  if (/Confirm votes/.test(label)) return !countdownRole || nowMs - firstSeenMs >= CONFIRM_COUNTDOWN_GRACE_MS ? "tap" : "wait"
  if (countdownRole && /Confirming in/.test(label)) return "tap"
  return "wait"
}

// ── reload, hidden-step, freeze: acts keyed on the game turn the page shows ─────
/** A once-only act at game turn `atTurn` or later, while the grid is live (a turn's intro or play: never the confirm
 *  stage, which reads no turn). `stages` narrows it (the freeze waits for a play stage, mid-turn). */
export function dueAtTurn(at: { turn: number | null; stage: string }, atTurn: number, done: boolean, stages: readonly string[] = ["intro", "play"]): boolean {
  return !done && at.turn !== null && at.turn >= atTurn && stages.includes(at.stage)
}

/** The step lands this long after the page is hidden, so the app has read its clocks with the page hidden first. */
export const STEP_AFTER_HIDE_MS = 3000
/** The show waits for the page's own turn `showAtTurn`; if the page never shows it (the app's clock is wrong, which is
 *  what the role probes), it is shown anyway this long after that turn starts on the chain (hiddenShowDueMs). One turn:
 *  the page's chain time ran ~7.4 s behind the runner's wall in game 199 while the runner's mapping may lag less, and a
 *  hidden page's timers tick at 1 Hz. A clock really broken by the -60 s step reads ~5 turns behind, so none is lost. */
export const SHOW_GRACE_MS = 12_000

export interface HiddenStepState {
  /** wall ms the page was hidden; null = not yet */
  hiddenAtMs: number | null
  stepped: boolean
  shown: boolean
  /** wall ms the fallback show is due (hiddenShowDueMs, set at the hide); absent = the turns' bare length from the hide */
  showDueMs?: number
}
export const HIDDEN_STEP_IDLE: HiddenStepState = { hiddenAtMs: null, stepped: false, shown: false }

/** When the hidden page is shown on the FALLBACK: SHOW_GRACE_MS after showAtTurn starts on the chain (turnStartS, the
 *  round gap included), mapped to the runner's wall through `clock`. With no chain game (the demo: gameAt 0, or no
 *  clock), the same schedule counted from the hide. */
export function hiddenShowDueMs(r: { hideAtTurn: number; showAtTurn: number }, g: { gameAt: number; rounds: number; maxGroupSize: number }, hiddenAtMs: number, clock: { chainNowS: number; wallNowMs: number } | null): number {
  if (g.gameAt > 0 && clock) return wallMsFor(g.gameAt + turnStartS(g, r.showAtTurn), clock) + SHOW_GRACE_MS
  return hiddenAtMs + (turnStartS(g, r.showAtTurn) - turnStartS(g, r.hideAtTurn)) * 1000 + SHOW_GRACE_MS
}

/** What the hidden-step act asks of this moment. `turn` is what the page shows (it is read while hidden too). */
/** "show" = the page itself showed showAtTurn; "show-late" = the fallback, the page never did (a live game fails on it). */
export function hiddenStepStep(r: { hideAtTurn: number; showAtTurn: number }, s: HiddenStepState, at: { turn: number | null; stage: string }, nowMs: number): "hide" | "step" | "show" | "show-late" | null {
  if (s.shown) return null
  if (s.hiddenAtMs === null) return dueAtTurn(at, r.hideAtTurn, false) ? "hide" : null
  if (!s.stepped) return nowMs >= s.hiddenAtMs + STEP_AFTER_HIDE_MS ? "step" : null
  const byPage = at.turn !== null && at.turn >= r.showAtTurn
  const byClock = nowMs >= (s.showDueMs ?? s.hiddenAtMs + (r.showAtTurn - r.hideAtTurn) * TURN_S * 1000 + SHOW_GRACE_MS)
  return byPage ? "show" : byClock ? "show-late" : null
}

/** After a visible freeze the page reads behind until the peer check that the step opens moves it forward (pings every
 *  2 s, an in-game gap over 5 s jumps: lib/clock-sync.ts), so 20 s of freeze and the peer check span 2 or 3 turns.
 *  The bot must play again within this many turns of the one it froze in. It is below the turns a freeze at turn 9 of 12
 *  leaves (4), so it can fail (roles.test.ts pins that). */
export const FREEZE_RESUME_TURNS = 3

/** The visible freeze's recovery, off the bot's own tile timeline: the first turn it played after the thaw (a play frame
 *  stamped after `window.to`; a frame read as it thaws is stamped inside the freeze and proves nothing) is within
 *  FREEZE_RESUME_TURNS of the freeze's turn, and it played the game's last turn. */
export function freezeRecovery(rows: readonly { turn?: number | null; stage?: string; t?: string }[], window: { from: string; to: string }, freezeTurn: number, totalTurns: number): { ok: boolean; detail: string } {
  const after = rows.filter((r) => r.stage === "play" && r.turn != null && (r.t ?? "") > window.to)
  const first = after[0]
  if (!first) return { ok: false, detail: `never played after the thaw (froze in turn ${freezeTurn})` }
  const lastPlayed = after.some((r) => r.turn === totalTurns)
  const inTime = (first.turn as number) <= freezeTurn + FREEZE_RESUME_TURNS
  const secs = Math.round((Date.parse(first.t ?? "") - Date.parse(window.to)) / 1000)
  const resumed = `played turn ${first.turn} again ${secs} s after the thaw (${inTime ? "within" : "MORE than"} ${FREEZE_RESUME_TURNS} of the freeze's turn ${freezeTurn})`
  return { ok: inTime && lastPlayed, detail: `${resumed}, and ${lastPlayed ? `the last turn ${totalTurns}` : `never played the last turn ${totalTurns}`}` }
}

/** The freeze took: the page's own timer went `maxGapMs` without a tick (it ticks every 200 ms), and, when held, its
 *  performance.now() was held back by about the freeze. */
export function freezeLanded(freezeS: number, maxGapMs: number, heldMs: number, holdMonotonic: boolean): string | null {
  if (maxGapMs < freezeS * 1000 - 1000) return `the page's timer ticked within ${Math.round(maxGapMs)} ms: its JS did not stop for ${freezeS} s`
  if (holdMonotonic && Math.abs(heldMs - freezeS * 1000) > 2000) return `performance.now() was held back ${heldMs} ms, not about ${freezeS * 1000}`
  return null
}

/** A turn the page showed AGAIN after showing a later one: the replayed turns of #331. Read off the tile timeline's
 *  play and intro frames, in order. A reload's blank frames (turn null) are skipped, never a reset. */
export function replayedTurns(rows: readonly { turn?: number | null; stage?: string; t?: string }[]): { from: number; to: number; at: string }[] {
  const out: { from: number; to: number; at: string }[] = []
  let high = 0
  for (const r of rows) {
    if (r.turn == null || (r.stage !== "play" && r.stage !== "intro")) continue
    if (r.turn < high) out.push({ from: high, to: r.turn, at: r.t ?? "?" })
    high = Math.max(high, r.turn)
  }
  return out
}

/** The expiry floor in the store clock's saved state (lib/store-clock.ts, sessionStorage "jollity.storeClock"); null =
 *  nothing saved, or not readable. */
export function savedFloorOf(raw: string | null): bigint | null {
  try {
    const f = raw ? (JSON.parse(raw) as { floor?: unknown }).floor : undefined
    return typeof f === "string" && /^\d+$/.test(f) ? BigInt(f) : null
  } catch {
    return null
  }
}

/** The store clock's saved state (lib/store-clock.ts, sessionStorage "jollity.storeClock") before and after the reload:
 *  it must be there before, and survive with a floor no lower. null = proven, else why not. */
export function savedFloorSurvived(before: string | null, after: string | null): string | null {
  const a = savedFloorOf(before)
  const b = savedFloorOf(after)
  if (a === null) return "no saved store clock before the reload (sessionStorage jollity.storeClock): the page had no accepted statement to save a floor from"
  if (b === null) return "the saved store clock was gone after the reload: sessionStorage did not survive"
  if (b < a) return `the saved floor went down across the reload (${a} -> ${b})`
  return null
}

/** THE WAITING-ROOM RESTART CARD (`host-stuck-waiting`): the text the card shows. */
export const STUCK_CARD_TEXT = "Restart the Polkadot app"

/** What to say about the card's state at the moment the host is killed.
 *
 *  This is the one fact that decides app-vs-harness for `host-stuck-waiting`, and
 *  nothing recorded it: three runs (40154978844, 40260175041, 40439359008) fail
 *  `page shows "Restart the Polkadot app"` while every exported devLog starts AFTER
 *  the 90 s hang lifted, so the only record that could hold the card - the pre-kill
 *  page's own - was gone, and the run could not say whether the app failed to raise
 *  the card or the harness lost the evidence of it. Sampling the page at the kill
 *  answers it either way.
 *
 *  `shown` is null when the page could not be read: a page that is gone is not a page
 *  that showed nothing.
 *
 *  The second argument is SECONDS ELAPSED since the hang began, and it is rounded here
 *  rather than at the call site: the first version took `killAtMs - Date.now()`, which is
 *  milliseconds REMAINING, and would have printed "82000 s into the hang". */
export function stuckCardAtKillNote(shown: boolean | null, secondsIntoHang: number): string {
  const card = `"${STUCK_CARD_TEXT}"`
  const at = `${Math.round(secondsIntoHang)} s into the hang`
  if (shown === null) return `host-stuck-waiting: the pre-kill page could not be read, so whether ${card} was shown at the kill is unknown`
  return shown
    ? `host-stuck-waiting: ${card} WAS on the page at the kill (${at}): the card appeared and the evidence was lost, not the app failing to show it`
    : `host-stuck-waiting: ${card} was NOT on the page at the kill: the app never raised it during the hang`
}
