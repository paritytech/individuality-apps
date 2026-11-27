// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parse } from "yaml";
const root = resolve(import.meta.dirname, "../../../..");
const file = (name: string) => readFileSync(resolve(root, name), "utf8");
const workflow = parse(file(".github/workflows/jollity-lab.yml"));
const wrapper = file("apps/jollity-app/scripts/lab/opening.mts");
const references = ["ci", "deploy", "release"].map((name) => JSON.stringify(parse(file(`.github/workflows/${name}.yml`)).jobs));
const gate = "${{ github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && contains(github.event.pull_request.labels.*.name, 'run-dim2-opening') && (github.event.action != 'labeled' || github.event.label.name == 'run-dim2-opening')) }}";
function properties(w = workflow, code = wrapper, refs = references) {
  expect(Object.keys(w.on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
  expect(w.on.pull_request.branches).toEqual(["main"]);
  expect(w.on.pull_request.types).toEqual(["opened", "labeled", "synchronize", "reopened"]);
  expect(w.jobs.opening.if).toBe(gate);
  expect(w.permissions).toEqual({ contents: "read" });
  expect(w.jobs.opening.permissions).toBeUndefined();
  expect(JSON.stringify(w)).not.toContain("secrets.");
  expect(w.jobs.opening["runs-on"]).toBe("${{ vars.JOLLITY_LAB_RUNNER || 'ubuntu-24.04' }}");
  expect(w.jobs.opening["timeout-minutes"]).toBe(75);
  expect(w.concurrency).toBeUndefined();
  expect(w.jobs.opening.concurrency.group).toBe("jollity-lab-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || 'dispatch' }}");
  expect(w.jobs.opening.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  expect(w.jobs.opening.env.NEGATIVE_CONTROL).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.negative_control }}");
  expect(w.jobs.opening.env.PRODUCT_LAB_FORK_BUNDLE).toBe("fresh");
  expect(w.on.workflow_dispatch.inputs.negative_control.type).toBe("boolean");
  expect(w.on.workflow_dispatch.inputs.negative_control.default).toBe(false);
  const steps = w.jobs.opening.steps;
  expect(w.env?.GH_TOKEN).toBeUndefined();
  expect(w.jobs.opening.env.GH_TOKEN).toBeUndefined();
  const tokenSteps = steps.filter((step: { env?: { GH_TOKEN?: string } }) => step.env?.GH_TOKEN !== undefined);
  expect(tokenSteps).toHaveLength(2);
  for (const step of tokenSteps) {
    expect(step.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(step.id === "opening" || step.run.includes("jollity:lab:prepare")).toBe(true);
  }
  expect(JSON.stringify(steps)).not.toMatch(/actions\/cache|"cache"\s*:|release-cid/i);
  expect(steps.some((s: { run?: string }) => s.run?.includes("jollity:lab:prepare"))).toBe(true);
  expect(steps.find((s: { id?: string }) => s.id === "opening").run).toContain("jollity:e2e:opening -- --fresh");
  expect(code).toContain('process.env.PRODUCT_LAB_CACHE_DIR = join(state, "cache")');
  expect(code).toContain('process.env.PRODUCT_LAB_FORK_BUNDLE = "fresh"');
  expect(code.match(/discardForkBundles\(join\(state, "cache"\)\)/g)).toHaveLength(2);
  expect(code.indexOf('discardForkBundles(join(state, "cache"))')).toBeLessThan(code.lastIndexOf('["test", `e2e/dim2-opening${control'));
  for (const ref of refs) expect(ref).not.toMatch(/jollity-lab|Jollity (local )?fork opening/);
  expect(steps.find((s: { id?: string }) => s.id === "opening")["continue-on-error"]).toBeUndefined();
  for (const name of ["jollity-lab-demo", "jollity-lab-videos"]) {
    const upload = steps.find((s: { with?: { name?: string } }) => s.with?.name === name);
    expect(upload.if).toBe("always()"); expect(upload.with["retention-days"]).toBe(14);
  }
  expect(code).toContain('"--video"');
  // The wrapper hands its environment to fetch, doctor and the run; CI never names the genesis network, so it runs the
  // default (the Paseo copy, pinned by genesis.test.ts).
  expect(code).toContain('["fetch", "--config", "lab.opening.config.ts", "--environment", environment]');
  expect(code).toContain('["doctor", "--config", "lab.opening.config.ts", "--environment", environment]');
  expect(code).toMatch(/\["test", `e2e\/dim2-opening\$\{control[^\]]*"--environment", environment,/);
  expect(JSON.stringify(w.jobs)).not.toContain("previewnet-genesis");
}
it("keeps the real workflow opt-in, advisory, bounded and without a bundle cache", () => properties());
function admitted(event_name: string, action: string, labels: string[], label = "", repository = "paritytech/individuality-apps") {
  const expression = workflow.jobs.opening.if.slice(3, -2).replace('github.event.pull_request.labels.*.name', 'labels');
  const run = new Function("github", "labels", "contains", `return ${expression}`);
  return run({ event_name, repository: "paritytech/individuality-apps", event: { action, label: { name: label }, pull_request: { head: { repo: { full_name: repository } } } } }, labels, (values: string[], value: string) => values.includes(value));
}
it("evaluates the actual gate for arbitrary labels, event kinds, actions and head repositories", () => {
  fc.assert(fc.property(fc.array(fc.string()), fc.constantFrom("pull_request", "workflow_dispatch", "push", "schedule"), fc.constantFrom("opened", "labeled", "synchronize", "reopened"), fc.string(), fc.boolean(), (labels, event, action, label, sameRepo) => {
    const expected = event === "workflow_dispatch" || event === "pull_request" && sameRepo && labels.includes("run-dim2-opening") && (action !== "labeled" || label === "run-dim2-opening");
    expect(admitted(event, action, labels, label, sameRepo ? "paritytech/individuality-apps" : "other/fork")).toBe(expected);
  }));
});
it("admits the opening label, opened, synchronize and reopened events only while the PR is labelled", () => {
  expect(admitted("pull_request", "labeled", ["run-dim2-opening"], "run-dim2-opening")).toBe(true);
  for (const action of ["opened", "synchronize", "reopened"]) {
    expect(admitted("pull_request", action, ["run-dim2-opening"])).toBe(true);
    expect(admitted("pull_request", action, [])).toBe(false);
  }
  expect(admitted("workflow_dispatch", "", [])).toBe(true);
});
it("an unrelated label cannot start or cancel an opening on an already labelled PR", () => {
  // Workflow-level concurrency runs before the job gate; it must be absent.
  // The rejected job never acquires its own PR concurrency group.
  expect(workflow.concurrency).toBeUndefined();
  expect(workflow.jobs.opening.concurrency).toBeDefined();
  for (const label of ["deploy-preview", "deploy-paseo", "documentation", "bug"]) {
    expect(admitted("pull_request", "labeled", ["run-dim2-opening", label], label), label).toBe(false);
    expect(admitted("pull_request", "labeled", [label], label), label).toBe(false);
  }
  expect(admitted("pull_request", "labeled", [], "run-dim2-opening")).toBe(false);
});
it("refuses fork PRs even when labelled, while preserving dispatch", () => {
  for (const action of ["opened", "labeled", "synchronize", "reopened"]) expect(admitted("pull_request", action, ["run-dim2-opening"], "run-dim2-opening", "other/fork")).toBe(false);
  expect(admitted("workflow_dispatch", "", [], "", "other/fork")).toBe(true);
});
const ci = parse(file(".github/workflows/ci.yml"));
function offlineCi(w = ci) {
  const job = w.jobs.jollity;
  expect(job.if).toBeUndefined();
  for (const command of ["tsc -p apps/jollity-app/tsconfig.lab.json --noEmit", "vitest run apps/jollity-app/tests/lab"]) {
    const step = job.steps.find((step: { run?: string }) => step.run?.includes(command));
    expect(step, command).toBeDefined();
    expect(step.if).toBeUndefined();
  }
}
it("runs offline lab tests and typecheck in ordinary Jollity CI without the label", () => offlineCi());
it("rejects removal or label-gating of either ordinary-CI offline check", () => {
  for (const match of ["tsconfig.lab.json", "vitest run apps/jollity-app/tests/lab"]) {
    const missing = structuredClone(ci);
    missing.jobs.jollity.steps = missing.jobs.jollity.steps.filter((step: { run?: string }) => !step.run?.includes(match));
    expect(() => offlineCi(missing)).toThrow();
    const gated = structuredClone(ci);
    gated.jobs.jollity.steps.find((step: { run?: string }) => step.run?.includes(match)).if = "contains(github.event.pull_request.labels.*.name, 'run-dim2-opening')";
    expect(() => offlineCi(gated)).toThrow();
  }
});
describe("deliberately broken workflow properties are rejected", () => {
  const mutations = {
    "automatic trigger": (w: typeof workflow) => { w.on.push = { branches: ["main"] }; },
    "missing label gate": (w: typeof workflow) => { w.jobs.opening.if = "github.event_name == 'pull_request'"; },
    "unrelated label restarts": (w: typeof workflow) => { w.jobs.opening.if = w.jobs.opening.if.replace(" && (github.event.action != 'labeled' || github.event.label.name == 'run-dim2-opening')", ""); },
    "workflow-level cancellation": (w: typeof workflow) => { w.concurrency = w.jobs.opening.concurrency; },
    "fork PR allowed": (w: typeof workflow) => { w.jobs.opening.if = w.jobs.opening.if.replace("github.event.pull_request.head.repo.full_name == github.repository && ", ""); },
    "job-wide token": (w: typeof workflow) => { w.jobs.opening.env.GH_TOKEN = "${{ github.token }}"; },
    "fork cache": (w: typeof workflow) => { w.jobs.opening.steps.push({ uses: "actions/cache@v4", with: { path: ".product-lab", key: "fork-bundle" } }); },
    "release cache": (w: typeof workflow) => { w.jobs.opening.steps.push({ run: "echo release-cid-abc" }); },
    "kept bundle": (w: typeof workflow) => { w.jobs.opening.env.PRODUCT_LAB_FORK_BUNDLE = "keep"; },
    "PR control": (w: typeof workflow) => { w.jobs.opening.env.NEGATIVE_CONTROL = "true"; },
    "wrong runner": (w: typeof workflow) => { w.jobs.opening["runs-on"] = "ubuntu-latest"; },
    "write permission": (w: typeof workflow) => { w.permissions.contents = "write"; },
  };
  for (const [name, mutate] of Object.entries(mutations)) it(name, () => {
    const broken = structuredClone(workflow); mutate(broken); expect(() => properties(broken)).toThrow();
  });
  it("required downstream dependency", () => expect(() => properties(workflow, wrapper, [...references, "needs: [jollity-lab]"])).toThrow());
  it("removed per-run download guard", () => expect(() => properties(workflow, wrapper.replaceAll('discardForkBundles(join(state, "cache"));', ''))).toThrow());
  it("caller-controlled cache", () => expect(() => properties(workflow, wrapper.replace('process.env.PRODUCT_LAB_CACHE_DIR =', 'process.env.PRODUCT_LAB_CACHE_DIR ??='))).toThrow());
});
