// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { accountKey } from '../../../../lab/shared/upstream/lab/full-journey/identity.ts';
export const names = ['Alice', 'Bob', 'Carol'] as const;
export function requireThree(actual: readonly string[], expected: readonly string[]): void {
  const a = actual.map(accountKey).sort(), b = expected.map(accountKey).sort();
  if (a.length !== 3 || new Set(a).size !== 3 || b.length !== 3 || a.some((value, index) => value !== b[index]))
    throw new Error('The game must contain exactly the three fork players');
}
export function assertFlowReport(report: unknown, control: boolean): void {
  type Step = { hidden?: boolean; name?: string; result?: { status?: string; error_message?: string } };
  const features = report as Array<{ elements?: Array<{ type?: string; steps?: Step[] }> }>;
  if (!Array.isArray(features)) throw new Error('Invalid flow report');
  const scenarios = features.flatMap(f => f.elements ?? []).filter(s => s.type === 'scenario');
  if (scenarios.length !== 1) throw new Error('Expected exactly one flow scenario');
  const all = scenarios[0]!.steps ?? [], visible = all.filter(s => !s.hidden);
  if (visible.length !== (control ? 20 : 22)) throw new Error('Unexpected flow step count');
  const last = visible.at(-1)!;
  for (const step of all) if (!(control && step === last) && step.result?.status !== 'passed')
    throw new Error('An earlier step or cleanup failed');
  if (control && (last.name !== 'Alice has 3 DIM2 credits to keep on chain' || last.result?.status !== 'failed' ||
      !last.result.error_message?.includes('2 DIM2 credits to keep, not 3')))
    throw new Error('The control did not fail at the exact wrong-credits assertion');
}
