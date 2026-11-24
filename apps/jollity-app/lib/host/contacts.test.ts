// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => ({ api: null as unknown, calls: 0 }))
vi.mock("@parity/product-sdk-host", () => ({
  getTruApi: async () => sdk.api,
  formatHostError: (error: { tag: string }) => error.tag,
}))

/** a host whose contacts.usernames answers with `answer` (a list, or an error's tag), or never */
function host(answer: readonly string[] | string | "hangs") {
  sdk.api = {
    contacts: {
      usernames: () => {
        sdk.calls++
        if (answer === "hangs") return new Promise(() => {})
        return {
          match: (ok: (value: { usernames: readonly string[] }) => unknown, err: (error: { tag: string }) => unknown) =>
            typeof answer === "string" ? err({ tag: answer }) : ok({ usernames: answer }),
        }
      },
    },
  }
}

/** a fresh page: the module keeps its list for the page's life */
async function page() {
  vi.resetModules()
  return (await import("./contacts")).contactUsernames
}

afterEach(() => {
  vi.useRealTimers()
  sdk.api = null
  sdk.calls = 0
})

describe("contactUsernames", () => {
  it("is empty outside a host", async () => {
    const contactUsernames = await page()
    expect(await contactUsernames()).toEqual([])
  })

  it("gives the host's usernames, each once, with blank ones dropped", async () => {
    host(["alice", " bob.07 ", "", "alice"])
    const contactUsernames = await page()
    expect(await contactUsernames()).toEqual(["alice", "bob.07"])
  })

  it("asks the host once a page", async () => {
    host(["alice"])
    const contactUsernames = await page()
    await contactUsernames()
    expect(await contactUsernames()).toEqual(["alice"])
    expect(sdk.calls).toBe(1)
  })

  it("is empty when the host refuses, and asks again next time", async () => {
    host("Unsupported")
    const contactUsernames = await page()
    expect(await contactUsernames()).toEqual([])
    host(["alice"])
    expect(await contactUsernames()).toEqual(["alice"])
    expect(sdk.calls).toBe(2)
  })

  it("is empty when the host never answers", async () => {
    vi.useFakeTimers()
    host("hangs")
    const contactUsernames = await page()
    const listed = contactUsernames()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await listed).toEqual([])
  })
})
