// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The named warmup preconditions (the self-test's check 1). A mutant's `warmup`
 * is a list of real enabled labels; after they replay on the UNMUTATED room,
 * the precondition its spec names must hold, or the mutant is not found
 * however red the search turns. Each predicate reads only the harness's own
 * records (the wire log, the command and outcome logs, the enabled labels)
 * and Mesh's connection map through the internals cast, never a Mesh verdict.
 */
import type { Room, WireLogEntry } from "../mesh/room"

const published = (room: Room, from: string, kind: WireLogEntry["kind"]): WireLogEntry[] =>
  room.logs().wire.filter((entry) => entry.channel === "statement" && entry.from === from && entry.kind === kind && entry.fate === "published")

/**
 * M1385's: two offers from `a`'s
 * two PCs are deliverable to `b`'s new session at once, one captured and one
 * stored. What it checks, from the wire log and the enabled labels:
 * - `b` reloaded (it published a second hello) and holds a connection for `a`;
 * - `a/1`'s offer (x-pc a/1) has an enabled `deliver` and no `capture`: the
 *   room offers `capture` for every deliverable non-hello frame that is not
 *   in flight and not yet read by this session, so it is the copy `b`'s new
 *   transport captured (in its in-flight queue);
 * - `a/2`'s offer (x-pc a/2) has an enabled `deliver` and an enabled
 *   `capture`: it is in the store, not yet read.
 */
function twoOffersDeliverable(room: Room): boolean {
  const offers = published(room, "a", "offer")
  const first = offers.find((entry) => entry.xPc === "a/1")
  const second = offers.find((entry) => entry.xPc === "a/2")
  if (!first?.id || !second?.id) return false
  if (published(room, "b", "hello").length < 2) return false
  if (!room.internals("b").conns.get("a")) return false
  const enabled = new Set(room.enabled())
  const wire = (id: string, action: string) => `wire:a>b:${id}:${action}`
  return (
    enabled.has(wire(first.id, "deliver")) &&
    !enabled.has(wire(first.id, "capture")) &&
    enabled.has(wire(second.id, "deliver")) &&
    enabled.has(wire(second.id, "capture"))
  )
}

/**
 * M1374s's: `b` has an open statement send-answer (the command
 * was issued and its effect has not settled), and `env:signal-throws:b` is
 * enabled, so the answer's signal can still be refused.
 */
function bSendAnswerOpen(room: Room): boolean {
  const logs = room.logs()
  const open = logs.commands.filter(
    (command) =>
      command.side === "b" &&
      command.kind === "send-answer" &&
      (command.command as { lane?: boolean }).lane !== true &&
      !logs.outcomes.some((outcome) => outcome.commandId === command.id),
  )
  return open.length > 0 && room.enabled().includes("env:signal-throws:b")
}

/**
 * The outage scenario's drop: `a`'s current PC reads disconnected after an
 * env:ice drop on a steady link, and `b`'s still reads connected.
 */
function aIceDisconnected(room: Room): boolean {
  return room.internals("a").conns.get("b")?.pc.connectionState === "disconnected"
    && room.internals("b").conns.get("a")?.pc.connectionState === "connected"
}

/**
 * ML1's (L1, the outage scenario): `a`'s current PC reads failed after an
 * env:ice drop on a steady link, and `b`'s still reads connected.
 */
function aIceFailed(room: Room): boolean {
  return room.internals("a").conns.get("b")?.pc.connectionState === "failed"
    && room.internals("b").conns.get("a")?.pc.connectionState === "connected"
}

export const PRECONDITIONS: Record<string, (room: Room) => boolean> = {
  none: () => true,
  twoOffersDeliverable,
  bSendAnswerOpen,
  aIceDisconnected,
  aIceFailed,
}
