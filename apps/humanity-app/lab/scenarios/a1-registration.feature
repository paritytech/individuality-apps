# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @A1
Feature: Humanity registration from a transaction
  Scenario: A registration made on chain shows in Humanity as Registered
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And the lab schedules a game playing in 480 seconds with short phases
    When Ada opens peopl at /
    Then Ada sees the next-game block in mode "registration-open"
    When Ada is registered for the game by transaction
    Then Ada sees the next-game block in mode "confirmed" within 45 seconds
    When Ada reloads Humanity
    Then Ada sees the next-game block in mode "confirmed"
