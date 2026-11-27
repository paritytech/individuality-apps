// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { execFileSync } from 'node:child_process';
import { assertScenarioReport, scenarioNames, scenarioSummary } from '../../lab/scenarios/report.ts';
import { playReason } from '../../lab/scenarios/pending.ts';
const root = resolve(import.meta.dirname, '../../../..');
const workflow = parse(readFileSync(resolve(root, '.github/workflows/jollity-lab.yml'), 'utf8'));
const step = (name: string, status = 'passed', extra = {}) => ({ name, result: { status }, ...extra });
function report(pending = false) {
  const name = pending ? 'Three players play one DIM2 game and their reports are finalized' : 'Ada registers in DIM2 on the free route';
  return [{ elements: [{ type: 'scenario', name, steps: [step('Before', 'passed', { hidden: true }), step('Ada is a new actor'),
    ...pending ? [step('Alice, Bob and Carol are new actors registered for the game by transaction', 'pending', { embeddings: [{ mime_type: 'application/json', data: Buffer.from(JSON.stringify({ pending: playReason })).toString('base64') }] }), step('play', 'skipped')] : [step('register')],
    step('After', 'passed', { hidden: true })] }] }];
}
it('runs Jollity lab tests, one verified bundle and fresh scenario legs without a new send job', () => {
  expect(workflow.name).toBe('Jollity lab opening and scenarios');
  expect(workflow.on.workflow_dispatch.inputs.negative_control.description).toContain('wrong registered home scenario');
  expect(workflow.jobs.unit.name).toBe('Jollity lab tests');
  const unit = JSON.stringify(workflow.jobs.unit.steps);
  for (const command of ['jollity:lab:check', 'lab:check', 'actionlint']) expect(unit).toContain(command);
  // ci.yml runs the shipping Jollity tests; this workflow does not repeat them.
  expect(unit).not.toContain('test:lib');
  expect(workflow.jobs['scenario-bundle'].name).toBe('Pin the Paseo bundle for the scenario legs');
  expect(workflow.jobs.scenarios.name).toBe('Jollity scenario: ${{ matrix.name }}');
  const legs = JSON.stringify(workflow.jobs.scenarios.steps);
  for (const command of ['--dry-run', 'bundle-install', '--own-lab', '--video', 'classify', 'cleanup', 'retention-days']) expect(legs).toContain(command);
  expect(legs).not.toContain('humanity-app');
  const run = workflow.jobs.scenarios.steps.find((step: { id?: string }) => step.id === 'leg').run;
  expect(run.indexOf('rm -rf -- "$LEG_REPORTS"')).toBeLessThan(run.indexOf('node_modules/.bin/product-lab test'));
  expect(workflow.jobs.scenarios.steps.find((step: { name?: string }) => step.name === 'Clean up owned processes').if).toBe('always()');
  expect(workflow.jobs.scenarios.env.PRODUCT_LAB_LAB).toBe('jollity-scenarios');
  expect(workflow.jobs.scenarios.env.BUNDLE_SHA256).toContain('needs.scenario-bundle.outputs.manifest-sha256');
  expect(workflow.permissions).toEqual({ contents: 'read' });
  for (const name of ['sources', 'unit', 'scenario-legs', 'scenario-bundle', 'scenarios']) expect(JSON.stringify(workflow.jobs[name])).not.toMatch(/npm publish|pull-requests.*write|issues.*write|gh pr|git push/);
});
const gatePattern = () => /lab='([^']+)'/.exec(workflow.jobs.sources.steps[0].run as string)![1]!;
const changed = (file: string) => { try { execFileSync('grep', ['-qE', gatePattern()], { input: file + '\n' }); return true; } catch { return false; } };
/** Evaluate a job's `if` for one event, with GitHub's operators, which JavaScript shares here. */
function admits(expression: string, event: { name: string; action?: string; changed?: string }) {
  const body = expression.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').replaceAll('!cancelled()', 'true');
  const github = { event_name: event.name, repository: 'paritytech/individuality-apps',
    event: { action: event.action, pull_request: { head: { repo: { full_name: 'paritytech/individuality-apps' } } } } };
  return Boolean(new Function('github', 'needs', `return ${body}`)(github, { sources: { outputs: { changed: event.changed } } }));
}
it('gates the lab tests on lab paths, cancels superseded pushes and never runs them on a label event', () => {
  const { sources, unit } = workflow.jobs;
  expect(workflow.on.pull_request.types).toContain('opened');
  expect(unit.needs).toEqual(['sources']);
  expect(unit.concurrency.group).toBe(sources.concurrency.group);
  expect(unit.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  for (const action of ['opened', 'synchronize', 'reopened']) {
    expect(admits(sources.if, { name: 'pull_request', action }), action).toBe(true);
    expect(admits(unit.if, { name: 'pull_request', action, changed: 'true' }), action).toBe(true);
    expect(admits(unit.if, { name: 'pull_request', action, changed: 'false' }), action).toBe(false);
  }
  // A label adds no commit: neither job joins the shared group, so no label cancels a push's lab tests.
  expect(admits(sources.if, { name: 'pull_request', action: 'labeled' })).toBe(false);
  expect(admits(unit.if, { name: 'pull_request', action: 'labeled', changed: 'true' })).toBe(false);
  expect(admits(unit.if, { name: 'workflow_dispatch' })).toBe(true);
});
it('gives the leg the read-only token the Engine fork tooling needs, and keeps its logs on failure', () => {
  // Without it ppn stops at start ("no GitHub token") and the Engine exits before readiness.
  const leg = workflow.jobs.scenarios.steps.find((step: { id?: string }) => step.id === 'leg');
  expect(leg.env).toMatchObject({ GH_TOKEN: '${{ github.token }}', GITHUB_TOKEN: '${{ github.token }}' });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(leg.run).toContain('paseo-copy/processes/*.log');
});
it('fails the legs instead of skipping them when the lab tests failed or were cancelled', () => {
  const { scenarios } = workflow.jobs;
  expect(scenarios.if).not.toContain('needs.unit');
  const guard = scenarios.steps[0];
  expect(guard.name).toBe('Require the lab tests to have passed or been skipped');
  expect(scenarios.needs).toContain('sources');
  const exit = (result: string, sources = 'success') => { try { execFileSync('bash', ['-c', guard.run], { env: { ...process.env, UNIT_RESULT: result, SOURCES_RESULT: sources }, stdio: 'pipe' }); return 0; } catch { return 1; } };
  expect(exit('success')).toBe(0); expect(exit('skipped')).toBe(0);
  expect(exit('cancelled')).toBe(1); expect(exit('failure')).toBe(1);
  // A failed path check skips the lab tests; the legs must fail rather than run on an unproven lab.
  expect(exit('skipped', 'skipped')).toBe(0);
  expect(exit('skipped', 'failure')).toBe(1); expect(exit('skipped', 'cancelled')).toBe(1);
});
it('runs the gate pattern on every path the Jollity lab tests read, and not on shipping app code', () => {
  for (const file of ['lab/shared/post-game.ts', 'lab.config.ts', 'apps/jollity-app/lab/scenarios/steps.ts', 'apps/jollity-app/tests/lab/chest-read.test.ts',
    'apps/jollity-app/scripts/lab/scenarios-ci.mts', 'apps/jollity-app/lab.opening.config.ts', 'apps/jollity-app/tsconfig.lab.json', 'apps/jollity-app/tsconfig.json',
    '.github/workflows/jollity-lab.yml', '.github/workflows/ci.yml', '.github/workflows/deploy.yml', '.github/workflows/release.yml', '.github/workflows/humanity-lab.yml',
    'scripts/ci/changes.mjs', 'scripts/ci/visual/changes.mjs', 'scripts/ci/bundle-sources.txt', '.github/lab-scenario-summary.mts',
    'apps/humanity-app/tests/flow/fixtures/chest-observation.mts', 'apps/humanity-app/lab/opening/host.lock.json', 'packages/jollity-protocol/src/local-network.mjs', 'packages/jollity-protocol/src/local-network.d.mts', 'apps/humanity-app/deploy/bulletin-deploy.config.ts', 'package-lock.json', '.nvmrc'])
    expect(changed(file), file).toBe(true);
  for (const file of ['apps/jollity-app/app/page.tsx', 'apps/jollity-app/lib/chest-collect.ts', 'packages/jollity-protocol/src/index.ts', 'apps/humanity-app/deploy/icon.png', 'packages/jollity-game-chain/src/index.ts', 'apps/humanity-app/lab/flows/post-game.ts', '.github/workflows/humanity-ci.yml', 'README.md'])
    expect(changed(file), file).toBe(false);
  // Every file the tests import or read directly outside this app's lab must be in the gate.
  const tests = resolve(root, 'apps/jollity-app/tests/lab'), read = new Set<string>();
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  for (const file of walk(tests)) {
    const text = readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(/(?:from |import\(|new URL\(|resolve\(import\.meta\.dirname, )['"](\.\.?\/[^'"]+)['"]/g)) read.add(relative(root, resolve(dirname(file), spec!)));
    for (const [, spec] of text.matchAll(/(?:\bfile\(|resolve\(root, )['"]([^'"$]+)['"]\)/g)) read.add(spec!);
  }
  for (const name of ['ci', 'deploy', 'release']) read.add(`.github/workflows/${name}.yml`);
  const outside = [...read].filter(file => file && existsSync(resolve(root, file)) && !file.startsWith('apps/jollity-app/tests/lab'));
  expect(outside.length).toBeGreaterThan(10);
  for (const file of outside) expect(changed(file), file).toBe(true);
});
it('writes passed and pending counts, and the pending rows, to the run summary', () => {
  const good = report(true), summary = assertScenarioReport(good, [good[0]!.elements[0]!.name]);
  expect(summary.pendingRows).toEqual(['Three players play one DIM2 game and their reports are finalized']);
  const text = scenarioSummary('Play, prize and permission capability checks (B3, B5, B6)', summary);
  expect(text).toContain('**0 passed, 1 pending** of 1 rows');
  expect(text).toContain('- Pending: Three players play one DIM2 game and their reports are finalized');
  expect(text).toContain(JSON.stringify(summary));
  expect(scenarioSummary('<b>', { ...summary, pending: 0, pendingRows: [] })).not.toMatch(/<|Pending:/);
  expect(JSON.stringify(workflow.jobs.scenarios.steps)).toContain('LEG_NAME');
});
it('classifies supported steps only when every step and hook passed', () => {
  const good = report();
  expect(assertScenarioReport(good, [good[0]!.elements[0]!.name])).toMatchObject({ passed: 1, pending: 0, result: 'passed' });
  for (const index of [0, 1, 2, 3]) {
    const bad = report(); bad[0]!.elements[0]!.steps[index]!.result.status = 'failed';
    expect(() => assertScenarioReport(bad, [bad[0]!.elements[0]!.name])).toThrow();
  }
});
it('negative control rejects missing rows, undeclared pending and a lost pending reason', () => {
  const good = report(true), name = good[0]!.elements[0]!.name;
  expect(assertScenarioReport(good, [name])).toMatchObject({ result: 'pending', passed: 0, pending: 1 });
  expect(() => assertScenarioReport(good, scenarioNames)).toThrow('Missing, extra or duplicate');
  const bad = report(true); bad[0]!.elements[0]!.steps[2]!.result.status = 'passed';
  expect(() => assertScenarioReport(bad, [name])).toThrow('declared pending');
  const missing = report(true); delete (missing[0]!.elements[0]!.steps[2] as { embeddings?: unknown }).embeddings;
  expect(() => assertScenarioReport(missing, [name])).toThrow('reason was not recorded');
  const setup = report(true); setup[0]!.elements[0]!.steps[1]!.result.status = 'failed';
  expect(() => assertScenarioReport(setup, [name])).toThrow('declared pending');
});
it('requires the exact wrong-home assertion and never accepts infrastructure failure', () => {
  const make = (message: string) => [{ elements: [{ type: 'scenario', name: 'An idle chain cannot back the registered home', steps: [step('Before', 'passed', { hidden: true }), step('new'), step('setup'), step('open'),
    { name: 'Ada sees DIM2 home in state "registered"', result: { status: 'failed', error_message: message } }, step('After', 'passed', { hidden: true })] }] }];
  const name = 'An idle chain cannot back the registered home';
  expect(assertScenarioReport(make('not-on-chain: Finalized DIM2 setup does not back registered'), [name], true)).toMatchObject({ passed: 1 });
  expect(() => assertScenarioReport(make('environment unreachable'), [name], true)).toThrow('Wrong home negative-control failure');
});
