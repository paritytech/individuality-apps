// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { HealTracker, type HealEpisodeEvent, type HealEvent } from "./heal"

function tracker() {
  const events: Array<[string, HealEvent]> = []
  const episodes: Array<[string, HealEpisodeEvent]> = []
  return {
    events,
    episodes,
    heal: new HealTracker(
      (peer, event) => events.push([peer, event]),
      (peer, event) => episodes.push([peer, event]),
    ),
  }
}

describe("HealTracker", () => {
  it("ends an attempt healed when the link connects, with the time it took", () => {
    const { heal, events } = tracker()
    expect(heal.begin("amy", "disconnected", "ice_restart", 1000)).toBe(1)
    heal.connected("amy", 3500)
    expect(events).toEqual([["amy", { trigger: "disconnected", action: "ice_restart", attempt: 1, healed: true, healMs: 2500, end: "connected" }]])
  })

  it("carries an unseen detail from the attempt into its emitted row", () => {
    const { heal, events } = tracker()
    heal.begin("amy", "negotiation_error", "rebuild", 1000, "unseen")
    heal.peerSees("amy", 3500)
    expect(events).toEqual([["amy", {
      trigger: "negotiation_error",
      action: "rebuild",
      detail: "unseen",
      attempt: 1,
      healed: true,
      healMs: 2500,
      end: "peer_sees",
    }]])
  })

  it("ends a media-stall attempt only when frames flow again, not when the link reads connected", () => {
    const { heal, events } = tracker()
    heal.begin("amy", "media_stall", "ice_restart", 0)
    heal.connected("amy", 500) // the link never left connected
    expect(events).toEqual([])
    heal.mediaFlowing("amy", 4000)
    expect(events[0][1]).toMatchObject({ trigger: "media_stall", healed: true, healMs: 4000, end: "media_flowing" })
  })

  it("does not let flowing frames end an attempt of another kind", () => {
    const { heal, events } = tracker()
    heal.begin("amy", "failed", "rebuild", 0)
    heal.mediaFlowing("amy", 100)
    expect(events).toEqual([])
  })

  it.each([
    ["media_flowing", (heal: HealTracker) => heal.mediaFlowing("amy", 4000)],
    ["peer_sees", (heal: HealTracker) => heal.peerSees("amy", 4000)],
  ] as const)("keeps a negotiation repair open at connected until %s proves video", (end, proveVideo) => {
    const { heal, events } = tracker()
    heal.begin("amy", "negotiation_error", "rebuild", 0)
    heal.connected("amy", 500)
    expect(events).toEqual([])
    proveVideo(heal)
    expect(events).toEqual([
      ["amy", { trigger: "negotiation_error", action: "rebuild", attempt: 1, healed: true, healMs: 4000, end }],
    ])
  })

  it("counts attempts since the last heal, and closes the one before as not healed", () => {
    const { heal, events, episodes } = tracker()
    heal.begin("amy", "failed", "rebuild", 0)
    expect(heal.begin("amy", "failed", "rebuild", 6000)).toBe(2)
    expect(events).toEqual([["amy", { trigger: "failed", action: "rebuild", attempt: 1, healed: false, healMs: 6000, end: "next_attempt" }]])
    expect(episodes).toEqual([])
    heal.connected("amy", 7000)
    expect(events[1][1]).toMatchObject({ attempt: 2, healed: true, healMs: 1000 })
    expect(heal.begin("amy", "disconnected", "ice_restart", 9000)).toBe(1) // a heal starts the count over
  })

  it("emits one ordered episode for a multi-step heal, with numeric steps and total duration", () => {
    const { heal, episodes } = tracker()
    heal.begin("amy", "media_stall", "ice_restart", 1000)
    heal.begin("amy", "media_stall", "ice_restart", 2000)
    heal.begin("amy", "media_stall", "rebuild", 4000)
    heal.mediaFlowing("amy", 9000)

    expect(episodes).toEqual([["amy", {
      ladder: "media_stall:ice_restart > media_stall:ice_restart > media_stall:rebuild",
      steps: 3,
      healed: true,
      end: "media_flowing",
      ms: 8000,
    }]])
    expect(typeof episodes[0][1].steps).toBe("number")
    expect(typeof episodes[0][1].ms).toBe("number")
  })

  it("caps the ladder at six visible items while preserving its first and terminal steps", () => {
    const { heal, episodes } = tracker()
    for (let attempt = 0; attempt < 8; attempt++)
      heal.begin("amy", "disconnected", attempt === 0 ? "ice_restart" : "rebuild", attempt * 1000)
    heal.leave("amy", 9000)

    expect(episodes).toEqual([["amy", {
      ladder: "disconnected:ice_restart > disconnected:rebuild > disconnected:rebuild > +3 > disconnected:rebuild > disconnected:rebuild",
      steps: 8,
      healed: false,
      end: "peer_left",
      ms: 9000,
    }]])
  })

  it("bounds a never-healing episode's memory while keeping its count and both ends", () => {
    const { heal, episodes } = tracker()
    const ATTEMPTS = 1000
    for (let attempt = 0; attempt < ATTEMPTS; attempt++)
      heal.begin("amy", "disconnected", "rebuild", attempt * 1000, attempt === 0 ? "unseen" : undefined)
    heal.leave("amy", ATTEMPTS * 1000)

    const episode = episodes[0][1]
    expect(episode.steps).toBe(ATTEMPTS)
    expect(typeof episode.steps).toBe("number")
    expect(episode.steps_dropped).toBe(ATTEMPTS - 16)
    expect(typeof episode.steps_dropped).toBe("number")
    // first three retained (head), last two retained (tail), count in between
    expect(episode.ladder).toBe(
      `disconnected/unseen:rebuild > disconnected:rebuild > disconnected:rebuild > +${ATTEMPTS - 5} > disconnected:rebuild > disconnected:rebuild`,
    )
    expect(episode.end).toBe("peer_left")
  })

  it("keeps no dropped count for an episode that fits the cap", () => {
    const { heal, episodes } = tracker()
    for (let attempt = 0; attempt < 16; attempt++) heal.begin("amy", "failed", "rebuild", attempt * 1000)
    heal.leave("amy", 16000)
    expect(episodes[0][1]).not.toHaveProperty("steps_dropped")
    expect(episodes[0][1].steps).toBe(16)
  })

  it("clears an episode after a heal, leave and closeAll", () => {
    const { heal, episodes } = tracker()
    heal.begin("amy", "failed", "rebuild", 0)
    heal.connected("amy", 100)
    expect(heal.begin("amy", "disconnected", "ice_restart", 200)).toBe(1)
    heal.leave("amy", 300)
    expect(heal.begin("amy", "failed", "rebuild", 400)).toBe(1)
    heal.closeAll(500)
    expect(heal.begin("amy", "failed", "rebuild", 600)).toBe(1)

    expect(episodes.map(([, episode]) => [episode.steps, episode.healed, episode.end, episode.ms])).toEqual([
      [1, true, "connected", 100],
      [1, false, "peer_left", 100],
      [1, false, "mesh_closed", 100],
    ])
  })

  it("keeps each peer's attempts apart", () => {
    const { heal } = tracker()
    heal.begin("amy", "failed", "rebuild", 0)
    expect(heal.begin("bob", "failed", "rebuild", 0)).toBe(1)
  })

  it("ends an open attempt as not healed when the peer leaves or the mesh closes", () => {
    const { heal, events } = tracker()
    heal.begin("amy", "failed", "rebuild", 0)
    heal.begin("bob", "disconnected", "ice_restart", 100)
    heal.leave("amy", 5000)
    heal.closeAll(7000)
    expect(events.map(([peer, event]) => [peer, event.healed, event.end, event.healMs])).toEqual([
      ["amy", false, "peer_left", 5000],
      ["bob", false, "mesh_closed", 6900],
    ])
  })

  it("says nothing for a connect with no attempt open, and tells isOpen", () => {
    const { heal, events } = tracker()
    heal.connected("amy", 100)
    expect(events).toEqual([])
    expect(heal.isOpen("amy")).toBe(false)
    heal.begin("amy", "failed", "rebuild", 0)
    expect(heal.isOpen("amy")).toBe(true)
    expect(heal.openTrigger("amy")).toBe("failed")
    expect(heal.openTrigger("bob")).toBeUndefined()
  })
})
