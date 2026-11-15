// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * T0: the explorer's own plumbing. Its tests stay out of test:lib (checked by
 * running vitest's discovery, not by reading config), its fake clock fires one
 * timer per step and leaves setImmediate real, a reinstalled clock starts both
 * Mesh clocks again, and a mutant only loads behind a module reset.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installFakeClock, realSetImmediate, turn } from "../mesh/quiescence"
import { loadMutant } from "../mutants/load"

const appRoot = fileURLToPath(new URL("../../../", import.meta.url))

describe("explorer config and clock", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps the explorer out of test:lib", () => {
    const out = execFileSync("npx", ["vitest", "list", "--filesOnly", "--config", "vitest.lib.config.ts"], {
      cwd: appRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
      maxBuffer: 64 * 1024 * 1024,
    })
    const lines = out.split("\n").filter((line) => line.trim() !== "")
    expect(lines.length).toBeGreaterThan(100) // discovery ran
    expect(lines.filter((line) => line.includes("lib/explorer/"))).toEqual([])
  }, 300_000)

  it("keeps setImmediate real under the explorer's fake timers", async () => {
    installFakeClock()
    expect(vi.isFakeTimers()).toBe(true)
    let ran = false
    // a faked setImmediate would only run on a clock advance: this resolves on its own
    await new Promise<void>((resolve) => setImmediate(() => { ran = true; resolve() }))
    expect(ran).toBe(true)
    await new Promise<void>((resolve) => realSetImmediate(resolve))
  })

  it("fires one timer per clock.next, with microtasks between", async () => {
    const clock = installFakeClock()
    const fired: string[] = []
    setTimeout(() => {
      fired.push("first")
      queueMicrotask(() => fired.push("first's microtask"))
    }, 100)
    setTimeout(() => fired.push("second"), 100)
    clock.next()
    expect(fired).toEqual(["first"])
    await turn()
    expect(fired).toEqual(["first", "first's microtask"])
    clock.next()
    expect(fired).toEqual(["first", "first's microtask", "second"])
  })

  it("reinstalling the clock resets Date.now and monoNow together", async () => {
    const { monoNow } = await import("../../webrtc/mesh")
    installFakeClock()
    vi.advanceTimersByTime(7000)
    expect(Date.now()).toBe(7000)
    expect(monoNow()).toBe(7001)
    installFakeClock()
    expect(Date.now()).toBe(0)
    expect(monoNow()).toBe(1)
  })

  it("loads a mutant only after a module reset and counts its hunk hits", async () => {
    const target = "lib/explorer/mutants/fixture-target.ts"
    // a sibling left by a crashed run (its process is gone) is removed at load
    const stale = `${appRoot}lib/explorer/mutants/fixture-target.mutant-Mold-2147483646.ts`
    writeFileSync(stale, "export {}\n")
    const before = await import("../mutants/fixture-target")
    expect("planted" in before).toBe(false)
    const mutant = await loadMutant({
      id: "Mfixture",
      target,
      hunks: [{ find: 'return "hello"\n}', replace: 'return "mutated"\n}\nexport const planted = true' }],
    })
    const mutated = await import("../mutants/fixture-target")
    expect((mutated as Record<string, unknown>).planted).toBe(true)
    expect(existsSync(stale)).toBe(false)
    expect(mutant.hits).toEqual([0])
    expect(mutated.greet()).toBe("mutated")
    expect(mutant.hits).toEqual([1])
    await mutant.undo()
    const after = await import("../mutants/fixture-target")
    expect("planted" in after).toBe(false)
    expect(after.greet()).toBe("hello")
    // the sibling copy is gone and the target untouched
    expect(readFileSync(`${appRoot}${target}`, "utf8")).not.toContain("planted")
  })
})
