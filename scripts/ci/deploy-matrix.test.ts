// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { LEGS, PASEO_LABEL, PREVIEW_LABEL, planLegs } from "./deploy-matrix.mjs"

type Step = { name?: string; uses?: string; id?: string; if?: string; run?: string; shell?: string; env?: Record<string, string>; with?: Record<string, unknown> }
type Job = { name?: string; if?: string; needs?: string | string[]; strategy?: { "fail-fast": boolean; matrix: { include: string } }; steps: Step[] }

const wf = readFileSync(join(__dirname, "../../.github/workflows/deploy.yml"), "utf8")
const doc = parse(wf) as { on: { pull_request: { types: string[] } }; concurrency: { group: string; "cancel-in-progress": boolean }; jobs: Record<string, Job> }
const envs = (legs: Array<{ env: string }>) => legs.map((l) => l.env)

type Ctx = { env?: string; event: string; action?: string; label?: string; labels?: string[]; network?: string; fork?: boolean }

// deploy.yml picks its legs with GitHub expressions, evaluated server-side
// before any runner exists. The offline test evaluates THE TEXT IN deploy.yml:
// every token is checked against this whitelist first, on which Actions and JS
// agree for string, boolean and null operands, so anything else fails the test
// instead of being mis-evaluated.
const REPO = "paritytech/individuality-apps"
const LABEL_NAMES = "github.event.pull_request.labels.*.name"
const PATHS = [
  LABEL_NAMES,
  "github.event.pull_request.head.repo.full_name",
  "github.event.label.name",
  "github.event.action",
  "github.event_name",
  "matrix.env",
  "github.repository",
  "github.run_id",
  "inputs.network",
]
const FUNCS = ["fromJSON", "format", "contains", "always"]

function evaluate(expr: string, c: Ctx): unknown {
  const body = expr.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
  let rest = body.replace(/'[^']*'/g, " ")
  for (const t of [...PATHS, ...FUNCS]) rest = rest.split(t).join(" ")
  expect(rest.replace(/&&|\|\||==|!=|[(),]/g, " ").trim(), `unsupported construct in: ${body}`).toBe("")
  // a missing property is null in Actions; ?. makes it undefined in JS, which compares the same
  let js = body.split(LABEL_NAMES).join("prLabels")
  for (const p of PATHS.slice(1)) js = js.split(p).join(p.replace(/\./g, "?."))
  const isPr = c.event === "pull_request"
  const github = {
    event_name: c.event,
    repository: REPO,
    run_id: "42",
    event: {
      action: c.action,
      label: c.label === undefined ? undefined : { name: c.label },
      pull_request: isPr ? { head: { repo: { full_name: c.fork ? "someone/individuality-apps" : REPO } } } : undefined,
    },
  }
  const matrix = { env: c.env }
  const inputs = c.network === undefined ? {} : { network: c.network }
  const lower = (v: unknown) => String(v ?? "").toLowerCase()
  // contains() is case-insensitive in Actions
  const contains = (hay: unknown, needle: unknown) =>
    Array.isArray(hay) ? hay.some((h) => lower(h) === lower(needle)) : lower(hay).includes(lower(needle))
  const format = (f: string, ...a: unknown[]) => f.replace(/\{(\d)\}/g, (_, i) => String(a[Number(i)]))
  return new Function("github", "matrix", "inputs", "prLabels", "fromJSON", "format", "contains", "always", `return (${js})`)(
    github, matrix, inputs, isPr ? (c.labels ?? []) : [], JSON.parse, format, contains, () => true,
  )
}

// every event deploy.yml can see
const LABEL_SETS = [[], [PREVIEW_LABEL], [PASEO_LABEL], [PREVIEW_LABEL, PASEO_LABEL], ["bug"]]
const CASES: Ctx[] = [
  { event: "push" },
  ...[undefined, "", "all", "preview", "paseo-next-v2"].map((network) => ({ event: "workflow_dispatch", network })),
  ...["opened", "synchronize", "reopened"].flatMap((action) => LABEL_SETS.map((labels) => ({ event: "pull_request", action, labels }))),
  ...[PREVIEW_LABEL, PASEO_LABEL, "bug"].flatMap((label) =>
    LABEL_SETS.map((labels) => ({ event: "pull_request", action: "labeled", label, labels: [...new Set([...labels, label])] })),
  ),
]
const FORKS = CASES.filter((c) => c.event === "pull_request").map((c) => ({ ...c, fork: true }))
const show = (c: Ctx) => JSON.stringify(c)
const isUnrelatedLabel = (c: Ctx) => c.event === "pull_request" && c.action === "labeled" && planLegs(c).length === 0

