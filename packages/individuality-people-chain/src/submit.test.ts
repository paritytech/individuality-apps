// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { InvalidTxError } from "polkadot-api"
import { dispatchErrorName, isNonceRefusal, submitToBestBlock, type TxEvent } from "./submit"

type Observer = { next: (event: TxEvent) => void; error: (error: unknown) => void; complete?: () => void }

/** a watch the test drives by hand, and whether it was unsubscribed */
function watch() {
  let observer: Observer | undefined
  let unsubscribed = false
  return {
    subscribe(o: Observer) {
      observer = o
      return { unsubscribe: () => (unsubscribed = true) }
    },
    emit: (event: TxEvent) => observer!.next(event),
    fail: (error: unknown) => observer!.error(error),
    end: () => observer!.complete?.(),
    unsubscribed: () => unsubscribed,
  }
}

describe("submitToBestBlock", () => {
  it("resolves at the best block", async () => {
    const w = watch()
    const result = submitToBestBlock(w)
    w.emit({ type: "broadcasted" })
    w.emit({ type: "inBestBlock", ok: true })
    await expect(result).resolves.toEqual({ ok: true })
    expect(w.unsubscribed()).toBe(true)
  })

  it("names the pallet's error of a failed dispatch", async () => {
    const w = watch()
    const result = submitToBestBlock(w)
    w.emit({ type: "inBestBlock", ok: false, dispatchError: { type: "Module", value: { type: "Game", value: { type: "AlreadyRegistered" } } } })
    await expect(result).resolves.toEqual({ ok: false, error: "AlreadyRegistered" })
  })

  it("a watch that stopped tracking does not know whether the tx landed", async () => {
    const w = watch()
    const result = submitToBestBlock(w)
    w.emit({ type: "broadcasted" })
    w.fail(new Error("Tracking stopped"))
    await expect(result).resolves.toEqual({ ok: false, error: "Tracking stopped", landingUnknown: true })
  })

  it("a watch that ends before any block held the tx does not know either", async () => {
    const w = watch()
    const result = submitToBestBlock(w)
    w.emit({ type: "broadcasted" })
    w.end()
    await expect(result).resolves.toMatchObject({ ok: false, landingUnknown: true })
  })

  it("a refusal on the error channel is a known failure", async () => {
    const w = watch()
    const result = submitToBestBlock(w)
    w.fail({ type: "Invalid", value: { type: "Stale" } })
    await expect(result).resolves.toEqual({ ok: false, error: "Stale" })
  })

  it("settles on an event emitted while subscribing", async () => {
    let unsubscribed = false
    const result = submitToBestBlock({
      subscribe(observer) {
        observer.next({ type: "inBestBlock", ok: true })
        return { unsubscribe: () => (unsubscribed = true) }
      },
    })
    await expect(result).resolves.toEqual({ ok: true })
    expect(unsubscribed).toBe(true)
  })

  it("rejects with the reason once the signal aborts", async () => {
    const w = watch()
    const controller = new AbortController()
    const result = submitToBestBlock(w, controller.signal)
    controller.abort(new Error("gave up"))
    await expect(result).rejects.toThrow("gave up")
    expect(w.unsubscribed()).toBe(true)
  })
})

describe("isNonceRefusal", () => {
  it.each(["Stale", "Future"])("takes %s for a nonce refusal", (name) => {
    expect(isNonceRefusal(name)).toBe(true)
  })
  it.each(["Custom(172)", undefined])("is false for %s", (name) => {
    expect(isNonceRefusal(name)).toBe(false)
  })
})

describe("dispatchErrorName", () => {
  it("names a pool refusal by its innermost type", () => {
    expect(dispatchErrorName(new InvalidTxError({ type: "Invalid", value: { type: "Stale" } }))).toBe("Stale")
  })
  it("keeps the code of a custom pool refusal", () => {
    expect(dispatchErrorName(new InvalidTxError({ type: "Invalid", value: { type: "Custom", value: 172 } }))).toBe("Custom(172)")
  })
  it("ends on an error that leads back to itself", () => {
    const loop: { type: string; error?: unknown } = { type: "Looped" }
    loop.error = loop
    expect(dispatchErrorName(loop)).toBe("Looped")
  })
})
