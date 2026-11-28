// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { readLaunchSource } from "./launch-source"

const ROOT = {} as typeof globalThis

const hostRoot = (openSource: string, openedAtEpochMs = 1_000) =>
  ({ __trinityHostTelemetry: { hostSessionId: "123e4567-e89b-42d3-a456-426614174000", openSource, openedAtEpochMs } }) as unknown as typeof globalThis

/** A host bootstrap that reports an open with no timestamp at all. */
const hostRootWithoutTimestamp = (openSource: string) =>
  ({ __trinityHostTelemetry: { hostSessionId: "123e4567-e89b-42d3-a456-426614174000", openSource } }) as unknown as typeof globalThis

describe("launch source", () => {
  it.each([
    ["maps a host alarm open to notification", hostRoot("alarm"), 2_000, "", "/", "navigate", { source: "notification", detail: "alarm" }],
    ["maps a host deeplink open to deeplink", hostRoot("deeplink"), 2_000, "", "/", "navigate", { source: "deeplink", detail: null }],
    ["ignores a stale host open and falls through to the URL", hostRoot("alarm"), 1_000 + 6 * 60 * 1000, "?jollity-notification=reminder&moment=start-5m", "/", "navigate", { source: "notification", detail: "start-5m" }],
    ["never sends host free text for an unrecognised host open source", hostRoot("auto_open"), 2_000, "", "/", "navigate", { source: "unknown", detail: "host-other" }],
  ])("%s", (_name, root, now, search, pathname, navigationType, expected) => {
    expect(readLaunchSource({ root, now, search, pathname, navigationType })).toEqual(expected)
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

  it("does not classify any URL on a reload, not even a reminder URL", () => {
    expect(readLaunchSource({ root: ROOT, now: 1_000, search: "?jollity-notification=reminder&moment=start-5m", pathname: "/", navigationType: "reload" }))
      .toEqual({ source: "unknown", detail: "reload" })
  })

  it("leaves the URL unclassified when the browser reports no navigation type", () => {
    expect(readLaunchSource({ root: ROOT, now: 1_000, search: "?card=humanity", pathname: "/game", navigationType: null }))
      .toEqual({ source: "unknown", detail: null })
  })

  it("a host open still wins over the reload classification", () => {
    expect(readLaunchSource({ root: hostRoot("deeplink"), now: 2_000, search: "?game=248", pathname: "/prize-draw", navigationType: "reload" }))
      .toEqual({ source: "deeplink", detail: null })
  })

  it("a host open with no timestamp is never fresh, so a reload does not count as a notification open again", () => {
    expect(readLaunchSource({ root: hostRootWithoutTimestamp("alarm"), now: 2_000, search: "", pathname: "/", navigationType: "reload" }))
      .toEqual({ source: "unknown", detail: null })
    expect(readLaunchSource({ root: hostRootWithoutTimestamp("alarm"), now: 999_999_999, search: "?jollity-notification=reminder&moment=start-5m", pathname: "/", navigationType: "navigate" }))
      .toEqual({ source: "notification", detail: "start-5m" })
  })
})
