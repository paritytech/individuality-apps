// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * #1562's archived RP10 finding through the confirm pipeline. B4 fixes the
 * abstract room itself, so the old witness no longer reaches Mesh confirmation:
 * projection reports that RP10 does not fire with two phones. The matching
 * real-Mesh connectBy regression lives in mesh/liveness.test.ts.
 *
 * When room/model.ts changes, the fixture may stop replaying ("the witness
 * does not replay"): recapture it from a reload run (README, "Confirming a
 * finding on real Mesh").
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import type { RoomFinding } from "./bfs"
import { planConfirmation } from "./to-mesh"

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "findings", "1562.json"), "utf8")) as { phones: number; finding: RoomFinding }

describe("the room's RP10 finding on real Mesh (#1562)", () => {
  it("retires the archived finding because the abstract pair now heals by connectBy", () => {
    const confirmation = planConfirmation(fixture.finding, fixture.phones)
    expect(confirmation).toMatchObject({ verdict: "abstract-3" })
    expect("why" in confirmation ? confirmation.why : "").toMatch(/RP10 does not fire with two phones/)
  })
})
