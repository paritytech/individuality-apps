// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// A ROLE MUST PROVE IT ACTED. In games 185-187 bot 5's kill-relaunch never happened (the round index it waited for
// never came: the pill counts the whole game) and the job still said "success". Every role that is meant to act now
// records each action it performs, with a time, and at the end of stage (c) a role that was due and did not act FAILS
// the bot with the reason. Pure; vitest pins it (role-proof.test.ts).
import { SESSION_TICK_MS } from "../../apps/jollity-app/lib/game-clock"
import { pageFreezeThresholdMs } from "../../apps/jollity-app/lib/page-lifecycle"
import type { Check } from "./chain-checks"
import type { SlotResult } from "./result"
import { KILL_AFTER_TURN, gameEndAt, roleName, type RolePlan } from "./roles"

export type ActId =
  | "killed"
  | "relaunched"
  | "hidden"
  | "visible"
  | "left-app"
  | "rejoined"
  | "confirm-tap"
  | "confirm-tap-bare"
  | "storm-taps"
  | "clock-jump"
  | "host-killed"
  | "host-restarted"
  | "host-reconnected"
  | "reloading"
  | "reloaded"
  | "clock-step"
  | "frozen"
  | "thawed"
  | "clock-held"
  | "video-suppressed"
  | "video-enabled"
  | "video-disabled"
export interface RoleAction {
  id: ActId
  /** ISO time */
  at: string
  detail: string
}

/** What a role MUST have done by the end of the game, as action ids. */
export function dueActions(role: RolePlan): ActId[] {
  switch (role.kind) {
    case "kill-relaunch":
      return role.background ? ["killed", "relaunched", "hidden", "visible"] : ["killed", "relaunched"]
    case "background":
      return ["hidden", "visible"]
    case "late-join":
      return ["left-app", "rejoined"]
    case "video-return":
      return ["left-app", "rejoined", "video-suppressed", ...(role.enableAtTurn === null ? [] : ["video-enabled" as const]), ...(role.disableAtTurn === null ? [] : ["video-disabled" as const])]
    case "baseline":
      return role.changeVerdictThenConfirm ? ["confirm-tap"] : []
    case "tap-storm":
      return ["storm-taps"]
    case "host-crash":
      return ["host-killed", "host-restarted"]
    case "reload":
      return ["reloading", "reloaded"]
    case "hidden-step":
      return ["hidden", "clock-step", "visible"]
    case "freeze":
      return ["frozen", "thawed"]
    default:
      return []
  }
}

/** Is the role's trigger possible in THIS game's shape? An impossible one is a configuration error, said before the game plays. */
export function roleFeasibility(role: RolePlan, game: { gameAt: number; rounds: number; maxGroupSize: number; reportEnds: number }, jumpTurns: readonly number[] = []): string | null {
  const turns = game.rounds * game.maxGroupSize
  const late = jumpTurns.filter((t) => t > turns)
  if (late.length) return `a clock jump waits for turn ${late[0]} but the game has only ${turns} turn(s)`
  if (role.kind === "host-crash" && role.crashInRound > game.rounds) return `host-crash wants round ${role.crashInRound} but the game has ${game.rounds} round(s)`
  if (role.kind === "host-crash" && KILL_AFTER_TURN > game.maxGroupSize) return `host-crash waits for turn ${KILL_AFTER_TURN} of its round but a round has ${game.maxGroupSize} turn(s)`
  if (role.kind === "kill-relaunch") {
    if (role.killInRound > game.rounds) return `kill-relaunch wants round ${role.killInRound} but the game has ${game.rounds} round(s)`
    if (KILL_AFTER_TURN > game.maxGroupSize) return `kill-relaunch waits for turn ${KILL_AFTER_TURN} of its round but a round has ${game.maxGroupSize} turn(s)`
  }
  if (role.kind === "late-join" && role.joinAfterTurn >= turns) return `late-join returns after turn ${role.joinAfterTurn} but the game has only ${turns} turn(s)`
  if (role.kind === "video-return" && role.joinAfterTurn >= turns) return `video-return returns after turn ${role.joinAfterTurn} but the game has only ${turns} turn(s)`
  if (role.kind === "video-return" && role.enableAtTurn !== null && role.enableAtTurn <= role.joinAfterTurn) return `video-return enables at turn ${role.enableAtTurn}, not after its return at turn ${role.joinAfterTurn}`
  if (role.kind === "video-return" && role.disableAtTurn !== null && (role.enableAtTurn === null || role.disableAtTurn <= role.enableAtTurn)) return "video-return disableAtTurn must come after enableAtTurn"
  // the act must leave a turn after it, to show the session came back and played on
  if (role.kind === "reload" && role.reloadAtTurn >= turns) return `reload waits for turn ${role.reloadAtTurn} but the game has only ${turns} turn(s)`
  if (role.kind === "hidden-step" && role.showAtTurn > turns) return `hidden-step shows the page at turn ${role.showAtTurn} but the game has only ${turns} turn(s)`
  if (role.kind === "freeze" && role.freezeAtTurn >= turns) return `freeze waits for turn ${role.freezeAtTurn} but the game has only ${turns} turn(s)`
  const bg = role.kind === "kill-relaunch" || role.kind === "background" ? role.background : null
  if (bg) {
    const end = gameEndAt(game)
    if (end + bg.fromS >= game.reportEnds) return `the background window opens ${bg.fromS} s after the last turn (chain ${end + bg.fromS}) but reports end at ${game.reportEnds}`
  }
  return null
}

