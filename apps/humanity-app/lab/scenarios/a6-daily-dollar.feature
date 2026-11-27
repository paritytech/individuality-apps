# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @A6
Feature: Humanity daily scratch settlement
  Scenario: Ada's daily scratch pays into her Coinage purse
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And Ada is a member
    And the lab opens today's draw with a 1 dollar prize that Ada wins
    When Ada opens the daily scratch
    And Ada scratches today's ticket
    Then Ada's prize claim is finalized on chain to product account 0
    And Ada's host Coinage purse answer is still Unsupported
    And product account 0 grew by the PrizeClaimed amount
    And Ada's Coinage purse grows by the prize within 60 seconds
