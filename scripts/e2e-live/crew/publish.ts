// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, parse, resolve } from "node:path"
import type { CrewCatalogue } from "./catalogue"
import {
  validatePublicationBundle,
  validatePublicRunRecord,
  validatePublicSuiteRecord,
  type PublicationBundle,
  type PublicRunRecord,
  type PublicSuiteRecord,
} from "./run-record"
import { generateCrewSite, portraitBytesFor, readCrewSiteState } from "./site"

type RenameFile = typeof renameSync

class PublicationRollbackError extends AggregateError {}

export interface ApplyPublicationOptions {
  stateDir: string
  bundle: PublicationBundle
  catalogue: CrewCatalogue
  portraitDir: URL | string
  portraitSourceDir: string
  now: Date
  renameFile?: RenameFile
}

export interface ApplyPublicationResult {
  changed: boolean
  runs: number
  suites: number
  files: number
}

const REPLACEMENT_TARGETS = [
  "index.html",
  ".nojekyll",
  "assets",
  "identities",
  "runs",
  "suites",
  "data/runs",
  "data/suites",
  "data/catalogue-version.json",
] as const

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const equal = (one: unknown, two: unknown): boolean => json(one) === json(two)

const caseFoldedMap = <T extends { key: string }>(records: readonly T[], where: string): Map<string, T> => {
  const recordsByKey = new Map<string, T>()
  const canonical = new Map<string, string>()
  for (const record of records) {
    const folded = record.key.toLocaleLowerCase("en-US")
    const previous = canonical.get(folded)
    if (previous && previous !== record.key) throw new Error(`${where}: case-folded key collision between ${previous} and ${record.key}`)
    canonical.set(folded, record.key)
    recordsByKey.set(record.key, record)
  }
  return recordsByKey
}

const assertNoIncomingKeyCollision = <T extends { key: string }>(existing: Map<string, T>, incoming: readonly T[], where: string): void => {
  const folded = new Map([...existing.keys()].map((key) => [key.toLocaleLowerCase("en-US"), key]))
  for (const record of incoming) {
    const canonical = record.key.toLocaleLowerCase("en-US")
    const previous = folded.get(canonical)
    if (previous && previous !== record.key) throw new Error(`${where}: case-folded key collision between ${previous} and ${record.key}`)
    folded.set(canonical, record.key)
  }
}

const mergeRun = (existing: PublicRunRecord, incoming: PublicRunRecord): PublicRunRecord => equal(existing, incoming) ? existing : incoming

const mergeSuite = (existing: PublicSuiteRecord, incoming: PublicSuiteRecord): PublicSuiteRecord => {
  if (incoming.latestAttempt < existing.latestAttempt) return existing
  if (incoming.latestAttempt === existing.latestAttempt && existing.state === "completed" && incoming.state === "started") return existing
  const attempts = [...new Set([...existing.attempts, ...incoming.attempts])].sort((one, two) => one - two)
  const candidate = validatePublicSuiteRecord({
    ...incoming,
    attempts,
    observedRunKeys: incoming.state === "completed" ? incoming.observedRunKeys : [],
  })
  return equal(existing, candidate) ? existing : candidate
}

const copyIfPresent = (sourceRoot: string, stageRoot: string, path: string): void => {
  const source = join(sourceRoot, path)
  if (!existsSync(source)) return
  const target = join(stageRoot, path)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, force: false, errorOnExist: true })
}

const replaceState = (stateDir: string, stageDir: string, workspaceDir: string, renameFile: RenameFile): void => {
  const targets = REPLACEMENT_TARGETS.map((path) => ({ path, hadOld: existsSync(join(stateDir, path)) }))
  const backupDir = join(workspaceDir, "backup")
  const movedOld: string[] = []
  const installed: string[] = []
  writeFileSync(join(workspaceDir, "replacement.json"), json(targets))
  try {
    for (const target of targets) {
      if (!target.hadOld) continue
      const current = join(stateDir, target.path)
      const backup = join(backupDir, target.path)
      mkdirSync(dirname(backup), { recursive: true })
      renameFile(current, backup)
      movedOld.push(target.path)
    }
    for (const target of targets) {
      const staged = join(stageDir, target.path)
      if (!existsSync(staged)) continue
      const current = join(stateDir, target.path)
      mkdirSync(dirname(current), { recursive: true })
      renameFile(staged, current)
      installed.push(target.path)
    }
  } catch (error) {
    const recoveryErrors: unknown[] = []
    for (const path of installed.reverse()) {
      try { rmSync(join(stateDir, path), { recursive: true, force: true }) } catch (recoveryError) { recoveryErrors.push(recoveryError) }
    }
    for (const path of movedOld.reverse()) {
      try {
        const current = join(stateDir, path)
        mkdirSync(dirname(current), { recursive: true })
        renameFile(join(backupDir, path), current)
      } catch (recoveryError) { recoveryErrors.push(recoveryError) }
    }
    if (recoveryErrors.length) throw new PublicationRollbackError([error, ...recoveryErrors], `publication replacement failed and rollback is incomplete; recovery workspace retained at ${workspaceDir}`)
    throw error
  }
  writeFileSync(join(workspaceDir, "completed"), "complete\n")
  rmSync(backupDir, { recursive: true, force: true })
}

