// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * P1b, session coherence (#1385). One PC never resolves SRDs of
 * offers from two different remote PCs (two `x-pc` values): Mesh's own rule
 * is that a description from another remote connection rebuilds first
 * (mesh.ts onRtc). Oracle: the controlled PCs' op log (controlled-pc.ts).
 */
import { findGap, KNOWN_GAPS, type KnownGap } from "../known-gaps"
import type { Violation } from "../room"
import type { Monitor } from "./wire"

/** P1b with its known gaps (known-gaps.ts): an exact match is reported with its issue, never as a violation */
export const p1bMonitor = (gaps: readonly KnownGap[] = KNOWN_GAPS): Monitor => ({
  id: "P1b",
  // Reads only the per-PC op log in the fingerprint projection.
  closed: true,
  afterStep(room, record) {
    const found: Violation[] = []
    const remotes = new Map<string, string[]>()
    for (const entry of room.logs().ops) {
      // an offer without an identity (none under the controller) names no remote PC
      if (entry.op !== "srd" || entry.outcome !== "resolved" || entry.sdpRole !== "offer" || entry.xPc === undefined) continue
      const from = entry.xPc
      const seen = remotes.get(entry.pc) ?? []
      if (!seen.includes(from)) {
        seen.push(from)
        remotes.set(entry.pc, seen)
        // reported at the step that resolved the second remote's offer
        if (seen.length > 1 && entry.step === record.index) {
          const detail = `${entry.pc} resolved offers from ${seen.join(" and ")}`
          const gap = findGap("P1b", detail, gaps)
          found.push(gap ? { property: "P1b", atStep: record.index, detail, issue: gap.issue } : { property: "P1b", atStep: record.index, detail })
        }
      }
    }
    return found
  },
})

export const P1b = p1bMonitor()
