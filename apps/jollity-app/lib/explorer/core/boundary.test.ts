// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The explorer's import boundary (design 9.3): nothing outside lib/explorer,
 * test files and explore files may import lib/explorer, so the tool never
 * reaches a product bundle or a PR suite through an ordinary import. Scans the
 * whole repository's TypeScript sources. The one allowed outsider is T8's
 * root CLI, scripts/explore.mts, which is the tool's own entry point.
 */
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const repoRoot = resolve(appRoot, "../..")
const explorerDir = join(appRoot, "lib/explorer")
const ALLOWED = new Set(["scripts/explore.mts"])
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "out", "dist", "build", "coverage", "test-results", ".claude", ".superpowers", ".turbo"])

const specifiers = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.(?:do)?mock\s*\(\s*)["']([^"']+)["']/g

/** the specifiers in `text` that reach lib/explorer from `file` */
export function explorerImports(file: string, text: string): string[] {
  const out: string[] = []
  for (const [, specifier] of text.matchAll(specifiers)) {
    const target = specifier!.startsWith(".") ? resolve(dirname(file), specifier!) : specifier!
    if (target === explorerDir || target.startsWith(`${explorerDir}/`) || /(^|\/)lib\/explorer(\/|$)/.test(specifier!)) out.push(specifier!)
  }
  return out
}

const exempt = (path: string) =>
  path.startsWith(`${explorerDir}/`) || /\.test\.(ts|tsx|mts)$/.test(path) || /\.explore\.ts$/.test(path) || ALLOWED.has(relative(repoRoot, path))

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sources(join(dir, entry.name))
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield join(dir, entry.name)
  }
}

describe("the explorer's import boundary", () => {
  it("nothing outside the explorer, tests and explore files imports lib/explorer", () => {
    // the scanner itself sees each shape of import
    const product = join(appRoot, "lib/webrtc/x.ts")
    expect(explorerImports(product, 'import { a } from "../explorer/mesh/room"')).toEqual(["../explorer/mesh/room"])
    expect(explorerImports(product, 'const m = await import("../explorer/core/search")')).toEqual(["../explorer/core/search"])
    expect(explorerImports(product, 'import "@/lib/explorer/mesh/room"')).toEqual(["@/lib/explorer/mesh/room"])
    expect(explorerImports(product, 'import { b } from "./explorer-free"')).toEqual([])
    const offenders: string[] = []
    let scanned = 0
    for (const file of sources(repoRoot)) {
      if (exempt(file)) continue
      scanned++
      const found = explorerImports(file, readFileSync(file, "utf8"))
      if (found.length > 0) offenders.push(`${relative(repoRoot, file)}: ${found.join(", ")}`)
    }
    expect(scanned).toBeGreaterThan(100)
    expect(offenders).toEqual([])
  })
})
