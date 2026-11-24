// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { annotation, checkName, expectedGrants, grantDiff, grantProblems, grantsFromRead, judgeGrants, normalize, overall } from "./check-grants.mjs"

const VARIABLE = '{"back-me-up":["context"],"dim2":["context","storage"],"dim2next":["context","storage"]}'
const want = expectedGrants(VARIABLE)

/** What `dotns text view <name> manifest --json` prints for a manifest holding these grants. */
const cliAnswer = (trustedProducts?: unknown) =>
  JSON.stringify({
    domain: "peopl.paseo",
    key: "manifest",
    exists: true,
    owner: "0xdFE298F9f934d2Ae078583467f1649379779E33e",
    value: JSON.stringify({ $v: 1, displayName: "Humanity", ...(trustedProducts === undefined ? {} : { trustedProducts }) }),
  })

describe("normalize", () => {
  it("sorts the keys and each list, and drops repeats, as jq -S 'map_values(unique)' does", () => {
    expect(JSON.stringify(normalize({ dim2: ["storage", "context", "storage"], back: ["context"] }))).toBe(
      '{"back":["context"],"dim2":["context","storage"]}',
    )
  })
})

describe("expectedGrants", () => {
  it("reads HUMANITY_TRUSTED_PRODUCTS", () => {
    expect(want).toEqual({ "back-me-up": ["context"], dim2: ["context", "storage"], dim2next: ["context", "storage"] })
  })

  it("refuses a value release.yml would refuse", () => {
    expect(() => expectedGrants(undefined)).toThrow(/not set/)
    expect(() => expectedGrants(" ")).toThrow(/not set/)
    expect(() => expectedGrants("nope")).toThrow(/not valid JSON/)
    expect(() => expectedGrants('["dim2"]')).toThrow(/not an object/)
    expect(() => expectedGrants('{"dim2":"context"}')).toThrow(/not an object/)
  })
})

describe("grantProblems", () => {
  const problems = (trustedProducts: unknown, floorLabel = "dim2", expected = want) =>
    grantProblems({ manifest: JSON.parse(cliAnswer(trustedProducts)).value, want: expected, floorLabel })

  it("passes grants equal to the variable in any order, repeats included", () => {
    expect(problems({ dim2next: ["storage", "context"], dim2: ["storage", "context", "context"], "back-me-up": ["context"] })).toEqual([])
  })

  it("names a grant that differs from the variable", () => {
    expect(problems({ "back-me-up": ["context"], dim2: ["context", "storage"] })).toEqual([
      `it grants {"back-me-up":["context"],"dim2":["context","storage"]} but HUMANITY_TRUSTED_PRODUCTS is ${JSON.stringify(want)}`,
    ])
  })

  it("fails when Jollity's label lacks context or storage, even if the variable agrees", () => {
    const dropped = expectedGrants('{"dim2":["context"]}')
    expect(problems({ dim2: ["context"] }, "dim2", dropped)).toEqual(["dim2 lacks storage, which Jollity needs"])
    expect(problems({}, "dim2", expectedGrants("{}"))).toEqual(["dim2 lacks context and storage, which Jollity needs"])
  })

  it("follows the Jollity label it is given", () => {
    expect(problems({ ...want }, "otherjollity", want)).toEqual(["otherjollity lacks context and storage, which Jollity needs"])
  })

  it("reports a manifest that grants nothing as wrong", () => {
    expect(grantProblems({ manifest: null, want, floorLabel: "dim2" })).toEqual(["it has no manifest, so it grants nothing"])
    expect(problems(undefined)).toEqual(["its manifest has no trustedProducts, so it grants nothing"])
    expect(grantProblems({ manifest: "{not json", want, floorLabel: "dim2" })).toEqual([
      "its manifest is not JSON, so a host reads no grants from it",
    ])
    expect(problems(["dim2"])[0]).toMatch(/not an object of label to grant list/)
  })
})

