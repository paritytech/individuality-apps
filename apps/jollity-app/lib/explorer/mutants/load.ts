// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The mutant loader, kept minimal. A mutant is a list of hunks
 * on one target module. The mutated text goes to a gitignored sibling copy
 * (`<name>.mutant-<id>.ts`), each replacement prefixed with a hunk-hit counter
 * call, and the target is mocked onto it behind a module reset: a doMock
 * registered while the target is already in the module graph would have no
 * effect, so the reset is not optional. The caller re-imports the target (and
 * whatever imports it) after this resolves.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { vi } from "vitest"

export interface MutantSpec {
  id: string
  /** relative to the app root, e.g. lib/webrtc/mesh.ts */
  target: string
  hunks: { find: string; replace: string }[]
}

export interface LoadedMutant {
  /** per hunk, how many times its mutated statement ran */
  hits: number[]
  /** reset modules, unmock, delete the sibling copy */
  undo(): Promise<void>
}

const appRoot = fileURLToPath(new URL("../../../", import.meta.url))

type HitGlobal = typeof globalThis & { __explorerHunkHit?: (id: string, hunk: number) => void }

export class MutantRefreshError extends Error {}

/** Apply `spec`'s hunks to its target's text (exported for tests). */
export function mutateText(spec: MutantSpec, text: string): string {
  let out = text
  spec.hunks.forEach(({ find, replace }, index) => {
    const at = out.indexOf(find)
    if (at < 0 || out.indexOf(find, at + 1) >= 0) throw new MutantRefreshError(`refresh mutant ${spec.id}`)
    const counted = `;(globalThis as { __explorerHunkHit?: (id: string, hunk: number) => void }).__explorerHunkHit?.(${JSON.stringify(spec.id)}, ${index}); ${replace}`
    out = out.slice(0, at) + counted + out.slice(at + find.length)
  })
  return out
}

/** Delete siblings of `target` left by runs whose process is gone (a crash skips undo). */
function removeStaleSiblings(target: string) {
  const dir = dirname(target)
  const prefix = `${basename(target, ".ts")}.mutant-`
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".ts")) continue
    const pid = Number(/-(\d+)\.ts$/.exec(name)?.[1])
    if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) continue
    if (pid === process.pid) continue
    rmSync(join(dir, name), { force: true })
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export async function loadMutant(spec: MutantSpec): Promise<LoadedMutant> {
  const target = `${appRoot}${spec.target}`
  removeStaleSiblings(target)
  // one sibling per process: parallel runs (shards) never share a file
  const sibling = target.replace(/\.ts$/, `.mutant-${spec.id}-${process.pid}.ts`)
  writeFileSync(sibling, mutateText(spec, readFileSync(target, "utf8")))
  const hits = spec.hunks.map(() => 0)
  const global = globalThis as HitGlobal
  global.__explorerHunkHit = (id, hunk) => {
    if (id === spec.id) hits[hunk]++
  }
  vi.resetModules()
  vi.doMock(target, () => import(/* @vite-ignore */ sibling))
  return {
    hits,
    async undo() {
      vi.doUnmock(target)
      vi.resetModules()
      if (global.__explorerHunkHit) delete global.__explorerHunkHit
      if (existsSync(sibling)) rmSync(sibling)
    },
  }
}
