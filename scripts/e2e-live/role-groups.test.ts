// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { groupSeats } from "@parity/product-sdk-individuality"
import { gameGroupPeers, planVideoRoleWindow, sharedGamePeers, sharedGroupRounds, videoRoleEnableWindowOpen } from "./role-groups"

describe("sharedGroupRounds", () => {
  it("derives real overlap from each round's finalized shuffled indices", () => {
    expect(sharedGroupRounds([1, 1], [3, 2], 7, 6, 2, groupSeats)).toEqual([0])
    expect(sharedGroupRounds([1, 1], [2, 2], 6, 6, 2, groupSeats)).toEqual([0, 1])
  })

  it("refuses incomplete or impossible roster geometry", () => {
    expect(() => sharedGroupRounds([1], [2, 2], 7, 6, 2, groupSeats)).toThrow(/2 rounds/)
    expect(() => sharedGroupRounds([1, 1], [2, 7], 7, 6, 2, groupSeats)).toThrow(/index/)
  })
})

describe("sharedGamePeers", () => {
  it("uses the distinct union from the 27 October eight-peer roster excerpt", () => {
    // Artifact shape, anonymized: four peers in round 1, five in round 2, and
    // one peer shared between them. The persona's static five missed the union.
    const rounds = [
      ["self", "peer-a", "peer-b", "peer-c", "peer-shared"],
      ["peer-d", "self", "peer-e", "peer-f", "peer-g", "peer-shared"],
    ]
    expect(sharedGamePeers(rounds, "self")).toEqual([
      "peer-a", "peer-b", "peer-c", "peer-d", "peer-e", "peer-f", "peer-g", "peer-shared",
    ])
    expect(gameGroupPeers(rounds[1], "self")).toEqual([
      "peer-d", "peer-e", "peer-f", "peer-g", "peer-shared",
    ])
  })
})

describe("planVideoRoleWindow", () => {
  it("uses the later shared round so a six-person viewer gets Unseen, live video, disable, then reload", () => {
    expect(planVideoRoleWindow({ sharedRounds: [0, 1], maxGroupSize: 6, rounds: 2, joinAfterTurn: 2, reloadAtTurn: 11 })).toEqual({
      round: 1,
      enableAtTurn: 8,
      disableAtTurn: 10,
    })
  })

  it("uses an early shared round when one post-return Unseen turn and a live interval still fit", () => {
    expect(planVideoRoleWindow({ sharedRounds: [0], maxGroupSize: 6, rounds: 2, joinAfterTurn: 1, reloadAtTurn: 11 })).toEqual({
      round: 0,
      enableAtTurn: 3,
      disableAtTurn: 5,
    })
  })

  it("keeps one full suppressed-video turn after the late return", () => {
    const window = planVideoRoleWindow({ sharedRounds: [0], maxGroupSize: 6, rounds: 2, joinAfterTurn: 1, reloadAtTurn: 11 })
    expect(window?.enableAtTurn).toBeGreaterThanOrEqual(3)
  })

  it("never chooses a window whose disable is at or after reload", () => {
    expect(planVideoRoleWindow({ sharedRounds: [1], maxGroupSize: 6, rounds: 2, joinAfterTurn: 2, reloadAtTurn: 10 })).toBeNull()
  })

  it("does not let a sender that appears late collapse enable and disable into one turn", () => {
    const window = { enableAtTurn: 3, disableAtTurn: 5 }
    expect(videoRoleEnableWindowOpen(3, window)).toBe(true)
    expect(videoRoleEnableWindowOpen(4, window)).toBe(true)
    expect(videoRoleEnableWindowOpen(5, window)).toBe(false)
    expect(videoRoleEnableWindowOpen(6, window)).toBe(false)
  })
})

describe("video-role proof wiring", () => {
  it("carries the public viewer identity from probe to the sender and binds actual finalized overlap", () => {
    const workflow = readFileSync(resolve(__dirname, "../../.github/workflows/e2e-live.yml"), "utf8")
    const probe = readFileSync(resolve(__dirname, "probe.mts"), "utf8")
    const journey = readFileSync(resolve(__dirname, "journey.pw.ts"), "utf8")
    expect(probe).toContain("video_role_viewer_account=")
    expect(probe).toContain("video_role_viewer_reload_turn=")
    expect(workflow).toContain("E2E_VIDEO_ROLE_VIEWER_ACCOUNT: ${{ needs.probe.outputs.video_role_viewer_account }}")
    expect(workflow).toContain("E2E_VIDEO_ROLE_VIEWER_RELOAD_TURN: ${{ needs.probe.outputs.video_role_viewer_reload_turn }}")
    expect(journey).toContain('"group-overlap", "--game", String(g.index)')
    expect(journey).toContain("planVideoRoleWindow")
  })
})
