// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Every scenario process loads this declaration, so static selection also reaches Cucumber's child process.
import { relative, resolve } from 'node:path';
import { defineLab } from '@parity/product-lab';
import original from './lab.cross-app.config.ts';
import { scenarioApp } from '../shared/scenario-app.ts';
import { sourceAppDeclarations } from '../shared/apps.ts';
import { repository, useBuiltHumanity } from './build.ts';

useBuiltHumanity(scenarioApp, sourceAppDeclarations().peopl);
// One Jollity build for every run. Only update steps promote this otherwise-current local file.
process.env.CROSS_APP_UPDATE_LAB = '1';
const configRoot = resolve(repository, 'lab/cross-app');
const provider = original.environments['paseo-copy'];
export default defineLab({
  ...original,
  name: 'Humanity and Jollity timing (two-host topology)',
  // The config lives beside the cross-app helpers; retain the original app root for owned copies and sessions.
  features: original.features.map(file => relative(configRoot, resolve(configRoot, file))),
  steps: original.steps.map(file => relative(configRoot, resolve(configRoot, file))),
  environments: { 'paseo-copy': { ...provider, start: context => provider.start({ ...context, root: repository }) } },
  sessions: context => original.sessions({ ...context, root: repository }),
});
