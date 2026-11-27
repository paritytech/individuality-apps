# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@phone-permissions
Feature: A person on a phone gives Jollity its permissions
  The first thing a phone has to get right, with no game and no seat: Jollity opens in the Polkadot
  app, its permissions screen is walked, and the camera opens once, so that every sheet is answered
  long before a game.

  Scenario: Pat opens Jollity on her phone and gives it the camera
    Given Pat is a new actor
    Then Pat allows DIM2 its permissions
