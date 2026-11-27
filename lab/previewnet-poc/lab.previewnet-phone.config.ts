// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Live Previewnet on the phone hosts: one person in the Polkadot app on an iOS simulator, one on an Android
// emulator. It is lab.paseo-phone.config.ts on the other network, so what differs is the build and the name:
//
//  - the app is the published dim2.testnet, which the Polkadot app opens by that name;
//  - only the builds made for Previewnet reach it: iOS DevCI (io.parity.polkadotapp.develop, link scheme
//    polkadotappdev) and Android debug (io.parity.polkadotapp.debug). The nightlies are Paseo Next V2's;
//  - each person was onboarded in that app by hand and the lab holds none of their keys: the game account is the
//    one Jollity shows on its home;
//  - the iOS DevCI build runs products on the app's older native runtime unless told otherwise (only Debug and
//    Nightly default to the core's). The published Jollity gets no answer from that one and shows "Open Jollity in
//    the Polkadot app" (23 November 2026). Turn the core's runtime on once per simulator, with the app closed
//    (the app's Debug Settings have the same switch):
//      xcrun simctl spawn <udid> defaults write "$(xcrun simctl get_app_container <udid> io.parity.polkadotapp.develop data)/Library/Preferences/io.parity.polkadotapp.develop" truApiRuntimeEnabled -bool true
//  - Appium for the simulator runs on a port of this lab's own (4733), so another session's server on the default
//    port is left alone: appium --port 4733 --use-drivers xcuitest
//
// A simulator has no camera (product-lab's iOS host says so): Ivy can open Jollity and sign up, not show a face.
//   product-lab test lab/previewnet-poc/previewnet-ios-rehearsal.feature --config lab/previewnet-poc/lab.previewnet-phone.config.ts --environment live-previewnet --own-lab --verbose
import { defineLab, defineSteps } from '@parity/product-lab';
import { nextGame } from './next-game.ts';

const chains = ['people', 'asset-hub', 'bulletin'];
const dim2 = defineSteps({ id: 'dim2', product: { label: 'Jollity' }, requires: { chains }, actions: { nextGame }, assertions: {} });

export default defineLab({
  name: 'Previewnet: people on phones join a live game',
  app: { label: 'Jollity', steps: dim2, chains, account: { testId: 'home', attribute: 'data-account',
    firstRun: { on: { url: '/permissions' }, steps: [{ click: { role: 'button', name: 'Allow access' } }] } } },
  features: ['./previewnet-ios-rehearsal.feature', './previewnet-ios-sign-up.feature', './previewnet-ios-play.feature'],
  environments: { fast: false, 'paseo-copy': false, 'previewnet-copy': false },
  hosts: {
    ios: { product: 'dim2.testnet', bundleId: 'io.parity.polkadotapp.develop', appiumUrl: 'http://127.0.0.1:4733' },
    android: { product: 'dim2.testnet', package: 'io.parity.polkadotapp.debug' },
  },
  defaultHost: 'ios',
  live: { previewnet: { people: { Ivy: { host: 'ios' }, Pat: { host: 'android' } } } },
  advanced: { steps: ['./steps.ts', './play-steps.ts'] },
  advancedWhy: { steps: 'The sentences are Cucumber step files shared with the other labs of this repository' },
});
