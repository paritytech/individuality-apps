// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
const root = resolve(import.meta.dirname, '../../..');
const workflow = parse(readFileSync(join(root, '.github/workflows/cross-app-lab.yml'), 'utf8'));
function plan(event: string, c6 = 'true'): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'cross-app-plan-control-'));
  try {
    const output = join(dir, 'output'); writeFileSync(output, '');
    execFileSync('bash', ['-c', workflow.jobs.plan.steps.find((s: { id?: string }) => s.id === 'plan').run], { cwd: root, env: { ...process.env, EVENT: event, CROSS_APP_C6_ON_PR: c6, GITHUB_OUTPUT: output } });
    return JSON.parse(readFileSync(output, 'utf8').replace(/^runs=/, '')).map((l: { id: string }) => l.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
it('plans each PR scenario once, the optional PR loop and only the full loop nightly', () => {
  const runs = plan('pull_request');
  expect(runs).toHaveLength(11); expect(new Set(runs).size).toBe(11);
  expect(runs).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'b1', 'b2', 'b3', 'u3', 'u4'].map(c => `${c}-1`).concat('c6-1'));
  expect(plan('schedule')).toEqual(['c6-1']); expect(plan('schedule', 'false')).toEqual(['c6-1']);
  expect(plan('pull_request', 'false')).toHaveLength(10);
  expect(plan('pull_request', 'false')).toEqual(runs.filter(id => id !== 'c6-1'));
});
function contract(w: typeof workflow) {
  const leg = w.jobs.runs;
  if (!leg.needs.includes('build') || leg.strategy['max-parallel'] !== "${{ github.event_name == 'pull_request' && 11 || 8 }}") throw Error('Shared build or bounded concurrency missing');
  const artifact = leg.steps.find((s: { with?: { name?: string } }) => s.with?.name?.startsWith('cross-app-build-'));
  if (!artifact?.with.name.includes('github.sha') || leg.steps.some((s: { run?: string }) => /npm run.*build/.test(s.run ?? ''))) throw Error('Commit-keyed shared app build missing');
  if (leg.strategy['fail-fast'] !== false || !leg.env.HUMANITY_SCENARIOS_FORK_DIRECTORY || !leg.env.HUMANITY_SCENARIOS_SETUP.includes('fast')) throw Error('Leg isolation/setup missing');
  const prepare = leg.steps.findIndex((s: { name?: string }) => s.name === 'Prepare pinned Engine, CLI host and Chromium');
  const controls = leg.steps.findIndex((s: { name?: string }) => s.name === 'Recorder and report controls');
  if (prepare < 0 || controls <= prepare || leg.steps[controls].env?.CROSS_APP_BROWSER_CONTROLS !== '1') throw Error('Prepared browser controls missing');
  if (leg.steps[controls].if !== "matrix.id == 'c3-1' || github.event_name == 'schedule'") throw Error('Recorder controls must cover the PR entry and nightly loop');
  if (leg['timeout-minutes'] !== '${{ matrix.timeout }}') throw Error('Per-run timeout budget missing');
  const checks = w.jobs.build.steps.filter((s: { run?: string }) => s.run?.includes('tsconfig.scenarios.json'));
  if (checks.length !== 1 || leg.steps.some((s: { run?: string }) => s.run?.includes('tsconfig.scenarios.json'))) throw Error('Script type-check must run once before scenario jobs');
  if (w.jobs.build['runs-on'] !== 'ubuntu-latest') throw Error('Build needs a GitHub-hosted runner');
  if (!leg.steps.some((s: { with?: { path?: string } }) => s.with?.path?.includes('/transactions.jsonl'))) throw Error('Sanitized transaction artifact missing');
  const restore = leg.steps.find((s: { id?: string }) => s.id === 'bundle_cache');
  if (!restore?.with?.key.includes('cross-app-paseo-bundle-') || !restore.with.key.includes('needs.bundle.outputs.asset-key')) throw Error('Pinned per-PR bundle cache missing');
  if (w.permissions.contents !== 'read' || w.jobs.comment.permissions['pull-requests'] !== 'write' || Object.keys(leg.permissions ?? {}).length) throw Error('Unexpected permissions');
  if (w.jobs.summarize.steps.find((s: { with?: { pattern?: string } }) => s.with?.pattern === 'cross-app-data-*')?.['continue-on-error'] !== true || w.jobs.summarize.steps.find((s: { name?: string }) => s.name?.startsWith('Merge real timing'))?.if !== 'always()') throw Error('Missing-leg comment fallback missing');
  return true;
}
it('keeps the workflow isolation, pinned bundle, script check and comment-only write permission', () => expect(contract(workflow)).toBe(true));
it('@negative-control: rejects missing typecheck, shared bundle key and missing copy isolation', () => {
  const w = structuredClone(workflow); w.jobs.build.steps = w.jobs.build.steps.filter((s: { run?: string }) => !s.run?.includes('tsconfig.scenarios.json'));
  expect(() => contract(w)).toThrow('type-check');
  const cache = structuredClone(workflow); cache.jobs.runs.steps.find((s: { id?: string }) => s.id === 'bundle_cache').with.key = 'shared';
  expect(() => contract(cache)).toThrow('cache');
  const copy = structuredClone(workflow); delete copy.jobs.runs.env.HUMANITY_SCENARIOS_FORK_DIRECTORY;
  expect(() => contract(copy)).toThrow('isolation');
  const evidence = structuredClone(workflow);
  evidence.jobs.runs.steps.find((s: { with?: { path?: string } }) => s.with?.path?.includes('/transactions.jsonl')).with.path = 'dataset.json';
  expect(() => contract(evidence)).toThrow('transaction artifact');
  const missing = structuredClone(workflow); delete missing.jobs.summarize.steps.find((s: { with?: { pattern?: string } }) => s.with?.pattern === 'cross-app-data-*')['continue-on-error'];
  expect(() => contract(missing)).toThrow('fallback');
});
it('seals the inherited upstream instrumentation patch and records its retirement', () => {
  const folder = join(root, 'patches/humanity-jollity-scarcity-e2e');
  const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
  for (const p of manifest.patches) {
    expect(createHash('sha256').update(readFileSync(join(folder, p.file))).digest('hex')).toBe(p.sha256);
    expect(p.base).toMatch(/^[0-9a-f]{40}$/); expect(p.reason).toBeTruthy(); expect(p['retire-when']).toBeTruthy();
    expect(createHash('sha256').update(readFileSync(join(root, p.destination))).digest('hex')).toBe(p.destinationSha256);
  }
});

