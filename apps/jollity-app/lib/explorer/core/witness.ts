// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Witnesses: a replayable JSON choice list for one finding.
 * Labels carry meaning, not positions, so a witness survives unrelated edits;
 * a label that is not enabled at step k stops the replay as out of date.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { exploreRoom, type ExploreRoomOptions, type Violation } from "../mesh/room"
import { livenessBoundFinding, type LivenessBoundCheck } from "../mesh/liveness-stats"
import { loadMutant, type MutantSpec } from "../mutants/load"
import { loadSpec } from "../mutants/spec"
import { isFault, LABEL_SCHEMA, type Label } from "./labels"
import type { Finding } from "./search"

export interface Witness {
  schema: 1
  machine: string
  source: { commit: string; dirty: boolean; files: Record<string, string> }
  scenario: Record<string, unknown> & { mutant: string | null }
  labels: Label[]
  check?: LivenessBoundCheck
  violation: { property: string; atStep: number; detail: string; evidence?: unknown }
}

export type ReplayResult =
  | { status: "reproduced" | "not-reproduced"; violation?: Violation }
  /** the labels replay, but a different violation (property, detail or step) is found */
  | { status: "different-violation"; violation: Violation }
  | { status: "out-of-date"; atStep: number; label: Label }

const repoRoot = resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))

/** the source whose change can alter a replay (a trailing slash-star hashes a tree) */
export const WITNESS_SOURCE_FILES: readonly string[] = [
  "apps/jollity-app/lib/webrtc/mesh.ts",
  "apps/jollity-app/lib/state-machines/peer-actor.ts",
  "apps/jollity-app/lib/state-machines/peer-runner.ts",
  "apps/jollity-app/lib/webrtc/test-pc.ts",
  "apps/jollity-app/lib/explorer/**",
]

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of (await readdir(dir)).sort()) {
    const path = join(dir, entry)
    if ((await stat(path)).isDirectory()) out.push(...(await filesUnder(path)))
    else if (!/\.mutant-/.test(entry)) out.push(path)
  }
  return out
}

async function hashOf(entry: string): Promise<string> {
  const hash = createHash("sha256")
  if (entry.endsWith("/**")) {
    const base = join(repoRoot, entry.slice(0, -3))
    for (const path of await filesUnder(base)) {
      hash.update(path.slice(base.length)).update(await readFile(path))
    }
  } else {
    hash.update(await readFile(join(repoRoot, entry)))
  }
  return `sha256:${hash.digest("hex")}`
}

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()

export async function sourceStamp(
  files: readonly string[],
): Promise<Witness["source"]> {
  const entries = await Promise.all(
    files.map(async (file) => [file, await hashOf(file)] as const),
  )
  return {
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    files: Object.fromEntries(entries),
  }
}

/** A finding as a witness (the search found it at `scenario`). */
export async function witnessFromFinding(
  machine: string,
  scenario: Witness["scenario"],
  finding: Finding & { check?: LivenessBoundCheck },
): Promise<Witness> {
  return {
    schema: 1,
    machine,
    source: await sourceStamp(WITNESS_SOURCE_FILES),
    scenario,
    labels: finding.labels,
    ...(finding.check === undefined ? {} : { check: finding.check }),
    violation: {
      property: finding.property,
      atStep: finding.atStep,
      detail: finding.detail,
      ...(finding.evidence === undefined ? {} : { evidence: finding.evidence }),
    },
  }
}

export async function writeWitness(
  dir: string,
  witness: Witness,
  slug = `${witness.violation.property}-${witness.labels.length}`,
): Promise<string> {
  const folder = join(dir, "witnesses")
  await mkdir(folder, { recursive: true })
  const path = join(folder, `${slug.replace(/[^\w.-]+/g, "-")}.json`)
  await writeFile(path, `${JSON.stringify(witness, null, 2)}\n`)
  return path
}

export async function readWitness(path: string): Promise<Witness> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<Witness>
  if (raw.schema !== LABEL_SCHEMA) {
    throw new Error(
      `unsupported witness schema ${String(raw.schema)} (this explorer reads schema ${LABEL_SCHEMA})`,
    )
  }
  if (
    !Array.isArray(raw.labels) ||
    !raw.scenario ||
    typeof raw.scenario !== "object" ||
    !raw.violation ||
    !raw.source ||
    raw.scenario.phaseOffsetMs === undefined
  ) {
    throw new Error(`malformed witness ${path}`)
  }
  return raw as Witness
}

function roomOptions(witness: Witness): ExploreRoomOptions {
  const s = witness.scenario
  // an older witness carries a "flag" field: "on" is ignored, and "off" names
  // the tree of Mesh's old decision path, which is gone
  if (s.flag !== undefined && s.flag !== "on") throw new Error(`witness ran with flag ${String(s.flag)}: the peer actor always drives the Mesh now, and only flag-on witnesses replay`)
  return {
    scenario: s.name as ExploreRoomOptions["scenario"],
    phaseOffsetMs: s.phaseOffsetMs as ExploreRoomOptions["phaseOffsetMs"],
    ...(s.slice === 1 || s.slice === 2 ? { slice: s.slice } : {}),
    ...(typeof s.faults === "number" ? { faults: s.faults } : {}),
    ...(typeof s.horizonMs === "number" ? { horizonMs: s.horizonMs } : {}),
    // a mutant's witness is judged as the self-test judged it: without known gaps
    ...(s.mutant ? { knownGaps: false } : {}),
    ...(s.heartbeat === false ? { heartbeat: false } : {}),
  }
}

