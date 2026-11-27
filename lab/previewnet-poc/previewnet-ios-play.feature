# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@previewnet-ios-play
Feature: A person on an iOS simulator plays the live game she signed up for on Previewnet
  Run before game time, after the sign-up scenario. A simulator has no camera, so this is
  expected to stop where Jollity asks for one: the step it stops at is the finding.

  Scenario: Ivy plays the live game and her report is finalized
    Given Ivy is a new actor
    When Ivy plays the game and votes for the people she sees
    Then Ivy's report of the game is finalized