it('@negative-control: refuses skipped browser preparation and a missing per-run timeout budget', () => {
  const wrong = structuredClone(workflow), steps = wrong.jobs.runs.steps;
  const prepare = steps.findIndex((s: { name?: string }) => s.name === 'Prepare pinned Engine, CLI host and Chromium');
  const controls = steps.findIndex((s: { name?: string }) => s.name === 'Recorder and report controls');
  [steps[prepare], steps[controls]] = [steps[controls], steps[prepare]];
  expect(() => contract(wrong)).toThrow('Prepared browser controls');
  const nightly = structuredClone(workflow); nightly.jobs.runs.steps[controls].if = "matrix.id == 'c3-1'";
  expect(() => contract(nightly)).toThrow('nightly loop');
  const budget = structuredClone(workflow); budget.jobs.runs['timeout-minutes'] = 120;
  expect(() => contract(budget)).toThrow('timeout budget');
});

it('@negative-control: refuses an unpinned app artifact or unbounded runner concurrency', () => {
  const artifact = structuredClone(workflow);
  artifact.jobs.runs.steps.find((s: { with?: { name?: string } }) => s.with?.name?.startsWith('cross-app-build-')).with.name = 'cross-app-build-latest';
  expect(() => contract(artifact)).toThrow('Commit-keyed');
  const parallel = structuredClone(workflow); delete parallel.jobs.runs.strategy['max-parallel'];
  expect(() => contract(parallel)).toThrow('bounded concurrency');
});

it('@negative-control: refuses self-hosted builds and repeated strict script checks', () => {
  const hosted = structuredClone(workflow); hosted.jobs.build['runs-on'] = 'self-hosted';
  expect(() => contract(hosted)).toThrow('GitHub-hosted');
  const repeated = structuredClone(workflow);
  repeated.jobs.runs.steps.push({ run: 'node_modules/.bin/tsc --noEmit -p apps/humanity-app/tsconfig.scenarios.json' });
  expect(() => contract(repeated)).toThrow('once');
});
