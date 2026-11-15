// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The streamed fingerprint walk (room.ts canonicalFingerprintValue) against
 * the walk it replaced (fingerprint-reference.ts): the canonical text must be
 * byte-identical, so every saved fingerprint (census keys, witnesses, known-gap
 * state keys) still matches. Random values that reach every branch, the edge
 * cases one by one, and random schedules over real rooms.
 */
// quiescence first: it traps the real timers before anything else loads
import "./quiescence"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { referenceFingerprintValue } from "./fingerprint-reference"
import { randomSchedules, rng } from "./random-schedules"
import { canonicalFingerprintValue, HarnessError, pathOf, type FingerprintWalkHooks } from "./room"

const KEYS = ["a", "b", "id", "commandId", "log", "0", "1", "2", "10", "01", "-1", "4294967294", "4294967295", "", "x/log/y", "é", "\"q\""]
const STRINGS = ["", "plain", "wire-3", "quote\"and\\slash", "\ud800lone", "emoji 😀", "line\nbreak", "drop-me", "fn-me", " "]
const NUMBERS = [0, -0, 1, 7, 42, -3.5, 1e21, 1e-7, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER]

class Holder {
  constructor(public inner: unknown, public n = 1) {}
}

function randomValue(random: () => number, depth: number, pool: object[]): unknown {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!
  const roll = random()
  if (depth <= 0 || roll < 0.3) {
    const kind = Math.floor(random() * 10)
    switch (kind) {
      case 0: case 1: return pick(NUMBERS)
      case 2: case 3: return pick(STRINGS)
      case 4: return random() < 0.5
      case 5: return null
      case 6: return undefined
      case 7: return BigInt(Math.floor(random() * 1000) - 500)
      case 8: return () => 1
      default: return Symbol("s")
    }
  }
  if (roll < 0.38 && pool.length > 0) return pick(pool) // shared, and sometimes a cycle
  const shape = Math.floor(random() * 9)
  const children = Math.floor(random() * 5)
  if (shape === 0 || shape === 1) {
    const array: unknown[] = []
    pool.push(array)
    for (let index = 0; index < children; index++) array.push(randomValue(random, depth - 1, pool))
    if (random() < 0.3) array[children + 2] = randomValue(random, depth - 1, pool) // holes
    if (random() < 0.2 && array.length > 0) delete array[0]
    return array
  }
  if (shape === 2 || shape === 3) {
    const object: Record<string, unknown> = {}
    pool.push(object)
    for (let index = 0; index < children; index++) object[pick(KEYS)] = randomValue(random, depth - 1, pool)
    if (random() < 0.1) Object.defineProperty(object, "__proto__", { value: randomValue(random, depth - 1, pool), enumerable: true, configurable: true, writable: true })
    return object
  }
  if (shape === 4) {
    const map = new Map<unknown, unknown>()
    pool.push(map)
    for (let index = 0; index < children; index++) map.set(random() < 0.7 ? pick([...KEYS, ...NUMBERS]) : randomValue(random, depth - 1, pool), randomValue(random, depth - 1, pool))
    return map
  }
  if (shape === 5) {
    const set = new Set<unknown>()
    pool.push(set)
    for (let index = 0; index < children; index++) set.add(randomValue(random, depth - 1, pool))
    return set
  }
  if (shape === 6) {
    const holder = new Holder(undefined, Math.floor(random() * 3))
    pool.push(holder)
    holder.inner = randomValue(random, depth - 1, pool)
    return holder
  }
  if (shape === 7) return pick([new Uint8Array([1, 2, Math.floor(random() * 255)]), new Uint8Array([4, 5]).buffer, new Float64Array([1.5]), new Date(Math.floor(random() * 1e12)), new Date(Number.NaN)])
  return Promise.resolve(1)
}

const hooks: FingerprintWalkHooks = {
  transform: (value, key, at) => {
    if (value === 7) return { value: { $timer: 1 } }
    if (typeof value === "number" && (key === "id" || key === "commandId") && pathOf(at).includes("/log/")) return { value: `cmd${String(value)}` }
    if (value === "drop-me") return { value: undefined }
    if (value === "fn-me") return { value: () => 1 }
    if (value instanceof Holder && value.n === 2) return { value: { $holder: pathOf(at) } }
    return undefined
  },
  orderKey: (value) => `${typeof value}:${String(typeof value === "object" && value !== null ? JSON.stringify(Object.keys(value)) : String(value))}`,
}

