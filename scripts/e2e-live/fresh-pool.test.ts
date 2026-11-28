// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { drawnFresh, deletableLegacy, freshPoolSecret, freshPoolVariable, listedProfiles, parseFreshPool, rebuildFreshPool, unboundFresh } from "./fresh-pool"
import { botMatrix } from "./timing"
import { loadProfiles, validateProfiles, loadNetemProfiles, profileByName, type Profile } from "./profile"
import raw from "./profiles.json"

describe("freshPoolVariable", () => {
  it("is per chain, beside the regular pool's names", () => {
    expect(freshPoolVariable("previewnet")).toBe("E2E_FRESH_IDENTITIES_PREVIEWNET")
    expect(freshPoolVariable("paseo-next-v2")).toBe("E2E_FRESH_IDENTITIES")
  })
})

describe("parseFreshPool", () => {
  it("an unset or empty variable is an empty pool, not an error (most runs need none)", () => {
    expect(parseFreshPool(undefined)).toEqual({})
    expect(parseFreshPool("  ")).toEqual({})
    expect(parseFreshPool("{}")).toEqual({})
  })
  it("reads {username: game account}", () => {
    expect(parseFreshPool('{"jollityfr.11":"5Aaa"}')).toEqual({ "jollityfr.11": "5Aaa" })
  })
  it("refuses a malformed one rather than guessing", () => {
    expect(() => parseFreshPool("[1]")).toThrow()
    expect(() => parseFreshPool('{"nodot":"5Aaa"}')).toThrow(/lite username/)
  })
})

describe("unboundFresh", () => {
  const pool = { "a.1": "5A", "b.2": "5B", "c.3": "5C" }
  it("keeps the persons the chain holds no binding for, in pool order", async () => {
    const bound = new Set(["5B"])
    expect(await unboundFresh(pool, {}, async (a) => bound.has(a))).toEqual(["a.1", "c.3"])
  })
  it("skips a person who is also in the regular pool (a long-lived bot is never fresh)", async () => {
    expect(await unboundFresh(pool, { "a.1": "5A" }, async () => false)).toEqual(["b.2", "c.3"])
  })
  it("never takes a failed read for 'unbound'", async () => {
    await expect(unboundFresh(pool, {}, async (a) => { if (a === "5B") throw new Error("rpc down"); return false })).rejects.toThrow(/rpc down/)
  })
  it("an empty pool reads nothing", async () => {
    let calls = 0
    expect(await unboundFresh({}, {}, async () => (calls++, false))).toEqual([])
    expect(calls).toBe(0)
  })
})

describe("check-seat-preparing", () => {
  const p = profileByName("check-seat-preparing")
  it("is runnable and takes a fresh person, not a fixed identity", () => {
    expect(p.pending).toBeUndefined()
    expect(p.freshIdentity).toBe(true)
    expect(p.identity).toBeUndefined()
  })
  const regular = { "base.1": "5R" }
  it("is scheduled by name with the first unbound person of the fresh pool", () => {
    const e = botMatrix('["check-seat-preparing"]', undefined, undefined, regular, "previewnet", undefined, undefined, ["fr.7", "fr.8"])
    expect(e).toEqual([{ bot: 1, profile: "check-seat-preparing", identity: "fr.7", secret: "FR_7" }])
  })
  it("says how to top the pool up when no unbound person is left", () => {
    expect(() => botMatrix('["check-seat-preparing"]', undefined, undefined, regular, "previewnet", undefined, undefined, [])).toThrow(/new-identity\.mts .*--fresh/)
  })
  it("never gives one person to two bots of a run", () => {
    const twin = { ...JSON.parse(JSON.stringify(p)), name: "check-seat-preparing-2" } as Profile
    const e = botMatrix('["check-seat-preparing","check-seat-preparing-2"]', ["check-seat-preparing", "check-seat-preparing-2"], [p, twin], regular, "previewnet", undefined, undefined, ["fr.7", "fr.8"])
    expect(e.map((x) => x.identity)).toEqual(["fr.7", "fr.8"])
  })
  it("is not part of 'all' (a fresh person is a consumable)", () => {
    const e = botMatrix("all", undefined, undefined, Object.fromEntries(loadProfiles().flatMap((q) => (typeof q.identity === "object" ? [[q.identity.previewnet, "5X"]] : []))), "previewnet", undefined, undefined, ["fr.7"])
    expect(e.map((x) => x.profile)).not.toContain("check-seat-preparing")
  })
})

describe("freshIdentity validation", () => {
  const netem = loadNetemProfiles()
  const base = () => structuredClone(raw.profiles.find((q) => q.name === "check-seat-preparing")) as Record<string, unknown>
  it("refuses a fixed identity beside it", () => {
    expect(() => validateProfiles({ profiles: [{ ...base(), identity: "fixturebotaa.69" }] }, netem)).toThrow(/freshIdentity/)
  })
  it("must be true when present", () => {
    expect(() => validateProfiles({ profiles: [{ ...base(), freshIdentity: "yes" }] }, netem)).toThrow(/freshIdentity/)
  })
})

describe("drawnFresh", () => {
  it("is the persons of the fresh profiles only, with their accounts, for the gather job", () => {
    const bots = [{ profile: "baseline", identity: "base.1" }, { profile: "check-seat-preparing", identity: "fr.7" }]
    expect(drawnFresh(bots, { "fr.7": "5F", "fr.8": "5G" }, (n) => n === "check-seat-preparing")).toEqual({ "fr.7": "5F" })
  })
  it("round-trips through the gather matrix: the drawn person alone is enough to resolve the same bot", () => {
    const regular = { "base.1": "5R" }
    const drawn = drawnFresh([{ profile: "check-seat-preparing", identity: "fr.7" }], { "fr.7": "5F", "fr.8": "5G" }, () => true)
    expect(botMatrix('["check-seat-preparing"]', undefined, undefined, regular, "previewnet", undefined, undefined, Object.keys(drawn))[0]).toMatchObject({ identity: "fr.7" })
  })
})

