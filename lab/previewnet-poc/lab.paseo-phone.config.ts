// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The Paseo trial on a phone: one person in the Polkadot app on an Android device joins a game real people play on
// live Paseo Next V2. The steps are the desktop trial's (lab.paseo-play.config.ts); what differs is who opens the
// page. Here it is product-lab's own session, the only way to a phone:
//
//  - the app is the published dim2.paseo, which the Polkadot app opens by its product id (the steps' id and the
//    network's TLD), not a build of this checkout;
//  - the person was onboarded in that app by hand, and the lab holds none of her keys: her game account is the one
//    Jollity shows on its home;
//  - "Given Pat is a new actor" binds Pat to her device and opens Jollity there, so no scenario opens it again;
//  - which device she is on is the machine's to say, on the command line of a phone run and NOT in the .env beside
//    this file: that file is shared with the other labs of this folder, and product-lab refuses a lab whose people
//    the variable does not name (20 November 2026: every desktop lab here stopped planning).
//      PRODUCT_LAB_PHONES=Pat=emulator-5590/<her lite username> product-lab test …
//
// The free seat needs peopl.paseo to publish its grant to dim2: a phone cannot be handed one from a file, as the
// desktop trial's host is. Until then only phone-permissions.feature can pass.
//   PRODUCT_LAB_PHONES=… product-lab test lab/previewnet-poc/phone-permissions.feature --config lab/previewnet-poc/lab.paseo-phone.config.ts --environment live-next-v2
import { defineLab, defineSteps } from '@parity/product-lab';
import { nextGame } from './next-game.ts';

const chains = ['people', 'asset-hub', 'bulletin'];
const dim2 = defineSteps({ id: 'dim2', product: { label: 'Jollity' }, requires: { chains }, actions: { nextGame }, assertions: {} });

export default defineLab({
  name: 'Paseo Next V2: a person on a phone joins a live game',
  // Every person here is on a phone, which opens Jollity by its name: the lab starts no dev server (product-lab 0.6.0).
  // The Android host cannot tell the lab her account, so the lab reads it from Jollity's home when it opens the app.
  // A phone that has never opened Jollity shows its one-time permissions screen first: the lab presses "Allow access"
  // there, and skips that on a phone that has passed the screen.
  app: { label: 'Jollity', steps: dim2, chains, account: { testId: 'home', attribute: 'data-account',
    firstRun: { on: { url: '/permissions' }, steps: [{ click: { role: 'button', name: 'Allow access' } }] } } },
  features: ['./phone-permissions.feature', './phone-rehearsal.feature', './phone-sign-up.feature', './phone-play.feature', './phone-now.feature'],
  environments: { fast: false, 'paseo-copy': false, 'previewnet-copy': false },
  hosts: { android: { product: 'dim2.paseo' } },
  defaultHost: 'android',
  live: { 'next-v2': { people: { Pat: { host: 'android' } } } },
  advanced: { steps: ['./steps.ts', './play-steps.ts'] },
  advancedWhy: { steps: 'The sentences are Cucumber step files shared with the other labs of this repository' },
});
