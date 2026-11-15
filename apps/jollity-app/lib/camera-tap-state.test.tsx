// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./debug/log-store", () => ({ devLog: () => {} }))
vi.mock("./telemetry", () => ({
  recordCount: () => {},
  recordDistribution: () => {},
  reportFailure: () => {},
  reportCameraRestore: () => {},
}))
vi.mock("./journeys/game-trace", () => ({ cameraRecovering: () => {}, cameraRecovered: () => {}, currentGameTurn: () => undefined }))

const { cameraTapState, useCameraTapState } = await import("./camera")

afterEach(cleanup)

describe("useCameraTapState", () => {
  it("renders from a referentially stable external-store snapshot", () => {
    let renders = 0
    function Probe() {
      renders += 1
      const value = useCameraTapState()
      return <output>{`${value.tap}:${value.opening}`}</output>
    }

    render(<Probe />)

    expect(screen.getByText("none:false")).toBeTruthy()
    expect(cameraTapState()).toBe(cameraTapState())
    expect(renders).toBeLessThan(3)
  })
})
