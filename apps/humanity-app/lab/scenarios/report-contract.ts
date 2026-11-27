// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { drainStep, ImportedGameNotRun } from '../../../../lab/shared/imported-game-admission.ts';
import { purseReason } from './pending-purse.ts';
interface Step {
  hidden?: boolean; name?: string; result?: { status?: string; error_message?: string };
  embeddings?: Array<{ data: string; mime_type: string }>;
}
interface Scenario { type?: string; name?: string; steps?: Step[] }
type ReportKind = 'passed' | 'a6' | 'negative';
function assertScenario(scenario: Scenario, kind: ReportKind): void {
  const steps = scenario.steps ?? [], visible = steps.filter(s => !s.hidden), last = visible.at(-1);
  if (!visible.length) throw Error('No scenario steps');
  const first = visible[0]!;
  if (first.name === drainStep && first.result?.status === 'failed' && first.result.error_message?.includes('not run: imported game drain:') &&
    visible.slice(1).every(step => step.result?.status === 'skipped') && steps.filter(step => step.hidden).every(step => step.result?.status === 'passed')) {
    throw new ImportedGameNotRun(first.result.error_message.split('not run: imported game drain:')[1]!.trim());
  }
  if (first.name !== drainStep) throw Error('Scenario report is missing its first imported-game drain');
  for (const step of steps) {
    if (kind !== 'passed' && step === last) continue;
    if (step.result?.status !== 'passed') throw Error('A scenario step or hook did not pass');
  }
  if (kind === 'negative' && (scenario.name !== 'An incorrect played count fails at the attendance assertion' || visible.length !== 6 ||
    last?.name !== 'Ada sees the attendance row:' || last.result?.status !== 'failed' || !last.result.error_message?.includes('Attendance row differs from finalized chain record'))) throw Error('Wrong negative-control failure');
  if (kind === 'a6') {
    const expected = [drainStep, 'Ada is a new actor', 'Ada is a member', "the lab opens today's draw with a 1 dollar prize that Ada wins", 'Ada opens the daily scratch', "Ada scratches today's ticket",
      "Ada's prize claim is finalized on chain to product account 0", "Ada's host Coinage purse answer is still Unsupported", 'product account 0 grew by the PrizeClaimed amount', "Ada's Coinage purse grows by the prize within 60 seconds"];
    if (scenario.name !== "Ada's daily scratch pays into her Coinage purse" || JSON.stringify(visible.map(s => s.name)) !== JSON.stringify(expected) || last?.result?.status !== 'pending') throw Error('A6 did not reach only the terminal pending purse');
    const reason = last.embeddings?.some(e => {
      if (e.mime_type !== 'application/json') return false;
      try { const value = JSON.parse(Buffer.from(e.data, 'base64').toString('utf8')); return value.status === 'pending' && value.reason === purseReason; }
      catch { return false; }
    });
    if (!reason) throw Error('A6 pending purse reason was not recorded');
  }
}
export function assertScenarioReport(report: unknown, kind: ReportKind) {
  if (!Array.isArray(report)) throw Error('Invalid scenario report');
  const scenarios = (report as Array<{ elements?: Scenario[] }>).flatMap(f => f.elements ?? []).filter(s => s.type === 'scenario');
  if (!scenarios.length || (kind !== 'passed' && scenarios.length !== 1)) throw Error('Unexpected scenario count');
  // Classify the entire report before deciding its result; scenario order cannot hide a failure.
  const outcomes = scenarios.map(scenario => {
    try { assertScenario(scenario, kind); return { status: 'passed' as const }; }
    catch (error) { return { status: error instanceof ImportedGameNotRun ? 'not-run' as const : 'failed' as const, error }; }
  });
  const failure = outcomes.find(outcome => outcome.status === 'failed');
  if (failure) throw failure.error;
  const refused = outcomes.find(outcome => outcome.status === 'not-run');
  if (refused) throw refused.error;
  return { scenarios: scenarios.length, result: kind === 'a6' ? 'chain legs passed; purse pending' : kind === 'negative' ? 'negative control failed at the expected assertion' : 'passed' };
}

/** product-lab 0.1.0 coverage counts declarative sentences only. Account for its raw
 * unmatched rows with the actual registered custom definitions, refusing zero or two matches. */
export function assertCustomCoverage(report: unknown, steps: readonly { pattern: { match(text: string): unknown } }[]) {
  const unmatched = (report as { unmatched?: Array<{ step: string }> })?.unmatched;
  if (!Array.isArray(unmatched)) throw Error('Invalid coverage report');
  for (const use of unmatched) {
    const matches = steps.filter(step => step.pattern.match(use.step) !== undefined);
    if (matches.length !== 1) throw Error(`Expected one custom binding for ${use.step}; found ${matches.length}`);
  }
  return { customUses: unmatched.length, uniquelyBound: unmatched.length, unbound: 0, ambiguous: 0 };
}
