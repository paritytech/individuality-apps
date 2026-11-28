// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { derivePlayers, identitySecretName, parseIdentities, portPlan, secretSuffix, stripSecrets } from "./players"

const M = (n: number) => `phrase ${n}`

describe("derivePlayers: CI", () => {
  it("plays the slot with the one mnemonic and sees nothing else", () => {
    expect(derivePlayers({ E2E_SLOT: "4", E2E_PLAYER_MNEMONIC: M(4) }, [])).toEqual({ mode: "ci", players: [{ n: 4, mnemonic: M(4) }] })
  })
  it("refuses the mnemonic without a slot", () => {
    expect(() => derivePlayers({ E2E_PLAYER_MNEMONIC: M(1) }, [])).toThrow(/needs E2E_SLOT/)
  })
  it("ignores the old numbered names", () => {
    expect(() => derivePlayers({ CI: "true", E2E_SLOT: "2", E2E_PLAYER_2_MNEMONIC: M(2) }, [])).toThrow(/secret is missing/)
  })
  it("rejects a bad slot", () => {
    expect(() => derivePlayers({ E2E_SLOT: "0", E2E_PLAYER_MNEMONIC: M(1) }, [])).toThrow(/not a slot number/)
    expect(() => derivePlayers({ E2E_SLOT: "x" }, [1])).toThrow(/not a slot number/)
  })
  it("in CI with the secret missing is an error, not a desk run", () => {
    expect(() => derivePlayers({ CI: "true", E2E_SLOT: "2" }, [2])).toThrow(/secret is missing/)
    expect(() => derivePlayers({ CI: "true" }, [1, 2])).toThrow(/E2E_PLAYER_MNEMONIC is not/)
  })
})

describe("derivePlayers: desk", () => {
  it("plays every slot directory present", () => {
    expect(derivePlayers({}, [3, 1, 2])).toEqual({ mode: "desk", players: [1, 2, 3].map((n) => ({ n, mnemonic: "" })) })
  })
  it("E2E_SLOT narrows to one, which must exist", () => {
    expect(derivePlayers({ E2E_SLOT: "2" }, [1, 2, 3]).players).toEqual([{ n: 2, mnemonic: "" }])
    expect(() => derivePlayers({ E2E_SLOT: "5" }, [1, 2, 3])).toThrow(/no desk slot e2e-5/)
  })
  it("errors with nothing to play", () => {
    expect(() => derivePlayers({}, [])).toThrow(/no E2E_PLAYER/)
  })
})

describe("mnemonic hygiene", () => {
  it("stripSecrets leaves no phrase in a child env", () => {
    const env = stripSecrets({ PATH: "/bin", E2E_SLOT: "1", E2E_PLAYER_MNEMONIC: M(1), HOST_CLI_SIGNER_MNEMONIC: M(3), E2E_GROUP_MNEMONIC_1: M(4), E2E_GROUP_MNEMONIC_3: M(5), UNSET: undefined })
    expect(env).toEqual({ PATH: "/bin", E2E_SLOT: "1" })
    expect(JSON.stringify(env)).not.toContain("phrase")
  })
})

describe("portPlan", () => {
  it("keeps three processes apart with distinct bases", () => {
    const used = [10000, 11000, 12000].flatMap((b) => {
      const p = portPlan(b, 0)
      return [p.hostStart, p.appStart, p.oracle]
    })
    expect(new Set(used).size).toBe(used.length)
  })
  it("defaults to the historical ports", () => {
    expect(portPlan(0, 1)).toEqual({ hostStart: 9955, appStart: 3000, oracle: 9976 })
  })
})

describe("the identity pool", () => {
  it("names a secret after the username", () => {
    expect(secretSuffix("fixturebotaa.69")).toBe("FIXTUREBOTAA_69")
    expect(identitySecretName("fixturebotzz.74")).toBe("E2E_ID_FIXTUREBOTZZ_74")
    expect(() => secretSuffix("Not A Name")).toThrow(/not a lite username/)
    expect(() => secretSuffix("a.b")).toThrow()
  })
  it("parses E2E_IDENTITIES and refuses an empty or malformed pool", () => {
    expect(parseIdentities('{"a.1":"5Abc","b.2":"5Def"}')).toEqual({ "a.1": "5Abc", "b.2": "5Def" })
    expect(() => parseIdentities(undefined)).toThrow(/E2E_IDENTITIES is empty/)
    expect(() => parseIdentities("{")).toThrow(/not valid JSON/)
    expect(() => parseIdentities("[]")).toThrow(/non-empty JSON object/)
    expect(() => parseIdentities('{"a.1":""}')).toThrow(/account of a\.1/)
    expect(() => parseIdentities('{"nodot":"5A"}')).toThrow(/not a lite username/)
  })
})
