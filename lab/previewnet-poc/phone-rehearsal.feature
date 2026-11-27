# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@phone-rehearsal
Feature: A phone's Jollity can be read as a game is read
  Everything the play scenario asks of a page except a game, so that a page that cannot do it
  fails here and not at game time.

  Scenario: Pat's Jollity is read as the play loop reads it
    Given Pat is a new actor
    Then Pat's Jollity can be read as a game is read
