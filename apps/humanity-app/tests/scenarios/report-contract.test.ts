// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { it, expect } from 'vitest';
import { assertScenarioReport } from '../../lab/scenarios/report-contract.ts';
import { drainStep, ImportedGameNotRun } from '../../../../lab/shared/imported-game-admission.ts';
import { purseReason } from '../../lab/scenarios/pending-purse.ts';
const a6Names = [drainStep, 'Ada is a new actor', 'Ada is a member', "the lab opens today's draw with a 1 dollar prize that Ada wins", 'Ada opens the daily scratch', "Ada scratches today's ticket", "Ada's prize claim is finalized on chain to product account 0", "Ada's host Coinage purse answer is still Unsupported", 'product account 0 grew by the PrizeClaimed amount', "Ada's Coinage purse grows by the prize within 60 seconds"];
function a6() {
  return [{ elements: [{ type: 'scenario', name: "Ada's daily scratch pays into her Coinage purse", steps: [
    { hidden: true, name: '', result: { status: 'passed' }, embeddings: [] },
    ...a6Names.map(name => ({ hidden: false, name, result: { status: 'passed' }, embeddings: [] as Array<{ data: string; mime_type: string }> })),
    { hidden: true, name: '', result: { status: 'passed' }, embeddings: [] },
  ] }] }];
}
it('accepts only a terminal A6 pending purse after every chain leg and hook passed', () => {
  const report = a6(), steps = report[0]!.elements[0]!.steps, last = steps.at(-2)!;
  last.result.status = 'pending'; last.embeddings = [{ mime_type: 'application/json', data: Buffer.from(JSON.stringify({ status: 'pending', reason: purseReason })).toString('base64') }];
  expect(assertScenarioReport(report, 'a6').result).toBe('chain legs passed; purse pending');
  steps[6]!.result.status = 'failed'; expect(() => assertScenarioReport(report, 'a6')).toThrow(/did not pass/);
  steps[6]!.result.status = 'passed'; last.result.status = 'passed'; expect(() => assertScenarioReport(report, 'a6')).toThrow(/pending purse/);
  last.result.status = 'pending'; last.embeddings = []; expect(() => assertScenarioReport(report, 'a6')).toThrow(/reason/);
});
it('rejects a dry-run report as proof and checks the negative failure exactly', () => {
  const steps = Array.from({ length: 6 }, (_, i) => ({ name: i === 5 ? 'Ada sees the attendance row:' : i === 0 ? drainStep : 'setup', result: { status: 'passed', error_message: '' } }));
  const report = [{ elements: [{ type: 'scenario', name: 'An incorrect played count fails at the attendance assertion', steps }] }];
  steps[5]!.result = { status: 'failed', error_message: 'Error: Attendance row differs from finalized chain record' };
  expect(assertScenarioReport(report, 'negative').result).toContain('expected assertion');
  steps[0]!.result.status = 'skipped'; expect(() => assertScenarioReport(report, 'negative')).toThrow(/did not pass/);
  expect(() => assertScenarioReport([], 'passed')).toThrow(/count/);
});
it('accounts for raw coverage custom uses without hiding missing or ambiguous definitions', async () => {
  const { SentencePattern } = await import('@parity/product-lab/domain');
  const { assertCustomCoverage } = await import('../../lab/scenarios/report-contract.ts');
  const report = { unmatched: [{ step: 'Ada is a member' }] }, definition = { pattern: SentencePattern.parse('{actor} is a member') };
  expect(assertCustomCoverage(report, [definition])).toEqual({ customUses: 1, uniquelyBound: 1, unbound: 0, ambiguous: 0 });
  expect(() => assertCustomCoverage(report, [])).toThrow(/found 0/);
  expect(() => assertCustomCoverage(report, [definition, definition])).toThrow(/found 2/);
});

