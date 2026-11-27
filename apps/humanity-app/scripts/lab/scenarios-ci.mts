// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// CI legs of Humanity scenarios A: pin one Paseo bundle per run, install it in each leg, check the leg's offline plan,
// and summarize and measure the leg.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { engineBundle, lookupBundle, pinBundle, installPinnedBundle, refetchPinnedBundle } from '../../../../lab/shared/ci-bundle.ts';
export type { BundlePin } from '../../../../lab/shared/ci-bundle.ts';
export { assetKey, readPin, lookupBundle, pinBundle, installPinnedBundle, refetchPinnedBundle, downloadArchive } from '../../../../lab/shared/ci-bundle.ts';
import { CLEANUP_REPORT_FILE } from '@parity/product-lab/domain/features';
import { ImportedGameNotRun } from '../../../../lab/shared/imported-game-admission.ts';
import { assertScenarioReport } from '../../lab/scenarios/report-contract.ts';

export type Kind = 'passed' | 'a6' | 'negative';
export type Verdict = 'pass' | 'fail' | 'pending' | 'not-run';
export interface Leg { id: string; name: string; kind: Kind; scenarios: string[]; tags?: string; feature?: string; line?: number; example?: string }
export interface Outside { attempted: number; blocked: number; sentryLocal: number; pending: number; notBlocked: number; socketFrameViolations: number; summaries: number }
export interface LegSummary {
  version: 1; id: string; name: string; verdict: Verdict; seconds: number | null; rawExit: number | null; classifierExit: number | null;
  scenarios: Array<{ label: string; result: Verdict; seconds: number | null }>; outside: Outside | null; videos: string; report: string;
  bundle: LegBundle | null; guardTests: GuardTests | null;
}
/** The A1+A2 leg's real-browser guard-test step: passed, failed (or cancelled), or never reached. */
export type GuardTests = 'pass' | 'fail' | 'not-run';
/** The run's pinned bundle, whether this leg restored it from the cache, how long restore and verification took, and
 * the manifest SHA-256 the leg's bundle still had after the run. */
export interface LegBundle { pinned: string; cacheHit: boolean | null; restoreSeconds: number | null; used: string | null }

const PIN = /^[0-9a-f]{64}$/;
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const exit = (value: string | undefined) => value !== undefined && /^\d+$/.test(value) ? Number(value) : null;

export function parseLeg(text: string | undefined): Leg {
  const leg = row(JSON.parse(text ?? 'null'));
  if (typeof leg.id !== 'string' || !/^[a-z0-9-]+$/.test(leg.id) || typeof leg.name !== 'string' || !['passed', 'a6', 'negative'].includes(leg.kind as string) ||
    !Array.isArray(leg.scenarios) || !leg.scenarios.length || !leg.scenarios.every(label => typeof label === 'string')) throw Error('Invalid scenario leg');
  return leg as unknown as Leg;
}

/** The guard-test step's outcome, for a leg that runs them (`expected` is the step's own matrix condition); null otherwise. */
export function guardTests(expected: string | undefined, outcome: string | undefined): GuardTests | null {
  if (expected !== 'true') return null;
  return outcome === 'success' ? 'pass' : outcome === 'skipped' ? 'not-run' : 'fail';
}

/** The leg's verdict from the raw run and the classifier's exit codes: 0 classified, 2 imported-game refusal, otherwise
 * failed. A cleanup failure (the framework's cleanup report beside the run's report) fails any leg. */
export function legVerdict(kind: Kind, rawExit: number | null, classifierExit: number | null, cleanupFailed = false): Verdict {
  if (cleanupFailed) return 'fail';
  if (classifierExit === 2) return 'not-run';
  if (classifierExit !== 0) return 'fail';
  // A6's declared purse step is pending, which makes the raw run exit 1 (run 8). A copy that fails to stop also exits 1:
  // the scenarios lab's AfterAll throws, Cucumber leaves the report empty and the classifier fails it; a lab using the
  // framework's cleanup hooks writes the cleanup report instead, checked above.
  if (kind === 'a6') return rawExit === 1 ? 'pending' : 'fail';
  return rawExit === 0 ? 'pass' : 'fail';
}

