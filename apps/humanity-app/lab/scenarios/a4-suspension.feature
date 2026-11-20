# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @A4
Feature: Humanity warnings and suspension
  Scenario: Missed games warn Ada, then suspend her membership
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And Ada is a member with 3 attended games
    And the lab sets the absence grace to 1 miss in a window of 3
    When the lab plays a game where Ada misses
    Then Ada sees the Humanity card labelled "Member, at risk"
    And Ada sees the caution note "Play {when} to keep it."
    When the lab records one further missed game for Ada by forced attendance
    Then Ada sees the Humanity card labelled "Suspended"
    And Ada's score record on chain shows recognition "Suspended"
