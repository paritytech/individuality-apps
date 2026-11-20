# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @C1
Feature: Sign up in Jollity, Humanity shows it (C1)
  Ada registers for the next game in Jollity through its real screen and her host signs.
  The lab times it until Humanity's card shows her registered: signing, inclusion, finality,
  hand-off to Humanity's data layer and render. 45 s and 90 s are labels; only a missing
  end state within 10 minutes, or a broken step, fails the run.

  Scenario Outline: Sign up in Jollity, Humanity shows it (C1), run <run>
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And the lab schedules a game playing in 1200 seconds with short phases
    And 2 lab players are registered for the game by transaction
    And the lab funds Ada's game account
    When Ada sees Humanity offer Register for the next game
    And Ada sees Jollity offer Register for the next game
    Then Ada registers in Jollity, her host signs, and Humanity shows her registered, C1 run "<run>"

    Examples:
      | run |
      | 1   |
      | 2   |
      | 3   |
