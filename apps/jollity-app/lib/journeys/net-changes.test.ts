// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { retryableNetworkChange, watchNetwork, type NetChange } from "./net-changes"

/** a tiny event target: what window and navigator.connection are to the watcher */
function target() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    listeners,
    addEventListener: (name: string, fn: () => void) => void (listeners.get(name) ?? listeners.set(name, new Set()).get(name)!).add(fn),
    removeEventListener: (name: string, fn: () => void) => void listeners.get(name)?.delete(fn),
    fire: (name: string) => listeners.get(name)?.forEach((fn) => fn()),
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  }
}

let win: ReturnType<typeof target>
let conn: ReturnType<typeof target> & { type: string; effectiveType: string }
let nav: { onLine: boolean; connection?: typeof conn }

beforeEach(() => {
  win = target()
  conn = Object.assign(target(), { type: "wifi", effectiveType: "4g" })
  nav = { onLine: true, connection: conn }
  vi.stubGlobal("window", win)
  vi.stubGlobal("navigator", nav)
})
afterEach(() => vi.unstubAllGlobals())

const collect = () => {
  const seen: NetChange[] = []
  const stop = watchNetwork((change) => seen.push(change))
  return { seen, stop }
}

describe("watchNetwork", () => {
  it("retries only on an online edge or a real connection type change", () => {
    expect(retryableNetworkChange({ event: "online", attrs: { "net.online": "true" } })).toBe(true)
    expect(retryableNetworkChange({ event: "offline", attrs: { "net.online": "false" } })).toBe(false)
    expect(retryableNetworkChange({ event: "change", attrs: { "net.from_type": "wifi", "net.type": "cellular" } })).toBe(true)
    expect(retryableNetworkChange({ event: "change", attrs: { "net.from_type": "cellular", "net.type": "cellular", "net.effective": "3g" } })).toBe(false)
  })
  it("reports offline and online with the connection at that moment", () => {
    const { seen } = collect()
    nav.onLine = false
    win.fire("offline")
    nav.onLine = true
    win.fire("online")
    expect(seen.map((change) => change.event)).toEqual(["offline", "online"])
    expect(seen[0].attrs).toMatchObject({ "net.event": "offline", "net.online": "false", "net.type": "wifi", "net.effective": "4g" })
    expect(seen[1].attrs).toMatchObject({ "net.event": "online", "net.online": "true" })
  })

  it("reports a connection change with what it changed from", () => {
    const { seen } = collect()
    conn.type = "cellular"
    conn.effectiveType = "3g"
    conn.fire("change")
    expect(seen).toHaveLength(1)
    expect(seen[0].event).toBe("change")
    expect(seen[0].attrs).toMatchObject({ "net.type": "cellular", "net.effective": "3g", "net.from_type": "wifi", "net.from_effective": "4g" })
    // the next change is from the new one
    conn.type = "wifi"
    conn.fire("change")
    expect(seen[1].attrs).toMatchObject({ "net.from_type": "cellular", "net.type": "wifi" })
  })

  it("says unsupported where the browser has no connection API (iOS), and still reports online and offline", () => {
    delete nav.connection
    const { seen } = collect()
    nav.onLine = false
    win.fire("offline")
    expect(seen[0].attrs).toMatchObject({ "net.event": "offline", "net.type": "unsupported", "net.effective": "unsupported", "net.connection": "unsupported" })
  })

  it("says unsupported for the online flag when the browser has none", () => {
    delete (nav as { onLine?: boolean }).onLine
    const { seen } = collect()
    win.fire("online")
    expect(seen[0].attrs["net.online"]).toBe("unsupported")
  })

  it("removes every listener when stopped", () => {
    const { seen, stop } = collect()
    expect(win.count() + conn.count()).toBe(3)
    stop()
    expect(win.count() + conn.count()).toBe(0)
    win.fire("offline")
    conn.fire("change")
    expect(seen).toEqual([])
  })

  it("never throws into the page when the callback does", () => {
    watchNetwork(() => {
      throw new Error("boom")
    })
    expect(() => win.fire("offline")).not.toThrow()
  })

  it("does nothing without a window", () => {
    vi.stubGlobal("window", undefined)
    expect(() => watchNetwork(() => {})()).not.toThrow()
  })
})
