// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ConnectionFooter } from "@/components/waiting-room/connection-footer"
import type { CameraState } from "@/lib/camera"

afterEach(cleanup)

describe("connection footer works", () => {
  it.each<[string, CameraState]>([
    ["off", { kind: "off" }],
    ["live", { kind: "live", stream: {} as MediaStream, muted: false }],
  ])("labels the camera indicator Camera when the camera is %s", (_, camera) => {
    // Given
    const footer = { text: "Waiting for players", detail: null, info: null, network: "checking", quality: null, chain: "connecting" } as const

    // When
    render(<ConnectionFooter camera={camera} footer={footer} peers={[]} />)

    // Then
    expect(screen.getByText("Camera")).toBeTruthy()
    expect(screen.queryByText("Stream")).toBeNull()
    expect(screen.getByText("Camera").parentElement).toContain(screen.getByRole("img", { name: "Your camera" }))
  })
})
