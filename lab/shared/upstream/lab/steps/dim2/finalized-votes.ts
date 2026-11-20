// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import type { PeopleConnection } from "../humanity/chain/people.ts";
import { assertDim2ReportProof, isShutOut, type Dim2ReportOutcome, type LiveGame } from "./live-game.ts";

export interface Dim2VoteRound {
  readonly round: number;
  readonly person: number;
  readonly notperson: number;
}

/** The report's actual arguments, read from its exact finalized block and extrinsic index. */
export async function readDim2Votes(
  access: Pick<PeopleConnection["access"], "blockAt" | "extrinsics" | "finalizedHead">,
  proof: Dim2ReportOutcome,
  game: LiveGame,
  account: string,
) {
  if (isShutOut(proof)) throw new Error(`No finalized DIM2 votes for ${account}: game ${game.index} shut this report out`);
  assertDim2ReportProof(proof, game, account);
  const [head, block, entries] = await Promise.all([
    access.finalizedHead(), access.blockAt(proof.event.block), access.extrinsics(proof.event.blockHash, { includeCallArguments: true }),
  ]);
  if (head.number < proof.event.block || block?.hash !== proof.event.blockHash)
    throw new Error(`DIM2 report block #${proof.event.block} is not on the finalized chain`);
  const entry = entries?.find((value) => value.index === proof.event.extrinsicIndex);
  if (!entry || entry.hash !== proof.txHash || entry.decoded !== "complete" || entry.call?.pallet !== "Game" || entry.call.name !== "report")
    throw new Error(`Cannot decode the exact finalized Game.report ${proof.txHash} at #${proof.event.block}:${proof.event.extrinsicIndex}`);
  const args = entry.callArguments;
  if (!args || typeof args !== "object" || !("full_report" in args) || !Array.isArray(args.full_report) || !args.full_report.length)
    throw new Error(`Finalized Game.report ${proof.txHash} has no decoded full_report`);
  const rounds = args.full_report.map((votes: unknown, index: number): Dim2VoteRound => {
    if (!Array.isArray(votes) || !votes.length) throw new Error(`Finalized DIM2 round ${index + 1} has no votes`);
    let person = 0, notperson = 0;
    for (const vote of votes) {
      if (!vote || typeof vote !== "object" || !("type" in vote)) throw new Error(`Unreadable finalized DIM2 vote in round ${index + 1}`);
      if (vote.type === "Person") person++;
      else if (vote.type === "NotPerson") notperson++;
      else throw new Error(`Unknown finalized DIM2 vote in round ${index + 1}`);
    }
    return { round: index + 1, person, notperson };
  });
  return { account, game: game.index, block: proof.event.block, blockHash: proof.event.blockHash, txHash: proof.txHash, extrinsicIndex: entry.index, rounds };
}

/** Every round and both counts must match; a partial table cannot hide rejected votes. */
export function assertDim2Votes(found: { rounds: readonly Dim2VoteRound[] }, expected: readonly { round: string; person: string; notperson: string }[]): void {
  assert.deepEqual(found.rounds, expected.map((row) => ({ round: Number(row.round), person: Number(row.person), notperson: Number(row.notperson) })), "Finalized DIM2 votes differ");
}
