// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One recovery for a call that raced papi dropping a pinned block while the
 * host resumed. The chain engine tells us when its fresh follow is usable;
 * callers rebuild the whole read or transaction against that follow.
 */
import type { GameEngine } from "@jollity/protocol"
import { hostRetryRecord, recordCount } from "./telemetry"
import { isHostChannelInterruption, waitForSdkReconnect } from "./host/safe-call"

export type ChainRetryOperation = "signup-route" | "signup-seat" | "signup-tx" | "person-bind" | "report" | "chain-health"

// Keep this in step with packages/jollity-collectables/src/collectables.ts's `unpinned`:
// both doors recognize papi's stable "not pinned" phrase.
export function isBlockNotPinned(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /BlockNotPinned|block[^\n]*not pinned|not pinned/i.test(message)
}

export function blockNotPinnedHash(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /Block (0x[0-9a-f]+) is not pinned/i.exec(message)?.[1]
}

type RetryOptions<T> = {
  operation: ChainRetryOperation
  run: () => Promise<T>
  /** Return the failed operation's error, or null when the value succeeded. */
  errorOf?: (value: T) => unknown | null
  /** A transaction may only be rebuilt before its broadcast callback. */
  retryIf?: () => boolean
  signal?: AbortSignal
}

/** The one emitter of chain.retries, recorded once the rerun has settled. */
export function retryMetric(
  operation: ChainRetryOperation,
  succeeded: boolean,
  reason: "block-not-pinned" | "host-interrupted" = "block-not-pinned",
): void {
  recordCount("chain.retries", 1, {
    "chain.retry_reason": reason,
    "chain.retry_operation": operation,
    "chain.retry_succeeded": String(succeeded),
  })
}

const SAFE_HOST_RETRY_OPERATIONS = new Set<ChainRetryOperation>(["signup-route", "signup-seat"])

/** Run once, then rebuild once for a recoverable pinned-block or safe host-read failure. */
export async function retryBlockNotPinned<T>(
  engine: Pick<GameEngine, "waitUntilFollowing">,
  options: RetryOptions<T>,
): Promise<T> {
  const errorOf = options.errorOf ?? (() => null)
  let first: T
  try {
    first = await options.run()
  } catch (error) {
    if (options.retryIf?.() === false) throw error
    if (isBlockNotPinned(error)) return retry(engine, options, error)
    if (SAFE_HOST_RETRY_OPERATIONS.has(options.operation) && isHostChannelInterruption(error)) {
      const startedAt = performance.now()
      if (!(await waitForSdkReconnect())) throw error
      return retryHostRead(options, startedAt, error)
    }
    throw error
  }
  const error = errorOf(first)
  if (options.retryIf?.() === false) return first
  if (isBlockNotPinned(error)) return retry(engine, options, error)
  if (SAFE_HOST_RETRY_OPERATIONS.has(options.operation) && isHostChannelInterruption(error)) {
    const startedAt = performance.now()
    if (!(await waitForSdkReconnect())) return first
    return retryHostRead(options, startedAt, error)
  }
  return first
}

async function retryHostRead<T>(options: RetryOptions<T>, startedAt: number, failure: unknown): Promise<T> {
  const errorOf = options.errorOf ?? (() => null)
  hostRetryRecord({ operation: options.operation, attempt: 2, reason: "host-interrupted", waitedMs: performance.now() - startedAt, error: failure })
  try {
    const value = await options.run()
    retryMetric(options.operation, errorOf(value) === null, "host-interrupted")
    return value
  } catch (error) {
    retryMetric(options.operation, false, "host-interrupted")
    throw error
  }
}

async function retry<T>(
  engine: Pick<GameEngine, "waitUntilFollowing">,
  options: RetryOptions<T>,
  failure: unknown,
): Promise<T> {
  const errorOf = options.errorOf ?? (() => null)
  try {
    const startedAt = performance.now()
    const following = await engine.waitUntilFollowing?.(blockNotPinnedHash(failure), options.signal)
    // A replay-only/hung follow must not hold route reads forever. Preserve
    // papi's original diagnosis for the existing host-chain restart path.
    if (following === false) throw failure
    hostRetryRecord({ operation: options.operation, attempt: 2, reason: "block-not-pinned", waitedMs: performance.now() - startedAt, error: failure })
    const value = await options.run()
    retryMetric(options.operation, errorOf(value) === null)
    return value
  } catch (error) {
    retryMetric(options.operation, false)
    throw error
  }
}
