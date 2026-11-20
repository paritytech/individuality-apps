// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { wrappingReason } from './setup.ts';
import { permissionRefusalReason, playReason, prizeReason } from './pending.ts';
interface Step { keyword?: string; hidden?: boolean; name?: string; result?: { status?: string; error_message?: string }; embeddings?: Array<{ mime_type: string; data: string }> }
interface Row { type?: string; name?: string; steps?: Step[] }
const pendingRows: Record<string, { step: string; reason: string }> = {
  "DIM2's home shows wrapping-up for the chain state the lab set": { step: 'the lab sets the DIM2 game state to "game in PlayerProcess"', reason: wrappingReason },
  'Three players play one DIM2 game and their reports are finalized': { step: 'Alice, Bob and Carol are new actors registered for the game by transaction', reason: playReason },
  'A recognized player claims the game airdrop in DIM2': { step: 'Ada attended the last game and has reached personhood', reason: prizeReason },
  'Refusing access shows Try again, and allowing it reaches home': { step: 'Ada opens dim2 at / and refuses access once', reason: permissionRefusalReason },
};
export const scenarioNames = [
  ...['no-game', 'register', 'unfunded', 'registered', 'missed', 'wrapping-up'].map(state => `DIM2's home shows ${state} for the chain state the lab set`),
  ...['free', 'deposit'].map(route => `Ada registers in DIM2 on the ${route} route`),
  'Three players play one DIM2 game and their reports are finalized',
  'After the game DIM2 shows results and Ada keeps her credits',
  'A recognized player claims the game airdrop in DIM2',
  'Refusing access shows Try again, and allowing it reaches home',
];
export function reportRows(report: unknown): Row[] {
  if (!Array.isArray(report)) throw Error('Invalid Jollity scenario report');
  return report.flatMap((f: { elements?: Row[] }) => f.elements ?? []).filter(row => row.type === 'scenario');
}
export function assertScenarioReport(report: unknown, expected: readonly string[], negative = false) {
  const rows = reportRows(report);
  if (rows.length !== expected.length || new Set(expected).size !== expected.length || JSON.stringify(rows.map(row => row.name).sort()) !== JSON.stringify([...expected].sort())) throw Error('Missing, extra or duplicate Jollity scenario rows');
  let passed = 0, pending = 0; const pendingNames: string[] = [];
  for (const row of rows) {
    const all = row.steps ?? [], visible = all.filter(step => !step.hidden);
    const hooks = all.filter(step => step.hidden);
    if (!visible.length || !hooks.some(step => (step.keyword ?? step.name) === 'Before') || !hooks.some(step => (step.keyword ?? step.name) === 'After') || hooks.some(step => step.result?.status !== 'passed')) throw Error('Jollity setup or cleanup hook did not pass');
    if (negative) {
      if (row.name !== 'An idle chain cannot back the registered home' || visible.length !== 4 || visible.slice(0, -1).some(step => step.result?.status !== 'passed') ||
        visible.at(-1)?.name !== 'Ada sees DIM2 home in state "registered"' || visible.at(-1)?.result?.status !== 'failed' ||
        !visible.at(-1)?.result?.error_message?.includes('Finalized DIM2 setup does not back registered')) throw Error('Wrong home negative-control failure');
      passed++; continue;
    }
    const declared = pendingRows[row.name ?? ''];
    if (!declared) {
      if (all.some(step => step.result?.status !== 'passed')) throw Error('A supported Jollity step did not pass');
      passed++; continue;
    }
    const index = visible.findIndex(step => step.name === declared.step), step = visible[index];
    if (index < 0 || step?.result?.status !== 'pending' || visible.slice(0, index).some(step => step.result?.status !== 'passed') ||
      visible.slice(index + 1).some(step => step.result?.status !== 'skipped')) throw Error('Jollity did not reach exactly its declared pending capability');
    const recorded = step.embeddings?.some(item => {
      if (item.mime_type !== 'application/json') return false;
      try { return JSON.parse(Buffer.from(item.data, 'base64').toString('utf8')).pending === declared.reason; } catch { return false; }
    });
    if (!recorded) throw Error('Jollity pending reason was not recorded exactly');
    pending++; pendingNames.push(row.name!);
  }
  return { rows: rows.length, passed, pending, result: pending ? 'pending' : 'passed', pendingRows: pendingNames.sort() };
}
/** A green job can hold pending rows; the run summary says how many, and which. */
export function scenarioSummary(leg: string, summary: ReturnType<typeof assertScenarioReport>) {
  const plain = (value: string) => value.replace(/[^A-Za-z0-9 ,'()-]/g, '');
  return [`### Jollity scenario: ${plain(leg) || 'leg'}`, '', `**${summary.passed} passed, ${summary.pending} pending** of ${summary.rows} rows`, '',
    ...summary.pendingRows.map(name => `- Pending: ${plain(name)}`), ...(summary.pendingRows.length ? [''] : []),
    '```json', JSON.stringify(summary), '```', ''].join('\n');
}
