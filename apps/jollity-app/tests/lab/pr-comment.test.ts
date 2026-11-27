// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import ts from "typescript";
import { scenarioSummary } from "../../../../.github/lab-scenario-summary.mts";

const root = resolve(import.meta.dirname, "../../../..");
const file = (path: string) => readFileSync(resolve(root, path), "utf8");
const workflow = parse(file(".github/workflows/jollity-lab.yml"));
const humanity = parse(file(".github/workflows/humanity-lab.yml"));
const job = workflow.jobs.comment;
const script = job.steps[0].with.script;

it("uses the same tested writer and PR concurrency group as Humanity, with only its own section key", () => {
  expect(script).toBe(humanity.jobs.comment.steps[0].with.script);
  expect(job.concurrency).toEqual(humanity.jobs.comment.concurrency);
  expect(job.concurrency).toEqual({ group: "lab-opening-comment-${{ github.event.pull_request.number }}", "cancel-in-progress": false });
  expect(job.steps[0].env.WORKFLOW).toBe("jollity");
  expect(job.steps[0].uses).toBe(humanity.jobs.comment.steps[0].uses);
  expect(job.permissions).toEqual({ "pull-requests": "write" });
  expect(job.needs).toEqual(["opening"]);
  expect(job["continue-on-error"]).toBe(true);
  expect(job.steps[0]["continue-on-error"]).toBe(true);
  expect(job.steps).toHaveLength(1);
  expect(job["timeout-minutes"]).toBe(3);
  expect(workflow.jobs.opening.permissions).toBeUndefined();
  expect(workflow.concurrency).toBeUndefined();
  for (const output of ["scenarios", "demo", "videos", "results"]) expect(workflow.jobs.opening.outputs[output]).toBe(humanity.jobs.opening.outputs[output]);
  for (const id of ["upload_demo", "upload_videos", "upload_results"]) {
    const upload = workflow.jobs.opening.steps.find((step: { id?: string }) => step.id === id);
    expect(upload.if).toBe("always()");
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
  }
  const summary = workflow.jobs.opening.steps.find((step: { id?: string }) => step.id === "comment_summary");
  expect(summary.if).toBe("always()");
  expect(summary["continue-on-error"]).toBe(true);
  expect(summary.run).toBe(humanity.jobs.opening.steps.find((step: { id?: string }) => step.id === "comment_summary").run.replaceAll("apps/humanity-app/", "apps/jollity-app/"));
});

it("evaluates the actual comment gate for forks, dispatches, skipped, failed and cancelled openings", () => {
  const evaluate = new Function("github", "needs", "always", `return ${job.if.slice(3, -2)}`);
  for (const event of ["pull_request", "workflow_dispatch", "push"]) {
    for (const repository of ["paritytech/individuality-apps", "other/fork"]) {
      for (const result of ["skipped", "success", "failure", "cancelled"]) {
        const github = { event_name: event, repository: "paritytech/individuality-apps", event: { pull_request: { head: { repo: { full_name: repository } } } } };
        expect(evaluate(github, { opening: { result } }, () => true)).toBe(event === "pull_request" && repository === github.repository && result !== "skipped");
      }
    }
  }
});

it("projects both Jollity features and renders their actual writer without raw diagnostics", async () => {
  for (const control of [false, true]) {
    const feature = file(`apps/jollity-app/e2e/dim2-opening${control ? "-wrong-state" : ""}.feature`);
    const name = /^\s*Scenario:\s*(.+)$/m.exec(feature)![1];
    const names = [...feature.matchAll(/^\s*(?:Given|When|Then|And|But)\s+(.+)$/gm)].map((match) => match[1]);
    const report = [{ elements: [{ type: "scenario", name, steps: names.map((name, index) => ({ name, result: { status: control && index === names.length - 1 ? "failed" : "passed", error_message: "private error" } })) }] }];
    const summary = scenarioSummary(report, feature);
    expect(summary[0]!.steps).toHaveLength(control ? 5 : 8);
    expect(summary[0]!.status).toBe(control ? "failed" : "passed");
    let body = "";
    const issues = { listComments: () => {}, createComment: async (comment: { body: string }) => { body = comment.body; } };
    const github = { rest: { issues }, paginate: async () => [] };
    const context = { runId: 123, repo: { owner: "paritytech", repo: "individuality-apps" }, issue: { number: 1661 } };
    const process = { env: { WORKFLOW: "jollity", RESULT: control ? "failure" : "success", SCENARIOS: JSON.stringify(summary), GITHUB_RUN_ATTEMPT: "1", GITHUB_SERVER_URL: "https://github.com" } };
    await new Function("github", "context", "core", "process", `return (async () => { ${script} })()`)(github, context, { warning: () => {} }, process);
    expect(body).toContain("## Jollity opening");
    expect(body).toContain(`${name} · ${control ? "FAIL" : "PASS"}`);
    expect(body).not.toMatch(/private error|Humanity opening/);
    expect(body.match(/\| PASS \|/g)).toHaveLength(control ? 4 : 8);
  }
});

it("writes the projection in the actual finally block before cleanup", () => {
  const source = ts.createSourceFile("opening.mts", file("apps/jollity-app/scripts/lab/opening.mts"), ts.ScriptTarget.Latest, true);
  let count = 0;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "writeScenarioSummary") {
      count++;
      const block = node.parent.parent;
      expect(ts.isBlock(block) && ts.isTryStatement(block.parent) && block.parent.finallyBlock === block).toBe(true);
      expect(node.getText(source)).toContain('join(reports, "sanitized")');
      expect(node.getText(source)).toContain('"product-lab-test.json"');
      expect(node.getText(source)).toContain('`e2e/dim2-opening${control ? "-wrong-state" : ""}.feature`');
      expect(block.getText(source).indexOf("writeScenarioSummary")).toBeLessThan(block.getText(source).indexOf("await cleanup()"));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(count).toBe(1);
});
