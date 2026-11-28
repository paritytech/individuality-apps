// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { assertRegularPoolState, poolFromVariableRead, rebuildRegularPool, regularPoolSecret } from "./regular-pool"

describe("regularPoolSecret", () => {
  it("is one secret per chain", () => {
    expect(regularPoolSecret("previewnet")).toBe("E2E_POOL_PREVIEWNET")
    expect(regularPoolSecret("paseo-next-v2")).toBe("E2E_POOL")
  })
})

describe("rebuildRegularPool", () => {
  const mnemonics: Record<string, string> = { "a.1": "m-a1", "b.2": "m-b2", "c.3": "m-c3" }
  const variable = { "a.1": "5A", "b.2": "5B" }

  it("moves locally retained identities into the aggregate while keeping the public pool", () => {
    const result = rebuildRegularPool({ variable, mnemonicOf: (username) => mnemonics[username], legacy: new Set(["a.1", "b.2"]) })
    expect(result.variable).toEqual(variable)
    expect(result.secret).toEqual({ "a.1": "m-a1", "b.2": "m-b2" })
    expect(result.migratedLegacy).toEqual(["a.1", "b.2"])
    expect(result.legacyOnly).toEqual([])
  })

  it("keeps an identity on its legacy secret when this desk has no retained signer", () => {
    const result = rebuildRegularPool({ variable, mnemonicOf: (username) => (username === "a.1" ? mnemonics[username] : undefined), legacy: new Set(["a.1", "b.2"]) })
    expect(result.variable).toEqual(variable)
    expect(result.secret).toEqual({ "a.1": "m-a1" })
    expect(result.migratedLegacy).toEqual(["a.1"])
    expect(result.legacyOnly).toEqual(["b.2"])
  })

  it("fails closed when neither the desk nor a legacy secret can boot an identity", () => {
    expect(() => rebuildRegularPool({ variable, mnemonicOf: () => undefined, legacy: new Set(["a.1"]) })).toThrow(/b\.2/)
  })

  it("adds a newly minted identity without allocating an individual secret", () => {
    const result = rebuildRegularPool({ variable: { "a.1": "5A" }, mnemonicOf: () => "m-a1", legacy: new Set(), add: { username: "c.3", account: "5C", mnemonic: "m-c3" } })
    expect(result.variable).toEqual({ "a.1": "5A", "c.3": "5C" })
    expect(result.secret).toEqual({ "a.1": "m-a1", "c.3": "m-c3" })
  })

  it("never includes a mnemonic in an error", () => {
    try {
      rebuildRegularPool({ variable: { "a.1": "5A" }, mnemonicOf: () => "m-a1", legacy: new Set(), add: { username: "a.1", account: "5X", mnemonic: "m-secret" } })
    } catch (error) {
      expect(String(error)).not.toContain("m-a1")
      expect(String(error)).not.toContain("m-secret")
    }
  })
})

describe("regular pool GitHub state", () => {
  it("treats only the matching verified not-found response as an absent variable", () => {
    expect(poolFromVariableRead("E2E_IDENTITIES_PREVIEWNET", { ok: false, out: "variable E2E_IDENTITIES_PREVIEWNET was not found" })).toEqual({})
    expect(() => poolFromVariableRead("E2E_IDENTITIES_PREVIEWNET", { ok: false, out: "HTTP 500: temporary server error" })).toThrow(/gh variable get E2E_IDENTITIES_PREVIEWNET failed/)
    expect(() => poolFromVariableRead("E2E_IDENTITIES_PREVIEWNET", { ok: false, out: "variable E2E_IDENTITIES was not found" })).toThrow(/failed/)
  })

  it("refuses an empty public variable when its aggregate secret already exists", () => {
    expect(() => assertRegularPoolState("E2E_IDENTITIES_PREVIEWNET", {}, "E2E_POOL_PREVIEWNET", new Set(["E2E_POOL_PREVIEWNET"]))).toThrow(/inconsistent regular pool/)
    expect(() => assertRegularPoolState("E2E_IDENTITIES_PREVIEWNET", {}, "E2E_POOL_PREVIEWNET", new Set())).not.toThrow()
    expect(() => assertRegularPoolState("E2E_IDENTITIES_PREVIEWNET", { "bot.1": "5Account" }, "E2E_POOL_PREVIEWNET", new Set(["E2E_POOL_PREVIEWNET"]))).not.toThrow()
  })
})

describe("regular pool workflow wiring", () => {
  const workflow = readFileSync(resolve(__dirname, "../../.github/workflows/e2e-live.yml"), "utf8")

  it("masks both aggregate pools before either journey can receive a mnemonic", () => {
    const step = workflow.slice(workflow.indexOf("- name: Mask the identity pools' mnemonics"), workflow.indexOf("# boot.mts: oracle"))
    expect(step).toContain("E2E_POOL_JSON:")
    expect(step).toContain("E2E_FRESH_POOL_JSON:")
    expect(step).toContain("set -euo pipefail")
    expect(step).toContain("all(.[]; type == \"string\" and length > 0)")
    expect(step).toContain('echo "::add-mask::$m"')
    expect(workflow.match(/if: steps\.mask\.outcome == 'success' && matrix\.size/g)).toHaveLength(2)
  })

  it("normally prefers a legacy identity secret, then regular and fresh pools, with an aggregate-only proof switch", () => {
    expect(workflow.match(/\(!inputs\.aggregate_only && secrets\[format\('E2E_ID_\{0\}', matrix\.secret[123]\)\]\) \|\| fromJSON\(secrets\[inputs\.network == 'paseo-next-v2' && 'E2E_POOL' \|\| 'E2E_POOL_PREVIEWNET'\] \|\| '\{\}'\)\[matrix\.identity[123]\] \|\| fromJSON/g)).toHaveLength(4)
    expect(workflow).toContain("aggregate_only:")
  })
})
