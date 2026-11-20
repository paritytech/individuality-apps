// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { plainName } from '../names.ts';
import { selectRun } from '../runs.ts';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { breakdown } from '../timing.ts';
import { configKeys, events, renderReport, type Dataset, type RunConfig } from '../report.ts';
import { retainedRows, summarizeRuns } from '../scripts/cross-app-ci.mts';
const sample = (): Dataset => ({ source: 'local <run>', command: 'run c3', verdict: 'passed',
  config: Object.fromEntries(configKeys.map(key => [key, { value: 'value', basis: 'declared', ref: 'source.ts:1' }])) as RunConfig,
  rows: [{ breakdown: breakdown({ direction: 'C1', run: '1', reader: { app: 'Humanity', head: 'best', how: 'poll' }, tap: 1000, submitted: 1200, included: 1600, includedBlock: 5, finalized: 2000, handoff: 1700, rendered: 1800 }), raw: { tap: 1000, chain: { submitted: 1200, included: 1600, finalized: 2000, includedBlock: 5 }, rendered: { at: 1800 } } }] });
describe('standalone report', () => {
  it('renders exact sum proofs, real marks, provenance, labels and missing measurements without external assets', () => {
    const data = sample(), report = renderReport([data]);
    expect(report.html).toContain('Difference: 0 ms');
    expect(report.html).toContain('total 800 ms');
    expect(report.html).toContain('lab-observed, upper bound');
    expect(report.html).toContain('not measured');
    expect(report.html).toContain('local &lt;run&gt;');
    expect(report.html).toContain('source.ts:1');
    expect(report.html).not.toMatch(/<(?:script|link|img)[^>]*(?:src|href)=/);
    expect(events(data.rows[0]!).map(m => m.at)).toEqual([1000, 1200, 1600, 1800, 2000]);
    expect(report.markdown).toContain('<!-- cross-app-lab-comment:v1 -->');
    expect(report.markdown).toContain('0.800 s');
  });
  it('distinguishes a single run from a measured range in both report formats', () => {
    const data = sample(), single = renderReport([data]);
    expect(single.html).toContain('<td>1</td><td>0.800 s</td><td>single run</td>');
    expect(single.markdown).toContain('| 1 | 0.800 s | single run |');
    const repeat = sample(); repeat.rows[0]!.breakdown.run = '2';
    repeat.rows[0]!.breakdown.totalMs = 1000; repeat.rows[0]!.breakdown.segments.push({ name: 'unattributed', ms: 200 });
    const multiple = renderReport([data, repeat]);
    expect(multiple.html).toContain('<td>2</td><td>0.900 s</td><td>0.800 s to 1.000 s</td>');
    expect(multiple.markdown).toContain('| 2 | 0.900 s | 0.800 s to 1.000 s |');
  });
  it('@negative-control: refuses non-finite raw marks, even outside the summed path', () => {
    const data = sample(); data.rows[0]!.raw.data = Infinity;
    expect(() => renderReport([data])).toThrow('Non-finite');
    expect(() => retainedRows('{"raw":{"at":1e999}}')).toThrow('Non-finite');
  });
  it('@negative-control: refuses segments that do not sum', () => {
    const data = sample(); data.rows[0]!.breakdown.totalMs++;
    expect(() => renderReport([data])).toThrow('parts add up');
  });
  it('@negative-control: refuses a missing config value', () => {
    const data = sample(); delete (data.config as Partial<RunConfig>)['Humanity card poll'];
    expect(() => renderReport([data])).toThrow('Missing config value: Humanity card poll');
  });
  it('@negative-control: refuses an empty run and a blank timing file', () => {
    expect(() => renderReport([])).toThrow('Empty run');
    expect(() => renderReport([{ ...sample(), rows: [] }])).toThrow('Empty run');
    expect(() => retainedRows(' \n')).toThrow('Empty run');
  });
  it('does not count the combined Humanity missed plus date observation twice', () => {
    const data = sample(), first = data.rows[0]!;
    data.rows = [{ ...first, breakdown: { ...first.breakdown, direction: 'C5', metric: 'humanity-missed' } }, { ...first, breakdown: { ...first.breakdown, direction: 'C5', metric: 'humanity-next' } }];
    const report = renderReport([data]);
    expect(report.html.match(/<article /g)).toHaveLength(1);
    expect(report.markdown).toContain('1 timing endpoints');
  });
  it('keeps C6 loop rows out of the ordinary C1, C3 and C4 medians', () => {
    const data = sample(), first = data.rows[0]!;
    data.rows = [first, { ...first, breakdown: { ...first.breakdown, run: 'C6-registration' } }];
    const report = renderReport([data]);
    expect(report.markdown).toContain(`| ${plainName('C1')} / primary | 1 |`);
    expect(report.markdown).toContain(`| ${plainName('C1')} / ${plainName('C6')} / primary | 1 |`);
  });
  it('states the C1 worst-phase and C3 permission-click caveats in the sticky comment', () => {
    const report = renderReport([sample()]);
    expect(report.markdown).toContain('worst phase');
    expect(report.markdown).toContain(`${plainName('C3')} includes the lab permission click`);
  });
  it('uses separate background/update selections and refuses unknown legs', () => {
    expect(selectRun('b1-1')).toMatchObject({ tags: '@B1', row: 1, update: false });
    expect(selectRun('u3-3')).toMatchObject({ tags: '@U3', row: 3, update: true });
    expect(selectRun('c6-1')).toMatchObject({ tags: '@C6' });
    expect(() => selectRun('live')).toThrow('Unknown');
  });
});

it('merges independent run datasets into grouped statistics and keeps every run status', () => {
  const folder = mkdtempSync(join(tmpdir(), 'cross-app-merge-control-'));
  vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request'); vi.stubEnv('CROSS_APP_C6_ON_PR', 'true');
  try {
    for (const row of [1, 2]) {
      const data = sample(); data.source = `c${row}-1`; data.rows[0]!.breakdown.direction = row === 1 ? 'C1' : 'C2';
      mkdirSync(join(folder, `run-${row}`)); writeFileSync(join(folder, `run-${row}/dataset.json`), JSON.stringify(data));
    }
    summarizeRuns(folder, join(folder, 'out'));
    const comment = readFileSync(join(folder, 'out/comment.md'), 'utf8');
    expect(comment).toContain(`| ${plainName('C1')} / primary | 1 | 0.800 s | single run |`);
    expect(comment).toContain(`${plainName('C1')}, run 1: passed`);
    expect(comment).toContain(`${plainName('C2')}, run 1: passed`);
    expect(comment).toContain(`${plainName('C3')}, run 1: not run`);
    expect(comment).not.toContain(`${plainName('C1')}, run 2:`);
    expect(JSON.parse(readFileSync(join(folder, 'out/datasets.json'), 'utf8'))).toHaveLength(2);
    mkdirSync(join(folder, 'duplicate')); writeFileSync(join(folder, 'duplicate/dataset.json'), readFileSync(join(folder, 'run-1/dataset.json')));
    expect(() => summarizeRuns(folder, join(folder, 'out'))).toThrow('Duplicate');
  } finally { vi.unstubAllEnvs(); rmSync(folder, { recursive: true, force: true }); }
});
