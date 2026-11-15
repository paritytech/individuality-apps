// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The ids the buttons of a chat card fire, and the custom message types the
 * renderer keys off.
 *
 * The worker handles the ids in its render handler.
 */
export const ACTION_REGISTER = "jollity.register"
export const ACTION_OPEN_GAME = "jollity.open"
export const ACTION_TUTORIAL = "jollity.tutorial"
export const ACTION_USERNAME = "jollity.username"
/** Opens the collectibles of the player in the stash product. */
export const ACTION_STASH = "jollity.stash"
/** Asks the host for the camera again, which iOS answers without a prompt once it was declined. */
export const ACTION_TURN_ON_CAMERA = "jollity.turn-on-camera"

export const MESSAGE_WELCOME = "jollity.welcome"
export const MESSAGE_GAME_CARD = "jollity.gamecard"
export const MESSAGE_INTRO = "jollity.intro"
export const MESSAGE_DAILY_DOLLAR = "jollity.dailydollar"
