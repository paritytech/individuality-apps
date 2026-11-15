// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The host reminder of the next game, for a player who signs up in the app.
 *
 * The chat asks for it before its sign-ups and on its polls. The app asks
 * before its sign-up goes out, which waits for the answer, and again once it
 * lands, which is how a player who registers after a game gets the alarm, the
 * pill and the auto-open of the host. Both ask under one record in host
 * storage, so every ask for a game sends the same start (see
 * `HOST_REMINDER_KEY`).
 *
 * The host may hold the call while it asks the player for the alarm, the
 * notifications and the calendar. An answer after the timeout reads as
 * "failed" here, and is still recorded when it comes. Null outside a host.
 * Never throws.
 */
import { HOST_REMINDER_KEY } from "@jollity/protocol"
import {
  ASK_UNDER_WAY_MS,
  askUnderClaim,
  askUnderWay,
  remindNextGame,
  type GameReminderOutcome,
  type HostReminder,
  type HostReminderStore,
} from "@individuality/sign-up"
import { devLog } from "../debug/log-store"
import { withTimeout } from "../with-timeout"
import { describeError } from "./error-detail"
import { hostStorage } from "./storage"

const TIMEOUT_MS = 10_000
const ANSWER_POLL_MS = 1_000

export type AppReminderOutcome = GameReminderOutcome | "asking" | "unrecorded"

/** Hears the answer of the host to a real ask, never to a stored answer that is reused, and why it was not held. */
export type ReminderAskListener = (outcome: AppReminderOutcome, error?: string) => void

async function reminderStore(): Promise<HostReminderStore | null> {
  const storage = await hostStorage()
  if (!storage) return null
  return {
    read: async () => (await storage.readJSON(HOST_REMINDER_KEY)) as HostReminder | null,
    write: (record) => storage.writeJSON(HOST_REMINDER_KEY, record),
  }
}

/**
 * Asks the host to remind the player of the game at `gamePlayTime`, in chain
 * seconds, which starts at `startsAtMs` on the wall clock.
 *
 * It asks nothing when the record cannot be read, as the chat does, or when
 * the record already holds the game. It asks nothing either over an ask for
 * the game that may still be answered, unless `askOverClaim` says the caller
 * has waited it out.
 */
export async function holdGameReminder(
  gamePlayTime: number,
  startsAtMs: number,
  onAsked?: ReminderAskListener,
  { timeoutMs = TIMEOUT_MS, askOverClaim = false } = {},
): Promise<AppReminderOutcome | null> {
  const ask = async (): Promise<AppReminderOutcome | "no-host"> => {
    const sdk = await import("@parity/product-sdk-host")
    const [truApi, store] = await Promise.all([sdk.getTruApi(), reminderStore()])
    if (!truApi) return "no-host"
    if (!store) return "unrecorded"
    const stored = await store.read()
    if (stored?.gamePlayTime === gamePlayTime && (stored.outcome === "held" || (!askOverClaim && askUnderWay(stored, gamePlayTime)))) {
      return stored.outcome
    }
    let askError: string | undefined
    const asked = await askUnderClaim(
      (startsAt) => remindNextGame(truApi, startsAt, (text) => (askError = text)),
      store,
      stored,
      gamePlayTime,
      startsAtMs,
    )
    if (askError) devLog("reminder", `game reminder answered ${asked}`, { detail: askError }, "warn")
    onAsked?.(asked, askError)
    return asked
  }
  try {
    const outcome = (await withTimeout(ask(), timeoutMs)) ?? "failed"
    return outcome === "no-host" ? null : outcome
  } catch (error) {
    devLog("reminder", "game reminder ask failed", { detail: describeError(error) }, "warn")
    return "unrecorded"
  }
}

/**
 * Waits while the record shows an ask for the game under way, from the chat or an earlier tap, so a sign-up takes its answer rather than ask over it.
 *
 * It gives up once a host call would have answered, and reads nothing after.
 * Each read is bounded by that moment too, since host storage may never
 * answer one.
 */
async function answerUnderWay(gamePlayTime: number): Promise<void> {
  const giveUpAt = Date.now() + ASK_UNDER_WAY_MS
  try {
    const store = await reminderStore()
    if (!store) return
    while (Date.now() < giveUpAt && askUnderWay(await withTimeout(store.read(), giveUpAt - Date.now()), gamePlayTime)) {
      await new Promise((resolve) => setTimeout(resolve, ANSWER_POLL_MS))
    }
  } catch {
    /* An unreadable record leaves the ask to decide. */
  }
}

/**
 * The answer of the host a sign-up from the app waits for before it goes out.
 *
 * It takes the answer of an ask still under way, and asks over its claim once
 * a host call would have answered. It gives the host as long as the chat
 * does, and asks once more on a failed or denied answer, since the host may
 * give up on the call while it asks the player for the alarm.
 */
export async function reminderForSignup(gamePlayTime: number, startsAtMs: number, onAsked?: ReminderAskListener): Promise<AppReminderOutcome | null> {
  await answerUnderWay(gamePlayTime)
  const ask = () => holdGameReminder(gamePlayTime, startsAtMs, onAsked, { timeoutMs: ASK_UNDER_WAY_MS, askOverClaim: true })
  const outcome = await ask()
  return outcome === "failed" || outcome === "denied" ? ask() : outcome
}
