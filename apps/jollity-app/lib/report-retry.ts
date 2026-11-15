// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ReportVote } from "@jollity/protocol"
import type { ReportStatus } from "./report-missed"

export interface ReportRetrySource {
  nowSeconds: () => number
  reportStatus: (gameIndex: number) => Promise<Pick<ReportStatus, "closed" | "report">>
  submitReport: (report: ReportVote[][], signal?: AbortSignal) => Promise<void>
}

type ReportChainClosedAt = "pre-submit" | "watch" | "NoReporting"

/** "closed": report_ends passed on the source clock before the report
 *  landed. A chain-closed result retains which proof shut the attempt down:
 *  the status read before submit, the beside-watch poll, or the pallet's
 *  NoReporting refusal. The chain can close before report_ends (#596). */
export type ReportAttemptResult =
  | "sent"
  | "closed"
  | { kind: "chain-closed"; at: ReportChainClosedAt }

/** The pallet refused the report because its window is shut (NoReporting):
 *  the game left Reporting or report_ends passed. Not a reason to retry. */
export class ReportWindowClosedError extends Error {
  constructor() {
    super("NoReporting")
    this.name = "ReportWindowClosedError"
  }
}

/** how often an attempt re-reads the status while its watch stays open */
export const REPORT_STATUS_POLL_MS = 3_000

/** What one status read says about the report. A read that failed is its own
 *  word ("unread") so a failure is never mistaken for an open window; "sent"
 *  wins over "closed" because a landed report is the answer either way. */
export type ReportReadKind = "sent" | "closed" | "open" | "unread"

export function reportReadKind(status: Pick<ReportStatus, "closed" | "report"> | null): ReportReadKind {
  if (status === null) return "unread"
  if (status.report === "sent") return "sent"
  return status.closed ? "closed" : "open"
}

/** The attempt's pure core (state-machine house rule): no I/O, no clock. Time
 *  and every read arrive as event fields; side effects leave as commands that
 *  submitReportAttempt below runs. */
export type ReportAttemptOutcome = ReportAttemptResult | "failed"

export interface ReportAttemptState {
  phase: "idle" | "reading" | "watching" | "done"
  /** the submission settled by itself: nothing left to abort */
  submitSettled: boolean
  outcome: ReportAttemptOutcome | null
}

export type ReportAttemptEvent =
  | { kind: "start"; nowS: number; reportEnds: number }
  | { kind: "status"; read: ReportReadKind; nowS: number; reportEnds: number }
  | { kind: "submit-settled"; result: "ok" | "window-closed" | "failed" }
  | { kind: "poll"; read: ReportReadKind }
  | { kind: "deadline" }

export type ReportAttemptCommand =
  | { kind: "arm-deadline"; ms: number }
  | { kind: "read-status"; purpose: "first" | "poll" }
  | { kind: "submit" }
  | { kind: "schedule-poll"; ms: number }
  | { kind: "abort"; reason: "window" | "ended" }
  | { kind: "settle"; outcome: ReportAttemptOutcome }

export const startReportAttempt = (): ReportAttemptState => ({ phase: "idle", submitSettled: false, outcome: null })

