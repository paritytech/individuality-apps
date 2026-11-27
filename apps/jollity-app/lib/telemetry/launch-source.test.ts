// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { readLaunchSource } from "./launch-source"
import { isMaskSafe } from "./testing"

const ROOT = {} as typeof globalThis

describe("launch source", () => {
  it("maps a host alarm open to notification", () => {
    const root = {
      __trinityHostTelemetry: { hostSessionId: "123e4567-e89b-42d3-a456-426614174000", openSource: "alarm", openedAtEpochMs: 1_000 },
    } as unknown as typeof globalThis
    expect(readLaunchSource({ root, now: 2_000, search: "", pathname: "/" })).toEqual({ source: "notification", detail: "alarm" })
  })

  it("maps a host deeplink open to deeplink", () => {
    const root = {
      __trinityHostTelemetry: { hostSessionId: "123e4567-e89b-42d3-a456-426614174000", openSource: "deeplink", openedAtEpochMs: 1_000 },
    } as unknown as typeof globalThis
    expect(readLaunchSource({ root, now: 2_000, search: "", pathname: "/" })).toEqual({ source: "deeplink", detail: null })
  })

  it("ignores a stale host open and falls through to the URL", () => {
    const root = {
      __trinityHostTelemetry: { hostSessionId: "123e4567-e89b-42d3-a456-426614174000", openSource: "alarm", openedAtEpochMs: 1_000 },
    } as unknown as typeof globalThis
    expect(readLaunchSource({ root, now: 1_000 + 6 * 60 * 1000, search: "?jollity-notification=reminder&moment=start-5m", pathname: "/" }))
      .toEqual({ source: "notification", detail: "start-5m" })
  })

  it("reads a reminder notification from the launch URL with its moment", () => {
    expect(readLaunchSource({ root: ROOT, now: 1_000, search: "?jollity-notification=reminder&moment=close-10m", pathname: "/" }))
      .toEqual({ source: "notification", detail: "close-10m" })
  })

  it("reads any other launch query as a deeplink with the route", () => {
    expect(readLaunchSource({ root: ROOT, now: 1_000, search: "?card=humanity", pathname: "/game" }))
      .toEqual({ source: "deeplink", detail: "/game" })
  })

  it("reports unknown when nothing says what opened the page", () => {
    expect(readLaunchSource({ root: ROOT, now: 1_000, search: "", pathname: "/" }))
      .toEqual({ source: "unknown", detail: null })
  })

  it("never sends host free text for an unrecognised host open source", () => {
    const root = {
      __trinityHostTelemetry: { hostSessionId: "123e4567-e89b-42d3-a456-426614174000", openSource: "auto_open", openedAtEpochMs: 1_000 },
    } as unknown as typeof globalThis
    expect(readLaunchSource({ root, now: 2_000, search: "", pathname: "/" }))
      .toEqual({ source: "unknown", detail: "host-other" })
  })
})

describe("masking-safe launch source vocabulary", () => {
  const words = [
    "app.launch_source",
    "app.launch_detail",
    "app.concurrent_page",
    "notification",
    "deeplink",
    "app-icon",
    "unknown",
    "alarm",
    "host-other",
    "start-5m",
    "close-10m",
    "true",
    "false",
  ]
  it.each(words.map((word) => [word]))("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
})
