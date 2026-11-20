# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@real-runtime @hosted @isolated @negative-control @fails-with:not-on-chain
Feature: Humanity into a shared DIM2 game from this checkout
  Scenario: Register, play, vote and receive delivered credits (wrong credits control)
    Given these actors exist:
      | actor |
      | Alice |
      | Bob   |
      | Carol |
    And the three fresh fork players have zero PAS and no prior credits
    When the lab atomically prepares one local DIM2 game
    And Alice taps "Open the game" in Humanity
    And Bob taps "Open the game" in Humanity
    And Carol taps "Open the game" in Humanity
    When the three players register for the game in DIM2 together
    Then Alice's DIM2 registration on chain is:
      | registered |
      | true       |
    And Bob's DIM2 registration on chain is:
      | registered |
      | true       |
    And Carol's DIM2 registration on chain is:
      | registered |
      | true       |
    When the lab closes registration one minute after all three players registered
    When the three players play and vote in DIM2 together
    Then Alice's DIM2 app report is finalized
    And Bob's DIM2 app report is finalized
    And Carol's DIM2 app report is finalized
    And Alice's finalized DIM2 votes are:
      | round | person | notperson |
      | 1     | 2      | 0         |
    And Bob's finalized DIM2 votes are:
      | round | person | notperson |
      | 1     | 2      | 0         |
    And Carol's finalized DIM2 votes are:
      | round | person | notperson |
      | 1     | 2      | 0         |
    When the three players view the DIM2 game results together
    Then Alice has 3 DIM2 credits to keep on chain