const deploy = doc.jobs.deploy
const INCLUDE = deploy.strategy!.matrix.include
const DEPLOY_IF = deploy.if!
const COMMENT_IF = doc.jobs.comment.if!
const SUFFIX = [...doc.concurrency.group.matchAll(/\$\{\{[\s\S]*?\}\}/g)][1]?.[0] ?? ""

describe("planLegs: main and workflow_dispatch", () => {
  it("does not expose a second unrelated-label classifier", async () => {
    expect(await import("./deploy-matrix.mjs")).not.toHaveProperty("isUnrelatedLabel")
  })
  it("push and an untargeted dispatch run both", () => {
    expect(envs(planLegs({ event: "push" }))).toEqual(["preview", "paseo-next-v2"])
    for (const network of ["all", "", undefined]) {
      expect(envs(planLegs({ event: "workflow_dispatch", network }))).toEqual(["preview", "paseo-next-v2"])
    }
  })
  it("a targeted dispatch expands to exactly one leg", () => {
    expect(envs(planLegs({ event: "workflow_dispatch", network: "preview" }))).toEqual(["preview"])
    expect(envs(planLegs({ event: "workflow_dispatch", network: "paseo-next-v2" }))).toEqual(["paseo-next-v2"])
  })
})

describe("planLegs: a PR push (opened, synchronize, reopened)", () => {
  for (const action of ["opened", "synchronize", "reopened"]) {
    it(`${action}: Previewnet always starts (its gate decides), never paseo unasked`, () => {
      expect(envs(planLegs({ event: "pull_request", action }))).toEqual(["preview"])
      expect(envs(planLegs({ event: "pull_request", action, labels: [PREVIEW_LABEL] }))).toEqual(["preview"])
    })
  }
  it("deploy-paseo adds paseo", () => {
    expect(envs(planLegs({ event: "pull_request", action: "synchronize", labels: [PASEO_LABEL] }))).toEqual(["preview", "paseo-next-v2"])
  })
})

describe("planLegs: a late label preserves every leg required by the current labels", () => {
  it("a late deploy-preview retains paseo when deploy-paseo is already on", () => {
    expect(envs(planLegs({ event: "pull_request", action: "labeled", label: PREVIEW_LABEL, labels: [PASEO_LABEL, PREVIEW_LABEL] }))).toEqual(["preview", "paseo-next-v2"])
  })
  it("a late deploy-paseo retains the Previewnet push leg it may replace", () => {
    expect(envs(planLegs({ event: "pull_request", action: "labeled", label: PASEO_LABEL, labels: [PASEO_LABEL] }))).toEqual(["preview", "paseo-next-v2"])
  })
  it("an unrelated label runs nothing", () => {
    expect(planLegs({ event: "pull_request", action: "labeled", label: "bug", labels: ["bug", PASEO_LABEL] })).toEqual([])
    expect(isUnrelatedLabel({ event: "pull_request", action: "labeled", label: "bug" })).toBe(true)
    expect(isUnrelatedLabel({ event: "pull_request", action: "labeled", label: PASEO_LABEL })).toBe(false)
    expect(isUnrelatedLabel({ event: "pull_request", action: "synchronize" })).toBe(false)
  })
})

describe("the legs", () => {
  it("every leg carries the properties the job reads", () => {
    for (const l of Object.values(LEGS)) {
      for (const k of ["env", "display-name", "network-name", "suffix", "shell", "staging-suffix", "deployer-product-id"]) expect(l).toHaveProperty(k)
    }
  })
  it("keeps the check names", () => {
    expect(LEGS.preview["display-name"]).toBe("Previewnet")
    expect(LEGS["paseo-next-v2"]["display-name"]).toBe("Paseo")
  })
})

