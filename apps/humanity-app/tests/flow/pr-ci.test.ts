// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const workflow = parse(read('.github/workflows/humanity-dim2-flow.yml'));
const gate = workflow.jobs.sources.steps[0].run as string;
const condition = workflow.jobs.flow.if as string;
const repository = 'paritytech/individuality-apps';
function changed(files: string[], script = gate): boolean {
  const offline = script.replace(/files=\$\(gh api[^\n]+\)/, 'files="$1"').replace(/ >> "\$GITHUB_OUTPUT"/g, '');
  return execFileSync('bash', ['-c', offline, 'flow-path-test', files.join('\n')], { encoding: 'utf8' }).trim() === 'changed=true';
}
function runs(event: string, { action = 'synchronize', label = '', labels = [] as string[], fork = false, path = false, cancelled = false } = {}, expression = condition): boolean {
  const source = expression.replace(/^\$\{\{ | \}\}$/g, '').replace('github.event.pull_request.labels.*.name', 'github.event.pull_request.labels');
  const github = { event_name: event, repository, event: { action, label: { name: label }, pull_request: { number: 1, labels, head: { repo: { full_name: fork ? 'other/fork' : repository } } } } };
  return new Function('github', 'needs', 'contains', 'cancelled', `return ${source}`)(github, { sources: { outputs: { changed: String(path) } } }, (values: string[], value: string) => values.includes(value), () => cancelled);
}
it('executes the path classifier on flow inputs and shared imports, leaving app-only and lock changes opt-in', () => {
  for (const file of [
    'lab/shared/host.ts', 'lab.config.ts', 'apps/humanity-app/lab/flows/humanity-dim2.feature', 'lab/shared/upstream/lab/steps/humanity/bootstrap/imported-games.ts',
    'lab/shared/upstream/lab/steps/dim2/live-game.ts', 'apps/humanity-app/lab/flows/steps.ts',
    'apps/humanity-app/lab/opening/session.ts', 'apps/humanity-app/scripts/lab/flow.mts', 'apps/humanity-app/lab.flow.config.ts',
    '.github/workflows/humanity-dim2-flow.yml', '.github/lab-scenario-summary.mts', '.github/lab-demo-summary.mts',
  ]) expect(changed([file]), file).toBe(true);
  for (const file of ['package-lock.json', 'package.json', '.nvmrc', 'apps/humanity-app/src/app.tsx', 'apps/jollity-app/app/page.tsx', 'apps/humanity-app/lab/opening/steps.ts', 'apps/humanity-app/scripts/lab/flow.mts.backup']) expect(changed([file]), file).toBe(false);
  expect(changed([])).toBe(false);
  expect(changed(['package-lock.json', 'apps/humanity-app/lab/flows/steps.ts'])).toBe(true);
});
it('evaluates label, event, path, fork and cancellation combinations using the actual job gate', () => {
  expect(workflow.on.pull_request).toEqual({ branches: ['main'], types: ['labeled', 'synchronize', 'reopened', 'opened'] });
  for (const action of workflow.on.pull_request.types) for (const label of ['', 'unrelated', 'run-dim2-flow']) for (const optedIn of [false, true]) for (const path of [false, true]) for (const fork of [false, true]) {
    const labels = optedIn ? ['run-dim2-flow'] : [];
    const expected = !fork && (action !== 'labeled' || label === 'run-dim2-flow') && (optedIn || path);
    expect(runs('pull_request', { action, label, labels, path, fork }), JSON.stringify({ action, label, labels, path, fork })).toBe(expected);
  }
  for (const event of ['push', 'workflow_dispatch']) expect(runs(event)).toBe(true);
  for (const event of ['schedule', 'pull_request_target']) expect(runs(event, { path: true })).toBe(false);
  expect(runs('pull_request', { path: true, cancelled: true })).toBe(false);
  const sources = new Function('github', `return ${workflow.jobs.sources.if}`);
  for (const fork of [false, true]) for (const action of ['opened', 'labeled']) for (const label of ['unrelated', 'run-dim2-flow']) {
    expect(sources({ event_name: 'pull_request', repository, event: { action, label: { name: label }, pull_request: { head: { repo: { full_name: fork ? 'other/fork' : repository } } } } })).toBe(!fork && (action !== 'labeled' || label === 'run-dim2-flow'));
  }
});
it('@negative-control removing the label gate starts an unlabelled unrelated PR and violates the matrix', () => {
  const mutant = condition.replace("contains(github.event.pull_request.labels.*.name, 'run-dim2-flow')", 'true');
  expect(mutant).not.toBe(condition);
  expect(runs('pull_request')).toBe(false);
  expect(runs('pull_request', {}, mutant)).toBe(true);
});
it('uses the large runner for all flow events and preserves main and dispatch queues outside the comment group', () => {
  const { flow, sources, comment } = workflow.jobs;
  expect(flow['runs-on']).toBe("${{ vars.DIM2_FLOW_RUNNER || 'ubuntu-24.04' }}");
  expect(flow['timeout-minutes']).toBe(120);
  expect(flow.steps.find((step: { id?: string }) => step.id === 'flow')['timeout-minutes']).toBe(50);
  expect(workflow.concurrency).toBeUndefined();
  expect(sources.concurrency).toEqual(flow.concurrency);
  expect(flow.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  const group = flow.concurrency.group as string;
  const evaluate = new Function('github', 'format', `return ${group.slice(group.indexOf('${{') + 3, -2)}`);
  for (const [event, ref, number, expected] of [['pull_request', 'refs/pull/4/merge', 4, 'pr-4'], ['pull_request', 'refs/pull/5/merge', 5, 'pr-5'], ['push', 'refs/heads/main', 0, 'main'], ['workflow_dispatch', 'refs/heads/main', 0, 'dispatch-refs/heads/main'], ['workflow_dispatch', 'refs/heads/topic', 0, 'dispatch-refs/heads/topic']]) {
    expect(evaluate({ event_name: event, ref, event: { pull_request: { number } } }, (template: string, value: string) => template.replace('{0}', value))).toBe(expected);
  }
  expect(comment.concurrency).toEqual({ group: 'lab-opening-comment-${{ github.event.pull_request.number }}', 'cancel-in-progress': false });
  expect(flow.env.NEGATIVE_CONTROL).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.negative_control }}");
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(sources.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  expect(flow.permissions).toBeUndefined();
  expect(comment.permissions).toEqual({ 'pull-requests': 'write' });
});
it('uploads only media and the sanitized directory, with G3 applied to every upload path', () => {
  const uploads = workflow.jobs.flow.steps.filter((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@'));
  expect(uploads.map((step: { with: { name: string } }) => step.with.name)).toEqual(['humanity-dim2-demo', 'humanity-dim2-videos', 'humanity-dim2-results-${{ github.run_id }}']);
  expect(uploads.map((step: { with: { path: string } }) => step.with.path.trim())).toEqual([
    ['mp4', 'webm', 'vtt'].map(ext => `artifacts/humanity-dim2-demo/**/*.${ext}`).concat('artifacts/humanity-dim2-demo/**/slide.png').join('\n'),
    'artifacts/humanity-dim2-recordings/**/videos/', 'apps/humanity-app/.product-lab/flow-reports/sanitized/',
  ]);
  // G3 expressed in pieces so the test source itself remains portable.
  const g3 = new RegExp(['/' + 'Users/', 'hadikh' + 'airallah', '/opt/' + 'homebrew', 'Cell' + 'ar', '/private/' + 'var', '/' + 'tmp/'].join('|'));
  for (const upload of uploads) {
    expect(upload.with.path).not.toMatch(g3);
    expect(upload.with.path).not.toMatch(/transactions|attachments|node-logs|phase-record|recording\.json|command-report|flow-edit/);
  }
  const runner = read('apps/humanity-app/scripts/lab/flow.mts');
  expect(runner).not.toContain('publicReport');
  expect(runner).toContain('if (mode === "run") resetRunReports(reports);');
});


it('sets up the same pinned Bun as both openings before acquiring host tooling', () => {
  const steps = workflow.jobs.flow.steps as Array<{ uses?: string; with?: unknown; name?: string }>;
  const setup = steps.find(step => step.uses?.startsWith('oven-sh/setup-bun@'));
  expect(setup).toMatchObject({ uses: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6', with: { 'bun-version': '1.4.2' } });
  for (const product of ['humanity', 'jollity']) {
    const opening = parse(read(`.github/workflows/${product}-lab.yml`));
    expect(setup).toEqual(opening.jobs.opening.steps.find((step: { uses?: string }) => step.uses?.startsWith('oven-sh/setup-bun@')));
  }
  expect(steps.indexOf(setup!)).toBeGreaterThan(steps.findIndex(step => step.uses?.startsWith('actions/setup-node@')));
  expect(steps.indexOf(setup!)).toBeLessThan(steps.findIndex(step => step.name === 'Prepare locked tooling'));
});


it('fits the sum of explicit step caps inside the job budget with upload and setup headroom', () => {
  const flow = workflow.jobs.flow;
  const minutes = flow.steps.reduce((sum: number, step: { 'timeout-minutes'?: number }) => sum + (step['timeout-minutes'] ?? 0), 0);
  expect(minutes).toBe(105);
  expect(flow['timeout-minutes']).toBeGreaterThanOrEqual(minutes + 15);
});

it('@negative-control lowering the real workflow job budget loses the required reserve', () => {
  const yaml = read('.github/workflows/humanity-dim2-flow.yml');
  const lowered = yaml.replace('timeout-minutes: 120', 'timeout-minutes: 90');
  expect(lowered).not.toBe(yaml);
  const flow = parse(lowered).jobs.flow;
  const minutes = flow.steps.reduce((sum: number, step: { 'timeout-minutes'?: number }) => sum + (step['timeout-minutes'] ?? 0), 0);
  expect(flow['timeout-minutes']).toBeLessThan(minutes + 15);
});
