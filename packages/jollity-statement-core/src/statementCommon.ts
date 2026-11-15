// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Helpers shared by every caller of the statement store: the WebRTC
 * signalling transport (`statementTransport.ts`) and any "can we publish
 * right now?" probe an app builds on top.
 *
 * The namespace is caller-supplied, so nothing here imports app settings.
 * The packed slot expiry is exported as `nextSlotExpiry` because this
 * package also ships the native apps' sequence expiry under `nextExpiry`
 * (statement.ts) — two different schemes, two names.
 */

const enc = new TextEncoder()
export async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ])
}

/** A set of keys seen so far: the returned function is true the first time a key is given. For
 *  failures that repeat on every frame or retry and need saying once. */
export function onceByKey(): (key: string) => boolean {
  const seen = new Set<string>()
  return (key) => {
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
}

/** Best-effort string form of an arbitrary rejection reason — unlike bare
 *  `(e as Error)?.message`, this also covers plain-string and message-less
 *  object rejections, so a host bridge that rejects with a string (rather
 *  than throwing an Error) cannot silently defeat the classification below,
 *  nor leave `stats.lastError` as an unhelpful "". */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  if (e && typeof e === "object") {
    const m = (e as { message?: unknown }).message
    if (typeof m === "string") return m
    try {
      return JSON.stringify(e)
    } catch {
      /* fall through to String(e) */
    }
  }
  return String(e)
}

/** The `sign-timeout:` prefix health classifiers key on. Shared so a
 *  submitter can't emit a lookalike that the classifier misses. */
export const SIGN_TIMEOUT_PREFIX = "sign-timeout:"

/** A hung sign step is attributable to the SIGNER, not the store or the
 *  network — relabel it so health reporting says "waiting on the signer"
 *  instead of a generic rejection. Hardened via `errMessage` against
 *  non-Error rejections. ONE implementation, every submitter. */
export function classifySignError(e: unknown): Error {
  const msg = errMessage(e)
  if (/timeout/i.test(msg))
    return new Error(`${SIGN_TIMEOUT_PREFIX} signer did not return a proof`)
  return e instanceof Error ? e : new Error(msg)
}

/** Did this rejection come from the store failing to construct at all
 *  (a host with no statement-store bridge) rather than from a submit the
 *  store accepted and then stalled? Tagged at the throw site so the
 *  distinction survives as data instead of being guessed from copy. */
export const STORE_UNAVAILABLE_PREFIX = "store-unavailable:"

export function storeUnavailableError(e: unknown): Error {
  return new Error(`${STORE_UNAVAILABLE_PREFIX} ${errMessage(e)}`)
}

export function isStoreUnavailable(e: unknown): boolean {
  return errMessage(e).startsWith(STORE_UNAVAILABLE_PREFIX)
}

/**
 * Was this submit rejected for TIME: the node's `alreadyExpired`? Matched
 * exactly, never guessed from words. sc-statement-store's `statement_submit`
 * answers `SubmitResult::Invalid(InvalidReason::AlreadyExpired)`, which serde
 * writes `{"status":"invalid","reason":"alreadyExpired"}` (tag "status", the
 * reason's tag "reason", camelCase). It arrives as:
 *  - the truapi host: `statement_submit not accepted: {"reason":"alreadyExpired","status":"invalid"}`
 *    (serde_json re-serialized, keys sorted);
 *  - `nodeStatementStore` (store.ts): `statement rejected: {"status":"invalid","reason":"alreadyExpired"}`;
 *  - a store that rejects with the result object itself;
 *  - the iOS host, whose native store words it in Swift with no JSON:
 *    `invalid(Optional(StatementStore.StatementInvalidReason.alreadyExpired))`,
 *    matched as the whole word `alreadyExpired` / `already_expired`.
 * The other expiry rejections (`channelPriorityTooLow`, `accountFull`) are
 * about expiry ORDER against the store's own statements, not the clock.
 */
