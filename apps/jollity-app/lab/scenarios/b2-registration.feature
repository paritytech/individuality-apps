# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@jollity-registration
Feature: Jollity registers through each seat route (B2)
  Scenario Outline: Ada registers in DIM2 on the <route> route
    Given Ada is a new actor
    And the lab gives Ada the "<route>" seat
    And the lab schedules a game opening in 300 seconds with short phases
    When Ada opens dim2 at /
    And Ada registers for the game in DIM2
    Then Ada's DIM2 registration on chain is:
      | registered | true |
    # Plan adaptation: the opening's `sees DIM2 registered as "true"` waits for the Register control,
    # which the home hides once Ada is in. This checks the registered home itself.
    And Ada sees the registered DIM2 home
    Examples:
      | route   |
      | free    |
      | deposit |
