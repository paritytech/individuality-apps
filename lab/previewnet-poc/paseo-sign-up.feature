# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@paseo-sign-up
Feature: A person signs up for the next live game on Paseo Next V2
  Ada exists on the live network. She takes the free seat in the game real people will play.

  Scenario: Ada signs up for the next live game on the free seat
    Given Ada is a new actor
    And the next game is open for sign-up
    When Ada opens dim2 at /
    And Ada allows DIM2 its permissions
    And Ada registers for the game in DIM2
    Then Ada's DIM2 registration on chain is:
      | registered | true |
    And Ada's sign-up took the free seat
