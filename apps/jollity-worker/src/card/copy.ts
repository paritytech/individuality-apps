// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Every string the game card says, in ASCII only.
 *
 * The host loads the worker script as Latin-1 and the payload codec of a
 * custom message is `charCodeAt & 0xff`, so there are no emoji, em-dashes or
 * curly quotes, only hyphens and straight quotes. The rules are in intro.ts.
 */

export const NEXT_GAME = "Next game"
/**
 * The line a host shows for the game card where it lists the card without drawing it, such as the chats list.
 *
 * It stays as posted while the card redraws, since truapi has no way to edit a message, so it holds for every face, a cancelled game included.
 */
export const GAME_CARD_ALT = "Your weekly game. Tap to join or see results."
/** The button that signs the player up for the next game. */
export const ILL_BE_THERE = "I'll be there"
/** The label on the slide that registers, where the host draws one in place of I'll be there. */
export const SLIDE_TO_REGISTER = "Slide to register"
/** The line under the card of a player who declined the camera. */
export const CAMERA_OFF = "Camera is off. Turn it on to play."
/** The button beside the camera line. */
export const TURN_ON = "Turn on"
export const REGISTERED = "Registered"
export const HOW_TO_PLAY = "How to play"
/** The disabled button before sign-up opens. It names no time, because the
 *  chain opens sign-up when it creates the game, which is only projected
 *  until then. The native Polkadot Prizes card says the same. */
export const OPENING_SOON = "Opening soon"
/** Heads the countdown of the last five minutes, on the pill of a host or on the card. */
export const GAME_STARTING_IN = "Game starting in"
/** Heads the countdown to the join on the card of a registered player. */
export const LEFT_TO_JOIN = "Left to join"
/** It stands where the date was once registration has shut. */
export const REGISTRATION_CLOSED = "Registration closed"
export const GAME_CANCELLED = "Game cancelled"
/** The way into a running game from the card. */
export const START_PLAYING = "Start playing"
/** Heads the card once the game has started, for a registered player. */
export const LIVE_NOW = "Live now"
/** Along the top of the card of a game ahead, beside a circle for each game still between a candidate and membership. */
export const GAMES_TO_MEMBERSHIP = (count: number) => `${count} ${count === 1 ? "game" : "games"} to Membership`

export const REGISTRATION_CLOSED_NOTICE = "You just missed this one. Stay tuned for the next game."
/** The notice under I'll be there when a sign-up from the chat did not go through. */
export const SIGN_UP_FAILED = "Couldn't sign you up."
/** The notice under I'll be there, here and in the app, while the People chain says nobody owns the username of the player. */
export const NAME_UNOWNED = "Your username isn't registered. Open your membership card to set it up."
/** The notice under I'll be there while the host or the phone refuses the reminders of the game. */
export const NOTIFICATIONS_REQUIRED = "Enable notifications to join game."
/** The notice under I'll be there of the game product in a host that cannot remind yet. */
export const REMINDERS_UNSUPPORTED = "Update to new version to join game."
/** The notice under a button whose product the host did not open, by the name the player knows. */
export const openFailed = (product: string) => `The Polkadot app couldn't open ${product}. Update it to the latest version.`

/** The pending card, while the chain still takes the votes on the player. */
export const VOTES_COMING = "We are still waiting for the votes on you."
/** Under the votes, counting to when the chain stops taking them. */
export const VOTING_ENDS = (countdown: string) => `Voting ends in ${countdown}`
export const GAME_ENDED = "Game ended"
/** Under Game ended for a member who did not pass, as the native card says it. */
export const GOT_AWAY = "This one got away."
/** The line under it. */
export const NEXT_CHANCE = "Your next chance awaits."

/** The new member card, one sentence a line since the host does not centre wrapped text. */
export const GAME_SUCCEEDED = "Game succeeded."
/** Under Game succeeded for a new member and for a standing one, the one line native has for a pass. */
export const GOT_MEMBERSHIP = "You got Membership!"
/** Under the new member card, the line the native chat list shows for the moment. */
export const MEMBER_STATUS = "You're a Polkadot Member!"
/** The collectibles box of the new member card, with no number until the claims on Asset Hub are read. */
export const EARNED_COLLECTIBLES = (count: number | null) =>
  count === null ? "You've earned collectibles." : `You've earned ${count} ${count === 1 ? "collectible" : "collectibles"}.`
export const OPEN_COLLECTIBLES = "Open Collectibles"
/** The same box when the game earned nothing, in the words of the native results card. */
export const NO_REWARDS = "No rewards for this game"
/** The progress line under the headline, only ever with a count the source
 *  knows. A null count says nothing rather than invent one. */
export const N_MORE_TO_MEMBER = (count: number) =>
  `${count} more ${count === 1 ? "game" : "games"} to become a Polkadot Member.`
/** The same nudge without a number, for a source that cannot count, so the
 *  card still points forward. The worker sends a null `gamesToMembership` when
 *  the chain gives no count. */
export const PLAY_AGAIN = "Play again to get your Membership."
export const MEMBER_NAME = "Set up your member name"
/** In place of the name button while the chain is still adding the member to the ring the name is claimed with. */
export const NAME_PENDING = "Finishing your membership..."
/** In place of the name button once the full username is set, the note of the design. */
export const NAME_UPGRADED = "You upgraded your username"

// The prize draw shows as the won ticket of the design. The prize is claimed
// by itself, by the app's draw screen or else by the worker after the game
// settles, so the card has no Claim button: a line under the ticket says
// where the claim stands. A winner the chain will not pay, for not being a
// member after the game, gets no ticket, only two lines that say why.
export const PRIZE_DRAW = "Prize draw"
export const YOU_WON = "You won the prize"
export const CLAIMING = "Claiming your prize…"
export const CLAIMED = "Prize claimed."
export const CLAIM_IN_APP = "You can still claim it in Jollity."
export const NOT_ELIGIBLE = "You aren't eligible for the prize draw yet."
export const MEMBERS_ONLY = "Only members can claim prizes."
export const CLAIM_CANCELLED = "The claim didn't go through."
export const CLAIM_FAILED = "This prize can't be claimed right now."

// The missed card draws each sentence as its own line, since the host has no
// text alignment and a wrapped line would sit left in the centred card.
export const MISSED_OR_FAILED = "You missed the game or didn't pass."
export const MISSED_PLAY_N_MORE = (count: number) =>
  `Play ${count} more ${count === 1 ? "game" : "games"} to get your Membership.`
export const MISSED = "You missed the game."
export const PLAYED_NOT_PASSED = "You played but didn't pass."
export const PLAYED_EARNED = (count: number) => `You earned ${count} ${count === 1 ? "collectible" : "collectibles"}.`
export const PLAYED_CLAIM_IN_STASH = (count: number) => `Open your Stash to claim ${count === 1 ? "it" : "them"}.`
export const OPEN_STASH = "Open Stash"
/** For a member with no allowed miss left. */
export const LAST_MISS = "Miss the next game and your Membership pauses."
export const MISSED_PAUSED = "Your Membership is on pause until you play again."
export const PLAYED_PAUSED = "Your Membership is on pause until you pass a game."
