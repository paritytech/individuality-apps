// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { applyRemap, baseOf, planRemap } from "./remap-plan"

// --list                      previewnet usernames in profiles.json, first-appearance order (JSON array)
// --paseo-clash <names.json>  names also used as another network's identity (JSON array; exit 3 if any)
// --apply <new.json>          new.json = { regular: [...], personas: { <base>: <username> } }; rewrites every tracked file
// Fixtures and history that only quote example names; the identity-minting tool and its test fixtures stay as they are.
const EXCLUDED = [":!scripts/e2e-live/new-identity.mts", ":!scripts/e2e-live/settle-claim.test.ts"]
const repo = resolve(import.meta.dirname, "../..")
const profilesPath = resolve(repo, "scripts/e2e-live/profiles.json")
const network = process.env.NETWORK ?? "previewnet"
const profiles = JSON.parse(readFileSync(profilesPath, "utf8")) as { profiles: { identity?: Record<string, string> | string }[] }
const ordered = (net: string): string[] => {
  const seen = new Set<string>()
  for (const profile of profiles.profiles) if (profile.identity && typeof profile.identity === "object" && profile.identity[net]) seen.add(profile.identity[net])
  return [...seen]
}
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1]
const oldNames = ordered(network)

if (process.argv.includes("--list")) {
  console.log(JSON.stringify(oldNames))
} else if (process.argv.includes("--paseo-clash")) {
  const names = JSON.parse(readFileSync(resolve(arg("--paseo-clash")), "utf8")) as string[]
  const others = new Set(profiles.profiles.flatMap((p) => (p.identity && typeof p.identity === "object" ? Object.entries(p.identity).filter(([net]) => net !== network).map(([, name]) => name) : typeof p.identity === "string" ? [p.identity] : [])))
  const clash = names.filter((name) => others.has(name))
  console.log(JSON.stringify(clash))
  if (clash.length) process.exit(3)
} else if (process.argv.includes("--apply")) {
  const fresh = JSON.parse(readFileSync(resolve(arg("--apply")), "utf8")) as { regular: string[]; personas: Record<string, string> }
  const { map, unusedRegular } = planRemap(oldNames, fresh.regular, fresh.personas)
  const files = execFileSync("git", ["grep", "-lE", oldNames.map((n) => n.replace(/\./g, "\\.")).join("|"), "--", ".", ...EXCLUDED], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean)
  const touched: string[] = []
  for (const file of files) {
    const path = resolve(repo, file)
    const before = readFileSync(path, "utf8")
    const after = applyRemap(before, map)
    if (after !== before) { writeFileSync(path, after); touched.push(file) }
  }
  console.log(JSON.stringify({ map, touched, unusedRegular, baseOfExample: baseOf(oldNames[0] ?? "") }, null, 1))
} else {
  throw new Error("usage: --list | --paseo-clash <names.json> | --apply <new.json>")
}
