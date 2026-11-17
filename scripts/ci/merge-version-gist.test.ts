// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mergeVersionDoc, publishVersion } from "./merge-version-gist.mjs"

describe("mergeVersionDoc", () => {
  it("writes its own entry as { version, time } and keeps the other legs' keys", () => {
    const before = JSON.stringify({ "my-game.paseo": { version: "a", time: 1 }, "my-gamenext.paseo": { version: "b", time: 2 }, updated: "old" })
    const doc = JSON.parse(mergeVersionDoc(before, "my-gamenext.paseo", "c", 3, "2026-10-03T00:00:00Z"))
    expect(doc).toEqual({ "my-game.paseo": { version: "a", time: 1 }, "my-gamenext.paseo": { version: "c", time: 3 }, updated: "2026-10-03T00:00:00Z" })
  })
  it("starts from nothing when the file is empty or not JSON", () => {
    expect(JSON.parse(mergeVersionDoc("", "my-game.paseo", "x", 7, "t"))).toEqual({ "my-game.paseo": { version: "x", time: 7 }, updated: "t" })
    expect(JSON.parse(mergeVersionDoc("<<junk", "my-game.paseo", "x", 7, "t"))).toEqual({ "my-game.paseo": { version: "x", time: 7 }, updated: "t" })
  })
})

describe("publishVersion", () => {
  const env = { GIST_ID: "g1", GIST_TOKEN: "tok", GIST_FILE: "my-game-version.json", KEY: "my-game.paseo", VERSION: "v2", TIME: "1700000000" }
  it("reads the gist, merges, and PATCHes the merged file back", async () => {
    const calls: { url: string; method: string; body?: string }[] = []
    const fetchImpl = async (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body })
      if (!init.method || init.method === "GET")
        return { ok: true, json: async () => ({ files: { "my-game-version.json": { content: '{"my-gamenext.paseo":{"version":"n","time":5}}' } } }) }
      return { ok: true, json: async () => ({}) }
    }
    const result = await publishVersion(env, fetchImpl as never, () => "T")
    expect(result).toBe("written")
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"])
    const sent = JSON.parse(JSON.parse(calls[1].body!).files["my-game-version.json"].content)
    expect(sent).toEqual({ "my-gamenext.paseo": { version: "n", time: 5 }, "my-game.paseo": { version: "v2", time: 1700000000 }, updated: "T" })
  })
  it("skips when there is nothing to write", async () => {
    const fetchImpl = async () => { throw new Error("must not be called") }
    expect(await publishVersion({ ...env, GIST_TOKEN: "" }, fetchImpl as never, () => "T")).toBe("skipped")
    expect(await publishVersion({ ...env, GIST_ID: "" }, fetchImpl as never, () => "T")).toBe("skipped")
    expect(await publishVersion({ ...env, GIST_FILE: "" }, fetchImpl as never, () => "T")).toBe("skipped")
    expect(await publishVersion({ ...env, VERSION: "" }, fetchImpl as never, () => "T")).toBe("skipped")
    expect(await publishVersion({ ...env, TIME: "" }, fetchImpl as never, () => "T")).toBe("skipped")
    expect(await publishVersion({ ...env, TIME: "soon" }, fetchImpl as never, () => "T")).toBe("skipped")
  })
  it("never throws: an API failure is reported, not raised", async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) })
    expect(await publishVersion(env, fetchImpl as never, () => "T")).toBe("failed")
    const boom = async () => { throw new Error("net") }
    expect(await publishVersion(env, boom as never, () => "T")).toBe("failed")
  })
  it("the CLI exits 0 with a notice when unconfigured", () => {
    const r = spawnSync("node", ["scripts/ci/merge-version-gist.mjs"], { env: { PATH: process.env.PATH }, encoding: "utf8" })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("::notice")
  })
})
