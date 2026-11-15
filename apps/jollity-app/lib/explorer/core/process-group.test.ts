// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawn } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { groupAlive, terminateGroup } from "./process-group"

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

describe("process groups", () => {
  it("waits for a shard that closes a depth during shutdown, so nothing is appended after", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explorer-group-"))
    const file = join(dir, "progress.jsonl")
    const ready = join(dir, "ready")
    writeFileSync(file, "")
    // the wrapper (like npx) ends on SIGTERM at once; its grandchild (like a vitest worker) closes one more depth, slowly, then exits
    const worker = `process.on("SIGTERM",()=>setTimeout(()=>{require("fs").appendFileSync(${JSON.stringify(file)},"depth5\\n");process.exit(0)},400));require("fs").writeFileSync(${JSON.stringify(ready)},"");setInterval(()=>{},1000)`
    const wrapper = `const {spawn}=require("child_process");spawn(process.execPath,["-e",${JSON.stringify(worker)}],{stdio:"inherit"});process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)`
    const child = spawn(process.execPath, ["-e", wrapper], { detached: true, stdio: "inherit" })
    const exited = new Promise<void>((done) => child.on("exit", () => done()))
    for (let i = 0; i < 100 && !(await fileExists(ready)); i += 1) await sleep(50)
    appendFileSync(file, "depth4\n")
    await terminateGroup(child.pid!, "SIGTERM", { timeoutMs: 5000, pollMs: 20 })
    await exited
    expect(groupAlive(child.pid!)).toBe(false)
    const atRebuild = readFileSync(file, "utf8")
    expect(atRebuild).toBe("depth4\ndepth5\n")
    await sleep(600)
    expect(readFileSync(file, "utf8")).toBe(atRebuild)
  }, 20_000)

  it("kills a group that ignores the signal after the timeout", async () => {
    const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { detached: true, stdio: "ignore" })
    await sleep(300)
    await terminateGroup(child.pid!, "SIGTERM", { timeoutMs: 300, pollMs: 20 })
    expect(groupAlive(child.pid!)).toBe(false)
  }, 20_000)
})

async function fileExists(path: string): Promise<boolean> {
  try { readFileSync(path); return true } catch { return false }
}