const scenarioTag = (element: Row, feature: Row) => [...list(element.tags), ...list(feature.tags)]
  .map(tag => /^@(A\d+(?:-control)?)$/.exec(String(row(tag).name))?.[1]).find(Boolean);
const label = (leg: Leg, tag: string | undefined) => tag ? leg.example ? `${tag} ${leg.example}` : tag : 'unlabelled';
const seconds = (element: Row) => {
  const nanos = ['before', 'steps', 'after'].flatMap(key => list(element[key])).map(step => row(row(step).result).duration).filter((value): value is number => typeof value === 'number' && value >= 0);
  return nanos.length ? Math.round(nanos.reduce((sum, value) => sum + value, 0) / 1e9) : null;
};
const scenarios = (report: unknown) => list(report).flatMap(feature => list(row(feature).elements).filter(element => row(element).type === 'scenario').map(element => ({ feature: row(feature), element: row(element) })));

/** Each selected scenario, classified alone by the same report contract; an expected scenario absent from the report did not run. */
export function scenarioRows(report: unknown, leg: Leg): LegSummary['scenarios'] {
  const rows = scenarios(report).map(({ feature, element }) => {
    let result: Verdict;
    try { assertScenarioReport([{ ...feature, elements: [element] }], leg.kind); result = leg.kind === 'a6' ? 'pending' : 'pass'; }
    catch (error) { result = error instanceof ImportedGameNotRun ? 'not-run' : 'fail'; }
    return { label: label(leg, scenarioTag(element, feature)), result, seconds: seconds(element) };
  });
  const missing = leg.scenarios.filter(expected => !rows.some(entry => entry.label === expected));
  return [...rows, ...missing.map(expected => ({ label: expected, result: 'not-run' as const, seconds: null }))];
}

/** Outside requests from the browser guard's own records, de-duplicated across every attached snapshot. */
export function outsideCounts(report: unknown): Outside | null {
  const summaries = scenarios(report).flatMap(({ element }) => ['before', 'steps', 'after'].flatMap(key => list(element[key])))
    .flatMap(step => list(row(step).embeddings)).filter(embedding => row(embedding).mime_type === 'application/json')
    .flatMap(embedding => { try { return [row(JSON.parse(Buffer.from(String(row(embedding).data), 'base64').toString('utf8')))]; } catch { return []; } })
    .filter(value => value.productLab === 'humanity-scenario-network');
  if (!summaries.length) return null;
  const records = new Map<string, Row>();
  for (const summary of summaries) for (const request of list(summary.requests).map(row)) {
    if (request.outside === true) records.set(JSON.stringify([request.tag, request.actor, request.id, request.at, request.host, request.source]), request);
  }
  const outside = [...records.values()], decided = (decision: string) => outside.filter(request => request.decision === decision).length;
  return { attempted: outside.length, blocked: decided('blocked'), sentryLocal: decided('sentry-local'), pending: decided('pending'),
    notBlocked: outside.filter(request => !['blocked', 'sentry-local', 'pending'].includes(String(request.decision))).length,
    socketFrameViolations: outside.reduce((sum, request) => sum + (typeof request.outsideFrameViolations === 'number' ? request.outsideFrameViolations : 0), 0),
    summaries: summaries.length };
}