const same = (value: unknown, withHooks?: FingerprintWalkHooks) =>
  expect(canonicalFingerprintValue(value, withHooks)).toBe(referenceFingerprintValue(value, withHooks))

describe("the streamed fingerprint walk", () => {
  it("writes the reference walk's text for random values, with and without hooks", () => {
    const random = rng(7)
    for (let round = 0; round < 3000; round++) {
      const pool: object[] = []
      const value = randomValue(random, 5, pool)
      same({ root: value, again: pool[0] ?? null })
      same({ log: [{ id: 3, commandId: 4, nested: { id: 5 } }], value, timers: [7, 7] }, hooks)
    }
  })

  it("matches the reference on each edge case", () => {
    const shared = { s: 1 }
    const cyclic: Record<string, unknown> = { name: "c" }
    cyclic.self = cyclic
    const holes = [1, , 3]
    const ownProto: Record<string, unknown> = {}
    Object.defineProperty(ownProto, "__proto__", { value: 1, enumerable: true })
    for (const value of [
      { b: 1, a: 2, 10: "ten", 2: "two", "01": "zero-one", "-1": "minus", 4294967295: "max", 4294967294: "index" },
      { first: shared, second: [shared, shared], third: new Map([[shared, shared]]) },
      cyclic,
      holes,
      [undefined, () => 1, Symbol("x"), null],
      new Map<unknown, unknown>([[() => 1, Symbol("y")], ["k", undefined]]),
      new Set([undefined, () => 1, 1]),
      { fn: () => 1, sym: Symbol("z"), undef: undefined, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, negZero: -0 },
      { "x/log/y": { id: 3 }, log: { id: 4, commandId: 5, other: 6 }, deep: { log: [{ id: 7 }] } },
      "\ud800",
      ownProto,
      new Holder(new Holder(1, 2), 1),
      123n,
      Promise.resolve(1),
      new Date(5),
      new Uint16Array([1, 2]),
    ]) {
      same(value)
      same({ value }, hooks)
    }
    expect(() => canonicalFingerprintValue(new DataView(new ArrayBuffer(2)))).toThrow(HarnessError)
    expect(() => canonicalFingerprintValue({ a: new (class Empty {})() })).toThrow(/exotic object: Empty/)
    expect(() => referenceFingerprintValue({ a: new (class Empty {})() })).toThrow(/exotic object: Empty/)
  })
})

describe("the room's fingerprint through the streamed walk", () => {
  for (const [name, seed] of [["steady", 21], ["rejoin-two-offers", 22], ["mid-glare", 23], ["ice-disconnected", 24]] as const) {
    it(`is the reference walk's digest at every node of random schedules: ${name}`, async () => {
      let compared = 0
      const mismatches: string[] = []
      await randomSchedules(name, { schedules: 6, depth: 10, seed }, (room) => {
        const walks = room as unknown as { fingerprintWith(canonical: (root: unknown, hooks: FingerprintWalkHooks) => string): string }
        const streamed: string[] = []
        const reference: string[] = []
        const digest = walks.fingerprintWith((root, rootHooks) => {
          const text = canonicalFingerprintValue(root, rootHooks)
          streamed.push(text)
          return text
        })
        walks.fingerprintWith((root, rootHooks) => {
          const text = referenceFingerprintValue(root, rootHooks)
          reference.push(text)
          return text
        })
        expect(room.fingerprint()).toBe(digest)
        expect(digest).toBe(createHash("sha256").update(reference.at(-1)!).digest("hex"))
        for (let index = 0; index < reference.length; index++) {
          compared++
          if (streamed[index] !== reference[index] && mismatches.length < 3) mismatches.push(`${streamed[index]}\n  !=\n${reference[index]}`)
        }
      })
      expect(mismatches).toEqual([])
      expect(compared).toBeGreaterThan(6)
    }, 300_000)
  }
})
