# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @U4
Feature: Jollity's new-version screen: after a game on the way back (U4)
  Scenario Outline: Jollity's new-version screen: after a game on the way back (U4), run <run>
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And Ada is a member
    And the lab schedules a game playing in 1200 seconds with short phases
    And Ada registers for the game through her Jollity screen
    And 2 real Jollity media peers register through their own screens
    When Ada sees Jollity show her registered seat
    Then Ada plays in Jollity and returns to her updated Humanity card, C4 run "U4-<run>"

    Examples:
      | run |
      | 1   |
      | 2   |
      | 3   |
