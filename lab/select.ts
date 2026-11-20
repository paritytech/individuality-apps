// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { isOptionsEnvironment, type EnvironmentStartContext, type LabEnvironmentEntry } from '@parity/product-lab';
import { relative, resolve } from 'node:path';
import humanityScenarios from '../apps/humanity-app/lab.scenarios.config.ts';
import humanityFlow from '../apps/humanity-app/lab.flow.config.ts';
import humanityOpening from '../apps/humanity-app/lab.opening.config.ts';
import jollityScenarios from '../apps/jollity-app/lab/scenarios/config.ts';
import jollityOpening from '../apps/jollity-app/lab.opening.config.ts';
import crossApp from './cross-app/lab.cross-app.config.ts';
import { repositoryRoot, humanityRoot } from './shared/paths.ts';

// Jollity's app root is CommonJS; Node/tsx can expose its default inside a wrapper.
const jollityConfig = 'default' in jollityOpening ? jollityOpening.default as typeof jollityOpening : jollityOpening;
const labs = {
  'humanity-scenarios': { config: humanityScenarios, root: humanityRoot },
  'humanity-flow': { config: humanityFlow, root: humanityRoot },
  'humanity-opening': { config: humanityOpening, root: humanityRoot },
  'jollity-scenarios': { config: jollityScenarios, root: resolve(repositoryRoot, 'apps/jollity-app') },
  'jollity-opening': { config: jollityConfig, root: resolve(repositoryRoot, 'apps/jollity-app') },
  'cross-app': { config: crossApp, root: resolve(repositoryRoot, 'lab/cross-app') },
};
function rootedEnvironment(entry: LabEnvironmentEntry, root: string): LabEnvironmentEntry {
  if (isOptionsEnvironment(entry)) return { ...entry, choices: entry.choices.map(choice => {
    const provider = choice.environment;
    return { ...choice, environment: 'start' in provider ? { ...provider,
      start: (context: EnvironmentStartContext) => provider.start({ ...context, root }),
    } : provider };
  }) };
  return 'start' in entry ? { ...entry, start: (context: EnvironmentStartContext) => entry.start({ ...context, root }) } : entry;
}
export const labNames = Object.keys(labs);
export function selectLab(name = process.env.PRODUCT_LAB_LAB ?? 'humanity-scenarios') {
  if (!Object.hasOwn(labs, name)) throw Error(`Unknown lab ${JSON.stringify(name)}; choose ${labNames.join(', ')}`);
  const { config, root } = labs[name as keyof typeof labs];
  const files = (paths: readonly string[]) => paths.map(file => relative(repositoryRoot, resolve(root, file)));
  // Product callbacks keep their original app-relative commands and state roots.
  return { ...config, features: files(config.features), steps: files(config.steps),
    environments: Object.fromEntries(Object.entries(config.environments).map(([id, provider]) => [id, rootedEnvironment(provider, root)])),
    sessions: (context: Parameters<typeof config.sessions>[0]) => config.sessions({ ...context, root }),
  };
}
