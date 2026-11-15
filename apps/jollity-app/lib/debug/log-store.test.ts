// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { addDevLogSink, devLog } from "./log-store"

describe("the devLog sinks", () => {
  it("hands every line to every sink, in the order they were added", () => {
    const seen: string[] = []
    const stopA = addDevLogSink((entry) => seen.push(`a:${entry.message}`))
    const stopB = addDevLogSink((entry) => seen.push(`b:${entry.message}`))
    devLog("test", "one")
    expect(seen).toEqual(["a:one", "b:one"])
    stopA()
    stopB()
  })

  it("stops handing lines to a sink once it is removed", () => {
    const seen: string[] = []
    const stop = addDevLogSink((entry) => seen.push(entry.message))
    devLog("test", "before")
    stop()
    devLog("test", "after")
    expect(seen).toEqual(["before"])
  })

  it("keeps logging to the other sinks when one throws", () => {
    const seen: string[] = []
    const stopBad = addDevLogSink(() => {
      throw new Error("broken sink")
    })
    const stopGood = addDevLogSink((entry) => seen.push(entry.message))
    expect(() => devLog("test", "still here")).not.toThrow()
    expect(seen).toEqual(["still here"])
    stopBad()
    stopGood()
  })
})

describe("what a sink receives", () => {
  const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident"

  it("has the message scrubbed and the data text computed once for all sinks", () => {
    const texts: Array<string | undefined> = []
    const messages: string[] = []
    const stopA = addDevLogSink((entry) => {
      messages.push(entry.message)
      texts.push(entry.dataText())
    })
    const stopB = addDevLogSink((entry) => texts.push(entry.dataText()))
    devLog("test", `seed: ${PHRASE}`, { seed: PHRASE })
    stopA()
    stopB()
    expect(messages[0]).toBe("seed: [redacted: mnemonic-like string]")
    expect(texts[0]).toBe('{"seed":"[redacted: mnemonic-like string]"}')
    expect(texts[1]).toBe(texts[0])
  })

  it("has no data text for a line without data", () => {
    let text: string | undefined = "unset"
    const stop = addDevLogSink((entry) => (text = entry.dataText()))
    devLog("test", "plain")
    stop()
    expect(text).toBeUndefined()
  })
})
