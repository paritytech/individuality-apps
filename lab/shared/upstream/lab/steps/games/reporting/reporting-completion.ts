// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
const reportingEnded = z.object({
  type: z.literal("Module"),
  value: z.object({
    type: z.literal("Game"),
    value: z.object({ type: z.enum(["NoGame", "NoReporting"]) }),
  }),
});
const processing = z.object({
  index: z.number(),
  state: z.object({ type: z.literal("PlayerProcess") }),
});
/** A late force-end call can race the runtime's own reporting completion.
 * Accept only the exact expected game in PlayerProcess, or its GameEnded event
 * in this dispatch block. Finalized completion and score assertions still follow.
 * A different game, cancellation, other dispatch error or unknown state fails. */
export function reportingAlreadyCompleted(
  error: unknown,
  gameAtDispatch: unknown,
  expectedGameIndex: number,
  endedGamesAtDispatch: readonly number[] = [],
): boolean {
  const parsed = reportingEnded.safeParse(error);
  if (!parsed.success) return false;
  if (parsed.data.value.value.type === "NoGame")
    return gameAtDispatch === undefined;
  const game = processing.safeParse(gameAtDispatch);
  return (
    (game.success && game.data.index === expectedGameIndex) ||
    (gameAtDispatch === undefined &&
      endedGamesAtDispatch.includes(expectedGameIndex))
  );
}
