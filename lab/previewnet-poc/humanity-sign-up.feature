# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@previewnet-poc @humanity-sign-up
Feature: A person on Previewnet signs up for the next game from Humanity
  Register on Humanity's next-game block signs the DIM2 game account up without Jollity: the way a
  person signs up on a host where Jollity may not use Humanity's key. Jollity is opened first, so
  that it links her name to the game account, which Humanity cannot do for an account without PGAS.
  The same scenario runs on a local Previewnet and on live Previewnet.

  Scenario: Ada registers in Humanity, takes the free seat, and Jollity shows her in
    Given Ada is a new actor
    When Ada opens dim2 at /
    And Ada allows DIM2 its permissions
    And Ada opens peopl at /
    And Ada shows the inline card for a host without Pocket
    Given the next game is open for sign-up
    When Ada registers for the game in Humanity
    Then Ada's DIM2 registration on chain is:
      | registered | true |
    And Ada's sign-up took the free seat
    And Ada's DIM2 home shows her registered