it('classifies only an admission refusal followed by skipped product steps as not run', () => {
  const report = a6(), steps = report[0]!.elements[0]!.steps;
  const refusal = steps[1]!; refusal.result.status = 'failed';
  Object.assign(refusal.result, { error_message: 'ImportedGameNotRun: not run: imported game drain: imported game in Reporting' });
  for (const step of steps.slice(2, -1)) step.result.status = 'skipped';
  expect(() => assertScenarioReport(report, 'a6')).toThrow(ImportedGameNotRun);
  steps[3]!.result.status = 'passed'; expect(() => assertScenarioReport(report, 'a6')).toThrow(/did not pass/);
  steps[3]!.result.status = 'skipped'; Object.assign(refusal.result, { error_message: 'Error: unexpected RPC failure' });
  expect(() => assertScenarioReport(report, 'a6')).toThrow('A scenario step or hook did not pass');
});

function refusedScenario(name = 'refused') {
  const scenario = a6()[0]!.elements[0]!;
  scenario.name = name;
  scenario.steps[1]!.result.status = 'failed';
  Object.assign(scenario.steps[1]!.result, { error_message: 'ImportedGameNotRun: not run: imported game drain: not run: imported game in Reporting' });
  for (const step of scenario.steps.slice(2, -1)) step.result.status = 'skipped';
  return scenario;
}
function failedScenario() {
  const scenario = a6()[0]!.elements[0]!;
  scenario.name = 'product assertion failed';
  scenario.steps[4]!.result.status = 'failed';
  Object.assign(scenario.steps[4]!.result, { error_message: 'Error: attendance row does not match the chain' });
  return scenario;
}
it.each(['refused-first', 'failed-first'])('a real failure wins over an admission refusal: %s', order => {
  const refused = refusedScenario(), failed = failedScenario();
  const report = [{ elements: order === 'refused-first' ? [refused, failed] : [failed, refused] }];
  expect(() => assertScenarioReport(report, 'passed')).toThrow('A scenario step or hook did not pass');
});
it('classifies an all-refused report as not run', () => {
  const report = [{ elements: [refusedScenario('first'), refusedScenario('second')] }];
  expect(() => assertScenarioReport(report, 'passed')).toThrow(ImportedGameNotRun);
});
it.each(['refused-first', 'passed-first'])('allows a clean refusal alongside passed cases: %s', order => {
  const refused = refusedScenario(), passed = a6()[0]!.elements[0]!;
  const report = [{ elements: order === 'refused-first' ? [refused, passed] : [passed, refused] }];
  expect(() => assertScenarioReport(report, 'passed')).toThrow(ImportedGameNotRun);
});
it('a failed After hook stays a failure on the not-run path', () => {
  const scenario = refusedScenario();
  const after = scenario.steps.at(-1)!; after.name = 'After'; after.result.status = 'failed';
  Object.assign(after.result, { error_message: 'Error: cleanup failed' });
  expect(() => assertScenarioReport([{ elements: [scenario] }], 'passed')).toThrow('A scenario step or hook did not pass');
});

it('rejects an attendance-readiness timeout as the wrong negative-control failure', () => {
  const steps = Array.from({ length: 6 }, (_, i) => ({ name: i === 5 ? 'Ada sees the attendance row:' : i === 0 ? drainStep : 'setup', result: { status: i === 5 ? 'failed' : 'passed', error_message: i === 5 ? 'Timed out: attendance row matches chain' : '' } }));
  expect(() => assertScenarioReport([{ elements: [{ type: 'scenario', name: 'An incorrect played count fails at the attendance assertion', steps }] }], 'negative')).toThrow('Wrong negative-control failure');
});
it('uses an impossible played count in the eight-mark negative control', async () => {
  const { readFileSync } = await import('node:fs');
  const feature = readFileSync(new URL('../../lab/scenarios/wrong-attendance.feature', import.meta.url), 'utf8');
  const count = Number(/\| attended \| (\d+)/.exec(feature)?.[1]);
  expect(count).toBeGreaterThan(8);
});
