# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @C4
Feature: Play a real game, Humanity's card updates (C4)
  Scenario Outline: Play a real game, Humanity's card updates (C4), run <run>
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And Ada is a member
    And the lab schedules a game playing in 1200 seconds with short phases
    And Ada registers for the game through her Jollity screen
    And 2 real Jollity media peers register through their own screens
    When Ada sees Jollity show her registered seat
    Then Ada plays in Jollity and returns to her updated Humanity card, C4 run "<run>"

    Examples:
      | run |
      | 1   |
      | 2   |
      | 3   |
