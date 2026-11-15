// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The room-map command line for the shared tiled engine (tiled.ts), on demand only. Mesh-pair uses
 * the same journals, disk-backed frontiers, state-hash tile ownership and recovery through
 * scripts/explore.mts; it is not a second traversal. From apps/jollity-app:
 *
 *   npx tsx lib/explorer/room/tiled-main.ts --run reload --depth 5 --out /path/to/run \
 *     --workers 4 --tiles 1024
 *
 * Re-running the same command on the same --out resumes from the files. Other flags: --faults (1),
 * --inclusion-every (100), --probe-every (1000), --tiles (1024 for a new run; a resumed run keeps its own), --pair-shards (64 for a new run; a resumed run keeps its own), --keep-inboxes, --phones (3), --reloaded (the
 * phone whose reload is the injected moment, 1), --horizon-s (a time horizon in seconds of room time past the
 * anchor: none). The beat label is the default (ROOM_BEAT=1); ROOM_BEAT=0 keeps free hello reads for a
 * deliberate comparison, and --beat explicitly selects the default. Each finished
 * depth is a line of <out>/progress.jsonl; <out>/summary.json holds the whole result. The coordinator
 * forks this file again with --worker <k> for each worker process.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { defaultRoomBeat } from "./model"
import { runTiled, workerMain } from "./tiled"
import type { RoomRun } from "./checks"

const argv = process.argv.slice(2)
// before any room is made: the forked workers inherit it
if (argv.includes("--beat")) process.env.ROOM_BEAT = "1"
if (!argv.includes("--worker")) defaultRoomBeat()
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const number = (name: string, fallback: number) => (flag(name) !== undefined ? Number(flag(name)) : fallback)

if (argv.includes("--worker")) {
  workerMain(argv)
} else {
  const out = flag("--out")
  const run = flag("--run") as RoomRun | undefined
  if (!out || (run !== "reload" && run !== "network-all")) {
    console.error("usage: tiled-main.ts --run reload|network-all --depth D --out DIR [--workers N] [--tiles T]")
    process.exit(2)
  }
  const started = new Date().toISOString()
  runTiled({
    out,
    run,
    depth: number("--depth", 4),
    faults: number("--faults", 1),
    phones: number("--phones", 3),
    reloaded: number("--reloaded", 1),
    horizonMs: flag("--horizon-s") !== undefined ? Number(flag("--horizon-s")) * 1000 : undefined,
    tiles: flag("--tiles") !== undefined ? Number(flag("--tiles")) : undefined,
    pairShards: flag("--pair-shards") !== undefined ? Number(flag("--pair-shards")) : undefined,
    inclusionEvery: number("--inclusion-every", 100),
    probeEvery: number("--probe-every", 1000),
    workers: number("--workers", 2),
    workerEntry: import.meta.filename,
    keepInboxes: argv.includes("--keep-inboxes"),
    onLayer: (layer) => console.log(`tiled ${JSON.stringify(layer)}`),
  })
    .then((result) => {
      const summary = { started, finished: new Date().toISOString(), ...result, findings: result.counts.findings.map((finding) => ({ ...finding, labels: [...result.anchorLabels, ...finding.labels] })) }
      writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2))
      console.log(`tiled summary: states=${result.states} depth=${result.depthCompleted} edgeReached=${result.edgeReached} distinctPairs=${result.distinctPairs} findings=${JSON.stringify(result.counts.findingCounts)} probes=${JSON.stringify(result.counts.probes)} inclusion=${result.counts.inclusion.checked}/${result.counts.inclusion.mismatches} gaps=${result.counts.gaps.count}`)
      process.exit(0)
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exit(1)
    })
}
