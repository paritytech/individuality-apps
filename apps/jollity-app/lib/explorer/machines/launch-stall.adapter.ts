// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { launchStallMachineDefinition } from "../../state-machines/launch-stall.definition"
import { fromDefinition } from "./from-definition"

type StallMonitor = { stalls: number }

export const launchStallAdapter = fromDefinition(launchStallMachineDefinition, {
  // The one invariant that reads the whole trace (launch-stall.definition.ts: "the machine
  // reports at most one stall", clause L5) sees only the running count of `stall:` words
  // this monitor keeps. Capped at 2: the check is "at most one", so anything past the
  // second cannot change the answer and an uncapped counter would make every extra stall
  // its own state for nothing.
  traceMonitor: {
    initial: { stalls: 0 } as StallMonitor,
    step: (m: StallMonitor, entry) => ({
      stalls: Math.min(2, m.stalls + entry.real.commands.filter((word: string) => word.startsWith("stall:")).length),
    }),
    key: (m: StallMonitor) => String(m.stalls),
    covers: ["the machine reports at most one stall"],
  },
})
