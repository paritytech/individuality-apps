// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./telemetry", async () => (await import("./telemetry/testing")).fakeTelemetryModule())

import type { PermissionId, PermissionResult } from "./permissions"
import { runAlone, runPermissionPass } from "./permission-pass"
import { isMaskSafe, journeysNamed, recorded, resetRecorded } from "./telemetry/testing"

const ITEMS: PermissionId[] = ["camera", "network", "webrtc", "statements"]
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

function pass(
  answers: Partial<Record<PermissionId, PermissionResult>>,
  turn: Promise<void> | null = Promise.resolve(),
  over: Partial<Parameters<typeof runPermissionPass>[0]> = {},
) {
  return runPermissionPass({
    items: ITEMS,
    request: async (id) => answers[id] ?? { ok: true },
    turnIssue: () => turn,
    turnReceived: () => true,
    onAsking: () => {},
    onResult: () => {},
    requestTelemetry: async () => true,
    ...over,
  })
}

beforeEach(() => resetRecorded())

describe("journey.permissions", () => {
  it("ends granted with a step per prompt and the TURN issue after the network grant", async () => {
    await expect(pass({})).resolves.toEqual({ allGranted: true, cameraBlocked: false })
    await flush()
    const [journey] = journeysNamed("permissions")
    expect(journey.steps.map((step) => step.name)).toEqual(["camera", "network", "network.turn-receipt", "webrtc", "statements"])
    expect(journey.steps.find((step) => step.name === "network.turn-receipt")?.endAttrs).toEqual({ "turn.received": "true" })
    expect(journey.outcome).toBe("granted")
    expect(recorded.failures).toHaveLength(0)
  })

  it("waits for the TURN issue before ending, without holding the page", async () => {
    let finish: () => void = () => {}
    const turn = new Promise<void>((resolve) => (finish = resolve))
    await pass({}, turn)
    expect(journeysNamed("permissions")[0].ended).toBe(false)
    finish()
    await flush()
    expect(journeysNamed("permissions")[0].outcome).toBe("granted")
  })

  it("asks for telemetry right after the network grant, before the next prompt, and records the answer", async () => {
    const order: string[] = []
    await pass({}, null, {
      request: async (id) => (order.push(id), { ok: true }),
      requestTelemetry: async () => (order.push("telemetry"), true),
    })
    await flush()
    expect(order).toEqual(["camera", "network", "telemetry", "webrtc", "statements"])
    expect(journeysNamed("permissions")[0].attrs["telemetry.grant"]).toBe("granted")
  })

  it("never fails the pass over a refused, failed or throwing telemetry grant", async () => {
    for (const requestTelemetry of [
      async () => false,
      async () => {
        throw new Error("host went away")
      },
    ]) {
      resetRecorded()
      await expect(pass({}, null, { requestTelemetry })).resolves.toEqual({ allGranted: true, cameraBlocked: false })
      await flush()
      expect(recorded.failures).toHaveLength(0)
      expect(journeysNamed("permissions")[0].outcome).toBe("granted")
    }
    expect(journeysNamed("permissions")[0].attrs["telemetry.grant"]).toBe("refused")
  })

  it("does not ask for telemetry when the network step was refused", async () => {
    const requestTelemetry = vi.fn(async () => true)
    await pass({ network: { ok: false, reason: "denied" } }, null, { requestTelemetry })
    expect(requestTelemetry).not.toHaveBeenCalled()
  })

  it("reports a refused camera as expected, and ends refused with the step and reason", async () => {
    await expect(pass({ camera: { ok: false, reason: "blocked" } }, null)).resolves.toEqual({ allGranted: false, cameraBlocked: true })
    await flush()
    const [journey] = journeysNamed("permissions")
    expect(recorded.failures).toEqual([
      expect.objectContaining({ kind: "permission-refused", details: expect.objectContaining({ reason: "camera.blocked" }), expected: true }),
    ])
    expect(journey.outcome).toBe("refused")
    expect(journey.endAttrs).toEqual({ "permissions.step": "camera", "permissions.reason": "blocked" })
    expect(journey.attrs["journey.expected"]).toBe("true")
  })

  it("reports a failed host call as host-call-failed, never expected", async () => {
    await pass({ statements: { ok: false, reason: "host-error", step: "allocation" } })
    await flush()
    expect(recorded.failures).toEqual([
      expect.objectContaining({ kind: "host-call-failed", details: expect.objectContaining({ reason: "statements.allocation" }), expected: false }),
    ])
    expect(journeysNamed("permissions")[0].attrs["journey.expected"]).toBe("false")
  })

  it("counts an unanswered host modal as the player's refusal", async () => {
    await pass({ network: { ok: false, reason: "timeout" } })
    await flush()
    expect(recorded.failures[0]).toMatchObject({ kind: "permission-refused", details: { reason: "network.timeout" }, expected: true })
    expect(journeysNamed("permissions")[0].steps.map((step) => step.name)).not.toContain("network.turn-receipt")
  })
})

