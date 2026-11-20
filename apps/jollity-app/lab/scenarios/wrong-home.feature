# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@negative-control @fails-at-step-4 @fails-with:not-on-chain
Feature: A home claim needs the chain state it names
  Scenario: An idle chain cannot back the registered home
    Given Ada is a new actor
    And the lab sets the DIM2 game state to "no game scheduled"
    When Ada opens dim2 at /
    Then Ada sees DIM2 home in state "registered"
