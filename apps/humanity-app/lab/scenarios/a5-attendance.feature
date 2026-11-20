# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@environment:paseo-copy @A5
Feature: Humanity attendance and streak consistency
  Scenario Outline: The attendance row shows exactly what the chain recorded
    Given the lab drains imported games before the scenario
    And Ada is a new actor
    And Ada is a member
    When the lab plays games where Ada's attendance is "<pattern>"
    Then Ada's score record on chain has attendance history "<pattern>"
    And Ada sees the attendance row:
      | value    | <value>  |
      | attended | <played> |
      | missed   | <missed> |
    Examples:
      | pattern | value                | played | missed |
      | AAAMM   | Missed the last game | 6      | 2      |
      | MMAAA   | 3 in a row           | 6      | 2      |
      | AMAMA   | 1 in a row           | 6      | 2      |