/** A changed source hash only warns: replaying against new source is how a fix is checked. */
async function warnIfSourceChanged(witness: Witness): Promise<void> {
  const changed: string[] = []
  for (const [file, hash] of Object.entries(witness.source.files)) {
    try {
      if ((await hashOf(file)) !== hash) changed.push(file)
    } catch {
      changed.push(file)
    }
  }
  if (changed.length > 0) {
    console.warn(
      `witness source changed since ${witness.source.commit.slice(0, 8)}: ${changed.join(", ")}; replaying anyway`,
    )
  }
}

/** `spec`: the mutant's spec when it has no `<id>.json` (a planted spec in a test); by default it is read by id. */
export async function replayWitness(witness: Witness, spec?: MutantSpec): Promise<ReplayResult> {
  await warnIfSourceChanged(witness)
  const id = witness.scenario.mutant
  if (id && spec && spec.id !== id) throw new Error(`replayWitness: spec ${spec.id} is not the witness's mutant ${id}`)
  const mutant = id ? await loadMutant(spec ?? loadSpec(id)) : undefined
  try {
    const room = await exploreRoom(roomOptions(witness))
    try {
      for (const [index, label] of witness.labels.entries()) {
        // a fault past the budget is not takeable: the witness no longer fits its bounds
        if (!room.enabled().includes(label) || (isFault(label) && room.faultsLeft() <= 0)) {
          return { status: "out-of-date", atStep: index, label }
        }
        await room.step(label)
      }
      const expected = witness.violation
      if (witness.check?.kind === "liveness-bound") {
        const result = await room.checkLiveness()
        const found = livenessBoundFinding(result, witness.labels, witness.check.boundS)
        if (found?.property === expected.property && found.detail === expected.detail && found.atStep === expected.atStep) {
          return { status: "reproduced", violation: { property: "L1", detail: found.detail, atStep: found.atStep } }
        }
        if (result.violation !== undefined) return { status: "different-violation", violation: result.violation }
        return { status: "not-reproduced" }
      }
      // L1 is judged at the schedule's end, by its drain
      if (expected.property === "L1") await room.checkLiveness()
      const found = room.violations()
      const exact = found.find(
        (v) =>
          v.property === expected.property &&
          v.detail === expected.detail &&
          v.atStep === expected.atStep,
      )
      if (exact) return { status: "reproduced", violation: exact }
      const other = found.find((v) => v.property === expected.property) ?? found[0]
      return other
        ? { status: "different-violation", violation: other }
        : { status: "not-reproduced" }
    } finally {
      room.close()
    }
  } finally {
    await mutant?.undo()
  }
}

/** A vitest file for lib/webrtc, in the shape of mesh-rejoin-two-offers.test.ts. */
export function emitTest(witness: Witness, slug: string): string {
  const s = witness.scenario
  const o = roomOptions(witness)
  const property = witness.violation.property
  const labels = witness.labels.map((l) => `      ${JSON.stringify(l)},`).join("\n")
  const mutant = s.mutant
    ? `// NOTE: found under mutant ${s.mutant}; the mutant is an explorer self-check, so this file is not for committing.\n`
    : ""
  return `${mutant}/**
 * explore ${slug}: ${witness.violation.detail}
 * Found by \`npm run explore\` at ${witness.source.commit}${witness.source.dirty ? " (dirty tree)" : ""}.
 * Scenario ${String(o.scenario)}, phase offset ${o.phaseOffsetMs} ms,,
 * bounds: faults ${o.faults ?? "default"}, horizon ${o.horizonMs ?? "default"} ms, ${witness.labels.length} steps.
 */
import "../explorer/mesh/quiescence"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
${s.mutant ? `import { loadMutant, type LoadedMutant } from "../explorer/mutants/load"\nimport { loadSpec } from "../explorer/mutants/spec"\n` : ""}import { exploreRoom, type ExploreRoom } from "../explorer/mesh/room"

describe("explore ${slug}", () => {
  let room: ExploreRoom
${s.mutant ? "  let mutant: LoadedMutant\n" : ""}  beforeEach(async () => {
${s.mutant ? `    mutant = await loadMutant(loadSpec(${JSON.stringify(s.mutant)}))\n` : ""}    room = await exploreRoom({ ${Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} })
  })
  afterEach(async () => {
    room.close()
${s.mutant ? "    await mutant.undo()\n" : ""}  })

  it(${JSON.stringify(witness.violation.detail)}, async () => {
    await room.replay([
${labels}
    ])
    expect(room.violations("${property}")).toEqual([]) // red before the fix
  })
})
`
}