describe("grantDiff and judgeGrants", () => {
  it("lists, per product, the grants missing and extra, and leaves matching products out", () => {
    expect(grantDiff(normalize({ "back-me-up": ["context", "storage"], dim2: ["context"], x: ["context"] }), want)).toEqual([
      { label: "back-me-up", missing: [], extra: ["storage"] },
      { label: "dim2", missing: ["storage"], extra: [] },
      { label: "dim2next", missing: ["context", "storage"], extra: [] },
      { label: "x", missing: [], extra: ["context"] },
    ])
    expect(grantDiff(want, want)).toEqual([])
  })

  it("returns the grants found, the difference and Jollity's floor with the problems", () => {
    const manifest = JSON.parse(cliAnswer({ ...want, dim2: ["context"] })).value
    expect(judgeGrants({ manifest, want, floorLabel: "dim2" })).toEqual({
      problems: [expect.stringMatching(/^it grants /), "dim2 lacks storage, which Jollity needs"],
      found: { "back-me-up": ["context"], dim2: ["context"], dim2next: ["context", "storage"] },
      products: [{ label: "dim2", missing: ["storage"], extra: [] }],
      floor: { label: "dim2", lacking: ["storage"] },
    })
    expect(judgeGrants({ manifest: JSON.parse(cliAnswer(want)).value, want, floorLabel: "dim2" })).toMatchObject({ problems: [], products: [], floor: null })
  })

  it("finds no grants, and every expected one missing, when the manifest grants nothing", () => {
    expect(judgeGrants({ manifest: null, want, floorLabel: "dim2" })).toEqual({
      problems: ["it has no manifest, so it grants nothing"],
      found: null,
      products: grantDiff({}, want),
      floor: { label: "dim2", lacking: ["context", "storage"] },
    })
  })
})

describe("grantsFromRead", () => {
  it("returns the manifest, or null when the name or the record does not exist", () => {
    expect(grantsFromRead(cliAnswer({}))).toEqual({ manifest: '{"$v":1,"displayName":"Humanity","trustedProducts":{}}' })
    expect(grantsFromRead('{"domain":"x.paseo","key":"manifest","exists":false,"owner":null,"value":null}')).toBeNull()
    expect(grantsFromRead('{"domain":"x.paseo","key":"manifest","exists":true,"owner":"0x1","value":null}')).toBeNull()
  })

  it("throws when the CLI did not answer with its JSON, since that is a failed read", () => {
    expect(() => grantsFromRead("")).toThrow(/no JSON/)
    expect(() => grantsFromRead("Error: connection refused")).toThrow(/no JSON/)
    expect(() => grantsFromRead('{"value":"x"}')).toThrow(/no exists field/)
  })
})

describe("checkName", () => {
  const base = { name: "peopl.paseo", want, floorLabel: "dim2", attempts: 3, delayMs: 0 }

  it("is ok when the grants match", async () => {
    const result = await checkName({ ...base, read: async () => cliAnswer(want) })
    expect(result.outcome).toBe("ok")
  })

  it("is wrong when the read works and the grants are missing", async () => {
    const result = await checkName({ ...base, read: async () => cliAnswer({}) })
    expect(result).toMatchObject({ outcome: "wrong" })
    expect(result.detail).toMatch(/dim2 lacks context and storage/)
  })

  it("carries the grants expected and found, and what differs per product, when wrong", async () => {
    const result = await checkName({ ...base, read: async () => cliAnswer({ ...want, dim2: ["context"] }) })
    expect(result).toEqual({
      name: "peopl.paseo",
      outcome: "wrong",
      detail: expect.stringContaining("dim2 lacks storage"),
      expected: want,
      found: { ...want, dim2: ["context"] },
      products: [{ label: "dim2", missing: ["storage"], extra: [] }],
      floor: { label: "dim2", lacking: ["storage"] },
    })
  })

  it("is unchecked, never wrong, when every read fails", async () => {
    let reads = 0
    const result = await checkName({
      ...base,
      read: async () => {
        reads++
        throw new Error("no answer within 90 s")
      },
    })
    expect(reads).toBe(3)
    expect(result).toMatchObject({ outcome: "unchecked" })
    expect(result.detail).toBe("attempt 1: no answer within 90 s; attempt 2: no answer within 90 s; attempt 3: no answer within 90 s")
  })

  it("is unchecked when the CLI answers with something other than its JSON", async () => {
    const result = await checkName({ ...base, read: async () => "Warning: RPC unreachable" })
    expect(result.outcome).toBe("unchecked")
  })

  it("with confirmWrongMs, reads wrong grants again and keeps the second answer", async () => {
    const sequence = (...answers: Array<() => Promise<string>>) => {
      let reads = 0
      return { read: () => answers[reads++]!(), reads: () => reads }
    }
    const right = () => Promise.resolve(cliAnswer(want))
    const empty = () => Promise.resolve(cliAnswer({}))
    const down = () => Promise.reject(new Error("socket closed"))

    const stale = sequence(empty, right)
    expect((await checkName({ ...base, read: stale.read, confirmWrongMs: 0 })).outcome).toBe("ok")
    expect(stale.reads()).toBe(2)

    const still = sequence(empty, empty)
    expect((await checkName({ ...base, read: still.read, confirmWrongMs: 0 })).outcome).toBe("wrong")

    const lost = sequence(empty, down, down, down)
    const result = await checkName({ ...base, read: lost.read, confirmWrongMs: 0 })
    expect(result.outcome).toBe("unchecked")
    expect(result.detail).toMatch(/^a first read found wrong grants \(.*dim2 lacks context and storage.*\), and the read 0 s later to confirm it failed: attempt 1: socket closed/)

    const fine = sequence(right)
    expect((await checkName({ ...base, read: fine.read, confirmWrongMs: 0 })).outcome).toBe("ok")
    expect(fine.reads()).toBe(1)
  })

  it("retries a failed read and judges the one that works", async () => {
    const answers = [() => Promise.reject(new Error("socket closed")), () => Promise.resolve(cliAnswer({ dim2: ["context"] }))]
    const result = await checkName({ ...base, read: () => answers.shift()!() })
    expect(result.outcome).toBe("wrong")
  })
})

