// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Does a pull request need a preview deploy?
//
// An allowlist: a PR needs a preview when it changes what the bundle is built
// from (scripts/ci/bundle-sources.txt) or the deploy machinery. The
// state-machine explorer is development-only and sits below the broad lib/
// entry, so it is excluded explicitly. A build input nobody listed skips a
// needed preview: deploy-preview forces one, and the fix is to add the path to
// the list.
//
// Usage: node scripts/ci/changes.mjs HEAD^1 HEAD
//   prints deploy=0|1 for $GITHUB_OUTPUT. On a PR's merge commit HEAD^1 is the
//   base tip, so this is the whole PR, never one push.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

/** The bundle-source list: one path per line, `#` comments and blank lines dropped. */
export function readBundleSources(text = readFileSync(new URL("./bundle-sources.txt", import.meta.url), "utf8")) {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
}

export const BUNDLE_SOURCES = readBundleSources()

/** development-only explorer sources below the app's broad lib/ bundle entry */
export const EXPLORER_ONLY = ["apps/jollity-app/lib/explorer/", "scripts/explore.mts"]

/** what the deploy runs besides the bundle sources */
export const DEPLOY_MACHINERY = [
  ".github/workflows/deploy.yml",
  "scripts/ci/determine-domain.sh",
  "scripts/ci/merge-version-gist.mjs",
  "scripts/ci/deploy-matrix.mjs",
  "scripts/ci/deploy-comment.mjs",
  "scripts/ci/changes.mjs",
  "scripts/ci/bundle-sources.txt",
]

/** a path matches an entry when it is the entry, or the entry is a directory (ending /) that holds it */
export const matches = (entries, file) => entries.some((e) => (e.endsWith("/") ? file.startsWith(e) : file === e))

export function classify(files) {
  const list = files.map((f) => f.trim()).filter(Boolean)
  // no list at all, as from a shallow checkout or an empty merge: deploy
  if (!list.length) return { deploy: true }
  const bundle = list.some((f) => !matches(EXPLORER_ONLY, f) && matches(BUNDLE_SOURCES, f))
  return { deploy: bundle || list.some((f) => matches(DEPLOY_MACHINERY, f)) }
}

/**
 * The files between two commits. With rename detection a moved file is listed
 * at its destination only, so moving a component into docs/ would read as a
 * docs-only change and skip.
 */
export function changedFiles(from, to, cwd = process.cwd()) {
  return execFileSync("git", ["diff", "--name-only", "--no-renames", from, to], { cwd, encoding: "utf8" }).split("\n")
}

function main() {
  const [from = "HEAD^1", to = "HEAD"] = process.argv.slice(2)
  console.log(`deploy=${classify(changedFiles(from, to)).deploy ? 1 : 0}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
