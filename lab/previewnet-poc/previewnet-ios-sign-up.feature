# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@previewnet-ios-sign-up
Feature: A person on an iOS simulator signs up for the next live game on Previewnet
  Ivy is the person her simulator was onboarded as. She takes the free seat, which peopl.testnet
  grants on the network: nothing is handed to a phone.

  Scenario: Ivy signs up for the next live game on the free seat
    Given Ivy is a new actor
    And the next game is open for sign-up
    When Ivy allows DIM2 its permissions
    And Ivy registers for the game in DIM2
    Then Ivy's DIM2 registration on chain is:
      | registered | true |
    And Ivy's sign-up took the free seat