/** Checks, one per due action: pass with its time, or FAIL naming what never happened. */
/** `whyNot`: what the bot knows about an act that did not happen (the app's own reason), appended to its failure.
 *  `freeze`: a stall the app itself measured that explains a missing confirm-tap (confirmFreeze): the act is then
 *  INCONCLUSIVE, not a failure. Any other missing act still FAILS.
 *  `extraDue`: acts the PROFILE makes due besides its role's (clock-held: a clock that starts wrong is read back at the
 *  sign-up and in the waiting room, the "wrong through the sign-up" half of a corrected clock). */
export function verifyRoleActs(n: number, role: RolePlan, acts: readonly RoleAction[], net: { live: boolean; planned: number; fired: number }, clockJumps = 0, problems: readonly string[] = [], extraDue: readonly ActId[] = [], whyNot: Partial<Record<ActId, string>> = {}, freeze: ConfirmFreeze | null = null): Check[] {
  const label = roleName(role)
  const out: Check[] = problems.map((p) => ({ name: `player ${n} role ${label}: problem`, status: "fail" as const, detail: p }))
  if (clockJumps > 0) {
    const done = acts.filter((x) => x.id === "clock-jump")
    out.push({ name: `player ${n} clock jumps`, status: done.length >= clockJumps ? "pass" : "fail", detail: `${done.length} of ${clockJumps} jump(s) landed${done.length ? `: ${done.map((a) => a.detail).join("; ")}` : ": a jump's turn never came before the game ended"}` })
  }
  for (const id of [...dueActions(role), ...extraDue]) {
    const a = acts.filter((x) => x.id === id)
    const name = `player ${n} role ${label}: ${id}`
    const bare = id === "confirm-tap" ? acts.find((x) => x.id === "confirm-tap-bare") : undefined
    out.push(
      a.length
        ? { name, status: "pass", detail: `${a[0].at.slice(11, 19)} ${a[0].detail}` }
        : id === "confirm-tap" && bare
          ? // the bot DID confirm, on the bare CTA (roles.ts confirmTapStep, after the grace): the chain check stays the authority
            freeze
            ? { name, status: "inconclusive", detail: `${describeFreeze(freeze)}; the bot still tapped the bare CTA (${bare.detail}) at ${bare.at.slice(11, 19)} UTC` }
            : { name, status: "pass", detail: `NOTE: no tap during "Confirming in N" because the countdown never showed (no freeze measured); the bot tapped the bare CTA instead (${bare.detail}) at ${bare.at.slice(11, 19)} UTC${whyNot[id] ? `; ${whyNot[id]}` : ""}` }
          : id === "confirm-tap" && freeze
            ? { name, status: "inconclusive", detail: `${describeFreeze(freeze)}${whyNot[id] ? `; ${whyNot[id]}` : ""}` }
            : { name: `player ${n} role ${label}: ${id}`, status: "fail", detail: `the role was due to act (${id}) and never did: its trigger did not fire before the game ended${whyNot[id] ? `; ${whyNot[id]}` : ""}` },
    )
  }
  if (net.planned > 0 && net.live) out.push({ name: `player ${n} network timeline`, status: net.fired === net.planned ? "pass" : "fail", detail: `${net.fired} of ${net.planned} step(s) applied${net.fired < net.planned ? ": a step's trigger never came before the game ended" : ""}` })
  return out
}

export const actedLine = (a: RoleAction): string => `${a.at.slice(11, 19)} ${a.id}: ${a.detail}`

/** Cross-job acceptance for the bounded six-slot video-role proof. Missing or
 * ambiguous evidence is a failure: this gate exists so a green aggregate
 * report cannot stand in for the required viewer lifecycle. */
