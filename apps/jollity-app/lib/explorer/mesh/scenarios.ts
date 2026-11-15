// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The explorer's named scenarios. Every scenario
 * starts the same two phones (room.ts: a, then b `phaseOffsetMs` later, each
 * given `setRound(1)` and then the roster through `setPeers`, as useMesh
 * does); a scenario adds what the search may do
 * on top:
 * - `env`: the environment labels it enables, plus `wire:*:capture` for the
 *   transport's read-then-deliver copy; every scenario lists
 *   the network change on both sides (`NETWORK`);
 * - `rejections`: the (op, DOMException class) pairs a `pc:…:reject:<Class>`
 *   fault may use;
 * - `setup`: run after the start, before the first step. Both slice-1
 *   scenarios start from the bare start, so theirs does nothing; slice 2's
 *   scenarios (a connected pair, a lane offer) put their prefix here.
 * - `defaults`: F and H when the options give none (F = 2 and H = 120 s for
 *   the slice-1 scenarios), and the depth `npm run explore` searches when no
 *   `--depth` is given: the depth this scenario's tree closes at within the
 *   default 30-minute budget on a 16-core server (README "Default bounds").
 * - `from`: a mesh anchor (mesh/anchors.ts) whose committed warmup every
 *   schedule replays first, under this scenario, before the search's labels
 *   (run.explore.ts meshScenario). The bounds count labels past it.
 */
import type { Label } from "../core/labels"
import type { Room, ScenarioName } from "./room"

export interface Scenario {
  setup(room: Room): Promise<void>
  env: Label[]
  rejections: [op: string, cls: string][]
  defaults: { faults: number; horizonMs: number; depth: number }
  from?: "steady"
}

/** the env entry that turns on `wire:<from>><to>:<id>:capture` */
export const CAPTURE = "wire:*:capture"

/** a network change on either phone (room.ts env:network): every scenario may take one, as F allows */
const NETWORK: Label[] = ["env:network:a", "env:network:b"]

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  /** #1385's shape: b reloads while a's offer is
   *  stored, its new transport reads that offer, and a's fresh offer follows */
  "rejoin-two-offers": {
    async setup() {},
    env: ["env:reload:b", CAPTURE, ...NETWORK],
    rejections: [["srd", "InvalidAccessError"]],
    defaults: { faults: 2, horizonMs: 120_000, depth: 8 },
  },
  /** one offer and its answer, with b's transport refusing one signal (#1374) */
  "single-offer": {
    async setup() {},
    env: ["env:signal-throws:b", ...NETWORK],
    rejections: [],
    defaults: { faults: 2, horizonMs: 120_000, depth: 10 },
  },
  /** a connected pair loses its link (#1522, #1523, #1529, #689): from the
   *  steady anchor, either side's PC may go disconnected or failed (env:ice,
   *  a fault, once per side, only at a quiet point). A down pair carries no
   *  video frames and no lane frames, and comes back only through an ICE
   *  restart (its ufrag moves on) or a rebuild (new PCs) */
  outage: {
    async setup() {},
    env: ["env:ice:a:disconnected", "env:ice:a:failed", "env:ice:b:disconnected", "env:ice:b:failed", ...NETWORK],
    rejections: [],
    defaults: { faults: 2, horizonMs: 120_000, depth: 8 },
    from: "steady",
  },
}

/** An ad-hoc scenario: the base's start, env, rejections and defaults, plus
 *  the extra env labels and (op, class) rejections given, with F set when
 *  given. A fresh object: SCENARIOS itself is never changed, so a probe that
 *  needs a fault its base does not list (the confirm pipeline,
 *  room/to-mesh.ts) passes this as exploreRoom's `custom`. */
export function scenarioFrom(base: ScenarioName, extra: { env?: readonly Label[]; rejections?: readonly [op: string, cls: string][]; faults?: number } = {}): Scenario {
  const from = SCENARIOS[base]
  const rejections = [...from.rejections]
  for (const [op, cls] of extra.rejections ?? []) if (!rejections.some(([o, c]) => o === op && c === cls)) rejections.push([op, cls])
  return {
    ...from,
    env: [...new Set([...from.env, ...(extra.env ?? [])])],
    rejections,
    defaults: { ...from.defaults, faults: extra.faults ?? from.defaults.faults },
  }
}
