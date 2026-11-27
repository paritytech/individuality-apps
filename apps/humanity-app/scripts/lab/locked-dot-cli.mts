// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Supply Engine with the CLI installed by this repository's npm ci, before framework fetch can install it.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { savedForkEngineState, setupPaths, testedEngineRef } from '@parity/product-lab/env-engine';

export function prepareLockedDotCli(root: string, cache: string, log: (line: string) => void = console.log): string {
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  const version = '1.24.0', name = 'polkadot-cli';
  const manifest = read(join(root, 'package.json'));
  const lock = read(join(root, 'package-lock.json'));
  const locked = lock.packages?.['node_modules/polkadot-cli'];
  if (manifest.devDependencies?.[name] !== version || lock.packages?.['']?.devDependencies?.[name] !== version || locked?.version !== version || !locked.integrity) {
    throw Error('Expected polkadot-cli 1.24.0 in the root manifest and lockfile; run npm ci');
  }
  const installed = join(root, 'node_modules/polkadot-cli');
  if (!existsSync(join(installed, 'package.json'))) throw Error('Locked polkadot-cli is missing; run npm ci');
  const pkg = read(join(installed, 'package.json'));
  if (pkg.version !== version || typeof pkg.bin?.dot !== 'string') throw Error('Installed polkadot-cli differs from the lockfile; run npm ci');
  const target = resolve(installed, pkg.bin.dot);
  if (realpathSync(join(root, 'node_modules/.bin/dot')) !== realpathSync(target)) throw Error('Installed dot differs from the locked CLI; run npm ci');
  // These public helpers select the exact immutable ref and consumer-owned path used by framework fetch.
  const { base } = setupPaths(savedForkEngineState(cache), testedEngineRef, '', '.');
  const bin = join(base, 'dot-cli/bin'), destination = join(bin, 'dot');
  mkdirSync(bin, { recursive: true });
  // Replace a previous unlocked install's link as well as dangling links, without deleting its tree.
  const previous = lstatSync(destination, { throwIfNoEntry: false });
  if (previous?.isDirectory()) throw Error('Engine dot path is a directory; refusing to replace it');
  if (previous) unlinkSync(destination);
  symlinkSync(target, destination);
  log('Engine CLI: polkadot-cli 1.24.0 from repository npm ci (package-lock.json); unlocked install skipped');
  return destination;
}
