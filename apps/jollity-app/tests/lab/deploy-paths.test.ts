// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { classify } from "../../../../scripts/ci/changes.mjs";
const files = ["lab/opening/app.ts", "lab/opening/session.ts", "lab/opening/host.lock.json", "lab/opening/fixture.ts", "lab/opening/collection.ts", "lab/opening/peopl.testnet.product-config.json", "tests/lab/genesis.test.ts", "lab/opening/proof.ts", "lab/opening/bundle.ts", "lab/opening/IMPORTED.json", "lab.opening.config.ts", "tsconfig.lab.json", "e2e/dim2-opening.feature", "e2e/dim2-opening-wrong-state.feature", "tests/lab/opening.test.ts", "scripts/lab/opening.mts", "scripts/lab/proof.mts", "docs/lab.md", "docs/lab-verification.md",
  // Jollity scenarios: every file of the group, its CI script and its tests.
  ...readdirSync(resolve(import.meta.dirname, "../../lab/scenarios")).map((f) => `lab/scenarios/${f}`),
  "scripts/lab/scenarios-ci.mts", "tests/lab/browser-bodies.test.ts", "tests/lab/chest-read.test.ts", "tests/lab/fixtures/chest-read-parity.mts",
  "tests/lab/pending.test.ts", "tests/lab/registered-home.test.ts", "tests/lab/registration.test.ts", "tests/lab/results.test.ts", "tests/lab/scenarios-workflow.test.ts",
  "tests/lab/scenarios.test.ts", "tests/lab/deploy-paths.test.ts"].map((p) => `apps/jollity-app/${p}`).concat(".github/workflows/jollity-lab.yml");
// A push to main deploys whatever it changes (deploy.yml has no path filter since #24); only the PR preview is gated.
it("runs the actual preview classifier on every lab-only path", () => {
  expect(files.filter((path) => path.startsWith("apps/jollity-app/lab/scenarios/")).length).toBeGreaterThanOrEqual(18);
  for (const path of files) {
    expect(classify([path]), path).toEqual({ deploy: false });
  }
});
it("mixed source changes still preview", () => {
  const app = "apps/jollity-app/app/page.tsx";
  expect(classify([...files, app])).toEqual({ deploy: true });
});
