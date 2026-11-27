# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@paseo-play
Feature: A person plays the live game she signed up for on Paseo Next V2
  Run about twenty minutes before game time, after the sign-up scenario. The others in her group
  are real people. Her camera is Chromium's synthetic one, and she taps each person she is shown.

  Scenario: Ada plays the live game and her report is finalized
    Given Ada is a new actor
    When Ada opens dim2 at /
    And Ada plays the game and votes for the people she sees
    Then Ada's report of the game is finalized
