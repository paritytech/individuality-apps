# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @C6
Feature: Full loop: Humanity to a game and back (C6)
  Scenario: Full loop: Humanity to a game and back (C6)
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And the lab schedules a game playing in 1200 seconds with short phases
    And 2 real Jollity media peers register through their own screens
    When Ada sees Humanity offer Register for the next game
    And Ada enters Jollity from Humanity, C3 run "C6-entry"
    And the lab funds Ada's game account
    And Ada registers in Jollity, her host signs, and Humanity shows her registered, C1 run "C6-registration"
    Then Ada plays in Jollity and returns to her updated Humanity card, C4 run "C6-return"
