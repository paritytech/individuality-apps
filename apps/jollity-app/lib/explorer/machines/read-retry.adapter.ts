// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readRetryMachineDefinition } from "../../state-machines/read-retry.definition"
import { fromDefinition } from "./from-definition"

type ReadMonitor = { reads: string }

export const readRetryAdapter = fromDefinition(readRetryMachineDefinition, {
  // the one invariant that reads the whole trace (read-retry.definition.ts, "only a wait completion starts a replacement read") sees only the read commands emitted so far
  traceMonitor: {
    initial: { reads: "" } as ReadMonitor,
    step: (m: ReadMonitor, entry) => {
      const reads = entry.real.commands.filter((c: string) => c.startsWith("read:"))
      return reads.length === 0 ? m : { reads: [...new Set([...(m.reads === "" ? [] : m.reads.split(",")), ...reads])].sort().join(",") }
    },
    key: (m: ReadMonitor) => m.reads,
    covers: ["no attempt is read twice"],
  },
})
