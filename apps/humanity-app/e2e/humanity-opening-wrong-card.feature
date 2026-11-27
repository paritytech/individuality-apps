# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@negative-control @fails-with:screen-mismatch
Feature: A new person's card is not a Member card
  Scenario: The wrong card label fails at the card check
    Given Ada is a new actor
    When Ada opens peopl at /
    When Ada shows the inline card for a host without Pocket
    Then the opening fork has advancing finalized heads
    And Ada sees the Humanity card labelled "Member"
