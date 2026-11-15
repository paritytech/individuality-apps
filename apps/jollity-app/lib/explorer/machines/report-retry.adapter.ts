// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { reportRetryMachineDefinition } from "../../state-machines/report-retry.definition"
import { fromDefinition } from "./from-definition"

type RetryMonitor = { submits: number; submitOnFreshRead: boolean; settles: number }

export const reportRetryAdapter = fromDefinition(reportRetryMachineDefinition, {
  // the two invariants that read the whole trace (report-retry.definition.ts:257-264, 279-289) see only what this monitor keeps
  traceMonitor: {
    initial: { submits: 0, submitOnFreshRead: true, settles: 0 } as RetryMonitor,
    step: (m: RetryMonitor, entry) => ({
      submits: Math.min(2, m.submits + (entry.real.commands.includes("submit") ? 1 : 0)),
      submitOnFreshRead: m.submitOnFreshRead && (!entry.real.commands.includes("submit") || ["status-open", "status-unread"].includes(entry.eventKey)),
      settles: Math.min(2, m.settles + entry.real.commands.filter((c: string) => c.startsWith("settle:")).length),
    }),
    key: (m: RetryMonitor) => `${m.submits}|${m.submitOnFreshRead ? 1 : 0}|${m.settles}`,
    covers: ["at most one submit, and never after a sent/closed answer or the end", "an attempt settles exactly once, with its outcome, and done is terminal"],
  },
})