// Called only by the serialized history writer. Recovery is restartable: an
// already-restored target has no backup and is left in place on the next try.
const recoverPublication = (stateDir: string): void => {
  const parent = dirname(stateDir)
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`.${basename(stateDir)}.crew-publish-`)) continue
    const workspace = join(parent, entry.name)
    const manifest = join(workspace, "replacement.json")
    if (!existsSync(manifest)) continue
    const targets = JSON.parse(readFileSync(manifest, "utf8")) as Array<{ path: string; hadOld: boolean }>
    if (targets.length !== REPLACEMENT_TARGETS.length || targets.some((target, index) => target.path !== REPLACEMENT_TARGETS[index] || typeof target.hadOld !== "boolean")) throw new Error("invalid publisher recovery manifest")
    if (!existsSync(join(workspace, "completed"))) {
      for (const target of targets) {
        const backup = join(workspace, "backup", target.path)
        const current = join(stateDir, target.path)
        if (existsSync(backup)) {
          rmSync(current, { recursive: true, force: true })
          mkdirSync(dirname(current), { recursive: true })
          renameSync(backup, current)
        } else if (!target.hadOld) rmSync(current, { recursive: true, force: true })
      }
    }
    rmSync(workspace, { recursive: true, force: true })
  }
}

export function applyPublicationBundle(options: ApplyPublicationOptions): ApplyPublicationResult {
  const stateDir = resolve(options.stateDir)
  if (stateDir === parse(stateDir).root) throw new Error("refusing to publish into a filesystem root")
  if (!Number.isFinite(options.now.getTime())) throw new Error("publication needs a valid clock")
  const renameFile = options.renameFile ?? renameSync
  mkdirSync(dirname(stateDir), { recursive: true })
  const publication = validatePublicationBundle(options.bundle)
  caseFoldedMap(publication.runs, "bundle.runs")
  caseFoldedMap(publication.suites, "bundle.suites")
  recoverPublication(stateDir)
  const current = readCrewSiteState(stateDir)
  const runs = caseFoldedMap(current.runs, "stored runs")
  const suites = caseFoldedMap(current.suites, "stored suites")
  assertNoIncomingKeyCollision(runs, publication.runs, "bundle.runs")
  assertNoIncomingKeyCollision(suites, publication.suites, "bundle.suites")
  let changed = !existsSync(join(stateDir, "index.html"))

  for (const incoming of publication.runs) {
    const existing = runs.get(incoming.key)
    const merged = existing ? mergeRun(existing, incoming) : incoming
    if (!existing || !equal(existing, merged)) changed = true
    runs.set(incoming.key, merged)
  }
  for (const incoming of publication.suites) {
    const existing = suites.get(incoming.key)
    const merged = existing ? mergeSuite(existing, incoming) : incoming
    if (!existing || !equal(existing, merged)) changed = true
    suites.set(incoming.key, merged)
  }

  const newPortraits = new Map<string, Uint8Array>()
  for (const run of publication.runs) {
    if (!run.identity) continue
    const bytes = portraitBytesFor(options, run)
    const existing = newPortraits.get(run.identity.portraitPath)
    if (existing && !Buffer.from(existing).equals(Buffer.from(bytes))) throw new Error(`${run.identity.portraitPath}: portrait digest collision`)
    newPortraits.set(run.identity.portraitPath, bytes)
  }
  for (const run of runs.values()) {
    if (run.identity && !existsSync(join(stateDir, run.identity.portraitPath))) changed = true
  }
  if (!changed) return { changed: false, runs: publication.runs.length, suites: publication.suites.length, files: 0 }

  const workspaceDir = mkdtempSync(join(dirname(stateDir), `.${basename(stateDir)}.crew-publish-`))
  let retainWorkspace = false
  try {
    const canonicalDir = join(workspaceDir, "canonical")
    const stageDir = join(workspaceDir, "stage")
    mkdirSync(canonicalDir, { recursive: true })
    copyIfPresent(stateDir, canonicalDir, "data")
    copyIfPresent(stateDir, canonicalDir, join("assets", "portraits", "by-sha256"))
    mkdirSync(join(canonicalDir, "data", "runs"), { recursive: true })
    mkdirSync(join(canonicalDir, "data", "suites"), { recursive: true })
    for (const record of [...runs.values()].sort((one, two) => one.key.localeCompare(two.key)))
      writeFileSync(join(canonicalDir, "data", "runs", `${record.key}.json`), json(validatePublicRunRecord(record)))
    for (const record of [...suites.values()].sort((one, two) => one.key.localeCompare(two.key)))
      writeFileSync(join(canonicalDir, "data", "suites", `${record.key}.json`), json(validatePublicSuiteRecord(record)))
    for (const [path, bytes] of newPortraits) {
      const target = join(canonicalDir, path)
      mkdirSync(dirname(target), { recursive: true })
      if (existsSync(target) && !readFileSync(target).equals(Buffer.from(bytes))) throw new Error(`${path}: retained portrait bytes do not match the digest path`)
      writeFileSync(target, bytes)
    }

    const files = generateCrewSite({ stateDir: canonicalDir, outputDir: stageDir, catalogue: options.catalogue, portraitDir: options.portraitDir, now: options.now })
    // HTML derives expiry from the clock; durable JSON remains the source receipt.
    rmSync(join(stageDir, "data", "runs"), { recursive: true, force: true })
    rmSync(join(stageDir, "data", "suites"), { recursive: true, force: true })
    cpSync(join(canonicalDir, "data", "runs"), join(stageDir, "data", "runs"), { recursive: true })
    cpSync(join(canonicalDir, "data", "suites"), join(stageDir, "data", "suites"), { recursive: true })
    replaceState(stateDir, stageDir, workspaceDir, renameFile)
    return { changed: true, runs: publication.runs.length, suites: publication.suites.length, files: files.length }
  } catch (error) {
    retainWorkspace = error instanceof PublicationRollbackError
    throw error
  } finally {
    if (!retainWorkspace) rmSync(workspaceDir, { recursive: true, force: true })
  }
}
