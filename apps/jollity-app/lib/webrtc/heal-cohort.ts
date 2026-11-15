// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A diagnostic-only view of near-simultaneous failures across independent
 * peer connections. It never starts, delays or otherwise influences healing.
 */

const HEAL_COHORT_WINDOW_MS = 250
const HEAL_COHORT_RECOVERY_WAIT_MS = 30_000

/**
 * How long ICE may sit `disconnected` before the connection's `failed` and the
 * failure still counts as the transport being torn down under the link (a TURN
 * socket closed, issue #944): Chrome then drops the pair at once, and both
 * states land in the same millisecond. A path that only went quiet fails on
 * consent instead, seconds after `disconnected`.
 */
export const LINK_TORN_DOWN_MS = 1_000

export type LinkFailKind = "torn-down" | "timed-out"

export const linkFailKind = (quietMs: number): LinkFailKind => (quietMs <= LINK_TORN_DOWN_MS ? "torn-down" : "timed-out")

export interface HealCohortPath {
  relayProtocol?: string
  /** where relayProtocol came from: the browser's stat, or the TURN url (rtc-stats.ts resolvedRelay) */
  relayProtocolSource?: string
  turnEndpointHost?: string
}

/** How one established link failed: what mesh.ts knows at the connection's `failed`. */
export interface LinkFailure extends HealCohortPath {
  /** not `kind`: this rides an RtcEvent, whose `kind` is "link_failed" */
  failKind: LinkFailKind
  /** ms from ICE `disconnected` to the connection's `failed`; 0 when ICE never said disconnected first */
  quietMs: number
  /** ms since this connection last reached `connected` */
  upMs: number
  /** the link's last known path: direct, relay or unknown */
  path: string
  /** the page was hidden when the link failed */
  pageHidden: boolean
  /** ms since the last network change the mesh heard of; absent when there was none */
  sinceNetChangeMs?: number
}

export interface HealCohortEvent {
  /** established links that failed in this wave */
  size: number
  /** elapsed time from the first failure to the last */
  windowMs: number
  relayProtocol: string
  turnEndpointHost: string
  /** torn-down, timed-out, mixed, or unknown when no member said */
  failKind: string
  /** one entry per failed link, in failure order; null when the link gave no failure facts */
  quietMs: Array<number | null>
  /** one entry per failed link, in failure order; null means no recovery observed */
  recoveryMs: Array<number | null>
  unrecovered: number
  /** the page was hidden at the first failure (absent when unknown) */
  pageHidden?: boolean
  /** ms from the last network change to the first failure (absent when none) */
  sinceNetChangeMs?: number
}

interface Member {
  peerId: string
  failedAt: number
  recoveredAt?: number
  failure?: LinkFailure
  terminal: boolean
}

interface Cohort {
  members: Member[]
  sealed: boolean
  membershipTimer?: ReturnType<typeof setTimeout>
  recoveryTimer?: ReturnType<typeof setTimeout>
}

const sharedValue = (values: Array<string | undefined>): string => {
  const known = new Set(values.filter((value): value is string => Boolean(value)))
  if (known.size === 0) return "unknown"
  if (known.size === 1) return [...known][0]
  return "mixed"
}

export class HealCohortTracker {
  private collecting?: Cohort
  private byPeer = new Map<string, Cohort>()
  private pending = new Set<Cohort>()

  constructor(private emit: (anchorPeerId: string, event: HealCohortEvent) => void) {}

  failed(peerId: string, now: number, failure?: LinkFailure): void {
    // A connectionState callback can repeat while a link remains failed. One
    // outage belongs to one cohort until it recovers or leaves.
    if (this.byPeer.has(peerId)) return
    let cohort = this.collecting
    if (!cohort || now - cohort.members[0].failedAt > HEAL_COHORT_WINDOW_MS) {
      if (cohort) this.seal(cohort)
      cohort = { members: [], sealed: false }
      this.collecting = cohort
      this.pending.add(cohort)
      cohort.membershipTimer = setTimeout(() => this.seal(cohort!), HEAL_COHORT_WINDOW_MS)
    }
    cohort.members.push({ peerId, failedAt: now, failure, terminal: false })
    this.byPeer.set(peerId, cohort)
  }

  recovered(peerId: string, now: number): void {
    const cohort = this.byPeer.get(peerId)
    const member = cohort?.members.find((candidate) => candidate.peerId === peerId)
    if (!cohort || !member || member.terminal) return
    member.recoveredAt = now
    member.terminal = true
    if (cohort.sealed) this.flushIfTerminal(cohort)
  }

  left(peerId: string): void {
    const cohort = this.byPeer.get(peerId)
    const member = cohort?.members.find((candidate) => candidate.peerId === peerId)
    if (!cohort || !member || member.terminal) return
    member.terminal = true
    if (cohort.sealed) this.flushIfTerminal(cohort)
  }

  close(): void {
    if (this.collecting) this.seal(this.collecting)
    for (const cohort of [...this.pending]) {
      if (cohort.members.length >= 2) this.flush(cohort)
      else this.discard(cohort)
    }
  }

  private seal(cohort: Cohort): void {
    if (cohort.sealed) return
    cohort.sealed = true
    if (this.collecting === cohort) this.collecting = undefined
    if (cohort.membershipTimer) clearTimeout(cohort.membershipTimer)
    cohort.membershipTimer = undefined
    if (cohort.members.length < 2) {
      this.discard(cohort)
      return
    }
    if (cohort.members.every((member) => member.terminal)) {
      this.flush(cohort)
      return
    }
    cohort.recoveryTimer = setTimeout(() => this.flush(cohort), HEAL_COHORT_RECOVERY_WAIT_MS)
  }

  private flushIfTerminal(cohort: Cohort): void {
    if (cohort.members.every((member) => member.terminal)) this.flush(cohort)
  }

  private flush(cohort: Cohort): void {
    if (!this.pending.has(cohort)) return
    const first = cohort.members[0].failedAt
    const last = cohort.members.at(-1)?.failedAt ?? first
    const recoveryMs = cohort.members.map((member) => member.recoveredAt === undefined
      ? null
      : Math.max(0, Math.round(member.recoveredAt - member.failedAt)))
    const lead = cohort.members[0].failure
    this.emit(cohort.members[0].peerId, {
      size: cohort.members.length,
      windowMs: Math.max(0, Math.round(last - first)),
      relayProtocol: sharedValue(cohort.members.map((member) => member.failure?.relayProtocol)),
      turnEndpointHost: sharedValue(cohort.members.map((member) => member.failure?.turnEndpointHost)),
      failKind: sharedValue(cohort.members.map((member) => member.failure?.failKind)),
      quietMs: cohort.members.map((member) => (member.failure ? Math.max(0, Math.round(member.failure.quietMs)) : null)),
      recoveryMs,
      unrecovered: recoveryMs.filter((duration) => duration === null).length,
      ...(lead ? { pageHidden: lead.pageHidden } : {}),
      ...(lead?.sinceNetChangeMs !== undefined ? { sinceNetChangeMs: Math.max(0, Math.round(lead.sinceNetChangeMs)) } : {}),
    })
    this.discard(cohort)
  }

  private discard(cohort: Cohort): void {
    if (cohort.membershipTimer) clearTimeout(cohort.membershipTimer)
    if (cohort.recoveryTimer) clearTimeout(cohort.recoveryTimer)
    for (const member of cohort.members) {
      if (this.byPeer.get(member.peerId) === cohort) this.byPeer.delete(member.peerId)
    }
    this.pending.delete(cohort)
    if (this.collecting === cohort) this.collecting = undefined
  }
}
