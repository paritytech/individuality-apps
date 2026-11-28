// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

type Step = { id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string> }
type Job = { if: string; needs?: string[] | string; env: Record<string, string>; steps: Step[] }
const workflow = (name: string) => parse(readFileSync(resolve(__dirname, `../../../.github/workflows/${name}.yml`), "utf8")) as { jobs: Record<string, Job>; "run-name": string }
const live = workflow("e2e-live")
const pages = workflow("e2e-live-pages")
const annotation = workflow("e2e-live-annotate")
const repo = "paritytech/individuality-apps"
const trusted = { head_repository: { full_name: repo } }
const title = "Crew network=previewnet boot=false execution=manual classification=manual suite= wave="
const direct = { name: "E2E (live)", path: ".github/workflows/e2e-live.yml", event: "workflow_dispatch", display_title: title, ...trusted }
const annotated = { name: "E2E live recording annotation", path: ".github/workflows/e2e-live-annotate.yml", event: "workflow_run", display_title: `Crew annotation source=E2E (live) event=workflow_dispatch ${title}`, ...trusted }
const suite = { name: "PreviewNet Crew Nightly", path: ".github/workflows/e2e-live-nightly.yml", event: "workflow_dispatch", display_title: "PreviewNet complete crew suite", ...trusted }
const annotatedSuite = { ...trusted, name: annotated.name, path: annotated.path, event: annotated.event, display_title: `Crew annotation source=${suite.name} event=workflow_dispatch ${suite.display_title}` }
const scheduledSuite = { ...suite, event: "schedule" }
const annotatedScheduledSuite = { ...annotatedSuite, display_title: `Crew annotation source=${suite.name} event=schedule ${suite.display_title}` }
function admitted(source = direct, event_name = "workflow_run", ref = "refs/heads/main"): boolean {
  return Boolean(Function("github", "startsWith", "format", `return (${pages.jobs.admission?.if ?? "false"})`)(
    { event_name, ref, repository: repo, event: { workflow_run: source, repository: { default_branch: "main" } } },
    (text: string, prefix: string) => text.startsWith(prefix), (pattern: string, value: string) => pattern.replace("{0}", value),
  ))
}

