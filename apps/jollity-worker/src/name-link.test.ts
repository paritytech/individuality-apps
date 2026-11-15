// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { PLAYER_NAME_KEY } from "@jollity/protocol"
import type { WorkerHost } from "./host"
import { linkNameFromChat, nameLinkTrace } from "./name-link"
import { configureTelemetry, resetTelemetry, type TelemetryConfig } from "./telemetry"

// no chain to reach: a link that gets this far had a username
vi.mock("./chain", () => ({ connect: async () => null, connectAssetHub: async () => null }))

const DSN = "https://abc@o1.ingest.de.sentry.io/42"
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** every event the worker sent, by its message or transaction name */
function sent(fetchImpl: { mock: { calls: unknown[][] } }) {
  return fetchImpl.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body.split("\n")[2]!) as { message?: string; transaction?: string; level?: string; tags: Record<string, string>; contexts?: Record<string, Record<string, string>> })
}

let fetchImpl: ReturnType<typeof vi.fn<NonNullable<TelemetryConfig["fetchImpl"]>>>
beforeEach(() => {
  resetTelemetry()
  fetchImpl = vi.fn<NonNullable<TelemetryConfig["fetchImpl"]>>(async () => ({ status: 200 }))
  configureTelemetry({ dsn: DSN, product: "dim2.paseo", fetchImpl })
})

describe("the chat's journey.name-link (#456)", () => {
  it("ends linked with the stage reached and the deposit's facts, and sends no failure", async () => {
    const trace = nameLinkTrace()
    for (const stage of ["lookup", "funds", "sign", "store", "note", "verify"] as const) trace.stage(stage)
    trace.facts({
      "name_link.lookup_reason": "no-store",
      "name_link.already_linked": "false",
      "name_link.store": "none",
      "name_link.paid_in": "pgas",
    })
    trace.end("linked")
    await flush()

    const events = sent(fetchImpl)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      transaction: "journey.name-link",
      tags: {
        "journey.outcome": "linked",
        "journey.sad": "false",
        "name_link.surface": "chat",
        "name_link.stage": "verify",
        "name_link.lookup_reason": "no-store",
        "name_link.already_linked": "false",
        "name_link.store": "none",
        "name_link.paid_in": "pgas",
        "name_link.sign_ms": expect.stringMatching(/^\d+$/),
      },
    })
  })

  it("sends an expected failure, a warning, when the player declines the root's signature", async () => {
    const trace = nameLinkTrace()
    trace.stage("lookup")
    trace.stage("funds")
    trace.stage("sign")
    trace.warned("the root did not sign the note", "Rejected")
    trace.end("not-signed")
    await flush()

    const failure = sent(fetchImpl).find((event) => event.message === "name-link-failed: not-signed")
    expect(failure).toMatchObject({
      level: "warning",
      tags: { "failure.kind": "name-link-failed", "failure.reason": "not-signed", "journey.expected": "true" },
      contexts: { failure: { stage: "sign", error: "the root did not sign the note: Rejected" } },
    })
    const journey = sent(fetchImpl).find((event) => event.transaction === "journey.name-link")
    expect(journey?.tags).toMatchObject({ "journey.outcome": "not-signed", "journey.sad_reason": "not-signed", "name_link.stage": "sign" })
  })

  it("sends an expected failure, a warning, when nobody owns the username", async () => {
    const trace = nameLinkTrace()
    trace.stage("lookup")
    trace.stage("funds")
    trace.stage("sign")
    trace.warned("no account owns the username on the People chain")
    trace.end("unowned")
    await flush()

    const failure = sent(fetchImpl).find((event) => event.message === "name-link-failed: unowned")
    expect(failure).toMatchObject({
      level: "warning",
      tags: { "failure.kind": "name-link-failed", "failure.reason": "unowned", "journey.expected": "true" },
      contexts: { failure: { stage: "sign", error: "no account owns the username on the People chain" } },
    })
    const journey = sent(fetchImpl).find((event) => event.transaction === "journey.name-link")
    expect(journey?.tags).toMatchObject({ "journey.outcome": "unowned", "journey.sad_reason": "unowned", "name_link.stage": "sign" })
  })

  it("names the stage a failed link stopped in, as an error", async () => {
    const trace = nameLinkTrace()
    trace.stage("lookup")
    trace.stage("funds")
    trace.stage("sign")
    trace.stage("store")
    trace.end("failed")
    await flush()

    expect(sent(fetchImpl).find((event) => event.message)).toMatchObject({ message: "name-link-failed: store", level: "error" })
  })

  it("masks the host's own allowance answer", async () => {
    const trace = nameLinkTrace()
    trace.facts({ "name_link.allowance_answer": "Unauthorized" })
    trace.end("unfunded")
    await flush()

    const journey = sent(fetchImpl).find((event) => event.transaction === "journey.name-link")
    expect(journey?.tags["name_link.allowance_answer"]).toBe("Unau*horized")
  })

  it("ends skipped with why, and no failure", async () => {
    nameLinkTrace().skipped("no-username")
    await flush()

    const events = sent(fetchImpl)
    expect(events).toHaveLength(1)
    expect(events[0]?.tags).toMatchObject({ "journey.outcome": "skipped", "name_link.why": "no-username", "name_link.stage": "setup" })
  })

  it("records why the existing note is named and that the root decision stopped the link", async () => {
    const trace = nameLinkTrace()
    trace.stage("lookup")
    trace.facts({ "name_link.lookup_reason": "named", "name_link.already_linked": "true" })
    trace.end("already-linked")
    await flush()

    const journey = sent(fetchImpl).find((event) => event.transaction === "journey.name-link")
    expect(journey?.tags).toMatchObject({
      "journey.outcome": "already-linked",
      "name_link.lookup_reason": "named",
      "name_link.already_linked": "true",
      "name_link.stage": "lookup",
    })
  })
})

describe("the chat's link takes the username", () => {
  const hostWith = (userName: string | null, stored: unknown) =>
    ({
      accounts: {
        userName: vi.fn(async () => userName),
        signAsRoot: vi.fn(),
        signer: vi.fn(async () => null),
      },
      productAccount: vi.fn(async () => null),
      storage: { readJSON: vi.fn(async (key: string) => (key === PLAYER_NAME_KEY ? stored : null)) },
    }) as unknown as WorkerHost

  it("from the host, else from the name the app stored for the worker, and says what started it", async () => {
    const fromHost = await linkNameFromChat(hostWith("alice.01", null), { name: "dim2.paseo", index: 1 }, undefined, "register")
    const fromStore = await linkNameFromChat(hostWith(null, "bob.02"), { name: "dim2.paseo", index: 1 })
    await flush()

    // both got past the username, to the chain the test leaves out
    expect([fromHost, fromStore]).toEqual(["skipped", "skipped"])
    expect(sent(fetchImpl).map((event) => [event.tags["name_link.why"], event.tags["name_link.trigger"]])).toEqual([
      ["no-chain", "register"],
      ["no-chain", "background"],
    ])
  })

  it("skips with no-username when neither the host nor the store has one", async () => {
    const outcome = await linkNameFromChat(hostWith(null, null), { name: "dim2.paseo", index: 1 })
    await flush()

    expect(outcome).toBe("skipped")
    expect(sent(fetchImpl)[0]?.tags["name_link.why"]).toBe("no-username")
  })
})