export function legSummary(leg: Leg, report: unknown, input: { rawExit: number | null; classifierExit: number | null; seconds: number | null; videos: string; report: string; bundle?: LegBundle; cleanupFailed?: boolean; guardTests?: GuardTests | null }): LegSummary {
  const rows = scenarioRows(report, leg), classified = legVerdict(leg.kind, input.rawExit, input.classifierExit, input.cleanupFailed);
  // The classifier sees only the scenarios in the report; a leg missing one of its scenarios cannot pass.
  const reported = leg.scenarios.every(expected => scenarios(report).some(({ feature, element }) => label(leg, scenarioTag(element, feature)) === expected));
  // A leg whose bundle is not the run's pinned one ran on another Paseo state, so it cannot pass.
  const pinned = !input.bundle || (PIN.test(input.bundle.pinned) && input.bundle.used === input.bundle.pinned);
  // The guard tests are part of the leg: a failed run fails it, and a leg whose guard tests never ran cannot pass.
  const guard = input.guardTests ?? null;
  const guarded = guard === 'fail' || (guard === 'not-run' && classified !== 'not-run');
  const verdict = !pinned || guarded || (classified !== 'not-run' && !reported) ? 'fail' : classified;
  return { version: 1, id: leg.id, name: leg.name, verdict, seconds: input.seconds, rawExit: input.rawExit,
    classifierExit: input.classifierExit, scenarios: rows, outside: outsideCounts(report), videos: input.videos, report: input.report, bundle: input.bundle ?? null,
    guardTests: guard };
}

export type StepKind = 'precondition' | 'journey' | 'hook' | 'unclassified';
export interface ScenarioPhases {
  label: string; preconditionSeconds: number; journeySeconds: number; hookSeconds: number; unclassified: string[];
  steps: Array<{ keyword: string; name: string; kind: StepKind; seconds: number | null; status: string }>;
}
const tenths = (value: number) => Math.round(value * 10) / 10;
/** Each step's time from the report, split by its Gherkin block: the Given block (new person, member setup, draws and
 * other preconditions) versus the When/Then journey under test. And/But inherit their block; hooks stay apart. */
export function scenarioPhases(report: unknown, leg: Leg): ScenarioPhases[] {
  return scenarios(report).map(({ feature, element }) => {
    let block: 'precondition' | 'journey' = 'precondition';
    const steps = ['before', 'steps', 'after'].flatMap(key => list(element[key])).map(row).map(step => {
      const keyword = String(step.keyword ?? '').trim(), duration = row(step.result).duration;
      let kind: StepKind;
      if (step.hidden === true || keyword === 'Before' || keyword === 'After') kind = 'hook';
      else if (keyword === 'Given') kind = block = 'precondition';
      else if (keyword === 'When' || keyword === 'Then') kind = block = 'journey';
      else if (keyword === 'And' || keyword === 'But' || keyword === '*') kind = block;
      else kind = 'unclassified';
      return { keyword, name: String(step.name ?? ''), kind, seconds: typeof duration === 'number' && duration >= 0 ? tenths(duration / 1e9) : null, status: String(row(step.result).status ?? 'unavailable') };
    });
    const total = (kind: StepKind) => tenths(steps.filter(step => step.kind === kind).reduce((sum, step) => sum + (step.seconds ?? 0), 0));
    return { label: label(leg, scenarioTag(element, feature)), preconditionSeconds: total('precondition'), journeySeconds: total('journey'), hookSeconds: total('hook'),
      unclassified: steps.filter(step => step.kind === 'unclassified').map(step => `${step.keyword} ${step.name}`.trim()), steps };
  });
}

/** "8 min 17 s", "25.8 s" or "1 h 2 min" as seconds. */
export function parseDuration(text: string): number | null {
  const units: Record<string, number> = { h: 3600, min: 60, s: 1, ms: 0.001 };
  const parts = [...text.matchAll(/([\d.]+)\s*(h|min|ms|s)\b/g)];
  return parts.length ? tenths(parts.reduce((sum, [, value, unit]) => sum + Number(value) * units[unit!]!, 0)) : null;
}
/** The Paseo copy's start (start command to ready) and stop, as the run's own log reports them. */
export function environmentTimes(log: string) {
  const times = (what: string) => [...log.matchAll(new RegExp(`${what} the environment \\(([^)]+)\\)`, 'g'))].map(match => parseDuration(match[1]!));
  const start = times('start'), stop = times('stop');
  return { startSeconds: start[0] ?? null, starts: start.length, stopSeconds: stop.at(-1) ?? null };
}
/** The workspace file system from the sampler's `<unix seconds> <used KiB> <available KiB>` lines (`df -Pk`): the peak
 * used, the least available, and the samples. Runs 1-2 sampled no disk, so A3's lost runner could not be told apart. */
