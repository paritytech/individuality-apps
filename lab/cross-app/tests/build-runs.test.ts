// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashes, verifyBuild, useBuiltHumanity } from '../build.ts';
import { planRuns, selectRun } from '../runs.ts';
import { plainName } from '../names.ts';
import { summarizeRuns } from '../scripts/cross-app-ci.mts';
it('keeps every real feature row selectable locally and selects only its first row on PRs', () => {
  const folder = resolve(import.meta.dirname, '..');
  for (const code of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'B1', 'B2', 'B3', 'U3', 'U4'] as const) {
    const file = ({ C1: 'c1-jollity-to-humanity', C2: 'c2-humanity-to-jollity', C3: 'c3-entry', C4: 'c4-return', C5: 'c5-miss', C6: 'c6-loop', B1: 'b1-miss', B2: 'b2-return', B3: 'b3-registration', U3: 'u3-entry', U4: 'u4-return' })[code];
    const text = readFileSync(join(folder, file + '.feature'), 'utf8');
    expect(text).toContain(`Feature: ${plainName(code)}`);
    const rows = [...text.matchAll(/^\s*\|\s*(\d+)\s*\|/gm)].map(m => Number(m[1]));
    const runs = (code === 'C6' ? [1] : rows).map(row => selectRun(`${code.toLowerCase()}-${row}`));
    expect(runs.map(r => r.row)).toEqual(code === 'C6' ? [1] : [1, 2, 3]);
    expect(planRuns('pull_request').filter(r => r.code === code)).toEqual([runs[0]]);
    for (const run of runs) { expect(run.code).toBe(code); expect(run.tags).toBe(`@${code}`); expect(run.update).toBe(code.startsWith('U')); expect(run.name).toBe(`${plainName(code)}, run ${run.row}`); expect(run.timeout).toBeLessThanOrEqual(65); }
  }
  expect(() => selectRun('c2')).toThrow('Unknown'); expect(() => selectRun('c2-4')).toThrow('Unknown'); expect(() => selectRun('c6-2')).toThrow('Unknown');
});
it('verifies shared build commit and bytes, refusing a stale or tampered build', () => {
  const folder = mkdtempSync(join(tmpdir(), 'cross-app-build-control-'));
  try {
    for (const variant of ['humanity', 'jollity']) { mkdirSync(join(folder, variant)); writeFileSync(join(folder, variant, 'index.html'), variant); }
    writeFileSync(join(folder, 'build.json'), JSON.stringify({ commit: 'one', files: hashes(folder) }));
    expect(() => verifyBuild(folder, 'one')).not.toThrow();
    expect(() => verifyBuild(folder, 'two')).toThrow('another commit');
    writeFileSync(join(folder, 'jollity/index.html'), 'tampered'); expect(() => verifyBuild(folder, 'one')).toThrow('bytes differ');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
it('uses static output only for the cross-app process and drops every Vite-only setting', () => {
  const source = { command: 'npm', args: ['dev'], env: { VITE_NETWORK: 'paseo-next-v2' }, settings: {}, updates: 'vite' };
  useBuiltHumanity(source, { command: 'node', args: ['static-server.mjs', 'dist', '{port}'], updates: 'none' });
  expect(source).toEqual({ command: 'node', args: ['static-server.mjs', 'dist', '{port}'], updates: 'none' });
});
it('summarizes every planned run, including when no runner produced timing evidence', () => {
  const folder = mkdtempSync(join(tmpdir(), 'cross-app-missing-runs-'));
  vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request'); vi.stubEnv('CROSS_APP_C6_ON_PR', 'true');
  try {
    summarizeRuns(join(folder, 'absent'), join(folder, 'out'));
    const comment = readFileSync(join(folder, 'out/comment.md'), 'utf8');
    for (const run of planRuns('pull_request')) expect(comment).toContain(`${run.name}: not run`);
    expect(readFileSync(join(folder, 'out/report.html'), 'utf8')).toContain(plainName('C2'));
    mkdirSync(join(folder, 'inputs'));
    for (const [id, verdict] of [['c1-1', 'failed'], ['c2-1', 'failed']]) {
      mkdirSync(join(folder, 'inputs', id!));
      writeFileSync(join(folder, 'inputs', id!, 'dataset.json'), JSON.stringify({ source: id, rows: [], verdict }));
    }
    summarizeRuns(join(folder, 'inputs'), join(folder, 'failed'));
    expect(JSON.parse(readFileSync(join(folder, 'failed/datasets.json'), 'utf8'))).toHaveLength(2);
    expect(readFileSync(join(folder, 'failed/comment.md'), 'utf8')).toContain(`${plainName('C2')}, run 1: failed`);
    vi.stubEnv('GITHUB_EVENT_NAME', 'schedule');
    summarizeRuns(join(folder, 'absent'), join(folder, 'nightly'));
    const nightly = readFileSync(join(folder, 'nightly/comment.md'), 'utf8');
    expect(nightly).toContain(plainName('C6')); expect(nightly).not.toContain(plainName('C2'));
  } finally { vi.unstubAllEnvs(); rmSync(folder, { recursive: true, force: true }); }
});
