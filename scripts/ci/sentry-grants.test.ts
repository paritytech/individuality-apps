// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFile } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { expectedGrants, judgeGrants } from "./check-grants.mjs"
import { githubRun, grantEvent, grantEvents, noResultsDetail, productLine, wrongSummary } from "./sentry-grants.mjs"
import { envelopeLines, stubSentry } from "./sentry-stub"

const want = expectedGrants('{"back-me-up":["context"],"dim2":["context","storage"],"dim2next":["context","storage"]}')
const TRACE = "0123456789abcdef0123456789abcdef"
const RUN_ENV = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "paritytech/individuality-apps",
  GITHUB_RUN_ID: "123456",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_WORKFLOW: "Humanity grants",
  GITHUB_REF_NAME: "main",
  GITHUB_SHA: "8c0824575",
}
const run = githubRun(RUN_ENV)

/** A wrong result as check-grants.mjs writes it, for a manifest granting `trustedProducts`. */
function wrong(name: string, trustedProducts: unknown) {
  const manifest = trustedProducts === null ? null : JSON.stringify({ $v: 1, trustedProducts })
  const { problems, ...grants } = judgeGrants({ manifest, want, floorLabel: "dim2" })
  return { name, outcome: "wrong", detail: problems.join("; "), expected: want, ...grants }
}

describe("githubRun", () => {
  it("links the run, and is null outside GitHub Actions", () => {
    expect(run).toEqual({
      run_url: "https://github.com/paritytech/individuality-apps/actions/runs/123456",
      attempt: "1",
      workflow: "Humanity grants",
      ref: "main",
      commit: "8c0824575",
    })
    expect(githubRun({})).toBeNull()
  })
})

describe("wrongSummary", () => {
  it("names, per product, the grants missing and extra", () => {
    expect(productLine({ missing: ["storage"], extra: [] })).toBe("missing storage")
    expect(productLine({ missing: ["context", "storage"], extra: ["chat"] })).toBe("missing context and storage, extra chat")
    expect(wrongSummary(wrong("peopl.paseo", { ...want, dim2: ["context"] }))).toBe("dim2 missing storage")
    expect(wrongSummary(wrong("peopl.paseo", { ...want, "back-me-up": ["context", "storage"], x: ["context"] }))).toBe(
      "back-me-up extra storage; x extra context",
    )
  })

  it("adds Jollity's floor when the variable itself drops it", () => {
    const loose = expectedGrants('{"dim2":["context"]}')
    const { problems, ...grants } = judgeGrants({ manifest: JSON.stringify({ trustedProducts: { dim2: ["context"] } }), want: loose, floorLabel: "dim2" })
    expect(wrongSummary({ name: "n", outcome: "wrong", detail: problems.join("; "), expected: loose, ...grants })).toBe(
      "dim2 lacks storage, which Jollity needs",
    )
  })

  it("says what the manifest lacks when it grants nothing", () => {
    expect(wrongSummary(wrong("peopl.paseo", null))).toBe("it has no manifest, so it grants nothing")
  })
})

describe("grantEvent", () => {
  const base = { slug: "humanity-grants", environment: "paseo", traceId: TRACE, run, now: 1_763_900_000_000, eventId: "e".repeat(32), spanId: "s".repeat(16) }

  it("makes a wrong grant one readable issue: name, expected and found, per product, and the run", () => {
    const event = grantEvent({ ...base, result: wrong("peopl.paseo", { ...want, dim2: ["context"], dim2next: ["context", "storage", "chat"] }) })
    expect(event).toEqual({
      event_id: "e".repeat(32),
      timestamp: 1_763_900_000,
      platform: "node",
      level: "error",
      logger: "humanity-grants",
      environment: "paseo",
      message: { formatted: "Grants wrong on peopl.paseo: dim2 missing storage; dim2next extra chat" },
      fingerprint: ["humanity-grants", "paseo", "peopl.paseo", "wrong"],
      tags: { "monitor.slug": "humanity-grants", "grants.outcome": "wrong", "grants.name": "peopl.paseo" },
      contexts: {
        monitor: { slug: "humanity-grants" },
        trace: { trace_id: TRACE, span_id: "s".repeat(16), op: "humanity-grants" },
        grants: {
          outcome: "wrong",
          name: "peopl.paseo",
          problem: expect.stringMatching(/^it grants .* but HUMANITY_TRUSTED_PRODUCTS is /),
          expected: '{"back-me-up":["context"],"dim2":["context","storage"],"dim2next":["context","storage"]}',
          found: '{"back-me-up":["context"],"dim2":["context"],"dim2next":["chat","context","storage"]}',
        },
        "grants by product": { dim2: "missing storage", dim2next: "extra chat" },
        "github run": run,
      },
    })
  })

  it("says found none when the manifest grants nothing", () => {
    const event = grantEvent({ ...base, result: wrong("peoplnext.paseo", null) })
    expect(event.contexts.grants.found).toBe("none")
    expect(event.contexts["grants by product"]).toEqual({ "back-me-up": "missing context", dim2: "missing context and storage", dim2next: "missing context and storage" })
  })

  it("carries the read error of a name that could not be read", () => {
    const event = grantEvent({ ...base, result: { name: "peopl.paseo", outcome: "unchecked", detail: "attempt 1: no answer within 90 s" } })
    expect(event.message.formatted).toBe("Could not check the grants of peopl.paseo: the manifest could not be read")
    expect(event.fingerprint).toEqual(["humanity-grants", "paseo", "peopl.paseo", "unchecked"])
    expect(event.contexts.grants).toEqual({ outcome: "unchecked", name: "peopl.paseo", read_error: "attempt 1: no answer within 90 s" })
  })

  it("clips a long title, and leaves the run out when there is none", () => {
    const long = { name: "n", outcome: "wrong", detail: "x".repeat(900), found: null }
    const event = grantEvent({ ...base, run: null, result: long })
    expect(event.message.formatted).toHaveLength(400)
    expect(event.contexts).not.toHaveProperty("github run")
  })
})

