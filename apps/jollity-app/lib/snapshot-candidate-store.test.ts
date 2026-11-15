// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { SnapshotCandidateStore } from "./snapshot-candidate-store"

describe("SnapshotCandidateStore", () => {
  it("keeps the best candidate and revokes rejected and replaced object URLs", () => {
    const revoked: string[] = []
    const store = new SnapshotCandidateStore<string>((url) => revoked.push(url))
    expect(store.offer("alice", { url: "blob:first", score: [0, 200, 20] }, 0)).toBe(true)
    expect(store.offer("alice", { url: "blob:worse", score: [0, 180, 20] }, 0)).toBe(false)
    expect(store.offer("alice", { url: "blob:host", score: [1, 144, 13] }, 0)).toBe(true)
    expect(store.photoFor("alice")).toBe("blob:host")
    expect(revoked).toEqual(["blob:worse", "blob:first"])
  })

  it("rejects late async results after the synchronous freeze boundary", () => {
    const revoked: string[] = []
    const store = new SnapshotCandidateStore<string>((url) => revoked.push(url))
    const generation = store.generation()
    store.freeze()
    expect(store.offer("alice", { url: "blob:late", score: [1, 720, 100] }, generation)).toBe(false)
    expect(store.photoFor("alice")).toBeUndefined()
    expect(store.generation()).toBe(1)
    expect(revoked).toEqual(["blob:late"])
  })

  it("revokes every retained URL on disposal", () => {
    const revoked: string[] = []
    const store = new SnapshotCandidateStore<string>((url) => revoked.push(url))
    store.offer("alice", { url: "blob:a", score: [0, 200, 20] }, 0)
    store.offer("bob", { url: "blob:b", score: [0, 200, 20] }, 0)
    store.dispose()
    expect(revoked).toEqual(["blob:a", "blob:b"])
    expect(store.frozen()).toBe(true)
  })
})