export function parseDisk(text: string) {
  const rows = text.split('\n').map(line => line.trim().split(/\s+/)).filter(cells => cells.length === 3 && cells.every(cell => /^\d+$/.test(cell))).map(cells => cells.map(Number));
  if (!rows.length) return { samples: 0, usedPeakMiB: null, availableMinMiB: null, totalMiB: null };
  const mib = (kib: number) => tenths(kib / 1024);
  return { samples: rows.length, usedPeakMiB: mib(Math.max(...rows.map(r => r[1]!))), availableMinMiB: mib(Math.min(...rows.map(r => r[2]!))), totalMiB: mib(rows[0]![1]! + rows[0]![2]!) };
}
/** Whole-runner CPU and memory from `vmstat -n <interval>`; the first line (averages since boot) is dropped. */
export function parseVmstat(text: string, memTotalKiB: number | null) {
  let columns: string[] | undefined;
  const rows: Record<string, number>[] = [];
  for (const line of text.split('\n')) {
    const cells = line.trim().split(/\s+/);
    if (cells.includes('id') && cells.includes('free')) { columns = cells; continue; }
    if (columns && cells.length === columns.length && cells.every(cell => /^\d+$/.test(cell))) rows.push(Object.fromEntries(columns.map((name, index) => [name, Number(cells[index])])));
  }
  const samples = rows.slice(1);
  const busy = samples.map(sample => 100 - sample.id!);
  const used = memTotalKiB ? samples.map(sample => (memTotalKiB - sample.free! - sample.buff! - sample.cache!) / 1024) : [];
  const stats = (values: number[]) => values.length ? { peak: tenths(Math.max(...values)), average: tenths(values.reduce((sum, value) => sum + value, 0) / values.length) } : null;
  const memoryTotalMiB = memTotalKiB ? Math.round(memTotalKiB / 1024) : null, memoryUsedMiB = stats(used);
  // Headroom: what the busiest sample left of the runner's memory.
  return { samples: samples.length, cpuPercent: stats(busy), memoryUsedMiB, memoryTotalMiB, memoryHeadroomMiB: memoryTotalMiB !== null && memoryUsedMiB ? tenths(memoryTotalMiB - memoryUsedMiB.peak) : null };
}