export function verifyVideoRoleProof(results: readonly SlotResult[]): Check {
  const viewer = results.find((r) => r.profile === "reload-mid-game")
  const flip = results.find((r) => r.profile === "video-role-late-flip")
  const never = results.find((r) => r.profile === "video-role-late-never")
  const fail = (detail: string): Check => ({ name: "video-role-proof cross-peer lifecycle", status: "fail", detail })
  if (!viewer?.videoRoleProof || !viewer.account || !flip?.account || !never?.account)
    return fail("missing reload viewer, delayed-flip, never-video, account, or viewer timeline evidence")
  const enabled = flip.role.actions.find((a) => a.id === "video-enabled")?.at
  const disabled = flip.role.actions.find((a) => a.id === "video-disabled")?.at
  const reloaded = viewer.role.actions.find((a) => a.id === "reloaded")?.at
  if (!enabled || !disabled || !reloaded) return fail("missing video-enabled, video-disabled, or viewer reloaded action")
  const enabledAt = Date.parse(enabled)
  const disabledAt = Date.parse(disabled)
  const reloadedAt = Date.parse(reloaded)
  if (![enabledAt, disabledAt, reloadedAt].every(Number.isFinite)) return fail("video lifecycle action timestamps were invalid")
  const proof = viewer.videoRoleProof
  const unseenTurn = proof.turns.find((turn) => {
    const at = Date.parse(turn.at)
    return Number.isFinite(at) && turn.roles[flip.account!] === "unseen" && at < enabledAt
  })
  if (!unseenTurn) return fail("viewer recorded no complete Unseen turn for delayed-flip before enable")
  const firstCoplayer = proof.markers.find((marker) => marker.id === flip.account && marker.role === "coplayer")
  const firstCoplayerAt = firstCoplayer ? Date.parse(firstCoplayer.at) : Number.NaN
  if (!firstCoplayer || !Number.isFinite(firstCoplayerAt) || firstCoplayerAt < enabledAt || firstCoplayerAt >= disabledAt)
    return fail("first Co-player marker was missing or outside video-enabled → video-disabled")
  if (disabledAt >= reloadedAt)
    return fail("delayed-flip video disable did not precede viewer reload")
  const flipRecap = proof.recap.find((tile) => tile.id === flip.account)
  const flipRecapAt = flipRecap ? Date.parse(flipRecap.at) : Number.NaN
  if (!flipRecap || !Number.isFinite(flipRecapAt) || flipRecapAt <= reloadedAt || flipRecap.role !== "coplayer" || !/Seen earlier/i.test(flipRecap.text))
    return fail("after reload the delayed-flip tile was not Co-player with Seen earlier")
  if (proof.recap.some((tile) => tile.id === never.account))
    return fail("viewer recap showed a confirm tile for the never-video player")
  const isDefault = (verdict: NonNullable<typeof proof.report>[string] | undefined) =>
    verdict?.verdict === "notperson" && verdict.source === "unseen" && verdict.unseenChoice === "default-notperson"
  if (!isDefault(proof.report?.[never.account]))
    return fail("viewer did not file the never-video player as the default NotPerson")
  // an empty recap proves nothing: the peer must have captured a confirm screen with other tiles on it
  const peer = results.find((result) => {
    const other = result.videoRoleProof
    return result !== viewer && !!other?.recap.length && other.recap.every((tile) => tile.id !== never.account) && isDefault(other.report?.[never.account!])
  })
  if (!peer) return fail("no peer recap showed the never-video player with no tile and the default NotPerson")
  return {
    name: "video-role-proof cross-peer lifecycle",
    status: "pass",
    detail: `Unseen turn ${unseenTurn.turn}; first Co-player ${firstCoplayer.at}; reload restored Seen earlier; the never-video player had no confirm tile and was filed the default NotPerson by the viewer and player ${peer.slot}`,
  }
}

/** A clock jump took when the offset read back from the page is the target within 2 s (a page that ignored the write reads its old offset). */
export const clockJumpLanded = (targetS: number, readBackS: number): boolean => Math.abs(readBackS - targetS) <= 2

/** A clock that starts wrong and is corrected mid-game (clockOffsetS != 0 and a clock jump): it must be read back wrong
 *  at the sign-up and again in the waiting room, or the "wrong through the sign-up" half never happened. */
export const clockHeldDue = (p: { clockOffsetS: number; clockJumps?: readonly unknown[] } | null): ActId[] => (p && p.clockOffsetS !== 0 && (p.clockJumps?.length ?? 0) > 0 ? ["clock-held"] : [])

/** What the bot knows about why the confirm-tap never saw the countdown: the app's own "auto-confirm off" line (a page
 *  that stalled 5+ s counts itself away for good, lib/game-session.ts markAway; games 196 and 197 on bot 1) and the
 *  bot's note that it had to tap the bare CTA. Said in the failure; the act still FAILS. */
export function whyNotActed(trail: { autoConfirmOff?: { ts: number; reason: string } } | null | undefined, roleNotes: readonly string[]): Partial<Record<ActId, string>> {
  const parts: string[] = []
  const off = trail?.autoConfirmOff
  if (off) parts.push(`the app logged auto-confirm off (${off.reason}) at ${new Date(off.ts).toISOString().slice(11, 19)} UTC, so no countdown could arm`)
  const bare = roleNotes.find((n) => /the countdown never showed/.test(n))
  if (bare) parts.push(bare)
  return parts.length ? { "confirm-tap": parts.join("; ") } : {}
}

