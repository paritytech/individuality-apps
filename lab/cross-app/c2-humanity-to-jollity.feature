# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @C2
Feature: Sign up in Humanity, Jollity shows it (C2)
  Ada registers for the next game in Humanity through its real screen and her host signs.
  The lab times it until Jollity's home says "You're in": signing, inclusion, finality,
  hand-off to Jollity's data layer and render. 45 s and 90 s are labels; only a missing
  end state within 10 minutes, or a broken step, fails the run.

  Scenario Outline: Sign up in Humanity, Jollity shows it (C2), run <run>
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And the lab schedules a game playing in 1200 seconds with short phases
    And 2 lab players are registered for the game by transaction
    And the lab funds Ada's game account
    And the lab funds Ada's name-link deposit on Asset Hub
    When Ada sees Jollity offer Register for the next game
    And Ada sees Humanity offer Register for the next game
    And the lab waits for Humanity to see Ada's finalized funding
    Then Ada registers in Humanity, her host signs, and Jollity shows You're in, C2 run "<run>"

    Examples:
      | run |
      | 1   |
      | 2   |
      | 3   |
