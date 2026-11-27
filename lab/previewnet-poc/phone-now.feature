# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@phone-play @phone-now
Feature: A person on a phone signs up for the live game on Paseo Next V2 at the last minute and plays it
  One run for a game whose sign-up is about to close: no wait for a later game. She signs up in Jollity.

  Scenario: Pat signs up, plays the live game and her report is finalized
    Given Pat is a new actor
    When Pat registers for the game in DIM2
    And Pat plays the game and votes for the people she sees
    Then Pat's report of the game is finalized
