// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFile } from "node:child_process"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { checkInRequest, cronUrl } from "./sentry-checkin.mjs"

const DSN = "https://abc123@o42.ingest.de.sentry.io/4507"

describe("cronUrl", () => {
  it("builds the check-in endpoint from the DSN's host, project and public key", () => {
    expect(cronUrl(DSN, "humanity-grants")).toBe("https://o42.ingest.de.sentry.io/api/4507/cron/humanity-grants/abc123/")
  })

  it("keeps a path prefix of a self-hosted DSN", () => {
    expect(cronUrl("https://k@sentry.example.com/sub/7", "m")).toBe("https://sentry.example.com/sub/api/7/cron/m/k/")
  })

  it("refuses a value that is not a DSN", () => {
    expect(cronUrl("", "m")).toBeNull()
    expect(cronUrl("https://o42.ingest.sentry.io/4507", "m")).toBeNull()
    expect(cronUrl("https://k@o42.ingest.sentry.io/", "m")).toBeNull()
  })
})

describe("checkInRequest", () => {
  const config = { schedule: { type: "crontab", value: "23 * * * *" }, checkin_margin: 45 }

  it("sends the monitor's config with in_progress, so the check-in creates or updates it", () => {
    const r = checkInRequest({ dsn: DSN, slug: "humanity-grants", status: "in_progress", checkInId: "id1", environment: "paseo", monitorConfig: config })
    expect(r.url).toBe("https://o42.ingest.de.sentry.io/api/4507/cron/humanity-grants/abc123/?status=in_progress&environment=paseo&check_in_id=id1")
    expect(r.body).toEqual({ status: "in_progress", environment: "paseo", check_in_id: "id1", monitor_config: config })
  })

  it("closes the same check-in with its result and duration, without the config", () => {
    const r = checkInRequest({ dsn: DSN, slug: "humanity-grants", status: "error", checkInId: "id1", durationSeconds: 42, monitorConfig: config })
    expect(r.body).toEqual({ status: "error", environment: "production", check_in_id: "id1", duration: 42 })
    expect(r.url).toContain("status=error&environment=production&check_in_id=id1&duration=42")
  })

  it("refuses an unknown status or a bad DSN", () => {
    expect(() => checkInRequest({ dsn: DSN, slug: "m", status: "missed" })).toThrow(/status must be/)
    expect(() => checkInRequest({ dsn: "nope", slug: "m", status: "ok" })).toThrow(/not a DSN/)
  })
})

describe("sentry-checkin.mjs", () => {
  const script = join(__dirname, "sentry-checkin.mjs")
  const run = (env: Record<string, string>, args = ["humanity-grants", "ok"]) =>
    promisify(execFile)(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" })

  /** A stand-in Sentry that answers every request with `status` and records what it got. */
  async function sentry(status: number) {
    const seen: Array<{ method?: string; url?: string; body: string }> = []
    const server = createServer((req: IncomingMessage, res) => {
      let body = ""
      req.on("data", (d) => (body += d))
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body })
        res.writeHead(status).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    return { dsn: `http://pubkey@127.0.0.1:${port}/42`, seen, close: () => new Promise((resolve) => server.close(resolve)) }
  }

  it("skips with a warning when SENTRY_DSN is empty", async () => {
    const { stdout } = await run({ SENTRY_DSN: "" })
    expect(stdout).toBe("::warning title=No Sentry check-in::SENTRY_DSN is empty, so humanity-grants was not told ok.\n")
  })

  it("posts the check-in to the DSN's cron endpoint", async () => {
    const server = await sentry(202)
    try {
      const { stdout } = await run(
        { SENTRY_DSN: server.dsn, CHECK_IN_ID: "abc", SENTRY_ENVIRONMENT: "paseo", MONITOR_CONFIG: '{"schedule":{"type":"crontab","value":"23 * * * *"}}' },
        ["humanity-grants", "in_progress"],
      )
      expect(stdout).toBe("Sentry check-in in_progress sent for humanity-grants (202).\n")
      expect(server.seen).toHaveLength(1)
      expect(server.seen[0]!.method).toBe("POST")
      expect(server.seen[0]!.url).toBe("/api/42/cron/humanity-grants/pubkey/?status=in_progress&environment=paseo&check_in_id=abc")
      expect(JSON.parse(server.seen[0]!.body).monitor_config.schedule.value).toBe("23 * * * *")
    } finally {
      await server.close()
    }
  })

  it("warns and exits 0 when Sentry answers with an error, and never prints the DSN", async () => {
    const server = await sentry(500)
    try {
      const { stdout } = await run({ SENTRY_DSN: server.dsn, CHECK_IN_ID: "abc" }, ["humanity-grants", "error"])
      expect(stdout).toBe("::warning title=Sentry check-in not sent::humanity-grants error: Sentry answered 500\n")
      expect(stdout).not.toContain("pubkey")
    } finally {
      await server.close()
    }
  })

  it("warns and exits 0 when Sentry cannot be reached", async () => {
    const server = await sentry(202)
    await server.close()
    const { stdout } = await run({ SENTRY_DSN: server.dsn }, ["humanity-grants", "ok"])
    expect(stdout).toMatch(/^::warning title=Sentry check-in not sent::humanity-grants ok: /)
  })
})
