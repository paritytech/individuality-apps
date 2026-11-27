// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// A trial beside the Previewnet labs: one named person joins a game real people play on live Paseo Next V2. She is
// the person `onboard.mts paseo-next-v2 Ada` made, whose phrase the lab reads from PASEO_PLAY_ADA_MNEMONIC. The lab
// changes nothing on the network but what she does in Jollity: it has no root call there and funds nobody.
//
// Two scenarios, run apart because a live game is hours away when she signs up: the sign-up, and later the play.
//   product-lab test lab/previewnet-poc/paseo-sign-up.feature --config lab/previewnet-poc/lab.paseo-play.config.ts --environment live-next-v2 --own-lab
//   product-lab test lab/previewnet-poc/paseo-play.feature    --config …                                        (about 20 minutes before game time)
import { defineLab, defineSteps } from '@parity/product-lab';
import { nextGame } from './next-game.ts';
import { paseoPlaySessions } from './session.ts';

const chains = ['people', 'asset-hub', 'bulletin'];
const dim2 = defineSteps({ id: 'dim2', product: { label: 'Jollity source' }, requires: { chains }, actions: { nextGame }, assertions: {} });

export default defineLab({
  name: 'Paseo Next V2: one person joins a live game',
  app: { label: 'Jollity source', steps: dim2, chains },
  features: ['./paseo-sign-up.feature', './paseo-play.feature', './probe.feature', './paseo-now.feature', './paseo-rehearsal.feature'],
  environments: { fast: false, 'paseo-copy': false, 'previewnet-copy': false },
  live: { 'next-v2': { people: { Ada: 'PASEO_PLAY_ADA_MNEMONIC' } } },
  advanced: { steps: ['./steps.ts', './play-steps.ts', './probe-steps.ts'], sessions: paseoPlaySessions },
  advancedWhy: {
    steps: 'The sentences are Cucumber step files shared with the other labs of this repository',
    sessions: 'Her Jollity is built from this checkout, in a host process of her own',
  },
});
