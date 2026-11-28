// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { Page } from "@playwright/test"
import { CAMERA_OFF_LINE, NO_CAMERA_LINE } from "../../apps/jollity-app/lib/permission-copy"
import { cameraUnavailableOutcome, expectedCameraHelp, isGateUrl, passPermissionGate, shouldWaitForExpectedPermissionGate } from "./permission-gate"

describe("isGateUrl", () => {
  it("is the /permissions page, with or without a slash or a query", () => {
    expect(isGateUrl("http://localhost:3000/permissions")).toBe(true)
    expect(isGateUrl("http://localhost:3000/permissions/?x=1")).toBe(true)
  })
  it("is nothing else", () => {
    expect(isGateUrl("http://localhost:3000/")).toBe(false)
    expect(isGateUrl("http://localhost:3000/game")).toBe(false)
    expect(isGateUrl("http://localhost:3000/permissions-x")).toBe(false)
    expect(isGateUrl("about:blank")).toBe(false)
    expect(isGateUrl("")).toBe(false)
  })
})

describe("expectedCameraHelp", () => {
  it("reads the Settings line under the Blocked row for a denied profile", () => {
    expect(expectedCameraHelp("denied")).toEqual({ row: "Blocked", line: CAMERA_OFF_LINE })
  })
  it("reads the no camera line under its row for a no-camera profile", () => {
    expect(expectedCameraHelp("no-camera")).toEqual({ row: "No camera found", line: NO_CAMERA_LINE })
  })
})

describe("passPermissionGate", () => {
  const fake = (url: string, leaves: boolean | string, help: "denied" | "no-camera" | null = null, lineShown = true) => {
    let clicks = 0
    let current = url
    const names: string[] = []
    const visible = (name: string) =>
      help === "denied"
        ? name === "Blocked" || (lineShown && name === CAMERA_OFF_LINE)
        : help === "no-camera"
          ? name === "No camera found" || (lineShown && name === NO_CAMERA_LINE)
          : false
    const page = {
      url: () => current,
      getByRole: (_role: string, opts?: { name?: string | RegExp }) => ({
        click: async () => {
          clicks++
          names.push(String(opts?.name))
          if (leaves) current = typeof leaves === "string" ? leaves : "http://x/"
        },
        isVisible: async () => typeof opts?.name === "string" && visible(opts.name),
        getByRole: (_nestedRole: string, nested?: { name?: string }) => ({ isVisible: async () => !!nested?.name && visible(nested.name) }),
        getByText: (text: string) => ({ isVisible: async () => visible(text) }),
      }),
      getByText: (text: string) => ({ isVisible: async () => visible(text) }),
      waitForTimeout: async () => {},
    } as unknown as Page
    return { page, clicks: () => clicks, names: () => names }
  }
  const quiet = () => {}
  it("is false off the gate and true once it passed", async () => {
    expect(await passPermissionGate(fake("http://x/", true).page, quiet, 30)).toEqual({ kind: "not-gate" })
    expect(await passPermissionGate(fake("http://x/permissions", true).page, quiet, 30)).toEqual({ kind: "passed" })
  })
  it("taps Allow access once and throws when the gate is still up instead of letting the caller wait forever", async () => {
    const f = fake("http://x/permissions", false)
    await expect(passPermissionGate(f.page, quiet, 30)).rejects.toThrow(/still on \/permissions/)
    expect(f.clicks()).toBe(1)
    expect(f.names()).toEqual([String(/^Allow access$/)])
  })
  it.each(["denied" as const, "no-camera" as const])("accepts the explicit %s help outcome without leaving /permissions", async (reason) => {
    const f = fake("http://x/permissions", false, reason)
    await expect(passPermissionGate(f.page, quiet, 30, { kind: "camera-unavailable", reason })).resolves.toEqual({
      kind: "camera-unavailable",
      reason,
      helpShown: true,
      handedOver: false,
    })
    expect(f.clicks()).toBe(1)
  })
  it("does not take the camera row as the help without the line that says what fixes it", async () => {
    const f = fake("http://x/permissions", false, "denied", false)
    await expect(passPermissionGate(f.page, quiet, 30, { kind: "camera-unavailable", reason: "denied" })).rejects.toThrow(/still on \/permissions/)
  })
  it("does not let an ordinary profile treat the camera help as passing the gate", async () => {
    await expect(passPermissionGate(fake("http://x/permissions", false, "denied").page, quiet, 30)).rejects.toThrow(/still on \/permissions/)
  })
  it("records leaving the gate as a failed expected outcome instead of an ordinary pass", async () => {
    await expect(passPermissionGate(fake("http://x/permissions", true).page, quiet, 30, { kind: "camera-unavailable", reason: "denied" })).resolves.toEqual({
      kind: "camera-unavailable",
      reason: "denied",
      helpShown: false,
      handedOver: true,
    })
  })
  it("records an unexpected /game handover", async () => {
    await expect(passPermissionGate(fake("http://x/permissions", "http://x/game").page, quiet, 30, { kind: "camera-unavailable", reason: "denied" })).resolves.toMatchObject({
      helpShown: false,
      handedOver: true,
    })
  })
  it("requires the exact permission route for a terminal camera outcome", () => {
    const expected = { kind: "camera-unavailable" as const, reason: "denied" as const }
    expect(cameraUnavailableOutcome("http://x/permissions", expected, false).handedOver).toBe(false)
    expect(cameraUnavailableOutcome("http://x/permissions/", expected, true)).toMatchObject({ helpShown: true, handedOver: false })
    expect(cameraUnavailableOutcome("http://x/", expected, false).handedOver).toBe(true)
    expect(cameraUnavailableOutcome("http://x/game", expected, false).handedOver).toBe(true)
  })
  it("does not settle a terminal camera persona on root before its asynchronous gate redirect", () => {
    const expected = { kind: "camera-unavailable" as const, reason: "denied" as const }
    expect(shouldWaitForExpectedPermissionGate("http://x/", expected)).toBe(true)
    expect(shouldWaitForExpectedPermissionGate("http://x/permissions", expected)).toBe(false)
    expect(shouldWaitForExpectedPermissionGate("http://x/game", expected)).toBe(false)
    expect(shouldWaitForExpectedPermissionGate("http://x/", undefined)).toBe(false)
  })
})