describe("deploy.yml's expressions are planLegs", () => {
  it("the evaluator refuses what it cannot evaluate faithfully", () => {
    expect(() => evaluate("${{ !inputs.network }}", { event: "push" })).toThrow()
    expect(() => evaluate("${{ startsWith(github.ref, 'x') }}", { event: "push" })).toThrow()
  })
  it("the matrix is exactly planLegs, whole rows, for every event", () => {
    for (const c of CASES) expect(evaluate(INCLUDE, c), show(c)).toEqual(planLegs(c))
  })
  it("the job runs exactly when the matrix is non-empty (an empty include fails the run)", () => {
    for (const c of CASES) expect(Boolean(evaluate(DEPLOY_IF, c)), show(c)).toBe(planLegs(c).length > 0)
  })
  it("fork PRs are skipped", () => {
    for (const c of FORKS) expect(Boolean(evaluate(DEPLOY_IF, c)), show(c)).toBe(false)
  })
  it("the comment runs on every own-repo PR event but an unrelated label", () => {
    for (const c of [...CASES, ...FORKS]) {
      expect(Boolean(evaluate(COMMENT_IF, c)), show(c)).toBe(c.event === "pull_request" && !c.fork && !isUnrelatedLabel(c))
    }
  })
  it("serialises every productive event in the per-PR group and isolates unrelated labels", () => {
    expect(doc.concurrency.group.startsWith("deploy-${{ github.event.pull_request.number || 'production' }}")).toBe(true)
    expect(doc.concurrency["cancel-in-progress"]).toBe(false)
    // any pending productive run it replaces is covered by the complete plan
    for (const c of CASES) {
      const expected = isUnrelatedLabel(c) ? "-noop-42" : ""
      expect(evaluate(SUFFIX, c), show(c)).toBe(expected)
    }
  })
  it("keeps both deploy legs for simultaneous labels in either event order", () => {
    const labels = [PREVIEW_LABEL, PASEO_LABEL]
    const preview = { event: "pull_request", action: "labeled", label: PREVIEW_LABEL, labels }
    const paseo = { event: "pull_request", action: "labeled", label: PASEO_LABEL, labels }
    expect(envs(planLegs(preview))).toEqual(["preview", "paseo-next-v2"])
    expect(envs(planLegs(paseo))).toEqual(["preview", "paseo-next-v2"])
    expect(evaluate(SUFFIX, preview)).toBe("")
    expect(evaluate(SUFFIX, paseo)).toBe("")
  })
  it("a label replacing a pending push preserves its full required leg set for every prior-label state", () => {
    const states = [[], [PREVIEW_LABEL], [PASEO_LABEL], [PREVIEW_LABEL, PASEO_LABEL]]
    for (const prior of states) {
      const pending = { event: "pull_request", action: "synchronize", labels: prior }
      for (const added of [PREVIEW_LABEL, PASEO_LABEL]) {
        if (prior.includes(added)) continue
        const labels = [...prior, added]
        const replacement = { event: "pull_request", action: "labeled", label: added, labels }
        const pendingEnvs = envs(planLegs(pending))
        const replacementEnvs = envs(planLegs(replacement))
        expect(replacementEnvs, `${added} after ${prior.join(",") || "no labels"}`).toEqual(envs(planLegs({ event: "pull_request", action: "synchronize", labels })))
        expect(pendingEnvs.every((env) => replacementEnvs.includes(env)), `${added} must cover pending ${pendingEnvs.join(",")}`).toBe(true)
        expect(evaluate(SUFFIX, replacement), show(replacement)).toBe(evaluate(SUFFIX, pending))
      }
    }
  })
})

