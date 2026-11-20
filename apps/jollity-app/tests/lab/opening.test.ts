// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AppDevServer } from "@parity/product-lab/domain/apps";
import type { BrowserPage } from "@parity/product-lab/ports/browser";
import { HostNetworkRoutes } from "@parity/product-lab/domain";
import { assertOpening, observeOpening } from "../../lab/opening/steps.ts";
import { assertOpeningReport, cleanupAll, requireLoopback } from "../../lab/opening/session.ts";
import { dim2DevServer, dim2SourceServer, dim2AppEnv, sourceEvidence, digest } from "../../lab/opening/app.ts";
import { discardForkBundles } from "../../lab/opening/bundle.ts";
import { assertSudoReceipt, requireOwnedFork, sudoReceiptEvidence } from "../../lab/opening/fixture.ts";
const good = { home: true, status: "Next game", register: true, source: "host", account: "ada", registered: "false" };
const routes = (endpoint = "ws://127.0.0.1:20000") => HostNetworkRoutes.from({ network: "paseo-next-v2", namespace: "paseo", publicRoutes: { reason: "rejection control" },
  chains: { people: { ws: endpoint }, "asset-hub": { ws: "ws://127.0.0.1:20001" }, bulletin: { ws: "ws://127.0.0.1:20002" } }, services: { "identity-backend": "http://127.0.0.1:20003" } });