describe("grantEvents", () => {
  const base = { slug: "humanity-grants", environment: "paseo", traceId: TRACE, run }

  it("sends one event per name that is wrong or unread, and none for a right one", () => {
    const events = grantEvents(
      {
        outcome: "wrong",
        results: [
          { name: "peopl.paseo", outcome: "ok", detail: "fine" },
          wrong("peoplnext.paseo", {}),
          { name: "peopl.testnet", outcome: "unchecked", detail: "socket closed" },
        ],
      },
      base,
    )
    expect(events.map((e) => e.fingerprint)).toEqual([
      ["humanity-grants", "paseo", "peoplnext.paseo", "wrong"],
      ["humanity-grants", "paseo", "peopl.testnet", "unchecked"],
    ])
    expect(new Set(events.map((e) => e.event_id)).size).toBe(2)
    expect(events.every((e) => e.contexts.trace.trace_id === TRACE)).toBe(true)
    expect(grantEvents({ outcome: "ok", results: [{ name: "peopl.paseo", outcome: "ok", detail: "" }] }, base)).toEqual([])
  })

  it("sends one event for a run that compared nothing", () => {
    const [unset] = grantEvents({ outcome: "unchecked", error: "HUMANITY_TRUSTED_PRODUCTS is not set. Set the repo variable, then run the check again.", results: [] }, base)
    expect(unset!.message.formatted).toBe("Could not check the grants: HUMANITY_TRUSTED_PRODUCTS is not set. Set the repo variable, then run the check again.")
    expect(unset!.fingerprint).toEqual(["humanity-grants", "paseo", "(run)", "unchecked"])
    expect(unset!.tags).toEqual({ "monitor.slug": "humanity-grants", "grants.outcome": "unchecked" })
    const [stopped] = grantEvents(null, base)
    expect(stopped!.message.formatted).toBe("Could not check the grants: the check stopped before it read the names. See the failed step.")
  })

  it("words a missing results file by the outcome the check gave", () => {
    const [found] = grantEvents(null, { ...base, outcome: "wrong" })
    expect(found!.message.formatted).toBe("Could not check the grants: the check found wrong grants but wrote no results, so which names is unknown. See the run.")
    expect(found!.fingerprint).toEqual(["humanity-grants", "paseo", "(run)", "wrong"])
    const [unread] = grantEvents(null, { ...base, outcome: "unchecked" })
    expect(unread!.message.formatted).toMatch(/the check could not read every name but wrote no results/)
    expect(unread!.fingerprint).toEqual(["humanity-grants", "paseo", "(run)", "unchecked"])
    expect(noResultsDetail("")).toBe("the check stopped before it read the names. See the failed step.")
    expect(noResultsDetail(undefined)).toBe(noResultsDetail(""))
  })

  it("keeps the same failure in two environments as two issues", () => {
    const run = { outcome: "unchecked", error: "the dotns CLI could not be installed", results: [] }
    const [paseo] = grantEvents(run, base)
    const [previewnet] = grantEvents(run, { ...base, environment: "previewnet" })
    expect(paseo!.fingerprint).toEqual(["humanity-grants", "paseo", "(run)", "unchecked"])
    expect(previewnet!.fingerprint).toEqual(["humanity-grants", "previewnet", "(run)", "unchecked"])
    expect(previewnet!.environment).toBe("previewnet")
  })

  it("sends no event for a name not deployed since a reset", () => {
    expect(grantEvents({ outcome: "undeployed", results: [{ name: "peopl.testnet", outcome: "undeployed", detail: "gone" }] }, base)).toEqual([])
  })
})

