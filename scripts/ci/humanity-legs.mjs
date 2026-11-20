// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Which Humanity names a deploy.yml run publishes.
//
// Every name is the bare label in the HUMANITY_DOTNS_DOMAIN secret, <label>
// below, with the suffix of its leg. A leg names no label, since GitHub drops a
// job output that holds a secret, and the deploy job adds it. A push to main publishes <label>.testnet and the
// paseo staging name <label>next.paseo when it changes what Humanity ships.
// The staging name is built for product <label>, so release.yml can copy its
// records onto <label>.paseo. A same-repo pull request that changes what
// Humanity ships gets <label>-pr<N>-preview.testnet, still built for product
// <label>, since a preview label would derive an empty product account. It
// reads the game record from the Jollity sandbox of the same PR,
// <JOLLITY_DOTNS_DOMAIN><sandbox-suffix>. A dispatch publishes what its inputs
// pick, and target release writes <label>.paseo itself.
//
// Usage: node scripts/ci/humanity-legs.mjs
//   reads the run from the environment and prints legs=<JSON> for $GITHUB_OUTPUT.
import { execFileSync } from "node:child_process"

export const SOURCES =
  /^(apps\/humanity-app|apps\/humanity-worker|packages\/humanity-shared|packages\/shared-records|packages\/individuality-[^/]+)\/|^\.github\/workflows\/deploy\.yml$|^scripts\/ci\/humanity-legs\.mjs$/

export const NOT_SHIPPED =
  /^apps\/humanity-app\/(lab\/|e2e\/|tests\/|scripts\/lab\/|lab\.(opening|flow)\.config\.ts$|tsconfig\.(lab|flow)\.json$|eslint\.config\.mjs$|docs\/lab[^/]*$)/

export const shipsHumanity = (files) => files.some((f) => SOURCES.test(f) && !NOT_SHIPPED.test(f))

const leg = (env, name, suffix, environment, { sandboxSuffix = "", comment = false, sentry = false } = {}) => ({
  env,
  name,
  suffix,
  tld: env === "preview" ? "testnet" : "paseo",
  environment,
  "sandbox-suffix": sandboxSuffix,
  comment,
  sentry,
})

export function planHumanityLegs({ event, action = "", network = "", target = "", pr = "", sameRepo = true, ref = "", changed }) {
  if (event === "pull_request") {
    if (action === "labeled" || !sameRepo || !changed) return []
    return [leg("preview", `PR ${pr} preview`, `-pr${pr}-preview`, "", { sandboxSuffix: `-pr${pr}-sandbox00`, comment: true })]
  }
  if (event === "push" && !changed) return []
  const sentry = ref === "refs/heads/main"
  const legs = []
  if (network !== "paseo-next-v2") legs.push(leg("preview", "previewnet", "", "humanity-previewnet", { sentry }))
  if (network !== "preview") {
    legs.push(
      target === "release"
        ? leg("paseo-next-v2", "paseo release", "", "humanity-paseo-next-v2", { sentry })
        : leg("paseo-next-v2", "paseo staging", "next", "", { sentry }),
    )
  }
  return legs
}

/** The files the run changes, or null when they cannot be listed and every source counts as changed. */
function changedFiles({ event, before, sha, pr, repo }) {
  const lines = (text) => text.split("\n").filter(Boolean)
  if (event === "pull_request") {
    return lines(execFileSync("gh", ["api", "--paginate", `repos/${repo}/pulls/${pr}/files`, "--jq", ".[].filename"], { encoding: "utf8" }))
  }
  if (event !== "push" || !before || /^0+$/.test(before)) return null
  execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", before], { stdio: "inherit" })
  return lines(execFileSync("git", ["diff", "--name-only", "--no-renames", before, sha], { encoding: "utf8" }))
}

function main() {
  const env = process.env
  const run = {
    event: env.EVENT,
    action: env.ACTION,
    network: env.NETWORK,
    target: env.TARGET,
    pr: env.PR,
    sameRepo: env.SAME_REPO === "true",
    ref: env.REF,
  }
  const skipped = run.event === "pull_request" && (run.action === "labeled" || !run.sameRepo)
  const files = skipped ? [] : changedFiles({ event: run.event, before: env.BEFORE, sha: env.GITHUB_SHA, pr: run.pr, repo: env.GITHUB_REPOSITORY })
  const changed = files === null || shipsHumanity(files)
  console.log(`legs=${JSON.stringify(planHumanityLegs({ ...run, changed }))}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
