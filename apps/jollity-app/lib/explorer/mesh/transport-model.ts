// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { RtcPayload } from "@jollity/statement-core"
import type { Side } from "../core/labels"

export interface WireFrame {
  id: string
  from: Side
  to: Side
  sid: string
  gen?: string
  payload: RtcPayload
  kind: "offer" | "answer" | "cand" | "hello"
}

export interface TransportModel {
  publish(from: Side, to: Side, payload: RtcPayload): WireFrame
  /**
   * Whether this frame is currently the store slot's value. Call immediately
   * after publish() to distinguish a stale answer that was skipped.
   */
  stored(frameId: string): boolean
  hello(from: Side, sid: string): void
  /** `receiver` has taken a hello of `peer`'s current session (the heartbeat's hello then reaches it) */
  heard(receiver: Side, peer: Side): boolean
  /**
   * The heartbeat's re-announce (statementTransport.ts heartbeat): the last
   * description `from` stored for `to` goes back into its slot, same gen and
   * SDP under a new frame id, when the slot no longer holds it (it was
   * dropped). Null when there is nothing to re-announce. The record is
   * cleared when `from` starts a new session and when `from` takes a hello
   * of `to`'s new session (resetNegotiation).
   */
  reannounce(from: Side, to: Side): WireFrame | null
  /** the heartbeat's hello while the peer has not heard it: back into the
   *  presence slot if it is gone from there (dropped), else null */
  rehello(from: Side): WireFrame | null
  /** `from`'s current session's hello is gone from the presence slot (dropped) */
  helloLost(from: Side): boolean
  deliverable(): WireFrame[]
  /** deliverable().length, without building the list (the drain reads it every turn) */
  deliverableCount(): number
  capture(frameId: string): void
  inFlight(to: Side): WireFrame[]
  /** inFlight(to).length, without building the list */
  inFlightCount(to: Side): number
  take(frameId: string, dup?: boolean): { frame: WireFrame; newSession: boolean }
  drop(frameId: string): void
  fingerprintState(): unknown
}

const other = (side: Side): Side => (side === "a" ? "b" : "a")
const pairKey = (receiver: Side, peer: Side) => `${receiver}>${peer}`
const sessionKey = (receiver: Side, peer: Side, sid: string) => `${pairKey(receiver, peer)}:${sid}`
const slotKey = (frame: Pick<WireFrame, "from" | "to" | "kind">) =>
  frame.kind === "hello" ? `p:${frame.from}` : `${frame.from}>${frame.to}:${frame.kind === "cand" ? "c" : "d"}`

const SID_RE = /^(\d+)-([0-9a-z]+)$/

function compareSid(left: string, right: string): number {
  const leftMatch = SID_RE.exec(left)
  const rightMatch = SID_RE.exec(right)
  if (leftMatch && rightMatch) {
    const leftTime = Number(leftMatch[1])
    const rightTime = Number(rightMatch[1])
    if (leftTime !== rightTime) return leftTime - rightTime
    return leftMatch[2]!.localeCompare(rightMatch[2]!)
  }
  return left.localeCompare(right)
}

function counterOf(frame: Pick<WireFrame, "sid" | "gen">): number | null {
  const prefix = `${frame.sid}.`
  if (!frame.gen?.startsWith(prefix)) return null
  const value = frame.gen.slice(prefix.length)
  if (!/^\d+$/.test(value)) return null
  const counter = Number(value)
  return Number.isSafeInteger(counter) ? counter : null
}

function descriptionKey(frame: WireFrame): string | null {
  const desc = frame.payload.rtc.desc
  return desc ? `${frame.gen ?? ""}|${desc.sdp ?? ""}` : null
}

function candidateKey(frame: WireFrame): string | null {
  const candidate = frame.payload.rtc.cand
  return candidate ? `${candidate.usernameFragment ?? ""}|${candidate.candidate ?? ""}` : null
}

/**
 * Pure receive-policy model for statementTransport header rules 2, 4 and 5.
 * Every session and generation gate is evaluated at take/read time;
 * deliverable() is only a preview using those same gates.
 * This bounded model has no clock or SESSION_SILENT_MS fail-open, so a sid
 * heard through hello remains live and older or retired hellos stay refused.
 * Stored slots and already-read frames are deliberately separate: replacing a
 * slot cannot retract a copy that the receiver has captured for delivery.
 */
