// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Generate standalone HTML and markdown from retained datasets, or print legacy timing markdown. Nothing is posted.
import { readFileSync, writeFileSync } from 'node:fs';
import { assertAddsUp, assertFiniteNumbers, commentSection, type Breakdown } from '../timing.ts';
import { renderReport, type Dataset } from '../report.ts';
const args = process.argv.slice(2);
if (args[0] === '--out') {
  const [, output, ...files] = args;
  if (!output || !files.length) throw Error('Use --out report.html dataset.json...');
  const datasets = files.flatMap(file => { const data = JSON.parse(readFileSync(file, 'utf8')) as Dataset | Dataset[]; return Array.isArray(data) ? data : [data]; });
  const report = renderReport(datasets);
  writeFileSync(output, report.html);
  writeFileSync(output.replace(/\.html$/, '') + '.md', report.markdown + '\n');
} else {
  if (!args.length) throw Error('Give at least one timings.jsonl');
  const runs = args.flatMap(file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    const value = JSON.parse(line) as { breakdown: Breakdown }; assertFiniteNumbers(value); return value.breakdown;
  }));
  if (!runs.length) throw Error('Empty run');
  runs.forEach(assertAddsUp);
  process.stdout.write(commentSection(runs));
}
