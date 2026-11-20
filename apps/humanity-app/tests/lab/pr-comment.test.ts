// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import ts from "typescript";
import { scenarioSummary } from "../../../../.github/lab-scenario-summary.mts";

const workflow = parse(readFileSync(new URL("../../../../.github/workflows/humanity-lab.yml", import.meta.url), "utf8"));
const script = workflow.jobs.comment.steps[0].with.script as string;
const feature = readFileSync(new URL("../../e2e/humanity-opening.feature", import.meta.url), "utf8");
const names = [...feature.matchAll(/^\s*(?:Given|When|Then|And|But)\s+(.+)$/gm)].map((match) => match[1]);
const scenario = /^\s*Scenario:\s*(.+)$/m.exec(feature)![1];
const report = (failed = false) => [{ elements: [{ type: "scenario", name: scenario, steps: [
  { hidden: true, name: "Before", result: { status: "passed" } },
  ...names.map((name, index) => ({ name, result: { status: failed && index === 4 ? "failed" : failed && index > 4 ? "skipped" : "passed", error_message: "private diagnostic must not escape" }, embeddings: [{ data: "private attachment" }] })),
] }] }];
const runUrl = "https://github.com/paritytech/individuality-apps/actions/runs/123";
const marker = "<!-- lab-opening-comment:v1 -->";
type Comment = { id: number; body: string; user: { login: string; type: string } };
type Update = { comment_id: number; body: string };
function memory() {
  const comments: Comment[] = [];
  let creates = 0;
  let updates = 0;
  let reads = 0;
  let warnings = 0;
  let unavailable = false;
  let onRead = () => {};
  let onUpdate = () => {};
  let onCreate = () => {};
  const issues = {
    listComments: () => {},
    getComment: async ({ comment_id }: { comment_id: number }) => {
      reads++;
      onRead();
      return { data: { ...comments.find((comment) => comment.id === comment_id)! } };
    },
    updateComment: async ({ comment_id, body }: Update) => {
      updates++;
      comments.find((comment) => comment.id === comment_id)!.body = body;
      onUpdate();
    },
    createComment: async ({ body }: { body: string }) => {
      creates++;
      comments.push({ id: comments.length + 1, body, user: { login: "github-actions[bot]", type: "Bot" } });
      onCreate();
    },
  };
  return {
    comments, issues,
    set onRead(fn: () => void) { onRead = fn; },
    set onUpdate(fn: () => void) { onUpdate = fn; },
    set onCreate(fn: () => void) { onCreate = fn; },
    set unavailable(value: boolean) { unavailable = value; },
    stats: () => ({ creates, updates, reads, warnings }),
    github: { rest: { issues }, paginate: async () => {
      if (unavailable) throw new Error("service unavailable");
      return comments.map((comment) => ({ ...comment }));
    } },
    core: { warning: () => { warnings++; } },
  };
}
type Store = ReturnType<typeof memory>;
async function execute(store: Store, env: Record<string, string> = {}, source = script) {
  const process = { env: { WORKFLOW: "humanity", RESULT: "success", SCENARIOS: JSON.stringify(scenarioSummary(report(), feature)), GITHUB_RUN_ATTEMPT: "1", GITHUB_SERVER_URL: "https://github.com", DEMO_URL: `${runUrl}/artifacts/1`, VIDEOS_URL: `${runUrl}/artifacts/2`, RESULTS_URL: `${runUrl}/artifacts/3`, ...env } };
  const context = { runId: 123, repo: { owner: "paritytech", repo: "individuality-apps" }, issue: { number: 1661 } };
  return new Function("github", "context", "core", "process", `return (async () => { ${source}\nreturn { buildSection, updateSection }; })()`)(store.github, context, store.core, process) as Promise<{ buildSection(): string; updateSection(body: string, section: string): string }>;
}

