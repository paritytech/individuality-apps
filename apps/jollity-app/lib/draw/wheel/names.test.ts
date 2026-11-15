// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { NAME_READS_AT_ONCE, nameCache, rowLabels, rowName, unnamedLabel } from "./names"

describe("nameCache", () => {
  it("reads a ticket once, however often it is asked for", async () => {
    const lookup = vi.fn(async (ticket: string) => `name-of-${ticket}`)
    const nameOf = nameCache(lookup)
    const [a, b] = await Promise.all([nameOf("aa"), nameOf("aa")])
    expect([a, b, await nameOf("aa")]).toEqual(["name-of-aa", "name-of-aa", "name-of-aa"])
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it("asks again for a ticket that had no name, or whose read failed", async () => {
    const answers: Array<string | null | Error> = [null, new Error("offline"), "lena.12"]
    const lookup = vi.fn(async () => {
      const next = answers.shift()!
      if (next instanceof Error) throw next
      return next
    })
    const nameOf = nameCache(lookup)
    expect(await nameOf("aa")).toBeNull()
    expect(await nameOf("aa")).toBeNull()
    expect(await nameOf("aa")).toBe("lena.12")
    expect(await nameOf("aa")).toBe("lena.12")
    expect(lookup).toHaveBeenCalledTimes(3)
  })

  it("names nobody without a lookup", async () => {
    expect(await nameCache(undefined)("aa")).toBeNull()
  })
})

describe("who's playing: the row's labels", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it("writes a name in the row's capitals", () => {
    expect(rowName(" jollity-ana.74 ")).toBe("JOLLITY-ANA.74")
  })

  it("labels a ticket nobody has named by the start of its slot", () => {
    expect(unnamedLabel("0x3f2a9c")).toBe("#3F2A")
    expect(unnamedLabel("3f2a9c")).toBe("#3F2A")
  })

  it("shows a ticket's code until its name lands, then the name, and says so each time", async () => {
    const onName = vi.fn()
    const names: Record<string, string | null> = { aaaa: "ana", bbbb: null }
    const labels = rowLabels(["aaaa", "bbbb"], async (slot) => names[slot] ?? null, onName)
    expect([labels.labelOf(0), labels.labelOf(1)]).toEqual(["#AAAA", "#BBBB"])
    await flush()
    expect([labels.labelOf(0), labels.labelOf(1)]).toEqual(["ANA", "#BBBB"])
    expect(onName).toHaveBeenCalledTimes(1)
  })

  it("keeps a failed read as the ticket's code", async () => {
    const labels = rowLabels(["aaaa"], async () => Promise.reject(new Error("offline")), () => {})
    await flush()
    expect(labels.labelOf(0)).toBe("#AAAA")
  })

  it("reads you and the winners first, and never more than a few at once", async () => {
    const slots = Array.from({ length: NAME_READS_AT_ONCE + 4 }, (_, i) => `${i}`.padStart(4, "0"))
    const asked: string[] = []
    let inFlight = 0
    let most = 0
    const pending: Array<() => void> = []
    const lookup = (slot: string) =>
      new Promise<string | null>((resolve) => {
        asked.push(slot)
        inFlight++
        most = Math.max(most, inFlight)
        pending.push(() => {
          inFlight--
          resolve(null)
        })
      })
    rowLabels(slots, lookup, () => {}, [0, 7])
    expect(asked.slice(0, 2)).toEqual(["0000", "0007"])
    while (pending.length) {
      pending.shift()!()
      await flush()
    }
    expect(new Set(asked).size).toBe(slots.length)
    expect(most).toBe(NAME_READS_AT_ONCE)
  })

  it("drops names that land after the page has gone", async () => {
    const onName = vi.fn()
    const labels = rowLabels(["aaaa"], async () => "ana", onName)
    labels.stop()
    await flush()
    expect(labels.labelOf(0)).toBe("#AAAA")
    expect(onName).not.toHaveBeenCalled()
  })
})
