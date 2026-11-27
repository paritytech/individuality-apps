// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineLab } from '@parity/product-lab';
import { freshPaseoCopy } from '../../../../lab/shared/fresh-copy.ts';
import { keepBundle } from '../../../../lab/shared/bundle.ts';
import { jollityScenarioSessions } from './session.ts';
keepBundle();
export default defineLab({
  name: 'Jollity scenarios B, Jollity UI only',
  environments: { 'paseo-copy': freshPaseoCopy() }, defaultEnvironment: 'paseo-copy',
  apps: { dim2: { label: 'Jollity source', requires: { chains: ['people', 'asset-hub', 'bulletin'], services: ['identity-backend'] } } },
  features: ['lab/scenarios/b1-home.feature', 'lab/scenarios/b2-registration.feature', 'lab/scenarios/b3-play.feature', 'lab/scenarios/b4-results.feature', 'lab/scenarios/b5-prize.feature', 'lab/scenarios/b6-permissions.feature', 'lab/scenarios/wrong-home.feature'],
  steps: ['lab/opening/steps.ts', 'lab/scenarios/steps.ts'], sessions: jollityScenarioSessions,
});
