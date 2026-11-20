# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @A2
Feature: Humanity's next game after results
  Scenario: After a game ends Humanity shows results, then the right next game
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And the lab schedules a game playing in 240 seconds with short phases
    And Ada is registered for the game by transaction
    And 2 lab players are registered for the game by transaction
    And the lab watches the next-game block throughout the game
    When the lab plays the game where Ada attends
    Then Ada sees the next-game block in mode "results-pending" or "closed" or "no-game"
    When the lab schedules the next game in 600 seconds
    Then Ada sees the next-game block in mode "registration-open" with the scheduled time
    And Ada never saw the finished game's time as the next game
