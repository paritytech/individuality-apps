# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

Feature: A new person opens DIM2 source on a local Paseo fork
  Scenario: Ada's unregistered home and lite proof survive a reload
    Given Ada is a new actor
    When Ada opens dim2 at /
    Then the opening fork has advancing finalized heads
    And Ada has a readable DIM2 lite proof
    And Ada sees DIM2 registered as "false"
    When Ada reloads DIM2
    Then Ada sees DIM2 registered as "false"
    And Ada has a readable DIM2 lite proof
