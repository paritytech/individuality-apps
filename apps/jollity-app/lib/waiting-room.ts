// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE WAITING ROOM, AS THE PLAYER READS IT: one screen on two routes. The home
 * shows it from T-300 to the handover, and /game shows it from the handover
 * to the tiles move-in at T-2. It holds the clock, the connection footer (a
 * headline and its line, a dot per co-player of each round, and the
 * indicators), and the How to play steps.
 *
 * The clock rule: each route gives the screen a kickoff and a clock in ONE
 * time frame (`WaitingClock`). Only the time left counts, so the handover
 * shows no jump. This module reads no clock: every time is an argument.
 */
import { DIAL_ENDS_BEFORE, DIAL_WINDOW, TILES_ENTER_SECONDS } from "@jollity/game-chain/game"
import type { NetworkIcon, QualityBars } from "./connection-status"
import { formatCountdown } from "./format"
import type { LinkSummary } from "./webrtc/useMesh"

/**
 * A co-player's connection dot (#1350):
 *
 *  - direct       green: linked directly
 *  - turn         amber: linked through a TURN relay
 *  - connecting   a hollow amber ring: their endpoint is on the statement
 *                 store but the link is not up, so their tile shows static,
 *                 not a face
 *  - no-endpoint  a grey ×: no endpoint from them on the store
 */
export type PeerDot = "direct" | "turn" | "connecting" | "no-endpoint"

export interface WaitingPeer {
  /** a PlayerId (an SS58 account) */
  id: string
  /** their round, 0 for the round still to play first */
  round: number
  dot: PeerDot
}

/** One co-player's dot from their link. No link at all is no endpoint. */
export function peerDot(link: LinkSummary | undefined): PeerDot {
  if (link?.conn === "connected") return link.path === "relay" ? "turn" : "direct"
  return link?.endpoint ? "connecting" : "no-endpoint"
}

/** The co-players of the round still to play first, then of the later rounds,
 *  each round with its whole group. A co-player met in two rounds is in both,
 *  with the one dot of their one link. */
export function waitingPeers(input: {
  rounds: readonly (readonly string[])[]
  links: readonly LinkSummary[]
}): WaitingPeer[] {
  const byId = new Map(input.links.map((link) => [link.id, link]))
  return input.rounds.flatMap((ids, round) => ids.map((id) => ({ id, round, dot: peerDot(byId.get(id)) })))
}

const DOT_RANK: Record<PeerDot, number> = { direct: 0, turn: 0, connecting: 1, "no-endpoint": 2 }

/**
 * Who came through, in order: a co-player takes the next number the first
 * time their dot is green or amber, and loses it if the link drops back. One
 * number per person, whichever rounds they are in. The same map when nothing
 * changed.
 */
export function trackArrivals(prev: ReadonlyMap<string, number>, peers: readonly WaitingPeer[]): ReadonlyMap<string, number> {
  const through = [...new Set(peers.filter((peer) => DOT_RANK[peer.dot] === 0).map((peer) => peer.id))]
  const kept = [...prev].filter(([id]) => through.includes(id))
  const added = through.filter((id) => !prev.has(id))
  if (added.length === 0 && kept.length === prev.size) return prev
  let next = Math.max(0, ...prev.values())
  return new Map([...kept, ...added.map((id): [string, number] => [id, ++next])])
}

/**
 * The dot row of the connection footer, one array, one group per
 * round, the round still to play first. Inside a round: the linked first, in
 * the order they came through, then the rings, then the ×s, each in seat
 * order otherwise. A co-player met in two rounds is drawn in both. `breaks`:
 * the indices a round separator goes before, one after each round's group but
 * the last.
 */
export function dotRow(peers: readonly WaitingPeer[], arrivals: ReadonlyMap<string, number>): { dots: WaitingPeer[]; breaks: number[] } {
  const arrived = (peer: WaitingPeer) => arrivals.get(peer.id) ?? Number.POSITIVE_INFINITY
  const rounds = [...new Set(peers.map((peer) => peer.round))].sort((a, b) => a - b)
  const groups = rounds.map((round) =>
    peers
      .filter((peer) => peer.round === round)
      .map((peer, seat) => ({ peer, seat }))
      .sort(
        (a, b) =>
          DOT_RANK[a.peer.dot] - DOT_RANK[b.peer.dot] ||
          (DOT_RANK[a.peer.dot] === 0 ? arrived(a.peer) - arrived(b.peer) || 0 : 0) ||
          a.seat - b.seat,
      )
      .map(({ peer }) => peer),
  )
  const breaks = groups.slice(0, -1).map((_, index) => groups.slice(0, index + 1).reduce((sum, group) => sum + group.length, 0))
  return { dots: groups.flat(), breaks }
}

export interface WaitingClock {
  /** kickoff, unix seconds, in the frame of nowMs */
  kickoffAt: number
  /** the clock of the route, ms */
  nowMs: () => number
}

export type ClockFace =
  /** "M:SS" to the dial's 00, while more than one dial turn is left */
  | { kind: "digits"; text: string }
  /** seconds to the tiles move-in, fractional: the dial turns, then shows 00 for one second */
  | { kind: "dial"; left: number }
  /** the 00 second is over: the tiles move in */
  | { kind: "ended" }

