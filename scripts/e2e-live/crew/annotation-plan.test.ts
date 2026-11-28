// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

describe("recording annotation discovery", () => {
  it("keeps mixed bot attempts and skips one unreadable selected-results artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "crew-annotation-plan-"))
    const output = join(root, "output")
    writeFileSync(output, "")
    writeFileSync(join(root, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ")
if (args.includes("/attempts/2")) console.log(JSON.stringify({id:42,run_attempt:2,status:"completed",event:"workflow_dispatch",path:".github/workflows/e2e-live-nightly.yml@refs/heads/main"}))
else if (args.includes("/runs/42/artifacts")) console.log(JSON.stringify([{artifacts:[
  {id:1,name:"e2e-live-42-attempt-2-bad-wave-selected-results",expired:false},
  {id:2,name:"e2e-live-42-attempt-2-wave-02-selected-results",expired:false}
]}]))
else if (args.includes("/artifacts/")) process.stdout.write("zip")
else process.exit(1)
`, { mode: 0o755 })
    writeFileSync(join(root, "unzip"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2)
const archive = args[args.indexOf("-q") + 1], destination = args[args.indexOf("-d") + 1]
if (path.basename(archive, ".zip") === "1") process.exit(2)
fs.mkdirSync(path.join(destination, "publication-out"), {recursive:true})
fs.writeFileSync(path.join(destination, "publication-out", "publication-bundle.json"), "{}")
for (const [slot, run] of [
  [1,{id:"42",attempt:1}],
  [2,{id:"42",attempt:2}],
  [3,{attempt:2,superseded:true,skipped:{kind:"restarted-after-probed-game",expected:{index:170,registrationEnds:900},current:null}}],
]) fs.writeFileSync(path.join(destination, "result-" + slot + ".json"), JSON.stringify({slot,run,runner:{group:"shared"}}))
`, { mode: 0o755 })
    const result = spawnSync(process.execPath, ["--import", resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs"), resolve(__dirname, "annotation-plan-cli.mts")], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_REPOSITORY: "paritytech/individuality-apps", SOURCE_RUN_ID: "42", SOURCE_ATTEMPT: "2", GITHUB_OUTPUT: output },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain("Skipping unreadable selected-results artifact")
    const values = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)))
    expect(values.has_results).toBe("true")
    expect(JSON.parse(values.matrix).include).toEqual([{ execution_key: "wave-02", source_attempt: 2, artifact_name: "e2e-live-42-attempt-2-wave-02-selected-results", group: "shared", bots_label: "1-2-3", directory: "wave-02/shared" }])
    expect(JSON.parse(values.publication_matrix).include).toEqual([{ execution_key: "wave-02", source_attempt: 2, artifact_name: "e2e-live-42-attempt-2-wave-02-selected-results" }])
  })

  it("accepts a scheduled Nightly source but not a scheduled direct-game source", () => {
    const root = mkdtempSync(join(tmpdir(), "crew-annotation-schedule-"))
    const output = join(root, "output")
    writeFileSync(output, "")
    const execute = (path: string) => {
      writeFileSync(join(root, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ")
if (args.includes("/attempts/1")) console.log(JSON.stringify({id:42,run_attempt:1,status:"completed",event:"schedule",path:${JSON.stringify(path)}}))
else if (args.includes("/runs/42/artifacts")) console.log(JSON.stringify([{artifacts:[]}]))
else process.exit(1)
`, { mode: 0o755 })
      return spawnSync(process.execPath, ["--import", resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs"), resolve(__dirname, "annotation-plan-cli.mts")], {
        cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_REPOSITORY: "paritytech/individuality-apps", SOURCE_RUN_ID: "42", SOURCE_ATTEMPT: "1", GITHUB_OUTPUT: output },
      })
    }
    expect(execute(".github/workflows/e2e-live-nightly.yml@refs/heads/main").status).toBe(0)
    expect(execute(".github/workflows/e2e-live.yml@refs/heads/main").status).not.toBe(0)
  })

  it.each([
    ["an ordinary result with no run id", { attempt: 2 }],
    ["a result from another workflow run", { id: "41", attempt: 2 }],
    ["a missing-id superseded result from another attempt", { attempt: 1, superseded: true, skipped: { kind: "restarted-after-probed-game" } }],
  ])("rejects %s", (_label, run) => {
    const root = mkdtempSync(join(tmpdir(), "crew-annotation-source-"))
    const output = join(root, "output")
    writeFileSync(output, "")
    writeFileSync(join(root, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ")
if (args.includes("/attempts/2")) console.log(JSON.stringify({id:42,run_attempt:2,status:"completed",event:"workflow_dispatch",path:".github/workflows/e2e-live-nightly.yml@refs/heads/main"}))
else if (args.includes("/runs/42/artifacts")) console.log(JSON.stringify([{artifacts:[{id:2,name:"e2e-live-42-attempt-2-wave-02-selected-results",expired:false}]}]))
else if (args.includes("/artifacts/2/zip")) process.stdout.write("zip")
else process.exit(1)
`, { mode: 0o755 })
    writeFileSync(join(root, "unzip"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2)
const destination = args[args.indexOf("-d") + 1]
fs.mkdirSync(destination, {recursive:true})
fs.writeFileSync(path.join(destination, "result-1.json"), JSON.stringify({slot:1,run:${JSON.stringify(run)},runner:{group:"shared"}}))
`, { mode: 0o755 })
    const result = spawnSync(process.execPath, ["--import", resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs"), resolve(__dirname, "annotation-plan-cli.mts")], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_REPOSITORY: "paritytech/individuality-apps", SOURCE_RUN_ID: "42", SOURCE_ATTEMPT: "2", GITHUB_OUTPUT: output },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("selected result source mismatch")
  })
})
