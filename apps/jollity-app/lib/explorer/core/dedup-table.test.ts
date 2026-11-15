// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { DedupTable, dedupKey, NO_NODE, PathArena } from "./dedup-table"

const hex = (seed: string): string => createHash("sha256").update(seed).digest("hex").slice(0, 32)

describe("DedupTable", () => {
  it("inserts, finds and keeps faults apart in the key", () => {
    const table = new DedupTable()
    const key = dedupKey(hex("a"), 2)
    expect(table.find(key)).toBe(-1)
    table.set(key, 5, 7)
    const slot = table.find(key)
    expect(slot).not.toBe(-1)
    expect(table.remaining(slot)).toBe(5)
    expect(table.node(slot)).toBe(7)
    expect(table.find(dedupKey(hex("a"), 1))).toBe(-1)
    expect(table.find(dedupKey(hex("a"), undefined))).toBe(-1)
    expect(table.find(dedupKey(hex("b"), 2))).toBe(-1)
    expect(table.size).toBe(1)
  })

  it("overwrites the remaining depth and node in place when a key comes back with more depth left", () => {
    const table = new DedupTable()
    const key = dedupKey(hex("a"), 0)
    table.set(key, 2, 1)
    table.set(key, 4, 9)
    const slot = table.find(key)
    expect(table.size).toBe(1)
    expect(table.remaining(slot)).toBe(4)
    expect(table.node(slot)).toBe(9)
  })

  it("grows by doubling past a 0.6 load and keeps every entry", () => {
    const table = new DedupTable(16)
    expect(table.capacity).toBe(16)
    for (let index = 0; index < 1000; index += 1) table.set(dedupKey(hex(String(index)), index % 3), (index % 200) + 1, index)
    expect(table.size).toBe(1000)
    expect(table.capacity).toBe(2048)
    expect(table.byteLength).toBe(2048 * 24)
    for (let index = 0; index < 1000; index += 1) {
      const slot = table.find(dedupKey(hex(String(index)), index % 3))
      expect(table.remaining(slot)).toBe((index % 200) + 1)
      expect(table.node(slot)).toBe(index)
    }
  })

  it("separates keys that agree on their low bits", () => {
    // test keys pass through digest128 unhashed, so they can share every low bit
    const table = new DedupTable(16)
    const keys = Array.from({ length: 200 }, (_, index) => `${index.toString(16).padStart(8, "0")}${"0".repeat(24)}`)
    keys.forEach((key, index) => table.set(dedupKey(key, 0), 1 + (index % 9), index))
    keys.forEach((key, index) => {
      const slot = table.find(dedupKey(key, 0))
      expect(table.node(slot)).toBe(index)
    })
    // and keys equal in all but one word, or in the faults alone
    const base = "0".repeat(32)
    const variants = [base, `1${"0".repeat(31)}`, `${"0".repeat(31)}1`, `${"0".repeat(8)}1${"0".repeat(23)}`]
    const small = new DedupTable(16)
    variants.forEach((key, index) => small.set(dedupKey(key, 0), 1, index))
    variants.forEach((key, index) => small.set(dedupKey(key, 1), 1, 10 + index))
    expect(small.size).toBe(8)
    variants.forEach((key, index) => {
      expect(small.node(small.find(dedupKey(key, 0)))).toBe(index)
      expect(small.node(small.find(dedupKey(key, 1)))).toBe(10 + index)
    })
  })

  it("rejects what it cannot store", () => {
    const table = new DedupTable()
    expect(() => table.set(dedupKey(hex("a"), 0), 0, 0)).toThrow(RangeError)
    expect(() => table.set(dedupKey(hex("a"), 0), 256, 0)).toThrow(RangeError)
    expect(() => dedupKey("xyz", 0)).toThrow(RangeError)
    expect(() => dedupKey(hex("a"), -1)).toThrow(RangeError)
    expect(() => dedupKey(hex("a"), 1.5)).toThrow(RangeError)
  })

  it("makes the same pruning decisions as the string-keyed Map it replaced (randomized)", () => {
    let state = 0x2545_f491
    const random = (bound: number): number => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) % bound
    }
    const table = new DedupTable(16)
    const map = new Map<string, { remaining: number; node: number }>()
    // a small key space so keys repeat often, with faults included and left out
    for (let step = 0; step < 50_000; step += 1) {
      const fingerprint = hex(String(random(3000)))
      const faults = random(4) === 0 ? undefined : random(3)
      const mapKey = faults === undefined ? fingerprint : `${fingerprint}\0F=${faults}`
      const key = dedupKey(fingerprint, faults)
      const remaining = 1 + random(20)
      const prior = map.get(mapKey)
      const slot = table.find(key)
      expect(slot === -1).toBe(prior === undefined)
      const pruneByMap = prior !== undefined && prior.remaining >= remaining
      const pruneByTable = slot !== -1 && table.remaining(slot) >= remaining
      expect(pruneByTable).toBe(pruneByMap)
      if (pruneByMap) {
        expect(table.node(slot)).toBe(prior!.node)
      } else {
        map.set(mapKey, { remaining, node: step })
        table.set(key, remaining, step)
      }
    }
    expect(table.size).toBe(map.size)
  })
})

describe("PathArena", () => {
  it("rebuilds every path from parent pointers, through growth", () => {
    const arena = new PathArena()
    const root = arena.push(NO_NODE, undefined)
    expect(arena.path(root)).toEqual([])
    const nodes: { node: number; path: string[] }[] = [{ node: root, path: [] }]
    for (let index = 0; index < 3000; index += 1) {
      const parent = nodes[(index * 7919) % nodes.length]!
      const label = `l${index % 13}`
      nodes.push({ node: arena.push(parent.node, label), path: [...parent.path, label] })
    }
    for (const { node, path } of nodes) expect(arena.path(node)).toEqual(path)
    expect(arena.length).toBe(3001)
    expect(arena.byteLength).toBe(4096 * 8)
  })
})
