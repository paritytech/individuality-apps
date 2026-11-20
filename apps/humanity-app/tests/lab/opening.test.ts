// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import type { BrowserPage } from "@parity/product-lab/ports/browser";
import { HostNetworkRoutes } from "@parity/product-lab/domain";
import { assertOpening, observeOpening } from "../../lab/opening/steps.ts";
import { assertOpeningReport, bundleAsset, cleanupAll, requireLoopback } from "../../lab/opening/session.ts";

const good = { home: true, card: true, username: "adalab.01", label: "Person" };
it("observes the DOM after serializing the callback into a separate browser context", async () => {
  const content: Record<string, string> = { "humanity-home": "Home", "membership-card": "Card", "card-username": good.username, "card-label": good.label };
  const page = { evaluate: async (fn: (arg: undefined) => unknown) => runInNewContext(`(${fn.toString()})(undefined)`, {
    document: { querySelector: (selector: string) => ({ textContent: content[selector.slice(14, -2)], getClientRects: () => [{}] }) },
    getComputedStyle: () => ({ visibility: "visible" }),
  }) } as unknown as BrowserPage;
  expect(await observeOpening(page)).toEqual(good);
});
it("accepts only the exact wrong-card failure after passing setup and cleanup", () => {
  const step = (name: string, status = "passed", error_message?: string) => ({ name, result: { status, error_message } });
  const report = (last = step('Ada sees the Humanity card labelled "Member"', "failed", 'Card label "Person" does not match "Member"')) => [{ elements: [{ type: "scenario", steps: [
    { hidden: true, ...step("Before") }, step("Ada is a new actor"), step('Ada opens peopl at /'), step("Ada shows the inline card for a host without Pocket"), step("the opening fork has advancing finalized heads"), last, { hidden: true, ...step("After") },
  ] }] }];
  expect(() => assertOpeningReport(report(), true)).not.toThrow();
  expect(() => assertOpeningReport([], true)).toThrow();
  expect(() => assertOpeningReport(report(step('Ada sees the Humanity card labelled "Member"', "failed", "Card username is wrong")), true)).toThrow();
  expect(() => assertOpeningReport(report(step('Ada sees the Humanity card labelled "Member"')), true)).toThrow();
  const failedSetup = report();
  failedSetup[0]!.elements[0]!.steps[1]!.result.status = "failed";
  expect(() => assertOpeningReport(failedSetup, true)).toThrow();
});
describe("Humanity opening observations", () => {
  it("accepts the provisioned person", () => expect(() => assertOpening(good, "adalab.01", "Person")).not.toThrow());
  for (const change of [{ home: false }, { card: false }, { username: "someone.01" }, { label: "Member" }]) {
    it(`rejects ${JSON.stringify(change)}`, () => expect(() => assertOpening({ ...good, ...change }, "adalab.01", "Person")).toThrow());
  }
  it("rejects the wrong-card expectation specifically", () => {
    expect(() => assertOpening(good, "adalab.01", "Member")).toThrow('Card label "Person" does not match "Member"');
  });
});
const routes = (endpoint = "ws://127.0.0.1:20000", service = "http://127.0.0.1:20003") => HostNetworkRoutes.from({
  network: "paseo-next-v2", namespace: "paseo", publicRoutes: { reason: "unit-test rejection control" },
  chains: { people: { ws: endpoint }, "asset-hub": { ws: "ws://127.0.0.1:20001" }, bulletin: { ws: "ws://127.0.0.1:20002" } },
  services: { "identity-backend": service },
});
it("accepts only the local fork, even if upstream routing opted into a public endpoint", () => {
  expect(() => requireLoopback(routes())).not.toThrow();
  expect(() => requireLoopback(routes("wss://people.example.org"))).toThrow("non-loopback");
  expect(() => requireLoopback(routes(undefined, "https://identity.example.org"))).toThrow("non-loopback");
});
it("closes remaining resources and retains setup and cleanup errors", async () => {
  const called: number[] = [];
  const initial = new Error("onboarding failed");
  const cleanup = new Error("host stop failed");
  try {
    await cleanupAll([() => { called.push(1); }, () => { called.push(2); throw cleanup; }], initial);
    throw new Error("cleanup falsely passed");
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([initial, cleanup]);
  }
  expect(called).toEqual([2, 1]);
});

it("kept-bundle guard separates Engine assets from release metadata and host archives", () => {
  expect(bundleAsset("https://github.com/paritytech/previewnet-engine/releases/download/nightly/bundle.tar.gz")).toBe(true);
  expect(bundleAsset("https://api.github.com/repos/paritytech/previewnet-engine/releases/assets/12")).toBe(true);
  expect(bundleAsset("https://release-assets.githubusercontent.com/asset")).toBe(true);
  expect(bundleAsset("https://api.github.com/repos/paritytech/previewnet-engine/releases/tags/nightly")).toBe(false);
  expect(bundleAsset("https://github.com/paritytech/host-rust-core/releases/download/v0.27.0/host.tar.gz")).toBe(false);
  expect(bundleAsset("http://127.0.0.1:20000/bootstrap.js")).toBe(false);
});
