// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * LATE JOIN.
 *
 * A registered player who missed the waiting room joins a running game at
 * any turn (#699): the home hands them to /game while turns remain
 * (app/page.tsx), the same way it hands back a player who reloaded or
 * relaunched mid-game. Only a game whose last turn is over turns them away.
 *
 * Joining late costs the latecomer, not the others. A co-player's phone casts
 * no vote on them for the turns before it first sees their video, and a
 * co-player who sat in a round with them but never saw them files NotPerson
 * (#445). In turn, a co-player the latecomer never shared a turn with gets
 * `Person` from them rather than `NotPerson` (lib/game-session.ts
 * `voteShown`, with lib/game-roster.ts `sharedTurnWith`; #520), so nobody is
 * voted down by a latecomer who never saw them.
 */

/** the verdict for a co-player no turn of yours ever had in it */
export const UNSEEN_VERDICT = "person"
