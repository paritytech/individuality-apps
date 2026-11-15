// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The beat label (ROOM_BEAT): one heartbeat per phone replaces the free hello reads. A beat is due at
 * once after a boot, then one period after the last (8 s while a link forms or is down, 16 s once every
 * link is up); time does not pass a due beat; the beat reaches every peer at one instant.
 */
import { describe, expect, it } from "vitest"
import { beatDue, beatDueAt, candidateLabels, defaultRoomBeat, initialRoom, step } from "./model"
import { roomAnchor } from "./checks"

describe("the beat label", () => {
  const room = initialRoom(3, 1, true)

  it("defaults network runs to the beat and preserves an explicit opt-out", () => {
    const previous = process.env.ROOM_BEAT
    delete process.env.ROOM_BEAT
    try {
      defaultRoomBeat()
      expect(initialRoom(2, 0).beat).toBe(true)
      process.env.ROOM_BEAT = "0"
      defaultRoomBeat()
      expect(initialRoom(2, 0).beat).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.ROOM_BEAT
      else process.env.ROOM_BEAT = previous
    }
  })

  it("takes the place of the free hello labels", () => {
    const labels = candidateLabels(room)
    expect(labels).toContain("beat:0")
    expect(labels.some((label) => label.startsWith("hello:"))).toBe(false)
    expect(candidateLabels(initialRoom(3, 1, false)).some((label) => label.startsWith("hello:"))).toBe(true)
  })

  it("is due at once after a boot, and time does not pass a due beat", () => {
    expect(beatDue(room)).toBe(true)
    expect(step(room, "advance:0")).toBeNull()
    const after = step(room, "beat:1")!.room
    expect(after.phones[1]!.lastBeat).toBe(room.now)
    // the other phones' beats are still due
    expect(step(after, "advance:0")).toBeNull()
    expect(step(after, "beat:1")).toBeNull()
  })

  it("is rearmed one heartbeat later while a link is not up, and heard by every peer at that instant", () => {
    let at = room
    for (const label of ["beat:0", "beat:1", "beat:2"]) at = step(at, label)!.room
    expect(beatDue(at)).toBe(false)
    expect(beatDueAt(at, 0)).toBe(at.now + 8_000)
    expect(at.halves[1]![0]!.facts.lastSignalAt).toBe(at.now)
    expect(at.halves[2]![0]!.facts.lastSignalAt).toBe(at.now)
  })

  it("is the anchor's way to a steady room, and a reload makes the phone's beat due again", () => {
    const previous = process.env.ROOM_BEAT
    process.env.ROOM_BEAT = "1"
    try {
      const anchor = roomAnchor(2, "reload", 1)
      expect(anchor.room.beat).toBe(true)
      expect(beatDueAt(anchor.room, 1)).toBe(anchor.room.now)
      expect(anchor.room.phones[1]!.lastBeat).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.ROOM_BEAT
      else process.env.ROOM_BEAT = previous
    }
  })
})
