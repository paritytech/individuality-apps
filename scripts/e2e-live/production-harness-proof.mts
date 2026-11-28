// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { patchTestTag, stripSentryDsns } from "./deployed-app"

const distDir = resolve(process.env.NEXT_DIST_DIR ?? "apps/jollity-app/.next")
const chunksDir = join(distDir, "_next", "static", "chunks")
const files = new Map<string, Uint8Array>()

async function collectJavaScript(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collectJavaScript(path)
    else if (entry.isFile() && path.endsWith(".js")) files.set(path, new Uint8Array(await readFile(path)))
  }
}

await collectJavaScript(chunksDir)
assert(files.size > 0, `no production chunks found under ${chunksDir}; build the app first`)

const patchedTags = patchTestTag(files, "e2e-bot")
assert(patchedTags > 0, "production chunks did not contain the bot-patchable empty test tag")

const strippedDsns = stripSentryDsns(files)
assert(strippedDsns > 0, "production chunks did not contain baked Sentry DSNs to strip")

const chunks = [...files.values()].map((bytes) => new TextDecoder().decode(bytes))
const configChunk = chunks.find((source) => /\.allowHarnessOnly&&([\w$]+)\.testTag\?\1:/.test(source))
assert(configChunk, "minified configFromEnvironment lost its early allowHarnessOnly + runtime testTag return")
assert(configChunk.includes('testTag:"e2e-bot"'), "the bot-patched runtime test tag is absent from the config chunk")

const harnessChunk = chunks.find((source) =>
  source.includes("harnessEnabled") && source.includes('allowHarnessOnly:!0') && source.includes('?.testTag??""')
)
assert(harnessChunk, "minified harnessEnabled no longer reads configFromEnvironment's runtime testTag")

const sentryDsn = /https:\/\/[^"'`\\\s]+@[^"'`\\\s]+\.ingest(?:\.[a-z0-9-]+)?\.sentry\.io\/\d+/i
assert(!chunks.some((source) => sentryDsn.test(source)), "a Sentry DSN remained after the bot's telemetry-off transform")

console.log(`Production harness proof passed: ${files.size} chunks, ${patchedTags} test-tag patch(es), ${strippedDsns} DSN(s) stripped.`)
