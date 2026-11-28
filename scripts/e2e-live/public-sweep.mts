// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Scan the live bots' tree for private content (public-sweep-rules.ts says what).
//
//   npx tsx scripts/e2e-live/public-sweep.mts [--usernames <map.json>] [--private-terms <terms.json>] [--root <dir>] [path ...]
//
// --usernames (or E2E_SWEEP_USERNAMES) is a private {address: username} map,
// read from where it is kept and never copied here; without it the player
// check is skipped and says so. --private-terms (or E2E_SWEEP_PRIVATE_TERMS),
// {"terms": [{"term", "category"}]}, is kept private the same way. Paths default to everything the bots own.
// Exit 1 on any hit; each is printed as file:line, category and a short hash.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { buildAllowlist, buildPrivateTerms, buildUserMap, scanText, type Hit } from "./public-sweep-rules"

const DEFAULT_PATHS = [
  "scripts/e2e-live",
  "scripts/lib/claims-chain.mts",
  "scripts/lib/host-session.mts",
  "scripts/lib/lite-chain.mts",
  "scripts/lib/host-slot.mjs",
  "scripts/game-chain-report.mts",
  "scripts/game-chain-report.test.mts",
  ".claude/skills/bot-e2e",
  ".github/workflows/e2e-live.yml",
  ".github/workflows/e2e-live-annotate.yml",
  ".github/workflows/e2e-live-nightly.yml",
  ".github/workflows/e2e-live-pages.yml",
  ".github/workflows/attest-previewnet-bots.yml",
  "docs/e2e-live-previewnet-crew.md",
]

const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}
const root = resolve(option("--root") ?? resolve(import.meta.dirname, "../.."))
const usernamesPath = option("--usernames") ?? process.env.E2E_SWEEP_USERNAMES
const termsPath = option("--private-terms") ?? process.env.E2E_SWEEP_PRIVATE_TERMS
const paths = args.length ? args : DEFAULT_PATHS

const files: string[] = []
const walk = (path: string): void => {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) if (entry !== "node_modules" && entry !== "__pycache__") walk(join(path, entry))
  } else if (stat.isFile()) files.push(path)
}
for (const path of paths) walk(resolve(root, path))

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"))
const allow = buildAllowlist(readJson(join(root, "scripts/e2e-live/profiles.json")), readJson(join(root, "scripts/e2e-live/persona-bootstrap.json")))
const users = usernamesPath ? buildUserMap(readJson(usernamesPath) as Record<string, string>) : undefined
const privateTerms = termsPath ? buildPrivateTerms(readJson(termsPath)) : undefined

const hits: Hit[] = []
for (const file of files) {
  // binary files too: as latin1 bytes, so metadata strings are still seen
  hits.push(...scanText(relative(root, file), readFileSync(file).toString("latin1"), allow, users, privateTerms))
}

console.log(`public sweep: ${files.length} file(s); allowlist ${allow.names.size} bot identities, ${allow.bases.size} bot bases; ` +
  (users ? `player check on (${users.names.size} usernames)` : "player check SKIPPED (no --usernames map)") +
  (privateTerms ? `; ${privateTerms.size} private terms` : "; private terms SKIPPED (no --private-terms file)"))
for (const hit of hits) console.log(`${hit.file}:${hit.line}: ${hit.category} [${hit.tag}]`)
const byCategory = new Map<string, number>()
for (const hit of hits) byCategory.set(hit.category, (byCategory.get(hit.category) ?? 0) + 1)
console.log(hits.length ? `FAIL ${hits.length} hit(s): ${[...byCategory].map(([c, n]) => `${c} ${n}`).join(", ")}` : "OK no hits")
process.exitCode = hits.length ? 1 : 0
