# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @B3
Feature: Apps catch up after being in the background: sign-up while Jollity was away (B3)
  Scenario Outline: Apps catch up after being in the background: sign-up while Jollity was away (B3), run <run>
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And the lab schedules a game playing in 1200 seconds with short phases
    And 2 lab players are registered for the game by transaction
    And the lab funds Ada's game account
    When Ada sees Jollity offer Register for the next game
    Then Ada backgrounds Jollity before registration, B3 run "<run>"

    Examples:
      | run |
      | 1   |
      | 2   |
      | 3   |
