// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * DELIBERATE FAILURE EVENTS, one fixed kind each, so repeats group into one
 * issue per kind and reason (fingerprint `[kind, reason]`).
 *
 * EXPECTED failures (the player said no) go out as warnings with
 * `journey.expected: "true"`, and dashboards leave them out of the failure
 * rate. The whole rule is `isExpected`. RECOVERED cases (a retry, a
 * reconnect, a re-bind) are not failures at all: the journey is marked sad
 * and no event is sent.
 */
import * as Sentry from "@sentry/react"
import { describeError } from "../host/error-detail"
import { maskSafeValues } from "../journeys/mask-text"
import { isExpected, markExpected } from "./failure-policy"

export { isExpected, markExpected } from "./failure-policy"

export const FAILURE_KINDS = [
  "camera-unavailable",
  "permission-refused",
  "host-call-failed",
  "person-bind-failed",
  "signup-failed",
  "mesh-isolated",
  "peer-failed",
  "report-failed",
  "claim-failed",
  "prize-topup-failed",
  "attestations-late",
  "art-failed",
  "draw-unplayable",
  "draw-skipped",
  "name-link-failed",
  "render-crash",
  "clock-drift",
  "unclean-exit",
  "turn-unavailable",
  "own-key-missing",
] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]

export interface FailureDetails {
  /** the main reason: a fixed word, the second half of the fingerprint */
  reason: string
  /** the thrown value, when there is one: sent as the event's exception */
  error?: unknown
  /** more context, as text (an error message, a path, a hash) */
  context?: Record<string, string>
}

/** Whether one occurrence is a bug worth opening an issue for. */
export function isActionable(kind: FailureKind, details: Pick<FailureDetails, "reason">): boolean {
  switch (kind) {
    case "signup-failed":
    case "permission-refused":
    // a declined root signature or a name nobody owns is expected, a link that broke is not
    case "name-link-failed":
      return !isExpected(kind, details)
    case "camera-unavailable":
      return details.reason !== "denied" && details.reason !== "timeout"
    case "turn-unavailable":
      return details.reason === "bad-request" || details.reason === "proof-failed"
    // a refused read or a key nobody kept is this bug; a read that hung and a
    // player with no identifier on chain are not
    case "own-key-missing":
      return details.reason === "read-refused" || details.reason === "no-match"
    case "draw-skipped":
    case "mesh-isolated":
    case "peer-failed":
    case "attestations-late":
    case "clock-drift":
    case "unclean-exit":
      return false
    default:
      return true
  }
}

export { signupFailureReason } from "@individuality/sign-up/failure"

type Markable = {
  set(attrs: Record<string, string>): void
  trace?: { traceId: string; spanId: string } | null
  /** Internal journey seam: make its root active while a record is built. */
  __withActiveSpan?<T>(work: () => T): T
}

interface FailureDelivery {
  recordCount(name: string, value: number, attrs: Record<string, string>): void
  flushMetrics(): void
  logEvent(
    name: string,
    level: "info" | "warn",
    attributes: Record<string, string | number | boolean | undefined>,
    detail?: string,
  ): void
}

let delivery: FailureDelivery | null = null

/** Install the real delivery doorway without making this leaf import it. */
export function setFailureDelivery(next: FailureDelivery): void {
  delivery = next
}

export function sendFailure(kind: FailureKind, details: FailureDetails, journey?: Markable): void {
  const expected = isExpected(kind, details)
  markExpected(journey, expected)
  const currentDelivery = delivery
  if (!isActionable(kind, details) && currentDelivery) {
    const attrs = {
      "failure.kind": kind,
      "failure.reason": details.reason,
      "journey.expected": String(expected),
    }
    currentDelivery.recordCount("failure", 1, attrs)
    const sendLog = () =>
      currentDelivery.logEvent(
        `${kind}: ${details.reason}`,
        expected ? "info" : "warn",
        { ...maskSafeValues(details.context ?? {}), ...attrs },
        details.error === undefined ? undefined : describeError(details.error),
      )
    if (journey?.__withActiveSpan) journey.__withActiveSpan(sendLog)
    else sendLog()
    // Logs leave immediately, while the SDK normally buffers metrics for up
    // to five seconds. A post-game page can close inside that window (game
    // 821), leaving the failure Log without the metric paired with it.
    currentDelivery.flushMetrics()
    return
  }
  Sentry.withScope((scope) => {
    scope.setLevel(expected ? "warning" : "error")
    scope.setFingerprint([kind, details.reason])
    scope.setTags({
      "failure.kind": kind,
      "failure.reason": details.reason,
      "journey.expected": expected ? "true" : "false",
    })
    if (details.context) scope.setContext("failure", maskSafeValues(details.context))
    // a journey runs in its own trace (a game's, not the pageload's): the
    // event belongs to it, so it shows up beside the journey's spans
    if (journey?.trace) scope.setContext("trace", { trace_id: journey.trace.traceId, span_id: journey.trace.spanId })
    if (details.error instanceof Error) {
      Sentry.captureException(details.error)
      return
    }
    Sentry.captureEvent({
      message: `${kind}: ${details.reason}`,
      ...(details.error !== undefined ? { extra: { error: describeError(details.error) } } : {}),
    })
  })
}

const MAX_COMPONENT_STACK = 4_000

/** What the root error boundary reports: the error and React's component stack. */
export function renderCrashDetails(error: unknown, componentStack: string | null | undefined): FailureDetails {
  return {
    reason: "render",
    error,
    context: { component_stack: (componentStack ?? "").trim().slice(0, MAX_COMPONENT_STACK) },
  }
}