export function legMetrics(leg: Leg, report: unknown, input: { vmstat: string; memTotalKiB: number | null; cpus: number | null; intervalSeconds: number; samplerCpuSeconds: number | null;
  phases: Record<string, number>; log: string; bundle: Omit<LegBundle, 'used'>; disk?: string; setup?: string }) {
  return { version: 1 as const, leg: leg.name, setup: input.setup ?? 'unavailable', runner: { cpus: input.cpus }, sampler: { tool: 'vmstat', intervalSeconds: input.intervalSeconds, cpuSeconds: input.samplerCpuSeconds },
    ...parseVmstat(input.vmstat, input.memTotalKiB), disk: parseDisk(input.disk ?? ''), bundle: input.bundle, environment: environmentTimes(input.log), phases: input.phases, scenarios: scenarioPhases(report, leg) };
}
export function metricsMarkdown(metrics: ReturnType<typeof legMetrics>): string {
  const value = (number: number | null | undefined, unit: string) => number === null || number === undefined ? 'unavailable' : `${number} ${unit}`;
  const lines = [`## Leg ${metrics.leg} metrics`, '', '| Measure | Value |', '| --- | --- |',
    `| CPU busy, peak / average (whole runner, ${metrics.runner.cpus ?? '?'} CPUs) | ${value(metrics.cpuPercent?.peak, '%')} / ${value(metrics.cpuPercent?.average, '%')} |`,
    `| Memory used, peak / average (of ${value(metrics.memoryTotalMiB, 'MiB')}) | ${value(metrics.memoryUsedMiB?.peak, 'MiB')} / ${value(metrics.memoryUsedMiB?.average, 'MiB')} |`,
    `| Memory headroom at the peak | ${value(metrics.memoryHeadroomMiB, 'MiB')} |`,
    `| Workspace disk used, peak / least available (of ${value(metrics.disk.totalMiB, 'MiB')}, ${metrics.disk.samples} samples) | ${value(metrics.disk.usedPeakMiB, 'MiB')} / ${value(metrics.disk.availableMinMiB, 'MiB')} |`,
    `| Chain setup | ${metrics.setup} |`,
    `| Sampler | vmstat every ${metrics.sampler.intervalSeconds} s, ${metrics.samples} samples, ${value(metrics.sampler.cpuSeconds, 's')} CPU |`,
    `| Bundle restore and verification (cache ${metrics.bundle.cacheHit === null ? 'unavailable' : metrics.bundle.cacheHit ? 'hit' : 'miss'}) | ${value(metrics.bundle.restoreSeconds, 's')} |`,
    `| Paseo copy start, start command to ready | ${value(metrics.environment.startSeconds, 's')} |`,
    `| Paseo copy stop | ${value(metrics.environment.stopSeconds, 's')} |`,
    ...Object.entries(metrics.phases).map(([name, seconds]) => `| Phase: ${name} | ${seconds} s |`), ''];
  for (const scenario of metrics.scenarios) {
    lines.push(`### ${scenario.label}: preconditions ${scenario.preconditionSeconds} s, journey ${scenario.journeySeconds} s, hooks ${scenario.hookSeconds} s`, '',
      '| Step | Block | Seconds | Status |', '| --- | --- | --- | --- |',
      ...scenario.steps.filter(step => step.kind !== 'hook').map(step => `| ${`${step.keyword} ${step.name}`.trim().replaceAll('|', '\\|')} | ${step.kind} | ${step.seconds ?? 'unavailable'} | ${step.status} |`), '',
      `Unclassified steps: ${scenario.unclassified.join('; ') || 'none'}`, '');
  }
  return lines.join('\n');
}

/** The dry run must select exactly the leg's scenarios, so a moved tag or Examples row fails before a fork starts. */
export function assertPlan(report: unknown, leg: Leg): void {
  const planned = scenarios(report).map(({ feature, element }) => label(leg, scenarioTag(element, feature)));
  if (JSON.stringify([...planned].sort()) !== JSON.stringify([...leg.scenarios].sort())) throw Error(`Leg ${leg.name} plans ${planned.join(', ') || 'nothing'}, not ${leg.scenarios.join(', ')}`);
}

function readReport(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
}


