// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// CI entry point: offline planning, one pinned bundle, strict report classification. Never invoked on import.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { CLEANUP_REPORT_FILE } from '@parity/product-lab/domain/features';
import { lookupBundle, pinBundle, installPinnedBundle, refetchPinnedBundle } from '../../../../lab/shared/ci-bundle.ts';
import { assertScenarioReport, reportRows, scenarioNames, scenarioSummary } from '../../lab/scenarios/report.ts';
export async function main(args = process.argv.slice(2)) {
  const [mode, file, extra] = args;
  if (mode === 'cleanup' && !file) {
    const { NodeSystem, processEnvironment } = await import('@parity/product-lab/composition');
    const result = await new NodeSystem(processEnvironment()).processes.reapAbandoned(resolve(fileURLToPath(new URL('../../', import.meta.url)), '.product-lab'), { maxDepth: 12 });
    if (result.failed.length) throw Error('Jollity owned process cleanup failed');
    return;
  }
  if (mode === 'bundle-lookup') return lookupBundle();
  if (mode === 'bundle-pin' && file && extra) return pinBundle(file, extra, process.env.ASSET_KEY ?? '', process.env.CACHED === 'true');
  if (mode === 'bundle-install' && file) {
    const pin = process.env.BUNDLE_SHA256 ?? '';
    if (process.env.BUNDLE_CACHE_HIT !== 'true' && !existsSync(resolve(file, 'manifest.json'))) await refetchPinnedBundle(file, pin);
    return installPinnedBundle(file, pin, null);
  }
  if ((mode === 'plan' || mode === 'classify') && file) {
    const report: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const expected: string[] = process.env.SCENARIO_NAMES ? JSON.parse(process.env.SCENARIO_NAMES) : scenarioNames;
    if (mode === 'plan') {
      const rows = reportRows(report);
      if (rows.length !== expected.length || JSON.stringify(rows.map(row => row.name).sort()) !== JSON.stringify([...expected].sort()) || rows.some(row => row.steps?.some(step => ['undefined', 'ambiguous'].includes(step.result?.status ?? '')))) throw Error('Incomplete Jollity scenario plan');
      console.log(`Planned ${rows.length} Jollity scenario rows; no scenario executed`); return;
    }
    if (process.env.RAW_EXIT !== undefined && !['0', '1'].includes(process.env.RAW_EXIT)) throw Error('Unexpected Jollity runner exit');
    if (existsSync(resolve(file, '..', CLEANUP_REPORT_FILE))) throw Error('Jollity cleanup failed');
    const summary = assertScenarioReport(report, expected, process.env.NEGATIVE_CONTROL === 'true');
    console.log(JSON.stringify(summary));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, scenarioSummary(process.env.LEG_NAME ?? '', summary));
    if (summary.pending) console.log(`::notice title=Jollity scenarios pending::${summary.passed} passed, ${summary.pending} pending`);
    return;
  }
  throw Error('Use bundle-lookup, bundle-pin <bundle> <pin>, bundle-install <bundle>, plan <report>, or classify <report>');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
