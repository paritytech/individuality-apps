// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The grants checks as the workflows wire them: deploy.yml's read-back after a
// paseo publish, release.yml's check of the staged grants, and the hourly
// humanity-grants.yml. Shell steps run here as the workflow text has them.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string>; uses?: string }
type Job = { env?: Record<string, string>; steps: Step[]; permissions?: Record<string, string>; "timeout-minutes"?: number }
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> }

const workflow = (file: string) => {
  const text = readFileSync(join(__dirname, "../../.github/workflows", file), "utf8")
  return { text, doc: parse(text) as Workflow }
}
const stepNamed = (job: Job, prefix: string) => {
  const step = job.steps.find((s) => s.name?.startsWith(prefix))
  if (!step) throw new Error(`no step "${prefix}"`)
  return step
}

/** Runs a step's script in bash, with shell functions standing in for commands. */
function runStep(script: string, { env = {}, stubs = "", cwd }: { env?: Record<string, string>; stubs?: string; cwd?: string } = {}) {
  const dir = cwd ?? mkdtempSync(join(tmpdir(), "grants-step-"))
  const output = join(dir, "github-output")
  writeFileSync(output, "")
  const r = spawnSync("bash", ["-e", "-c", `${stubs}\n${script}`], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, ...env },
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: readFileSync(output, "utf8"), dir }
}

describe("deploy.yml: the grants read-back", () => {
  const { doc } = workflow("deploy.yml")
  const job = doc.jobs.humanity!
  const names = job.steps.map((s) => s.name ?? s.uses ?? "")
  const install = stepNamed(job, "Install the dotns CLI")
  const readBack = stepNamed(job, "Read back the published grants")

  it("runs right after the publish, on paseo legs that are not a pull request's", () => {
    const publish = names.indexOf("Publish to Bulletin and DotNS")
    expect(names.indexOf(install.name!)).toBe(publish + 1)
    expect(names.indexOf(readBack.name!)).toBe(publish + 2)
    expect(install.if).toBe("${{ matrix.tld == 'paseo' && !matrix.comment }}")
    expect(readBack.if).toBe("${{ matrix.tld == 'paseo' && !matrix.comment && steps.dotns-cli.outputs.installed == 'true' }}")
    expect(install.id).toBe("dotns-cli")
    expect(job.env?.DOTNS_CLI_VERSION).toBe("1.1.0")
  })

  it("only warns when the read fails, and confirms wrong grants before failing", () => {
    expect(readBack.run).toBe('node scripts/ci/check-grants.mjs --env paseo-v2 --unchecked-warns --confirm-wrong "$DOMAIN"')
    expect(readBack.env).toEqual({
      HUMANITY_TRUSTED_PRODUCTS: "${{ vars.HUMANITY_TRUSTED_PRODUCTS }}",
      JOLLITY_DOTNS_DOMAIN: "${{ vars.JOLLITY_DOTNS_DOMAIN }}",
    })
    expect(JSON.stringify(readBack.env)).not.toContain("secrets.")
  })

  it("tries the install 3 times, then warns and leaves the read-back off instead of failing", () => {
    const stubs = 'npm() { echo try >> tries; return 1; }\nsleep() { :; }'
    const r = runStep(install.run!, { stubs, env: { DOTNS_CLI_VERSION: "1.1.0", DOMAIN: "peoplnext.paseo" } })
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(join(r.dir, "tries"), "utf8").trim().split("\n")).toHaveLength(3)
    expect(r.output).toBe("")
    expect(r.stdout).toContain("::warning title=Could not check the grants of peoplnext.paseo::")
  })

  it("marks the CLI installed when a retry works", () => {
    const stubs = '[ -f tries ] || : > tries\nnpm() { echo try >> tries; [ "$(wc -l < tries)" -ge 2 ]; }\nsleep() { :; }'
    const r = runStep(install.run!, { stubs, env: { DOTNS_CLI_VERSION: "1.1.0", DOMAIN: "peoplnext.paseo" } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.output).toBe("installed=true\n")
    expect(r.stdout).not.toContain("::warning")
  })
})

