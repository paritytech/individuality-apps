# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@previewnet-ios-rehearsal
Feature: Jollity on an iOS simulator on live Previewnet can be read as a game is read
  Everything the play scenario asks of a page except a game, so that a page that cannot do it
  fails here and not at game time.

  Scenario: Ivy's Jollity is read as the play loop reads it
    Given Ivy is a new actor
    Then Ivy's Jollity can be read as a game is read
