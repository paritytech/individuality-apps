// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The signalling transport's `keys.secret` (statement-core `SignallingKeys`):
 * this player's own key, with what each lookup tells the trace.
 *
 * Each lookup marks the join and the game (`signallingKeyLookedUp`). A miss
 * whose reads gave no answer goes back to the transport as "no-answer", so a
 * slow read is never counted as a missing key. A definite miss claims the
 * join's one `own-key-missing` failure, which goes out once the sign-up
 * surface is read. That read (lib/host/game-registration.ts
 * `readSignUpSurface`) runs once per game beside the lookup and never in its
 * way: the secret goes back to the transport whether or not it has answered.
 */
import type { GameEngine } from "@jollity/protocol"
import { lookUpSignallingSecret, type OwnKeyLookup } from "./host/communication-key"
import { humanityProduct, readSignUpSurface, type SignUpSurfaceFacts } from "./host/game-registration"
import { currentGameIndex, noteSignUpSurface, ownKeyMissed, signallingKeyLookedUp } from "./journeys/game-trace"
import { withTimeout } from "./with-timeout"

/** the one chain read of the game a page makes here, when the session has not
 *  said which game it is yet */
const GAME_READ_TIMEOUT_MS = 10_000

export function ownKeySecret(
  player: string | undefined,
  engine: Pick<GameEngine, "communicationIdentifier" | "game">,
): () => Promise<Uint8Array | null | "no-answer"> {
  // the game: the session's once it has said, else one chain read, kept once
  // it answers (a read that gave nothing is asked again next time)
  let gameRead: Promise<number | null> | undefined
  const gameIndex = (): Promise<number | null> => {
    const known = currentGameIndex()
    if (known !== null) return Promise.resolve(known)
    const read = (gameRead ??= withTimeout(engine.game(), GAME_READ_TIMEOUT_MS).then(
      (game) => game?.index ?? null,
      () => null,
    ))
    void read.then((index) => {
      if (index === null && gameRead === read) gameRead = undefined
    })
    return read
  }

  // read once per game
  let surfaceRead: { game: number | null; facts: Promise<SignUpSurfaceFacts> } | undefined
  const signUpSurface = async (): Promise<SignUpSurfaceFacts> => {
    const game = await gameIndex()
    if (!surfaceRead || surfaceRead.game !== game) surfaceRead = { game, facts: readSignUpSurface(game) }
    const facts = await surfaceRead.facts
    noteSignUpSurface(game, facts)
    return facts
  }

  return async () => {
    const surface = signUpSurface()
    // a lookup that threw (a chain read that failed) gave no answer; no
    // player is no identifier
    let lookup: OwnKeyLookup = { secret: null, cause: player ? "no-answer" : "no-identifier" }
    try {
      if (player) lookup = await lookUpSignallingSecret(player, engine)
      return lookup.cause === "no-answer" ? "no-answer" : lookup.secret
    } finally {
      // to the trace, a read that failed included: a miss means this player links with nobody
      signallingKeyLookedUp(!!lookup.secret, lookup)
      const { cause, reads, refusal } = lookup
      if (cause !== "found") ownKeyMissed({ cause, reads, refusal, humanityProduct: humanityProduct() }, surface)
    }
  }
}
