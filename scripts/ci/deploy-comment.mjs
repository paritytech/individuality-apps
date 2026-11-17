// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The Deploy run's one PR comment. A late label runs one leg and must keep the
// other's row, and a previewnet leg its gate ended (a `skipped` result) must
// still say why there is no preview.
//
// `previous` (the comment's current body) is passed on `labeled` runs only: a
// push shows what that run published, a label adds its leg to what is there.

export const MARKER = "<!-- jollity-deploy -->"
export const NO_PREVIEW = "No preview: no deployed sources changed. Add the deploy-preview label to force one."
export const PASEO_HINT = "No Paseo preview: add the deploy-paseo label to deploy one."

const ORDER = ["paseo-next-v2", "preview"]
const NAME = { preview: "Previewnet", "paseo-next-v2": "Paseo" }
const ENV_OF = Object.fromEntries(Object.entries(NAME).map(([env, name]) => [name, env]))

/** the table rows of a comment this module wrote, keyed by env */
export function rowsOf(body) {
  const rows = new Map()
  for (const line of (body ?? "").split("\n")) {
    const m = /^\| (\w+) \| `/.exec(line)
    if (m && ENV_OF[m[1]]) rows.set(ENV_OF[m[1]], line)
  }
  return rows
}

export function renderDeployComment({ label, runUrl, planned: wanted, results, previous = "" }) {
  // a leg its gate ended was never really planned: it says NO_PREVIEW, not "did not publish"
  const skipped = new Set(results.filter((r) => r.skipped).map((r) => r.env))
  const planned = wanted.filter((env) => !skipped.has(env))
  const published = results.filter((r) => r.cid)
  // legs ran and none published: leave the comment alone
  if (planned.length && !published.length) return null
  const kept = rowsOf(previous)
  const rows = []
  const shown = new Set()
  for (const env of ORDER) {
    const r = published.find((x) => x.env === env)
    if (r) rows.push(`| ${NAME[env]} | \`${r.domain}\` | https://${r.label}.${r.shell} |`)
    else if (!planned.includes(env) && kept.has(env)) rows.push(kept.get(env))
    else continue
    shown.add(env)
  }
  const notes = []
  for (const env of ORDER) if (planned.includes(env) && !shown.has(env)) notes.push(`${NAME[env]} did not publish. See the run logs.`)
  if (!shown.has("preview") && !planned.includes("preview")) notes.push(NO_PREVIEW)
  if (!shown.has("paseo-next-v2") && !planned.includes("paseo-next-v2")) notes.push(PASEO_HINT)

  const lines = [`**${label}** · [logs](${runUrl})`]
  if (rows.length) lines.push("", "| Network | Mobile / Desktop | Web |", "| :--- | :---: | :---: |", ...rows)
  if (notes.length) lines.push("", ...notes.map((n) => `<sub>${n}</sub>`))
  return [...lines, "", MARKER].join("\n")
}
