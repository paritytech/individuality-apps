# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @negative-control @A5-control
Feature: Reject a wrong attendance row
  Scenario: An incorrect played count fails at the attendance assertion
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And Ada is a member
    When the lab plays games where Ada's attendance is "AAAMM"
    Then Ada's score record on chain has attendance history "AAAMM"
    And Ada sees the attendance row:
      | value    | Missed the last game |
      | attended | 9                    |
      | missed   | 2                    |
