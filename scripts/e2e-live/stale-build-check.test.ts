// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { fixtureDescription, fixtureHits, fixtureLogLine, hostVersionOf, refusalLines, staleBuildVerdict, type StaleBuildFacts } from "./stale-build-check"

const base: StaleBuildFacts = { shown: true, registerButtons: 0, homeText: "Update available", fixtureHits: 2, browserLog: "", slotLog: "" }

describe("fixtureHits", () => {
  it("counts the requests for the version file and no other", () => {
    const log = [fixtureLogLine("/dim2-version.json", "t1"), fixtureLogLine("/other.json", "t2"), fixtureLogLine("/dim2-version.json", "t3")].join("\n")
    expect(fixtureHits(log, "/dim2-version.json")).toBe(2)
    expect(fixtureHits("", "/dim2-version.json")).toBe(0)
  })
  it("a missing log is no evidence, not zero", () => {
    expect(fixtureHits(null, "/dim2-version.json")).toBeNull()
  })
})

describe("refusal and host version", () => {
  it("quotes the host's refusal line and the app's own failure", () => {
    const log = "ok\n12:00:01 [permissions] version permission not granted\n12:00:02 error version permission failed {detail}\nmore"
    expect(refusalLines(log)).toEqual(["12:00:01 [permissions] version permission not granted", "12:00:02 error version permission failed {detail}"])
    expect(refusalLines("nothing here")).toEqual([])
  })
  it("reads the truapi-host version from the slot log", () => {
    expect(hostVersionOf("boot\ntruapi-host 0.23.0 listening\n")).toBe("truapi-host 0.23.0")
    expect(hostVersionOf("no version")).toBeNull()
  })
})

describe("staleBuildVerdict", () => {
  it("passes only with the update screen, no Register AND a served fixture", () => {
    expect(staleBuildVerdict(1, base).map((c) => c.status)).toEqual(["pass", "pass"])
  })
  it("fails a screen that no fixture read explains", () => {
    const [shown] = staleBuildVerdict(1, { ...base, fixtureHits: 0 })
    expect(shown.status).toBe("fail")
    expect(shown.detail).toMatch(/not this run's proof/)
    expect(staleBuildVerdict(1, { ...base, fixtureHits: null })[0].status).toBe("fail")
  })
  it("a refused grant fails with the exact refusal and the host version", () => {
    const [shown] = staleBuildVerdict(1, {
      ...base,
      shown: false,
      homeText: "Register",
      fixtureHits: 0,
      browserLog: "[permissions] version permission not granted",
      slotLog: "truapi-host 0.23.0 up",
    })
    expect(shown.status).toBe("fail")
    expect(shown.detail).toMatch(/the fixture was never read/)
    expect(shown.detail).toContain("version permission not granted")
    expect(shown.detail).toContain("truapi-host 0.23.0")
  })
  it("a read that is judged current says so and fails", () => {
    const [shown] = staleBuildVerdict(1, { ...base, shown: false, fixtureHits: 3 })
    expect(shown.detail).toMatch(/read 3 time\(s\) but the app did not judge/)
    expect(shown.detail).toMatch(/no refusal line/)
  })
  it("a Register button on a stale build fails", () => {
    expect(staleBuildVerdict(1, { ...base, registerButtons: 1 })[1].status).toBe("fail")
  })
})

describe("fixtureDescription", () => {
  it("never prints 'product undefined': the profile pins none, so the network's own is named", () => {
    const line = fixtureDescription({ NEXT_PUBLIC_VERSION_URL: "http://localhost:1/v.json", NEXT_PUBLIC_BUILD_TIME: "0" }, "dim2.testnet")
    expect(line).toBe("http://localhost:1/v.json (build time 0, product dim2.testnet, the network's own)")
    expect(line).not.toMatch(/undefined/)
  })
  it("an empty fixture log is zero reads, a missing one is no evidence", () => {
    expect(fixtureHits("", "/v.json")).toBe(0)
    expect(staleBuildVerdict(1, { shown: false, registerButtons: 1, homeText: "x", fixtureHits: 0, browserLog: "[permissions] version permission not granted", slotLog: "truapi-host 0.23.0" })[0].detail).toMatch(/never read: the host refused/)
  })
})
