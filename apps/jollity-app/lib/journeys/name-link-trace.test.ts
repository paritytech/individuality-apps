// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../telemetry", async () => (await import("../telemetry/testing")).fakeTelemetryModule())

import { journeysNamed, recorded, resetRecorded } from "../telemetry/testing"
import { traceNameLink } from "./name-link-trace"

beforeEach(() => resetRecorded())

describe("journey.name-link (#456)", () => {
  it("says what asked for the link: the background, or a Register tap waiting on it", () => {
    traceNameLink("register").end("already-linked")
    expect(journeysNamed("name-link")[0]?.attrs["name_link.trigger"]).toBe("register")
  })

  it("is a step per stage and ends linked, with what the deposit found", () => {
    const trace = traceNameLink()
    for (const stage of ["lookup", "funds", "sign", "store", "note", "verify"] as const) trace.stage(stage)
    trace.facts({
      "name_link.lookup_reason": "no-store",
      "name_link.already_linked": "false",
      "name_link.store": "none",
      "name_link.paid_in": "pgas",
    })
    trace.end("linked")

    const [journey] = journeysNamed("name-link")
    expect(journey.steps.map((step) => step.name)).toEqual(["lookup", "funds", "sign", "store", "note", "verify"])
    expect(journey.steps.every((step) => step.ended)).toBe(true)
    expect(journey.attrs).toMatchObject({
      "name_link.surface": "app",
      "name_link.trigger": "background",
      "name_link.lookup_reason": "no-store",
      "name_link.already_linked": "false",
      "name_link.store": "none",
      "name_link.paid_in": "pgas",
    })
    expect(journey.outcome).toBe("linked")
    expect(journey.endAttrs).toEqual({ "name_link.stage": "verify" })
    expect(recorded.failures).toEqual([])
  })

  it("sends an expected failure when the player declines the root's signature", () => {
    const trace = traceNameLink()
    trace.stage("lookup")
    trace.stage("funds")
    trace.stage("sign")
    trace.warned("the root did not sign the note", "Rejected")
    trace.end("not-signed")

    const [journey] = journeysNamed("name-link")
    expect(journey.outcome).toBe("not-signed")
    expect(journey.sad).toEqual(["not-signed"])
    expect(recorded.failures).toEqual([
      {
        kind: "name-link-failed",
        details: { reason: "not-signed", context: { stage: "sign", error: "the root did not sign the note: Rejected" } },
        journey: "name-link",
        expected: true,
      },
    ])
    expect(journey.attrs["journey.expected"]).toBe("true")
  })

  it("sends an expected failure when nobody owns the username", () => {
    const trace = traceNameLink()
    trace.stage("lookup")
    trace.stage("funds")
    trace.stage("sign")
    trace.warned("no account owns the username on the People chain")
    trace.end("unowned")

    const [journey] = journeysNamed("name-link")
    expect(journey.outcome).toBe("unowned")
    expect(journey.sad).toEqual(["unowned"])
    expect(recorded.failures).toEqual([
      {
        kind: "name-link-failed",
        details: { reason: "unowned", context: { stage: "sign", error: "no account owns the username on the People chain" } },
        journey: "name-link",
        expected: true,
      },
    ])
    expect(journey.attrs["journey.expected"]).toBe("true")
  })

  it("names the stage a failed link stopped in as the failure's reason", () => {
    const trace = traceNameLink()
    trace.stage("lookup")
    trace.stage("funds")
    trace.stage("sign")
    trace.stage("store")
    trace.stage("note")
    trace.warned("linking the name failed", "wrote the signed note: the dry run failed")
    trace.end("failed")

    expect(recorded.failures[0]).toMatchObject({ kind: "name-link-failed", details: { reason: "note" }, expected: false })
    expect(journeysNamed("name-link")[0].endAttrs).toEqual({ "name_link.stage": "note" })
  })

  it("reports unfunded at the deposit, not expected", () => {
    const trace = traceNameLink()
    trace.stage("lookup")
    trace.stage("funds")
    trace.facts({ "name_link.allowance": "not-allocated", "name_link.allowance_answer": "Rejected", "name_link.paid_in": "none" })
    trace.end("unfunded")

    expect(recorded.failures[0]).toMatchObject({ details: { reason: "unfunded", context: { stage: "funds" } }, expected: false })
    expect(journeysNamed("name-link")[0].attrs["name_link.allowance_answer"]).toBe("Rejected")
  })

  it("calls a throw before the link could answer a failure at setup", () => {
    traceNameLink().threw(new Error("no accounts provider"))

    expect(recorded.failures[0]).toMatchObject({ details: { reason: "setup", context: { stage: "setup" } } })
    expect(journeysNamed("name-link")[0].outcome).toBe("failed")
  })

  it("ends skipped, with why, and sends no failure", () => {
    traceNameLink().skipped("no-username")

    const [journey] = journeysNamed("name-link")
    expect(journey.outcome).toBe("skipped")
    expect(journey.endAttrs).toEqual({ "name_link.why": "no-username" })
    expect(recorded.failures).toEqual([])
  })

  it("sends nothing for an already linked account", () => {
    const trace = traceNameLink()
    trace.stage("lookup")
    trace.facts({ "name_link.lookup_reason": "named", "name_link.already_linked": "true" })
    trace.end("already-linked")

    expect(journeysNamed("name-link")[0]).toMatchObject({
      outcome: "already-linked",
      attrs: { "name_link.lookup_reason": "named", "name_link.already_linked": "true" },
    })
    expect(recorded.failures).toEqual([])
  })
})
