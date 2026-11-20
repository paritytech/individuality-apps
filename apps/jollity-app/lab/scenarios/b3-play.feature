# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@jollity-play @pending-transaction-media-keys
Feature: Three Jollity players play and report (B3)
  Scenario: Three players play one DIM2 game and their reports are finalized
    Given Alice, Bob and Carol are new actors registered for the game by transaction
    When the lab closes registration one minute after all three players registered
    And Alice, Bob and Carol play and vote in the DIM2 app together
    Then Alice's finalized DIM2 votes are:
      | round | person | notperson |
      | 1     | 2      | 0         |
    And Alice's DIM2 app report is finalized