describe("the Previewnet gate", () => {
  const steps = deploy.steps
  const at = steps.findIndex((s) => s.id === "gate")
  const gate = steps[at]
  const title = (s: Step) => s.name ?? s.uses ?? ""

  it("runs right after checkout on Previewnet PR pushes and deploy-paseo replacements", () => {
    expect(steps[at - 1].uses).toBe("actions/checkout@v7")
    expect(steps[at - 1].with?.["fetch-depth"]).toBe(2)
    expect(gate.if).toBe("matrix.env == 'preview' && github.event_name == 'pull_request' && (github.event.action != 'labeled' || github.event.label.name == 'deploy-paseo')")
    expect(gate.shell).toBe("bash")
    expect(gate.run).toContain("set -o pipefail")
    expect(gate.run).toContain("node scripts/ci/changes.mjs HEAD^1 HEAD")
    expect(gate.env?.FORCED).toBe("${{ contains(github.event.pull_request.labels.*.name, 'deploy-preview') }}")
  })
  it("every deploy-only step is behind the gate, except recording and uploading the skip", () => {
    const UNGATED = ["Record the skipped preview", "Upload the deployment result"]
    expect(at).toBe(1)
    expect(steps[0].uses).toBe("actions/checkout@v7")
    expect(steps[at + 1].name).toBe("Require the DOTNS_MNEMONIC secret")
    for (const [i, s] of steps.entries()) {
      if (i === 0 || s === gate || UNGATED.includes(title(s))) continue
      expect(i, title(s)).toBeGreaterThan(at)
      // an ungated step whose own if reads cache-hit != 'true' would BUILD and PUBLISH
      expect(s.if, title(s)).toContain("steps.gate.outputs.gate != 'skip'")
    }
    expect(steps.find((s) => s.name === "Record the skipped preview")?.if).toBe("steps.gate.outputs.gate == 'skip'")
    expect(steps.find((s) => s.name === "Upload the deployment result")?.if).toBeUndefined()
  })
  it("records the skipped leg and uploads it under the normal result name", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-result-"))
    const record = steps.find((s) => s.name === "Record the skipped preview")!
    const r = spawnSync("bash", ["-eo", "pipefail", "-c", record.run!], { cwd: dir, encoding: "utf8" })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, ".deploy-result/preview.json"), "utf8"))).toEqual({ env: "preview", skipped: true })
    const upload = steps.find((s) => s.name === "Upload the deployment result")!
    expect(upload.uses).toBe("actions/upload-artifact@v4")
    expect(upload.with).toEqual({
      name: "deploy-result-${{ matrix.env }}",
      path: ".deploy-result/${{ matrix.env }}.json",
      "retention-days": 14,
    })
  })

  // the gate's own shell, run in a throwaway repo whose HEAD^1..HEAD is the PR
  const runGate = (files: string[], forced: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"))
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir })
    git("init", "-q")
    git("config", "commit.gpgsign", "false")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "t")
    writeFileSync(join(dir, "README.md"), "base\n")
    git("add", ".")
    git("commit", "-qm", "base")
    for (const f of files) {
      mkdirSync(join(dir, dirname(f)), { recursive: true })
      writeFileSync(join(dir, f), "pr\n")
    }
    git("add", ".")
    git("commit", "-qm", "pr")
    const out = join(dir, "github-output")
    writeFileSync(out, "")
    const script = gate.run!.split("scripts/ci/changes.mjs").join(join(__dirname, "changes.mjs"))
    const r = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, FORCED: String(forced) },
    })
    expect(r.status, r.stderr).toBe(0)
    return /^gate=(.*)$/m.exec(readFileSync(out, "utf8"))?.[1]
  }
  it("a scripts-only push skips, deploy-preview forces it, an app change deploys", () => {
    expect(runGate(["scripts/oss/x.mjs"], false)).toBe("skip")
    expect(runGate(["scripts/oss/x.mjs"], true)).toBe("deploy")
    expect(runGate(["apps/jollity-app/app/page.tsx"], false)).toBe("deploy")
    expect(runGate([".github/workflows/deploy.yml"], false)).toBe("deploy")
  })
  it("fails closed when the actual gate classifier pipeline crashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-crash-"))
    const out = join(dir, "github-output")
    writeFileSync(out, "")
    const script = `node() { return 17; }\n${gate.run!}`
    const r = spawnSync("bash", ["-e", "-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, FORCED: "false" },
    })
    expect(r.status, r.stderr).toBe(17)
    expect(readFileSync(out, "utf8")).not.toContain("gate=skip")
  })
})

describe("deploy.yml wiring", () => {
  it("listens for labels", () => {
    expect(doc.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "labeled"])
  })
  it("has no job in front of the deploy", () => {
    expect(Object.keys(doc.jobs).sort()).toEqual(["comment", "deploy"])
    expect(deploy.needs).toBeUndefined()
    expect(wf).not.toContain("needs.plan")
  })
  it("the comment job renders through deploy-comment.mjs and knows its legs from planLegs", () => {
    expect(wf).toContain("scripts/ci/deploy-comment.mjs")
    expect(wf).toContain("scripts/ci/deploy-matrix.mjs")
    expect(doc.jobs.comment.needs).toBe("deploy")
    expect(wf).not.toContain("One network did not publish")
  })
  it("keeps the check names and a flat matrix", () => {
    expect(deploy.name).toBe("${{ matrix.display-name }}")
    expect(deploy.strategy?.["fail-fast"]).toBe(false)
    // the matrix is flat (matrix.env, not matrix.target.env); a stale reference expands to nothing
    expect(wf).not.toContain("matrix.target.")
  })
  it("enables Logs on previewnet but holds Paseo releases off by default", () => {
    const decision = "${{ matrix.env == 'preview' && '1' || vars.NEXT_PUBLIC_TELEMETRY_LOGS || '0' }}"
    expect(wf).toContain(`NEXT_PUBLIC_TELEMETRY_LOGS: ${decision}`)
    expect(wf).toContain(`TELEMETRY_LOGS: ${decision}`)
    expect(wf).toContain('"$TELEMETRY_LOGS"')
  })
})
