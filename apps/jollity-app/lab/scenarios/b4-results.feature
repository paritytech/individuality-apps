# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@jollity-results
Feature: Results and chest from transaction-seeded reports (B4)
  Scenario: After the game DIM2 shows results and Ada keeps her credits
    Given Ada is a new actor
    And Ada played a game in which both other players reported her
    # The chest only reads and animates claims. Credits read before and after it show it leaves them unspent.
    Then Ada has 2 DIM2 credits to keep on chain
    When Ada views the DIM2 game results
    # Plan adaptation: there is no Claim all control. The chest collects on its own and Continue hands over to Humanity.
    Then Ada's chest opened before its backstop and offers Continue
    And Ada still has 2 DIM2 credits to keep on chain
