// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export interface ProbedGame {
  index: number
  gameAt: number
  registrationEnds: number
}

export interface ProbedSelection {
  /** A scheduled game has no index until the pallet promotes it into Game.Game. */
  index: number | null
  gameAt: number
  registrationEnds: number
}

export interface CurrentGameIdentity {
  index: number
  gameAt: number
  registrationEnds: number
  state: string
}

export interface ProbedGameSnapshot {
  chainNow: number
  game: CurrentGameIdentity | null
}

const integer = (env: Readonly<Record<string, string | undefined>>, name: string): number => {
  const raw = env[name]
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer from the live E2E probe; got ${JSON.stringify(raw ?? "")}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a non-negative integer from the live E2E probe; got ${JSON.stringify(raw)}`)
  return value
}

/** The probe's immutable game identity. Live play fails closed if the workflow
 * stops carrying either half. A desk run has no probe and keeps following the
 * current Registration game; boot-only runs never call this. */
export function parseProbedGame(env: Readonly<Record<string, string | undefined>>): ProbedSelection | null {
  if (env.GITHUB_ACTIONS !== "true" && !env.E2E_PROBED_GAME) return null
  const rawIndex = env.E2E_PROBED_GAME?.trim() ?? ""
  return {
    index: rawIndex === "" ? null : integer(env, "E2E_PROBED_GAME"),
    gameAt: integer(env, "E2E_PROBED_GAME_AT"),
    registrationEnds: integer(env, "REGISTRATION_ENDS"),
  }
}

/** A restarted runner may execute long after its probe. It may continue only
 * when the chain still exposes the exact game the probe selected. */
export function matchProbedGame(expected: ProbedGame, current: CurrentGameIdentity | null): { ok: true } | { ok: false; reason: string } {
  if (current?.index === expected.index && current.gameAt === expected.gameAt && current.registrationEnds === expected.registrationEnds && current.state === "Registration") return { ok: true }
  if (current?.index === expected.index && current.registrationEnds === expected.registrationEnds && current.state === "Registration" && current.gameAt !== expected.gameAt) {
    return {
      ok: false,
      reason: `the probe selected game ${expected.index} at exact kickoff ${expected.gameAt}, but game ${current.index} has kickoff ${current.gameAt}; refusing a different kickoff`,
    }
  }
  const found = current ? `game ${current.index} in ${current.state} (registration ends ${current.registrationEnds})` : "no current game"
  return {
    ok: false,
    reason: `the probe selected game ${expected.index} (registration ends ${expected.registrationEnds}), but the chain ${current ? "now has" : "has"} ${found}; the probe's game is over`,
  }
}

type Refusal =
  | { action: "fail"; reason: string }
  | {
      action: "skip"
      reason: string
      skipped: {
        kind: "restarted-after-probed-game"
        expected: ProbedSelection
        current: { index: number; gameAt: number; registrationEnds: number } | null
      }
    }

const refusal = (attempt: number, expected: ProbedSelection, current: CurrentGameIdentity | null, reason: string): Refusal => {
  if (attempt <= 1) return { action: "fail", reason }
  return {
    action: "skip",
    reason,
    skipped: {
      kind: "restarted-after-probed-game",
      expected,
      current: current ? { index: current.index, gameAt: current.gameAt, registrationEnds: current.registrationEnds } : null,
    },
  }
}

const BIND_MIN_LEFT_S = 45
const MAX_BIND_SCANS = 90

/** Resolve a probe selection into one immutable chain game before any Register
 * tap. A future schedule is identified only by its exact gameAt. While an
 * earlier game is still current (or the current slot is briefly empty), the
 * runner rescans. It never derives/guesses the next index and never accepts a
 * later kickoff. The registration end is the second immutable identity half. */
export async function awaitProbedGame(
  attempt: number,
  expected: ProbedSelection,
  read: () => Promise<ProbedGameSnapshot>,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 3000)),
): Promise<{ action: "continue"; game: ProbedGame } | Refusal> {
  if (expected.index !== null) {
    const { game: current } = await read()
    const decision = probedGameDecision(attempt, expected as ProbedGame, current)
    return decision.action === "continue" ? { action: "continue", game: expected as ProbedGame } : decision
  }

  let last: ProbedGameSnapshot | undefined
  for (let scan = 0; scan < MAX_BIND_SCANS; scan++) {
    const snapshot = await read()
    last = snapshot
    const current = snapshot.game
    if (current?.gameAt === expected.gameAt) {
      if (!Number.isSafeInteger(current.index) || current.index < 0) {
        return refusal(attempt, expected, current, `the exact scheduled kickoff ${expected.gameAt} appeared without a concrete non-negative game index`)
      }
      if (current.registrationEnds !== expected.registrationEnds) {
        return refusal(
          attempt,
          expected,
          current,
          `game ${current.index} at exact scheduled kickoff ${expected.gameAt} says registration ends ${current.registrationEnds}, but the probe selected ${expected.registrationEnds}; refusing mismatched game identity`,
        )
      }
      if (current.state !== "Registration") {
        return refusal(attempt, expected, current, `game ${current.index} at exact scheduled kickoff ${expected.gameAt} is already ${current.state}; registration can no longer begin`)
      }
      return { action: "continue", game: { index: current.index, gameAt: current.gameAt, registrationEnds: current.registrationEnds } }
    }
    if (current && current.gameAt > expected.gameAt) {
      return refusal(
        attempt,
        expected,
        current,
        `the chain advanced to game ${current.index} at ${current.gameAt}, past the probe's exact scheduled kickoff ${expected.gameAt}; refusing a different kickoff`,
      )
    }
    if (snapshot.chainNow >= expected.registrationEnds - BIND_MIN_LEFT_S) {
      const found = current ? `game ${current.index} at ${current.gameAt}` : "no current game"
      return refusal(
        attempt,
        expected,
        current,
        `the exact scheduled kickoff ${expected.gameAt} never became a concrete game before registration had ${BIND_MIN_LEFT_S} s left (chain has ${found})`,
      )
    }
    await pause()
  }
  const found = last?.game ? `game ${last.game.index} at ${last.game.gameAt}` : "no current game"
  return refusal(attempt, expected, last?.game ?? null, `the exact scheduled kickoff ${expected.gameAt} did not become concrete after ${MAX_BIND_SCANS} rescans (chain has ${found})`)
}

/** A first attempt that missed its immutable game is a timing failure. Only
 * GitHub's restarted attempt clean-skips, leaving evidence for gather. */
export function probedGameDecision(
  attempt: number,
  expected: ProbedGame,
  current: CurrentGameIdentity | null,
):
  | { action: "continue" }
  | { action: "fail"; reason: string }
  | {
      action: "skip"
      reason: string
      skipped: {
        kind: "restarted-after-probed-game"
        expected: ProbedGame
        current: { index: number; gameAt: number; registrationEnds: number } | null
      }
    } {
  const matched = matchProbedGame(expected, current)
  if (matched.ok) return { action: "continue" }
  if (attempt <= 1) return { action: "fail", reason: matched.reason }
  return {
    action: "skip",
    reason: matched.reason,
    skipped: {
      kind: "restarted-after-probed-game",
      expected,
      current: current ? { index: current.index, gameAt: current.gameAt, registrationEnds: current.registrationEnds } : null,
    },
  }
}