describe("sentry-grants.mjs", () => {
  const script = join(__dirname, "sentry-grants.mjs")
  const dir = mkdtempSync(join(tmpdir(), "sentry-grants-"))
  const results = (content: unknown) => {
    const file = join(dir, `results-${Math.random()}.json`)
    writeFileSync(file, JSON.stringify(content))
    return file
  }
  const runScript = (env: Record<string, string>, file: string) =>
    promisify(execFile)(process.execPath, [script, "humanity-grants", file], { env: { PATH: process.env.PATH ?? "", ...RUN_ENV, ...env }, encoding: "utf8" })
  const twoBad = { outcome: "wrong", results: [wrong("peopl.paseo", { ...want, dim2: ["context"] }), { name: "peoplnext.paseo", outcome: "unchecked", detail: "attempt 1: socket closed" }] }

  it("skips with a warning when SENTRY_DSN is empty", async () => {
    const { stdout } = await runScript({ SENTRY_DSN: "" }, results(twoBad))
    expect(stdout).toBe("::warning title=No Sentry event::SENTRY_DSN is empty, so humanity-grants sent no detail of the grants.\n")
  })

  it("posts one event envelope per bad name, tied to the check-in's trace and the monitor", async () => {
    const server = await stubSentry(200)
    try {
      const { stdout } = await runScript({ SENTRY_DSN: server.dsn, CHECK_IN_ID: TRACE, SENTRY_ENVIRONMENT: "paseo" }, results(twoBad))
      expect(server.seen).toHaveLength(2)
      expect(server.seen.every((r) => r.url === "/api/42/envelope/" && r.method === "POST")).toBe(true)
      const [first, second] = server.seen.map((r) => envelopeLines(r.body))
      expect(first![0].event_id).toBe(first![2].event_id)
      expect(first![1]).toEqual({ type: "event" })
      expect(first![2]).toMatchObject({
        level: "error",
        environment: "paseo",
        message: { formatted: "Grants wrong on peopl.paseo: dim2 missing storage" },
        fingerprint: ["humanity-grants", "paseo", "peopl.paseo", "wrong"],
        contexts: {
          monitor: { slug: "humanity-grants" },
          trace: { trace_id: TRACE },
          "github run": { run_url: "https://github.com/paritytech/individuality-apps/actions/runs/123456" },
        },
      })
      expect(second![2].contexts.grants).toEqual({ outcome: "unchecked", name: "peoplnext.paseo", read_error: "attempt 1: socket closed" })
      expect(stdout).toMatch(/^Sentry event sent for peopl\.paseo \(wrong\) \(200\), event [0-9a-f]{32}\.\nSentry event sent for peoplnext\.paseo \(unchecked\) \(200\), event [0-9a-f]{32}\.\n$/)
    } finally {
      await server.close()
    }
  })

  it("sends one event for the run when the results file is missing", async () => {
    const server = await stubSentry(200)
    try {
      await runScript({ SENTRY_DSN: server.dsn, CHECK_IN_ID: TRACE }, join(dir, "none.json"))
      expect(server.seen).toHaveLength(1)
      expect(envelopeLines(server.seen[0]!.body)[2].message.formatted).toMatch(/^Could not check the grants: the check stopped before it read the names/)
    } finally {
      await server.close()
    }
  })

  it("words the event by OUTCOME when the check ended but wrote no results file", async () => {
    const server = await stubSentry(200)
    try {
      await runScript({ SENTRY_DSN: server.dsn, CHECK_IN_ID: TRACE, OUTCOME: "wrong" }, join(dir, "none.json"))
      expect(server.seen).toHaveLength(1)
      const event = envelopeLines(server.seen[0]!.body)[2]
      expect(event.message.formatted).toBe("Could not check the grants: the check found wrong grants but wrote no results, so which names is unknown. See the run.")
      expect(event.tags["grants.outcome"]).toBe("wrong")
    } finally {
      await server.close()
    }
  })

  it("warns and exits 0, sending nothing, when the results cannot be turned into events", async () => {
    const server = await stubSentry(200)
    try {
      for (const broken of [{ outcome: "wrong", results: "oops" }, { outcome: "wrong", results: [{ name: "peopl.paseo", outcome: "wrong", detail: "x", found: {}, products: [{ label: "dim2" }] }] }]) {
        const { stdout } = await runScript({ SENTRY_DSN: server.dsn }, results(broken))
        expect(stdout).toMatch(/^::warning title=Sentry events not sent::humanity-grants sent no detail of the grants: .+\n$/)
        expect(stdout).not.toContain("pubkey")
      }
      expect(server.seen).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it("sends nothing for a run whose names are all right", async () => {
    const server = await stubSentry(200)
    try {
      const { stdout } = await runScript({ SENTRY_DSN: server.dsn }, results({ outcome: "ok", results: [{ name: "peopl.paseo", outcome: "ok", detail: "" }] }))
      expect(server.seen).toHaveLength(0)
      expect(stdout).toBe("")
    } finally {
      await server.close()
    }
  })

  it("warns and exits 0 when Sentry answers with an error, and never prints the DSN", async () => {
    const server = await stubSentry(500)
    try {
      const { stdout } = await runScript({ SENTRY_DSN: server.dsn }, results(twoBad))
      expect(stdout).toBe(
        "::warning title=Sentry event not sent::humanity-grants peopl.paseo (wrong): Sentry answered 500\n" +
          "::warning title=Sentry event not sent::humanity-grants peoplnext.paseo (unchecked): Sentry answered 500\n",
      )
      expect(stdout).not.toContain("pubkey")
    } finally {
      await server.close()
    }
  })
})
