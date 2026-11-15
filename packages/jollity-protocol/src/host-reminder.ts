// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The host storage key of the record both the chat and the app keep of the
 * game reminder, as @individuality/sign-up's `HostReminder`.
 *
 * The host writes a calendar entry for every start it has not seen exactly,
 * and never removes one. So the first ask for a game fixes its start in the
 * record before it reaches the host, and every later ask for that game, from
 * either side and on any retry, sends the same start.
 */
export const HOST_REMINDER_KEY = "jollity.wg.host-reminder"
