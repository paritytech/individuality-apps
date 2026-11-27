// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Two people play one Jollity game on a local copy of Previewnet: new people, the lab's own game, nothing funded.
// The sign-up lab beside this one (lab.previewnet-poc.config.ts) has the single person and Humanity; this one has
// Jollity only, once per person.
import { defineLab, defineSteps } from '@parity/product-lab';
import { nextGameIn } from './next-game.ts';
import { previewnetPlaySessions } from './session.ts';

const chains = ['people', 'asset-hub', 'bulletin'];
// Two sign-ups take about two minutes: 13 minutes to play time leaves room for them and keeps the wait short.
const dim2 = defineSteps({ id: 'dim2', product: { label: 'Jollity source' }, requires: { chains }, actions: { nextGame: nextGameIn(780) }, assertions: {} });

export default defineLab({
  name: 'Previewnet: two people play one game',
  app: { label: 'Jollity source', steps: dim2, chains },
  features: ['./two-people-play.feature'],
  environments: { fast: false, 'paseo-copy': false, 'previewnet-copy': {} },
  defaultEnvironment: 'previewnet-copy',
  // Live Previewnet has no other players (22 November 2026: its games had no sign-ups), so the lab brings both: two
  // existing people, whose phrases it reads from these variables (onboard.mts makes each once).
  live: { previewnet: { people: { Ada: 'PREVIEWNET_POC_ADA_MNEMONIC', Bob: 'PREVIEWNET_POC_BOB_MNEMONIC' } } },
  // Root calls exist on local copies only, and a run has to confirm them (`product-lab test --root-calls`).
  rootCalls: ['Game.schedule_games'],
  // Every start begins from the copy as it was made. A kept copy still holds the last run's game, and the next
  // one opens only when that has played and been reported: 13 minutes on Previewnet's phases (20 November 2026).
  keepBetweenStarts: false,
  advanced: { steps: ['./steps.ts', './play-steps.ts'], sessions: previewnetPlaySessions },
  advancedWhy: {
    steps: 'The sentences are Cucumber step files shared with the other labs of this repository',
    sessions: 'Each person has a Jollity built from this checkout in a host process of their own',
  },
});
