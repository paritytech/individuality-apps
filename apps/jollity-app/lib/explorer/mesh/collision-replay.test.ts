// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { collisionPathsForFlag } from "./collision-replay.explore"

describe("collision replay census ownership", () => {
  it("replays only the flag-on tree's census paths, dropping a saved census's flag-off ones", () => {
    const entries = [
      { key: "off:same", paths: [["off-path"]] },
      { key: "on:same", paths: [["on-path"]] },
    ]
    expect(collisionPathsForFlag(entries)).toEqual([
      { key: "same", paths: [["on-path"]] },
    ])
  })
})