export function isTimeRejection(e: unknown): boolean {
  const expired = (v: unknown) => {
    const r = v as { status?: unknown; reason?: unknown } | null
    return !!r && typeof r === "object" && r.status === "invalid" && r.reason === "alreadyExpired"
  }
  if (expired(e)) return true
  const msg = errMessage(e)
  for (let open = msg.indexOf("{"); open !== -1; open = msg.indexOf("{", open + 1)) {
    const close = msg.indexOf("}", open)
    if (close === -1) return false
    try {
      if (expired(JSON.parse(msg.slice(open, close + 1)))) return true
    } catch {
      /* not this brace */
    }
  }
  return /\balready_?expired\b/i.test(msg)
}

/**
 * The expiry our OWN channel already holds, when the store refused a
 * statement as `channelPriorityTooLow`: the node keeps one statement per
 * channel and a replacement must carry a higher expiry. It happens after a
 * reload mid-game (the new page's expiry floor starts at 0, the old page's
 * statements are still live), and the cure is one re-stamp above it. Read
 * from the raw text, not JSON.parse: a packed expiry is past 2^53. The host
 * writes the field `min_expiry` (RejectionReason, serde camelCase variants
 * with snake_case fields); the spec-v2 shape writes `minExpiry`. Null for
 * every other rejection, and for one that does not say the floor.
 */
export function channelPriorityFloor(e: unknown): bigint | null {
  const msg = errMessage(e)
  if (!/"reason"\s*:\s*"channelPriorityTooLow"/.test(msg)) return null
  const floor = /"min_?[eE]xpiry"\s*:\s*(\d+)/.exec(msg)
  return floor ? BigInt(floor[1]!) : null
}

// Shared by every submitter (transport + probes) so retuning one cannot
// silently leave another testing a stale threshold.
export const SUBMIT_TIMEOUT_MS = 12_000
export const SIGN_TIMEOUT_MS = 8_000 // below SUBMIT_TIMEOUT_MS so a hung SIGN is attributable to the signer

export const TTL_S = 30 // must exceed the mesh's BACKOFF_MAX_MS (20s) so a re-offer outlives recovery

// Strictly-rising packed expiry = TTL deadline (high 32 bits) + LWW priority
// (whole u64), so each overwrite of a slot outranks the previous. BigInt mask
// avoids the signed-Int32 bug.
// `nowMs` is the time the deadline is stamped from (default `Date.now()`).
// The node judges the deadline against its OWN clock, so the app passes its
// store clock (storeClock.ts): the game clock plus a learned acceptance margin.
// The floor keeps every stamp rising, a margin change included.
let lastExpiry = 0n
let floorListener: ((floor: bigint) => void) | null = null
/** Told every time the floor rises, so the app can save it at MINT time (lib/store-clock.ts): a statement still in
 *  flight at a reload is then covered too, not only the accepted ones. One listener, the page's; null removes it. */
export function onSlotExpiryFloor(listener: ((floor: bigint) => void) | null): void {
  floorListener = listener
}
const raised = () => {
  try {
    floorListener?.(lastExpiry)
  } catch {
    /* a listener never breaks a stamp */
  }
}
/** The packed expiry for a stamp: the deadline `nowMs` + `ttlS` in the high 32
 *  bits, the stamp's low ms bits as the priority. No floor: `nextSlotExpiry`
 *  adds that for the signalling slots. */
export function packExpiry(nowMs: number, ttlS: number = TTL_S): bigint {
  const deadline = BigInt(Math.floor(nowMs / 1000) + ttlS)
  return (deadline << 32n) | (BigInt(Math.floor(nowMs)) & 0xffffffffn)
}
/** the highest packed expiry this page has minted (persisted across a reload
 *  by the app, lib/store-clock.ts) */
export function slotExpiryFloor(): bigint {
  return lastExpiry
}
/** lift the floor to `expiry`: a reload restoring its last one, or a
 *  `channelPriorityTooLow` naming the one our channel holds. Never lowers it. */
export function raiseSlotExpiryFloor(expiry: bigint): void {
  if (expiry > lastExpiry) {
    lastExpiry = expiry
    raised()
  }
}
/** tests: a new page's floor */
export function resetSlotExpiryForTests(): void {
  lastExpiry = 0n
}
export function nextSlotExpiry(nowMs: number = Date.now()): bigint {
  let e = packExpiry(nowMs)
  if (e <= lastExpiry) e = lastExpiry + 1n
  lastExpiry = e
  raised()
  return e
}
