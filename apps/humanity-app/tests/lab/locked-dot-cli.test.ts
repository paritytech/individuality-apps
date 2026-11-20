// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { prepareEngine, savedForkEngineState, setupPaths, testedEngineRef } from '@parity/product-lab/env-engine';
import type { SyncCommandRunner } from '@parity/product-lab/ports/system';
import { prepareLockedDotCli } from '../../scripts/lab/locked-dot-cli.mts';

const root = resolve(import.meta.dirname, '../../../..');
it('dry Engine preparation uses the npm ci CLI and never installs polkadot-cli unlocked', () => {
  const cache = mkdtempSync(join(tmpdir(), 'locked-dot-control-'));
  try {
    const lines: string[] = [];
    const destination = prepareLockedDotCli(root, cache, line => { lines.push(line); console.log(line); });
    expect(realpathSync(destination)).toBe(realpathSync(join(root, 'node_modules/.bin/dot')));
    const state = savedForkEngineState(cache), paths = setupPaths(state, testedEngineRef, '', '.');
    mkdirSync(join(paths.checkout, '.git'), { recursive: true });
    writeFileSync(join(paths.checkout, '.git/FETCH_HEAD'), testedEngineRef);
    writeFileSync(join(paths.checkout, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.33.0' }));
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const commands: SyncCommandRunner = { run(request) {
      calls.push({ command: request.command, args: request.args ?? [] });
      return { code: 0, stdout: request.command === 'git' ? testedEngineRef : '', stderr: '' };
    } };
    prepareEngine(state, testedEngineRef, 'paseo-next-v2', commands, '.', { platform: 'linux' });
    expect(calls.some(call => call.command === 'npm')).toBe(false);
    expect(calls.some(call => call.args.includes('fetch'))).toBe(true);
    expect(lines).toEqual(['Engine CLI: polkadot-cli 1.24.0 from repository npm ci (package-lock.json); unlocked install skipped']);
    const config = JSON.parse(readFileSync(join(state, 'engine.json'), 'utf8'));
    expect(config.extraPath).toEqual([join(paths.base, 'dot-cli/bin')]);
    unlinkSync(destination); symlinkSync(join(cache, 'old-unlocked-dot'), destination);
    prepareLockedDotCli(root, cache, () => {});
    expect(realpathSync(destination)).toBe(realpathSync(join(root, 'node_modules/.bin/dot')));
    // Prove this control detects the framework's original unlocked install path.
    unlinkSync(destination); calls.length = 0;
    prepareEngine(state, testedEngineRef, 'paseo-next-v2', commands, '.', { platform: 'linux' });
    expect(calls).toContainEqual(expect.objectContaining({ command: 'npm', args: expect.arrayContaining(['install', 'polkadot-cli@1.24.0']) }));
  } finally { rmSync(cache, { recursive: true, force: true }); }
});

it('@negative-control: refuses a missing or mismatched CLI pin before touching Engine tooling', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'locked-dot-pin-'));
  try {
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ devDependencies: { 'polkadot-cli': '1.24.0' } }));
    const lock = { packages: { '': { devDependencies: { 'polkadot-cli': '1.24.0' } }, 'node_modules/polkadot-cli': { version: '1.24.0', integrity: 'test' } } };
    writeFileSync(join(fixture, 'package-lock.json'), JSON.stringify(lock));
    expect(() => prepareLockedDotCli(fixture, join(fixture, 'cache'))).toThrow('missing');
    lock.packages['node_modules/polkadot-cli'].version = '1.25.0';
    writeFileSync(join(fixture, 'package-lock.json'), JSON.stringify(lock));
    expect(() => prepareLockedDotCli(fixture, join(fixture, 'cache'))).toThrow('root manifest and lockfile');
    lock.packages['node_modules/polkadot-cli'].version = '1.24.0';
    writeFileSync(join(fixture, 'package-lock.json'), JSON.stringify(lock));
    mkdirSync(join(fixture, 'node_modules/polkadot-cli'), { recursive: true });
    writeFileSync(join(fixture, 'node_modules/polkadot-cli/package.json'), JSON.stringify({ version: '1.25.0', bin: { dot: 'dot.js' } }));
    expect(() => prepareLockedDotCli(fixture, join(fixture, 'cache'))).toThrow('differs from the lockfile');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
