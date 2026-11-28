// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeNetemRunner, NETEM_INCONCLUSIVE_EXIT, NetemError, runNetemProcess } from "./netem-runner"

const scriptFixture = (body: string): { path: string; remove: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "netem-runner-"))
  const path = join(dir, "fixture.sh")
  writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${body}\n`, { mode: 0o755 })
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("streaming netem runner", () => {
  it("preserves stdout while emitting lifecycle records from stdout only", async () => {
    const fixture = scriptFixture(`
printf '[netem] before\\n'
printf 'E2E_NETEM_PHASE\\tactive\\t%s\\n' "$1"
printf 'E2E_NETEM_PHASE\\trestored\\tstderr-spoof\\n' >&2
printf '[netem] after\\n'
`)
    const events: unknown[] = []
    try {
      const run = makeNetemRunner(fixture.path, { timeoutFor: () => 1_000 })
      const stdout = await run(["outage"], (event) => events.push(event))
      expect(stdout).toBe("[netem] before\nE2E_NETEM_PHASE\tactive\toutage\n[netem] after\n")
      expect(events).toEqual([{ state: "active", detail: "outage" }])
    } finally {
      fixture.remove()
    }
  })

  it("retains stdout, stderr and exit 64 on an inconclusive command", async () => {
    const fixture = scriptFixture(`
printf 'E2E_NETEM_PHASE\\tactive\\thost-chain-cut\\n'
printf '[netem] partial proof\\n'
printf '[netem] app side inconclusive\\n' >&2
exit ${NETEM_INCONCLUSIVE_EXIT}
`)
    try {
      const run = makeNetemRunner(fixture.path, { timeoutFor: () => 1_000 })
      const error = await run(["host-chain-cut"]).then(() => null, (value) => value)
      expect(error).toBeInstanceOf(NetemError)
      expect(error).toMatchObject({
        exitCode: NETEM_INCONCLUSIVE_EXIT,
        timedOut: false,
        stdout: expect.stringContaining("partial proof"),
        stderr: expect.stringContaining("app side inconclusive"),
      })
      expect(String(error)).toContain("INCONCLUSIVE")
    } finally {
      fixture.remove()
    }
  })

  it("kills a timed-out process and keeps the output produced before timeout", async () => {
    const fixture = scriptFixture(`
trap '' TERM
printf '[netem] waiting\\n'
while :; do sleep 1; done
`)
    try {
      const started = Date.now()
      const error = await runNetemProcess("bash", [fixture.path], { timeoutMs: 30, killGraceMs: 30 }).then(() => null, (value) => value)
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(error).toBeInstanceOf(NetemError)
      expect(error).toMatchObject({ exitCode: null, timedOut: true, stdout: "[netem] waiting\n" })
      expect(String(error)).toContain("timed out")
    } finally {
      fixture.remove()
    }
  })

  it("lets a timeout trap finish cleanup and emit its restored marker before force-kill", async () => {
    const fixture = scriptFixture(`
trap 'sleep 1.2; printf "E2E_NETEM_PHASE\\trestored\\toutage\\n"; exit 143' TERM
printf 'E2E_NETEM_PHASE\\tactive\\toutage\\n'
while :; do sleep 10; done
`)
    const events: unknown[] = []
    try {
      const started = Date.now()
      const error = await runNetemProcess("bash", [fixture.path], {
        timeoutMs: 30,
        onLifecycle: (event) => events.push(event),
      }).then(() => null, (value) => value)
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(error).toMatchObject({ timedOut: true })
      expect(events).toEqual([
        { state: "active", detail: "outage" },
        { state: "restored", detail: "outage" },
      ])
    } finally {
      fixture.remove()
    }
  })

  it("fails and terminates the child on a malformed stdout lifecycle record", async () => {
    const fixture = scriptFixture(`
printf 'E2E_NETEM_PHASE\\tactive\\toutage\\textra\\n'
sleep 10
`)
    try {
      const started = Date.now()
      const error = await runNetemProcess("bash", [fixture.path], { timeoutMs: 5_000, killGraceMs: 30 }).then(() => null, (value) => value)
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(error).toBeInstanceOf(NetemError)
      expect(String(error)).toContain("expected exactly three tab-separated fields")
    } finally {
      fixture.remove()
    }
  })
})
