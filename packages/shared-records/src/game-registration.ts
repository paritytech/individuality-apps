// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The sign-up Jollity has on its way, or has just ended, for a game: the one
 * record both of its surfaces keep in host storage, and other products read
 * (issues 694 and 1316).
 *
 * The chat worker and the app each sign the shared game account up, and the
 * chain shows a sign-up only once it is in a block, up to half a minute after
 * the tap. In between, every home that offers Register would offer it again.
 * So whichever surface signs up writes this record at each step, under
 * `GAME_REGISTRATION_KEY` in its OWN product's storage: Jollity's chat and
 * app in Jollity's, Humanity's home in Humanity's. A product can read another's
 * storage through a `trustedProducts` storage grant but never write it, so
 * each reader reads both stores and keeps the latest record
 * (`latestGameRegistration`) instead of guessing from the chain. Jollity
 * writes it from apps/jollity-worker/src/signup.ts and
 * apps/jollity-app/lib/game-source.ts, Humanity from
 * apps/humanity-app/src/features/card/chain/game-sign-up.ts.
 *
 * The lifecycle of one sign-up is
 *
 *     (no record) -> registering -> sent -> registered
 *                                  \-> failed       \-> failed
 *
 * `registering` from the tap to the broadcast, `sent` while the transaction
 * is on the wire, `registered` once the chain holds the player, `failed` when
 * the sign-up ended any other way. The record names its game, and only says
 * something about that game: a reader compares `gameIndex` with the game it
 * shows. No record, or a record for another game, is "not registered by
 * Jollity", which leaves the chain the answer. The chain stays the authority
 * for `registered` too; the record only gets a reader there before finality.
 *
 * The record bridges the gap between the tap and the chain; it is no ledger.
 * A record outlives its sign-up only when the host stops the surface before
 * it can end it, so the two phases on their way count for as long as a live
 * sign-up could still hold them. The two ended phases count for as long as a
 * reader could be waiting on the chain to say the same, and the chain is the
 * answer after that.
 *
 * The record is JSON under the key; a cleared record is `null`.
 */

/** The host storage key of the record, a `GameRegistration` or null. */
export const GAME_REGISTRATION_KEY = "jollity.registration"

/**
 * How long the chat watches its transaction once it is on the wire, a few
 * blocks past finality. It then reads the chain: the player registered ends
 * registered, anything else ends the sign-up and clears the record.
 */
export const REGISTRATION_WATCH_MS = 120_000

/**
 * How long a `registering` record counts after it was written.
 *
 * The longest wait before the broadcast is the signer prompt, which the player
 * may sit on, so this is generous.
 */
export const REGISTERING_TTL_MS = 5 * 60_000

/**
 * How long a `sent` record counts after the broadcast.
 *
 * The chat settles a `sent` sign-up once the watch is over and its last chain
 * read has answered, which `SIGNUP_STEP_DEADLINE_MS` in apps/jollity-worker/src/signup.ts
 * bounds at 30 s. The app's own watch ends on finality or on its retry
 * loop's timeout, which is sooner. An older record belongs to a stopped
 * surface, and must not hold "You're in" over a sign-up that may have failed
 * on chain.
 */
export const SENT_TTL_MS = REGISTRATION_WATCH_MS + 30_000

/**
 * How long a `registered` or `failed` record counts after the sign-up ended.
 *
 * A reader is there to show the sign-up before its finalized chain read does,
 * which a sent record's lifetime covers twice over. A record older than that
 * would hold a landed sign-up the chain since rolled back, or a failure the
 * chain never saw, over what the chain says now.
 */
export const ENDED_TTL_MS = SENT_TTL_MS

/**
 * How far ahead of a reader's clock a record's `at` may be and still count.
 * Records now come from two products, whose clocks can differ; a record from
 * the future would otherwise win every comparison and outlive its lifetime.
 */
export const MAX_CLOCK_SKEW_MS = 60_000

/** Which surface made the sign-up: Jollity's chat or app, or Humanity's home. */
export type RegistrationSurface = "chat" | "app" | "humanity"

export type RegistrationPhase = "registering" | "sent" | "registered" | "failed"

export type GameRegistration = {
  gameIndex: number
  phase: RegistrationPhase
  surface: RegistrationSurface
  /** When the sign-up entered the phase, in wall-clock milliseconds. */
  at: number
  /**
   * Names the attempt, the same in every record of one tap, so a surface can
   * tell its own finished attempt from one a stopped run of it left.
   */
  attempt: number
  /** Why a `failed` sign-up ended, a short tag safe to log; absent otherwise. */
  reason?: string
}

/** Whether the record is of a sign-up still on its way, rather than an ended one. */
export function registrationInFlight(record: Pick<GameRegistration, "phase"> | null): boolean {
  return record?.phase === "registering" || record?.phase === "sent"
}

/** The record if it is well formed and within the lifetime of its phase at `now`, else null. */
export function liveGameRegistration(stored: unknown, now: number): GameRegistration | null {
  if (typeof stored !== "object" || stored === null) return null
  const { gameIndex, phase, surface, at, attempt, reason } = stored as Record<string, unknown>
  if (typeof gameIndex !== "number" || !Number.isInteger(gameIndex)) return null
  if (phase !== "registering" && phase !== "sent" && phase !== "registered" && phase !== "failed") return null
  if (surface !== "chat" && surface !== "app" && surface !== "humanity") return null
  if (typeof at !== "number" || typeof attempt !== "number") return null
  const lifetime = phase === "registering" ? REGISTERING_TTL_MS : phase === "sent" ? SENT_TTL_MS : ENDED_TTL_MS
  if (now - at > lifetime || at - now > MAX_CLOCK_SKEW_MS) return null
  return { gameIndex, phase, surface, at, attempt, ...(typeof reason === "string" ? { reason } : {}) }
}


/**
 * Of the records the products keep, each in its own storage, the one a reader
 * goes by; null when none is live. A product can read another's storage but
 * never write it, so Humanity keeps the record of its own sign-ups in its own
 * storage under the same key, and a reader reads both.
 *
 * A sign-up on its way outranks an ended one, whatever their times: one
 * product's failed attempt must not hide the other's that is still going, or
 * the home would offer Register over it. Within a rank, the latest.
 */
export function latestGameRegistration(records: readonly (GameRegistration | null)[]): GameRegistration | null {
  let latest: GameRegistration | null = null
  for (const record of records) {
    if (!record) continue
    if (!latest) latest = record
    else if (registrationInFlight(record) !== registrationInFlight(latest)) {
      if (registrationInFlight(record)) latest = record
    } else if (record.at > latest.at) latest = record
  }
  return latest
}
