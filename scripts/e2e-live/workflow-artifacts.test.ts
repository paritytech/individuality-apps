// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { botsOfJobName } from "./gather"
import { attemptArtifactName, parseResultArtifactName } from "./result"

interface UploadStep {
  name?: string
  if?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  "continue-on-error"?: boolean
  "timeout-minutes"?: number
  with?: {
    name?: string
    path?: string
    "retention-days"?: number
  }
}

const workflow = parse(readFileSync(resolve(__dirname, "../../.github/workflows/e2e-live.yml"), "utf8")) as {
  env: Record<string, string>
  on: { workflow_dispatch: { inputs: { telemetry: { default: boolean; description: string }; game_log_to_sentry: { default: boolean; description: string }; clock_watch_fault: { default: boolean; description: string }; flip_verdict: { default: boolean; description: string }; memory: { default: boolean; description: string } } } }
  jobs: {
    probe: { outputs: Record<string, string>; steps: UploadStep[] }
    play: { name: string; env: Record<string, string>; steps: UploadStep[] }
    "chain-capture": { needs: string; steps: UploadStep[] }
    gather: { needs: string[]; env: Record<string, string>; steps: UploadStep[] }
  }
}
const annotationWorkflow = parse(readFileSync(resolve(__dirname, "../../.github/workflows/e2e-live-annotate.yml"), "utf8")) as {
  env: Record<string, string>
  concurrency: { group: string; "cancel-in-progress": boolean }
  jobs: {
    "publish-recordings": { if: string }
    prepare: { if: string; steps: UploadStep[] }
    annotate: {
      needs: string
      if: string
      "continue-on-error": boolean
      strategy: { "fail-fast": boolean; "max-parallel": number; matrix: string }
      env: Record<string, string>
      steps: UploadStep[]
    }
  }
}
const ciWorkflow = parse(readFileSync(resolve(__dirname, "../../.github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, { steps: UploadStep[] }>
}
const journeySource = readFileSync(resolve(__dirname, "./journey.pw.ts"), "utf8")

function upload(name: string): UploadStep {
  const step = workflow.jobs.play.steps.find((candidate) => candidate.uses === "actions/upload-artifact@v4" && candidate.with?.name === name)
  expect(step, `upload step ${name}`).toBeDefined()
  return step as UploadStep
}

describe("live evidence upload contract", () => {
  it("inherits one normalized execution key in every job and keeps PR boot separate", () => {
    expect(workflow.env.E2E_EXECUTION_KEY).toBe("${{ github.event_name == 'pull_request' && 'pr-boot' || inputs.execution_key || 'manual' }}")
    expect(workflow.jobs.play.name).toContain(workflow.env.E2E_EXECUTION_KEY)
    for (const job of Object.values(workflow.jobs)) {
      const override = (job as { env?: Record<string, string> }).env?.E2E_EXECUTION_KEY
      expect(override).toBeUndefined()
    }
  })

  it("executes the workflow filters against repeated groups and multiple result attempts", () => {
    const listing = workflow.jobs.gather.steps.find((step) => step.name === "List the run's artifacts and play-job evidence")!.run!
    const download = workflow.jobs.gather.steps.find((step) => step.name === "Download every result attempt")!.run!
    const jobFilter = /jq -r --arg key "\$E2E_EXECUTION_KEY" '([^']+)' jobs.json/.exec(listing)![1]
    const artifactFilter = /jq -r --arg run "[^\n]+?" --arg key "\$E2E_EXECUTION_KEY" '([^']+)' artifacts.json/.exec(download)![1]
    const names = [
      "caller / play [wave-1] (group g1, bots 1-2)",
      "caller / play [wave-2] (group g1, bots 1-2)",
      "nested / caller / play [wave-1] (group g2, bots 3)",
      "caller / play [wave-10] (group g1, bots 1-2)",
    ]
    const jobs = spawnSync("jq", ["-r", "--arg", "key", "wave-1", jobFilter], {
      input: JSON.stringify({ jobs: names.map((name, id) => ({ id, name, conclusion: "failure" })) }), encoding: "utf8",
    })
    expect(jobs.status, jobs.stderr).toBe(0)
    expect(jobs.stdout.trim().split("\n")).toEqual(["0", "2"])
    const artifacts = spawnSync("jq", ["-r", "--arg", "run", "9", "--arg", "key", "wave-1", artifactFilter], {
      input: JSON.stringify({ artifacts: [
        { id: 1, name: "e2e-live-9-attempt-1-wave-1-bot2-result" },
        { id: 2, name: "e2e-live-9-attempt-2-wave-1-bot2-result" },
        { id: 3, name: "e2e-live-9-attempt-1-wave-2-bot2-result" },
        { id: 4, name: "e2e-live-9-attempt-1-wave-10-bot2-result" },
        { id: 5, name: "e2e-live-90-attempt-1-wave-1-bot2-result" },
        { id: 6, name: "e2e-live-9-attempt-1-wave-1-bot2" },
      ] }), encoding: "utf8",
    })
    expect(artifacts.status, artifacts.stderr).toBe(0)
    expect(artifacts.stdout.trim().split("\n").map((line) => line.split("\t")[0])).toEqual(["1", "2"])
  })

  it("downloads annotation evidence scoped by original attempt and execution", () => {
    expect(annotationWorkflow.jobs.annotate.env.E2E_EXECUTION_KEY).toBe("${{ matrix.execution_key }}")
    expect(annotationWorkflow.jobs).not.toHaveProperty("smoke")
    expect(annotationWorkflow.jobs.prepare.steps.some((step) => step.run?.includes("annotation-plan-cli.mts"))).toBe(true)
    expect(annotationWorkflow.jobs.annotate.steps.find((step) => step.uses === "actions/download-artifact@v4")?.with?.name).toBe("${{ matrix.artifact_name }}")
    expect(annotationWorkflow.jobs.annotate.steps.find((step) => step.uses === "actions/upload-artifact@v4")?.with?.name)
      .toBe("e2e-live-${{ inputs.source_run_id || github.event.workflow_run.id }}-attempt-${{ matrix.source_attempt }}-${{ env.E2E_EXECUTION_KEY }}-crew-hud-${{ matrix.group }}-annotation-${{ github.run_attempt }}")
  })

  it("preserves the cross-run rotation marker protocol outside wave evidence", () => {
    const marker = workflow.jobs.probe.steps.find((step) => step.uses === "actions/upload-artifact@v4")
    expect(marker?.with?.name).toBe("e2e-rotation-play-${{ inputs.network || 'previewnet' }}-${{ github.run_id }}-${{ steps.rotation.outputs.rotation_half }}")
  })

  it("scopes all live evidence uploads and downloads by execution and attempt", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of (job as { steps?: UploadStep[] }).steps ?? []) {
        if (step.with?.name?.startsWith("e2e-live-${{ github.run_id }}"))
          expect(step.with.name).toContain("e2e-live-${{ github.run_id }}-attempt-${{ github.run_attempt }}-${{ env.E2E_EXECUTION_KEY }}-")
      }
    }
    expect(workflow.jobs.play.name).toContain("play [")
  })
  it("keeps bot telemetry opt-in per run, never enabled by a T1-T12 profile", () => {
    expect(workflow.on.workflow_dispatch.inputs.telemetry.default).toBe(false)
    expect(workflow.on.workflow_dispatch.inputs.telemetry.description).toContain("Intentional telemetry check")
    expect(workflow.on.workflow_dispatch.inputs.telemetry.description).toContain("nothing enables it automatically")
    expect(workflow.jobs.probe.outputs.telemetry_profile).toBe("${{ steps.probe.outputs.telemetry_profile }}")
    for (const name of ["E2E_TELEMETRY", "NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN_TEST"]) {
      expect(workflow.jobs.play.env[name]).toContain("github.event_name != 'pull_request'")
      expect(workflow.jobs.play.env[name]).toContain("inputs.telemetry")
      expect(workflow.jobs.play.env[name]).not.toContain("github.event_name != 'workflow_dispatch'")
      expect(workflow.jobs.play.env[name]).not.toContain("telemetry_profile")
      expect(workflow.jobs.play.env[name]).not.toContain("devlog_harness")
      expect(workflow.jobs.play.env[name]).not.toContain("telemetry-t")
    }
    expect(workflow.jobs.gather.env.E2E_TELEMETRY).toContain("inputs.telemetry")
    expect(workflow.jobs.gather.env.E2E_TELEMETRY).not.toContain("telemetry_profile")
    expect(workflow.jobs.gather.env).not.toHaveProperty("DIM2_SENTRY_PROJECT")
    expect(workflow.jobs.play.env.DIM2_SENTRY_ORG).toBe("${{ vars.DIM2_SENTRY_ORG }}")
    expect(workflow.jobs.play.env.DIM2_SENTRY_PROJECT_IDS).toBe("${{ vars.DIM2_SENTRY_PROJECT_IDS }}")
  })

  it("enables the page harness only for dispatched devlog matrices", () => {
    expect(workflow.jobs.probe.outputs.devlog_harness).toBe("${{ steps.probe.outputs.devlog_harness }}")
    const harness = workflow.jobs.play.env.E2E_DEVLOG_HARNESS
    expect(harness).toContain("github.event_name != 'pull_request'")
    expect(harness).toContain("!inputs.boot_only")
    expect(harness).toContain("needs.probe.outputs.devlog_harness == 'true'")
    expect(harness).not.toContain("telemetry_profile")
    for (const name of ["E2E_TELEMETRY", "GAME_LOG_TO_SENTRY", "NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN_TEST"])
      expect(workflow.jobs.play.env[name]).not.toContain("devlog_harness")
  })

  it("keeps bot game logs off by default and enables them for explicit runs only", () => {
    expect(workflow.on.workflow_dispatch.inputs.game_log_to_sentry.default).toBe(false)
    expect(workflow.on.workflow_dispatch.inputs.game_log_to_sentry.description).toContain("game logs")
    expect(workflow.jobs.play.env.GAME_LOG_TO_SENTRY).toContain("inputs.game_log_to_sentry")
    expect(workflow.jobs.play.env.GAME_LOG_TO_SENTRY).not.toContain("telemetry_profile")
    expect(workflow.jobs.play.env.GAME_LOG_TO_SENTRY).not.toContain("devlog_harness")
    expect(workflow.jobs.gather.env.GAME_LOG_TO_SENTRY).toContain("inputs.game_log_to_sentry")
    expect(workflow.jobs.gather.env.GAME_LOG_TO_SENTRY).not.toContain("telemetry_profile")
  })

  it("offers the one-shot clock-watch fault only to bot 1", () => {
    expect(workflow.on.workflow_dispatch.inputs.clock_watch_fault.default).toBe(false)
    expect(workflow.on.workflow_dispatch.inputs.clock_watch_fault.description).toContain("chain-clock watch once")
    expect(workflow.jobs.play.env.E2E_CLOCK_WATCH_FAULT).toContain("inputs.clock_watch_fault")
    expect(workflow.jobs.play.env.E2E_CLOCK_WATCH_FAULT).toContain("matrix.bot1 == 1")
    for (const name of ["E2E_TELEMETRY", "NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN_TEST"])
      expect(workflow.jobs.play.env[name]).toContain("inputs.clock_watch_fault")
    expect(workflow.jobs.gather.env.E2E_TELEMETRY).not.toContain("inputs.clock_watch_fault")
    expect(journeySource).toMatch(/\.evaluate\(\(\) => \{\s+const requestedAt = Date\.now\(\)[\s\S]*failClockWatchOnce/)
    expect(journeySource).toContain('observeDevLogAt("clock", "chain clock subscription recovered")')
    expect(journeySource).toContain("recoveredAt <= failedAt")
  })

  it("offers the late verdict proof only to bot 1", () => {
    expect(workflow.on.workflow_dispatch.inputs.flip_verdict.default).toBe(false)
    expect(workflow.on.workflow_dispatch.inputs.flip_verdict.description).toContain("late confirm tile")
    expect(workflow.jobs.play.env.E2E_FLIP_VERDICT).toContain("inputs.flip_verdict")
    expect(workflow.jobs.play.env.E2E_FLIP_VERDICT).toContain("matrix.bot1 == 1")
    expect(workflow.jobs.play.env.E2E_FLIP_VERDICT).toContain("'1'")
  })

  it("keeps the Python Sentry readers out of the public gather job", () => {
    const readers = workflow.jobs.gather.steps.filter((step) => /share-measure|sentry-logs\.py|guard-evidence\.py/.test(step.run ?? ""))
    expect(readers).toHaveLength(0)
    expect(workflow.jobs.gather.steps.some((step) => /python3?\s/.test(step.run ?? ""))).toBe(false)
  })

  it("retains compact screenshot provenance with both per-bot artifacts", () => {
    const result = upload("e2e-live-${{ github.run_id }}-attempt-${{ github.run_attempt }}-${{ env.E2E_EXECUTION_KEY }}-bot${{ matrix.bot1 }}-result")
    const heavy = upload("e2e-live-${{ github.run_id }}-attempt-${{ github.run_attempt }}-${{ env.E2E_EXECUTION_KEY }}-bot${{ matrix.bot1 }}")

    expect(result.with?.path).toContain("/tmp/e2e-live-out/bot-${{ matrix.bot1 }}/screenshots-${{ matrix.bot1 }}.jsonl")
    expect(heavy.with?.path).toContain("/tmp/e2e-live-out/bot-${{ matrix.bot1 }}/screenshots-*.jsonl")
  })

  it("keeps the privacy-bounded named-file allowlists", () => {
    for (const step of workflow.jobs.play.steps.filter((candidate) => candidate.uses === "actions/upload-artifact@v4")) {
      expect(step.with?.path).not.toContain("/tmp/e2e-live-out/**")
    }
  })

  it("uploads two isolated, attempt-qualified artifacts for every possible group position", () => {
    for (const position of ["bot1", "bot2", "bot3"]) {
      const marker = "${{ matrix." + position + " }}"
      const heavy = "e2e-live-${{ github.run_id }}-attempt-${{ github.run_attempt }}-${{ env.E2E_EXECUTION_KEY }}-bot" + marker
      expect(upload(heavy + "-result").with?.path).toContain(`/bot-${marker}/result-${marker}.json`)
      expect(upload(heavy).with?.path).toContain(`/bot-${marker}/boot.log`)
      expect(upload(heavy).with?.path).toContain(`/bot-${marker}/video-*.webm`)
      expect(upload(heavy).with?.path).toContain(`/bot-${marker}/runner-health.jsonl`)
      expect(upload(heavy).with?.path).toContain(`/bot-${marker}/memory-*.json`)
    }
  })

  it("keeps live memory evidence explicitly opt-in", () => {
    expect(workflow.on.workflow_dispatch.inputs.memory.default).toBe(false)
    expect(workflow.on.workflow_dispatch.inputs.memory.description).toContain("memory/resource samples")
    expect(workflow.jobs.play.env.E2E_MEMORY).toContain("inputs.memory")
    expect(workflow.jobs.play.env.E2E_MEMORY).toContain("github.event_name != 'pull_request'")
  })

  // A group rerun re-uploads every bot of the group under the same names
  // unless the attempt is in them (#498): the result names must be the ones
  // gather parses, and each heavy name the one videoLink looks up.
  it("names every upload so gather binds it to its bot and attempt", () => {
    const runId = "123"
    const bots: Record<string, number> = { bot1: 2, bot2: 5, bot3: 9 }
    const expand = (name: string): string =>
      name
        .replaceAll("${{ github.run_id }}", runId)
        .replaceAll("${{ github.run_attempt }}", "3")
        .replaceAll("${{ env.E2E_EXECUTION_KEY }}", "manual")
        .replace(/\$\{\{ matrix\.(bot[123]) \}\}/g, (_, position: string) => String(bots[position]))
    const names = workflow.jobs.play.steps
      .filter((step) => step.uses === "actions/upload-artifact@v4" && step.with?.name?.startsWith("e2e-live-"))
      .map((step) => step.with?.name ?? "")
    expect(names).toHaveLength(6)
    for (const name of names) {
      const expanded = expand(name)
      expect(expanded, name).not.toContain("${{")
      if (expanded.endsWith("-result")) {
        const parsed = parseResultArtifactName(runId, expanded, "manual")
        expect(parsed, expanded).not.toBeNull()
        expect(parsed?.attempt).toBe(3)
        expect(Object.values(bots)).toContain(parsed?.bot)
      } else {
        const bot = Number(/-bot(\d+)$/.exec(expanded)?.[1])
        expect(expanded).toBe(attemptArtifactName(runId, bot, 3, "manual"))
      }
    }
    expect(new Set(names.map(expand)).size).toBe(names.length)
  })

  it("keeps the group job spelling that gather and the annotation filter read", () => {
    const jobName = workflow.jobs.play.name
      .replace("${{ matrix.group }}", "g1")
      .replace("${{ matrix.bots_label }}", "2-5-9")
      .replace(workflow.env.E2E_EXECUTION_KEY, "manual")
    expect(botsOfJobName(jobName, "manual")).toEqual([2, 5, 9])
    const list = workflow.jobs.gather.steps.find((step) => step.name === "List the run's artifacts and play-job evidence")
    expect(list?.run).toContain('startswith("play [" + $key + "] (group ")')
    expect(list?.run).not.toContain('startswith("play (bot ")')
  })

  it("fails closed through an explicit result-acquisition report", () => {
    const list = workflow.jobs.gather.steps.find((step) => step.name === "List the run's artifacts and play-job evidence")
    const download = workflow.jobs.gather.steps.find((step) => step.name === "Download every result attempt")
    const merge = workflow.jobs.gather.steps.find((step) => step.name === "Merge the bots' results")

    expect(list?.["continue-on-error"]).not.toBe(true)
    expect(list?.run).toContain("set -o pipefail")
    expect(download?.["continue-on-error"]).not.toBe(true)
    expect(download?.run).toContain("artifactListingComplete: false")
    expect(download?.run).toContain("downloaded: $downloaded")
    expect(download?.run).toMatch(/for delay in /)
    expect(merge?.env?.RESULT_ACQUISITION_JSON).toBe("result-acquisition.json")
    expect(merge?.run).toContain("gather-cli.mts gather-in gather-selected")
  })

  it("feeds every downstream reader the selected results, never every attempt", () => {
    const readers = workflow.jobs.gather.steps.filter((step) => /guards-cli|publication-cli|workflow-publication-cli/.test(step.run ?? ""))
    expect(readers.length).toBeGreaterThanOrEqual(1)
    for (const step of readers) {
      expect(step.run, step.name).toContain("gather-selected")
      expect(step.run, step.name).not.toMatch(/\bgather-in\b/)
    }
  })

  it("publishes the selected immutable result set for the annotation workers", () => {
    const selected = workflow.jobs.gather.steps.find((step) => step.uses === "actions/upload-artifact@v4" && step.with?.name === "e2e-live-${{ github.run_id }}-attempt-${{ github.run_attempt }}-${{ env.E2E_EXECUTION_KEY }}-selected-results")
    expect(selected?.if).toContain("!cancelled()")
    expect(selected?.["continue-on-error"]).toBe(true)
    expect(selected?.with?.path).toBe("gather-selected/")
    expect(selected?.with?.["retention-days"]).toBe(3)
  })

  it("renders crew HUD recordings in a separate post-run workflow", () => {
    expect((workflow.jobs as Record<string, unknown>).annotate).toBeUndefined()
    expect(annotationWorkflow.concurrency.group).toContain("e2e-live-annotate-")
    expect(annotationWorkflow.concurrency.group).not.toContain("inputs.network")
    expect(annotationWorkflow.concurrency["cancel-in-progress"]).toBe(false)

    const job = annotationWorkflow.jobs.annotate
    expect(job.needs).toBe("prepare")
    expect(job.if).toContain("has_results")
    expect(job["continue-on-error"]).toBe(true)
    expect(job.strategy["fail-fast"]).toBe(false)
    expect(job.strategy["max-parallel"]).toBeGreaterThanOrEqual(4)
    expect(job.strategy.matrix).toContain("needs.prepare.outputs.matrix")
    expect(job.env.RUN_ID).toBe("${{ inputs.source_run_id || github.event.workflow_run.id }}")
    expect(job.env.RUN_ATTEMPT).toBe("${{ matrix.source_attempt }}")

    const selected = job.steps.find((step) => step.uses === "actions/download-artifact@v4")
    expect(selected?.with?.name).toBe("${{ matrix.artifact_name }}")
    const originals = job.steps.find((step) => step.name === "Download the selected original recording artifacts")
    expect(originals?.["continue-on-error"]).toBe(true)
    expect(originals?.run).toContain('attempt=$(jq -r ".run.attempt" "$result")')
    expect(originals?.run).toContain('artifact_name="e2e-live-${RUN_ID}-attempt-${attempt}-${E2E_EXECUTION_KEY}-bot${bot}"')
    expect(originals?.run?.match(/artifact_name=.*$/m)?.[0]).not.toContain("-result")
    expect(originals?.run).toContain("actions/artifacts/${artifact_id}/zip")
    const render = job.steps.find((step) => step.name === "Render evidence-driven crew HUD recordings")
    expect(render?.if).toContain("always()")
    expect(render?.run).toContain("recording-annotate-cli.mts")
    expect(render?.run).toContain('--run-id "$RUN_ID"')
    expect(render?.run).toContain('--bots "$BOTS"')
    expect(render?.["continue-on-error"]).toBe(true)
    expect(job.steps.find((step) => step.name === "Explain a renderer setup failure per bot")?.if).toContain("always()")
    const upload = job.steps.find((step) => step.uses === "actions/upload-artifact@v4")
    expect(upload?.with?.name).toContain("-crew-hud-")
    expect(upload?.with?.path).toBe("work/${{ matrix.directory }}/annotated-recordings/")
    expect(upload?.with?.["retention-days"]).toBe(3)

    // the renderer smoke moved to CI: the secret-holding annotation workflow has no pull_request run
    const ciSteps = ciWorkflow.jobs["e2e-live"].steps
    const smokeDependencies = ciSteps.find((step) => step.name === "Install the recording renderer's dependencies")
    expect(smokeDependencies?.run).toContain("apt-get install -y ffmpeg")
    const smoke = ciSteps.find((step) => step.name === "Smoke the real recording annotation renderer")
    expect(smoke?.run).toContain("recording-smoke.mts")
  })

  it("trusts only same-repository dispatched or scheduled source runs in the annotation workflow", () => {
    const repo = "github.event.workflow_run.head_repository.full_name == github.repository"
    const annotation = annotationWorkflow.jobs
    expect(annotation["publish-recordings"].if).toContain(repo)
    expect(annotation.prepare.if).toContain(repo)
    const trust = annotation.prepare.steps.find((step) => step.name === "Require a trusted source run")
    expect(trust?.run).toContain("gh api")
    expect(trust?.run).toContain(".head_repository.full_name == $repo")
    expect(trust?.run).toContain(".github/workflows/e2e-live.yml")
    expect(trust?.run).toContain('.event == "workflow_dispatch"')
    const steps = annotation.prepare.steps
    expect(steps.indexOf(trust!)).toBeLessThan(steps.findIndex((step) => step.run === "npm ci"))
  })

  it("retains the adaptive proof beside the chain reports", () => {
    const step = workflow.jobs.gather.steps.find((candidate) => candidate.uses === "actions/upload-artifact@v4" && candidate.with?.name?.endsWith("-gather-evidence"))
    expect(step?.with?.path).toContain("gather-selected/adaptive-upload-proof.json")
    expect(step?.with?.path).toContain("chain-reports/")
    expect(step?.with?.path).not.toContain("sentry-logs/")
    expect(step?.with?.path).not.toContain("guard-evidence.json")
  })

  it("captures staged chain evidence in parallel while Preview still retains each point", () => {
    const job = workflow.jobs["chain-capture"]
    expect(job.needs).toBe("probe")
    const capture = job.steps.find((step) => step.name === "Capture kickoff, last-live, and settlement chain stages")
    expect(capture?.run).toContain("--capture-stage kickoff")
    expect(capture?.run).toContain("--capture-stage last-live")
    expect(capture?.run).toContain("--capture-stage settlement")
    expect(capture?.run).toContain("--staged")
    expect(capture?.run).toContain("--registration-opens")
    expect(capture?.run).toContain("registration_opens_iso=$(date -u -d")
    expect(capture?.run?.indexOf("--capture-stage settlement")).toBeLessThan(capture?.run?.indexOf('--out "$report.tmp"') ?? -1)
    expect(capture?.env?.E2E_NETWORK).toContain("inputs.network")
    expect(workflow.jobs.gather.needs).toContain("chain-capture")
    expect(workflow.jobs.gather.steps.some((step) => step.uses === "actions/download-artifact@v4" && step.with?.name?.includes("chain-stages"))).toBe(true)
  })
})
