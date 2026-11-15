// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * P2, outcome honesty (#1374), judged at each send-answer
 * effect outcome. The outcome is the one the room's executePeerCommand spy
 * recorded from the effect itself, so a completion the reducer
 * ignores is judged all the same; openCommands is the completion authority.
 *
 * The answers counted are the frames ON THE WIRE (wire.ts `onWire`: the
 * transport stored it, or the lane sent it; a refused signal or an answer the
 * transport skipped as stale is not) between the command's step and its
 * outcome's, from the command's PC at issue, with `x-role:answer` and an
 * `x-answers` naming the offer that PC last resolved through SRD by the
 * command's step (the op log).
 * - `resolved` with anything but exactly one such answer is a violation;
 * - `stale` or `rejected` with one or more is a violation;
 * - except a superseded answer (below), which is not judged.
 */
import type { CommandLogEntry, RoomLogs, Violation, WireLogEntry } from "../room"
import { answeredOffer, lastResolvedOffer, offerDelivery, onWire, sender, type Monitor } from "./wire"

/**
 * Superseded, not dishonest (controller ruling, fix round 1): the statement
 * transport skips an answer to an offer older than the newest it adopted from
 * that peer (statementTransport.ts send returns early), Mesh cannot see the
 * skip, and the answer is dead anyway because the peer has moved on. So a
 * `resolved` send-answer whose only answer the transport skipped is quiet,
 * but ONLY when a newer offer from the same peer was delivered to this side
 * after the answered one and before the skipped publish (delivery log).
 */
function superseded(logs: RoomLogs, command: CommandLogEntry, offer: string | undefined, ours: (entry: WireLogEntry) => boolean): boolean {
  const skipped = logs.wire.find((entry) => ours(entry) && entry.channel === "statement" && entry.fate === "skipped")
  if (!skipped) return false
  const answered = offerDelivery(logs.deliveries, command.side, offer, skipped.step)
  if (!answered) return false
  const from = logs.deliveries.indexOf(answered)
  return logs.deliveries.some((entry, index) =>
    index > from && entry.step <= skipped.step && entry.to === command.side && entry.from === command.peer && entry.kind === "offer" && entry.xOffer !== offer,
  )
}

export const P2: Monitor = {
  id: "P2",
  // Reads one side's command, outcome, op, wire and delivery projections.
  closed: true,
  afterStep(room, record) {
    const outcomes = (record.outcomes as { commandId: number; step: number; kind: string; outcome: string }[]).filter((outcome) => outcome.kind === "send-answer")
    if (outcomes.length === 0) return []
    const logs = room.logs()
    const found: Violation[] = []
    for (const outcome of outcomes) {
      const command = logs.commands.find((entry) => entry.id === outcome.commandId) as CommandLogEntry | undefined
      if (!command) continue
      const lane = (command.command as { lane?: boolean }).lane === true
      const pc = command.pcAtIssue
      const offer = lastResolvedOffer(logs.ops, pc, command.step)
      const ours = (entry: WireLogEntry) =>
        entry.step >= command.step && entry.step <= outcome.step && sender(entry) === pc &&
        entry.xRole === "answer" && offer !== undefined && answeredOffer(entry.xAnswers) === offer
      const answers = logs.wire.filter((entry) => ours(entry) && onWire(entry)).length
      if (outcome.outcome === "resolved" && answers === 0 && superseded(logs, command, offer, ours)) continue
      const honest = outcome.outcome === "resolved" ? answers === 1 : outcome.outcome === "stale" || outcome.outcome === "rejected" ? answers === 0 : true
      if (!honest) {
        found.push({
          property: "P2",
          atStep: record.index,
          detail: `${command.side}'s ${lane ? "lane" : "statement"} send-answer on ${pc ?? "no PC"} settled ${outcome.outcome} with ${answers} answer${answers === 1 ? "" : "s"} to ${offer ?? "(no resolved offer)"} on the wire`,
        })
      }
    }
    return found
  },
}