/** The digits and the dial count to the dial's 00, DIAL_ENDS_BEFORE ahead of kickoff. */
export function clockFace(clock: WaitingClock, nowMs: number): ClockFace {
  const now = nowMs / 1000
  const left = clock.kickoffAt - DIAL_ENDS_BEFORE - now
  if (left > DIAL_WINDOW) return { kind: "digits", text: formatCountdown(Math.ceil(left), 0) }
  const toTiles = clock.kickoffAt - TILES_ENTER_SECONDS - now
  if (toTiles > 0) return { kind: "dial", left: toTiles }
  return { kind: "ended" }
}

/** the statement store the links are signalled over */
export type ChainIcon = "ok" | "connecting" | "failing"

/** the store's own counters, as much as the Chain indicator reads */
export interface StoreHealth {
  storeLive: boolean
  subActive: boolean
  lastError: string
}

/** The connection footer's words and indicators, for each of its states. */
export interface WaitingFooter {
  /** the headline */
  text: string
  /** the line under it; null = none */
  detail: string | null
  /** the tooltip text; null = no info icon */
  info: string | null
  /** the test id the headline carries */
  testId?: "chain-restart" | "waiting-network-blocked"
  /** data-restart-advice, with testId "chain-restart" */
  restartAdvice?: "reconnecting" | "escalated" | "restart"
  network: NetworkIcon
  /** null: no reading yet */
  quality: QualityBars | null
  chain: ChainIcon
}

const CHECKING = { text: "Checking your network…", detail: "Finding the fastest way to reach your players" }
const GROUPS = { text: "Waiting for the groups", detail: null }

/**
 * The footer's headline, its line and the indicators. The first match wins
 * for the words: the restart advice, you can't reach anyone, then the room.
 * Quality reads only once you are through; Chain greys out when you can't
 * reach anyone, as the design draws it.
 */
export function waitingFooter(input: {
  restart: { heading: string; body: string; advice: "reconnecting" | "escalated" | "restart" } | null
  /** this phone cannot reach the others */
  unreachable: boolean
  room:
    | { route: "home"; check: "running" | "pass" | "blocked" | "other" }
    | {
        route: "game"
        network: NetworkIcon
        connected: number
        expected: number
        quality: QualityBars | null
        checking: boolean
        store: StoreHealth | undefined
      }
}): WaitingFooter {
  const { restart, unreachable, room } = input
  const network: NetworkIcon = unreachable
    ? "blocked"
    : room.route === "game"
      ? room.network
      : room.check === "pass"
        ? "direct"
        : room.check === "blocked"
          ? "blocked"
          : "checking"
  const through = network !== "checking" && network !== "blocked"
  const store = room.route === "game" ? room.store : undefined
  const chain: ChainIcon = restart
    ? "failing"
    : network === "blocked"
      ? "connecting"
      : room.route === "home"
        ? "ok"
        : !store
          ? "connecting"
          : store.storeLive && store.subActive
            ? "ok"
            : store.lastError
              ? "failing"
              : "connecting"
  const indicators = { network, quality: through && room.route === "game" ? room.quality : null, chain }

  if (restart) {
    return { text: restart.heading, detail: null, info: restart.body, testId: "chain-restart", restartAdvice: restart.advice, ...indicators }
  }
  if (network === "blocked") {
    return { text: "You can’t reach the other players", detail: "Switch to mobile data to join", info: null, testId: "waiting-network-blocked", ...indicators }
  }
  if (room.route === "home") return { ...(room.check === "running" ? CHECKING : GROUPS), info: null, ...indicators }
  if (room.expected === 0) return { ...GROUPS, info: null, ...indicators }
  if (room.connected === 0 && (room.checking || room.network === "checking")) return { ...CHECKING, info: null, ...indicators }
  if (room.connected >= room.expected) return { text: "You’re connected to everyone", detail: null, info: null, ...indicators }
  return {
    text: `Connected to ${room.connected} of ${room.expected}`,
    detail: room.network === "relay" ? "On a relay: this network blocks direct connection" : "Connecting to the others…",
    info: null,
    ...indicators,
  }
}

/** -1 = the clock page */
export type HowToPlayStep = -1 | 0 | 1

let howTo: { gameAt: number; step: HowToPlayStep } | null = null
const howToListeners = new Set<() => void>()

/** The open How to play step, keyed by the kickoff in the chain frame. A module
 *  store, so the step lives across the navigation from the home to /game. */
export const howToPlay = {
  get(gameAt: number): HowToPlayStep {
    return howTo?.gameAt === gameAt ? howTo.step : -1
  },
  set(gameAt: number, step: HowToPlayStep): void {
    if (howTo?.gameAt === gameAt && howTo.step === step) return
    howTo = { gameAt, step }
    for (const listener of howToListeners) listener()
  },
  subscribe(listener: () => void): () => void {
    howToListeners.add(listener)
    return () => {
      howToListeners.delete(listener)
    }
  },
}

/** the shortest horizontal move, px, that turns the page */
export const SWIPE_MIN_PX = 48

/** The page after a swipe of (dx, dy) px: a left swipe opens the next page, a
 *  right swipe the one before. A short or mostly vertical move keeps the page. */
export function swipeStep(step: HowToPlayStep, dx: number, dy: number): HowToPlayStep {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return step
  return dx < 0 ? (Math.min(step + 1, 1) as HowToPlayStep) : (Math.max(step - 1, -1) as HowToPlayStep)
}
