# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@jollity-permissions @pending-host-permissions
Feature: Permission refusal and recovery (B6)
  # Pending at the refusal action: the pinned unpatched host cannot decide one request.
  Scenario: Refusing access shows Try again, and allowing it reaches home
    Given Ada is a new actor
    When Ada opens dim2 at / and refuses access once
    Then Ada sees "Try again"
    When Ada allows access
    Then Ada sees DIM2 home in state "no-game"
