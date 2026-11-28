// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const liveText = readFileSync(resolve(__dirname, "../../../.github/workflows/e2e-live.yml"), "utf8")
const pagesPath = resolve(__dirname, "../../../.github/workflows/e2e-live-pages.yml")
const pagesText = existsSync(pagesPath) ? readFileSync(pagesPath, "utf8") : ""
type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
type Job = { if?: string; env?: Record<string, string>; needs?: string[] | string; permissions?: Record<string, string>; concurrency?: { group: string; "cancel-in-progress": boolean; queue?: string }; environment?: { name: string }; steps: Step[] }
const live = parse(liveText) as { on: Record<string, { inputs?: Record<string, { type?: string; default?: unknown }> }>; jobs: Record<string, Job>; concurrency: Record<string, unknown>; env: Record<string, string> }
const pages = (parse(pagesText) ?? {}) as typeof live

describe("reusable live execution and Pages workflow", () => {
  it("mirrors every dispatch input with native reusable types and internal execution fields", () => {
    const called = live.on.workflow_call?.inputs
    expect(called).toBeDefined()
    for (const [name, input] of Object.entries(live.on.workflow_dispatch.inputs!)) {
      expect(called?.[name]?.type, name).toBe(input.type === "choice" ? "string" : input.type ?? "string")
      expect(called?.[name]?.default, name).toEqual(input.default)
    }
    for (const name of ["execution_key", "classification", "suite_id", "suite_wave"]) expect(called?.[name]?.type).toBe("string")
    expect(live.jobs).not.toHaveProperty("prepare")
    expect(live.jobs.probe.needs).toBeUndefined()
    for (const name of ["probe", "play"]) {
      const steps = live.jobs[name].steps
      const validation = steps.findIndex((step) => step.run?.includes("validate-inputs"))
      expect(validation, name).toBeGreaterThan(steps.findIndex((step) => step.run === "npm ci"))
    }
    expect(live.jobs.play.steps.findIndex((step) => step.run?.includes("validate-inputs"))).toBe(live.jobs.play.steps.findIndex((step) => step.run === "npm ci") + 1)
  })

  it("uses non-PR gates for real execution, and keeps cancellation limited to PRs", () => {
    expect(liveText).not.toMatch(/github\.event_name == 'workflow_dispatch'/)
    expect(live.jobs.probe.if).toContain("github.event_name != 'pull_request'")
    expect(live.jobs.play.if).toContain("github.event_name != 'pull_request'")
    expect(live.concurrency["cancel-in-progress"]).toBe(false)
    expect(live.concurrency.queue).toBe("max")
    // the PR wrapper was removed: no secret-holding workflow runs on a pull request
    expect(existsSync(resolve(__dirname, "../../../.github/workflows/e2e-live-pr.yml"))).toBe(false)
    for (const name of ["e2e-live", "e2e-live-annotate", "e2e-live-pages", "e2e-live-nightly", "attest-previewnet-bots"]) {
      const on = parse(readFileSync(resolve(__dirname, `../../../.github/workflows/${name}.yml`), "utf8")).on as Record<string, unknown>
      expect(on, name).not.toHaveProperty("pull_request")
      expect(on, name).not.toHaveProperty("pull_request_target")
    }
  })

  it("evaluates real-run and telemetry gates identically for direct and scheduled callers", () => {
    const expressions = Object.values(live.jobs).flatMap((job) => [job.if, ...Object.values(job.env ?? {})]).filter((value): value is string => Boolean(value?.includes("github.event_name != 'pull_request'")))
    expect(expressions.length).toBeGreaterThan(10)
    for (const enabled of [false, true]) {
      const inputs = { boot_only: enabled, telemetry: enabled, game_log_to_sentry: enabled, clock_watch_fault: enabled, flip_verdict: enabled, aggregate_only: false, boot_profile: "baseline", suite_id: "" }
      const evaluate = (expression: string, event_name: string): unknown => Function("github", "inputs", "needs", "secrets", "matrix", "startsWith", "always", "cancelled", `return (${expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "")})`)(
        { event_name, run_attempt: 1 }, inputs, { probe: { result: "success", outputs: { decision: "play", telemetry_profile: "false", devlog_harness: "true" } } },
        { SENTRY_DSN: "configured", SENTRY_DSN_TEST: "configured" }, { bot1: 1 }, (text: string, prefix: string) => text.startsWith(prefix), () => true, () => false,
      )
      for (const expression of expressions) expect(evaluate(expression, "schedule"), expression).toEqual(evaluate(expression, "workflow_dispatch"))
      expect(evaluate(live.jobs.probe.if!, "pull_request")).toBe(false)
      expect(evaluate(live.jobs.gather.if!, "pull_request")).toBe(false)
    }
  })

  it("gathers decided gameplay and uploads one scoped PreviewNet bundle after guards", () => {
    expect(live.jobs.gather.if).toContain("!cancelled()")
    expect(live.jobs.gather.if).toContain("github.event_name != 'pull_request'")
    expect(live.jobs.gather.if).toContain("!inputs.boot_only")
    const steps = live.jobs.gather.steps
    const refresh = steps.findIndex((step) => step.name === "Refresh publication after guards")
    expect(refresh).toBeGreaterThan(steps.findIndex((step) => step.name === "Evaluate the bots' guards"))
    const publication = steps.find((step) => step.with?.name === "crew-publication-${{ github.run_id }}-attempt-${{ github.run_attempt }}-${{ env.E2E_EXECUTION_KEY }}")
    expect(publication?.if).toContain("!cancelled()")
    expect(publication?.if).toContain("previewnet")
    expect(publication?.with?.["retention-days"]).toBe(3)
    expect(publication?.with?.path).toBe("publication-out/")
    for (const step of steps.filter((step) => step.uses === "actions/upload-artifact@v4")) expect(step.with?.["retention-days"]).toBe(3)
  })

  it("uses default-branch code, exact source artifacts, separate history/deploy writers and a cross-repo Pages branch", () => {
    expect(pages.on?.workflow_run).toBeDefined()
    expect(pages.on?.workflow_dispatch?.inputs?.source_run_id).toBeDefined()
    expect(pages.on?.workflow_dispatch?.inputs?.source_run_attempt).toBeDefined()
    expect(pages.on).not.toHaveProperty("schedule")
    expect(pages.jobs?.history?.concurrency).toEqual({ group: "previewnet-crew-pages-history", "cancel-in-progress": false, queue: "max" })
    expect(pages.jobs?.deploy?.concurrency).toEqual({ group: "previewnet-crew-pages-deploy", "cancel-in-progress": false, queue: "max" })
    expect(pages.jobs?.history?.permissions).toEqual({ contents: "write", actions: "read" })
    expect(pages.jobs?.history?.needs).toBe("admission")
    expect(pages.jobs?.history?.if).toBe("needs.admission.outputs.ready == 'true'")
    expect(pages.jobs?.admission?.steps.every((step) => !step.uses && !step.run?.includes("npm"))).toBe(true)
    expect(pages.jobs?.history?.env?.SOURCE_RUN_ID).toBe("${{ needs.admission.outputs.id }}")
    expect(pages.jobs?.history?.env?.SOURCE_ATTEMPT).toBe("${{ needs.admission.outputs.attempt }}")
    expect(pages.jobs?.history?.env?.SOURCE_KIND).toBe("${{ needs.admission.outputs.kind }}")
    expect(pages.jobs.admission.steps.find((step) => step.id === "source")?.run).toContain("actions/runs/$source_id/attempts/$source_attempt")
    expect(pages.jobs?.deploy?.permissions).toEqual({ contents: "read" })
    expect(pages.jobs?.deploy?.environment).toBeUndefined()
    expect(pages.jobs?.deploy?.env?.SITE_BRANCH).toBe("gh-pages")
    expect(pagesText).toContain("ref: ${{ github.event.repository.default_branch }}")
    expect(pagesText).toContain("previewnet-crew-pages")
    expect(pagesText).toContain("publish-cli.mts")
    expect(pagesText).toContain("site-cli.mts")
    expect(pagesText).not.toContain("actions/deploy-pages")
    // The one secret is the results-repository token, held only by the deploy job.
    expect(pagesText.match(/secrets\.[A-Z_]+/g)).toEqual(["secrets.JOLLITY_TESTS_RELEASE_TOKEN"])
    expect(JSON.stringify(pages.jobs?.deploy?.steps)).toContain("secrets.JOLLITY_TESTS_RELEASE_TOKEN")
    expect(pagesText).not.toMatch(/--force|E2E_POOL|SENTRY_|TURN_/)
  })

  it("downloads only unexpired bundles from the requested run and current attempt", () => {
    const script = pages.jobs?.history?.steps.find((step) => step.id === "bundles")?.run ?? ""
    const filter = /jq -r --arg run "\$SOURCE_RUN_ID" --arg attempt "\$SOURCE_ATTEMPT" '([^']+)'/.exec(script)?.[1]
    expect(filter).toBeDefined()
    const result = spawnSync("jq", ["-r", "--arg", "run", "9", "--arg", "attempt", "2", filter!], {
      encoding: "utf8", input: JSON.stringify([
        { id: 1, name: "crew-publication-9-attempt-2-manual", expired: false },
        { id: 2, name: "crew-publication-9-attempt-1-manual", expired: false },
        { id: 3, name: "crew-publication-90-attempt-2-manual", expired: false },
        { id: 4, name: "crew-publication-9-attempt-2-game-ready", expired: false },
        { id: 5, name: "crew-publication-9-attempt-2-manual", expired: true },
      ]),
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split("\n")).toEqual(["1\tmanual", "4\tgame-ready"])
    const steps = pages.jobs.history.steps
    expect(steps.findIndex((step) => step.name === "Validate publication bundles before opening history")).toBeLessThan(steps.findIndex((step) => step.id === "publish"))
    expect(script).toContain('release_tag="crew-run-$SOURCE_RUN_ID-a$release_attempt"')
    expect(script).toContain('release_tag="$release_tag-x$execution"')
    expect(script).toContain("released-publication-bundle.json")
    expect(script).toContain("curl --fail --location --silent --show-error")
    expect(script).toContain("[.runs[] | select((.runId | tostring) == $run and .executionKey == $execution")
    expect(script).toContain("| unique | sort | reverse[]")
    expect(script).not.toContain('release_tag="crew-run-$SOURCE_RUN_ID-a$SOURCE_ATTEMPT"')
    expect(script).toContain(".diagnostics == null")
    expect(script).toContain(".source.artifactId")
    expect(script).toContain("e2e-live-$result_run-attempt-$artifact_attempt-$result_execution-bot$bot-result")
    expect(script).toContain(".size_in_bytes")
    expect(script).toContain(". <= 8388608")
    expect(script).toContain('result-bundles/$artifact_id/$result_id')
    const resultSelection = /jq -r '([^']*\.diagnostics == null[^']*)'/.exec(script)?.[1]
    expect(resultSelection).toBeDefined()
    const selected = spawnSync("jq", ["-r", resultSelection!], { encoding: "utf8", input: JSON.stringify({ runs: [
      { diagnostics: undefined, scenario: {}, bot: 1, source: { artifactId: 10 }, artifactAttempt: 2, executionKey: "wave-a", runId: 9 },
      { diagnostics: [], scenario: {}, bot: 2, source: { artifactId: 11 }, artifactAttempt: 2, executionKey: "wave-a", runId: 9 },
      { diagnostics: undefined, scenario: { criteria: [] }, bot: 3, source: { artifactId: 12 }, artifactAttempt: 2, executionKey: "wave-a", runId: 9 },
      { diagnostics: undefined, scenario: {}, bot: 4, source: { artifactId: 13 }, artifactAttempt: null, executionKey: "wave-a", runId: 9 },
    ] }) })
    expect(selected.status, selected.stderr).toBe(0)
    expect(selected.stdout.trim()).toBe("10\t1\twave-a\t2\t9")

    const attemptsFilter = /jq -r --arg run "\$SOURCE_RUN_ID" --arg execution "\$execution" \\\n\s+'([^']+)'/.exec(script)?.[1]
    expect(attemptsFilter).toBeDefined()
    const attempts = spawnSync("jq", ["-r", "--arg", "run", "9", "--arg", "execution", "game-ready", attemptsFilter!], {
      encoding: "utf8", input: JSON.stringify({ runs: [
        { runId: 9, attempt: 1, executionKey: "game-ready" },
        { runId: 9, attempt: 2, executionKey: "game-ready" },
        { runId: 9, attempt: 2, executionKey: "game-ready" },
        { runId: 9, attempt: 3, executionKey: "specialist-01" },
        { runId: 10, attempt: 4, executionKey: "game-ready" },
      ] }),
    })
    expect(attempts.status, attempts.stderr).toBe(0)
    expect(attempts.stdout.trim().split("\n")).toEqual(["2", "1"])

    const artifactFilter = /jq -e --argjson id "\$result_id" --arg name "\$expected_name"\s+\\\n\s+'([^']+)'/.exec(script)?.[1]
    expect(artifactFilter).toBeDefined()
    const expectedName = "e2e-live-9-attempt-2-wave-a-bot1-result"
    const exact = { id: 10, name: expectedName, expired: false, size_in_bytes: 8_388_608 }
    const accepts = (artifacts: unknown[]): number | null => spawnSync("jq", ["-e", "--argjson", "id", "10", "--arg", "name", expectedName, artifactFilter!], { encoding: "utf8", input: JSON.stringify(artifacts) }).status
    expect(accepts([exact])).toBe(0)
    for (const artifacts of [
      [{ ...exact, id: 11 }],
      [{ ...exact, name: `${expectedName}-wrong` }],
      [{ ...exact, expired: true }],
      [{ ...exact, size_in_bytes: 8_388_609 }],
      [exact, exact],
    ]) expect(accepts(artifacts)).not.toBe(0)
    const validation = pages.jobs.history.steps.find((step) => step.name === "Validate publication bundles before opening history")?.run ?? ""
    expect(validation).toContain('"result-bundles/$artifact_id"')
    const publish = pages.jobs.history.steps.find((step) => step.id === "publish")?.run ?? ""
    expect(publish).toContain('"validated/$artifact_id/publication-bundle.json"')
    expect(publish).not.toContain("result-bundles")
  })
})
