# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @U3
Feature: Jollity's new-version screen: while opening Jollity from Humanity (U3)
  Scenario Outline: Jollity's new-version screen: while opening Jollity from Humanity (U3), run <run>
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And the lab schedules a game playing in 1200 seconds with short phases
    And 2 lab players are registered for the game by transaction
    When Ada sees Humanity offer Register for the next game
    Then Ada meets the local update gate during entry, U3 run "<run>"

    Examples:
      | run |
      | 1   |
      | 2   |
      | 3   |
