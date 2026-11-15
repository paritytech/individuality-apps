// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { silenceConsoleLog } from "./quiet-console"

function fakeConsole() {
  const calls: string[] = []
  const target = {
    log: () => calls.push("log"),
    info: () => calls.push("info"),
    debug: () => calls.push("debug"),
    warn: () => calls.push("warn"),
    error: () => calls.push("error"),
  }
  return { calls, target, original: { ...target } }
}

describe("silenceConsoleLog", () => {
  it("silences only log, and restore puts the original back", () => {
    const { calls, target, original } = fakeConsole()
    const restore = silenceConsoleLog(target)
    target.log(); target.info(); target.debug(); target.warn(); target.error()
    expect(calls).toEqual(["info", "debug", "warn", "error"])
    restore()
    expect(target).toEqual(original)
    target.log()
    expect(calls.at(-1)).toBe("log")
  })

  it("restores once: a second call of the same restore does nothing extra", () => {
    const { target, original } = fakeConsole()
    const outer = silenceConsoleLog(target)
    const inner = silenceConsoleLog(target)
    inner()
    inner()
    expect(target.log).not.toBe(original.log)
    outer()
    expect(target.log).toBe(original.log)
  })

  for (const order of ["LIFO", "out-of-order"] as const) {
    it(`keeps log silent until both overlapping silences are restored (${order})`, () => {
      const { calls, target, original } = fakeConsole()
      const first = silenceConsoleLog(target)
      const second = silenceConsoleLog(target)
      const [early, late] = order === "LIFO" ? [second, first] : [first, second]
      early()
      target.log()
      expect(calls).toEqual([])
      late()
      expect(target.log).toBe(original.log)
      // a fresh silence after full release saves the original again
      silenceConsoleLog(target)()
      expect(target.log).toBe(original.log)
    })
  }

  it("restores from a finally after a thrown error", () => {
    const { target, original } = fakeConsole()
    expect(() => {
      const restore = silenceConsoleLog(target)
      try {
        throw new Error("boom")
      } finally {
        restore()
      }
    }).toThrow("boom")
    expect(target.log).toBe(original.log)
  })
})
