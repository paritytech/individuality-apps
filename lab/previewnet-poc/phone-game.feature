# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@phone-play @phone-game
Feature: A new person on a phone signs up for the coming live game on Paseo Next V2 and plays it
  One run for a phone that was onboarded minutes ago and has never opened Jollity (a CI runner's
  emulator): its permissions, the sign-up, the game, the report and the way on after it (a hold on the
  draw, the collectables' book closed by its cover). Started about 25 minutes before
  game time, so that the sign-up has its ten minutes and the game is inside the play step's wait.
  The others in her group are whoever signed up.

  # Her collectables read their last word when the game is settled, an hour after it where she earned nothing.
  @step-limit:85m
  Scenario: Pat gives Jollity its permissions, signs up, plays the live game and her report is finalized
    Given Pat is a new actor
    And the next game is open for sign-up
    When Pat allows DIM2 its permissions
    And Pat registers for the game in DIM2
    And Pat plays the game and votes for the people she sees
    Then Pat's report of the game is finalized
    And Pat holds on the draw and closes the book on her collectables
