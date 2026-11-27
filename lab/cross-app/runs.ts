// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { plainName, type scenarioNames } from './names.ts';
export interface ScenarioRun { id: string; code: keyof typeof scenarioNames; name: string; tags: string; row: number; timeout: number; update: boolean }
// All feature rows remain available to local callers, independently of CI event plans.
function allRuns(): ScenarioRun[] {
  const codes: Array<keyof typeof scenarioNames> = ['C1', 'C2', 'C3', 'C4', 'C5', 'B1', 'B2', 'B3', 'U3', 'U4', 'C6'];
  return codes.flatMap(code => Array.from({ length: code === 'C6' ? 1 : 3 }, (_, n) => ({
    id: `${code.toLowerCase()}-${n + 1}`, code, name: `${plainName(code)}, run ${n + 1}`, tags: `@${code}`, row: n + 1,
    timeout: ['C4', 'B2', 'U4', 'C6'].includes(code) ? 65 : 45, update: code.startsWith('U'),
  })));
}
export function planRuns(event: string, c6 = 'true'): ScenarioRun[] {
  return allRuns().filter(run => event === 'schedule' ? run.code === 'C6' : run.row === 1 && (run.code !== 'C6' || c6 !== 'false'));
}
export function selectRun(id: string): ScenarioRun {
  const run = allRuns().find(run => run.id === id);
  if (!run) throw Error('Unknown cross-app scenario run');
  return run;
}
