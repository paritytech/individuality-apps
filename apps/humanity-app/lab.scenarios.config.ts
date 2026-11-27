// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineLab } from '@parity/product-lab';
import { freshPaseoCopy } from '../../lab/shared/fresh-copy.ts';
import { keepBundle } from './lab/opening/session.ts';
import { humanityScenarioSessions } from '../../lab/shared/session.ts';

keepBundle();

export default defineLab({
  name: 'Humanity scenarios A, chain-driven games',
  environments: { 'paseo-copy': freshPaseoCopy() },
  defaultEnvironment: 'paseo-copy',
  apps: { peopl: { label: 'Humanity source', requires: { chains: ['people', 'asset-hub', 'bulletin'], services: ['identity-backend'] } } },
  features: ['lab/scenarios/a1-registration.feature', 'lab/scenarios/a2-next-game.feature', 'lab/scenarios/a3-promotion.feature', 'lab/scenarios/a4-suspension.feature', 'lab/scenarios/a5-attendance.feature', 'lab/scenarios/a6-daily-dollar.feature', 'lab/scenarios/wrong-attendance.feature'],
  steps: ['lab/opening/steps.ts', 'lab/scenarios/steps.ts'], sessions: humanityScenarioSessions,
});
