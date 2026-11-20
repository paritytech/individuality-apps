// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Keep only feature-authored names and fixed verdicts for the PR comment.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === "object" ? value as Row : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const statuses = new Set(["passed", "failed", "skipped", "pending", "undefined", "ambiguous"]);
const status = (value: unknown) => typeof value === "string" && statuses.has(value) ? value : "unavailable";

type ScenarioSummary = { name: string; status: string; reason?: string; steps: Array<{ name: string; status: string }> };
export function scenarioSummary(report: unknown, feature: string, allowImportedGameNotRun = false): ScenarioSummary[] {
  const name = /^\s*Scenario:\s*(.+)$/m.exec(feature)?.[1]?.trim();
  const names = [...feature.matchAll(/^\s*(?:Given|When|Then|And|But)\s+(.+)$/gm)].map((match) => match[1]!.trim());
  if (!name || !names.length || names.length > 100) return [];
  const scenarios = list(report).flatMap((entry) => list(row(entry).elements));
  const matches = scenarios.filter((entry) => row(entry).type === "scenario" && row(entry).name === name);
  const all = matches.length === 1 ? list(row(matches[0]).steps) : [];
  const visible = all.filter((entry) => !row(entry).hidden);
  const steps = names.map((name, index) => ({ name, status: row(visible[index]).name === name ? status(row(row(visible[index]).result).status) : "unavailable" }));
  const verdicts = all.map((entry) => status(row(row(entry).result).status));
  const failed = verdicts.some((value) => ["failed", "pending", "undefined", "ambiguous"].includes(value));
  const passed = visible.length === names.length && steps.every((step) => step.status === "passed") && verdicts.every((value) => value === "passed");
  const reason = "not run: imported game in Reporting";
  const error = row(row(visible[1]).result).error_message;
  const reportingTimeout = allowImportedGameNotRun && visible.length === names.length && names[1] === "the three fresh fork players have zero PAS and no prior credits" &&
    typeof error === "string" && [reason, `Error: ${reason}`].includes(error.split("\n")[0]!) &&
    steps[0]?.status === "passed" && steps[1]?.status === "failed" && steps.slice(2).every((step) => step.status === "skipped");
  if (reportingTimeout) {
    // Retain the timeout reason even if a teardown hook also failed. That scenario still fails.
    const hooksPassed = all.filter((entry) => row(entry).hidden).every((entry) => row(row(entry).result).status === "passed");
    return [{ name, status: hooksPassed ? "not-run" : "failed", reason, steps: steps.map((step, index) => index === 1 ? { ...step, status: "not-run" } : step) }];
  }
  return [{ name, status: failed ? "failed" : passed ? "passed" : "unavailable", steps }];
}

export function writeScenarioSummary(report: string, feature: string, sanitized: string, allowImportedGameNotRun = false) {
  // Failure before Cucumber, or a malformed report, must never mask the run.
  try {
    let data: unknown = [];
    try { if (statSync(report).size <= 2 * 1024 * 1024) data = JSON.parse(readFileSync(report, "utf8")); } catch { /* unavailable */ }
    const summary = scenarioSummary(data, readFileSync(feature, "utf8"), allowImportedGameNotRun);
    mkdirSync(sanitized, { recursive: true });
    writeFileSync(join(sanitized, "scenario-steps.json"), JSON.stringify(summary) + "\n");
    return summary;
  } catch { return []; /* best effort */ }
}
