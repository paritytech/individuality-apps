// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One recovery for host reads that raced a mobile WebView resume.
 *
 * The host transport rejects every in-flight call when its MessagePort is
 * replaced.  A fresh port normally reports connected within a second.  Only
 * callers that are explicitly safe to repeat use this helper: it waits for
 * that connected edge, reruns once, and never turns into a retry loop.
 */

import { classifyHostFailure } from "@individuality/people-chain"

export const HOST_RECONNECT_WAIT_MS = 2_000

export interface HostConnectionSource {
  subscribeConnectionStatus(callback: (status: "connecting" | "connected" | "disconnected") => void): () => void
}

type ResultLike = { ok?: boolean; error?: unknown }

/** The TrUAPI transport failure, through SDK wrappers and Result errors. */
export function isHostChannelInterruption(value: unknown): boolean {
  return classifyHostFailure(value) === "host-interrupted"
}

/** Wait for the transport's next connected report, with a bound. */
export function waitForHostReconnect(
  source: HostConnectionSource,
  timeoutMs = HOST_RECONNECT_WAIT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (connected: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unsubscribe()
      resolve(connected)
    }
    try {
      unsubscribe = source.subscribeConnectionStatus((status) => {
        if (status === "connected") queueMicrotask(() => finish(true))
      })
      timer = setTimeout(() => finish(false), timeoutMs)
    } catch {
      finish(false)
    }
  })
}

/** Keep the product SDK dependency inside the host doorway. */
export async function waitForSdkReconnect(timeoutMs = HOST_RECONNECT_WAIT_MS): Promise<boolean> {
  try {
    return waitForHostReconnect(await import("@parity/product-sdk-host"), timeoutMs)
  } catch {
    return false
  }
}

function resultError(value: unknown): unknown | null {
  const result = value as ResultLike
  return result?.ok === false ? result.error : null
}

export type HostRerun = { operation: string; attempt: number; reason: "host-interrupted"; waitedMs: number; error: unknown }

let recordRerun: (rerun: HostRerun) => void = () => {}

/** Telemetry hands in its record here, because telemetry reads host storage through this module. */
export function setHostRerunRecord(record: (rerun: HostRerun) => void): void {
  recordRerun = record
}

function logRerun(operation: string, startedAt: number, error: unknown): void {
  try {
    recordRerun({ operation, attempt: 2, reason: "host-interrupted", waitedMs: performance.now() - startedAt, error })
  } catch {}
}

/** Run an explicitly safe/idempotent host read, retrying at most once. */
export async function retrySafeHostRead<T>(
  source: HostConnectionSource,
  run: () => PromiseLike<T>,
  options: { errorOf?: (value: T) => unknown | null; reconnectWaitMs?: number; operation?: string } = {},
): Promise<T> {
  const errorOf = options.errorOf ?? resultError
  const operation = options.operation ?? "host-read"
  let first: T
  try {
    first = await run()
  } catch (error) {
    if (!isHostChannelInterruption(error)) throw error
    const startedAt = performance.now()
    if (!(await waitForHostReconnect(source, options.reconnectWaitMs))) throw error
    logRerun(operation, startedAt, error)
    return run()
  }
  const error = errorOf(first)
  if (!isHostChannelInterruption(error)) return first
  const startedAt = performance.now()
  if (!(await waitForHostReconnect(source, options.reconnectWaitMs))) return first
  logRerun(operation, startedAt, error)
  return run()
}

/** Wait for the fresh port before the first try, so the one rerun is not spent on a port known to be dead. */
export async function safeHostReadWhenConnected<T>(source: HostConnectionSource, run: () => PromiseLike<T>): Promise<T> {
  await waitForHostReconnect(source)
  return retrySafeHostRead(source, run)
}
