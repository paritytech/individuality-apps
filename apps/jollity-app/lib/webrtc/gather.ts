// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHAT A PEER CONNECTION GATHERED: the local ICE candidates by type and how
 * long the gathering took, and the errors the browser raised on the way
 * (`icecandidateerror`). Telling "no relay candidate" (the TURN server was
 * unreachable: error 701) from "no server reflexive one" (a NAT problem)
 * needs both. The Mesh keeps the tally per peer connection
 * (lib/webrtc/mesh.ts); lib/journeys/rtc-gather.ts turns it into telemetry.
 *
 * Pure. A browser that reports less than Chrome gets `unsupported`, never a
 * missing field: a candidate with no readable type counts as `other`, an error
 * with no code or url says `unsupported`. The error text is the server's words and is never read.
 *
 * AN ERROR NAMES ITS SERVER BY HOST ONLY. The url a browser reports can hold
 * the TURN username and password (`turn:user:pass@host`), so `urlHost` never
 * returns anything but the host.
 */
import { maskSafe } from "../journeys/mask-text"

export type CandidateType = "host" | "srflx" | "relay" | "other"
export type GatherCounts = Record<CandidateType, number>

/** an icecandidateerror, reduced to the two things worth keeping */
export interface IceErrorEvent {
  /** the errorCode as text (701 = the TURN server was unreachable) */
  code: string
  /** the server url's host, never the url */
  host: string
}

/** how many times one error (code and host) was raised in a gathering */
export interface IceErrorCount extends IceErrorEvent {
  n: number
}

/** what a gathering has so far: the candidates by type, the time once it
 *  completed, and its errors counted by code and host */
export interface GatherSnapshot {
  counts: GatherCounts
  ms?: number
  errors: IceErrorCount[]
}

/** a finished gathering: its snapshot, always with the time */
export interface GatherEvent extends GatherSnapshot {
  ms: number
}

export const UNSUPPORTED = "unsupported"

export function emptyCounts(): GatherCounts {
  return { host: 0, srflx: 0, relay: 0, other: 0 }
}

/** the candidate's type: the field where the browser has it, else the `typ`
 *  of its candidate line. Peer-reflexive and unreadable ones are `other`. */
export function candidateType(candidate: { type?: string | null; candidate?: string }): CandidateType {
  const type = candidate.type ?? /\btyp (\w+)/.exec(candidate.candidate ?? "")?.[1]
  return type === "host" || type === "srflx" || type === "relay" ? type : "other"
}

export function countCandidate(counts: GatherCounts, candidate: { type?: string | null; candidate?: string }): void {
  counts[candidateType(candidate)] += 1
}

/** `host/srflx/relay` as one short text: "2/1/0" is a pair whose TURN gave nothing */
export function gatheredAttr(counts: GatherCounts): string {
  return `${counts.host}/${counts.srflx}/${counts.relay}`
}

const SERVER_URL = /^(?:stuns?|turns?):(?:[^@/?]*@)?(\[[^\]]+\]|[^:/?\s]+)/i

/** the host of a STUN/TURN url, with any credentials and the port left off */
export function urlHost(url: string | null | undefined): string {
  const host = url ? SERVER_URL.exec(url)?.[1] : undefined
  return host ? maskSafe(host) : UNSUPPORTED
}

export function iceErrorInfo(event: { errorCode?: number; url?: string; errorText?: string }): IceErrorEvent {
  return { code: event.errorCode === undefined ? UNSUPPORTED : String(event.errorCode), host: urlHost(event.url) }
}

/**
 * One peer connection's gathering. `restart` begins a gathering (the first, or
 * an ICE restart's) and counts afresh; `startIfIdle` is for a browser that
 * sends a candidate or `complete` with no `gathering` state before it.
 */
export class GatherTracker {
  private counts = emptyCounts()
  private errors = new Map<string, IceErrorCount>()
  private startedAt = 0 // 0 = not started
  private ms: number | null = null

  restart(now: number): void {
    this.counts = emptyCounts()
    this.errors.clear()
    this.startedAt = now
    this.ms = null
  }

  startIfIdle(now: number): void {
    if (this.startedAt === 0) this.startedAt = now
  }

  add(candidate: { type?: string | null; candidate?: string }): void {
    countCandidate(this.counts, candidate)
  }

  addError(error: IceErrorEvent): void {
    const key = `${error.code}|${error.host}`
    const seen = this.errors.get(key)
    if (seen) seen.n += 1
    else this.errors.set(key, { ...error, n: 1 })
  }

  /** the gathering finished: its event the first time, null after */
  complete(now: number): GatherEvent | null {
    if (this.ms !== null) return null
    this.startIfIdle(now)
    this.ms = now - this.startedAt
    return { ...this.snapshot(), ms: this.ms }
  }

  snapshot(): GatherSnapshot {
    return { counts: { ...this.counts }, ...(this.ms !== null ? { ms: this.ms } : {}), errors: [...this.errors.values()].map((e) => ({ ...e })) }
  }
}
