// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../../..");
const read = (name: string) => parse(readFileSync(resolve(root, `.github/workflows/${name}.yml`), "utf8"));
const optional = (name: string) => existsSync(resolve(root, `.github/workflows/${name}.yml`)) ? read(name) : undefined;
// Humanity's own preview and publish workflows are not in this repository yet. The comparisons with them run
// again as soon as they are restored; the opening's own gate is checked either way.
const ci = optional("humanity-ci");
const publish = optional("humanity-publish");
const deployWorkflows = Boolean(ci && publish);
const lab = read("humanity-lab");
const detector = ci?.jobs.sources.steps.find((step: { id?: string }) => step.id === "files").run ?? "";
const gate = lab.jobs.sources.steps.find((step: { id?: string }) => step.id === "files").run;
function classifier(run: string, files: string[]): boolean {
  // Execute the workflow's actual shell classifier, substituting only the read-only GitHub lookup and output sink.
  const script = run.replace(/files=\$\(gh api[^\n]+\)/, 'files="$1"').replace(/ >> "\$GITHUB_OUTPUT"/g, "");
  return execFileSync("bash", ["-c", script, "deploy-test", files.join("\n")], { encoding: "utf8" }).trim() === "changed=true";
}
const preview = (files: string[]) => classifier(detector, files);
const opening = (files: string[]) => classifier(gate, files);
function match(pattern: string, file: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").split("**").map((part) => part.replace(/\*/g, "[^/]*")).join(".*");
  return new RegExp(`^${escaped}$`).test(file);
}
function pushes(files: string[]): boolean {
  return files.some((file) => {
    let included = false;
    for (const path of publish!.on.push.paths as string[]) {
      if (match(path.replace(/^!/, ""), file)) included = !path.startsWith("!");
    }
    return included;
  });
}
const labFiles = [
  "lab/opening/session.ts", "lab/opening/steps.ts", "lab/opening/host.lock.json", "lab/opening/IMPORTED.json",
  "e2e/humanity-opening.feature", "e2e/humanity-opening-wrong-card.feature", "tests/lab/opening.test.ts",
  "tests/lab/deploy-paths.test.ts", "scripts/lab/opening.mts", "lab.opening.config.ts", "tsconfig.lab.json",
  "docs/lab.md", "docs/lab-verification.md", "eslint.config.mjs",
].map((file) => `apps/humanity-app/${file}`);
describe.skipIf(!deployWorkflows)("Humanity deploy paths", () => {
  for (const classify of [preview, pushes]) {
    it(`${classify.name}: skips lab-only and root dependency changes`, () => {
      for (const file of [...labFiles, "package.json", "package-lock.json", ".gitignore", ".github/workflows/humanity-lab.yml"]) expect(classify([file]), file).toBe(false);
      expect(classify(labFiles)).toBe(false);
    });
    it(`${classify.name}: preserves product changes and mixed changes`, () => {
      for (const file of ["apps/humanity-app/src/app.tsx", "apps/humanity-worker/src/index.ts", "packages/humanity-shared/src/index.ts", "packages/shared-records/src/index.ts", "packages/individuality-sign-up/src/index.ts", ".github/workflows/humanity-deploy.yml"]) {
        expect(classify([file]), file).toBe(true);
        expect(classify([...labFiles, file]), file).toBe(true);
      }
    });
  }
  it("publishes when the publish workflow itself changes, but previews do not", () => {
    expect(pushes([".github/workflows/humanity-publish.yml"])).toBe(true);
    expect(preview([".github/workflows/humanity-publish.yml"])).toBe(false);
  });
  it("previews when the CI workflow itself changes, but does not publish", () => {
    expect(preview([".github/workflows/humanity-ci.yml"])).toBe(true);
    expect(preview([...labFiles, ".github/workflows/humanity-ci.yml"])).toBe(true);
    expect(pushes([".github/workflows/humanity-ci.yml"])).toBe(false);
  });
});

