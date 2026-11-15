// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

/** a host with stateful storage, so consent written by one call is read by the next */
function host(initial = "", login: "Connected" | "Rejected" = "Connected") {
  const store = new Map<string, string>(initial ? [["jollity.nameConsent", initial]] : [])
  const writes: string[] = []
  const json: [string, unknown][] = []
  const requestLogin = vi.fn(() => ({
    match: (ok: (value: string) => unknown, fail: () => unknown) => (login === "Rejected" ? fail() : ok(login)),
  }))
  const getUserId = vi.fn(() => ({ match: (ok: (value: { primaryUsername: string }) => unknown) => ok({ primaryUsername: " carol " }) }))
  vi.doMock("@parity/product-sdk-host", () => ({
    isInsideContainerSync: () => true,
    getHostLocalStorage: async () => ({
      readString: async (k: string) => store.get(k) ?? "",
      writeJSON: async (k: string, v: unknown) => void json.push([k, v]),
      writeString: async (k: string, v: string) => {
        writes.push(v)
        store.set(k, v)
      },
    }),
    getAccountsProvider: async () => ({ requestLogin, getUserId }),
  }))
  return { requestLogin, getUserId, writes, json }
}

beforeEach(() => vi.resetModules())

describe("the permissioned name", () => {
  it("is the trimmed primary username", async () => {
    host()
    const { requestDisplayName } = await import("./identity")
    await expect(requestDisplayName("so your card carries your name")).resolves.toBe("carol")
  })

  it("hands the name to the chat worker through host storage", async () => {
    const h = host()
    const { requestDisplayName } = await import("./identity")
    await requestDisplayName("x")
    expect(h.json).toEqual([["jollity.playerName", "carol"]])
  })

  it("shares one requestLogin between concurrent calls", async () => {
    const h = host()
    const { requestDisplayName } = await import("./identity")
    const names = await Promise.all([requestDisplayName("a"), requestDisplayName("b")])
    expect(names).toEqual(["carol", "carol"])
    expect(h.requestLogin).toHaveBeenCalledTimes(1)
    expect(h.getUserId).toHaveBeenCalledTimes(1)
  })

  it("does not rewrite a consent that is already granted", async () => {
    const h = host("granted")
    const { requestDisplayName } = await import("./identity")
    await requestDisplayName("x")
    expect(h.writes).toEqual([])
  })
})

describe("knownDisplayName", () => {
  it("never asks without consent unless told to", async () => {
    const h = host()
    const { knownDisplayName } = await import("./identity")
    await expect(knownDisplayName()).resolves.toBeNull()
    expect(h.requestLogin).not.toHaveBeenCalled()
  })

  it("ask: true names a player who never reached the results card, with no stored consent", async () => {
    const h = host()
    const { knownDisplayName } = await import("./identity")
    await expect(knownDisplayName({ ask: true })).resolves.toBe("carol")
    expect(h.writes).toEqual(["granted"])
  })

  it("a silent caller after an asking one gets the name, from the consent the asking call stored", async () => {
    const h = host()
    const { knownDisplayName } = await import("./identity")
    await knownDisplayName({ ask: true })
    await expect(knownDisplayName()).resolves.toBe("carol")
    expect(h.requestLogin).toHaveBeenCalledTimes(1)
  })

  it("a silent caller before an asking one is not changed by it", async () => {
    const h = host()
    const { knownDisplayName } = await import("./identity")
    await expect(knownDisplayName()).resolves.toBeNull()
    await expect(knownDisplayName({ ask: true })).resolves.toBe("carol")
    expect(h.requestLogin).toHaveBeenCalledTimes(1)
  })

  it("two concurrent asking calls share one login", async () => {
    const h = host()
    const { knownDisplayName } = await import("./identity")
    await Promise.all([knownDisplayName({ ask: true }), knownDisplayName({ ask: true })])
    expect(h.requestLogin).toHaveBeenCalledTimes(1)
  })

  it("a remembered refusal is final, asking or not", async () => {
    const h = host("rejected")
    const { knownDisplayName } = await import("./identity")
    await expect(knownDisplayName({ ask: true })).resolves.toBeNull()
    expect(h.requestLogin).not.toHaveBeenCalled()
  })

  it("a refusal at the host's prompt is remembered and answers null", async () => {
    const h = host("", "Rejected")
    const { knownDisplayName } = await import("./identity")
    await expect(knownDisplayName({ ask: true })).resolves.toBeNull()
    expect(h.writes).toEqual(["rejected"])
  })
})
