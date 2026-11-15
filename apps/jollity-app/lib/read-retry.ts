// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A chain read that fails, or never answers, is read again before anyone is told.
 *
 * The host can leave a request unanswered. truapi gives up on it only after 120
 * seconds, and product-sdk-host (checked on 0.24) never passes that failure on
 * to PAPI (paritytech/product-sdk#433), so the read would wait for ever. Each attempt
 * therefore gets a deadline, and a new attempt asks again with a new request, so
 * one lost answer costs a retry instead of a stalled screen.
 */
import { withTimeout } from "./with-timeout"

/** Five times a healthy chest read, which takes about three seconds on paseo. */
export const READ_ATTEMPT_MS = 15_000

/** The waits between attempts. Their count is the number of retries. */
export const READ_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000]

/** A read that neither answered nor failed within its deadline. */
export class ReadTimeoutError extends Error {
  constructor(ms: number) {
    super(`no answer after ${ms / 1000} seconds`)
    this.name = "ReadTimeoutError"
  }
}

class ReadAbortedError extends Error {
  constructor() {
    super("read aborted")
    this.name = "AbortError"
  }
}

/** Pure retry decisions. The host below owns promises, timers and abort
 * controllers; failures and elapsed waits arrive as events. */
export interface ReadRetryState {
  phase: "idle" | "reading" | "waiting" | "done"
  attempt: number
  delaysMs: readonly number[]
}

export type ReadRetryEvent<T = unknown> =
  | { kind: "start" }
  | { kind: "answered"; value: T }
  | { kind: "failed"; error: unknown }
  | { kind: "waited" }
  | { kind: "aborted"; reason: unknown }

export type ReadRetryCommand<T = unknown> =
  | { kind: "read"; attempt: number }
  | { kind: "retry"; error: unknown; retry: number; delayMs: number }
  | { kind: "resolve"; value: T }
  | { kind: "reject"; error: unknown }

export function startReadRetry(delaysMs: readonly number[] = READ_RETRY_DELAYS_MS): ReadRetryState {
  return { phase: "idle", attempt: 0, delaysMs }
}

export function readRetryStep<T>(
  state: ReadRetryState,
  event: ReadRetryEvent<T>,
): { state: ReadRetryState; commands: ReadRetryCommand<T>[] } {
  const stay = { state, commands: [] as ReadRetryCommand<T>[] }
  if (state.phase === "done") return stay
  if (event.kind === "aborted")
    return { state: { ...state, phase: "done" }, commands: [{ kind: "reject", error: event.reason }] }
  if (event.kind === "start") {
    if (state.phase !== "idle") return stay
    return { state: { ...state, phase: "reading", attempt: 1 }, commands: [{ kind: "read", attempt: 1 }] }
  }
  if (event.kind === "answered") {
    if (state.phase !== "reading") return stay
    return { state: { ...state, phase: "done" }, commands: [{ kind: "resolve", value: event.value }] }
  }
  if (event.kind === "failed") {
    if (state.phase !== "reading") return stay
    const delayMs = state.delaysMs[state.attempt - 1]
    if (delayMs === undefined)
      return { state: { ...state, phase: "done" }, commands: [{ kind: "reject", error: event.error }] }
    return {
      state: { ...state, phase: "waiting" },
      commands: [{ kind: "retry", error: event.error, retry: state.attempt, delayMs }],
    }
  }
  if (state.phase !== "waiting") return stay
  const attempt = state.attempt + 1
  return { state: { ...state, phase: "reading", attempt }, commands: [{ kind: "read", attempt }] }
}

function onlyReadRetryCommand<T>(commands: ReadRetryCommand<T>[]): ReadRetryCommand<T> {
  if (commands.length !== 1) throw new Error(`read retry machine emitted ${commands.length} commands`)
  return commands[0]!
}

export function readAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new ReadAbortedError()
}

export function waitForRead<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(readAbortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(readAbortReason(signal))
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

function waitDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  let timer: ReturnType<typeof setTimeout> | undefined
  return waitForRead(
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
    signal,
  ).finally(() => clearTimeout(timer))
}

/** Runs `read` until it answers within its deadline, and rejects with the last failure once the retries run out. */
export async function retryRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  options: {
    onRetry?: (error: unknown, retry: number, delayMs: number) => void
    attemptMs?: number
    delaysMs?: readonly number[]
    /** Aborts the current attempt and prevents another one from starting. */
    signal?: AbortSignal
  } = {},
): Promise<T> {
  const { onRetry, attemptMs = READ_ATTEMPT_MS, delaysMs = READ_RETRY_DELAYS_MS, signal } = options
  let machine = startReadRetry(delaysMs)
  const started = readRetryStep<T>(machine, { kind: "start" })
  machine = started.state
  let command = onlyReadRetryCommand(started.commands)
  for (;;) {
    if (command.kind !== "read") throw new Error("read retry machine expected a read command")
    if (signal?.aborted) {
      const aborted = readRetryStep<T>(machine, { kind: "aborted", reason: readAbortReason(signal) })
      machine = aborted.state
      const rejection = onlyReadRetryCommand(aborted.commands)
      if (rejection.kind !== "reject") throw new Error("read retry machine did not reject an abort")
      throw rejection.error
    }
    const attempt = new AbortController()
    const abortAttempt = () => attempt.abort(readAbortReason(signal!))
    signal?.addEventListener("abort", abortAttempt, { once: true })
    try {
      // boxed, so a read that answers null is not mistaken for the deadline
      const answer = await withTimeout(
        waitForRead(Promise.resolve().then(() => read(attempt.signal)), attempt.signal).then((value) => ({ value })),
        attemptMs,
      )
      if (answer === null) {
        const timeout = new ReadTimeoutError(attemptMs)
        attempt.abort(timeout)
        throw timeout
      }
      const settled = readRetryStep(machine, { kind: "answered", value: answer.value })
      machine = settled.state
      const resolved = onlyReadRetryCommand(settled.commands)
      if (resolved.kind !== "resolve") throw new Error("read retry machine did not resolve an answer")
      return resolved.value
    } catch (error) {
      if (signal?.aborted) {
        const aborted = readRetryStep<T>(machine, { kind: "aborted", reason: readAbortReason(signal) })
        machine = aborted.state
        const rejection = onlyReadRetryCommand(aborted.commands)
        if (rejection.kind !== "reject") throw new Error("read retry machine did not reject an abort")
        throw rejection.error
      }
      const failed = readRetryStep<T>(machine, { kind: "failed", error })
      machine = failed.state
      const decision = onlyReadRetryCommand(failed.commands)
      if (decision.kind === "reject") throw decision.error
      if (decision.kind !== "retry") throw new Error("read retry machine did not classify a failure")
      onRetry?.(decision.error, decision.retry, decision.delayMs)
      await waitDelay(decision.delayMs, signal)
      const waited = readRetryStep<T>(machine, { kind: "waited" })
      machine = waited.state
      command = onlyReadRetryCommand(waited.commands)
    } finally {
      signal?.removeEventListener("abort", abortAttempt)
      attempt.abort()
    }
  }
}