const cacheHit = (value: string | undefined) => value === 'true' ? true : value === 'false' ? false : null;
async function summary() {
  const leg = parseLeg(process.env.LEG), file = process.env.SUMMARY_FILE;
  if (!file) throw Error('SUMMARY_FILE is required');
  let used: string | null = null;
  try { used = (await engineBundle()).marked(); } catch { /* No prepared Engine or bundle: the leg cannot show the pinned bundle. */ }
  const result = legSummary(leg, readReport(join(process.env.LEG_REPORTS ?? '', 'product-lab-test.json')), {
    rawExit: exit(process.env.RAW_EXIT), classifierExit: exit(process.env.CLASSIFIER_EXIT), seconds: exit(process.env.LEG_SECONDS),
    videos: process.env.VIDEOS_URL ?? '', report: process.env.REPORT_URL ?? '',
    cleanupFailed: existsSync(join(process.env.LEG_REPORTS ?? '', CLEANUP_REPORT_FILE)), guardTests: guardTests(process.env.GUARD_TESTS_EXPECTED, process.env.GUARD_TESTS),
    bundle: { pinned: process.env.BUNDLE_SHA256 ?? '', cacheHit: cacheHit(process.env.BUNDLE_CACHE_HIT), restoreSeconds: exit(process.env.BUNDLE_SECONDS), used } });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  const outside = result.outside;
  const lines = [`### Humanity scenario ${leg.name}: ${result.verdict}`, '', '| Scenario | Result | Seconds |', '| --- | --- | --- |',
    ...result.scenarios.map(entry => `| ${entry.label} | ${entry.result} | ${entry.seconds ?? 'unavailable'} |`), '',
    ...(result.guardTests ? [`Real-browser guard tests: ${{ pass: 'passed', fail: 'FAILED', 'not-run': 'did not run' }[result.guardTests]}.`, ''] : []),
    `Bundle: pinned ${result.bundle?.pinned || 'unavailable'}; after the run ${result.bundle?.used ?? 'unavailable'}.`, '',
    outside ? `Outside requests (browser guard records): ${outside.attempted} attempted, ${outside.blocked} blocked, ${outside.sentryLocal} Sentry handled locally, ${outside.pending} pending, ${outside.notBlocked} not blocked; ${outside.socketFrameViolations} outside socket frame violations. Page traffic only, not a statement about the machine.` : 'Outside requests: no guard records in the report.', ''];
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${result.verdict}\n`);
  console.log(lines.join('\n'));
}

const optional = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
function metrics() {
  const leg = parseLeg(process.env.LEG), dir = process.env.LEG_METRICS, reports = process.env.LEG_REPORTS ?? '';
  if (!dir) throw Error('LEG_METRICS is required');
  const memTotal = /MemTotal:\s+(\d+)\s+kB/.exec(optional(join(dir, 'meminfo.txt')))?.[1], cpus = /^\d+$/m.exec(optional(join(dir, 'nproc.txt')))?.[0];
  const ticks = /^cpu_ticks=(\d+) clk_tck=(\d+)$/m.exec(optional(join(dir, 'sampler.txt')));
  const phases = Object.fromEntries(optional(join(dir, 'phases.txt')).split('\n').flatMap(line => { const match = /^([\w -]+)=(\d+)$/.exec(line.trim()); return match ? [[match[1]!, Number(match[2])]] : []; }));
  const result = legMetrics(leg, readReport(join(reports, 'product-lab-test.json')), {
    vmstat: optional(join(dir, 'vmstat.log')), memTotalKiB: memTotal ? Number(memTotal) : null, cpus: cpus ? Number(cpus) : null, intervalSeconds: Number(process.env.SAMPLER_INTERVAL ?? 5),
    samplerCpuSeconds: ticks ? tenths(Number(ticks[1]) / Number(ticks[2])) : null, phases, log: optional(join(reports, 'cucumber.log')) || optional(join(dir, 'product-lab.out')),
    disk: optional(join(dir, 'disk.log')), setup: process.env.HUMANITY_SCENARIOS_SETUP || 'full',
    bundle: { pinned: process.env.BUNDLE_SHA256 ?? '', cacheHit: cacheHit(process.env.BUNDLE_CACHE_HIT), restoreSeconds: exit(process.env.BUNDLE_SECONDS) } });
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(dir, 'metrics.md'), metricsMarkdown(result));
  console.log(metricsMarkdown(result));
}

async function main() {
  const [mode, file, extra] = process.argv.slice(2);
  if (mode === 'bundle-lookup' && !file) return lookupBundle();
  if (mode === 'bundle-pin' && file && extra) return pinBundle(file, extra, process.env.ASSET_KEY ?? '', process.env.CACHED === 'true');
  if (mode === 'bundle-install' && file && !extra) {
    // A missed restore re-fetches and verifies against the pin; a restored bundle is only verified.
    if (process.env.BUNDLE_CACHE_HIT !== 'true' && !existsSync(join(file, 'manifest.json'))) await refetchPinnedBundle(file, process.env.BUNDLE_SHA256 ?? '');
    return installPinnedBundle(file, process.env.BUNDLE_SHA256 ?? '', exit(process.env.BUNDLE_STARTED));
  }
  if (mode === 'plan' && file && !extra) { assertPlan(readReport(file), parseLeg(process.env.LEG)); console.log('Leg plan matches its scenarios'); return; }
  if (mode === 'summary' && !file) return summary();
  if (mode === 'metrics' && !file) return metrics();
  throw Error('Usage: scenarios-ci.mts bundle-lookup | bundle-pin <dir> <pin dir> | bundle-install <dir> | plan <dry-run product-lab-test.json> | summary | metrics');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