describe("sanitized scenario evidence", () => {
  it("keeps all seven ordered verdicts, including the repeated card step, and no private fields", () => {
    const summary = scenarioSummary(report(), feature);
    expect(summary).toEqual([{ name: scenario, status: "passed", steps: names.map((name) => ({ name, status: "passed" })) }]);
    expect(JSON.stringify(summary)).not.toMatch(/diagnostic|attachment|Before|embeddings|error_message/);
  });
  it("retains failures and skipped steps without copying their errors", () => {
    const [summary] = scenarioSummary(report(true), feature);
    expect(summary!.status).toBe("failed");
    expect(summary!.steps.map((step) => step.status)).toEqual(["passed", "passed", "passed", "passed", "failed", "skipped", "skipped"]);
  });
  it("refuses a false pass for missing, mismatched, duplicate or unknown evidence", () => {
    for (const invalid of [null, {}, [], [{ elements: [report()[0]!.elements[0], report()[0]!.elements[0]] }]]) {
      expect(scenarioSummary(invalid, feature)[0]!.status).toBe("unavailable");
    }
    const wrong = report();
    wrong[0]!.elements[0]!.steps[2]!.name = "unrecognized private name";
    wrong[0]!.elements[0]!.steps[1]!.result.status = "unrecognized private status";
    const summary = scenarioSummary(wrong, feature);
    expect(summary[0]!.status).toBe("unavailable");
    expect(JSON.stringify(summary)).not.toContain("private");
    const hook = report();
    hook[0]!.elements[0]!.steps[0]!.result.status = "failed";
    expect(scenarioSummary(hook, feature)[0]!.status).toBe("failed");
  });
  it("writes the sanitized projection before cleanup, even if the opening fails", () => {
    const source = readFileSync(new URL("../../scripts/lab/opening.mts", import.meta.url), "utf8");
    const file = ts.createSourceFile("opening.mts", source, ts.ScriptTarget.Latest, true);
    let count = 0;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(file) === "writeScenarioSummary") {
        count++;
        expect(ts.isExpressionStatement(node.parent)).toBe(true);
        const block = node.parent.parent;
        expect(ts.isBlock(block) && ts.isTryStatement(block.parent) && block.parent.finallyBlock === block).toBe(true);
        expect(node.getText(file)).toContain('join(reports, "sanitized")');
        expect(node.getText(file)).toContain('"product-lab-test.json"');
        expect(block.getText(file).indexOf("writeScenarioSummary")).toBeLessThan(block.getText(file).indexOf("await cleanup()"));
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    expect(count).toBe(1);
  });
});