describe("overall and annotation", () => {
  const ok = { name: "a", outcome: "ok", detail: "" }
  const wrong = { name: "b", outcome: "wrong", detail: "" }
  const unchecked = { name: "c", outcome: "unchecked", detail: "" }

  it("puts a known break before an unknown", () => {
    expect(overall([ok, ok])).toBe("ok")
    expect(overall([ok, unchecked])).toBe("unchecked")
    expect(overall([unchecked, wrong, ok])).toBe("wrong")
  })

  it("gives each outcome its own title, and escapes line breaks", () => {
    expect(annotation({ name: "peopl.paseo", outcome: "wrong", detail: "x" })).toMatch(/^::error title=Grants wrong on peopl\.paseo::x\. /)
    expect(annotation({ name: "peopl.paseo", outcome: "unchecked", detail: "a\nb 100%" })).toMatch(
      /^::error title=Could not check the grants of peopl\.paseo::.*unknown, not missing \(a%0Ab 100%25\)/,
    )
    expect(annotation({ name: "peopl.paseo", outcome: "ok", detail: "fine" })).toBe("::notice title=Grants right on peopl.paseo::fine.")
  })
})

describe("check-grants.mjs, run with a stand-in dotns CLI", { timeout: 30_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "check-grants-"))
  const answers = join(dir, "answers.json")
  const reads = join(dir, "reads.json")
  // Prints the answer for its <name> argument, or the next of a list of them
  // on each call; "hang" never exits, "fail" exits 1. Counts its calls.
  const bin = join(dir, "dotns")
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs")
const name = process.argv[4]
if (process.env.DOTNS_MNEMONIC) { console.log("a key reached the CLI"); process.exit(3) }
const count = fs.existsSync(${JSON.stringify(reads)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(reads)}, "utf8")) : {}
count[name] = (count[name] ?? 0) + 1
fs.writeFileSync(${JSON.stringify(reads)}, JSON.stringify(count))
const given = JSON.parse(fs.readFileSync(${JSON.stringify(answers)}, "utf8"))[name]
const answer = Array.isArray(given) ? given[Math.min(count[name], given.length) - 1] : given
if (answer === "hang") setInterval(() => {}, 1000)
else if (answer === "fail") { console.error("Error: RPC unreachable"); process.exit(1) }
else console.log(answer)
`,
  )
  chmodSync(bin, 0o755)

  function run(byName: Record<string, string | string[]>, flags: string[] = [], timeoutSeconds = "15", args?: string[]) {
    writeFileSync(answers, JSON.stringify(byName))
    writeFileSync(reads, "{}")
    const output = join(dir, `output-${Math.random()}`)
    writeFileSync(output, "")
    const resultsFile = join(dir, `results-${Math.random()}.json`)
    const r = spawnSync(process.execPath, [join(__dirname, "check-grants.mjs"), ...(args ?? ["--env", "paseo-v2", "--results", resultsFile, ...flags, ...Object.keys(byName)])], {
      env: {
        PATH: process.env.PATH ?? "",
        DOTNS_BIN: bin,
        DOTNS_MNEMONIC: "must not reach the CLI",
        HUMANITY_TRUSTED_PRODUCTS: VARIABLE,
        JOLLITY_DOTNS_DOMAIN: "dim2",
        GRANTS_READ_ATTEMPTS: "2",
        GRANTS_READ_TIMEOUT_SECONDS: timeoutSeconds,
        GRANTS_READ_DELAY_SECONDS: "0",
        GRANTS_CONFIRM_DELAY_SECONDS: "0",
        GITHUB_OUTPUT: output,
      },
      encoding: "utf8",
    })
    const count = JSON.parse(readFileSync(reads, "utf8")) as Record<string, number>
    const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : undefined
    return { status: r.status, stdout: r.stdout, output: readFileSync(output, "utf8"), reads: count, results }
  }

  it("exits 0 when both names grant what the variable says", () => {
    const r = run({ "peopl.paseo": cliAnswer(want), "peoplnext.paseo": cliAnswer(want) })
    expect(r.status).toBe(0)
    expect(r.output).toBe("outcome=ok\n")
    expect(r.stdout).toContain("::notice title=Grants right on peoplnext.paseo::")
  })

  it("exits 1 when a name's grants are wrong", () => {
    const r = run({ "peopl.paseo": cliAnswer({ "back-me-up": ["context"] }), "peoplnext.paseo": cliAnswer(want) })
    expect(r.status).toBe(1)
    expect(r.output).toBe("outcome=wrong\n")
    expect(r.stdout).toContain("::error title=Grants wrong on peopl.paseo::")
  })

  it("writes every name's result to --results, with what is wrong per product or the read error", () => {
    const r = run({ "peopl.paseo": cliAnswer({ ...want, dim2: ["context"] }), "peoplnext.paseo": "fail", "other.paseo": cliAnswer(want) })
    expect(r.status).toBe(1)
    expect(r.results.outcome).toBe("wrong")
    expect(r.results.results.map((x: { name: string; outcome: string }) => [x.name, x.outcome])).toEqual([
      ["peopl.paseo", "wrong"],
      ["peoplnext.paseo", "unchecked"],
      ["other.paseo", "ok"],
    ])
    expect(r.results.results[0]).toMatchObject({ expected: want, products: [{ label: "dim2", missing: ["storage"], extra: [] }] })
    expect(r.results.results[1].detail).toBe("attempt 1: dotns exited 1: Error: RPC unreachable; attempt 2: dotns exited 1: Error: RPC unreachable".replaceAll("dotns", bin))
  })

  it("exits 2, and says nothing of missing grants, when the read hangs or fails", () => {
    const r = run({ "peopl.paseo": "hang", "peoplnext.paseo": "fail" }, [], "2")
    expect(r.status).toBe(2)
    expect(r.output).toBe("outcome=unchecked\n")
    expect(r.stdout).toContain("::error title=Could not check the grants of peopl.paseo::")
    expect(r.stdout).toContain("no answer within 2 s")
    expect(r.stdout).toContain("::error title=Could not check the grants of peoplnext.paseo::")
    expect(r.stdout).toContain("RPC unreachable")
    expect(r.stdout).not.toContain("Grants wrong")
  })

  it("reports wrong grants first when one name is wrong and another unchecked", () => {
    const r = run({ "peopl.paseo": "fail", "peoplnext.paseo": cliAnswer({}) })
    expect(r.status).toBe(1)
    expect(r.output).toBe("outcome=wrong\n")
  })

  it("with --unchecked-warns, passes a failed read with a warning but still fails wrong grants", () => {
    const failed = run({ "peoplnext.paseo": "fail" }, ["--unchecked-warns"])
    expect(failed.status).toBe(0)
    expect(failed.output).toBe("outcome=unchecked\n")
    expect(failed.stdout).toContain("::warning title=Could not check the grants of peoplnext.paseo::")
    const wrong = run({ "peoplnext.paseo": cliAnswer({}) }, ["--unchecked-warns"])
    expect(wrong.status).toBe(1)
  })

  it("with --confirm-wrong, trusts only the second read of wrong grants", () => {
    const stale = run({ "peoplnext.paseo": [cliAnswer({}), cliAnswer(want)] }, ["--confirm-wrong"])
    expect(stale.status).toBe(0)
    expect(stale.reads).toEqual({ "peoplnext.paseo": 2 })
    expect(stale.stdout).toContain("a read 0 s earlier saw old grants")

    const wrong = run({ "peoplnext.paseo": [cliAnswer({}), cliAnswer({})] }, ["--confirm-wrong"])
    expect(wrong.status).toBe(1)
    expect(wrong.output).toBe("outcome=wrong\n")
    expect(wrong.stdout).toContain("(the same again 0 s later)")

    const lost = run({ "peoplnext.paseo": [cliAnswer({}), "fail"] }, ["--confirm-wrong", "--unchecked-warns"])
    expect(lost.status).toBe(0)
    expect(lost.output).toBe("outcome=unchecked\n")
    expect(lost.stdout).toContain("::warning title=Could not check the grants of peoplnext.paseo::")
    expect(lost.stdout).toContain("a first read found wrong grants")
  })

  it("reads once without --confirm-wrong, and once when the grants are right", () => {
    expect(run({ "peoplnext.paseo": cliAnswer({}) }).reads).toEqual({ "peoplnext.paseo": 1 })
    expect(run({ "peoplnext.paseo": cliAnswer(want) }, ["--confirm-wrong"]).reads).toEqual({ "peoplnext.paseo": 1 })
  })

  it("reports a crash as could-not-check, never as exit 1", () => {
    const resultsFile = join(dir, "results-crash.json")
    const crashed = run({}, [], "15", ["--results", resultsFile, "peopl.paseo"])
    expect(crashed.status).toBe(2)
    expect(JSON.parse(readFileSync(resultsFile, "utf8"))).toEqual({
      outcome: "unchecked",
      error: expect.stringMatching(/^The checker stopped, so the grants are unknown: usage:/),
      results: [],
    })
    expect(crashed.output).toBe("outcome=unchecked\n")
    expect(crashed.stdout).toContain("::error title=Could not check the grants::The checker stopped, so the grants are unknown: Error: usage:")
    const warned = run({}, [], "15", ["--unchecked-warns", "peopl.paseo"])
    expect(warned.status).toBe(0)
    expect(warned.stdout).toContain("::warning title=Could not check the grants::The checker stopped")
  })

  it("keeps a wrong result when the step summary cannot be written", () => {
    writeFileSync(answers, JSON.stringify({ "peopl.paseo": cliAnswer({}) }))
    const r = spawnSync(process.execPath, [join(__dirname, "check-grants.mjs"), "--env", "paseo-v2", "peopl.paseo"], {
      env: { PATH: process.env.PATH ?? "", DOTNS_BIN: bin, HUMANITY_TRUSTED_PRODUCTS: VARIABLE, JOLLITY_DOTNS_DOMAIN: "dim2", GITHUB_STEP_SUMMARY: dir },
      encoding: "utf8",
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain("::warning title=No grants summary::")
  })

  it("counts a missing variable as unchecked, not wrong", () => {
    writeFileSync(answers, "{}")
    const output = join(dir, "output-missing")
    writeFileSync(output, "")
    const resultsFile = join(dir, "results-missing.json")
    const r = spawnSync(process.execPath, [join(__dirname, "check-grants.mjs"), "--env", "paseo-v2", "--results", resultsFile, "peopl.paseo"], {
      env: { PATH: process.env.PATH ?? "", DOTNS_BIN: bin, JOLLITY_DOTNS_DOMAIN: "dim2", GITHUB_OUTPUT: output },
      encoding: "utf8",
    })
    expect(r.status).toBe(2)
    expect(readFileSync(output, "utf8")).toBe("outcome=unchecked\n")
    expect(JSON.parse(readFileSync(resultsFile, "utf8"))).toEqual({
      outcome: "unchecked",
      error: "HUMANITY_TRUSTED_PRODUCTS is not set. Set the repo variable, then run the check again.",
      results: [],
    })
    expect(r.stdout).toContain("::error title=Could not check the grants::HUMANITY_TRUSTED_PRODUCTS is not set")
  })
})
