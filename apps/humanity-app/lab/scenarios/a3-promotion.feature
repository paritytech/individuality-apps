# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @A3
Feature: Humanity promotion through chain-driven games
  Scenario: Two attended games promote Ada and give her the full name
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And Ada sees the Humanity card labelled "Person"
    When Ada attends 2 games played by the lab
    Then Ada's score record on chain shows recognition "Recognized" or reached personhood
    And Ada sees the promotion screen "You're a member"
    When Ada taps "Choose your name"
    And Ada claims her member username
    Then Ada sees the Humanity card labelled "Member"
    And Ada's card shows her claimed member username
    And Ada's full username resolves on chain
