# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

@previewnet-poc
Feature: A new person on Previewnet signs up for the next game
  The same scenario runs on a local Previewnet and on live Previewnet. Three steps choose by what
  the environment offers: who Ada is (a new person locally, a named existing person live), what
  her Humanity card says (a Person until her first sign-up, a Candidate after it, read from the
  chain) and how the next game comes to be open (live the lab waits for one; a local copy with none
  coming gets one scheduled by the lab). Nothing is funded: Ada takes the free seat.

  Scenario: Ada's Humanity card matches her standing and she takes the free seat in Jollity
    Given Ada is a new actor
    When Ada opens peopl at /
    And Ada shows the inline card for a host without Pocket
    Then Ada's Humanity card shows her standing on chain
    Given the next game is open for sign-up
    When Ada opens dim2 at /
    And Ada allows DIM2 its permissions
    And Ada registers for the game in DIM2
    Then Ada's DIM2 registration on chain is:
      | registered | true |
    And Ada's sign-up took the free seat
