// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The explorer's step vocabulary: the types, and the label grammar
 * (parse/format, schema 1).
 */
export type Side = "a" | "b"
export type Label = string

export const LABEL_SCHEMA = 1

type PcOperation = "srd" | "sld" | "cand" | "rollback"
type PcRejection =
  | "InvalidAccessError"
  | "InvalidStateError"
  | "OperationError"

export type ParsedLabel =
  | {
      kind: "pc-operation"
      side: Side
      pc: number
      operation: PcOperation
      outcome: "resolve"
    }
  | {
      kind: "pc-operation"
      side: Side
      pc: number
      operation: PcOperation
      outcome: "reject"
      error: PcRejection
    }
  | { kind: "pc-gather"; side: Side; pc: number }
  | { kind: "pc-negotiationneeded"; side: Side; pc: number }
  | { kind: "pc-stats"; side: Side; pc: number }
  | { kind: "pc-ice-timeout"; side: Side; pc: number }
  | {
      kind: "wire"
      from: Side
      to: Side
      frameId: string
      action: "deliver" | "drop" | "dup" | "capture"
    }
  | { kind: "lane"; from: Side; to: Side; action: "deliver" }
  | { kind: "clock-next" }
  | {
      kind: "environment"
      action: "reload" | "signal-throws" | "rebuild" | "lane-close"
      side: Side
    }
  | {
      kind: "environment-ice"
      side: Side
      state: "disconnected" | "failed"
    }
  /** a network change on one phone (room.ts: Mesh.networkChanged, as
   *  useMesh's repair runs it): a fault */
  | { kind: "environment-network"; side: Side }
  | { kind: "environment-round" }
  /** the statement transport's heartbeat on one side (room.ts beat): normal
   *  traffic, never a fault */
  | { kind: "heartbeat"; side: Side }

const side = (value: string): Side => value as Side
const pc = (value: string): number => Number.parseInt(value, 10)

export function parseLabel(label: Label): ParsedLabel {
  let match =
    /^pc:([ab])\/(\d+):(srd|sld|cand|rollback):(resolve)$/.exec(label)
  if (match) {
    return {
      kind: "pc-operation",
      side: side(match[1]),
      pc: pc(match[2]),
      operation: match[3] as PcOperation,
      outcome: "resolve",
    }
  }

  match =
    /^pc:([ab])\/(\d+):(srd|sld|cand|rollback):reject:(InvalidAccessError|InvalidStateError|OperationError)$/.exec(
      label,
    )
  if (match) {
    return {
      kind: "pc-operation",
      side: side(match[1]),
      pc: pc(match[2]),
      operation: match[3] as PcOperation,
      outcome: "reject",
      error: match[4] as PcRejection,
    }
  }

  match = /^pc:([ab])\/(\d+):(gather|negotiationneeded|stats|ice-timeout-failed)$/.exec(label)
  if (match) {
    const common = { side: side(match[1]), pc: pc(match[2]) }
    if (match[3] === "gather") return { kind: "pc-gather", ...common }
    if (match[3] === "stats") return { kind: "pc-stats", ...common }
    if (match[3] === "ice-timeout-failed") return { kind: "pc-ice-timeout", ...common }
    return { kind: "pc-negotiationneeded", ...common }
  }

  match =
    /^wire:([ab])>([ab]):([^:]+):(deliver|drop|dup|capture)$/.exec(label)
  if (match) {
    return {
      kind: "wire",
      from: side(match[1]),
      to: side(match[2]),
      frameId: match[3],
      action: match[4] as "deliver" | "drop" | "dup" | "capture",
    }
  }

  match = /^lane:([ab])>([ab]):deliver$/.exec(label)
  if (match) {
    return {
      kind: "lane",
      from: side(match[1]),
      to: side(match[2]),
      action: "deliver",
    }
  }

  if (label === "clock:next") return { kind: "clock-next" }
  match = /^hb:([ab])$/.exec(label)
  if (match) return { kind: "heartbeat", side: side(match[1]) }
  if (label === "env:round") return { kind: "environment-round" }

  match = /^env:(reload|signal-throws|rebuild|lane-close):([ab])$/.exec(label)
  if (match) {
    return {
      kind: "environment",
      action: match[1] as
        | "reload"
        | "signal-throws"
        | "rebuild"
        | "lane-close",
      side: side(match[2]),
    }
  }

  match = /^env:ice:([ab]):(disconnected|failed)$/.exec(label)
  if (match) {
    return {
      kind: "environment-ice",
      side: side(match[1]),
      state: match[2] as "disconnected" | "failed",
    }
  }

  match = /^env:network:([ab])$/.exec(label)
  if (match) return { kind: "environment-network", side: side(match[1]) }

  throw new Error(`unknown explorer label: ${label}`)
}

export function isFault(label: Label): boolean {
  let parsed: ParsedLabel
  try {
    parsed = parseLabel(label)
  } catch {
    return false
  }

  return (
    (parsed.kind === "pc-operation" && parsed.outcome === "reject") ||
    (parsed.kind === "wire" &&
      (parsed.action === "drop" || parsed.action === "dup")) ||
    (parsed.kind === "environment" &&
      (parsed.action === "reload" ||
        parsed.action === "signal-throws" ||
        parsed.action === "rebuild" ||
        parsed.action === "lane-close")) ||
    parsed.kind === "environment-ice" ||
    parsed.kind === "environment-network"
  )
}

export interface StepRecord {
  index: number
  label: Label
  /** WireFrames published during this step */
  frames: unknown[]
  /** executePeerCommand calls during this step */
  commands: unknown[]
  /** effect outcomes recorded during this step */
  outcomes: unknown[]
  /** runner onAccepted / onIgnored, for P6 and P7 */
  accepted: unknown[]
  /** fake clock after the step */
  clockMs: number
  /** real turns the drain needed */
  turns: number
}
