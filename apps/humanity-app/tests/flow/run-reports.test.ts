// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import ts from 'typescript';
import { resetRunReports } from '../../lab/flows/run-reports.ts';

it('preserves prepare resource records while removing stale run results and old attachment exports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flow-results-'));
  try {
    const reports = join(directory, 'reports'), sanitized = join(reports, 'sanitized');
    mkdirSync(sanitized, { recursive: true });
    const prepare = '{"seconds":12,"samples":[{"freeMemory":100}]}\n';
    writeFileSync(join(sanitized, 'prepare-123-resources.json'), prepare);
    for (const name of ['scenario-steps.json', 'old-steps.json', 'old-positive.json', 'run-123-resources.json']) writeFileSync(join(sanitized, name), 'stale');
    mkdirSync(join(sanitized, 'old-attachments')); writeFileSync(join(sanitized, 'old-attachments', 'private.json'), 'private');
    writeFileSync(join(reports, 'last-run.json'), 'stale');
    resetRunReports(reports);
    expect(readFileSync(join(sanitized, 'prepare-123-resources.json'), 'utf8')).toBe(prepare);
    for (const name of ['scenario-steps.json', 'old-steps.json', 'old-positive.json', 'run-123-resources.json', 'old-attachments']) expect(existsSync(join(sanitized, name)), name).toBe(false);
    expect(existsSync(join(reports, 'last-run.json'))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it('the actual wrapper acquires its lock before reset, so a refused second run cannot erase active evidence', () => {
  const runner = readFileSync(new URL('../../scripts/lab/flow.mts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('flow.mts', runner, ts.ScriptTarget.Latest, true);
  const main = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'main') as ts.FunctionDeclaration;
  const lockStart = main.body!.statements.findIndex(node => node.getText(source).startsWith('const lock ='));
  const samples = main.body!.statements.findIndex(node => node.getText(source).startsWith('const samples ='));
  const guarded = main.body!.statements.find(node => ts.isTryStatement(node) && node.tryBlock.getText(source).includes('resetRunReports(reports)')) as ts.TryStatement;
  expect(lockStart).toBeGreaterThanOrEqual(0);
  expect(samples).toBeGreaterThan(lockStart);
  expect(guarded, 'run-mode reset must stay inside the locked try block').toBeDefined();
  const reset = guarded.tryBlock.statements[0]!;
  expect(reset, 'the locked try must begin with the run-mode reset').toBeDefined();
  expect(reset.getText(source)).toBe('if (mode === "run") resetRunReports(reports);');
  expect(guarded.pos).toBeGreaterThan(main.body!.statements[samples]!.pos);
  expect(source.statements.some(node => !ts.isFunctionDeclaration(node) && node.getText(source).includes('resetRunReports(reports)'))).toBe(false);
  const code = main.body!.statements.slice(lockStart, samples).map(node => node.getText(source)).join('\n') + '\n' + reset.getText(source);
  const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const directory = mkdtempSync(join(tmpdir(), 'flow-lock-order-'));
  try {
    const state = join(directory, 'state'), reports = join(state, 'flow-reports'), sanitized = join(reports, 'sanitized');
    mkdirSync(sanitized, { recursive: true });
    writeFileSync(join(sanitized, 'prepare-123-resources.json'), 'prepare');
    writeFileSync(join(sanitized, 'scenario-steps.json'), 'old run');
    const scope = { state, reports, mode: 'run', join, mkdirSync, writeFileSync, resetRunReports, process: { pid: 123 } };
    const start = new Function(...Object.keys(scope), javascript);
    start(...Object.values(scope));
    expect(readFileSync(join(sanitized, 'prepare-123-resources.json'), 'utf8')).toBe('prepare');
    expect(existsSync(join(sanitized, 'scenario-steps.json'))).toBe(false);
    writeFileSync(join(sanitized, 'scenario-steps.json'), 'active run');
    writeFileSync(join(reports, 'last-run.json'), 'active run');
    expect(() => start(...Object.values(scope))).toThrow(/EEXIST/);
    expect(readFileSync(join(sanitized, 'scenario-steps.json'), 'utf8')).toBe('active run');
    expect(readFileSync(join(reports, 'last-run.json'), 'utf8')).toBe('active run');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
