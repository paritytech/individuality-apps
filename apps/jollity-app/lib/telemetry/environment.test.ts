// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { describePage, detectHostKind, environmentFor, ingestHost, pageOrigin, pickDsn } from "./environment"

const at = (hostname: string, protocol = "https:") => ({ hostname, protocol })

describe("the environment comes from the served host name", () => {
  it.each([
    ["dim2.paseo", "dim2.paseo"],
    ["dim2next.paseo", "dim2next.paseo"],
    ["dim2.testnet", "dim2.testnet"],
    ["app.dim2.paseo", "dim2.paseo"],
    ["dim2next.paseo.li", "dim2next.paseo"],
    ["app.dim2-pr126-sandbox00.paseo.li", "dim2-pr126-sandbox00.paseo"],
    ["DIM2.TESTNET", "dim2.testnet"],
    ["jollity.dot", "jollity.dot"],
    // the web gateway serves the executable at <name>.app.<tld>.li (seen live on PR #184)
    ["dim2-pr184-sandbox00.app.paseo.li", "dim2-pr184-sandbox00.paseo"],
    ["dim2.app.testnet.li", "dim2.testnet"],
  ])("%s → %s", (hostname, environment) => {
    expect(environmentFor(at(hostname))).toEqual({ environment, source: "host" })
  })

  it("reads the product name out of a polkadot:// URL", () => {
    const url = new URL("polkadot://dim2-pr126-sandbox00.paseo/")
    expect(environmentFor({ hostname: url.hostname, protocol: url.protocol })).toEqual({
      environment: "dim2-pr126-sandbox00.paseo",
      source: "host",
    })
  })

  it.each([
    ["localhost", "http:"],
    ["127.0.0.1", "http:"],
    ["[::1]", "http:"],
    ["192.168.1.20", "http:"],
    ["my-laptop", "http:"],
    ["", "file:"],
    ["", "about:"],
  ])("files %s over %s as local, never as the baked product", (hostname, protocol) => {
    expect(environmentFor(at(hostname, protocol))).toEqual({ environment: "local", source: "local" })
  })

  it.each([["something.example.com"], ["example.com"], ["paseo"], ["172.32.0.1"], ["8.8.8.8"], [""]])(
    "files the unrecognised host %s as unknown, never as the baked product",
    (hostname) => {
      expect(environmentFor(at(hostname))).toEqual({ environment: "unknown", source: "host-unknown" })
    },
  )
})

describe("the page origin", () => {
  it("keeps a custom scheme that location.origin would call null", () => {
    expect(pageOrigin(at("dim2.paseo", "polkadot:"))).toBe("polkadot://dim2.paseo")
  })
})

describe("the host kind", () => {
  const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36"
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"
  const ipadDesktopMode = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"
  it.each([
    [android, true, 5, "android"],
    [iphone, true, 5, "ios"],
    [ipadDesktopMode, true, 5, "ios"],
    [ipadDesktopMode, true, 0, "desktop"],
    [android, false, 5, "browser"],
  ] as const)("%s in a container=%s touch=%s → %s", (userAgent, inContainer, maxTouchPoints, kind) => {
    expect(detectHostKind({ userAgent, inContainer, maxTouchPoints })).toBe(kind)
  })
})

describe("the ingest host", () => {
  it("is the DSN's host", () => {
    expect(ingestHost("https://key@o123.ingest.de.sentry.io/456")).toBe("o123.ingest.de.sentry.io")
  })
  it("drops a port: the host rejects a domain that has one", () => {
    expect(ingestHost("https://key@localhost:22605/1")).toBe("localhost")
  })
  it.each([[undefined], [""], ["not a url"], ["https://o1.ingest.de.sentry.io/1"], ["ftp://key@host/1"]])(
    "is null for %s",
    (dsn) => {
      expect(ingestHost(dsn)).toBeNull()
    },
  )
})

describe("the boot facts", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
  const ANDROID =
    "Mozilla/5.0 (Linux; Android 16; SM-S918B Build/BP4A.251205.006; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.8037.57 Mobile Safari/537.36"
  const page = { hostname: "dim2.paseo", protocol: "polkadot:", inContainer: true, maxTouchPoints: 5 }

  it("names the origin, host kind, environment and the phone together", () => {
    expect(describePage({ ...page, userAgent: IPHONE })).toEqual({
      origin: "polkadot://dim2.paseo",
      host: "ios",
      environment: "dim2.paseo",
      envSource: "host",
      os: "ios",
      osVersion: "18.6",
      model: null,
    })
  })
  it("names an Android model", () => {
    expect(describePage({ ...page, userAgent: ANDROID })).toMatchObject({ host: "android", os: "android", osVersion: "16", model: "SM-S918B" })
  })
})

describe("the test project gets the test traffic (D8)", () => {
  const prod = "https://prod@o1.ingest.de.sentry.io/1"
  const test = "https://test@o1.ingest.de.sentry.io/2"
  const pick = (served: { hostname: string; protocol: string }, testDsn = test) =>
    pickDsn({ prod, test: testDsn, environment: environmentFor(served).environment })

  it("a developer's copy or a bot (environment local, served from localhost) writes to the test project", () => {
    expect(pick(at("localhost", "http:"))).toBe(test)
    expect(pick(at("127.0.0.1", "http:"))).toBe(test)
  })
  it("a hosted origin writes to production (the tag is not an input: a stale one must not divert players)", () => {
    expect(pick(at("dim2.paseo"))).toBe(prod)
    expect(pick(at("dim2.testnet"))).toBe(prod)
    expect(pick(at("dim2-pr523-sandbox00.paseo"))).toBe(prod)
    expect(pick(at("dim2next.paseo", "polkadot:"))).toBe(prod)
    expect(pick(at("weird.example"))).toBe(prod)
  })
  it("without a test DSN nothing changes", () => {
    expect(pick(at("localhost", "http:"), "")).toBe(prod)
    expect(pick(at("localhost", "http:"), "not a dsn")).toBe(prod)
  })
  it("a test DSN alone serves a developer's copy and leaves a real page silent", () => {
    expect(pickDsn({ prod: "", test, environment: "local" })).toBe(test)
    expect(pickDsn({ prod: "", test, environment: "dim2.paseo" })).toBe("")
  })
})
