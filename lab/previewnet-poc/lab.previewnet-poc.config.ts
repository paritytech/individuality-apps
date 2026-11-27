// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Proof of concept: one scenario that runs unchanged on a local copy of Previewnet and on live Previewnet.
// Locally Ada is a new person the lab onboards; live she is the existing person named below, whose phrase the
// lab reads from PREVIEWNET_POC_ADA_MNEMONIC (a bare BIP-39 phrase). Nothing is funded on either.
import { defineLab, defineSteps } from '@parity/product-lab';
import { nextGame } from './next-game.ts';
import { previewnetPocSessions } from './session.ts';

const chains = ['people', 'asset-hub', 'bulletin'];
// The sentences are Cucumber step files (`advanced.steps`), as in the other labs of this repository. One is an action,
// because only an action can make a root call: the next game, which a local copy has to schedule for itself.
const peopl = defineSteps({ id: 'peopl', product: { label: 'Humanity source' }, requires: { chains }, actions: {}, assertions: {} });
const dim2 = defineSteps({ id: 'dim2', product: { label: 'Jollity source' }, requires: { chains }, actions: { nextGame }, assertions: {} });

export default defineLab({
  name: 'Previewnet PoC: a new person signs up for the next game',
  app: { label: 'Humanity source', steps: peopl, chains },
  companions: { dim2: { label: 'Jollity source', steps: dim2, chains } },
  features: ['./new-person-signs-up.feature', './humanity-sign-up.feature'],
  environments: { fast: false, 'paseo-copy': false, 'previewnet-copy': {} },
  defaultEnvironment: 'previewnet-copy',
  live: { previewnet: { people: { Ada: 'PREVIEWNET_POC_ADA_MNEMONIC' } } },
  // Root calls exist on local copies only, and a run has to confirm them (`product-lab test --root-calls`).
  rootCalls: ['Game.schedule_games'],
  // Every start begins from the copy as it was made. A kept copy still holds the last run's game, and the next
  // one opens only when that has played and been reported: 13 minutes on Previewnet's phases (20 November 2026).
  keepBetweenStarts: false,
  advanced: {
    steps: ['../../apps/humanity-app/lab/opening/steps.ts', './steps.ts'], sessions: previewnetPocSessions,
  },
  advancedWhy: {
    steps: 'The sentences are Cucumber step files shared with the other labs of this repository',
    sessions: 'One person in two apps built from this checkout, each in a host process of her own',
  },
});