describe("publication admission regressions", () => {
  it.each([
    ["game success", "success", "play", "success", false, false, true],
    ["product failure", "success", "play", "failure", false, false, true],
    ["lost player", "success", "play", "cancelled", false, false, true],
    ["probe skip", "success", "skip", "skipped", false, false, false],
    ["boot only", "skipped", "", "success", true, false, false],
    ["probe failure", "failure", "play", "skipped", false, false, false],
    ["cancelled workflow", "success", "play", "cancelled", false, true, false],
  ])("%s: gate before gather runner, checkout, guards and publication", (_, probe, decision, play, boot_only, cancelled, expected) => {
    const result = Function("github", "inputs", "needs", "always", "cancelled", `return (${live.jobs.gather.if})`)(
      { event_name: "workflow_dispatch", run_attempt: 1 }, { boot_only, telemetry: true, suite_id: "" },
      { probe: { result: probe, outputs: { decision } }, play: { result: play } }, () => true, () => cancelled,
    )
    expect(result).toBe(expected)
  })

  it("stops every gather recovery step if cancellation arrives during setup", () => {
    for (const step of live.jobs.gather.steps.filter((step) => step.if))
      expect(step.if).toContain("!cancelled()")
  })

  it("admits direct, complete-suite and annotation evidence but rejects untrusted sources before setup", () => {
    expect(admitted(direct)).toBe(true)
    expect(admitted(annotated)).toBe(true)
    expect(admitted(suite)).toBe(true)
    expect(admitted(annotatedSuite)).toBe(true)
    expect(admitted(scheduledSuite)).toBe(true)
    expect(admitted(annotatedScheduledSuite)).toBe(true)
    for (const source of [direct, annotated, suite, annotatedSuite, scheduledSuite, annotatedScheduledSuite]) {
      for (const mutation of [
        { name: "Other workflow" }, { path: ".github/workflows/untrusted.yml" }, { event: "pull_request" },
        { display_title: source.display_title.replace("previewnet", "paseo-next-v2") },
        { display_title: source.display_title.replace("boot=false", "boot=true") },
        { display_title: source.display_title.replace("event=workflow_dispatch", "event=pull_request") },
        { head_repository: { full_name: "attacker/individuality-apps" } },
      ]) {
        if (mutation.display_title === source.display_title) continue
        expect(admitted({ ...source, ...mutation }), JSON.stringify(mutation)).toBe(false)
      }
    }
    expect(admitted({ ...direct, head_repository: { full_name: "attacker/individuality-apps" } })).toBe(false)
    expect(admitted(direct, "workflow_dispatch")).toBe(true)
    expect(admitted(direct, "workflow_dispatch", "refs/heads/topic")).toBe(false)
    expect(admitted({ ...direct, path: ".github/workflows/crew-suite.yml" })).toBe(false)
    expect(annotation["run-name"]).toContain("github.event.workflow_run.display_title")
    expect(annotation["run-name"]).toContain("github.event.workflow_run.event")
  })

  function resolveSource(options: { annotation?: boolean; manual?: boolean; hasBundle?: boolean; suite?: boolean; source?: Record<string, unknown> } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "crew-pages-admission-"))
    const output = join(dir, "output")
    const apiLog = join(dir, "requests")
    writeFileSync(output, "")
    const publication = { id: 1, name: "crew-publication-9-attempt-1-manual", expired: false }
    const released = { id: 2, name: `e2e-live-9-public-records-attempt-1${options.suite ? "-game-ready" : ""}`, expired: false }
    const source = { id: 9, status: "completed", run_attempt: 1, head_branch: "main", ...(options.suite ? suite : direct), ...options.source }
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const request = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(apiLog)}, request + '\\n');
if (request.includes('/runs/20/artifacts')) console.log(${JSON.stringify(JSON.stringify({ artifacts: [released] }))});
else if (request.includes('/runs/9/artifacts')) console.log(${JSON.stringify(JSON.stringify({ artifacts: options.hasBundle === false ? [] : [publication] }))});
else if (request.endsWith('/runs/9/attempts/1')) console.log(${JSON.stringify(JSON.stringify(source))});
else if (request.endsWith('/runs/9')) console.log(${JSON.stringify(JSON.stringify({ ...source, run_attempt: 2, status: "in_progress" }))});
else { console.error('Unexpected request: ' + request); process.exit(1); }
`, { mode: 0o755 })
    const script = pages.jobs.admission?.steps.find((step) => step.id === "source")?.run
    expect(script).toBeDefined()
    const result = spawnSync("bash", ["-c", script!], { cwd: dir, encoding: "utf8", env: {
      PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: repo, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(dir, "summary"),
      REQUESTED_RUN_ID: options.annotation ? "20" : "9", REQUESTED_ATTEMPT: options.manual ? "1" : "",
      SOURCE_EVENT: options.manual ? "workflow_dispatch" : "workflow_run", SOURCE_WORKFLOW: options.annotation ? annotated.name : direct.name,
      EVENT_ATTEMPT: "1", E2E_DEFAULT_BRANCH: "main",
    } })
    return { result, output: readFileSync(output, "utf8"), requests: readFileSync(apiLog, "utf8") }
  }

  it.each([{}, { annotation: true }, { manual: true }])("pins the original completed attempt despite a later running rerun: %j", (options) => {
    const { result, output, requests } = resolveSource(options)
    expect(result.status, result.stderr).toBe(0)
    expect(output).toContain("id=9\nattempt=1\nkind=direct\nready=true")
    expect(requests).toContain("/runs/9/attempts/1")
    expect(requests.split("\n")).not.toContain(`api repos/${repo}/actions/runs/9`)
  })

  it.each([
    { suite: true },
    { suite: true, annotation: true },
    { suite: true, source: { event: "schedule" } },
  ])("admits the completed exact-attempt suite only when leaf publication exists: %j", (options) => {
    const { result, output, requests } = resolveSource(options)
    expect(result.status, result.stderr).toBe(0)
    expect(output).toContain("id=9\nattempt=1\nkind=suite\nready=true")
    expect(requests).toContain("/runs/9/attempts/1")
    expect(requests).toContain("/runs/9/artifacts")
  })

  it("admits a suite when the REST API exposes its run title as name", () => {
    const { result, output } = resolveSource({ suite: true, source: { name: suite.display_title } })
    expect(result.status, result.stderr).toBe(0)
    expect(output).toContain("id=9\nattempt=1\nkind=suite\nready=true")
  })

  it("keeps probe skips without publication evidence out of the history runner and queue", () => {
    const { result, output } = resolveSource({ hasBundle: false })
    expect(result.status, result.stderr).toBe(0)
    expect(output).not.toContain("ready=true")
    expect(pages.jobs.history.if).toBe("needs.admission.outputs.ready == 'true'")
  })

  it.each([
    { suite: true, source: { status: "in_progress" } },
        { suite: true, source: { event: "pull_request" } },
    { source: { status: "in_progress" } },
  ])("rejects unfinished or unsupported sources: %j", (options) => {
    const { result, output } = resolveSource(options)
    expect(result.status).not.toBe(0)
    expect(output).not.toContain("ready=true")
  })

  it.each([{ event: "pull_request" }, { path: ".github/workflows/crew-suite.yml" }, { head_branch: "topic" }, { head_repository: { full_name: "attacker/individuality-apps" } }, { run_attempt: 2 }, { status: "queued" }, { display_title: title.replace("previewnet", "paseo-next-v2") }])("fails closed when resolved direct source disagrees with admission: %j", (source) => {
    const { result, output } = resolveSource({ source })
    expect(result.status).not.toBe(0)
    expect(output).not.toContain("ready=true")
  })
})
