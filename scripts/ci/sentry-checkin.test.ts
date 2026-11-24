// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { checkInItem, envelope, envelopeTarget, traceIdFor } from "./sentry-checkin.mjs"
import { envelopeLines, stubSentry } from "./sentry-stub"

const DSN = "https://abc123@o42.ingest.de.sentry.io/4507"

describe("envelopeTarget", () => {
  it("builds the envelope endpoint from the DSN's host and project, and keeps the key apart", () => {
    expect(envelopeTarget(DSN)).toEqual({ url: "https://o42.ingest.de.sentry.io/api/4507/envelope/", key: "abc123" })
  })

  it("keeps a path prefix of a self-hosted DSN", () => {
    expect(envelopeTarget("https://k@sentry.example.com/sub/7")?.url).toBe("https://sentry.example.com/sub/api/7/envelope/")
  })

  it("refuses a value that is not a DSN", () => {
    expect(envelopeTarget("")).toBeNull()
    expect(envelopeTarget("https://o42.ingest.sentry.io/4507")).toBeNull()
    expect(envelopeTarget("https://k@o42.ingest.sentry.io/")).toBeNull()
  })
})

describe("checkInItem", () => {
  const config = { schedule: { type: "crontab", value: "23 * * * *" }, checkin_margin: 45 }
  const trace = "0123456789abcdef0123456789abcdef"

  it("sends the monitor's config with in_progress, so the check-in creates or updates it", () => {
    const item = checkInItem({ slug: "humanity-grants", status: "in_progress", checkInId: "id1", environment: "paseo", monitorConfig: config, traceId: trace })
    expect(item).toEqual({
      type: "check_in",
      payload: {
        check_in_id: "id1",
        monitor_slug: "humanity-grants",
        status: "in_progress",
        environment: "paseo",
        monitor_config: config,
        contexts: { trace: { trace_id: trace } },
      },
    })
  })

  it("closes the same check-in with its result and duration, without the config", () => {
    const item = checkInItem({ slug: "humanity-grants", status: "error", checkInId: "id1", durationSeconds: 42, monitorConfig: config })
    expect(item.payload).toEqual({ check_in_id: "id1", monitor_slug: "humanity-grants", status: "error", environment: "production", duration: 42 })
  })

  it("refuses an unknown status", () => {
    expect(() => checkInItem({ slug: "m", status: "missed" })).toThrow(/status must be/)
  })
})

describe("envelope", () => {
  it("writes the header, then each item's header and payload, one JSON line each", () => {
    const body = envelope({ sent_at: "t" }, [{ type: "check_in", payload: { a: 1 } }])
    expect(body).toBe('{"sent_at":"t"}\n{"type":"check_in"}\n{"a":1}\n')
  })
})

describe("traceIdFor", () => {
  it("uses the check-in id as the run's trace id, and a fresh one when it is not 32 hex digits", () => {
    expect(traceIdFor("0123456789ABCDEF0123456789abcdef")).toBe("0123456789abcdef0123456789abcdef")
    for (const id of [undefined, "", "abc", "0123456789abcdef-0123456789abcdef"]) expect(traceIdFor(id)).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe("sentry-checkin.mjs", () => {
  const script = join(__dirname, "sentry-checkin.mjs")
  const run = (env: Record<string, string>, args = ["humanity-grants", "ok"]) =>
    promisify(execFile)(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" })

  const sentry = stubSentry

  it("skips with a warning when SENTRY_DSN is empty", async () => {
    const { stdout } = await run({ SENTRY_DSN: "" })
    expect(stdout).toBe("::warning title=No Sentry check-in::SENTRY_DSN is empty, so humanity-grants was not told ok.\n")
  })

  it("posts the check-in to the DSN's envelope endpoint, with the check-in id as its trace", async () => {
    const server = await sentry(200)
    const id = "0123456789abcdef0123456789abcdef"
    try {
      const { stdout } = await run(
        { SENTRY_DSN: server.dsn, CHECK_IN_ID: id, SENTRY_ENVIRONMENT: "paseo", MONITOR_CONFIG: '{"schedule":{"type":"crontab","value":"23 * * * *"}}' },
        ["humanity-grants", "in_progress"],
      )
      expect(stdout).toBe(`Sentry check-in in_progress sent for humanity-grants (200), trace ${id}.\n`)
      expect(server.seen).toHaveLength(1)
      const [request] = server.seen
      expect(request!.method).toBe("POST")
      expect(request!.url).toBe("/api/42/envelope/")
      expect(request!.type).toBe("application/x-sentry-envelope")
      expect(request!.auth).toBe("Sentry sentry_version=7, sentry_client=individuality-ci/1.0, sentry_key=pubkey")
      const [header, item, payload] = envelopeLines(request!.body)
      expect(Object.keys(header)).toEqual(["sent_at"])
      expect(item).toEqual({ type: "check_in" })
      expect(payload).toEqual({
        check_in_id: id,
        monitor_slug: "humanity-grants",
        status: "in_progress",
        environment: "paseo",
        monitor_config: { schedule: { type: "crontab", value: "23 * * * *" } },
        contexts: { trace: { trace_id: id } },
      })
    } finally {
      await server.close()
    }
  })

  it("sends the duration with the closing check-in", async () => {
    const server = await sentry(200)
    try {
      const started = String(Math.round(Date.now() / 1000) - 30)
      await run({ SENTRY_DSN: server.dsn, CHECK_IN_ID: "0123456789abcdef0123456789abcdef", CHECK_IN_STARTED: started }, ["humanity-grants", "ok"])
      const payload = envelopeLines(server.seen[0]!.body)[2]
      expect(payload.status).toBe("ok")
      expect(payload.duration).toBeGreaterThanOrEqual(30)
      expect(payload.duration).toBeLessThan(40)
      expect(payload.monitor_config).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it("warns and exits 0 when Sentry answers with an error, and never prints the DSN", async () => {
    const server = await sentry(500)
    try {
      const { stdout } = await run({ SENTRY_DSN: server.dsn, CHECK_IN_ID: "0123456789abcdef0123456789abcdef" }, ["humanity-grants", "error"])
      expect(stdout).toBe("::warning title=Sentry check-in not sent::humanity-grants error: Sentry answered 500\n")
      expect(stdout).not.toContain("pubkey")
    } finally {
      await server.close()
    }
  })

  it("warns and exits 0 when Sentry cannot be reached", async () => {
    const server = await sentry(200)
    await server.close()
    const { stdout } = await run({ SENTRY_DSN: server.dsn }, ["humanity-grants", "ok"])
    expect(stdout).toMatch(/^::warning title=Sentry check-in not sent::humanity-grants ok: /)
  })
})
