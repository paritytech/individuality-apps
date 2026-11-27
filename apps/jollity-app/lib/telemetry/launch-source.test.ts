// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { readLaunchSource } from "./launch-source"
import { NOTIFICATION_MOMENTS } from "./notification-url"
import { isMaskSafe } from "./testing"

const ROOT = {} as typeof globalThis

const hostRoot = (openSource: string, openedAtEpochMs = 1_000) =>
  ({ __trinityHostTelemetry: { hostSessionId: "123e4567-e89b-42d3-a456-426614174000", openSource, openedAtEpochMs } }) as unknown as typeof globalThis

describe("launch source", () => {
  it.each([
    ["maps a host alarm open to notification", hostRoot("alarm"), 2_000, "", "/", { source: "notification", detail: "alarm" }],
    ["maps a host deeplink open to deeplink", hostRoot("deeplink"), 2_000, "", "/", { source: "deeplink", detail: null }],
    ["ignores a stale host open and falls through to the URL", hostRoot("alarm"), 1_000 + 6 * 60 * 1000, "?jollity-notification=reminder&moment=start-5m", "/", { source: "notification", detail: "start-5m" }],
    ["never sends host free text for an unrecognised host open source", hostRoot("auto_open"), 2_000, "", "/", { source: "unknown", detail: "host-other" }],
  ])("%s", (_name, root, now, search, pathname, expected) => {
    expect(readLaunchSource({ root, now, search, pathname })).toEqual(expected)
  })

  it.each([
    ["reads a reminder notification from the launch URL with its moment", "?jollity-notification=reminder&moment=close-10m", "/", "navigate", { source: "notification", detail: "close-10m" }],
    ["maps an unrecognised moment to other so no URL free text is sent", "?jollity-notification=reminder&moment=hello-world", "/", "navigate", { source: "notification", detail: "other" }],
    ["reads a reminder without a moment", "?jollity-notification=reminder", "/", "navigate", { source: "notification", detail: null }],
    ["reads any other launch query as a deeplink with the route", "?card=humanity", "/game", "navigate", { source: "deeplink", detail: "/game" }],
    ["reports unknown when nothing says what opened the page", "", "/", "navigate", { source: "unknown", detail: null }],
  ])("%s", (_name, search, pathname, navigationType, expected) => {
    expect(readLaunchSource({ root: ROOT, now: 1_000, search, pathname, navigationType })).toEqual(expected)
  })

  it.each([
    ["a reload with a query is not a deeplink", "reload", "?game=248", "/prize-draw", { source: "unknown", detail: "reload" }],
    ["a reload with the low-power query is not a deeplink", "reload", "?lowpower=1", "/", { source: "unknown", detail: "reload" }],
    ["a back/forward navigation with a query is not a deeplink", "back_forward", "?game=248", "/game", { source: "unknown", detail: "reload" }],
    ["a prerender with a query is not a deeplink", "prerender", "?card=humanity", "/game", { source: "unknown", detail: "reload" }],
  ])("%s", (_name, navigationType, search, pathname, expected) => {
    expect(readLaunchSource({ root: ROOT, now: 1_000, search, pathname, navigationType })).toEqual(expected)
  })

  it("still reads the reminder URL on a reload: the notification itself opened the page", () => {
    expect(readLaunchSource({ root: ROOT, now: 1_000, search: "?jollity-notification=reminder&moment=start-5m", pathname: "/", navigationType: "reload" }))
      .toEqual({ source: "notification", detail: "start-5m" })
  })

  it("a host open still wins over the reload classification", () => {
    expect(readLaunchSource({ root: hostRoot("deeplink"), now: 2_000, search: "?game=248", pathname: "/prize-draw", navigationType: "reload" }))
      .toEqual({ source: "deeplink", detail: null })
  })
})

describe("masking-safe launch source vocabulary", () => {
  const words = [
    "app.launch_source",
    "app.launch_detail",
    "app.concurrent_page",
    "notification",
    "deeplink",
    "unknown",
    "alarm",
    "host-other",
    "other",
    "reload",
    ...NOTIFICATION_MOMENTS,
    "true",
    "false",
  ]
  it.each(words)("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
})
