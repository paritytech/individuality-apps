# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@previewnet-play
Feature: Two people play one game on Previewnet
  Ada and Bob sign up in Jollity for the same game on the free seat, play it, vote for each other,
  and each one's report is read back from the finalized People chain. On a local copy they are new
  people and the game is the lab's own; nothing is funded.

  Scenario: Ada and Bob play the next game and their reports are finalized
    Given Ada is a new actor
    And Bob is a new actor
    And the next game is open for sign-up
    When Ada opens dim2 at /
    And Ada allows DIM2 its permissions
    And Ada registers for the game in DIM2
    And Bob opens dim2 at /
    And Bob allows DIM2 its permissions
    And Bob registers for the game in DIM2
    And Ada and Bob play the game and vote for each other
    Then Ada's report of the game is finalized
    And Bob's report of the game is finalized
