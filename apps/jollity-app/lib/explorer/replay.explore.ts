// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// quiescence first: it traps the real timers before anything else loads
import "./mesh/quiescence"
import { mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import type { ExploreArgs } from "./core/cli"
import { emitTest, readWitness, replayWitness } from "./core/witness"

/** `npm run explore -- --replay <file>`: re-runs one witness and writes the
 * result to <out>/replay.json for scripts/explore.mts to map to an exit code. */
const rootDir = resolve(import.meta.dirname, "../../../..")
const raw = process.env.EXPLORE_ARGS
const args = raw === undefined ? undefined : (JSON.parse(raw) as ExploreArgs)

if (args?.replay === undefined) {
  describe.skip("explorer replay", () => {
    it("requires EXPLORE_ARGS with --replay", () => undefined)
  })
} else {
  describe("explorer replay", () => {
    it(`replays ${args.replay}`, async () => {
      const file = isAbsolute(args.replay!) ? args.replay! : resolve(rootDir, args.replay!)
      const witness = await readWitness(file)
      const result = await replayWitness(witness)
      const out = isAbsolute(args.out) ? args.out : resolve(rootDir, args.out)
      await mkdir(out, { recursive: true })
      const emitted = args.emitTest
        ? emitTest(witness, `${witness.violation.property.toLowerCase()}-${witness.labels.length}`)
        : undefined
      await writeFile(resolve(out, "replay.json"), `${JSON.stringify({ ...result, emitted })}\n`)
      expect(["reproduced", "not-reproduced", "out-of-date"]).toContain(result.status)
    })
  })
}
