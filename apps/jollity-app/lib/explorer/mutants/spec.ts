// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The targeted mutants' full specs, one JSON file per
 * mutant next to this module (`<id>.json`). The loader (load.ts) takes the
 * `{ id, target, hunks }` part; the rest says where the search starts
 * (`warmup`, real enabled labels, and the named `precondition` that must hold
 * after them), how far it goes, which properties it must trip and whether a
 * miss blocks a run (`gating`). The self-test (self-test.ts) judges them.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Label } from "../core/labels"
import type { PropertyId, ScenarioName } from "../mesh/room"
import type { MutantSpec as LoadableSpec } from "./load"

export interface MutantSpec extends LoadableSpec {
  id: string
  /** relative to the app root, e.g. lib/webrtc/mesh.ts */
  target: string
  /** the commit each `find` was checked against */
  contextCommit: string
  hunks: { find: string; replace: string }[]
  warmup: Label[]
  /** a named predicate (mutants/preconditions.ts) */
  precondition: string
  scenario: ScenarioName
  bounds: { depth: number; faults: number }
  mustTrip: PropertyId[]
  gating: boolean
}

const PROPERTIES: readonly PropertyId[] = ["P1", "P1b", "P2", "P3", "P6", "P7", "P8", "W", "R", "D", "L1"]
const SCENARIO_NAMES: readonly ScenarioName[] = ["rejoin-two-offers", "single-offer", "outage"]

const isString = (value: unknown): value is string => typeof value === "string"
const isCount = (value: unknown, min: number): value is number => Number.isInteger(value) && (value as number) >= min

/** Check a parsed spec's fields; throws naming the first bad one. */
function validateSpec(raw: unknown, id: string): MutantSpec {
  const spec = raw as Record<string, unknown> | null
  const bad = (field: string): never => {
    throw new Error(`mutant ${id}: bad ${field}`)
  }
  if (!spec || typeof spec !== "object") bad("spec")
  const s = spec!
  if (s.id !== id) bad(`id (${String(s.id)}, the file is ${id}.json)`)
  if (!isString(s.target) || !s.target.endsWith(".ts")) bad("target")
  if (!isString(s.contextCommit) || !/^[0-9a-f]{7,40}$/.test(s.contextCommit)) bad("contextCommit")
  if (!Array.isArray(s.hunks) || s.hunks.length === 0) bad("hunks")
  for (const hunk of s.hunks as unknown[]) {
    const h = hunk as Record<string, unknown> | null
    if (!h || !isString(h.find) || h.find.length === 0 || !isString(h.replace)) bad("hunk")
  }
  if (!Array.isArray(s.warmup) || !(s.warmup as unknown[]).every(isString)) bad("warmup")
  if (!isString(s.precondition) || s.precondition.length === 0) bad("precondition")
  if (!SCENARIO_NAMES.includes(s.scenario as ScenarioName)) bad("scenario")
  const bounds = s.bounds as Record<string, unknown> | null
  if (!bounds || !isCount(bounds.depth, 1) || !isCount(bounds.faults, 0)) bad("bounds")
  if (!Array.isArray(s.mustTrip) || s.mustTrip.length === 0 || !(s.mustTrip as unknown[]).every((p) => PROPERTIES.includes(p as PropertyId))) bad("mustTrip")
  if (typeof s.gating !== "boolean") bad("gating")
  return s as unknown as MutantSpec
}

/** reads lib/explorer/mutants/<id>.json and validates its fields */
export function loadSpec(id: string): MutantSpec {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`mutant ${id}: bad id`)
  const path = fileURLToPath(new URL(`./${id}.json`, import.meta.url))
  return validateSpec(JSON.parse(readFileSync(path, "utf8")), id)
}

/** slice 1's mutants */
export const SLICE1_MUTANTS = ["M1385-on", "M1385b", "M1374s", "ML1"] as const
