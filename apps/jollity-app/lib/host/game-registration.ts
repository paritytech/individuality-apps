// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The game registration record of @individuality/shared-records (issues 694
 * and 1316), in the two stores it is kept in: this product's host storage,
 * which the chat and the app share and write, and Humanity's, which Humanity's
 * home writes for the sign-ups it makes and this product only reads (only
 * when Humanity's manifest grants this product `storage`; a product never
 * writes another's).
 *
 * The status watch of lib/game-source.ts reads both and keeps the latest, so
 * the home shows a sign-up the chat or Humanity has on its way instead of
 * offering Register, and the app's own sign-up writes this product's at every
 * step, so the chat and the products Jollity's manifest grants storage to see
 * that one too. Null outside a host, on reads that failed, and for records that
 * are cleared, malformed or stale. Neither throws: a record nobody could write
 * or read leaves the chain the answer.
 */
import { network } from "@jollity/protocol"
import type { HostLocalStorage } from "@parity/product-sdk-host"
import {
  decodeStoredJSON,
  gameRegistrationStore,
  latestGameRegistration,
  type GameRegistration,
  type JSONStorage,
} from "@individuality/shared-records"
import { devLog } from "../debug/log-store"
import { WORKER_NOTIFICATIONS_KEY } from "../debug/worker-evidence"
import { withTimeout } from "../with-timeout"
import { describeError } from "./error-detail"
import { hostStorage } from "./storage"

const READ_TIMEOUT_MS = 8_000

/**
 * Humanity's product, whose storage keeps the sign-ups its home makes:
 * `peopl.<tld>`, or the label `NEXT_PUBLIC_HUMANITY_STORAGE_LABEL` names (a
 * staging or preview Humanity that signs this game account up as another name,
 * as Humanity's `VITE_GAME_STORAGE_LABEL` does the other way). Its manifest must
 * grant this product `storage`: a Humanity deploy grants nothing by default,
 * so set it in Humanity's `HUMANITY_TRUSTED_PRODUCTS` (for example
 * `{"dim2":["context","storage"]}`). Without the grant every read is refused.
 */
export function humanityProduct(): string {
  return `${process.env.NEXT_PUBLIC_HUMANITY_STORAGE_LABEL || "peopl"}.${network().dotnsTLD}`
}

/** Humanity's storage as this product may read it, or null outside a host. */
export async function humanityStorage(): Promise<JSONStorage | null> {
  const sdk = await import("@parity/product-sdk-host")
  const api = await sdk.getTruApi()
  if (!api) return null
  const product = humanityProduct()
  return {
    async readJSON(key) {
      const value = (await api.localStorage.read({ product, key })).match(
        (response) => response.value ?? null,
        (error) => {
          throw new Error(`${product} refused the read: ${sdk.formatHostError(error)}`)
        },
      )
      return value ? decodeStoredJSON(value) : null
    },
  }
}

// Opened on each use, as every read and write of this module always has.
const own = gameRegistrationStore(() => hostStorage())
const humanity = gameRegistrationStore(humanityStorage)

async function readOne(
  store: typeof own,
  from: "jollity" | "humanity",
): Promise<GameRegistration | null> {
  try {
    return await withTimeout(store.read(), READ_TIMEOUT_MS)
  } catch (error) {
    devLog("status", "game registration read failed", { from, detail: describeError(error) }, "warn")
    return null
  }
}

export async function readGameRegistration(): Promise<GameRegistration | null> {
  return latestGameRegistration(await Promise.all([readOne(own, "jollity"), readOne(humanity, "humanity")]))
}

/** Writes this product's record, or clears it with null. Resolves once the write is done or has failed. */
export function writeGameRegistration(record: GameRegistration | null): Promise<void> {
  return own.write(record).catch((error: unknown) => {
    devLog("signup", "game registration write failed", { detail: describeError(error), phase: record?.phase ?? "cleared" }, "warn")
  })
}

type OpeningPushOutcome = "cancelled" | "none" | "unreadable" | "failed"

interface RunningGame {
  index: number
  game_date: number
}

/**
 * Writes the record of a sign-up from the app, and cancels the opening push the chat worker booked for its game once the sign-up is on the wire or has landed.
 *
 * No worker may poll between the tap and the push, and the page is then the only part of the product running. The host scopes a cancel to the product, so the page may cancel an id the worker booked, and the worker cancelling it again later is answered as done. A sign-up still at the signer keeps the push, since nothing would book it again if it never reached the wire. Never throws.
 */
export async function recordSignUp(record: GameRegistration | null, readGame: () => Promise<RunningGame | null | undefined>): Promise<void> {
  await writeGameRegistration(record)
  if (record?.phase !== "sent" && record?.phase !== "registered") return
  const outcome = await cancelOpeningPush(record.gameIndex, readGame)
  void import("../telemetry")
    .then((telemetry) => telemetry.recordCount("signup.opening_push", 1, { outcome }))
    .catch(() => {})
}

async function cancelOpeningPush(gameIndex: number, readGame: () => Promise<RunningGame | null | undefined>): Promise<OpeningPushOutcome> {
  try {
    const sdk = await import("@parity/product-sdk-host")
    const [notifications, game] = await Promise.all([
      withTimeout(sdk.getNotificationManager(), READ_TIMEOUT_MS),
      withTimeout(readGame(), READ_TIMEOUT_MS),
    ])
    if (!notifications || game?.index !== gameIndex) return "none"
    const booking = await readBooking()
    if (!booking) return "unreadable"
    const moment = `opens:${game.game_date}`
    const id = pushId(booking.value, moment)
    if (id === null) return "none"
    if (!(await withTimeout(notifications.cancel(id).then(() => true), READ_TIMEOUT_MS))) throw new Error("the host never answered the cancel")
    await dropFromBooking(moment, id)
    return "cancelled"
  } catch (error) {
    devLog("signup", "could not cancel the opening push", { detail: describeError(error) }, "warn")
    return "failed"
  }
}

/**
 * The record `jollity.wg.notifs` of the chat worker, in the part this module reads and writes.
 *
 * A moment the record no longer holds is one the worker books again on its next poll that still wants it, so a sign-up the chain refuses after the cancel gets its push back.
 */
interface Booking {
  ids?: number[]
  moments?: Record<string, { id?: unknown } | undefined>
}

async function readBooking(): Promise<{ store: HostLocalStorage; value: Booking | null } | null> {
  try {
    const store = await withTimeout(hostStorage(), READ_TIMEOUT_MS)
    if (!store) return null
    const value = (await withTimeout(store.readJSON(WORKER_NOTIFICATIONS_KEY), READ_TIMEOUT_MS)) as Booking | null
    return { store, value }
  } catch (error) {
    devLog("signup", "the booked pushes could not be read", { detail: describeError(error) }, "warn")
    return null
  }
}

function pushId(booking: Booking | null, moment: string): number | null {
  const id = booking?.moments?.[moment]?.id
  return typeof id === "number" ? id : null
}

// Read again after the cancel, so a poll of the worker that wrote the booking meanwhile is kept.
async function dropFromBooking(moment: string, id: number): Promise<void> {
  const booking = await readBooking()
  if (!booking) throw new Error("the booked pushes could not be read after the cancel")
  if (!booking.value) return
  const moments = { ...booking.value.moments }
  delete moments[moment]
  const ids = booking.value.ids?.filter((held) => held !== id)
  const written = booking.store.writeJSON(WORKER_NOTIFICATIONS_KEY, { ...booking.value, moments, ids }).then(() => true)
  if (!(await withTimeout(written, READ_TIMEOUT_MS))) throw new Error("the host never answered the write of the booked pushes")
}
