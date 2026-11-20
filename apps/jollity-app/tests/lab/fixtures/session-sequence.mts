// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Exercise the actual mixed CommonJS config / ESM custom-step loading without a fork.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { customSteps } from "@parity/product-lab/steps";
import type { BrowserPage } from "@parity/product-lab/ports/browser";
import { opened as stepSessions } from "../../../lab/opening/session.ts";
import "../../../lab/opening/steps.ts";

const require = createRequire(new URL("../../../lab.opening.config.ts", import.meta.url));
const config = require("./lab.opening.config.ts").default;
const configModule = require("./lab/opening/session.ts") as typeof import("../../../lab/opening/session.ts");
// Prove this exercises the two module instances that differed in the failed run.
const esm = await import("../../../lab/opening/session.ts");
assert.equal(config.sessions, configModule.openingSessions);
assert.notEqual(config.sessions, esm.openingSessions);
const actor = { id: "ada", name: "Ada" };
let reloads = 0;
let headReads = 0;
const attached: unknown[] = [];
const view = { page: {} as BrowserPage, username: "owned-lite-person", account: "owned-account",
  proof: async () => ({ readable: true }), reload: async () => { reloads++; },
  heads: async () => { headReads++; return [{ chain: "people", advanced: true }, { chain: "asset-hub", advanced: true }]; } };
const headsStep = customSteps().find((step) => step.pattern.text === "the opening fork has advancing finalized heads");
assert.ok(headsStep);
const context = { lab: { scenario: "mixed module control", actor: () => actor,
  attach: async (evidence: unknown) => { attached.push(evidence); } } } as Parameters<typeof headsStep.run>[0];
try {
  // Given Ada is a new actor: the config-side session factory registers the view.
  configModule.opened.set(actor.id, view);
  // When Ada opens dim2 at /: the config-side openApp resolves that same actor id.
  const opened = configModule.opened.get(actor.id);
  assert.ok(opened); await opened.reload();
  // Then heads: run the real registered custom step, which imports session.ts as ESM.
  await headsStep.run(context);
  assert.equal(reloads, 1); assert.equal(headReads, 1); assert.equal(attached.length, 1);
  assert.equal(stepSessions.get(actor.id), view);
  console.log("create -> open -> actual finalized-heads step passed across CommonJS/ESM");
} finally {
  configModule.opened.delete(actor.id);
}
await assert.rejects(headsStep.run(context), /No owned DIM2 host session/);
assert.equal(stepSessions.has(actor.id), false);
console.log("missing/closed owned session still rejected");