export function reportAttemptStep(
  state: ReportAttemptState,
  event: ReportAttemptEvent,
): { state: ReportAttemptState; commands: ReportAttemptCommand[] } {
  const stay = { state, commands: [] as ReportAttemptCommand[] }
  /** the attempt is over: drop the watch if the submission is still pending */
  const finish = (
    outcome: ReportAttemptOutcome,
    submitSettled: boolean,
    abort: ReportAttemptCommand | null,
  ): { state: ReportAttemptState; commands: ReportAttemptCommand[] } => ({
    state: { phase: "done", submitSettled, outcome },
    commands: [...(abort === null ? [] : [abort]), { kind: "settle", outcome }],
  })
  const ended: ReportAttemptCommand = { kind: "abort", reason: "ended" }

  switch (event.kind) {
    case "start":
      if (state.phase !== "idle") return stay
      if (event.nowS >= event.reportEnds) return finish("closed", false, null)
      return {
        state: { ...state, phase: "reading" },
        commands: [
          { kind: "arm-deadline", ms: Math.max(1, (event.reportEnds - event.nowS) * 1000) },
          { kind: "read-status", purpose: "first" },
        ],
      }
    case "status":
      if (state.phase !== "reading") return stay
      if (event.read === "sent") return finish("sent", false, ended)
      // past Reporting the pallet can only refuse (NoReporting): file nothing
      if (event.read === "closed") return finish({ kind: "chain-closed", at: "pre-submit" }, false, ended)
      if (event.nowS >= event.reportEnds) return finish("closed", false, ended)
      return {
        state: { ...state, phase: "watching" },
        commands: [{ kind: "submit" }, { kind: "schedule-poll", ms: REPORT_STATUS_POLL_MS }],
      }
    case "submit-settled":
      if (state.phase !== "watching") return stay
      if (event.result === "ok") return finish("sent", true, null)
      if (event.result === "window-closed") return finish({ kind: "chain-closed", at: "NoReporting" }, true, null)
      return finish("failed", true, null)
    case "poll":
      if (state.phase !== "watching") return stay
      if (event.read === "sent") return finish("sent", false, ended)
      if (event.read === "closed") return finish({ kind: "chain-closed", at: "watch" }, false, ended)
      return { state, commands: [{ kind: "schedule-poll", ms: REPORT_STATUS_POLL_MS }] }
    case "deadline":
      if (state.phase !== "reading" && state.phase !== "watching") return stay
      return finish("closed", false, { kind: "abort", reason: "window" })
  }
}

/** One report attempt. It always re-reads the report's status first, then
 * keeps the submission's watch alive until report_ends. A healthy best-block
 * inclusion commonly takes 6–12 seconds, so elapsed time is never treated as
 * a failure while the report window remains open. Beside the open watch the
 * status is read again: a watch that hangs must not hide a report that landed
 * nor a chain that closed the window early (#596). The decisions live in
 * reportAttemptStep; this is the thin host that runs its commands. */
export function submitReportAttempt(
  source: ReportRetrySource,
  report: ReportVote[][],
  gameIndex: number,
  reportEnds: number,
): Promise<ReportAttemptResult> {
  const controller = new AbortController()
  let state = startReportAttempt()
  let failure: unknown
  let deadline: ReturnType<typeof setTimeout> | undefined
  let polling: ReturnType<typeof setTimeout> | undefined
  return new Promise<ReportAttemptResult>((resolve, reject) => {
    const readStatus = (purpose: "first" | "poll"): void => {
      void source
        .reportStatus(gameIndex)
        .catch(() => null)
        .then((status) => {
          const read = reportReadKind(status)
          dispatch(
            purpose === "first"
              ? { kind: "status", read, nowS: source.nowSeconds(), reportEnds }
              : { kind: "poll", read },
          )
        })
    }
    const run = (command: ReportAttemptCommand): void => {
      switch (command.kind) {
        case "arm-deadline":
          deadline = setTimeout(() => dispatch({ kind: "deadline" }), command.ms)
          break
        case "read-status":
          readStatus(command.purpose)
          break
        case "submit": {
          let submitted: Promise<void>
          try {
            submitted = source.submitReport(report, controller.signal)
          } catch (error) {
            submitted = Promise.reject(error)
          }
          submitted.then(
            () => dispatch({ kind: "submit-settled", result: "ok" }),
            (error: unknown) => {
              if (error instanceof ReportWindowClosedError) dispatch({ kind: "submit-settled", result: "window-closed" })
              else {
                failure = error
                dispatch({ kind: "submit-settled", result: "failed" })
              }
            },
          )
          break
        }
        case "schedule-poll":
          polling = setTimeout(() => readStatus("poll"), command.ms)
          break
        case "abort":
          // the transaction may still land, and the next status read sees it
          controller.abort(new Error(command.reason === "window" ? "the report window closed" : "the report attempt ended"))
          break
        case "settle":
          clearTimeout(deadline)
          clearTimeout(polling)
          if (command.outcome === "failed") reject(failure)
          else resolve(command.outcome)
          break
      }
    }
    const dispatch = (event: ReportAttemptEvent): void => {
      const step = reportAttemptStep(state, event)
      state = step.state
      step.commands.forEach(run)
    }
    dispatch({ kind: "start", nowS: source.nowSeconds(), reportEnds })
  })
}

export const REPORT_RETRY_MS = 1500
