// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Called only after acquiring flow.lock. Keep prepare telemetry, never stale run evidence. */
export function resetRunReports(reports: string): void {
  rmSync(join(reports, 'last-run.json'), { force: true });
  const sanitized = join(reports, 'sanitized');
  mkdirSync(sanitized, { recursive: true });
  for (const entry of readdirSync(sanitized, { withFileTypes: true })) {
    if (entry.isFile() && /^prepare-[0-9]+-resources\.json$/.test(entry.name)) continue;
    rmSync(join(sanitized, entry.name), { recursive: true, force: true });
  }
}
