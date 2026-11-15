// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * WHO THE PLAYER IS, with their permission — the host's identity surface,
 * behind one door.
 *
 * Two steps, and the first one IS the permission:
 *   1. `requestLogin(reason)` — the host shows ITS OWN consent UI with our
 *      reason in it and answers Success | AlreadyConnected | Rejected. This is
 *      the user granting this product the right to know who they are.
 *   2. `getUserId()` — `{ primaryUsername }`, their primary DotNS username.
 *
 * A rejection is REMEMBERED in host storage, so a screen asks once and then
 * stops; the caller simply gets null and shows no name. Nothing here invents
 * one: a card with no name on it is the honest card.
 *
 * Cached per page load: step 1 shows UI, so it must never run twice.
 */
import { PLAYER_NAME_KEY } from "@jollity/protocol"
import { devLog } from "../debug/log-store"
import { describeError } from "./error-detail"
import { retrySafeHostRead } from "./safe-call"

const CONSENT_KEY = "jollity.nameConsent"

type NameConsent = "granted" | "rejected" | "unasked"

let cached: string | null | undefined
let inflight: Promise<string | null> | undefined

async function storage(): Promise<{
  get: (k: string) => Promise<string | null>
  set: (k: string, v: string) => Promise<void>
} | null> {
  try {
    const sdk = await import("@parity/product-sdk-host")
    if (!sdk.isInsideContainerSync()) return null
    const host = await retrySafeHostRead(sdk, () => sdk.getHostLocalStorage())
    if (!host) return null
    return {
      get: async (k) => (await retrySafeHostRead(sdk, () => host.readString(k))) || null,
      set: async (k, v) => host.writeString(k, v),
    }
  } catch (error) {
    devLog("identity", "host storage unavailable", { detail: describeError(error) }, "warn")
    return null
  }
}

/**
 * The chat worker reads the name from host storage under PLAYER_NAME_KEY, as a
 * JSON string, and sends it with its telemetry. The one place the app writes it.
 */
async function shareWithWorker(name: string): Promise<void> {
  try {
    const sdk = await import("@parity/product-sdk-host")
    const host = await retrySafeHostRead(sdk, () => sdk.getHostLocalStorage())
    await host?.writeJSON(PLAYER_NAME_KEY, name)
  } catch (error) {
    devLog("identity", "the name could not be shared with the worker", { detail: describeError(error) }, "warn")
  }
}

/** what we already know without showing any UI */
async function nameConsent(): Promise<NameConsent> {
  const store = await storage()
  if (!store) return "unasked"
  const value = await store.get(CONSENT_KEY)
  return value === "granted" || value === "rejected" ? value : "unasked"
}

/**
 * Ask for the name, showing the host's consent UI if it has not been answered
 * yet. Null when the user declines, the host has no identity, or we are not
 * in a host at all. Concurrent calls share ONE requestLogin / getUserId.
 */
export function requestDisplayName(reason: string): Promise<string | null> {
  if (cached !== undefined) return Promise.resolve(cached)
  return (inflight ??= fetchDisplayName(reason).finally(() => {
    inflight = undefined
  }))
}

async function fetchDisplayName(reason: string): Promise<string | null> {
  try {
    const sdk = await import("@parity/product-sdk-host")
    if (!sdk.isInsideContainerSync()) return (cached = null)
    const accounts = await retrySafeHostRead(sdk, () => sdk.getAccountsProvider())
    if (!accounts) return (cached = null)

    // 1. the permission. "AlreadyConnected" is a yes given earlier.
    const login = await accounts.requestLogin(reason).match(
      (value) => value,
      (error) => {
        // a failed call also ends as Rejected: only the host's words tell them apart
        devLog("identity", "requestLogin did not succeed", { detail: describeError(error) }, "warn")
        return "Rejected" as const
      },
    )
    const store = await storage()
    if (login === "Rejected") {
      await store?.set(CONSENT_KEY, "rejected")
      return (cached = null)
    }
    // a "granted" already on disk needs no second write
    if ((await store?.get(CONSENT_KEY)) !== "granted") await store?.set(CONSENT_KEY, "granted")

    // 2. the name itself
    const userId = await retrySafeHostRead(sdk, () => accounts.getUserId(), {
      errorOf: (result) => result.match(() => null, (error) => error),
      operation: "identity.user-id",
    })
    const name = userId.match(
      (value) => value.primaryUsername,
      (error) => {
        devLog("identity", "getUserId failed", { detail: describeError(error) }, "warn")
        return null
      },
    )
    const trimmed = name && name.trim() ? name.trim() : null
    if (trimmed) await shareWithWorker(trimmed)
    return (cached = trimmed)
  } catch (error) {
    devLog("identity", "display name unavailable", { detail: describeError(error) }, "warn")
    return (cached = null)
  }
}

/**
 * The name, without ever raising a prompt of our own.
 *
 *  - `ask: false` (default): only when consent was already granted, for a
 *    silent first paint (the recap, the log export).
 *  - `ask: true`: the APP-OPEN path, so a player who stops before the results
 *    card is still named. It skips the stored-consent wait: a product the host
 *    trusts gets AlreadyConnected from `requestLogin` with no UI, and a
 *    remembered refusal is final. After it runs, consent is stored, so a later
 *    `ask: false` call gets the same answer and a refusal still gets null.
 */
export async function knownDisplayName({ ask = false }: { ask?: boolean } = {}): Promise<string | null> {
  const consent = await nameConsent()
  if (consent === "rejected" || (consent === "unasked" && !ask)) return null
  return requestDisplayName(ask ? "so your results carry your name" : "")
}
