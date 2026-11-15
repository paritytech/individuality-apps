// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The next-game reminder the host holds for a registered player, through the
 * `game` service of truapi.
 *
 * The host keeps one reminder per product and brings the player back with it:
 * an alarm 20 s before the start, a countdown pill over the last 5 min, the
 * product opening at the start and an entry in the calendar
 * (trinity-user-agents #990, `@parity/truapi` 0.24). A surface asks for it
 * when the player registers or the game moves. A host that predates the
 * service answers "unsupported".
 *
 * The client is typed by its shape alone, so this package keeps no truapi
 * dependency.
 */

export type GameReminderOutcome = "held" | "dropped" | "unsupported" | "starts-in-past" | "denied" | "failed"

/**
 * How long an ask stays under way after its claim, which is as long as a host call gets to answer.
 *
 * The host may hold the call while it asks the player for the alarm, the
 * notifications and the calendar. Past it, the next ask for the game goes out
 * over the claim.
 */
export const ASK_UNDER_WAY_MS = 45_000

/**
 * How long before the start of a game the player is brought in for the dial.
 *
 * Every countdown to a game (the pill of the host, the Jollity chat card and
 * the Humanity card) counts to this moment, so they all read the same.
 */
export const JOIN_LEAD_S = 60

/**
 * When the player joins a game starting at `gamePlayTime` (chain seconds), in
 * wall-clock milliseconds on the device clock. The device clock is what the
 * host counts its pill on, so every countdown reads it too, not the chain
 * clock, whose best block runs a block or two behind.
 */
export function joinAtMs(gamePlayTime: number): number {
  return (gamePlayTime - JOIN_LEAD_S) * 1000
}

/** How long before the join the host shows its countdown pill for a reminder it holds. */
export const HOST_PILL_LEAD_S = 300

/**
 * Whether the pill of the host is up for a game starting at `gamePlayTime`
 * (chain seconds): the last five minutes before the join.
 *
 * While it is up it is the one countdown on screen. The chat card and the
 * Humanity card say the game is starting soon and leave the seconds to it,
 * so two countdowns never tick side by side.
 */
export function hostPillUp(gamePlayTime: number, nowSeconds: number): boolean {
  const left = gamePlayTime - JOIN_LEAD_S - nowSeconds
  return left > 0 && left <= HOST_PILL_LEAD_S
}

/**
 * What the record every surface of a product keeps of the reminder last says
 * about one game, keyed by its play time in chain seconds. The product keeps
 * it in host storage, under a key of its own (`HostReminderStore`).
 *
 * The host writes a calendar entry for every start it has not seen exactly,
 * and never removes one. So the first ask for a game fixes its start in the
 * record before it reaches the host, and every later ask for that game, from
 * any surface and on any retry, sends the same start.
 */
export type HostReminder = {
  gamePlayTime: number
  outcome: GameReminderOutcome | "asking"
  /** The start every ask for this game sends, in wall-clock milliseconds. */
  startsAt?: number
  /** When the outcome was recorded, in wall-clock milliseconds. */
  at?: number
  /** A held reminder whose cancel failed, to cancel again from then on. */
  retryAt?: number
  /** A held reminder of a player one poll read as not registered. */
  outSeen?: boolean
}

/** Whether the record shows an ask for the game that a host call may still answer. */
export function askUnderWay(record: HostReminder | null | undefined, gamePlayTime: number, now = Date.now()): boolean {
  return record?.gamePlayTime === gamePlayTime && record.outcome === "asking" && now < (record.at ?? 0) + ASK_UNDER_WAY_MS
}

/** Reads and writes the record, and rejects when either fails. */
export interface HostReminderStore {
  read(): Promise<HostReminder | null>
  write(record: HostReminder): Promise<void>
}

interface CallResult {
  isOk(): boolean
  error?: unknown
}

type Thenable<T> = { then<R>(onfulfilled: (value: T) => R | PromiseLike<R>): unknown }

export interface GameReminderClient {
  game: {
    remindNextGame(request: { startsAt: bigint }): Thenable<CallResult>
    cancelNextGame(request: Record<string, never>): Thenable<CallResult>
  }
}

/** Takes the reason of an answer that is not the one asked for, as text. */
export type ReminderErrorListener = (text: string) => void

function failureOf(error: unknown): GameReminderOutcome {
  const tag = (error as { tag?: unknown } | null | undefined)?.tag
  if (tag === "Unsupported") return "unsupported"
  if (tag === "Denied") return "denied"
  if (tag === "Domain" && (error as { value?: { value?: unknown } }).value?.value === "StartsInPast") return "starts-in-past"
  return "failed"
}

/**
 * The refusal of the host in its own words, as `HostFailure: <reason>` or `Domain.V1: StartsInPast`.
 *
 * truapi nests a refusal as tagged values, the call error over the version over the error of the call, and the innermost one names it.
 */
function refusalText(error: unknown): string {
  const tags: string[] = []
  let node = error
  while (typeof node === "object" && node !== null && typeof (node as { tag?: unknown }).tag === "string") {
    tags.push((node as { tag: string }).tag)
    node = (node as { value?: unknown }).value
  }
  if (tags.length === 0) return String(error)
  const reason = typeof node === "string" ? node : (node as { reason?: unknown } | null | undefined)?.reason
  return typeof reason === "string" ? `${tags.join(".")}: ${reason}` : tags.join(".")
}

async function call(
  send: () => Thenable<CallResult>,
  success: GameReminderOutcome,
  onError?: ReminderErrorListener,
): Promise<GameReminderOutcome> {
  try {
    const result = await send()
    if (result.isOk()) return success
    onError?.(refusalText(result.error))
    return failureOf(result.error)
  } catch (error) {
    onError?.(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    return "failed"
  }
}

/**
 * Asks the host to hold the reminder for a game starting at `startsAtMs`, on the device clock, in place of the one it holds.
 *
 * `onError` hears why the host did not hold it, from the refusal or from the call that threw.
 */
export function remindNextGame(truApi: GameReminderClient, startsAtMs: number, onError?: ReminderErrorListener): Promise<GameReminderOutcome> {
  return call(() => truApi.game.remindNextGame({ startsAt: BigInt(Math.round(startsAtMs)) }), "held", onError)
}

/**
 * Asks the host to drop the reminder, which is safe whether it holds one or not.
 *
 * `onError` hears why the host did not drop it.
 */
export function cancelNextGame(truApi: GameReminderClient, onError?: ReminderErrorListener): Promise<GameReminderOutcome> {
  return call(() => truApi.game.cancelNextGame({}), "dropped", onError)
}

/**
 * Asks the host for the reminder of a game under a claim in the record.
 *
 * The start is the one the record already holds for the game, else
 * `startsAtMs`. Without a recorded claim it asks nothing and answers
 * "unrecorded", since a start the record cannot keep would reach the host
 * again as a different one. The answer is recorded only while the claim is
 * still the latest word, so a late answer never overwrites a newer record.
 */
export async function askUnderClaim(
  ask: (startsAtMs: number) => Promise<GameReminderOutcome>,
  store: HostReminderStore,
  stored: HostReminder | null,
  gamePlayTime: number,
  startsAtMs: number,
): Promise<GameReminderOutcome | "unrecorded"> {
  const startsAt = stored?.gamePlayTime === gamePlayTime && stored.startsAt !== undefined ? stored.startsAt : Math.round(startsAtMs)
  const claim: HostReminder = { gamePlayTime, startsAt, outcome: "asking", at: Date.now() }
  try {
    await store.write(claim)
  } catch {
    return "unrecorded"
  }
  const outcome = await ask(startsAt)
  try {
    const latest = await store.read()
    if (latest?.outcome === "asking" && latest.gamePlayTime === gamePlayTime && latest.at === claim.at) {
      await store.write({ gamePlayTime, startsAt, outcome, at: Date.now() })
    }
  } catch {
    /* The claim stays, and the next ask sends the same start. */
  }
  return outcome
}