describe("an automatic pass", () => {
  it("files no refusal the player already gave, and says it was not tapped", async () => {
    await expect(pass({ camera: { ok: false, reason: "blocked" } }, null, { automatic: true })).resolves.toEqual({
      allGranted: false,
      cameraBlocked: true,
    })
    await flush()
    expect(recorded.failures).toHaveLength(0)
    expect(journeysNamed("permissions")[0].attrs["permissions.trigger"]).toBe("auto")
    expect(journeysNamed("permissions")[0].outcome).toBe("refused")
  })

  it("marks no row as asking, and still hands every answer back", async () => {
    const asked: PermissionId[] = []
    const answered: PermissionId[] = []
    await pass({}, null, { automatic: true, onAsking: (id) => asked.push(id), onResult: (id) => answered.push(id) })
    expect(asked).toEqual([])
    expect(answered).toEqual(ITEMS)
  })

  it("still reports a failed host call", async () => {
    await pass({ statements: { ok: false, reason: "host-error", step: "allocation" } }, null, { automatic: true })
    expect(recorded.failures).toEqual([expect.objectContaining({ kind: "host-call-failed" })])
  })

  it("leaves a tapped pass marked as tapped, asking row by row", async () => {
    const asked: PermissionId[] = []
    await pass({}, null, { onAsking: (id) => asked.push(id) })
    expect(asked).toEqual(ITEMS)
    expect(journeysNamed("permissions")[0].attrs["permissions.trigger"]).toBe("tap")
  })

  it.each(["permissions.trigger", "auto", "tap"])("keeps %s clear of the masked words", (literal) => {
    expect(isMaskSafe(literal)).toBe(true)
  })
})

describe("runAlone", () => {
  function heldRuns() {
    const finishes: Array<() => void> = []
    const run = vi.fn(() => new Promise<void>((resolve) => finishes.push(resolve)))
    const finishNext = async () => {
      finishes.shift()?.()
      await flush()
    }
    return { run, finishNext }
  }

  it("starts one run for two calls in the same tick", async () => {
    const flag = { current: false }
    const { run, finishNext } = heldRuns()
    const first = runAlone(flag, run)
    const second = runAlone(flag, run)
    expect(run).toHaveBeenCalledTimes(1)
    await finishNext()
    await Promise.all([first, second])
    expect(run).toHaveBeenCalledTimes(1)
    expect(flag.current).toBe(false)
  })

  it("drops a call that came during a run", async () => {
    const flag = { current: false }
    const { run, finishNext } = heldRuns()
    const first = runAlone(flag, run)
    await flush()
    await runAlone(flag, run)
    await finishNext()
    await first
    expect(run).toHaveBeenCalledTimes(1)
    expect(flag.current).toBe(false)
  })

  it("runs again once the run before it ended, even when that run threw", async () => {
    const flag = { current: false }
    await expect(runAlone(flag, async () => Promise.reject(new Error("host went away")))).rejects.toThrow("host went away")
    const run = vi.fn(async () => {})
    await runAlone(flag, run)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
