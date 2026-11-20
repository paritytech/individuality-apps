// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { planHumanityLegs, shipsHumanity } from "./humanity-legs.mjs"

const domains = (legs: Array<{ domain: string }>) => legs.map((l) => l.domain)
const plan = (run: Record<string, unknown>) => planHumanityLegs({ label: "peopl", ...run })

describe("shipsHumanity", () => {
  it("counts the Humanity apps and the packages it is built on", () => {
    expect(shipsHumanity(["apps/humanity-app/src/main.ts"])).toBe(true)
    expect(shipsHumanity(["apps/humanity-worker/src/index.ts"])).toBe(true)
    expect(shipsHumanity(["packages/humanity-shared/src/a.ts"])).toBe(true)
    expect(shipsHumanity(["packages/shared-records/src/a.ts"])).toBe(true)
    expect(shipsHumanity(["packages/individuality-sign-up/src/a.ts"])).toBe(true)
    expect(shipsHumanity([".github/workflows/deploy.yml"])).toBe(true)
  })

  it("leaves out the lab, the tests and Jollity", () => {
    expect(
      shipsHumanity([
        "apps/humanity-app/lab/opening.ts",
        "apps/humanity-app/e2e/a.feature",
        "apps/humanity-app/tests/a.test.ts",
        "apps/humanity-app/scripts/lab/run.ts",
        "apps/humanity-app/lab.flow.config.ts",
        "apps/humanity-app/tsconfig.lab.json",
        "apps/humanity-app/eslint.config.mjs",
        "apps/humanity-app/docs/lab-notes.md",
        "apps/jollity-app/app/page.tsx",
        "package-lock.json",
      ]),
    ).toBe(false)
  })
})

describe("planHumanityLegs", () => {
  it("publishes peopl.testnet and the staging name on a push that ships Humanity", () => {
    // Given
    const run = { event: "push", ref: "refs/heads/main", changed: true }

    // When
    const legs = plan(run)

    // Then
    expect(domains(legs)).toEqual(["peopl.testnet", "peoplnext.paseo"])
    expect(legs.map((l) => l.environment)).toEqual(["humanity-previewnet", ""])
    expect(legs.every((l) => l.sentry)).toBe(true)
  })

  it("publishes nothing on a push that leaves Humanity alone", () => {
    expect(plan({ event: "push", ref: "refs/heads/main", changed: false })).toEqual([])
  })

  it("follows the dispatch inputs", () => {
    const dispatch = (network: string, target: string) =>
      domains(plan({ event: "workflow_dispatch", ref: "refs/heads/main", network, target, changed: false }))
    expect(dispatch("all", "staging")).toEqual(["peopl.testnet", "peoplnext.paseo"])
    expect(dispatch("preview", "staging")).toEqual(["peopl.testnet"])
    expect(dispatch("paseo-next-v2", "release")).toEqual(["peopl.paseo"])
  })

  it("records the release name against its environment", () => {
    const [released] = plan({ event: "workflow_dispatch", network: "paseo-next-v2", target: "release", changed: false })
    expect(released.environment).toBe("humanity-paseo-next-v2")
  })

  it("uploads no source maps from a branch other than main", () => {
    const legs = plan({ event: "workflow_dispatch", ref: "refs/heads/feature", network: "all", changed: false })
    expect(legs.some((l) => l.sentry)).toBe(false)
  })

  it("gives a same-repo pull request one commented preview next to its Jollity sandbox", () => {
    // Given
    const run = { event: "pull_request", action: "synchronize", pr: "42", sameRepo: true, changed: true }

    // When
    const legs = plan(run)

    // Then
    expect(legs).toEqual([
      {
        env: "preview",
        label: "peopl-pr42-preview",
        domain: "peopl-pr42-preview.testnet",
        environment: "",
        "sandbox-suffix": "-pr42-sandbox00",
        comment: true,
        sentry: false,
      },
    ])
  })

  it("gives no preview to a fork, a label or a pull request that leaves Humanity alone", () => {
    const pr = { event: "pull_request", pr: "42", sameRepo: true, changed: true }
    expect(plan({ ...pr, sameRepo: false })).toEqual([])
    expect(plan({ ...pr, action: "labeled" })).toEqual([])
    expect(plan({ ...pr, changed: false })).toEqual([])
  })

  it("refuses a DOTNS_DOMAIN_HUMANITY that is not a bare label", () => {
    for (const label of [undefined, "", "peopl.paseo", "Peopl", "-peopl"]) {
      expect(() => planHumanityLegs({ label, event: "push", ref: "refs/heads/main", changed: true }), String(label)).toThrow(/DOTNS_DOMAIN_HUMANITY/)
    }
  })

  it("builds every name from the label", () => {
    expect(domains(planHumanityLegs({ label: "card", event: "workflow_dispatch", network: "all", changed: false }))).toEqual(["card.testnet", "cardnext.paseo"])
  })

  it("leaves no Humanity name in the deploy and release machinery", () => {
    const root = join(__dirname, "../..")
    for (const file of [".github/workflows/deploy.yml", ".github/workflows/release.yml", "scripts/ci/humanity-legs.mjs"]) {
      expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(/\bpeopl(next)?\b/)
    }
  })
})
