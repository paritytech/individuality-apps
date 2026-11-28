// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs"
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { loadCrewCatalogue } from "./catalogue"
import { deterministicClock, flagArguments, requiredFlag } from "./cli-arguments"
import { generateCrewSite } from "./site"

interface Arguments {
  stateDir: string
  outputDir: string
  now: Date
}

const canonicalPath = (path: string): string => {
  if (existsSync(path)) return realpathSync(path)
  return join(realpathSync(dirname(path)), basename(path))
}

const contains = (parent: string, child: string): boolean => {
  const fromParent = relative(parent, child)
  return fromParent === "" || (!isAbsolute(fromParent) && fromParent !== ".." && !fromParent.startsWith(`..${sep}`))
}

const assertSeparateTrees = (stateDir: string, outputDir: string): void => {
  const state = canonicalPath(resolve(stateDir))
  const output = canonicalPath(resolve(outputDir))
  if (contains(state, output) || contains(output, state)) throw new Error("crew site output must be separate from and must not contain the canonical history root")
}

function argumentsFrom(argv: string[]): Arguments {
  const values = flagArguments(argv, ["--state", "--out", "--now"])
  const usage = "usage: site-cli.mts --state <history-root> --out <separate-site-root>"
  const stateDir = resolve(requiredFlag(values, "--state", usage))
  const outputDir = resolve(requiredFlag(values, "--out", usage))
  if (stateDir === parse(stateDir).root) throw new Error("refusing to use a filesystem root as crew history")
  if (outputDir === parse(outputDir).root) throw new Error("refusing to use a filesystem root as crew output")
  mkdirSync(dirname(outputDir), { recursive: true })
  assertSeparateTrees(stateDir, outputDir)
  return { stateDir, outputDir, now: deterministicClock(values, "CREW_SITE_TEST_CLOCK") }
}

export function replaceGeneratedSite(stateDir: string, outputDir: string, stageDir: string, renameFile = renameSync): void {
  assertSeparateTrees(stateDir, outputDir)
  const targets = ["index.html", ".nojekyll", "assets", "identities", "runs", "suites", "data"]
  const backupDir = mkdtempSync(join(dirname(outputDir), ".crew-site-backup-"))
  const movedOld: string[] = []
  const installed: string[] = []
  let canDeleteBackup = false
  try {
    mkdirSync(outputDir, { recursive: true })
    for (const path of targets) {
      const current = join(outputDir, path)
      if (!existsSync(current)) continue
      const backup = join(backupDir, path)
      mkdirSync(dirname(backup), { recursive: true })
      renameFile(current, backup)
      movedOld.push(path)
    }
    for (const path of targets) {
      const staged = join(stageDir, path)
      if (!existsSync(staged)) continue
      const current = join(outputDir, path)
      mkdirSync(dirname(current), { recursive: true })
      renameFile(staged, current)
      installed.push(path)
    }
    canDeleteBackup = true
  } catch (error) {
    const recoveryErrors: unknown[] = []
    for (const path of installed.reverse()) {
      try { rmSync(join(outputDir, path), { recursive: true, force: true }) } catch (recoveryError) { recoveryErrors.push(recoveryError) }
    }
    for (const path of movedOld.reverse()) {
      const backup = join(backupDir, path)
      const current = join(outputDir, path)
      try {
        mkdirSync(dirname(current), { recursive: true })
        renameFile(backup, current)
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError)
      }
    }
    if (recoveryErrors.length > 0) throw new AggregateError([error, ...recoveryErrors], `crew site replacement failed and rollback was incomplete; backup retained at ${backupDir}`)
    canDeleteBackup = true
    throw error
  } finally {
    rmSync(stageDir, { recursive: true, force: true })
    if (canDeleteBackup) rmSync(backupDir, { recursive: true, force: true })
  }
}

function main(): void {
  const args = argumentsFrom(process.argv.slice(2))
  mkdirSync(dirname(args.outputDir), { recursive: true })
  const stageDir = mkdtempSync(join(dirname(args.outputDir), ".crew-site-stage-"))
  try {
    const written = generateCrewSite({
      stateDir: args.stateDir,
      outputDir: stageDir,
      catalogue: loadCrewCatalogue(),
      portraitDir: new URL("./portraits/", import.meta.url),
      now: args.now,
    })
    replaceGeneratedSite(args.stateDir, args.outputDir, stageDir)
    process.stdout.write(`${JSON.stringify({ outputDir: args.outputDir, files: written.length, generatedAt: args.now.toISOString() })}\n`)
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main()
