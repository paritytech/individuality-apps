# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @B1
Feature: Apps catch up after being in the background: missed game while Humanity was away (B1)
  Scenario Outline: Apps catch up after being in the background: missed game while Humanity was away (B1), run <run>
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And Ada is a member
    And the lab sets the absence grace to 1 miss in a window of 3
    And the lab schedules a game playing in 1200 seconds with short phases
    And 2 lab players are registered for the game by transaction
    And the lab funds Ada's game account
    When Ada sees Humanity offer Register for the next game
    And Ada sees Jollity offer Register for the next game
    And Ada registers in Jollity, her host signs, and Humanity shows her registered, C1 run "B1-<run>"
    Then Ada misses the registered game, B1 run "<run>"

    Examples:
      | run |
      | 1   |
      | 2   |
      | 3   |
