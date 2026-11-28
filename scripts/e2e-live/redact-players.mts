// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Before an upload: mask every other player the run's outputs name, then
// replace them in place with their invented labels (player-privacy.ts).
//
//   npx tsx scripts/e2e-live/redact-players.mts <dir or file> ...
//
// Text files only (json, jsonl, md, log, txt, html, svg); a video or image is
// left as it is. The bots (profiles.json, persona bases, E2E_IDENTITIES /
// E2E_FRESH_IDENTITIES, E2E_RUN_BOT_ACCOUNTS, E2E_EXPECTED_USER) stay readable.
// Prints counts only.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { botSet, PlayerPrivacy } from "./player-privacy"

const TEXT = /\.(json|jsonl|md|log|txt|html|svg)$/i
const here = import.meta.dirname
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"))

const files: string[] = []
const walk = (path: string): void => {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return
  }
  if (stat.isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry))
  else if (stat.isFile() && TEXT.test(path)) files.push(path)
}
for (const arg of process.argv.slice(2)) walk(resolve(arg))

const privacy = new PlayerPrivacy(botSet(readJson(join(here, "profiles.json")), readJson(join(here, "persona-bootstrap.json"))))
// learn (and mask) everyone first, so a name seen only in a later file is still replaced in an earlier one
const texts = files.map((file) => readFileSync(file, "utf8"))
for (const text of texts) privacy.seeIn(text)
let changed = 0
files.forEach((file, i) => {
  const redacted = privacy.redact(texts[i]!)
  if (redacted !== texts[i]) {
    writeFileSync(file, redacted)
    changed++
  }
})
console.log(`redact-players: ${files.length} text file(s), ${privacy.seen} other player(s), ${changed} file(s) rewritten`)