describe("Humanity opening gate", () => {
  it.skipIf(!deployWorkflows)("opens a fork for exactly what Humanity's preview gate previews, plus the opening's own inputs", () => {
    const corpus = [
      ...labFiles, "package.json", "package-lock.json", ".gitignore", ".nvmrc", "apps/jollity-app/src/app.tsx",
      ".github/workflows/humanity-lab.yml", ".github/workflows/humanity-ci.yml", ".github/workflows/humanity-publish.yml",
      ".github/workflows/humanity-deploy.yml", "apps/humanity-app/src/app.tsx", "apps/humanity-worker/src/index.ts",
      "packages/humanity-shared/src/index.ts", "packages/shared-records/src/index.ts", "packages/individuality-sign-up/src/index.ts",
    ];
    for (const file of corpus) {
      expect(opening([file]), file).toBe(preview([file]) || labFiles.includes(file) || file === ".github/workflows/humanity-lab.yml");
    }
    const paths = lab.on.pull_request.paths as string[];
    expect(paths).toEqual([...(ci!.on.pull_request.paths as string[]).filter((path) => path !== "package-lock.json"), ".github/lab-scenario-summary.mts"]);
  }, 30_000);
  it("opens a fork on pull requests when Humanity sources or the opening change, but not for the root lock", () => {
    for (const file of [...labFiles, ".github/workflows/humanity-lab.yml", "apps/humanity-app/src/app.tsx", "apps/humanity-worker/src/index.ts",
      "packages/humanity-shared/src/index.ts", "packages/shared-records/src/index.ts", "packages/individuality-sign-up/src/index.ts"]) {
      expect(opening([file]), file).toBe(true);
    }
    for (const file of [".gitignore", ".nvmrc"]) expect(opening([file]), file).toBe(false);
    for (const file of ["package-lock.json", "package.json", "apps/jollity-app/src/app.tsx"]) expect(opening([file]), file).toBe(false);
    expect(opening(["package-lock.json", "apps/jollity-app/package.json"])).toBe(false);
    expect(opening(["package-lock.json", "apps/humanity-app/lab/opening/session.ts"])).toBe(true);
    expect(opening([])).toBe(false);
    for (const file of ["lab/shared/host.ts", "lab/cross-app/steps.ts", "lab.config.ts"]) {
      expect(opening([file]), file).toBe(true);
      if (deployWorkflows) { expect(preview([file]), file).toBe(false); expect(pushes([file]), file).toBe(false); }
    }
    expect(opening([".github/lab-scenario-summary.mts"])).toBe(true);
    // Jollity's own lab inputs never open a Humanity fork.
    for (const file of ["apps/jollity-app/lab/opening/session.ts", "apps/jollity-app/e2e/dim2-opening.feature",
      "apps/jollity-app/lab.opening.config.ts", "apps/jollity-app/lab/scenarios/home.ts", "apps/jollity-app/lab/scenarios/config.ts"]) {
      expect(opening([file]), file).toBe(false);
    }
    expect(lab.on.pull_request.branches).toEqual(["main"]);
  }, 30_000);
  it("keeps lab runs non-required, read-only, bounded, PR-scoped and on a configurable runner", () => {
    expect(Object.keys(lab.on)).toEqual(["pull_request", "workflow_dispatch"]);
    expect(lab.on.schedule).toBeUndefined();
    expect(lab.on.pull_request_target).toBeUndefined();
    expect(lab.permissions).toEqual({ contents: "read" });
    expect(lab.jobs.sources.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(lab.jobs.sources.if).toBe("github.event_name == 'pull_request'");
    expect(lab.jobs.opening.needs).toEqual(["sources"]);
    expect(lab.jobs.opening.if).toBe("${{ !cancelled() && (github.event_name == 'workflow_dispatch' || (github.event.pull_request.head.repo.full_name == github.repository && needs.sources.outputs.changed == 'true')) }}");
    expect(lab.jobs.opening.permissions).toBeUndefined();
    expect(lab.jobs.opening["runs-on"]).toBe("${{ vars.HUMANITY_LAB_RUNNER || 'ubuntu-24.04' }}");
    expect(lab.jobs.opening["timeout-minutes"]).toBe(75);
    // Pull requests run the positive opening only; the control stays a dispatch input.
    expect(lab.jobs.opening.env.NEGATIVE_CONTROL).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.negative_control }}");
    expect(lab.jobs.opening.concurrency.group).toBe("humanity-lab-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || 'dispatch' }}");
    expect(lab.jobs.opening.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
    // Sources share the opening's group, so an older run's slow sources cannot cancel a newer opening.
    expect(lab.jobs.sources.concurrency).toEqual(lab.jobs.opening.concurrency);
    expect(lab.concurrency).toBeUndefined();
    expect(JSON.stringify(lab)).not.toContain("secrets.");
    // Nothing in the repository makes the opening a gate: no other workflow waits on it.
    const labWorkflows = ["humanity-lab.yml", "jollity-lab.yml", "cross-app-lab.yml", "humanity-dim2-flow.yml"];
    for (const name of readdirSync(resolve(root, ".github/workflows")).filter((file) => !labWorkflows.includes(file))) {
      expect(readFileSync(resolve(root, `.github/workflows/${name}`), "utf8"), name).not.toMatch(/Humanity (local )?fork opening|humanity-lab/);
    }
  });
  it("always retains demos and raw videos and labels failed demos without changing the opening verdict", () => {
    const steps = lab.jobs.opening.steps;
    for (const name of ["humanity-lab-demo", "humanity-lab-videos"]) {
      const upload = steps.find((step: { with?: { name?: string } }) => step.with?.name === name);
      expect(upload.if).toBe("always()");
      expect(upload.uses).toMatch(/^actions\/upload-artifact@/);
      expect(upload.with["retention-days"]).toBe(14);
    }
    const demo = steps.find((step: { id?: string }) => step.id === "demo");
    expect(demo.if).toBe("always()");
    expect(demo["continue-on-error"]).toBe(true);
    expect(steps.find((step: { id?: string }) => step.id === "opening")["continue-on-error"]).toBeUndefined();
    const flags = demo.run.replace(/node_modules\/\.bin\/tsx[^\n]+/, 'printf "%s\\n" "${args[@]}"');
    for (const [outcome, control, expected] of [["success", "false", ""], ["failure", "false", "--failed"], ["cancelled", "false", "--failed"], ["success", "true", "--failed"]]) {
      const result = execFileSync("bash", ["-c", flags], { encoding: "utf8", env: { ...process.env, OPENING_OUTCOME: outcome, NEGATIVE_CONTROL: control } });
      expect(result.trim()).toBe(expected);
    }
    const wrapper = readFileSync(resolve(root, "apps/humanity-app/scripts/lab/opening.mts"), "utf8");
    expect(wrapper).toContain('"--video"');
    expect(lab.jobs.opening.env.PRODUCT_LAB_RECORDINGS_DIR).toContain("artifacts/humanity-lab-recordings");
  });
});


describe("flow-only config paths", () => {
  const configs = ["lab.flow.config.ts", "tsconfig.flow.json"].map(file => `apps/humanity-app/${file}`);
  it("skips the opening, preview and publish for each flow config alone and together", () => {
    for (const files of [...configs.map(file => [file]), configs]) {
      expect(opening(files)).toBe(false);
      if (deployWorkflows) { expect(preview(files)).toBe(false); expect(pushes(files)).toBe(false); }
    }
    expect(gate).toContain('lab\\.(opening|flow)\\.config\\.ts$|tsconfig\\.(lab|flow)\\.json$');
    expect(opening([...configs, "apps/humanity-app/lab/opening/session.ts"])).toBe(true);
    expect(opening([...configs, "apps/humanity-app/src/app.tsx"])).toBe(true);
  });
  it("@negative-control removing the flow-config exclusion starts an unnecessary opening", () => {
    const mutant = gate.replace(/^.*files=\$\(grep -vE[^\n]+\n/m, "");
    expect(mutant).not.toBe(gate);
    expect(classifier(mutant, configs)).toBe(true);
  });
});