export function createTransportModel(): TransportModel {
  let nextId = 0
  const senderSid = new Map<Side, string>()
  const offerCounter = new Map<Side, number>()
  const store = new Map<string, WireFrame>()
  const captured = new Set<string>()
  const flight: WireFrame[] = []

  const currentSid = new Map<string, string>()
  const heardSid = new Set<string>()
  const retiredSid = new Set<string>()
  const outgoingGen = new Map<string, string>()
  const adoptedGen = new Map<string, string>()
  const lastOffer = new Map<string, number>()
  const seenDesc = new Map<string, string>()
  const seenCands = new Map<string, Set<string>>()
  /** sender>receiver: the last description the sender stored for the receiver (the transport's `out` descSent) */
  const announced = new Map<string, WireFrame>()

  const mint = (
    from: Side,
    to: Side,
    sid: string,
    kind: WireFrame["kind"],
    payload: RtcPayload,
    gen?: string,
  ): WireFrame => ({ id: `wire-${++nextId}`, from, to, sid, gen, payload, kind })

  const storeNewest = (frame: WireFrame) => {
    const key = slotKey(frame)
    // Reinsert so Map iteration remains publication order, including a slot replacement.
    store.delete(key)
    store.set(key, frame)
  }

  const admissible = (frame: WireFrame): boolean => {
    const pair = pairKey(frame.to, frame.from)
    if (retiredSid.has(sessionKey(frame.to, frame.from, frame.sid))) return false

    const current = currentSid.get(pair)
    if (frame.kind === "hello") {
      if (current === undefined) return true
      if (current === frame.sid) return !heardSid.has(pair)
      if (!heardSid.has(pair)) return true
      return compareSid(frame.sid, current) > 0
    }
    if (current !== undefined && current !== frame.sid) return false

    if (frame.kind === "offer") {
      const counter = counterOf(frame)
      const last = lastOffer.get(sessionKey(frame.to, frame.from, frame.sid)) ?? 0
      if (counter !== null && counter < last) return false
      if (counter === last && adoptedGen.get(pair) !== frame.gen) return false
    } else {
      const expected = frame.kind === "answer" ? outgoingGen.get(pair) : adoptedGen.get(pair)
      if (frame.gen === undefined || frame.gen !== expected) return false
    }

    const candidate = candidateKey(frame)
    if (candidate !== null && seenCands.get(pair)?.has(candidate)) return false
    const desc = descriptionKey(frame)
    return desc === null || seenDesc.get(pair) !== desc
  }

  const model: TransportModel = {
    publish(from, to, payload) {
      const sid = senderSid.get(from)
      if (!sid) throw new Error(`side ${from} has no session; call hello first`)

      const desc = payload.rtc.desc
      let kind: WireFrame["kind"]
      let gen = payload.rtc.gen
      let skip = false
      if (desc?.type === "offer") {
        kind = "offer"
        const counter = (offerCounter.get(from) ?? 0) + 1
        offerCounter.set(from, counter)
        gen = `${sid}.${counter}`
        const pair = pairKey(from, to)
        outgoingGen.set(pair, gen)
        adoptedGen.set(pair, gen)
        seenDesc.delete(pair)
        seenCands.delete(pair)
      } else if (desc?.type === "answer") {
        kind = "answer"
        const pair = pairKey(from, to)
        const peerSid = currentSid.get(pair)
        const counter = gen && peerSid ? counterOf({ sid: peerSid, gen }) : null
        const last = peerSid ? (lastOffer.get(sessionKey(from, to, peerSid)) ?? 0) : 0
        skip = counter !== null && counter < last
        if (gen && !skip) outgoingGen.set(pair, gen)
      } else if (payload.rtc.cand) {
        kind = "cand"
      } else {
        throw new Error("an RTC frame must contain an offer, answer or candidate")
      }

      const framePayload: RtcPayload = { rtc: { ...payload.rtc, ...(gen ? { gen } : {}) } }
      const frame = mint(from, to, sid, kind, framePayload, gen)
      if (!skip) {
        storeNewest(frame)
        if (kind !== "cand") announced.set(pairKey(from, to), frame)
      }
      return frame
    },

    stored(frameId) {
      return [...store.values()].some((frame) => frame.id === frameId)
    },

    hello(from, sid) {
      const previousLocalSid = senderSid.get(from)
      if (previousLocalSid !== sid) {
        senderSid.set(from, sid)
        offerCounter.set(from, 0)
      }
      if (previousLocalSid !== undefined && previousLocalSid !== sid) {
        const receivePair = pairKey(from, other(from))
        // a new session has a new transport: nothing of the old one's to re-announce
        announced.delete(receivePair)
        currentSid.delete(receivePair)
        heardSid.delete(receivePair)
        outgoingGen.delete(receivePair)
        adoptedGen.delete(receivePair)
        seenDesc.delete(receivePair)
        seenCands.delete(receivePair)
        for (const key of [...retiredSid]) {
          if (key.startsWith(`${receivePair}:`)) retiredSid.delete(key)
        }
        for (const key of [...lastOffer.keys()]) {
          if (key.startsWith(`${receivePair}:`)) lastOffer.delete(key)
        }
        for (let index = flight.length - 1; index >= 0; index -= 1) {
          const frame = flight[index]
          if (frame?.to === from) {
            captured.delete(frame.id)
            flight.splice(index, 1)
          }
        }
      }
      storeNewest(mint(from, other(from), sid, "hello", { rtc: {} }))
    },

    heard(receiver, peer) {
      const pair = pairKey(receiver, peer)
      const sid = senderSid.get(peer)
      return sid !== undefined && currentSid.get(pair) === sid && heardSid.has(pair)
    },

    helloLost(from) {
      const sid = senderSid.get(from)
      return sid !== undefined && store.get(`p:${from}`)?.sid !== sid
    },

    rehello(from) {
      const sid = senderSid.get(from)
      if (!sid) return null
      const held = store.get(`p:${from}`)
      if (held?.sid === sid) return null
      const frame = mint(from, other(from), sid, "hello", { rtc: {} })
      storeNewest(frame)
      return frame
    },

    reannounce(from, to) {
      const last = announced.get(pairKey(from, to))
      if (!last) return null
      const held = store.get(slotKey(last))
      if (held && descriptionKey(held) === descriptionKey(last)) return null
      const frame = mint(from, to, last.sid, last.kind, last.payload, last.gen)
      storeNewest(frame)
      announced.set(pairKey(from, to), frame)
      return frame
    },

    deliverable() {
      const inFlightIds = new Set(flight.map((frame) => frame.id))
      return [
        ...flight.filter(admissible),
        ...[...store.values()].filter((frame) => !inFlightIds.has(frame.id) && admissible(frame)),
      ]
    },

    deliverableCount() {
      let count = 0
      for (const frame of flight) if (admissible(frame)) count++
      for (const frame of store.values()) {
        if (!flight.some((held) => held.id === frame.id) && admissible(frame)) count++
      }
      return count
    },

    capture(frameId) {
      const frame = [...store.values()].find((candidate) => candidate.id === frameId)
      if (!frame || !admissible(frame)) throw new Error(`frame ${frameId} is not captureable`)
      if (captured.has(frameId)) return
      captured.add(frameId)
      flight.push(frame)
    },

    inFlight(to) {
      return flight.filter((frame) => frame.to === to)
    },

    inFlightCount(to) {
      let count = 0
      for (const frame of flight) if (frame.to === to) count++
      return count
    },

    take(frameId) {
      const flightIndex = flight.findIndex((candidate) => candidate.id === frameId)
      let frame: WireFrame | undefined
      if (flightIndex >= 0) {
        frame = flight[flightIndex]
        if (frame && admissible(frame)) {
          flight.splice(flightIndex, 1)
          captured.delete(frame.id)
        }
      } else {
        const entry = [...store.entries()].find(([, candidate]) => candidate.id === frameId)
        if (entry) frame = entry[1]
      }
      if (!frame || !admissible(frame)) throw new Error(`frame ${frameId} is not deliverable`)

      const pair = pairKey(frame.to, frame.from)
      let newSession = false
      if (frame.kind === "hello") {
        const previous = currentSid.get(pair)
        if (previous !== frame.sid) {
          if (previous !== undefined) {
            retiredSid.add(sessionKey(frame.to, frame.from, previous))
            newSession = true
            // resetNegotiation: our description to its old session is dead
            announced.delete(pair)
          }
          currentSid.set(pair, frame.sid)
          outgoingGen.delete(pair)
          adoptedGen.delete(pair)
          seenDesc.delete(pair)
          seenCands.delete(pair)
        }
        heardSid.add(pair)
      } else if ((frame.kind === "offer" || frame.kind === "answer") && frame.gen) {
        if (!currentSid.has(pair)) currentSid.set(pair, frame.sid)
        if (adoptedGen.get(pair) !== frame.gen) seenCands.delete(pair)
        adoptedGen.set(pair, frame.gen)
        const desc = descriptionKey(frame)
        if (desc !== null) seenDesc.set(pair, desc)
        if (frame.kind === "offer") {
          const counter = counterOf(frame)
          if (counter !== null) {
            const key = sessionKey(frame.to, frame.from, frame.sid)
            lastOffer.set(key, Math.max(lastOffer.get(key) ?? 0, counter))
          }
        }
      } else if (frame.kind === "cand") {
        if (!currentSid.has(pair)) currentSid.set(pair, frame.sid)
        const candidate = candidateKey(frame)
        if (candidate !== null) {
          let seen = seenCands.get(pair)
          if (!seen) seenCands.set(pair, (seen = new Set()))
          seen.add(candidate)
        }
      }

      return { frame, newSession }
    },

    drop(frameId) {
      const entry = [...store.entries()].find(([, candidate]) => candidate.id === frameId)
      if (entry) {
        store.delete(entry[0])
        return
      }
      const index = flight.findIndex((candidate) => candidate.id === frameId)
      if (index >= 0) flight.splice(index, 1)
    },

    fingerprintState() {
      return {
        senderSid,
        offerCounter,
        store,
        captured,
        flight: [...flight],
        currentSid,
        heardSid,
        retiredSid,
        outgoingGen,
        adoptedGen,
        lastOffer,
        seenDesc,
        seenCands,
        // only once a description is stored, so a room without one keeps its fingerprints
        ...(announced.size > 0 ? { announced } : {}),
      }
    },
  }

  return model
}
