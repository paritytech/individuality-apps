# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@negative-control @fails-with:screen-mismatch
Feature: A new person has not registered for DIM2
  Scenario: The wrong registration expectation fails at the final check
    Given Ada is a new actor
    When Ada opens dim2 at /
    Then the opening fork has advancing finalized heads
    And Ada has a readable DIM2 lite proof
    And Ada sees DIM2 registered as "true"
