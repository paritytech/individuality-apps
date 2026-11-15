// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * How a transaction on the People chain comes back: the pallet's error name
 * out of a papi dispatch error, and a watch that settles at the best block.
 * The sign-up's bind and the prize claim submit through these.
 */
import type { DispatchResult } from "./types"

/** How far the walk goes, so an error whose `error` leads back to itself still ends. */
const DISPATCH_ERROR_DEPTH = 6

/** The innermost `type` of a papi DispatchError, the pallet error name.
 *  `{Module, {Game, {AlreadyRegistered}}}` yields "AlreadyRegistered".
 *
 *  A pool refusal arrives as papi InvalidTxError, which keeps its
 *  `{Invalid, {Stale}}` under `error`, so the walk follows `error` where a
 *  node has no `value` and yields "Stale". A custom refusal keeps its code,
 *  so `{Invalid, {Custom, 172}}` yields "Custom(172)". Other failures, a host
 *  that refuses to build the transaction or a request that times out, carry no
 *  `type` chain and come back as their message, the only part that says what
 *  happened. */
export function dispatchErrorName(error: unknown): string {
  let node: unknown = error
  let name: string | undefined
  for (let depth = 0; depth < DISPATCH_ERROR_DEPTH && node !== null && typeof node === "object"; depth += 1) {
    const { type, value, error: cause } = node as { type?: unknown; value?: unknown; error?: unknown }
    if (typeof type === "string") name = type
    node = value ?? cause
  }
  if (name === "Custom" && (typeof node === "number" || typeof node === "bigint")) return `Custom(${node})`
  if (name) return name
  if (error instanceof Error && error.message) return error.message
  return typeof error === "string" && error ? error : "DispatchError"
}

/** The pool refusals of a nonce another transaction of the account took.
 *  `Stale` follows a send with the same nonce that landed, and `Future` one
 *  sent ahead of the account, so a second send clears both. */
export const isNonceRefusal = (name: string | undefined): name is "Stale" | "Future" => name === "Stale" || name === "Future"

/** papi's words when the block subscription under a transaction watch ended
 *  before the transaction's fate was known (observable-client's track-tx).
 *  The watches here turn them into the typed `landingUnknown` flag, so no
 *  caller matches text. */
export function isTrackingStopped(error: unknown): boolean {
  return error instanceof Error && /tracking stopped/i.test(error.message)
}

export function toDispatchResult(result: { ok: boolean; dispatchError?: unknown }): DispatchResult {
  return result.ok ? { ok: true } : { ok: false, error: dispatchErrorName(result.dispatchError) }
}

/** one papi tx lifecycle event, in the fields the settle logic reads */
export interface TxEvent {
  type: string
  ok?: boolean
  dispatchError?: unknown
}

/** what an abort carries, as an Error the caller can read */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error(`aborted: ${String(reason ?? "no reason")}`)
}

/**
 * Drive a `createSubmitAndWatch` observable and resolve the moment the tx is in
 * a BEST block (`inBestBlock`), or at `finalized` should the
 * best-block event never come. An invalid tx or a refused signature arrives on
 * the error channel and resolves as a failed dispatch — never a throw. A watch
 * that stops ("Tracking stopped") or COMPLETES with no block ever holding the
 * tx resolves as a failed dispatch with `landingUnknown`, so a caller is never
 * left pending and re-reads before it calls the tx failed.
 *
 * `signal` is the one way to reject: an abort drops the watch and rejects
 * with the signal's reason. The tx may still be on the wire — it is the
 * caller's job to re-read before submitting again.
 */
export function submitToBestBlock(
  watch: {
    subscribe: (observer: {
      next: (event: TxEvent) => void
      error: (error: unknown) => void
      complete?: () => void
    }) => {
      unsubscribe: () => void
    }
  },
  signal?: AbortSignal,
): Promise<DispatchResult> {
  return new Promise<DispatchResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    let settled = false
    // `sub` may not be assigned yet if the observable emits synchronously
    // during subscribe (papi can), so guard the unsubscribe. A `const` would
    // throw on that early read (temporal dead zone), hence the `let`.
    // eslint-disable-next-line prefer-const
    let sub: { unsubscribe: () => void } | undefined
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      sub?.unsubscribe()
      settle()
    }
    const done = (result: DispatchResult) => finish(() => resolve(result))
    const onAbort = () => finish(() => reject(abortError(signal!)))
    signal?.addEventListener("abort", onAbort, { once: true })
    sub = watch.subscribe({
      next: (event) => {
        if (event.type === "inBestBlock" || event.type === "finalized")
          done(toDispatchResult({ ok: event.ok ?? false, dispatchError: event.dispatchError }))
      },
      // a watch that stopped, or ended, never learned whether the tx landed
      error: (error) =>
        done({ ok: false, error: dispatchErrorName(error), ...(isTrackingStopped(error) ? { landingUnknown: true as const } : {}) }),
      complete: () => done({ ok: false, error: "the transaction watch ended before any block held it", landingUnknown: true }),
    })
    if (settled) sub?.unsubscribe()
  })
}
