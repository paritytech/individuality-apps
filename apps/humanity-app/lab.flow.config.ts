// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineLab } from '@parity/product-lab';
import { paseoCopy } from '@parity/product-lab/composition';
import { flowSessions } from './lab/flows/session.ts';
import { validateSourceApps } from '../../lab/shared/apps.ts';
validateSourceApps();
export default defineLab({
  name: 'Humanity to DIM2 at the merge commit',
  environments: paseoCopy({ ...(process.env.HUMANITY_FLOW_FORK_DIRECTORY ? { directory: process.env.HUMANITY_FLOW_FORK_DIRECTORY, seedsDir: `${process.env.HUMANITY_FLOW_FORK_DIRECTORY}/seeds` } : {}) }),
  defaultEnvironment: 'paseo-copy',
  apps: { peopl: { label: 'Humanity source', requires: { chains: ['people','asset-hub','bulletin'], services: ['identity-backend'] } },
    dim2: { label: 'DIM2 source', requires: { chains: ['people','asset-hub','bulletin'] } } },
  features: ['lab/flows/humanity-dim2.feature','lab/flows/humanity-dim2-wrong-credits.feature'],
  steps: ['lab/flows/steps.ts'], sessions: flowSessions,
});
