// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The slice-1 room run, on demand only. Skipped unless
 * ROOM_RUN is set. From apps/jollity-app:
 *
 *   ROOM_RUN=reload ROOM_DEPTH=4 ROOM_MAX_STATES=30000000 ROOM_OUT=/tmp/room-d4 \
 *   NODE_OPTIONS=--max-old-space-size=6144 \
 *   npx vitest run --config vitest.explore.config.ts lib/explorer/room/room.explore.ts
 *
 * ROOM_RUN is `reload` (steady-3, then p2's reload), `network-all`, `steady` (no
 * moment) or `frozen` (the ROOM_FROZEN=<phone> phone hides and freezes; model.ts).
 * ROOM_PHONES sets the room's size (default 3). ROOM_FROZEN_HIDE=hide-quiet anchors the
 * frozen run on the hide whose away frames are lost. ROOM_POR is refused with ROOM_FROZEN.
 * The heartbeat model is on by default (ROOM_BEAT=1); set ROOM_BEAT=0 only for a free-hello comparison.
 * (steady-3, then a network change on every phone at one instant). Other
 * knobs: ROOM_FAULTS (F past the anchor, default 1), ROOM_HEAP_STOP_MB
 * (default 7000), ROOM_INCLUSION_EVERY (default 100), ROOM_PROBE_EVERY
 * (default 1000), ROOM_POR=1 (partial-order reduction, por.ts; ROOM_POR_CHECK=N checks the
 * independence relation on 1 state in N), ROOM_SAMPLING (`order`, the default, or `key`: samples
 * picked by state id, as the tiled map picks them). One line per finished layer is appended to
 * <out>/layers.jsonl as it lands, so a killed run still leaves its numbers;
 * <out>/summary.json holds the whole result.
 *
 * After the search, each finding is confirmed on real Mesh (to-mesh.ts):
 * summary.json gives every finding a `confirm` verdict
 * (confirmed:mesh-pair, refuted, not-confirmable, abstract-3, unconfirmed)
 * and the run its `confirmCounts`. ROOM_CONFIRM=0 skips it.
 */
// quiescence first: it traps the real timers before anything else loads (the confirmations drive Mesh)
import "../mesh/quiescence"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { roomBfs } from "./bfs"
import { roomAnchor, type RoomRun } from "./checks"
import { porCheckFromEnv, porFromEnv } from "./por"
import { CAUSED, defaultRoomBeat, DROPPED, frozenFromEnv, HALF_LOCAL, UNSAFE_LOCAL } from "./model"
import { confirmFindings } from "./to-mesh"

const run = process.env.ROOM_RUN as RoomRun | undefined
if (run) defaultRoomBeat()
const number = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback)

const phones = number("ROOM_PHONES", 3)

describe.skipIf(!run)("the abstract room", () => {
  it(`searches from steady-3 + ${run}`, async () => {
    const depth = number("ROOM_DEPTH", 4)
    const faults = number("ROOM_FAULTS", 1)
    const out = process.env.ROOM_OUT ?? `test-results/explorer/room-${run}-d${depth}`
    mkdirSync(out, { recursive: true })
    if (porFromEnv() && frozenFromEnv().length > 0) throw new Error("ROOM_POR is not proven for the frozen page clock (por.ts takes vis labels as global, but its enabling sets do not know the freeze): run ROOM_FROZEN without it")
    const anchor = roomAnchor(phones, run!, faults)
    const started = new Date().toISOString()
    const result = roomBfs(anchor.room, {
      depth,
      maxStates: number("ROOM_MAX_STATES", 30_000_000),
      heapStopMb: number("ROOM_HEAP_STOP_MB", 7000),
      inclusionEvery: number("ROOM_INCLUSION_EVERY", 100),
      probeEvery: number("ROOM_PROBE_EVERY", 1000),
      sampling: process.env.ROOM_SAMPLING === "key" ? "key" : "order",
      rp7: run === "reload" ? { reloaded: 1, faults } : undefined,
      por: porFromEnv(),
      porCheck: porCheckFromEnv(),
      onLayer: (layer) => {
        const line = JSON.stringify({ run, ...layer, rssMb: Math.round(process.memoryUsage().rss / 2 ** 20) })
        appendFileSync(`${out}/layers.jsonl`, `${line}\n`)
        console.log(`room ${line}`)
      },
    })
    // findings' labels run from the anchor; prefix them so each replays from the start
    const findings = result.findings.map((finding) => ({ ...finding, labels: [...anchor.labels, ...finding.labels] }))
    const confirmed = process.env.ROOM_CONFIRM === "0" ? null : await confirmFindings(findings, phones)
    const summary = {
      run,
      started,
      bounds: { depth, faults, phones, frozen: frozenFromEnv() },
      anchor: { labels: anchor.labels.length, moment: anchor.labels.slice(-1) },
      labels: { halfLocal: HALF_LOCAL.length, unsafeLocal: UNSAFE_LOCAL, caused: Object.keys(CAUSED), dropped: DROPPED },
      ...result,
      findings: findings.map((finding, index) => ({ ...finding, ...(confirmed ? { confirm: confirmed.confirmations[index] } : {}) })),
      ...(confirmed ? { confirmCounts: confirmed.counts } : {}),
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2))
    console.log(`room summary: states=${result.states} depth=${result.depthCompleted} capped=${result.capped} heapStopped=${result.heapStopped} distinctPairs=${result.distinctPairs} findings=${JSON.stringify(result.findingCounts)} gaps=${result.gaps.count} inclusionMismatches=${result.inclusion.mismatches} confirm=${JSON.stringify(confirmed?.counts ?? null)} elapsedMs=${result.elapsedMs}`)
    expect(result.states).toBeGreaterThan(0)
  })
})
