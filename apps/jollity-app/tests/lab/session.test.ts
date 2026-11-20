// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// The fresh Node/tsx process loads real CommonJS/ESM dependencies, which can exceed 5 s on CI.
it("keeps config-side create/open and the real ESM heads step on one owned-session registry", () => {
  const fixture = fileURLToPath(new URL("./fixtures/session-sequence.mts", import.meta.url));
  const output = execFileSync(process.execPath, ["--import", "tsx", fixture], { encoding: "utf8", timeout: 30_000 });
  expect(output).toContain("create -> open -> actual finalized-heads step passed across CommonJS/ESM");
  expect(output).toContain("missing/closed owned session still rejected");
}, 30_000);
