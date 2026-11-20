// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { repositoryRoot } from '../shared/paths.ts';
import { defineLab } from '@parity/product-lab';
import { freshPaseoCopy } from '../shared/fresh-copy.ts';
import { keepBundle } from '../shared/bundle.ts';
import { crossAppSessions } from '../shared/session.ts';
import { validateSourceApps } from '../shared/apps.ts';

keepBundle();
validateSourceApps();

/** Cross-app C1 to C5 and recovery: one Ada on Humanity and Jollity, both built from this checkout, timed on a fresh Paseo copy. */
export default defineLab({
  name: 'Cross-app C, Humanity and Jollity timing (two-host topology)',
  environments: { 'paseo-copy': { ...freshPaseoCopy(), start: context => freshPaseoCopy().start({ ...context, root: repositoryRoot }) } },
  defaultEnvironment: 'paseo-copy',
  apps: { peopl: { label: 'Humanity source', requires: { chains: ['people', 'asset-hub', 'bulletin'], services: ['identity-backend'] } },
    dim2: { label: 'Jollity source', requires: { chains: ['people', 'asset-hub', 'bulletin'] } } },
  features: ['./c6-loop.feature', './c1-jollity-to-humanity.feature', './c2-humanity-to-jollity.feature', './c3-entry.feature', './c4-return.feature', './c5-miss.feature', './b1-miss.feature', './b3-registration.feature', './b2-return.feature', './u3-entry.feature', './u4-return.feature'],
  steps: ['../../apps/humanity-app/lab/scenarios/steps.ts', './steps.ts', './journeys.ts', './recovery.ts', './update.ts'], sessions: context => crossAppSessions({ ...context, root: repositoryRoot }),
});
