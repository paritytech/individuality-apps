# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

Feature: A new person opens Humanity source on a local Paseo fork
  Scenario: Ada's home and Person card survive a reload
    Given Ada is a new actor
    When Ada opens peopl at /
    When Ada shows the inline card for a host without Pocket
    Then the opening fork has advancing finalized heads
    And Ada sees the Humanity card labelled "Person"
    When Ada reloads Humanity
    Then Ada sees the Humanity card labelled "Person"
