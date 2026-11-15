// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * journey.name-link — the player's username linked to their jollity account
 * (#456, lib/draw/name-link.ts), in the background from app open: the social
 * half of the prize draw, since a ticket on the wheel shows a name only once
 * its holder has made this link.
 *
 * A step per `linkName` stage (lookup, funds, sign, store, note, verify), so
 * the `sign` step's duration is the time the player took to confirm the root's
 * signature, and `name_link.stage` names the step a link stopped in. The facts
 * the link reports (`name_link.lookup_reason`, `name_link.already_linked`,
 * `name_link.store`, `name_link.allowance`, `name_link.paid_in`) are
 * attributes. The outcomes are `linkName`'s, plus `skipped` with
 * `name_link.why` when there was nothing to link with.
 *
 * A link that stops short sends one `name-link-failed` event: reason
 * `not-signed` (expected: the player declined), `unowned` (expected: nobody
 * owns the name), `unfunded`, or, for `failed`, the stage it stopped in, with
 * the last warning the link logged. Every attribute is text. Framework-free,
 * and never throws.
 */
import type { LinkOutcome, LinkStage } from "@individuality/name-link"
import { describeError } from "../host/error-detail"
import { reportFailure, startJourney, type Step } from "../telemetry"
import { maskSafeValues } from "./mask-text"

/** why a link never started: no host accounts, no username from the host, no chain to reach */
export type NameLinkSkip = "no-host" | "no-username" | "no-chain"

export interface NameLinkTrace {
  /** `linkName`'s onStage */
  stage(stage: LinkStage): void
  /** `linkName`'s onFacts */
  facts(facts: Record<string, string>): void
  /** a warning the link logged: the failure event's error, should the link fail */
  warned(message: string, detail?: unknown): void
  skipped(why: NameLinkSkip): void
  end(outcome: LinkOutcome): void
  /** the link threw before `linkName` could answer (a host call while setting up) */
  threw(error: unknown): void
}

/** the most of an error a failure event carries */
const MAX_ERROR = 300

/** `trigger` goes on the journey as `name_link.trigger`: `background` (the
 *  source, on its own) or `register` (a Register tap waiting on it). */
export function traceNameLink(trigger: "background" | "register" = "background"): NameLinkTrace {
  const journey = startJourney("name-link", { "name_link.surface": "app", "name_link.trigger": trigger })
  let step: Step | null = null
  let stage: LinkStage | "setup" = "setup"
  let warning = "none"

  const finish = (outcome: LinkOutcome, error?: string) => {
    step?.end({ "step.outcome": outcome })
    step = null
    if (outcome === "unfunded" || outcome === "not-signed" || outcome === "unowned" || outcome === "failed") {
      const reason = outcome === "failed" ? stage : outcome
      journey.markSad(reason)
      reportFailure("name-link-failed", { reason, context: { stage, error: (error ?? warning).slice(0, MAX_ERROR) } }, journey)
    }
    journey.end(outcome, { "name_link.stage": stage })
  }

  return {
    stage(next) {
      step?.end()
      stage = next
      step = journey.step(next)
    },
    facts(found) {
      journey.set(maskSafeValues(found))
    },
    warned(message, detail) {
      warning = detail === undefined ? message : `${message}: ${typeof detail === "string" ? detail : describeError(detail)}`
    },
    skipped(why) {
      journey.end("skipped", { "name_link.why": why })
    },
    end(outcome) {
      finish(outcome)
    },
    threw(error) {
      finish("failed", describeError(error))
    },
  }
}
