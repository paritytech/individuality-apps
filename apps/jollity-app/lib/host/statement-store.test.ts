// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const trace = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock("../debug/log-store", () => ({ devLog: () => {} }))

import { playerStatementStore } from "./statement-store"

describe("the room's statement subscription", () => {
  beforeEach(() => {
    trace.calls.length = 0
  })

  it("marks the subscription and the first page for the join, once", async () => {
    let deliver: (page: { statements: { data: string }[] }) => void = () => {}
    const store = {
      subscribe: (_filter: unknown, onPage: typeof deliver) => {
        trace.calls.push("host subscribe")
        deliver = onPage
        return { unsubscribe() {} }
      },
    }
    const sdk = { getStatementStore: async () => store, getTruApi: async () => ({}) }
    const account = { dotNsIdentifier: "x", derivationIndex: 0 }
    const wrapped = await playerStatementStore(sdk as never, account as never, {
      onSubscribed: () => trace.calls.push("subscribed"),
      onFirstPage: () => trace.calls.push("first page"),
    })
    wrapped?.subscribe({ matchAny: [] } as never, () => {})
    deliver({ statements: [{ data: "0x" }] })
    deliver({ statements: [] })
    expect(trace.calls).toEqual(["subscribed", "host subscribe", "first page"])
  })

  it("works without hooks", async () => {
    let deliver: (page: { statements: { data: string }[] }) => void = () => {}
    const store = {
      subscribe: (_filter: unknown, onPage: typeof deliver) => {
        deliver = onPage
        return { unsubscribe() {} }
      },
    }
    const sdk = { getStatementStore: async () => store, getTruApi: async () => ({}) }
    const wrapped = await playerStatementStore(sdk as never, { dotNsIdentifier: "x", derivationIndex: 0 } as never)
    wrapped?.subscribe({ matchAny: [] } as never, () => {})
    expect(() => deliver({ statements: [] })).not.toThrow()
  })
})

/** A host store whose subscriptions the test can end, as the host does
 *  (`onInterrupt`): every subscribe call opens a new one. */
function endableStore() {
  const opened: Array<{ deliver: (page: { statements: { data: string }[] }) => void; end: (reason?: unknown) => void; unsubscribed: boolean }> = []
  const store = {
    subscribe: (_filter: unknown, onPage: (page: { statements: { data: string }[] }) => void) => {
      const entry = { deliver: onPage, end: (() => {}) as (reason?: unknown) => void, unsubscribed: false }
      opened.push(entry)
      return {
        unsubscribe() {
          entry.unsubscribed = true
        },
        onInterrupt(callback: (reason?: unknown) => void) {
          entry.end = callback
          return () => {}
        },
      }
    },
  }
  const sdk = { getStatementStore: async () => store, getTruApi: async () => ({}), formatHostError: () => "ended" }
  return { sdk, opened }
}

describe("a statement subscription the host ends", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("is opened again, and its pages reach the same handler", async () => {
    const { sdk, opened } = endableStore()
    const hooks = { onInterrupted: vi.fn(), onResubscribed: vi.fn() }
    const wrapped = await playerStatementStore(sdk as never, { dotNsIdentifier: "x", derivationIndex: 0 } as never, hooks)
    const pages: unknown[] = []
    wrapped?.subscribe({ matchAny: [] } as never, (page) => pages.push(page))
    opened[0].end()
    expect(hooks.onInterrupted).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(opened).toHaveLength(2)
    expect(hooks.onResubscribed).toHaveBeenCalledWith(1)
    opened[1].deliver({ statements: [{ data: "0x01" }] })
    expect(pages).toEqual([{ statements: [{ data: "0x01" }] }])
  })

  it("backs off while the host keeps ending it, and starts over once pages flow", async () => {
    const { sdk, opened } = endableStore()
    const wrapped = await playerStatementStore(sdk as never, { dotNsIdentifier: "x", derivationIndex: 0 } as never)
    wrapped?.subscribe({ matchAny: [] } as never, () => {})
    opened[0].end()
    await vi.advanceTimersByTimeAsync(1000) // 1 s
    opened[1].end()
    await vi.advanceTimersByTimeAsync(1999)
    expect(opened).toHaveLength(2) // 2 s now
    await vi.advanceTimersByTimeAsync(1)
    expect(opened).toHaveLength(3)
    opened[2].deliver({ statements: [] }) // it works again
    opened[2].end()
    await vi.advanceTimersByTimeAsync(1000) // back to 1 s
    expect(opened).toHaveLength(4)
  })

  it("is not opened again once unsubscribed", async () => {
    const { sdk, opened } = endableStore()
    const wrapped = await playerStatementStore(sdk as never, { dotNsIdentifier: "x", derivationIndex: 0 } as never)
    const sub = wrapped?.subscribe({ matchAny: [] } as never, () => {})
    opened[0].end()
    sub?.unsubscribe?.()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(opened).toHaveLength(1)
  })

  it("unsubscribes the one that is open", async () => {
    const { sdk, opened } = endableStore()
    const wrapped = await playerStatementStore(sdk as never, { dotNsIdentifier: "x", derivationIndex: 0 } as never)
    const sub = wrapped?.subscribe({ matchAny: [] } as never, () => {})
    opened[0].end()
    await vi.advanceTimersByTimeAsync(1000)
    sub?.unsubscribe?.()
    expect(opened[1].unsubscribed).toBe(true)
  })
})