describe("sticky comment using the workflow's actual script", () => {
  it("creates a bot comment, then updates it with the run, verdicts and exact artifact URLs", async () => {
    const store = memory();
    await execute(store);
    await execute(store);
    expect(store.stats()).toMatchObject({ creates: 1, updates: 0 });
    const body = store.comments[0]!.body;
    expect(body.startsWith(marker)).toBe(true);
    expect(body).toContain(`[Run 123, attempt 1](${runUrl}) · Result: **PASS**`);
    expect(body).toContain(`${scenario} · PASS`);
    expect(body.match(/\| PASS \|/g)).toHaveLength(7);
    for (const [label, id] of [["Demo", 1], ["Videos", 2], ["Results", 3]]) expect(body).toContain(`[${label}](${runUrl}/artifacts/${id})`);
  });
  it("shows failed run and scenario results and missing artifacts honestly", async () => {
    const store = memory();
    await execute(store, { RESULT: "failure", SCENARIOS: JSON.stringify(scenarioSummary(report(true), feature)), DEMO_URL: "", VIDEOS_URL: "https://elsewhere.invalid/video", RESULTS_URL: `${runUrl}0/artifacts/3` });
    const body = store.comments[0]!.body;
    expect(body).toContain("Result: **FAIL**");
    expect(body).toContain(`${scenario} · FAIL`);
    expect(body).toContain(`| ${names[4]} | FAIL |`);
    expect(body.match(/\| SKIPPED \|/g)).toHaveLength(2);
    for (const label of ["Demo", "Videos", "Results"]) expect(body).toContain(`- ${label}: unavailable`);
    expect(body).not.toContain("private");
  });
  it("handles cancellation, absent or malformed summary and escapes Markdown injection", async () => {
    for (const value of ["", "{", "null", "{}", "[]"]) {
      const store = memory();
      await execute(store, { RESULT: "cancelled", SCENARIOS: value });
      expect(store.comments[0]!.body).toContain("CANCELLED");
      expect(store.comments[0]!.body).toContain("Scenario steps unavailable");
    }
    const store = memory();
    await execute(store, { SCENARIOS: JSON.stringify([{ name: "<!-- injected --> @everyone", steps: [{ name: "[click](https://example.invalid)\n|PASS", status: "secret" }] }]) });
    expect(store.comments[0]!.body).not.toMatch(/<!-- injected|@everyone|\[click\]|\n\|PASS/);
    expect(store.comments[0]!.body).toContain("UNAVAILABLE");
  });
  it("skips entries that are not objects and resolves only its own verdict names", async () => {
    for (const value of ["[null]", "[1]", '["text"]', "[[]]"]) {
      const store = memory();
      await execute(store, { SCENARIOS: value });
      expect(store.stats().warnings).toBe(0);
      expect(store.comments[0]!.body).toContain("Scenario steps unavailable");
    }
    const store = memory();
    await execute(store, { RESULT: "constructor", SCENARIOS: JSON.stringify([null, { name: "Opening", status: "toString", steps: [null, "text", { name: "Step", status: "__proto__" }, { name: "Next", status: "passed" }] }]) });
    const body = store.comments[0]!.body;
    expect(body).not.toMatch(/function|native code|\| null|\| text/);
    expect(body).toContain("Result: **UNAVAILABLE**");
    expect(body).toContain("### Opening · UNAVAILABLE");
    expect(body).toContain("| Step | UNAVAILABLE |");
    expect(body).toContain("| Next | PASS |");
  });
  it("escapes bare URL autolinks, strikethrough, math, image and backslash Markdown", async () => {
    const store = memory();
    await execute(store, { SCENARIOS: JSON.stringify([{ name: "Opening", status: "passed", steps: [{ name: "see https://example.invalid ~~old~~ $x$ ![img] a\\b", status: "passed" }] }]) });
    const body = store.comments[0]!.body;
    expect(body).not.toMatch(/https:\/\/example|~~old~~|\$x\$|!\[|a\\b/);
    expect(body).toContain("https&#58;//example.invalid &#126;&#126;old&#126;&#126; &#36;x&#36; &#33;&#91;img&#93; a&#92;b");
  });
  it("ignores markers from people and other bots, including one in a quoted body", async () => {
    const store = memory();
    for (const [login, type, body] of [["person", "User", marker], ["other[bot]", "Bot", marker], ["github-actions[bot]", "Bot", `quoted ${marker}`]]) store.comments.push({ id: store.comments.length + 1, body: body!, user: { login: login!, type: type! } });
    await execute(store);
    expect(store.stats().creates).toBe(1);
    expect(store.comments).toHaveLength(4);
  });
  it("changes only its section and keeps newer runs and attempts", async () => {
    const store = memory();
    const helpers = await execute(store);
    const section = helpers.buildSection();
    const body = `${marker}\noperator note\n<!-- lab-opening:jollity:start -->\nJollity retained\n<!-- lab-opening:jollity:end -->\n${section}\nfooter`;
    const changed = helpers.updateSection(body, section.replace("Result: **PASS**", "Result: **FAIL**"));
    expect(changed).toContain("operator note");
    expect(changed).toContain("Jollity retained");
    expect(changed).toContain("\nfooter");
    expect(helpers.updateSection(body.replace("run:123:1", "run:124:1"), section)).toContain("run:124:1");
    expect(helpers.updateSection(body.replace("run:123:1", "run:123:2"), section)).toContain("run:123:2");
    expect(() => helpers.updateSection(body.replace("<!-- lab-opening:humanity:end -->", ""), section)).toThrow("Invalid opening section");
  });
  it("serializes simultaneous first creates and updates in the shared PR concurrency group", async () => {
    expect(workflow.jobs.comment.concurrency).toEqual({ group: "lab-opening-comment-${{ github.event.pull_request.number }}", "cancel-in-progress": false });
    const store = memory();
    let tail = Promise.resolve();
    const schedule = (key: string, result: string) => {
      tail = tail.then(async () => { await execute(store, { WORKFLOW: key, RESULT: result }); });
      return tail;
    };
    await Promise.all([schedule("humanity", "success"), schedule("jollity", "success"), schedule("flow", "success")]);
    await Promise.all([schedule("jollity", "failure"), schedule("humanity", "failure"), schedule("flow", "failure")]);
    expect(store.stats()).toMatchObject({ creates: 1, updates: 5 });
    expect(store.comments).toHaveLength(1);
    for (const key of ["humanity", "jollity", "flow"]) expect(store.comments[0]!.body.match(new RegExp(`lab-opening:${key}:start`, "g"))).toHaveLength(1);
    expect(store.comments[0]!.body.match(/Result: \*\*FAIL\*\*/g)).toHaveLength(3);
  });
  it("re-reads before writing and retries a verified write conflict without dropping the other section", async () => {
    const store = memory();
    await execute(store);
    const original = store.comments[0]!.body;
    const sibling = "\n<!-- lab-opening:jollity:start -->\nJollity retained\n<!-- lab-opening:jollity:end -->";
    store.onRead = () => { store.comments[0]!.body = store.comments[0]!.body.replace(sibling, "") + sibling; };
    let overwritten = false;
    store.onUpdate = () => {
      if (!overwritten) { overwritten = true; store.comments[0]!.body = original + sibling; }
    };
    await execute(store, { RESULT: "failure" });
    expect(store.stats().updates).toBe(2);
    expect(store.comments[0]!.body).toContain("Result: **FAIL**");
    expect(store.comments[0]!.body).toContain("Jollity retained");
  });
  it("re-lists an ambiguous create and treats exhausted API failures as non-fatal", async () => {
    const store = memory();
    store.onCreate = () => { throw new Error("response lost after successful create"); };
    await execute(store);
    expect(store.stats().creates).toBe(1);
    store.unavailable = true;
    await expect(execute(store)).resolves.toBeDefined();
    expect(store.stats().warnings).toBe(1);
  });
  it("keeps the writer isolated, non-fatal and limited to same-repo PRs", () => {
    const job = workflow.jobs.comment;
    expect(job.permissions).toEqual({ "pull-requests": "write" });
    expect(job.needs).toEqual(["opening"]);
    expect(job.if).toBe("${{ always() && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && needs.opening.result != 'skipped' }}");
    expect(job["continue-on-error"]).toBe(true);
    expect(job["timeout-minutes"]).toBe(3);
    expect(job.steps).toHaveLength(1);
    expect(job.steps[0]["continue-on-error"]).toBe(true);
    expect(job.steps[0].uses).toMatch(/^actions\/github-script@[0-9a-f]{40}$/);
    const opening = workflow.jobs.opening;
    expect(opening.permissions).toBeUndefined();
    for (const [output, id] of [["demo", "upload_demo"], ["videos", "upload_videos"], ["results", "upload_results"]]) {
      expect(opening.outputs[output!]).toBe(`\u0024{{ steps.${id}.outputs.artifact-url }}`);
      expect(opening.steps.find((step: { id?: string }) => step.id === id).uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    }
    const summary = opening.steps.find((step: { id?: string }) => step.id === "comment_summary");
    expect(summary.if).toBe("always()");
    expect(summary["continue-on-error"]).toBe(true);
    expect(summary.run).toContain("opening-reports/sanitized/scenario-steps.json");
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|pull_request_target/);
  });
});
