# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@phone-sign-up
Feature: A person on a phone signs up for the next live game on Paseo Next V2
  Pat is the person her phone was onboarded as. She takes the free seat, which peopl.paseo has to
  grant on the network: nothing is handed to a phone.

  Scenario: Pat signs up for the next live game on the free seat
    Given Pat is a new actor
    And the next game is open for sign-up
    When Pat allows DIM2 its permissions
    And Pat registers for the game in DIM2
    Then Pat's DIM2 registration on chain is:
      | registered | true |
    And Pat's sign-up took the free seat
