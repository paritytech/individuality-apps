// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto"
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"

export interface ExplorerVersion {
  gitSha: string
  sourceHash: string
}

type Rename = (from: string, to: string) => Promise<unknown>

/** Write a small checkpoint manifest beside the live disk frontier without ever exposing partial JSON. */
export async function atomicWriteJson(
  file: string,
  value: unknown,
  replace: Rename = rename,
): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  try {
    await replace(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export function assertCheckpointVersion(
  recorded: ExplorerVersion,
  current: ExplorerVersion,
  force: boolean,
): void {
  if (
    force ||
    (recorded.gitSha === current.gitSha && recorded.sourceHash === current.sourceHash)
  ) return
  throw new Error(
    `checkpoint source version mismatch: recorded git ${recorded.gitSha}, sources ${recorded.sourceHash}; ` +
      `current git ${current.gitSha}, sources ${current.sourceHash}. Pass --force-resume to continue deliberately.`,
  )
}

async function runtimeSources(at: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name)
    if (entry.isDirectory()) files.push(...await runtimeSources(path))
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) files.push(path)
  }
  return files
}

/** Git identity plus a deterministic digest of every runtime explorer source. */
export async function explorerVersion(root: string, gitSha: string): Promise<ExplorerVersion> {
  const explorer = join(root, "apps/jollity-app/lib/explorer")
  const files = [
    ...await runtimeSources(explorer),
    join(root, "scripts/explore.mts"),
  ].sort()
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(relative(root, file)).update("\0").update(await readFile(file)).update("\0")
  }
  return { gitSha, sourceHash: hash.digest("hex") }
}
