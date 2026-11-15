// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const storage = vi.hoisted(() => ({ values: new Map<string, string | null>(), failed: new Set<string>() }))

vi.mock("../host/storage", () => ({
  tryReadStoredString: async (key: string) =>
    storage.failed.has(key) ? { ok: false as const } : { ok: true as const, value: storage.values.get(key) ?? null },
}))

import { readWorkerEvidence } from "./worker-evidence"

beforeEach(() => {
  storage.values.clear()
  storage.failed.clear()
})

describe("worker evidence export", () => {
  it("keeps the bounded diagnostic log and exports only redacted booking metadata", async () => {
    storage.values.set(
      "jollity.wg.workerLog",
      JSON.stringify([
        { time: 100, kind: "success", text: "Notification permission granted." },
        {
          time: 200,
          kind: "error",
          text: "seed: abandon ability able about above absent absorb abstract absurd abuse access accident",
        },
      ]),
    )
    storage.values.set(
      "jollity.wg.notifs",
      JSON.stringify({ gamePlayTime: 300, registered: true, ids: [41, 42, "bad"], complete: false, retryAt: 400 }),
    )

    const evidence = await readWorkerEvidence()

    expect(evidence).toEqual({
      log: [
        { time: 100, kind: "success", text: "Notification permission granted." },
        { time: 200, kind: "error", text: "seed: [redacted: mnemonic-like string]" },
      ],
      notifications: { gamePlayTime: 300, registered: true, idCount: 2, complete: false, retryAt: 400 },
    })
    expect(JSON.stringify(evidence)).not.toContain("41")
    expect(JSON.stringify(evidence)).not.toContain('"ids"')
  })

  it("does not handover-range-filter the pre-game worker evidence", async () => {
    storage.values.set(
      "jollity.wg.workerLog",
      JSON.stringify([{ time: 100, kind: "info", text: "booked before handover" }]),
    )

    expect(await readWorkerEvidence()).toMatchObject({
      log: [{ time: 100, kind: "info", text: "booked before handover" }],
    })
  })

  it("normalizes malformed values and distinguishes an unavailable store", async () => {
    storage.values.set(
      "jollity.wg.workerLog",
      JSON.stringify([
        { time: 1, kind: "wat", text: "wrong kind" },
        { time: "2", kind: "info", text: "wrong time" },
        { time: 3, kind: "info", text: 4 },
      ]),
    )
    storage.values.set("jollity.wg.notifs", JSON.stringify({ gamePlayTime: "bad", registered: true, ids: [1] }))
    expect(await readWorkerEvidence()).toEqual({ log: [], notifications: null })

    storage.failed.add("jollity.wg.workerLog")
    storage.failed.add("jollity.wg.notifs")
    expect(await readWorkerEvidence()).toBeNull()
  })
})
