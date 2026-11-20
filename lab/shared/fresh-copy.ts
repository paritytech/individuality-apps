// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { EnvironmentProvider } from '@parity/product-lab';
import { paseoCopy, type NetworkCopyOptions } from '@parity/product-lab/composition';
import { forkBundleManifestPath, markedComplete, preparedEngine, savedForkEngineState } from '@parity/product-lab/env-engine';
import { refuseOlderScenarioNodes } from './older-copy-nodes.ts';
import { keepBundle } from './bundle.ts';

function fullCopy(options?: NetworkCopyOptions): EnvironmentProvider {
  const provider = paseoCopy(options)['paseo-copy']?.choices.find(choice => choice.id === 'full')?.environment;
  if (!provider || !('start' in provider)) throw Error('Pinned Paseo full-copy provider is unavailable');
  return provider;
}

/** A new provider start gets a new fork and seed directory; the Engine bundle stays shared.
 * No old fork is deleted or adopted. Missing cached tooling/bundle is a refusal, never a fetch.
 */
export function freshPaseoCopy(): EnvironmentProvider {
  const declared = fullCopy();
  return {
    ...declared, description: 'A fresh full Paseo copy from the cached bundle; missing or incomplete bundles are refused', updates: [], keeps: undefined,
    ...(declared.tooling ? { tooling: { ...declared.tooling,
      async prepare() { throw Error('Humanity scenarios require the existing prepared Engine; automatic preparation is refused'); },
    } } : {}),
    async start(context) {
      if (context.keep || context.update) throw Error('Humanity scenarios require a fresh cached copy, without keep or updates');
      if (process.env.PRODUCT_LAB_FORK_BUNDLE !== 'keep') throw Error('Humanity scenarios require PRODUCT_LAB_FORK_BUNDLE=keep');
      keepBundle();
      const cacheDir = process.env.PRODUCT_LAB_CACHE_DIR;
      if (!cacheDir || !isAbsolute(cacheDir)) throw Error('Humanity scenarios require the existing absolute PRODUCT_LAB_CACHE_DIR');
      const commands = context.system?.syncCommands;
      if (!commands) throw Error('Humanity scenarios require the prepared Engine check adapter');
      const engine = preparedEngine(savedForkEngineState(cacheDir), { stateDirectory: '.', fix: 'Use the existing prepared Engine', commands, patch: 'as-prepared' });
      if (!markedComplete(dirname(forkBundleManifestPath(engine.workspace, 'paseo-next-v2')))) throw Error('Cached Paseo bundle is missing or incomplete; download refused');
      const parent = resolve(context.root, process.env.HUMANITY_SCENARIOS_FORK_DIRECTORY ?? '.product-lab/scenarios-engine');
      const within = relative(resolve(context.root), parent);
      if (within === '' || within.startsWith('..') || isAbsolute(within)) throw Error('Fresh scenario copies must stay below the lab root');
      refuseOlderScenarioNodes(parent, commands);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const directory = mkdtempSync(join(parent, 'run-'));
      const provider = fullCopy({ cacheDir, directory, seedsDir: join(directory, 'seeds') });
      return provider.start(context);
    },
  };
}
