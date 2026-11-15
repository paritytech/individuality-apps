// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE PAGE'S STORE CLOCK (docs/time-and-clocks.md, Rule 2): the clock every
 * statement's expiry is stamped from. The policy, types, and limits come from
 * statement-core (chain-agnostic, its header has the node's rule); this module
 * expresses it as a pure reducer behind the app's clock/telemetry adapter.
 *
 *  - BASE: the game clock (lib/chain-clock.ts `chainNowMs`), which no wall step
 *    moves. Phone and node clocks are synced, so the margin stays 0. Before
 *    the game source registers it, the step-free device clock stands in; a
 *    margin learned against it is dropped when the game clock arrives.
 *  - A time rejection (`alreadyExpired`) is the safety net: one re-stamp with
 *    the margin pushed ahead, the smallest accepted margin kept.
 *  - ONE CLOCK FOR THE PAGE, so the margin the waiting room calibrated
 *    (lib/store-calibration.ts) is the one the game's signalling stamps with.
 *  - IT OUTLIVES A RELOAD. A page reloaded mid-game starts with an expiry
 *    floor of 0 while its old statements still hold its channels with higher
 *    expiries, so the node refuses the new ones (`channelPriorityTooLow`)
 *    for up to margin + TTL. Every MINTED stamp saves the floor (so a
 *    statement still in flight at the reload, say the goodbye statement, is
 *    covered), and every accepted one the margins, to sessionStorage (it
 *    survives a host reload: lib/self-reload.ts keeps its reload budget there
 *    too), and the next page's clock starts from them. One key for the page, not one per room: the floor is the
 *    page's, and a higher floor than a room needs only lengthens a life.
 *    (Rule 4: a saved stamp, but it only ever RAISES a floor.)
 *
 * It does not stamp from the latest of the wall, device and game clocks: a
 * phone set ahead would stamp every expiry ahead, with no retry to recover.
 */
import {
  MAX_RETRY_MARGIN_MS,
  MIN_RETRY_MARGIN_MS,
  onSlotExpiryFloor,
  raiseSlotExpiryFloor,
  slotExpiryFloor,
  TTL_S,
  type StoreClock,
  type StoreClockBase,
  type StoreClockEvent,
  type StoreStamp,
} from "@jollity/statement-core"
import { chainNowMs } from "./chain-clock"
import { deviceNowMs } from "./device-clock"
import { storeClockEvent } from "./journeys/game-trace"

/** the game clock, or the step-free device clock before the game source
 *  registers it (kind "chain" is the historical name for the game clock) */
export function storeClockBase(): StoreClockBase {
  const chain = chainNowMs()
  return chain === null ? { ms: deviceNowMs(), kind: "device" } : { ms: chain, kind: "chain" }
}

const SAVED_KEY = "jollity.storeClock"

interface Saved {
  /** the expiry floor, a packed u64 as decimal text */
  floor: string
  margins: Record<string, number>
}

interface MessageExpiryKindState {
  marginMs: number
  failedPushMs: number
}

/** Pure state behind the page's statement-expiry clock. */
export interface MessageExpiryClockState {
  kinds: Record<string, MessageExpiryKindState>
  rejectedReported: boolean
}

export type MessageExpiryClockInput =
  | { type: "stamp"; base: StoreClockBase }
  | { type: "retry"; base: StoreClockBase; first: StoreStamp; ttlS: number }
  | { type: "accepted"; stamp: StoreStamp }
  | { type: "rejected"; stamp: StoreStamp; reason: string }
  | { type: "margin"; base: StoreClockBase }

export type MessageExpiryClockCommand =
  | { type: "stamp"; stamp: StoreStamp }
  | { type: "margin"; marginMs: number }
  | { type: "event"; event: StoreClockEvent }

export function createMessageExpiryClock(initial: Record<string, number> = {}): MessageExpiryClockState {
  return {
    kinds: Object.fromEntries(
      Object.entries(initial).flatMap(([kind, marginMs]) =>
        Number.isFinite(marginMs) && marginMs >= 0
          ? [[kind, { marginMs: Math.min(marginMs, MAX_RETRY_MARGIN_MS), failedPushMs: 0 }]]
          : [],
      ),
    ),
    rejectedReported: false,
  }
}

/** Rule 2 as a pure reducer: base time is carried by each event and telemetry
 * leaves as a command. */
export function messageExpiryClockStep(
  state: MessageExpiryClockState,
  event: MessageExpiryClockInput,
): { state: MessageExpiryClockState; commands: MessageExpiryClockCommand[] } {
  const next: MessageExpiryClockState = {
    kinds: Object.fromEntries(
      Object.entries(state.kinds).map(([kind, value]) => [kind, { ...value }]),
    ),
    rejectedReported: state.rejectedReported,
  }
  const of = (kind: string): MessageExpiryKindState =>
    (next.kinds[kind] ??= { marginMs: 0, failedPushMs: 0 })

  switch (event.type) {
    case "stamp": {
      const { marginMs } = of(event.base.kind)
      return {
        state: next,
        commands: [{
          type: "stamp",
          stamp: {
            ms: event.base.ms + marginMs,
            base: event.base.ms,
            kind: event.base.kind,
            from: marginMs,
            retry: false,
            learn: false,
          },
        }],
      }
    }
    case "retry": {
      const current = of(event.base.kind)
      const stale = event.base.kind === event.first.kind
        && event.base.ms - event.first.base > (event.ttlS * 1_000) / 2
      const pushMs = stale
        ? current.marginMs
        : Math.min(
            MAX_RETRY_MARGIN_MS,
            Math.max(MIN_RETRY_MARGIN_MS, 2 * event.first.from, 2 * current.failedPushMs),
          )
      return {
        state: next,
        commands: [{
          type: "stamp",
          stamp: {
            ms: event.base.ms + pushMs,
            base: event.base.ms,
            kind: event.base.kind,
            from: event.first.from,
            retry: true,
            learn: !stale,
          },
        }],
      }
    }
    case "accepted": {
      if (!event.stamp.learn) return { state: next, commands: [] }
      const current = of(event.stamp.kind)
      const learned = event.stamp.ms - event.stamp.base
      const marginMs = current.marginMs <= event.stamp.from
        ? learned
        : Math.min(current.marginMs, learned)
      if (marginMs === current.marginMs) return { state: next, commands: [] }
      const previousMs = current.marginMs
      current.marginMs = marginMs
      current.failedPushMs = 0
      next.rejectedReported = false
      return {
        state: next,
        commands: [{
          type: "event",
          event: { kind: "learned", marginMs, previousMs, base: event.stamp.kind },
        }],
      }
    }
    case "rejected": {
      const current = of(event.stamp.kind)
      const pushMs = event.stamp.ms - event.stamp.base
      if (event.stamp.learn) current.failedPushMs = Math.max(current.failedPushMs, pushMs)
      if (next.rejectedReported) return { state: next, commands: [] }
      next.rejectedReported = true
      return {
        state: next,
        commands: [{
          type: "event",
          event: {
            kind: "rejected",
            reason: event.reason,
            marginMs: current.marginMs,
            pushMs,
            base: event.stamp.kind,
          },
        }],
      }
    }
    case "margin":
      return { state: next, commands: [{ type: "margin", marginMs: of(event.base.kind).marginMs }] }
  }
}

function restore(): Saved["margins"] | undefined {
  try {
    const raw = sessionStorage.getItem(SAVED_KEY)
    if (!raw) return undefined
    const saved = JSON.parse(raw) as Saved
    if (/^\d+$/.test(saved.floor)) raiseSlotExpiryFloor(BigInt(saved.floor))
    return saved.margins && typeof saved.margins === "object" ? saved.margins : undefined
  } catch {
    return undefined // no sessionStorage in this host, or not ours to read
  }
}

function save(clock: StoreClock): void {
  try {
    const saved: Saved = { floor: slotExpiryFloor().toString(), margins: clock.margins() }
    sessionStorage.setItem(SAVED_KEY, JSON.stringify(saved))
  } catch {
    /* no sessionStorage: a reload pays the priority re-stamp instead */
  }
}

function create(): StoreClock {
  let state = createMessageExpiryClock(restore())
  const apply = (input: MessageExpiryClockInput): MessageExpiryClockCommand[] => {
    const result = messageExpiryClockStep(state, input)
    state = result.state
    for (const command of result.commands) {
      if (command.type === "event") {
        try {
          storeClockEvent(command.event)
        } catch {
          /* telemetry never breaks signalling */
        }
      }
    }
    return result.commands
  }
  const value = <T extends MessageExpiryClockCommand["type"]>(
    commands: MessageExpiryClockCommand[],
    type: T,
  ): Extract<MessageExpiryClockCommand, { type: T }> => {
    const command = commands.find((candidate): candidate is Extract<MessageExpiryClockCommand, { type: T }> => candidate.type === type)
    if (!command) throw new Error(`message-expiry clock emitted no ${type}`)
    return command
  }
  const clock: StoreClock = {
    stamp: () => value(apply({ type: "stamp", base: storeClockBase() }), "stamp").stamp,
    retryStamp: (first, ttlS = TTL_S) =>
      value(apply({ type: "retry", base: storeClockBase(), first, ttlS }), "stamp").stamp,
    accepted: (stamp) => void apply({ type: "accepted", stamp }),
    rejected: (stamp, reason) => void apply({ type: "rejected", stamp, reason }),
    marginMs: () => value(apply({ type: "margin", base: storeClockBase() }), "margin").marginMs,
    margins: () => Object.fromEntries(Object.entries(state.kinds).map(([kind, value]) => [kind, value.marginMs])),
  }
  onSlotExpiryFloor(() => save(clock))
  return {
    ...clock,
    accepted(stamp) {
      clock.accepted(stamp)
      save(clock)
    },
  }
}

let shared: StoreClock | null = null

/** the page's store clock, created on first use */
export function storeClock(): StoreClock {
  shared ??= create()
  return shared
}

/** tests: a fresh clock, margin 0, and nothing saved; `{ reload: true }`
 *  keeps the saved state, as a reload does */
export function resetStoreClockForTests(options: { reload?: boolean } = {}): void {
  shared = null
  onSlotExpiryFloor(null)
  if (options.reload) return
  try {
    sessionStorage.removeItem(SAVED_KEY)
  } catch {
    /* none */
  }
}
