// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { checkBuild, type CheckBuildDeps } from "./stale-build"

const DOC = {
  "dim2.paseo": { version: "aaa", time: 1000 },
  "dim2next.paseo": { version: "bbb", time: 2000 },
  updated: "2026-10-03T00:00:00Z",
}
const URL = "https://gist.githubusercontent.com/o/id/raw/dim2-version.json"

function deps(over: Partial<CheckBuildDeps> = {}): CheckBuildDeps {
  return {
    url: URL,
    product: "dim2.paseo",
    version: "aaa",
    time: 1000,
    grant: async () => true,
    fetchText: async () => JSON.stringify(DOC),
    timeoutMs: 50,
    now: () => 1,
    ...over,
  }
}

const verdict = (doc: unknown, version: string, time: number | undefined, product = "dim2.paseo") =>
  checkBuild(deps({ version, time, product, fetchText: async () => JSON.stringify(doc) }))

describe("the comparison: the release's time is the order", () => {
  it("a build OLDER than the release is stale", async () => {
    expect(await verdict(DOC, "old", 999)).toBe("stale")
  })
  it("a build the same age as the release is current", async () => {
    expect(await verdict(DOC, "other", 1000)).toBe("current")
  })
  it("a build NEWER than the release is current (a failed gist write, the window after a deploy)", async () => {
    expect(await verdict(DOC, "newer", 1001)).toBe("current")
  })
  it("a build whose version is ANY entry is current, whatever its time", async () => {
    expect(await verdict(DOC, "bbb", 5)).toBe("current")
  })
  it("is unknown when either time is missing or unparsable", async () => {
    expect(await verdict(DOC, "old", undefined)).toBe("unknown")
    expect(await verdict(DOC, "old", Number.NaN)).toBe("unknown")
    expect(await verdict({ "dim2.paseo": { version: "aaa" } }, "old", 5)).toBe("unknown")
    expect(await verdict({ "dim2.paseo": { version: "aaa", time: "soon" } }, "old", 5)).toBe("unknown")
  })
  it("is unknown for the old string format, with no release entry, on a dev build, or on junk", async () => {
    expect(await verdict({ "dim2.paseo": "aaa" }, "old", 5)).toBe("unknown")
    expect(await verdict({ "dim2.paseo": "aaa" }, "aaa", 5)).toBe("unknown")
    expect(await verdict({ "dim2next.paseo": { version: "bbb", time: 2000 } }, "old", 5)).toBe("unknown")
    expect(await verdict(DOC, "dev", 5)).toBe("unknown")
    expect(await verdict(DOC, "", 5)).toBe("unknown")
    expect(await verdict(null, "old", 5)).toBe("unknown")
    expect(await verdict([1], "old", 5)).toBe("unknown")
  })
})

describe("checkBuild fails open", () => {
  it("an empty url turns the gate off without asking or fetching", async () => {
    const grant = vi.fn(async () => true)
    const fetchText = vi.fn(async () => "{}")
    expect(await checkBuild(deps({ url: "", grant, fetchText, version: "old" }))).toBe("unknown")
    expect(grant).not.toHaveBeenCalled()
    expect(fetchText).not.toHaveBeenCalled()
  })
  it("a refused grant allows, never fetches, and says it was DENIED (not worth a retry loop)", async () => {
    const fetchText = vi.fn(async () => JSON.stringify(DOC))
    expect(await checkBuild(deps({ version: "old", grant: async () => false, fetchText }))).toBe("denied")
    expect(fetchText).not.toHaveBeenCalled()
  })
  it("a grant that throws allows", async () => {
    expect(await checkBuild(deps({ version: "old", grant: async () => { throw new Error("x") } }))).toBe("denied")
  })
  it("a fetch error allows", async () => {
    expect(await checkBuild(deps({ version: "old", fetchText: async () => { throw new Error("offline") } }))).toBe("unknown")
  })
  it("a fetch that never answers times out, is aborted, and allows", async () => {
    let seen: AbortSignal | undefined
    const never = (_u: string, signal: AbortSignal) => {
      seen = signal
      return new Promise<string>(() => {})
    }
    expect(await checkBuild(deps({ version: "old", timeoutMs: 20, fetchText: never }))).toBe("unknown")
    expect(seen?.aborted).toBe(true)
  })
  it("a page that leaves aborts the fetch", async () => {
    const page = new AbortController()
    let seen: AbortSignal | undefined
    const pending = checkBuild(deps({ version: "old", signal: page.signal, timeoutMs: 1000, fetchText: (_u, s) => ((seen = s), new Promise<string>(() => {})) }))
    await new Promise((r) => setTimeout(r, 5))
    page.abort()
    expect(seen?.aborted).toBe(true)
    void pending
  })
  it("a body that is not JSON, or lacks the key, allows", async () => {
    expect(await checkBuild(deps({ version: "old", fetchText: async () => "<html>" }))).toBe("unknown")
    expect(await checkBuild(deps({ version: "old", fetchText: async () => "{}" }))).toBe("unknown")
  })
})

describe("the cache-busting query", () => {
  it("is one value per minute, not per request", async () => {
    const seen: string[] = []
    const fetchText = async (u: string) => (seen.push(u), JSON.stringify(DOC))
    await checkBuild(deps({ now: () => 120_000, fetchText }))
    await checkBuild(deps({ now: () => 179_999, fetchText }))
    await checkBuild(deps({ now: () => 180_000, fetchText }))
    expect(seen).toEqual([`${URL}?t=2`, `${URL}?t=2`, `${URL}?t=3`])
  })
  it("joins an existing query with &", async () => {
    const seen: string[] = []
    await checkBuild(deps({ url: "https://x/y?a=1", now: () => 60_000, fetchText: async (u) => (seen.push(u), JSON.stringify(DOC)) }))
    expect(seen[0]).toBe("https://x/y?a=1&t=1")
  })
})
