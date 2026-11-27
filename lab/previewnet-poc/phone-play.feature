# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@phone-play
Feature: A person on a phone plays the live game she signed up for on Paseo Next V2
  Run about twenty minutes before game time, after the sign-up scenario. The others in her group
  are real people; her camera is the device's.

  Scenario: Pat plays the live game and her report is finalized
    Given Pat is a new actor
    When Pat plays the game and votes for the people she sees
    Then Pat's report of the game is finalized
