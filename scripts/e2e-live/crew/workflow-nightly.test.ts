// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { identityFor, loadProfiles } from "../profile"
import { buildNightlyPlan } from "./nightly-plan"

const load = (name: string) => parse(readFileSync(resolve(__dirname, `../../../.github/workflows/${name}.yml`), "utf8"))
const suite = load("e2e-live-nightly")
const live = load("e2e-live")
const pages = load("e2e-live-pages")
const annotation = load("e2e-live-annotate")
const probeSource = readFileSync(resolve(__dirname, "../probe.mts"), "utf8")
const botSkill = readFileSync(resolve(__dirname, "../../../.claude/skills/bot-e2e/SKILL.md"), "utf8")
const agents = readFileSync(resolve(__dirname, "../AGENTS.md"), "utf8")

describe("complete-suite run, log, stop workflow", () => {
  it("runs at 03:17 Europe/Zurich and retains the explicitly reserved manual entry", () => {
    expect(Object.keys(suite.on)).toEqual(["schedule", "workflow_dispatch"])
    expect(suite.on.schedule).toEqual([{ cron: "17 3 * * *", timezone: "Europe/Zurich" }])
    expect(suite.on.workflow_dispatch.inputs.reserved_window_confirmed).toMatchObject({ type: "boolean", required: true, default: false })
    expect(suite.jobs.plan.if).toContain("github.event_name == 'schedule'")
    expect(suite.jobs.plan.if).toContain("inputs.reserved_window_confirmed == true")
    expect(JSON.stringify(suite)).toContain("stopped the ordinary dispatcher")
    expect(suite.permissions).toEqual({ actions: "read", checks: "read", contents: "read" })
    expect(suite.concurrency).toEqual({ group: "previewnet-crew-nightly", "cancel-in-progress": false, queue: "max" })
  })

  it("chains game-ready, specialists and checks serially (no telemetry job), then stops", () => {
    expect(Object.keys(suite.jobs)).toEqual(["plan", "pin", "game-ready", "specialists", "checks", "stale-build"])
    expect(suite.jobs["game-ready"].needs).toEqual(["plan", "pin"])
    expect(suite.jobs.specialists.needs).toEqual(["plan", "pin", "game-ready"])
    expect(suite.jobs.checks.needs).toEqual(["plan", "pin", "specialists"])
    expect(suite.jobs["stale-build"].needs).toEqual(["plan", "pin", "checks"])
    for (const name of ["game-ready", "specialists", "checks", "stale-build"]) {
      const job = suite.jobs[name]
      expect(job.strategy).toMatchObject({ "fail-fast": false, "max-parallel": 1 })
      expect(job.uses).toBe("./.github/workflows/e2e-live.yml")
      expect(job.secrets).toBe("inherit")
      expect(job.with).toMatchObject({ network: "previewnet", suite_id: "${{ needs.plan.outputs.suite_id }}", execution_key: "${{ matrix.key }}", suite_wave: "${{ matrix.key }}" })
    }
    expect(JSON.stringify(suite)).not.toMatch(/retry|finaliz|verdict|budget|receipt|republish|restarter|deadline/)
  })

  it("pins one app build for the whole run and hands it to every e2e-live call", () => {
    expect(suite.on.workflow_dispatch.inputs.app_cid).toMatchObject({ type: "string", required: false, default: "" })
    expect(suite.jobs.pin.if).toContain("inputs.reserved_window_confirmed == true")
    expect(suite.jobs.pin.outputs.app_cid).toBe("${{ steps.pin.outputs.app_cid }}")
    const pinStep = suite.jobs.pin.steps.find((step: { id?: string }) => step.id === "pin")
    expect(pinStep.run).toContain("scripts/e2e-live/pin-app.mts")
    expect(pinStep.env).toMatchObject({ E2E_NETWORK: "previewnet", E2E_APP_CID_INPUT: "${{ inputs.app_cid }}" })
    expect(JSON.stringify(suite.jobs.pin.steps)).toContain("app pinned:")
    for (const name of ["game-ready", "specialists", "checks", "stale-build"]) {
      const job = suite.jobs[name]
      expect(job.needs).toContain("pin")
      expect(job.if).toContain("needs.pin.result == 'success'")
      // a local app has no CID to pin (app_cid with app=local is refused)
      expect(job.with.app_cid).toBe("${{ matrix.app != 'local' && needs.pin.outputs.app_cid || '' }}")
    }
  })

  it("plans the 46 non-telemetry profiles, with stale-build final and boot-only", () => {
    const profiles = loadProfiles()
    const identities = Object.fromEntries(profiles.flatMap((profile) => {
      const identity = identityFor(profile, "previewnet")
      return identity ? [[identity, "available"]] : []
    }))
    const plan = buildNightlyPlan({ suiteId: "manual-suite-run-42", identities })
    expect(plan.waves.flatMap(({ coverageProfiles }) => coverageProfiles)).toHaveLength(46)
    expect(plan.waves.flatMap(({ profiles }) => profiles)).toHaveLength(49)
    expect(plan.waves.at(-1)).toMatchObject({ key: "check-stale-build", bootOnly: true, bootProfile: "check-stale-build" })
    expect(suite.jobs.checks.with.classification).toBe("harness-check")
    expect(suite.jobs["stale-build"].with.classification).toBe("harness-check")
  })

  it("shares one non-replacing live-game lane and rechecks manual work after queue acquisition", () => {
    expect(live.concurrency.group).toContain("e2e-live-{0}")
    expect(live.concurrency["cancel-in-progress"]).toBe(false)
    expect(live.concurrency.queue).toBe("max")
    expect(live.jobs.probe.name).toBeUndefined()
    expect(readFileSync(resolve(__dirname, "../../../.claude/skills/bot-e2e/scripts/game-loop.sh"), "utf8")).toContain('.name=="probe"')
    const admission = live.jobs.probe.steps.find((step: { name?: string }) => step.name?.startsWith("Refuse ordinary PreviewNet"))
    expect(admission.if).toContain("inputs.suite_id == ''")
    expect(admission.run).toContain("nightly-window-cli.mts manual")
    expect(admission.name).not.toContain("nightly window")
    expect(admission.run).not.toContain("NIGHTLY_WINDOW")
    expect(admission.run).toContain("gh run list --workflow e2e-live-nightly.yml")
    expect(admission.run).toContain('status == "queued"')
    expect(admission.run).toContain('status == "in_progress"')
    expect(probeSource).toContain("listedProfiles(process.env.BOTS).map((name) => profileForName(name))")
    expect(probeSource).toContain("? coldSuiteCandidateMinLeftS(suiteProfiles")
  })

  it("admits scheduled annotation and Pages evidence with exact event provenance", () => {
    expect(annotation.jobs.prepare.if).toContain("github.event.workflow_run.event == 'schedule'")
    expect(annotation.jobs.prepare.if).toContain("github.event.workflow_run.path == '.github/workflows/e2e-live-nightly.yml'")
    expect(annotation.jobs.prepare.if).not.toContain("github.event.workflow_run.name ==")
    expect(annotation.jobs["publish-recordings"].if).toContain("github.event.workflow_run.event == 'schedule'")
    expect(annotation.jobs["publish-recordings"].if).toContain("github.event.workflow_run.path == '.github/workflows/e2e-live-nightly.yml'")
    expect(annotation.jobs["publish-recordings"].if).not.toContain("github.event.workflow_run.name ==")
    expect(pages.jobs.admission.if).toContain("github.event.workflow_run.event == 'schedule'")
    expect(pages.jobs.admission.steps[0].run).toContain('.event == "schedule"')
  })

  it("documents the nightly plus ad-hoc contract for future persona and scenario changes", () => {
    expect(botSkill).toContain("03:17 Europe/Zurich")
    expect(botSkill).not.toContain("03:00–09:00")
    expect(botSkill).toContain("no reserved time window")
    expect(botSkill).not.toContain("Bots play ON DEMAND only")
    expect(botSkill).not.toContain("Nothing in the workflow runs on a schedule")
    expect(agents).toContain("03:17 Europe/Zurich")
    expect(agents).toContain("nightly schedule")
  })

  it("skips the expensive check job for every suite wave and has no PR wrapper", () => {
    expect(live.jobs.check.if).toBe("inputs.suite_id == ''")
    expect(live.on.pull_request).toBeUndefined()
    expect(existsSync(resolve(__dirname, "../../../.github/workflows/e2e-live-pr.yml"))).toBe(false)
  })

  it("publishes only completed exact-attempt leaf bundles into ordinary history", () => {
    expect(pages.on.workflow_run.types).toEqual(["completed"])
    expect(pages.on.workflow_run.workflows).toContain("PreviewNet Crew Nightly")
    expect(pages.jobs.admission.if).toContain("github.event.workflow_run.event == 'workflow_dispatch'")
    expect(pages.jobs.admission.steps[0].run).toContain("actions/runs/$source_id/attempts/$source_attempt")
    const download = pages.jobs.history.steps.find((step: { id?: string }) => step.id === "bundles").run
    expect(download).toContain('^crew-publication-' + '" + $run + "-attempt-" + $attempt')
    expect(download).toContain("publication-ids.tsv")
    expect(pages.jobs.history.steps.find((step: { name?: string }) => step.name === "Validate publication bundles before opening history")).toBeDefined()
    expect(JSON.stringify(pages)).not.toContain("in_progress")
  })

  it("annotates each selected-results execution once and keeps raw evidence for 14 days", () => {
    expect(annotation.on.workflow_dispatch.inputs.source_run_id).toMatchObject({ type: "string", required: true })
    expect(annotation.on.workflow_dispatch.inputs.source_run_attempt).toMatchObject({ type: "string", required: true, default: "1" })
    expect(annotation.on.workflow_run.workflows).toContain("PreviewNet Crew Nightly")
    expect(annotation.on.workflow_run.types).toEqual(["completed"])
    expect(annotation.jobs.prepare.if).toContain("github.event_name == 'workflow_dispatch'")
    expect(annotation.jobs.prepare.env.SOURCE_RUN_ID).toBe("${{ inputs.source_run_id || github.event.workflow_run.id }}")
    expect(annotation.jobs.prepare.env.SOURCE_ATTEMPT).toBe("${{ inputs.source_run_attempt || github.event.workflow_run.run_attempt }}")
    expect(annotation.jobs.annotate.env.E2E_EXECUTION_KEY).toBe("${{ matrix.execution_key }}")
    expect(annotation.jobs.annotate.env.RUN_ID).toBe("${{ inputs.source_run_id || github.event.workflow_run.id }}")
    expect(annotation.jobs.annotate.steps.find((step: { uses?: string }) => step.uses === "actions/download-artifact@v4").with.name).toBe("${{ matrix.artifact_name }}")
    expect(annotation.jobs.annotate.steps.find((step: { uses?: string }) => step.uses === "actions/download-artifact@v4").with["run-id"]).toBe("${{ inputs.source_run_id || github.event.workflow_run.id }}")
    expect(annotation.jobs["publish-recordings"].strategy.matrix).toBe("${{ fromJSON(needs.prepare.outputs.publication_matrix) }}")
    expect(annotation.jobs["publish-recordings"].if).toContain("github.event_name == 'workflow_run'")
    expect(annotation.jobs["publish-recordings"].env.E2E_EXECUTION_KEY).toBe("${{ matrix.execution_key }}")
    expect(annotation.jobs["publish-recordings"].steps.find((step: { name?: string }) => step.name === "Download every annotated player POV").with.pattern).toContain("${{ matrix.execution_key }}")
    const bundles = pages.jobs.history.steps.find((step: { id?: string }) => step.id === "bundles").run
    expect(bundles).toContain('release_name="$release_name-$execution"')
    expect(bundles).toContain('released-bundles/$execution')
    for (const workflow of [suite, live, pages, annotation]) {
      for (const job of Object.values(workflow.jobs) as Array<{ steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>) {
        for (const step of job.steps ?? []) if (step.uses?.startsWith("actions/upload-")) expect(step.with?.["retention-days"]).toBe(3)
      }
    }
  })
})
