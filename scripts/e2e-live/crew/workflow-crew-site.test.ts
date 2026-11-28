// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const workflow = (name: string) => parse(readFileSync(resolve(__dirname, `../../../.github/workflows/${name}.yml`), "utf8"))
const pages = workflow("e2e-live-pages")
// Narrow ownership boundary: shared records/catalogue/portraits/ingestion and
// live harness files deliberately remain outside renderer-only isolation.
const siteOnly = ["site.ts", "site.css", "status.js", "site-cli.mts", "site.test.ts", "site-fixtures.test.ts", "workflow-crew-site.test.ts"]
  .map((name) => `scripts/e2e-live/crew/${name}`)
  .concat(".github/workflows/e2e-live-pages.yml")

// The filters here use exact paths and a single trailing /** prefix. Evaluate
// ordered inclusions/exclusions as GitHub does; an excluded path never hides a
// second, included harness path in the same commit or rename.
function matches(paths: string[], changed: string[]): boolean {
  return changed.some((file) => {
    let included = false
    for (const path of paths) {
      const negative = path.startsWith("!"), pattern = negative ? path.slice(1) : path
      if (pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern) included = !negative
    }
    return included
  })
}

describe("crew renderer-only workflow isolation", () => {
  it("republishes main on renderer-only pushes without booting a live game, and never runs on a pull request", () => {
    expect(pages.on.push.branches).toEqual(["main"])
    expect(pages.on.push.paths).toEqual(siteOnly)
    expect(pages.on).not.toHaveProperty("pull_request")
    expect(pages.on).not.toHaveProperty("pull_request_target")
    for (const path of siteOnly) expect(matches(pages.on.push.paths, [path]), path).toBe(true)
  })

  it("no longer exempts the copied status client from the app gates, and CI checks it", () => {
    const status = "scripts/e2e-live/crew/status.js"
    for (const name of ["ci", "deploy"]) {
      for (const event of ["pull_request", "push"]) {
        const trigger = (workflow(name).on[event] ?? {}) as { "paths-ignore"?: string[] }
        expect(trigger["paths-ignore"] ?? [], `${name}/${event}`).not.toContain(status)
      }
    }
    // the check the removed PR wrapper used to give a status.js-only change now lives in CI
    const ciSteps = workflow("ci").jobs["e2e-live"].steps as Array<{ run?: string }>
    expect(ciSteps.some((step) => step.run?.includes("node --check scripts/e2e-live/crew/status.js"))).toBe(true)
    // the Pages push filter republishes for the status client alone, not for its neighbours
    expect(matches(pages.on.push.paths, [status])).toBe(true)
    expect(matches(pages.on.push.paths, ["scripts/e2e-live/crew/portraits/person.webp"])).toBe(false)
    expect(matches(pages.on.push.paths, ["scripts/e2e-live/crew/status-helper.js"])).toBe(false)
  })

  it("keeps harness paths and the removed PR wrapper out of the Pages push filter", () => {
    for (const path of ["scripts/e2e-live/crew/run-record.ts", "scripts/e2e-live/crew/catalogue.ts", "scripts/e2e-live/crew/publish.ts", "scripts/e2e-live/crew/release-recordings.ts", "scripts/e2e-live/crew/portraits/person.webp", "scripts/e2e-live/play.mts", ".github/workflows/e2e-live-pr.yml"]) {
      expect(matches(pages.on.push.paths, [path]), path).toBe(false)
    }
    expect(matches(pages.on.push.paths, ["lib/game.ts"])).toBe(false)
  })

  it("runs focused checks on pushes without secrets, app builds or live dispatch", () => {
    const check = pages.jobs["site-check"]
    expect(check.if).toBe("github.event_name == 'push'")
    expect(check.permissions).toEqual({ contents: "read" })
    expect(check.needs).toBeUndefined()
    const commands = check.steps.map((step: { run?: string }) => step.run ?? "").join("\n")
    expect(commands).toContain("npm ci")
    expect(commands).toContain("node --check scripts/e2e-live/crew/status.js")
    expect(commands).toContain("npm run typecheck:e2e-live")
    const lint = check.steps.find((step: { run?: string }) => step.run?.startsWith("npx eslint"))?.run
    expect(lint).toBeDefined()
    expect(lint).toContain("scripts/e2e-live/crew/status.js")
    for (const path of siteOnly.filter((path) => /\.(?:ts|mts)$/.test(path))) expect(lint).toContain(path)
    for (const name of ["site.test.ts", "site-fixtures.test.ts", "workflow-pages.test.ts", "workflow-crew-site.test.ts"]) expect(commands).toContain(`scripts/e2e-live/crew/${name}`)
    expect(commands).not.toMatch(/npm run (?:build|typecheck(?:\s|$)|test:ci)|workflow run|e2e-live\.yml|secrets\./)
  })

  it("publishes successful renderer pushes and admitted source runs but never PRs or failed checks", () => {
    const deploy = pages.jobs.deploy
    expect(deploy.needs).toEqual(["history", "site-check"])
    const evaluate = (event: string, siteResult: string, ready = "", cancelled = false) => Function("github", "needs", "always", "cancelled", `return (${deploy.if.replaceAll("needs.site-check", 'needs["site-check"]')})`)(
      { event_name: event }, { history: { outputs: { ready } }, "site-check": { result: siteResult } }, () => true, () => cancelled,
    )
    expect(evaluate("push", "success")).toBe(true)
    for (const result of ["failure", "cancelled", "skipped"]) expect(evaluate("push", result)).toBe(false)
    expect(evaluate("pull_request", "success")).toBe(false)
    expect(evaluate("pull_request", "success", "true")).toBe(false)
    expect(evaluate("push", "failure", "true")).toBe(false)
    expect(evaluate("workflow_run", "skipped", "true")).toBe(true)
    expect(evaluate("workflow_dispatch", "skipped", "true")).toBe(true)
    expect(evaluate("workflow_run", "skipped", "")).toBe(false)
    expect(evaluate("push", "success", "", true)).toBe(false)
    expect(evaluate("workflow_run", "skipped", "true", true)).toBe(false)
  })

  it("preserves one shared Pages slot, latest composed site, and source-history admission", () => {
    expect(pages.jobs.deploy.concurrency).toEqual({ group: "previewnet-crew-pages-deploy", "cancel-in-progress": false, queue: "max" })
    expect(pages.jobs.history.needs).toBe("admission")
    expect(pages.jobs.history.if).toBe("needs.admission.outputs.ready == 'true'")
    expect(pages.jobs.admission.if).not.toContain("github.event_name == 'push'")
    expect(pages.jobs.admission.if).not.toContain("github.event_name == 'pull_request'")
    const checkouts = pages.jobs.deploy.steps.filter((step: { uses?: string }) => step.uses === "actions/checkout@v4")
    expect(checkouts.map((step: { with: { ref: string } }) => step.with.ref)).toEqual(["${{ github.event.repository.default_branch }}", "previewnet-crew-pages"])
    const commands = pages.jobs.deploy.steps.map((step: { run?: string }) => step.run ?? "").join("\n")
    expect(commands).toContain("site-cli.mts --state crew-history")
    expect(commands).not.toMatch(/tools\/replay|@jollity\/replay/)
    expect(commands).not.toMatch(/npm run build(?:\n|$)|needs\.(?:ci|app|game)|workflow run/)
    expect(pages.jobs.deploy.permissions).toEqual({ contents: "read", pages: "write", "id-token": "write" })
  })
})