// A BOT THAT FROZE IS NOT A BOT THAT FAILED (#341). The bot runners are overloaded: a main-thread stall past the app's
// own freeze line makes lib/game-session.ts markAway() switch auto-confirm off for the whole game, so "Confirming in N"
// never shows and the confirm-tap act cannot happen. Sentry reads the same stall as ui.long_task_ms, so the verdict is
// corrected by the SAME numbers: the app's long tasks, read through window.__jollityHarness.smoothness() (lib/telemetry/
// smoothness.ts), never a second observer of the harness's own.

/** One stall the app measured (lib/telemetry/smoothness.ts LongTaskRecord): its length and the epoch ms it ended. */
export interface LongTask {
  ms: number
  endedAt: number
}

/** A stall that explains why the confirm countdown never armed. */
export interface ConfirmFreeze {
  ms: number
  /** epoch ms it ended */
  endedAt: number
  /** the game turn the page showed when it began; null = no timeline to read it from */
  turn: number | null
}

/** The app's freeze line, taken from the app: lib/page-lifecycle.ts pageFreezeThresholdMs over lib/game-clock.ts
 *  SESSION_TICK_MS (the interval markAway's tick runs on). Not a copy: a retuned line moves this one. */
export const FREEZE_THRESHOLD_MS = pageFreezeThresholdMs(SESSION_TICK_MS)

/** the acts that take a page away from the screen on purpose: a stall beside one of these is no runner overload */
const AWAY_ACTS: readonly ActId[] = ["killed", "relaunched", "hidden", "visible", "left-app", "rejoined", "reloading", "reloaded", "frozen", "thawed", "clock-step"]

/** how close to the app's "auto-confirm off" line the stall must end: markAway runs on the first tick after it */
const OFF_SLACK_MS = 3000

/** Was the missing confirm countdown a freeze? ALL of: the app logged auto-confirm off with reason off-after-background
 *  (lib/game-session.ts markAway); the page ran a long task of at least `thresholdMs` that ended at that line (so before
 *  the confirm stage, where the freeze is no longer watched); and the bot made no hidden or background act up to then,
 *  so it was a stall and not a real background. The longest such stall, or null: then a missing act still FAILS. */
export function confirmFreeze(input: {
  trail: { autoConfirmOff?: { ts: number; reason: string } } | null | undefined
  longTasks: readonly LongTask[]
  acts: readonly RoleAction[]
  /** the turn the page showed at an epoch ms, from the bot's tile timeline */
  turnAt?: (ms: number) => number | null
  thresholdMs?: number
}): ConfirmFreeze | null {
  const off = input.trail?.autoConfirmOff
  if (!off || off.reason !== "off-after-background") return null
  if (input.acts.some((a) => AWAY_ACTS.includes(a.id) && Date.parse(a.at) <= off.ts + OFF_SLACK_MS)) return null
  const threshold = input.thresholdMs ?? FREEZE_THRESHOLD_MS
  const hit = input.longTasks.filter((t) => t.ms >= threshold && Math.abs(t.endedAt - off.ts) <= OFF_SLACK_MS).sort((a, b) => b.ms - a.ms)[0]
  return hit ? { ms: hit.ms, endedAt: hit.endedAt, turn: input.turnAt?.(hit.endedAt - hit.ms) ?? null } : null
}

/** Europe/Berlin wall time, "21:25:28 CEST" (CET in winter), for a person reading a summary */
export function cestTime(ms: number): string {
  const d = new Date(ms)
  const berlin = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d)
  const hours = (Number(berlin.slice(0, 2)) - d.getUTCHours() + 24) % 24
  return `${berlin} ${hours === 2 ? "CEST" : "CET"}`
}

export function describeFreeze(f: ConfirmFreeze): string {
  return `INCONCLUSIVE, not failed: the bot's page froze for ${(f.ms / 1000).toFixed(1)} s${f.turn === null ? "" : ` in turn ${f.turn}`} (ended ${cestTime(f.endedAt)}), longer than the app's ${(FREEZE_THRESHOLD_MS / 1000).toFixed(1)} s freeze line, so the app counted the page away and switched auto-confirm off and no countdown could arm: runner overload, see #341`
}

/** The turn a tile timeline showed at `ms`: the last frame at or before it that names a turn, else the first after. */
export function turnAtTime(rows: readonly { t?: string; turn?: number | null }[], ms: number): number | null {
  const named = rows.filter((r) => r.turn != null)
  const before = named.filter((r) => Date.parse(r.t ?? "") <= ms).at(-1)
  return (before ?? named[0])?.turn ?? null
}
