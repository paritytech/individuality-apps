// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  // the scene code in ./proto reads the media queries as it loads
  window.matchMedia ??= (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
})
// the scene throws as it builds, as a phone with no WebGL would
vi.mock("./proto/scenes/wheel/slit/scene.js", () => ({
  createSlit: () => {
    throw new Error("no WebGL")
  },
  slitParams: () => {},
}))
vi.mock("./baked-coin", () => ({ keepBakes: () => {}, releaseBakes: () => {} }))
vi.mock("./names", () => ({ nameCache: () => new Map(), rowLabels: () => ({ labelOf: () => "", stop: () => {} }), rowName: (name: string) => name.trim().toUpperCase() }))

const { mountWheel } = await import("./mount")

describe("mountWheel", () => {
  it("leaves nothing of itself in the host when the stage throws as it builds", () => {
    const host = document.createElement("div")
    const kept = host.appendChild(document.createElement("span"))
    const slot = (n: number) => n.toString(16).padStart(64, "0")
    const draw = { tickets: [slot(1), slot(2)], mine: slot(1), target: slot(2), won: false, winners: 1, prize: { amount: "200", unit: "CASH", prefix: "$" }, friends: [] }
    expect(() => mountWheel(host, draw)).toThrow("no WebGL")
    expect([...host.children]).toEqual([kept])
  })
})
