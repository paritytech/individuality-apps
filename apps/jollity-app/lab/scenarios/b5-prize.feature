# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@jollity-prize @pending-game-prize-helpers
Feature: The game prize draw (B5)
  Scenario: A recognized player claims the game airdrop in DIM2
    Given Ada is a new actor
    And Ada attended the last game and has reached personhood
    And the game paid one airdrop that Ada won
    When Ada opens the DIM2 prize draw
    And Ada claims her prize
    Then the claim is finalized and Ada's prize balance grows
