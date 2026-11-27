# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@paseo-play @paseo-rehearsal
Feature: The lab can read a person's Jollity on Paseo Next V2 as it reads it in a game
  No game and no sign-up: Jollity is opened, read as the play loop reads it, and what the page has
  said so far is written to the run's console file. A minute, at any time of day.

  Scenario: Ada's Jollity can be read and its console is kept
    Given Ada is a new actor
    When Ada opens dim2 at /
    Then Ada's Jollity can be read as a game is read
