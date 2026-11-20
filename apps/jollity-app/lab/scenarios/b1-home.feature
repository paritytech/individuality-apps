# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@jollity-home
Feature: Jollity home follows the state set on the owned chain (B1)
  Scenario Outline: DIM2's home shows <state> for the chain state the lab set
    Given Ada is a new actor
    And the lab sets the DIM2 game state to "<setup>"
    When Ada opens dim2 at /
    Then Ada sees DIM2 home in state "<state>"
    Examples:
      | setup                              | state       |
      | no game scheduled                  | no-game     |
      | registration open, Ada funded      | register    |
      | registration open, Ada unfunded    | unfunded    |
      | Ada registered by transaction      | registered  |
      | registration closed, Ada not in it | missed      |
      | game in PlayerProcess              | wrapping-up |
