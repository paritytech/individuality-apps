// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { healEpisodeAttributes } from "./heal-episode"

describe("heal episode Logs attributes", () => {
  it("keeps the step count, healed flag and duration typed", () => {
    const attributes = healEpisodeAttributes({
      ladder: "disconnected:ice_restart > disconnected:rebuild",
      steps: 2,
      healed: true,
      end: "connected",
      ms: 12_345,
    })

    expect(attributes).toEqual({
      "rtc.heal_ladder": "disconnected:ice_restart > disconnected:rebuild",
      "rtc.heal_steps": 2,
      "rtc.heal_episode_healed": true,
      "rtc.heal_end": "connected",
      "rtc.heal_episode_ms": 12_345,
    })
    expect(typeof attributes["rtc.heal_steps"]).toBe("number")
    expect(typeof attributes["rtc.heal_episode_healed"]).toBe("boolean")
    expect(attributes).not.toHaveProperty("rtc.healed")
    expect(typeof attributes["rtc.heal_episode_ms"]).toBe("number")
  })

  it("adds a numeric dropped count only when the episode outgrew the cap", () => {
    const attributes = healEpisodeAttributes({
      ladder: "disconnected:rebuild > disconnected:rebuild > disconnected:rebuild > +995 > disconnected:rebuild > disconnected:rebuild",
      steps: 1000,
      steps_dropped: 984,
      healed: false,
      end: "peer_left",
      ms: 999_000,
    })

    expect(attributes["rtc.heal_steps"]).toBe(1000)
    expect(attributes["rtc.heal_steps_dropped"]).toBe(984)
    expect(typeof attributes["rtc.heal_steps_dropped"]).toBe("number")
  })
})
