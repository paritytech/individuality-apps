# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@probe
Feature: The lab's Jollity can move between its own pages
  A probe of the lab's setup, not of the product: the game is entered by a move inside the app.

  Scenario: Ada's Jollity moves from home to another page
    Given Ada is a new actor
    When Ada opens dim2 at /
    Then Ada's Jollity moves to its chest page by itself