describe("release.yml: the staged grants check", () => {
  const { doc } = workflow("release.yml")
  const step = stepNamed(doc.jobs.humanity!, "Check the staged grants")
  const today = '{"back-me-up":["context"],"dim2":["context","storage"],"dim2next":["context","storage"]}'

  it("reads the Jollity label from JOLLITY_DOTNS_DOMAIN", () => {
    expect(step.env?.JOLLITY).toBe("${{ vars.JOLLITY_DOTNS_DOMAIN }}")
  })

  /** Runs the step with the staged name granting `staged` and the variable at `expected`. */
  function check(staged: string, expected: string, jollity = "dim2") {
    const dir = mkdtempSync(join(tmpdir(), "release-grants-"))
    mkdirSync(join(dir, "records"))
    const manifest = JSON.stringify({ $v: 1, displayName: "Humanity", trustedProducts: JSON.parse(staged) })
    writeFileSync(join(dir, "records/peoplnext.paseo.manifest.json"), JSON.stringify({ exists: true, value: manifest }))
    return runStep(step.run!, {
      cwd: dir,
      env: { EXPECTED: expected, JOLLITY: jollity, STAGED: "peoplnext.paseo", DOMAIN: "peopl.paseo", LABEL: "peopl" },
    })
  }

  it("passes today's grants", () => {
    const r = check(today, today)
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain("as HUMANITY_TRUSTED_PRODUCTS says")
  })

  it("fails a dim2 that lacks context or storage, even when the variable says the same", () => {
    for (const grants of ['{"dim2":["contextual","storage"]}', '{"dim2":["context"]}', '{"back-me-up":["context"]}', "{}"]) {
      const r = check(grants, grants)
      expect(r.status, grants).toBe(1)
      expect(r.stdout).toContain("::error title=Staged grants leave Jollity out::")
    }
  })

  it("fails when the Jollity label is unset", () => {
    const r = check(today, today, "")
    expect(r.status).toBe(1)
    expect(r.stdout).toContain("(JOLLITY_DOTNS_DOMAIN unset) lacks context or storage")
  })

  it("still fails staged grants that differ from the variable", () => {
    const r = check('{"dim2":["context","storage"]}', today)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain("::error title=Staged grants differ::")
  })
})

describe("humanity-grants.yml", () => {
  const { text, doc } = workflow("humanity-grants.yml")
  const job = doc.jobs.grants!
  const monitorConfig = JSON.parse(job.env!.MONITOR_CONFIG!)

  it("runs every hour, by hand too, with no key", () => {
    expect(doc.on).toEqual({ schedule: [{ cron: "23 * * * *" }], workflow_dispatch: null })
    expect(doc.permissions).toEqual({ contents: "read" })
    expect(text).not.toMatch(/MNEMONIC/)
  })

  it("reads previewnet on the stack it publishes, with a CLI that has --stack", () => {
    expect(job.env?.DOTNS_CLI_VERSION).toBe("2.0.0")
    const stack = new URL(job.env!.PREVIEWNET_STACK!)
    expect(stack.protocol).toBe("polkadotapp:")
    expect(stack.searchParams.get("url")).toBe("https://previewnet.substrate.dev/.well-known/trinity-stack.json")
    expect(stack.searchParams.get("key")).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("tells Sentry the same schedule it runs on", () => {
    expect(monitorConfig.schedule).toEqual({ type: "crontab", value: "23 * * * *" })
    expect(monitorConfig.timezone).toBe("UTC")
    expect(monitorConfig.max_runtime).toBeGreaterThan(job["timeout-minutes"]!)
    expect(job.env?.MONITOR_SLUG).toBe("humanity-grants")
  })

  it("checks both paseo names and the previewnet name, and uses Jollity's SENTRY_DSN for both check-ins", () => {
    expect(stepNamed(job, "Read the live grants").run).toBe(
      'node scripts/ci/check-grants.mjs --results "$RUNNER_TEMP/grants-results.json" ' +
        '--env paseo-v2 "${LABEL}.paseo" "${LABEL}next.paseo" ' +
        '--stack "$PREVIEWNET_STACK" "${LABEL}.testnet"',
    )
    expect(stepNamed(job, "Tell Sentry the check started").env).toEqual({ SENTRY_DSN: "${{ secrets.SENTRY_DSN }}" })
    expect(stepNamed(job, "Tell Sentry how the check ended").env?.SENTRY_DSN).toBe("${{ secrets.SENTRY_DSN }}")
  })

  it("always closes the check-in: ok only when the check said ok", () => {
    const end = stepNamed(job, "Tell Sentry how the check ended")
    expect(end.if).toBe("always()")
    const stubs = 'node() { echo "$*"; }'
    const sent = (outcome: string) => runStep(end.run!, { stubs, env: { OUTCOME: outcome, MONITOR_SLUG: "humanity-grants", RUNNER_TEMP: "/tmp/r" } }).stdout
    const checkIn = (status: string) => `scripts/ci/sentry-checkin.mjs humanity-grants ${status}\n`
    const detail = "scripts/ci/sentry-grants.mjs humanity-grants /tmp/r/grants-results.json\n"
    expect(sent("ok")).toBe(checkIn("ok"))
    expect(sent("wrong")).toBe(detail + checkIn("error"))
    expect(sent("unchecked")).toBe(detail + checkIn("error"))
    expect(sent("")).toContain("::error title=Could not check the grants::The check stopped before it read the names.")
    expect(sent("")).toContain(detail + checkIn("error"))
  })

  it("sends the detail of a failed check with the same Sentry DSN and check-in id", () => {
    const end = stepNamed(job, "Tell Sentry how the check ended")
    expect(end.env?.SENTRY_DSN).toBe("${{ secrets.SENTRY_DSN }}")
    expect(stepNamed(job, "Tell Sentry the check started").run).toContain('echo "CHECK_IN_ID=$CHECK_IN_ID"')
  })
})
