// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The --dedup visited table, stored compactly. A Map from a string key to
 * `{ remaining, path }` cost about 1 KB per state at depth 20 (the key string
 * plus a copy of the label path), and unbounded runs ran out of memory on it.
 *
 * DedupTable is an open-addressing hash table on one Uint32Array, 24 bytes a
 * slot: the 128-bit fingerprint digest as four words, a meta word (the
 * faults tag and the remaining depth) and a path-node id. PathArena keeps the
 * paths the dedup check replays as parent pointers, 8 bytes per expanded
 * node, and rebuilds the exact label path on demand.
 */
import type { Label } from "./labels"

const STRIDE = 6
const META = 4
const NODE = 5
const MAX_LOAD = 0.6
const MAX_REMAINING = 0xff
/** the faults tag is faults + 1 in 24 bits; 0 is "no faults in the key" */
const MAX_FAULTS = 0xff_ff_fe
export const NO_NODE = 0xff_ff_ff_ff

/** A parsed key: the digest's four words and the faults tag. */
export interface DedupKey {
  w0: number
  w1: number
  w2: number
  w3: number
  tag: number
}

/** `hex` is the 32-hex-digit digest; `faults` is undefined when the key leaves faults out. */
export function dedupKey(hex: string, faults: number | undefined): DedupKey {
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new RangeError(`dedup key must be 32 hex digits, got ${hex}`)
  if (faults !== undefined && !(Number.isInteger(faults) && faults >= 0 && faults <= MAX_FAULTS)) {
    throw new RangeError(`dedup faults must be an integer in 0..${MAX_FAULTS}, got ${faults}`)
  }
  return {
    w0: Number.parseInt(hex.slice(0, 8), 16) >>> 0,
    w1: Number.parseInt(hex.slice(8, 16), 16) >>> 0,
    w2: Number.parseInt(hex.slice(16, 24), 16) >>> 0,
    w3: Number.parseInt(hex.slice(24, 32), 16) >>> 0,
    tag: faults === undefined ? 0 : faults + 1,
  }
}

// the digest of a test key may be any 32 hex digits, so mix every word
const slotHash = (key: DedupKey): number => {
  let h = key.w0 ^ Math.imul(key.w1, 0x85eb_ca6b) ^ Math.imul(key.w2, 0xc2b2_ae35) ^ Math.imul(key.w3, 0x27d4_eb2f) ^ Math.imul(key.tag, 0x1656_67b1)
  h ^= h >>> 16
  h = Math.imul(h, 0x85eb_ca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2_ae35)
  h ^= h >>> 16
  return h >>> 0
}

export class DedupTable {
  private slots: Uint32Array
  private mask: number
  size = 0

  constructor(initialSlots = 1024) {
    let capacity = 16
    while (capacity < initialSlots) capacity *= 2
    this.slots = new Uint32Array(capacity * STRIDE)
    this.mask = capacity - 1
  }

  get capacity(): number {
    return this.mask + 1
  }

  get byteLength(): number {
    return this.slots.byteLength
  }

  /** The slot holding `key`, or -1. */
  find(key: DedupKey): number {
    const slots = this.slots
    for (let index = slotHash(key) & this.mask; ; index = (index + 1) & this.mask) {
      const base = index * STRIDE
      const meta = slots[base + META]!
      if (meta === 0) return -1
      if (
        slots[base] === key.w0 &&
        slots[base + 1] === key.w1 &&
        slots[base + 2] === key.w2 &&
        slots[base + 3] === key.w3 &&
        meta >>> 8 === key.tag
      ) {
        return index
      }
    }
  }

  remaining(slot: number): number {
    return this.slots[slot * STRIDE + META]! & 0xff
  }

  node(slot: number): number {
    return this.slots[slot * STRIDE + NODE]!
  }

  /** Insert `key`, or overwrite its remaining depth and node. */
  set(key: DedupKey, remaining: number, node: number): void {
    if (!(Number.isInteger(remaining) && remaining >= 1 && remaining <= MAX_REMAINING)) {
      throw new RangeError(`dedup remaining depth must be 1..${MAX_REMAINING}, got ${remaining}`)
    }
    const found = this.find(key)
    if (found !== -1) {
      this.write(found, key, remaining, node)
      return
    }
    if (this.size + 1 > this.capacity * MAX_LOAD) this.grow()
    this.write(this.emptySlot(key), key, remaining, node)
    this.size += 1
  }

  private emptySlot(key: DedupKey): number {
    let index = slotHash(key) & this.mask
    while (this.slots[index * STRIDE + META] !== 0) index = (index + 1) & this.mask
    return index
  }

  private write(slot: number, key: DedupKey, remaining: number, node: number): void {
    const base = slot * STRIDE
    this.slots[base] = key.w0
    this.slots[base + 1] = key.w1
    this.slots[base + 2] = key.w2
    this.slots[base + 3] = key.w3
    this.slots[base + META] = ((key.tag << 8) | remaining) >>> 0
    this.slots[base + NODE] = node
  }

  private grow(): void {
    const old = this.slots
    this.slots = new Uint32Array(old.length * 2)
    this.mask = this.mask * 2 + 1
    const key: DedupKey = { w0: 0, w1: 0, w2: 0, w3: 0, tag: 0 }
    for (let base = 0; base < old.length; base += STRIDE) {
      const meta = old[base + META]!
      if (meta === 0) continue
      key.w0 = old[base]!
      key.w1 = old[base + 1]!
      key.w2 = old[base + 2]!
      key.w3 = old[base + 3]!
      key.tag = meta >>> 8
      this.slots.set(old.subarray(base, base + STRIDE), this.emptySlot(key) * STRIDE)
    }
  }
}

/** Append-only label paths as parent pointers, one node per expanded search node. */
export class PathArena {
  private parents = new Uint32Array(1024)
  private labelIds = new Uint32Array(1024)
  private readonly labels: Label[] = []
  private readonly ids = new Map<Label, number>()
  length = 0

  get byteLength(): number {
    return this.parents.byteLength + this.labelIds.byteLength
  }

  /** A child of `parent` (NO_NODE for the root) reached by `label` (undefined for the root). */
  push(parent: number, label: Label | undefined): number {
    if (this.length === this.parents.length) {
      const parents = new Uint32Array(this.length * 2)
      parents.set(this.parents)
      this.parents = parents
      const labelIds = new Uint32Array(this.length * 2)
      labelIds.set(this.labelIds)
      this.labelIds = labelIds
    }
    let labelId = NO_NODE
    if (label !== undefined) {
      labelId = this.ids.get(label) ?? this.labels.length
      if (labelId === this.labels.length) {
        this.ids.set(label, labelId)
        this.labels.push(label)
      }
    }
    this.parents[this.length] = parent
    this.labelIds[this.length] = labelId
    return this.length++
  }

  path(node: number): Label[] {
    const path: Label[] = []
    for (let at = node; at !== NO_NODE; at = this.parents[at]!) {
      const labelId = this.labelIds[at]!
      if (labelId !== NO_NODE) path.push(this.labels[labelId]!)
    }
    return path.reverse()
  }
}
