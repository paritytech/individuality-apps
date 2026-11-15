// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Ample-set partial-order reduction for the room,
 * behind a flag (ROOM_POR=1, the in-memory room BFS only): off, the search runs exactly as before.
 *
 * The census (1 Nov 2026): on 3 and 4 phones it reduces no state. Every closure reaches every enabled
 * label: a pair label is dependent with both its phones' sweeps (tick writes every pair of its phone),
 * and those reach every other pair; while faults are left `ph:<k>:*` couples all phones through the
 * budget; and `advance` moves the clock every half reads. por.test.ts keeps that result as a test. A
 * per-half sweep label is the model change that would break the first coupling.
 *
 * What it keeps. Every edge the reduced search takes is an edge of the full search, and every state it
 * reaches is a state of the full search (at a depth no smaller), so its findings are a subset of the full
 * search's. Ample sets keep every finding of the unbounded search whose check reads only the label's
 * footprint (all edge checks) or a projection no ample label changes (RP3/RP4, below). They do NOT keep
 * every state: state counts, pair-state counts and anything sampled per state (RP10's probes, the
 * inclusion sample) are lower bounds of the full search's under POR. Within a depth bound a finding can
 * also move deeper (a postponed label runs after an ample one), which is why the proof gate compares
 * finding sets at equal depth and reports any difference.
 *
 * The macro view. A label that leaves a choice in its phone's FIFO makes the room busy, and a busy room
 * enables only that phone's choices (candidateLabels). Busy states are always expanded in full. At a
 * quiet state a label stands for itself plus the choices it leaves (at faultsLeft = 0 only
 * `choice:<i>:resolved`, so the macro is deterministic); independence and footprints are about that
 * macro, from quiet state to quiet state.
 *
 * Resources (the footprint's unit, one per part of the room key, key.ts): pair p (both halves, both
 * extras, both statement slots, both lane directions and both admissions of pair p: pairKey), phone i
 * (owesSweep, its FIFO, its beat: phoneKey), the clock (`now`). Phone sessions change only on a reload
 * (a fault), and the fault budget only on a fault.
 *
 * The rules, exactly:
 * - F0 (faults). At a state with faultsLeft > 0 the ample set is the full set. A fault label (ph, w drop,
 *   ice drop, fault completions, a rejected choice) writes the budget every other fault label reads, and
 *   `ph:<k>:*` is enabled at every quiet state while the budget lasts and touches every pair of k, so the
 *   closure below would reach every label anyway. At faultsLeft = 0 every fault label is disabled for
 *   good, so the budget, the sessions and RP7 (which fires only while no fault was spent past the
 *   anchor) are constants from there on.
 * - Footprints (static, per label family, at faultsLeft = 0): `h`, `hello`, `w`, `lane`, `ice`, `chan` on
 *   pair p read p and the clock and write p; `tick:<i>` and `beat:<i>` read and write every pair of i and
 *   phone i and read the clock; `advance:<i>` and `advance-jb:<i>` are global (they move the clock every
 *   half reads, and read every half's deadlines). Two labels are dependent when one is global, or one
 *   writes a resource the other reads or writes.
 * - C0. The ample set is empty only when no label is enabled.
 * - C1 (a stubborn-set closure over every candidate label, enabled or not). Starting from a seed: an
 *   enabled label in the set brings in every label dependent with it; a disabled label brings in a
 *   necessary enabling set (every path that enables it takes one of them first):
 *   - a fault label: none (disabled for good at faultsLeft = 0);
 *   - `advance`: `tick:<k>` for one phone k that owes a sweep (only k's tick clears it); with none owed,
 *     `beat:<i>` for one due beat; otherwise the full set;
 *   - `tick:<i>`: every `advance` and every label writing a pair of i (a sweep is due again when the clock
 *     moves, or when a half of i gets a fresh connection book, as a replace-connection gives it);
 *   - `beat:<i>`: every `advance` and every label writing a pair of i (the period follows i's links);
 *   - a pair label: every label writing its pair, and every `advance`.
 *   The ample set is the closure's enabled labels. Seeds: one enabled label per pair or phone label, and
 *   for `advance` each owing phone in turn; the smallest closure wins, and a closure with every enabled
 *   label is the full set.
 * - C2 (visibility). The state checks (quietViolations: RP3, RP4) read each half's initiator, closed
 *   link, hidden flag and round, and quiet. A reduced ample set may hold only labels whose macro leaves
 *   that projection unchanged; otherwise the next closure is tried, then the full set. The edge checks
 *   (D0, RP1, RP2, RP4's offer, RP6, inclusion and its gaps) read only the label's footprint, so an
 *   ample label runs them on the same inputs as the postponed run would.
 * - C3 (cycles, BFS form). If any ample label's child, or the quiet end of its macro, is already visited
 *   (a self-loop included), the state is expanded in full.
 *
 * The runtime check (ROOM_POR_CHECK=N, or `check` in the options): on 1 state in N (by state id), every
 * pair of enabled labels the relation calls independent must be enabled in both orders and reach equal
 * full keys; every enabled label's macro must change only the resources it writes; and a disabled label
 * in the ample set must stay disabled after every enabled label outside its enabling set.
 */
import { fullRoomKey, pairKey, phoneKey } from "./key"
import { candidateLabels, ENTRY, pairsOf, quiet, step, type Room } from "./model"

export const porFromEnv = (): boolean => process.env.ROOM_POR === "1"
export const porCheckFromEnv = (): number => (process.env.ROOM_POR_CHECK ? Number(process.env.ROOM_POR_CHECK) : 0)

export interface Footprint {
  reads: number[]
  writes: number[]
  /** dependent with every label */
  global: boolean
  /** spends the fault budget (disabled for good at faultsLeft = 0) */
  fault: boolean
}

/** Resource numbering for n phones: pairs first (pairsOf order), then phones, then the clock. */
export const pairResource = (n: number, a: number, b: number): number => {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  // index of (lo, hi) in pairsOf(n)
  return lo * n - (lo * (lo + 1)) / 2 + (hi - lo - 1)
}
export const phoneResource = (n: number, i: number): number => (n * (n - 1)) / 2 + i
export const clockResource = (n: number): number => (n * (n - 1)) / 2 + n

const PAIR = /^(\w+):(\d+)[>@-](\d+)/

/** A test hook: replace one label's footprint (the wrong-claim negative control). */
export type FootprintOverride = (label: string, n: number, footprint: Footprint) => Footprint

export function footprint(label: string, n: number, override?: FootprintOverride): Footprint {
  const made = baseFootprint(label, n)
  return override ? override(label, n, made) : made
}

function baseFootprint(label: string, n: number): Footprint {
  const parts = label.split(":")
  const family = parts[0]!
  const clock = clockResource(n)
  const phonePairs = (i: number) => Array.from({ length: n }, (_, j) => j).filter((j) => j !== i).map((j) => pairResource(n, i, j))
  switch (family) {
    case "h": {
      const match = PAIR.exec(label)!
      const p = pairResource(n, Number(match[2]), Number(match[3]))
      const key = parts.slice(2).join(":")
      return { reads: [p, clock], writes: [p], global: false, fault: ENTRY.get(key)?.fault === true }
    }
    case "hello":
    case "lane":
    case "chan": {
      const match = PAIR.exec(label)!
      const p = pairResource(n, Number(match[2]), Number(match[3]))
      return { reads: [p, clock], writes: [p], global: false, fault: false }
    }
    case "w":
    case "ice": {
      const match = PAIR.exec(label)!
      const p = pairResource(n, Number(match[2]), Number(match[3]))
      return { reads: [p, clock], writes: [p], global: false, fault: parts[2] === "drop" }
    }
    case "tick":
    case "beat": {
      const i = Number(parts[1])
      const touched = [...phonePairs(i), phoneResource(n, i)]
      return { reads: [...touched, clock], writes: touched, global: false, fault: false }
    }
    case "advance":
    case "advance-jb":
      return { reads: [], writes: [], global: true, fault: false }
    case "ph": {
      const i = Number(parts[1])
      const touched = [...phonePairs(i), phoneResource(n, i)]
      return { reads: [...touched, clock], writes: touched, global: false, fault: true }
    }
    case "choice":
      // only at busy states, which are expanded in full
      return { reads: [], writes: [], global: true, fault: parts[2] === "rejected" }
    case "vis":
      // the frozen page clock moves one phone's clock and gates every label of it: dependent on everything (and ROOM_POR is refused with ROOM_FROZEN, room.explore.ts)
      return { reads: [], writes: [], global: true, fault: false }
    default:
      throw new Error(`no footprint for ${label}`)
  }
}

export const dependent = (x: Footprint, y: Footprint): boolean => {
  if (x.global || y.global) return true
  for (const w of x.writes) if (y.reads.includes(w) || y.writes.includes(w)) return true
  for (const w of y.writes) if (x.reads.includes(w)) return true
  return false
}

// ── the macro view ──

/** The label's macro from a quiet state at faultsLeft = 0: the label, then each choice it leaves resolved, to the next quiet state. Null when the label is not enabled or a choice cannot resolve. */
export function macroStep(room: Room, label: string): Room | null {
  const first = step(room, label)
  if (!first) return null
  let at = first.room
  for (let guard = 0; !quiet(at); guard++) {
    if (guard > 64) throw new Error(`macro of ${label}: more than 64 choices`)
    const i = at.phones.findIndex((phone) => phone.queue.length > 0)
    const next = step(at, `choice:${i}:resolved`)
    if (!next) return null
    at = next.room
  }
  return at
}

/** The projection the state checks read (quietViolations): each half's initiator, closed link, hidden flag and round. */
function visibleView(room: Room): string {
  let out = ""
  for (let i = 0; i < room.n; i++) for (let j = 0; j < room.n; j++) {
    if (i === j) continue
    const actor = room.halves[i]![j]!.actor
    out += `${actor.initiator ? 1 : 0}${actor.link === "closed" ? 1 : 0}${actor.hidden ? 1 : 0}${actor.roundGeneration},`
  }
  return out
}

// ── the ample set ──

export interface AmpleOptions {
  override?: FootprintOverride
}

export interface AmpleChoice {
  /** the ample labels (a subset of `enabled`), or null for the full set */
  ample: string[] | null
  /** why the full set was taken */
  why?: "busy" | "faults" | "advance-enabled" | "all-enabled" | "no-enabling-set" | "visible" | "single"
}

interface Index {
  labels: string[]
  footprints: Footprint[]
  readers: number[][]
  writers: number[][]
  globals: number[]
  byLabel: Map<string, number>
}

function indexOf(room: Room, options: AmpleOptions): Index {
  const labels = candidateLabels(room)
  const resources = clockResource(room.n) + 1
  const readers: number[][] = Array.from({ length: resources }, () => [])
  const writers: number[][] = Array.from({ length: resources }, () => [])
  const globals: number[] = []
  const footprints = labels.map((label) => footprint(label, room.n, options.override))
  const byLabel = new Map<string, number>()
  footprints.forEach((fp, at) => {
    byLabel.set(labels[at]!, at)
    if (fp.global) globals.push(at)
    for (const r of fp.reads) readers[r]!.push(at)
    for (const w of fp.writes) writers[w]!.push(at)
  })
  return { labels, footprints, readers, writers, globals, byLabel }
}

/** A necessary enabling set for a disabled label at a quiet state with faultsLeft = 0 (label indices), or null: none known, take the full set. `owing` picks the phone whose tick enables `advance`. */
function enablingSet(room: Room, index: Index, at: number, owing: number): number[] | null {
  const label = index.labels[at]!
  const fp = index.footprints[at]!
  if (fp.fault) return []
  const parts = label.split(":")
  const family = parts[0]!
  const advances = () => index.globals.filter((g) => /^advance/.test(index.labels[g]!))
  const writersOf = (resources: number[]) => [...new Set(resources.flatMap((r) => index.writers[r]!))]
  switch (family) {
    case "advance":
    case "advance-jb": {
      const owed = room.phones.map((phone, i) => (phone.owesSweep ? i : -1)).filter((i) => i >= 0)
      if (owed.length > 0) {
        const k = owed.includes(owing) ? owing : owed[0]!
        return [index.byLabel.get(`tick:${k}`)!]
      }
      if (room.beat) {
        const due = room.phones.findIndex((_, i) => index.byLabel.has(`beat:${i}`) && step(room, `beat:${i}`) !== null)
        if (due >= 0) return [index.byLabel.get(`beat:${due}`)!]
      }
      return null
    }
    case "tick":
    case "beat":
      return [...new Set([...advances(), ...writersOf(fp.writes.filter((r) => r < phoneResource(room.n, 0)))])]
    case "choice":
      return null
    default:
      return [...new Set([...advances(), ...writersOf(fp.writes)])]
  }
}

/** The closure from one seed (label indices of the set), or null when a disabled label has no enabling set. */
function closure(room: Room, index: Index, enabled: boolean[], seed: number, owing: number, trace?: Map<number, { by: number; rule: "dependent" | "enabling" }>): Set<number> | null {
  const inSet = new Set<number>([seed])
  const work = [seed]
  let current = seed
  const add = (at: number) => {
    if (!inSet.has(at)) {
      inSet.add(at)
      work.push(at)
      trace?.set(at, { by: current, rule: enabled[current] ? "dependent" : "enabling" })
    }
  }
  while (work.length > 0) {
    const at = work.pop()!
    current = at
    if (enabled[at]) {
      const fp = index.footprints[at]!
      if (fp.global) {
        for (let other = 0; other < index.labels.length; other++) add(other)
        continue
      }
      for (const g of index.globals) add(g)
      for (const w of fp.writes) {
        for (const other of index.readers[w]!) add(other)
        for (const other of index.writers[w]!) add(other)
      }
      for (const r of fp.reads) for (const other of index.writers[r]!) add(other)
    } else {
      const nes = enablingSet(room, index, at, owing)
      if (nes === null) return null
      for (const other of nes) add(other)
    }
  }
  return inSet
}

/**
 * The ample set at `room`, given its enabled labels. `ends` gives each enabled label's macro end (C2);
 * the caller applies C3. Candidates are tried smallest first.
 */
export function chooseAmple(room: Room, enabledLabels: readonly string[], ends: (label: string) => Room | null, options: AmpleOptions = {}): AmpleChoice {
  if (!quiet(room)) return { ample: null, why: "busy" }
  if (room.faultsLeft > 0) return { ample: null, why: "faults" }
  if (enabledLabels.length <= 1) return { ample: null, why: "single" }
  const index = indexOf(room, options)
  const enabled = index.labels.map(() => false)
  for (const label of enabledLabels) {
    const at = index.byLabel.get(label)
    if (at === undefined) throw new Error(`${label} is enabled but not a candidate`)
    enabled[at] = true
  }
  // an enabled global label (advance) is dependent with every label: every closure holds it and so every label
  if (index.globals.some((at) => enabled[at])) return { ample: null, why: "advance-enabled" }
  // seeds: one enabled label per pair or phone-label unit
  const seeds = new Map<string, number>()
  enabledLabels.forEach((label) => {
    const at = index.byLabel.get(label)!
    const fp = index.footprints[at]!
    if (fp.global) return
    const unit = `${fp.writes.join(",")}`
    if (!seeds.has(unit)) seeds.set(unit, at)
  })
  const owed = room.phones.map((phone, i) => (phone.owesSweep ? i : -1)).filter((i) => i >= 0)
  const owingChoices = owed.length > 0 ? owed : [-1]
  const sets: number[][] = []
  const seen = new Set<string>()
  let noEnabling = false
  for (const seed of seeds.values()) {
    for (const owing of owingChoices) {
      const set = closure(room, index, enabled, seed, owing)
      if (!set) {
        noEnabling = true
        continue
      }
      const ample = [...set].filter((at) => enabled[at]).sort((a, b) => a - b)
      if (ample.length >= enabledLabels.length) continue
      const key = ample.join(",")
      if (seen.has(key)) continue
      seen.add(key)
      sets.push(ample)
    }
  }
  if (sets.length === 0) return { ample: null, why: noEnabling ? "no-enabling-set" : "all-enabled" }
  sets.sort((a, b) => a.length - b.length || a[0]! - b[0]!)
  const view = visibleView(room)
  for (const set of sets) {
    const labels = set.map((at) => index.labels[at]!)
    // C2: every ample macro leaves the checked projection as it was
    if (labels.every((label) => {
      const end = ends(label)
      return end !== null && visibleView(end) === view
    })) return { ample: labels }
  }
  return { ample: null, why: "visible" }
}

// ── the runtime check ──

export interface PorCheck {
  states: number
  pairs: number
  writes: number
  enabling: number
  failures: number
  samples: string[]
}

export const emptyPorCheck = (): PorCheck => ({ states: 0, pairs: 0, writes: 0, enabling: 0, failures: 0, samples: [] })

/** The resources whose key part differs between two rooms. */
function changedResources(before: Room, after: Room): number[] {
  const out: number[] = []
  const n = before.n
  for (const [lo, hi] of pairsOf(n)) if (pairKey(before, lo, hi) !== pairKey(after, lo, hi)) out.push(pairResource(n, lo, hi))
  for (let i = 0; i < n; i++) if (phoneKey(before, i) !== phoneKey(after, i)) out.push(phoneResource(n, i))
  if (before.now !== after.now) out.push(clockResource(n))
  return out
}

/**
 * Check the relation's claims at one quiet state with faultsLeft = 0: commutation of every independent
 * enabled pair (both orders enabled, equal full keys), each enabled macro's writes, and the enabling sets
 * of the disabled labels (one step: a label outside the set does not enable it).
 */
export function checkIndependence(room: Room, check: PorCheck, options: AmpleOptions = {}, maxPairs = 400): void {
  if (!quiet(room) || room.faultsLeft > 0) return
  check.states += 1
  const index = indexOf(room, options)
  const ends = new Map<string, Room>()
  for (const label of index.labels) {
    const end = macroStep(room, label)
    if (end) ends.set(label, end)
  }
  const fail = (text: string) => {
    check.failures += 1
    if (check.samples.length < 20) check.samples.push(text)
  }
  const enabled = [...ends.keys()]
  for (const label of enabled) {
    const fp = index.footprints[index.byLabel.get(label)!]!
    if (fp.global) continue
    check.writes += 1
    for (const r of changedResources(room, ends.get(label)!)) if (!fp.writes.includes(r)) fail(`${label} changed resource ${r} outside its writes [${fp.writes.join(",")}]`)
  }
  let pairs = 0
  for (let x = 0; x < enabled.length && pairs < maxPairs; x++) {
    for (let y = x + 1; y < enabled.length && pairs < maxPairs; y++) {
      const a = enabled[x]!
      const b = enabled[y]!
      if (dependent(index.footprints[index.byLabel.get(a)!]!, index.footprints[index.byLabel.get(b)!]!)) continue
      pairs += 1
      check.pairs += 1
      const ab = macroStep(ends.get(a)!, b)
      const ba = macroStep(ends.get(b)!, a)
      if (!ab || !ba) fail(`${a} and ${b} are claimed independent, but ${!ab ? `${b} is not enabled after ${a}` : `${a} is not enabled after ${b}`}`)
      else if (fullRoomKey(ab) !== fullRoomKey(ba)) fail(`${a} and ${b} are claimed independent, but the two orders reach different rooms`)
    }
  }
  // enabling sets: a disabled label stays disabled after any enabled label outside its set
  const enabledFlags = index.labels.map((label) => ends.has(label))
  for (let at = 0; at < index.labels.length; at++) {
    if (enabledFlags[at]) continue
    const nes = enablingSet(room, index, at, -1)
    if (nes === null || index.footprints[at]!.fault) continue
    const inNes = new Set(nes)
    for (const other of enabled) {
      const o = index.byLabel.get(other)!
      if (inNes.has(o)) continue
      check.enabling += 1
      if (macroStep(ends.get(other)!, index.labels[at]!) !== null) fail(`${index.labels[at]} is enabled by ${other}, outside its enabling set`)
    }
  }
}

/** Diagnostics (the census): for each seed's closure, the chain by which each pair outside the seed's pair was first reached. */
export function explainClosures(room: Room, enabledLabels: readonly string[]): { seed: string; enabled: number; chains: string[][] }[] {
  const index = indexOf(room, {})
  const enabled = index.labels.map((label) => enabledLabels.includes(label))
  const out: { seed: string; enabled: number; chains: string[][] }[] = []
  const seen = new Set<string>()
  for (const label of enabledLabels) {
    const at = index.byLabel.get(label)!
    const fp = index.footprints[at]!
    if (fp.global || seen.has(fp.writes.join(","))) continue
    seen.add(fp.writes.join(","))
    const trace = new Map<number, { by: number; rule: "dependent" | "enabling" }>()
    const set = closure(room, index, enabled, at, -1, trace)
    if (!set) continue
    const chains: string[][] = []
    const reached = new Set<string>()
    for (const member of set) {
      const unit = index.footprints[member]!.writes.join(",")
      if (reached.has(unit) || unit === fp.writes.join(",")) continue
      reached.add(unit)
      const chain: string[] = []
      for (let x: number | undefined = member; x !== undefined && x !== at; x = trace.get(x)?.by) chain.unshift(`${index.labels[x]}${enabled[x] ? "" : "(off)"} <${trace.get(x)?.rule}>`)
      chains.push(chain)
    }
    out.push({ seed: label, enabled: [...set].filter((x) => enabled[x]).length, chains })
  }
  return out
}
