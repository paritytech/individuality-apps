// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { NetemLifecycleParser, NetemLifecycleProtocolError, parseNetemLifecycleLine } from "./netem-lifecycle"

describe("netem lifecycle stdout protocol", () => {
  it("parses exact active and restored records", () => {
    expect(parseNetemLifecycleLine("E2E_NETEM_PHASE\tactive\toutage")).toEqual({ state: "active", detail: "outage" })
    expect(parseNetemLifecycleLine("E2E_NETEM_PHASE\trestored\tvideo-stall\r")).toEqual({ state: "restored", detail: "video-stall" })
  })

  it("ignores ordinary human output and marker text that is not a record", () => {
    expect(parseNetemLifecycleLine("[netem] OUTAGE for 10 s")).toBeNull()
    expect(parseNetemLifecycleLine("[netem] saw E2E_NETEM_PHASE active")).toBeNull()
    expect(parseNetemLifecycleLine("")).toBeNull()
  })

  it.each([
    "E2E_NETEM_PHASE",
    "E2E_NETEM_PHASE\tactive",
    "E2E_NETEM_PHASE\tactive\toutage\textra",
    "E2E_NETEM_PHASE\tACTIVE\toutage",
    "E2E_NETEM_PHASE\tfailed\toutage",
    "E2E_NETEM_PHASE\tactive\t",
    "E2E_NETEM_PHASE\tactive\tOutage",
    "E2E_NETEM_PHASE\tactive\toutage value",
    "E2E_NETEM_PHASE\tactive\toutage\u001b[31m",
    "E2E_NETEM_PHASE\tactive\toutage\u0000",
  ])("rejects malformed or control-bearing marker records: %s", (line) => {
    expect(() => parseNetemLifecycleLine(line)).toThrow(NetemLifecycleProtocolError)
  })

  it("handles arbitrarily split stdout chunks and ignores interleaved human lines", () => {
    const parser = new NetemLifecycleParser()
    expect(parser.push("[netem] before\nE2E_NET")).toEqual([])
    expect(parser.push("EM_PHASE\tactive\tout")).toEqual([])
    expect(parser.push("age\n[netem] during\r\nE2E_NETEM_PHASE\trestored\t")).toEqual([
      { state: "active", detail: "outage" },
    ])
    expect(parser.push("outage\n")).toEqual([{ state: "restored", detail: "outage" }])
    expect(parser.finish()).toEqual([])
  })

  it("parses one final unterminated stdout record exactly once", () => {
    const parser = new NetemLifecycleParser()
    expect(parser.push("E2E_NETEM_PHASE\tactive\tblackout")).toEqual([])
    expect(parser.finish()).toEqual([{ state: "active", detail: "blackout" }])
    expect(parser.finish()).toEqual([])
  })

  it("fails closed on an overlong unterminated line", () => {
    const parser = new NetemLifecycleParser({ maxLineLength: 32 })
    expect(() => parser.push(`E2E_NETEM_PHASE\tactive\t${"x".repeat(33)}`)).toThrow(NetemLifecycleProtocolError)
  })

  it("bounds and ignores an overlong ordinary diagnostic before parsing the next marker", () => {
    const parser = new NetemLifecycleParser({ maxLineLength: 32 })
    expect(parser.push(`[netem] host log ${"x".repeat(100)}`)).toEqual([])
    expect(parser.push("still the same diagnostic\nE2E_NETEM_PHASE\tactive\toutage\n")).toEqual([
      { state: "active", detail: "outage" },
    ])
    expect(parser.finish()).toEqual([])
  })
})
