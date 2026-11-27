// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { flowDemoStatus, writeFlowDemoStatus } from '../../../../.github/lab-demo-summary.mts';
const run = 'https://github.com/paritytech/individuality-apps/actions/runs/123';
it('requires both a successful cut and an artifact from this run before claiming a demo was produced', () => {
  expect(flowDemoStatus('success', `${run}/artifacts/1`, run)).toBe('produced');
  for (const outcome of ['failure', 'skipped', '', undefined]) expect(flowDemoStatus(outcome, `${run}/artifacts/1`, run)).toBe('not produced');
  for (const url of ['', undefined, `${run}0/artifacts/1`, 'https://elsewhere.invalid/1']) expect(flowDemoStatus('success', url, run)).toBe('not produced');
});
it('writes missing-demo status to the step summary and sanitized results while leaving the journey passed', () => {
  const base = mkdtempSync(join(tmpdir(), 'flow-demo-status-'));
  try {
    const output = join(base, 'output'), summary = join(base, 'summary'); writeFileSync(output, ''); writeFileSync(summary, '');
    expect(writeFlowDemoStatus({ outcome: 'failure', url: '', runUrl: run, journey: 'success', directory: base, output, summary })).toBe('not produced');
    expect(JSON.parse(readFileSync(join(base, 'demo-status.json'), 'utf8'))).toEqual({ demo: 'not produced', journey: 'PASS' });
    expect(readFileSync(output, 'utf8')).toContain('demo_status=not produced');
    expect(readFileSync(summary, 'utf8')).toContain('Journey: **PASS**');
    expect(readFileSync(summary, 'utf8')).toContain('Demo: **not produced**');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
it('wires the actual cut outcome and uploaded demo into the always-run summary before results upload', () => {
  const workflow = parse(readFileSync(new URL('../../../../.github/workflows/humanity-dim2-flow.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.flow.steps;
  const cut = steps.find((step: { id?: string }) => step.id === 'demo'), summary = steps.find((step: { id?: string }) => step.id === 'comment_summary');
  expect(cut['continue-on-error']).toBe(true);
  expect(summary.if).toBe('always()'); expect(summary['continue-on-error']).toBe(true);
  expect(summary.env).toEqual({ DEMO_OUTCOME: '${{ steps.demo.outcome }}', DEMO_URL: '${{ steps.upload_demo.outputs.artifact-url }}', FLOW_OUTCOME: '${{ steps.flow.outcome }}' });
  expect(summary.run).toContain('writeFlowDemoStatus(');
  expect(steps.indexOf(summary)).toBeLessThan(steps.findIndex((step: { id?: string }) => step.id === 'upload_results'));
  expect(workflow.jobs.flow.outputs.demo_status).toBe('${{ steps.comment_summary.outputs.demo_status }}');
  expect(workflow.jobs.comment.steps[0].env.DEMO_STATUS).toBe('${{ needs.flow.outputs.demo_status }}');
});


it.each([
  ['success', [], 'PASS'],
  ['failure', [{ status: 'not-run', reason: 'not run: imported game in Reporting' }], 'NOT RUN: imported game in Reporting'],
  ['failure', [{ status: 'failed', reason: 'not run: imported game in Reporting' }], 'FAIL (not run: imported game in Reporting)'],
] as const)('the actual Node 24 workflow summary renders %s with scenario evidence', (journey, scenarios, label) => {
  const base = mkdtempSync(join(tmpdir(), 'flow-summary-command-'));
  try {
    const root = join(base, 'repo');
    mkdirSync(join(root, '.github'), { recursive: true });
    copyFileSync(new URL('../../../../.github/lab-demo-summary.mts', import.meta.url), join(root, '.github/lab-demo-summary.mts'));
    const workflow = parse(readFileSync(new URL('../../../../.github/workflows/humanity-dim2-flow.yml', import.meta.url), 'utf8'));
    const summary = workflow.jobs.flow.steps.find((step: { id?: string }) => step.id === 'comment_summary');
    const sanitized = join(root, 'apps/humanity-app/.product-lab/flow-reports/sanitized');
    mkdirSync(sanitized, { recursive: true });
    writeFileSync(join(sanitized, 'scenario-steps.json'), JSON.stringify(scenarios));
    const output = join(base, 'output'), status = join(base, 'summary'); writeFileSync(output, ''); writeFileSync(status, '');
    execFileSync('bash', ['-c', summary.run], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: status,
      GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'paritytech/individuality-apps', GITHUB_RUN_ID: '123',
      DEMO_OUTCOME: 'failure', DEMO_URL: '', FLOW_OUTCOME: journey } });
    expect(readFileSync(output, 'utf8')).toContain('demo_status=not produced');
    expect(readFileSync(status, 'utf8')).toContain(`Journey: **${label}**`);
    expect(JSON.parse(readFileSync(join(sanitized, 'demo-status.json'), 'utf8')).journey).toBe(label);
    expect(readFileSync(status, 'utf8')).toContain('Demo: **not produced**');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
