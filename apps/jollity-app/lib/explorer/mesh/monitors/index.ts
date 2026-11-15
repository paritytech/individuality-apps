// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The monitor registry the room runs. Slice 1's four are here; further
 * monitors go in SLICE2_MONITORS (empty for now). A room built with
 * `slice: 2` runs both lists. `atEnd` is not yet called by the room: the
 * first monitor that needs it wires it into checkLeaf.
 */
import { P1 } from "./p1"
import { KNOWN_GAPS, type KnownGap } from "../known-gaps"
import { P1b, p1bMonitor } from "./p1b"
import { P2 } from "./p2"
import { DEADLINE } from "./deadline"
import type { Monitor } from "./wire"

export type { Monitor } from "./wire"

export const SLICE1_MONITORS: Monitor[] = [P1, P1b, P2, DEADLINE]
export const SLICE2_MONITORS: Monitor[] = []

/** The slice's monitors; `gaps` replaces the known-gap list of P1b (the self-test passes none). */
export function monitorsFor(slice: 1 | 2, gaps: readonly KnownGap[] = KNOWN_GAPS): Monitor[] {
  const first = gaps === KNOWN_GAPS ? SLICE1_MONITORS : SLICE1_MONITORS.map((monitor) => (monitor.id === "P1b" ? p1bMonitor(gaps) : monitor))
  return slice === 2 ? [...first, ...SLICE2_MONITORS] : [...first]
}
