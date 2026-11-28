// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { emptyResult } from "./result"
import { applySupervisorOutcome, boundaryActions, boundaryDecision, ensureGroupDirectories, finalizeGroupChild, groupChildren, noteGroupChildMessage, parseRunnerGroup, recordSharedNetem, runnerGroups, shapeDeadline, writeSupervisorOutcome } from "./runner-group"
import type { BotEntry } from "./timing"

const entries: BotEntry[] = [
  { bot: 4, profile: "baseline-iphone14-wifi", identity: "one.1", secret: "ONE_1" },
  { bot: 8, profile: "locale-la-enus", identity: "two.2", secret: "TWO_2" },
]
const group = runnerGroups(entries, { share: "on" }).include[0]

describe("runner group supervisor contract", () => {
  it("isolates every child secret, port range, state and artifact path", () => {
    const children = groupChildren(group, {
      CI: "true", E2E_GROUP_MNEMONIC_1: "alpha secret", E2E_GROUP_MNEMONIC_2: "beta secret",
      E2E_GROUP_MNEMONIC_3: "unused secret", HOST_CLI_SIGNER_MNEMONIC: "must disappear",
    }, "/runner-temp")
    expect(children.map(({ env, out }) => ({ slot: env.E2E_SLOT, secret: env.E2E_PLAYER_MNEMONIC, base: env.E2E_BASE_PORT, state: env.E2E_STATE_DIR, out }))).toEqual([
      { slot: "4", secret: "alpha secret", base: "10000", state: "/runner-temp/e2e-live-groups/g01/bot-4", out: "/tmp/e2e-live-out/bot-4" },
      { slot: "8", secret: "beta secret", base: "11000", state: "/runner-temp/e2e-live-groups/g01/bot-8", out: "/tmp/e2e-live-out/bot-8" },
    ])
    for (const child of children) {
      expect(child.env.HOST_CLI_SIGNER_MNEMONIC).toBeUndefined()
      expect(Object.keys(child.env).some((key) => key.startsWith("E2E_GROUP_MNEMONIC_"))).toBe(false)
    }
  })

  it("validates the bounded planned row without re-reading profile data", () => {
    expect(() => parseRunnerGroup(JSON.stringify({ ...group, shared: false, size: 1, entries: [entries[0]] }))).toThrow(/2\.\.3/)
    expect(() => parseRunnerGroup(JSON.stringify({ ...group, size: 4, entries: [...entries, entries[0], entries[1]] }))).toThrow(/1\.\.3/)
    expect(() => parseRunnerGroup(JSON.stringify({ ...group, effect_profile: "" }))).toThrow(/planned static-network effect/)
  })

  it("partitions ready, pending and already-expired children without file polling", () => {
    const children = groupChildren(group, { E2E_GROUP_MNEMONIC_1: "alpha", E2E_GROUP_MNEMONIC_2: "beta" }, "/tmp")
    expect(boundaryDecision(children, new Map([[4, 200], [8, 100]]), new Set(), 100)).toEqual({ ready: [children[0]], pending: [], expired: [children[1]] })
    expect(boundaryDecision(children, new Map([[4, 200]]), new Set(), 100)).toEqual({ ready: [children[0]], pending: [children[1]], expired: [] })
    expect(boundaryDecision(children, new Map([[4, 200], [8, 400]]), new Set(), 250)).toEqual({ ready: [children[1]], pending: [], expired: [children[0]] })
    expect(shapeDeadline(children, new Map([[4, 50_000], [8, 60_000]]), 90_000)).toBe(30_000)
  })

  it("does not spin on an expired ready child's deadline while a sibling is pending", () => {
    const children = groupChildren(group, { E2E_GROUP_MNEMONIC_1: "alpha", E2E_GROUP_MNEMONIC_2: "beta" }, "/tmp/group")
    const ready = new Map([[4, 30]])
    const decision = boundaryDecision(children, ready, new Set(), 31)

    expect(decision).toEqual({ ready: [], pending: [children[1]], expired: [children[0]] })
    expect(shapeDeadline(decision.ready, ready, 600_000)).toBe(600_000)
  })

  it("never expires an already released sibling while a later child is still booting", () => {
    const children = groupChildren(group, { E2E_GROUP_MNEMONIC_1: "alpha", E2E_GROUP_MNEMONIC_2: "beta" }, "/tmp")
    const decision = boundaryDecision(children, new Map([[4, 200]]), new Set(), 250)
    expect(boundaryActions(decision, new Set([4]), new Set())).toEqual({ release: [], expire: [] })
    expect(decision.pending).toEqual([children[1]])
  })

  it("retains a child's deadline outcome when it exits while shared shaping is still applying", () => {
    const children = groupChildren(group, { E2E_GROUP_MNEMONIC_1: "alpha", E2E_GROUP_MNEMONIC_2: "beta" }, "/tmp")
    const ready = new Map<number, number | null>([[4, 30]])
    const missed = new Map<number, string>()
    expect(noteGroupChildMessage({ type: "e2e-group-expired", slot: 4, reason: "registration budget expired" }, 4, ready, missed)).toBe(true)
    expect(boundaryDecision(children, ready, new Set([4]), 31)).toEqual({ ready: [], pending: [children[1]], expired: [children[0]] })
    expect(missed).toEqual(new Map([[4, "registration budget expired"]]))
  })

  it("writes one typed red supervisor outcome and preserves real results", () => {
    const root = mkdtempSync(join(tmpdir(), "jollity-runner-outcomes-"))
    const children = groupChildren(group, { E2E_GROUP_MNEMONIC_1: "alpha", E2E_GROUP_MNEMONIC_2: "beta", GITHUB_SHA: "abc123" }, root, root)
    ensureGroupDirectories(children)
    const existing = emptyResult(children[0].member.bot, "account", children[0].member.identity)
    existing.stages.a.status = "pass"
    writeFileSync(join(children[0].out, `result-${children[0].member.bot}.json`), JSON.stringify(existing))
    const outcomes = [{ bot: 4, code: 0, result: true }, { bot: 8, code: 1, result: false }]
    applySupervisorOutcome(children, outcomes, { kind: "shared-registration-deadline-missed", detail: "late" })
    expect(outcomes.every(({ result }) => result)).toBe(true)
    const kept = JSON.parse(readFileSync(join(children[0].out, "result-4.json"), "utf8"))
    const created = JSON.parse(readFileSync(join(children[1].out, "result-8.json"), "utf8"))
    expect(kept.stages.a.status).toBe("pass")
    expect(kept.runnerOutcomes).toEqual([{ kind: "shared-registration-deadline-missed", detail: "late" }])
    expect(kept.inconclusive).toBeUndefined()
    expect(created).toMatchObject({ slot: 8, profile: "locale-la-enus", provenance: { commit: "abc123" }, runnerOutcomes: [{ kind: "shared-registration-deadline-missed", detail: "late" }] })
  })

  it("does not manufacture cleanup evidence when a result is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "jollity-runner-cleanup-"))
    const [child] = groupChildren(group, { E2E_GROUP_MNEMONIC_1: "alpha", E2E_GROUP_MNEMONIC_2: "beta" }, root, root)
    ensureGroupDirectories([child])
    expect(writeSupervisorOutcome(child, { kind: "shared-network-cleanup-failed", detail: "clear failed" }, { create: false })).toBe(false)
  })

  it("copies shared network evidence into every child artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "jollity-runner-netem-"))
    const children = groupChildren(group, { E2E_GROUP_MNEMONIC_1: "alpha", E2E_GROUP_MNEMONIC_2: "beta" }, root, root)
    ensureGroupDirectories(children)
    recordSharedNetem(children, ["apply", "wifi"], "qdisc wifi", "2026-10-09T00:00:00Z")
    for (const child of children) expect(readFileSync(join(child.out, "netem.log"), "utf8")).toContain("shared netem apply wifi\nqdisc wifi")
  })

  it("turns malformed result evidence into a failed outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "jollity-runner-malformed-"))
    const [child] = groupChildren(group, { E2E_GROUP_MNEMONIC_1: "alpha", E2E_GROUP_MNEMONIC_2: "beta" }, root, root)
    ensureGroupDirectories([child])
    writeFileSync(join(child.out, `result-${child.member.bot}.json`), "{truncated")
    await expect(finalizeGroupChild(child, Promise.resolve(0), () => undefined)).resolves.toMatchObject({ bot: child.member.bot, code: 1, result: false, annotationError: expect.any(String) })
  })
})
