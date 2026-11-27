# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@paseo-play @paseo-now
Feature: A person signs up for the live game on Paseo Next V2 at the last minute and plays it
  One run for a game whose sign-up is about to close: no wait for a later game.

  Scenario: Ada signs up, plays the live game and her report is finalized
    Given Ada is a new actor
    When Ada opens dim2 at /
    And Ada allows DIM2 its permissions
    And Ada registers for the game in DIM2
    And Ada plays the game and votes for the people she sees
    Then Ada's report of the game is finalized