describe("freshPoolSecret", () => {
  it("is ONE secret per chain, beside the variable (the count of repo secrets never grows with the pool)", () => {
    expect(freshPoolSecret("previewnet")).toBe("E2E_FRESH_POOL_PREVIEWNET")
    expect(freshPoolSecret("paseo-next-v2")).toBe("E2E_FRESH_POOL")
  })
})

describe("listedProfiles (LOW 1: exact names, never a substring)", () => {
  it("reads the names of a JSON list, strings and {profile} entries", () => {
    expect(listedProfiles('["a","b"]')).toEqual(["a", "b"])
    expect(listedProfiles('[{"bot":1,"profile":"a"},"b"]')).toEqual(["a", "b"])
  })
  it("a preset, a count or junk names no profile", () => {
    for (const t of [undefined, "", "all", "core", "rotate", "3", "check-seat-preparing", "{", '{"profile":"a"}']) expect(listedProfiles(t)).toEqual([])
  })
  it("a profile whose name merely contains another is not that other", () => {
    expect(listedProfiles('["check-seat-preparing-2"]')).not.toContain("check-seat-preparing")
  })
})

describe("rebuildFreshPool (the desk's rebuild of the one JSON secret)", () => {
  const mnemonics: Record<string, string> = { "a.1": "m-a1", "b.2": "m-b2", "c.3": "m-c3" }
  const base = { variable: { "a.1": "5A", "b.2": "5B" }, mnemonicOf: (u: string) => mnemonics[u], spent: new Set<string>(), legacy: new Set<string>() }
  it("keeps every unspent person, secret and variable agreeing", () => {
    const r = rebuildFreshPool(base)
    expect(r.variable).toEqual({ "a.1": "5A", "b.2": "5B" })
    expect(r.secret).toEqual({ "a.1": "m-a1", "b.2": "m-b2" })
  })
  it("adds a new person to both", () => {
    const r = rebuildFreshPool({ ...base, add: { username: "c.3", account: "5C", mnemonic: "m-c3" } })
    expect(Object.keys(r.variable)).toEqual(["a.1", "b.2", "c.3"])
    expect(r.secret["c.3"]).toBe("m-c3")
  })
  it("prunes the spent from both and says who", () => {
    const r = rebuildFreshPool({ ...base, spent: new Set(["a.1"]) })
    expect(r.variable).toEqual({ "b.2": "5B" })
    expect(r.secret).toEqual({ "b.2": "m-b2" })
    expect(r.dropped).toEqual(["a.1"])
  })
  it("a person with no local slot is an error naming the person, unless spent or still on its own legacy secret", () => {
    const lost = { ...base, mnemonicOf: (u: string) => (u === "a.1" ? undefined : mnemonics[u]) }
    expect(() => rebuildFreshPool(lost)).toThrow(/a\.1/)
    expect(rebuildFreshPool({ ...lost, spent: new Set(["a.1"]) }).variable).toEqual({ "b.2": "5B" })
    const legacy = rebuildFreshPool({ ...lost, legacy: new Set(["a.1"]) })
    expect(legacy.variable).toEqual({ "a.1": "5A", "b.2": "5B" })
    expect(legacy.secret).toEqual({ "b.2": "m-b2" })
  })
  it("never puts a mnemonic in an error", () => {
    try {
      rebuildFreshPool({ ...base, add: { username: "a.1", account: "5X", mnemonic: "m-secret" } })
    } catch (e) {
      expect(String(e)).not.toContain("m-secret")
      expect(String(e)).not.toContain("m-a1")
    }
  })
})

describe("deletableLegacy (a spent person's own secret)", () => {
  const legacy = new Set(["a.1", "b.2", "c.3"])
  it("deletes only spent persons that have a legacy secret", () => {
    expect(deletableLegacy(["a.1", "z.9"], legacy, {}, new Set())).toEqual(["a.1"])
  })
  it("deletes nothing when the regular pool could not be read", () => {
    expect(deletableLegacy(["a.1"], legacy, null, new Set())).toEqual([])
  })
  it("never deletes a regular-pool person or one a profile names", () => {
    expect(deletableLegacy(["a.1", "b.2", "c.3"], legacy, { "a.1": "5A" }, new Set(["b.2"]))).toEqual(["c.3"])
  })
})

describe("the mask step fails closed", () => {
  const wf = readFileSync(resolve(__dirname, "../../.github/workflows/e2e-live.yml"), "utf8")
  const step = wf.slice(wf.indexOf("- name: Mask the identity pools' mnemonics"), wf.indexOf("# boot.mts: oracle"))
  it("uses pipefail, validates the JSON and masks without a failing test", () => {
    expect(step).toContain("set -euo pipefail")
    expect(step).toContain("jq -e 'type == \"object\" and all(.[]; type == \"string\" and length > 0)'")
    expect(step).toContain('if [ -n "$m" ]; then echo "::add-mask::$m"; fi')
  })
  it("gates both journey steps on the mask step succeeding", () => {
    expect(wf.match(/if: steps\.mask\.outcome == 'success' && matrix\.size/g)).toHaveLength(2)
  })
})
