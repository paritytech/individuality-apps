// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Account for custom sentences in the pinned framework's raw declarative-only coverage report.
import { readFileSync } from 'node:fs';
import { customSteps } from '@parity/product-lab/steps';
import '../../lab/opening/steps.ts';
import '../../lab/scenarios/steps.ts';
import { assertCustomCoverage } from '../../lab/scenarios/report-contract.ts';
const [file, extra] = process.argv.slice(2);
if (!file || extra) throw Error('Usage: scenarios-bindings.mts <coverage.json>');
console.log(JSON.stringify(assertCustomCoverage(JSON.parse(readFileSync(file, 'utf8')), customSteps()), null, 2));
