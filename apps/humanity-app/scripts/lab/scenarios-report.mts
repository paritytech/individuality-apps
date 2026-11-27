// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Validate a scenario report, including the one explicit A6 pending step or the expected negative failure.
import { ImportedGameNotRun } from '../../../../lab/shared/imported-game-admission.ts';
import { readFileSync } from 'node:fs';
import { assertScenarioReport } from '../../lab/scenarios/report-contract.ts';
const [kind, file, extra] = process.argv.slice(2);
if (!['passed', 'a6', 'negative'].includes(kind ?? '') || !file || extra) throw Error('Usage: scenarios-report.mts passed|a6|negative <product-lab-test.json>');
try { console.log(assertScenarioReport(JSON.parse(readFileSync(file, 'utf8')), kind as 'passed' | 'a6' | 'negative')); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof ImportedGameNotRun ? 2 : 1;
}