it("observes the DOM with a self-contained serialized callback", async () => {
  const attributes: Record<string, string> = { "data-source": "host", "data-account": "ada", "data-registered": "false" };
  const page = { evaluate: async (fn: (arg: undefined) => unknown) => runInNewContext(`(${fn.toString()})(undefined)`, {
    document: { querySelector: () => ({ textContent: "Next game", getClientRects: () => [{}], getAttribute: (name: string) => attributes[name] }) },
  }) } as unknown as BrowserPage;
  expect(await observeOpening(page)).toEqual(good);
});
describe("DIM2 observations", () => {
  it("accepts the unregistered host account", () => expect(() => assertOpening(good, "ada", "false")).not.toThrow());
  for (const change of [{ home: false }, { status: null }, { register: false }, { source: "ws" }, { account: "other" }, { registered: "true" }]) {
    it(`rejects ${JSON.stringify(change)}`, () => expect(() => assertOpening({ ...good, ...change }, "ada", "false")).toThrow());
  }
  it("fails specifically on the deliberately wrong registered state", () => expect(() => assertOpening(good, "ada", "true")).toThrow('DIM2 registered "false" does not match "true"'));
});
const step = (name: string, status = "passed", error_message?: string) => ({ name, result: { status, error_message } });
function report(control = true) {
  const names = ["Ada is a new actor", "Ada opens dim2 at /", "the opening fork has advancing finalized heads", "Ada has a readable DIM2 lite proof", `Ada sees DIM2 registered as "${control ? "true" : "false"}"`, ...control ? [] : ["Ada reloads DIM2", 'Ada sees DIM2 registered as "false"', "Ada has a readable DIM2 lite proof"]];
  const steps = names.map((name, i) => step(name, control && i === 4 ? "failed" : "passed", control && i === 4 ? 'screen-mismatch: DIM2 registered "false" does not match "true"' : undefined));
  return [{ elements: [{ type: "scenario", steps: [{ hidden: true, ...step("Before") }, ...steps, { hidden: true, ...step("After") }] }] }];
}
it("requires exactly the intended mismatch, passing setup, proof, heads and cleanup", () => {
  expect(() => assertOpeningReport(report(), true)).not.toThrow();
  expect(() => assertOpeningReport(report(false), false)).not.toThrow();
  for (const i of [0, 1, 2, 3, 4, 6]) {
    const broken = report(); broken[0]!.elements[0]!.steps[i]!.result.status = "failed";
    if (i === 4) broken[0]!.elements[0]!.steps[i]!.result.error_message = "proof denied";
    expect(() => assertOpeningReport(broken, true)).toThrow();
  }
  for (const status of ["passed", "skipped", "undefined"]) {
    const broken = report(); broken[0]!.elements[0]!.steps[5]!.result.status = status;
    expect(() => assertOpeningReport(broken, true)).toThrow();
  }
  const wrong = report(); wrong[0]!.elements[0]!.steps[5]!.result.error_message = "timeout";
  expect(() => assertOpeningReport(wrong, true)).toThrow();
  expect(() => assertOpeningReport([], true)).toThrow();
  expect(() => assertOpeningReport([...report(), ...report()], true)).toThrow();
});
it("refuses public routes, unowned targets and failed or absent inner sudo receipts", () => {
  expect(() => requireLoopback(routes())).not.toThrow();
  expect(() => requireLoopback(routes("wss://example.org"))).toThrow();
  expect(() => requireOwnedFork({ environmentId: "paseo-copy", offer: { local: false, chains: [] } })).toThrow();
  expect(() => requireOwnedFork({ environmentId: "previewnet-copy", offer: { local: true, chains: [] } })).toThrow();
  const event = { type: "Sudo", value: { type: "Sudid", value: { sudo_result: { success: true } } } };
  expect(() => assertSudoReceipt({ ok: true, events: [event] })).not.toThrow();
  for (const receipt of [{ ok: false, events: [event] }, { ok: true, events: [] }, { ok: true, events: [{ ...event, value: { type: "Sudid", value: { sudo_result: { success: false } } } }] }]) expect(() => assertSudoReceipt(receipt)).toThrow();
});
it("closes every owned resource even after a failure", async () => {
  const calls: number[] = [];
  await expect(cleanupAll([() => { calls.push(1); }, () => { calls.push(2); throw Error("stop failed"); }], Error("setup failed"))).rejects.toBeInstanceOf(AggregateError);
  expect(calls).toEqual([2, 1]);
});
it("owns an isolated hoisted Next server and records source SHA, tree and root lock", () => {
  const temp = mkdtempSync(join(tmpdir(), "dim2-source-test-"));
  try {
    const app = join(temp, "apps/jollity-app"); mkdirSync(app, { recursive: true });
    writeFileSync(join(temp, "package-lock.json"), "{}"); writeFileSync(join(app, "app.ts"), "export {};");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: temp, stdio: "pipe" });
    git("init"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.org", "-c", "commit.gpgsign=false", "commit", "-m", "test: fixture");
    expect(() => dim2SourceServer(app, "run1", routes())).toThrow("Missing hoisted Next");
    const next = join(temp, "node_modules/next/dist/bin"); mkdirSync(next, { recursive: true }); writeFileSync(join(next, "next"), "");
    const source = dim2SourceServer(app, "run1", routes());
    expect(source.declaration.command).toBe("node");
    expect(source.declaration.args).toEqual([join(next, "next"), "dev", "--webpack", "--port", "{port}", "--hostname", "127.0.0.1"]);
    expect(source.declaration.startTimeoutMs).toBe(180_000);
    expect(source.source.kind).toBe("source"); expect(source.source.commit).toMatch(/^[a-f0-9]{40}$/); expect(source.source.appTree).toMatch(/^[a-f0-9]{40}$/);
    expect(sourceEvidence(app).lockSha256).toBe(digest(readFileSync(join(temp, "package-lock.json"))));
    expect(dim2AppEnv(routes(), "run1").NEXT_DIST_DIR).not.toBe(dim2AppEnv(routes(), "run2").NEXT_DIST_DIR);
    source.cleanup(); expect(existsSync(join(app, dim2AppEnv(routes(), "run1").NEXT_TSCONFIG))).toBe(false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
it("removes current, staged and partial bundles before each run but keeps binaries", () => {
  const cache = mkdtempSync(join(tmpdir(), "dim2-bundle-test-"));
  try {
    const workspace = join(cache, "engine/tooling/pinned/workspace"); mkdirSync(workspace, { recursive: true });
    for (const name of ["fork-bundle-paseo-next-v2", "fork-bundle-paseo-next-v2.next.partial", "bin", "fork-bundle-other"]) mkdirSync(join(workspace, name));
    discardForkBundles(cache);
    expect(existsSync(join(workspace, "fork-bundle-paseo-next-v2"))).toBe(false);
    expect(existsSync(join(workspace, "fork-bundle-paseo-next-v2.next.partial"))).toBe(false);
    expect(existsSync(join(workspace, "bin"))).toBe(true); expect(existsSync(join(workspace, "fork-bundle-other"))).toBe(true);
  } finally { rmSync(cache, { recursive: true, force: true }); }
});

it("records a failed sudo receipt before throwing, including the exact call and dispatch error", () => {
  const receipt = { ok: true, txHash: "0x123", block: { hash: "0x456", number: 23, index: 2 },
    events: [{ type: "Sudo", value: { type: "Sudid", value: { sudo_result: { success: false, value: { type: "Module", value: { type: "Game", value: { type: "InvalidGameState" } } } } } } }] };
  const records: ReturnType<typeof sudoReceiptEvidence>[] = [];
  expect(() => assertSudoReceipt(receipt, "Game.set_game_phases", (evidence) => records.push(evidence))).toThrow(/Game.set_game_phases:.*InvalidGameState/);
  expect(records).toEqual([sudoReceiptEvidence("Game.set_game_phases", receipt)]);
  expect(records[0]?.txHash).toBe("0x123");
  expect(records[0]?.eventNames).toEqual(["Sudo.Sudid"]);
});
it("preserves outer dispatch failure and distinguishes missing, duplicate and malformed sudo events", () => {
  const outer = { ok: false, events: [], dispatchError: { type: "BadOrigin" } };
  expect(() => assertSudoReceipt(outer, "Game.schedule_games")).toThrow(/Game.schedule_games:.*BadOrigin/);
  const good = { type: "Sudo", value: { type: "Sudid", value: { sudo_result: { success: true } } } };
  for (const events of [[], [good, good], [{ type: "Sudo", value: { type: "KeyChanged" } }], [{ type: "Sudo", value: { type: "Sudid", value: {} } }]]) {
    expect(() => assertSudoReceipt({ ok: true, events }, "Game.cancel_game")).toThrow("Game.cancel_game");
  }
});
it("receipt evidence retains only public transaction fields", () => {
  const receipt = { ok: true, events: [{ type: "Sudo", value: { type: "Sudid", value: { sudo_result: { success: true } } } }],
    signer: { privateData: "must not be retained" }, wallet: "must not be retained" };
  const evidence = sudoReceiptEvidence("Game.cancel_game", receipt);
  expect(JSON.stringify(evidence)).not.toContain("must not be retained");
  expect(() => assertSudoReceipt(receipt, "Game.cancel_game")).not.toThrow();
});

it("validates the real launcher offline and rejects machine-specific absolute commands", () => {
  const declaration = dim2DevServer("/checkout/node_modules/next/dist/bin/next", {});
  expect(AppDevServer.parse("dim2", declaration).command).toBe("node");
  for (const command of ["/opt/homebrew/Cellar/node@24/24.22.0/bin/node", "/usr/bin/node", "C:\\nodejs\\node.exe"]) {
    expect(() => AppDevServer.parse("dim2", { ...declaration, command })).toThrow(/command must be a program on PATH/);
  }
});
