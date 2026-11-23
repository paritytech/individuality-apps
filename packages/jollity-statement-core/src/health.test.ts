// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  NOT_STALLED,
  NET_GRACE_MS,
  RECOVERY_GRACE_MS,
  SIGNAL_GRACE_MS,
  SUBMIT_STALL_MS,
  classifyLadder,
  classifySignalHealth,
  dedupeKey,
  deriveGroupId,
  shouldEmit,
  stallTransition,
  type LadderInput,
  type Layer,
  type LayerResult,
  type PeerHealthSnapshot,
  type PeerReportLike,
} from "./health"
import type { SignalStats } from "./transport"

const NOW = 1_800_000_000_000

function stats(over: Partial<SignalStats> = {}): SignalStats {
  return {
    kind: "peer-session",
    storeLive: true,
    subActive: true,
    submitsOk: 5,
    submitsFailed: 0,
    framesSent: 5,
    framesRecv: 5,
    lastSubmitOkAt: NOW - 1_000,
    lastInboundAt: NOW - 1_000,
    lastError: "",
    inflight: 0,
    firstSendAt: NOW - 20_000,
    signTimeouts: 0,
    ...over,
  }
}

const PAST_GRACE = SIGNAL_GRACE_MS + 1

describe("classifySignalHealth", () => {
  it("is warming with no transport, and inside the grace window", () => {
    expect(classifySignalHealth(null, 99_999, NOW)).toBe("warming")
    expect(classifySignalHealth(stats(), SIGNAL_GRACE_MS - 1, NOW)).toBe("warming")
  })

  it("reports store-unavailable before the grace window even applies", () => {
    // an app version with no statement store is knowable immediately — there
    // is nothing to wait for
    expect(classifySignalHealth(stats({ storeLive: false }), 0, NOW)).toBe("store-unavailable")
  })

  // The silent hang: frames queued, nothing acknowledged, no call failed.
  it("names a silent signer: sent, but neither an ok nor a failure", () => {
    expect(
      classifySignalHealth(
        stats({ framesSent: 3, submitsOk: 0, submitsFailed: 0, lastSubmitOkAt: 0 }),
        PAST_GRACE,
        NOW,
      ),
    ).toBe("signer-no-response")
  })

  it("does not cry silence before three frames have been sent", () => {
    expect(
      classifySignalHealth(
        stats({ framesSent: 2, submitsOk: 0, submitsFailed: 0, lastSubmitOkAt: 0 }),
        PAST_GRACE,
        NOW,
      ),
    ).toBe("ok")
  })

  it("routes a sign timeout to the signer, not to a rejection", () => {
    // it arrives through the same catch as any rejection and bumps
    // submitsFailed, so the order of these checks is what makes it legible
    expect(
      classifySignalHealth(
        stats({ submitsFailed: 2, lastSubmitOkAt: 0, lastError: "sign-timeout: no answer in 8000ms" }),
        PAST_GRACE,
        NOW,
      ),
    ).toBe("signer-no-response")
  })

  it("separates the rejection kinds", () => {
    const rejected = (lastError: string) =>
      classifySignalHealth(stats({ submitsFailed: 2, lastSubmitOkAt: 0, lastError }), PAST_GRACE, NOW)
    expect(rejected("statement not authorised for this account")).toBe("submit-rejected-allowance")
    expect(rejected("AccountFull")).toBe("submit-rejected-full")
    expect(rejected("error 0")).toBe("submit-rejected-full")
    expect(rejected("something else entirely")).toBe("submit-rejected-other")
  })

  it("holds fire on failures while a recent submit still succeeded", () => {
    // retries in flight are not a stall
    expect(
      classifySignalHealth(
        stats({ submitsFailed: 2, lastSubmitOkAt: NOW - 1_000, lastError: "boom" }),
        PAST_GRACE,
        NOW,
      ),
    ).toBe("ok")
  })

  it("reports inbound-dead for a down subscription, and for prolonged silence", () => {
    expect(classifySignalHealth(stats({ subActive: false }), PAST_GRACE, NOW)).toBe("inbound-dead")
    expect(classifySignalHealth(stats({ framesRecv: 0 }), SUBMIT_STALL_MS + 1, NOW)).toBe("inbound-dead")
  })
})

// ── ladder ────────────────────────────────────────────────────────────────

function peer(over: Partial<PeerReportLike> = {}): PeerReportLike {
  return {
    id: "peerAAAA",
    conn: "connected",
    ice: "connected",
    gather: "complete",
    sig: "stable",
    pair: "srflx/srflx",
    frames: 120,
    ...over,
  }
}

const snap = (
  conn: RTCPeerConnectionState,
  gaveEndpoint: boolean,
  over: Partial<PeerHealthSnapshot> = {},
): PeerHealthSnapshot => ({ conn, gaveEndpoint, ...over })

function ladder(over: Partial<LadderInput> = {}): LadderInput {
  return {
    online: true,
    ice: { turnReceived: true, issuerErrors: [], at: NOW - 5_000 },
    stats: stats(),
    signalElapsedMs: NET_GRACE_MS + 1,
    peers: [peer()],
    health: [snap("connected", true)],
    selfLive: true,
    struggling: false,
    connectionNowMs: NOW,
    nowMs: NOW,
    ...over,
  }
}

const rung = (rungs: LayerResult[], layer: Layer) => rungs.find((r) => r.layer === layer)!

describe("classifyLadder", () => {
  it("blames nothing when every rung is healthy", () => {
    const v = classifyLadder(ladder())
    expect(v.blame).toBeNull()
    expect(v.rungs.every((r) => r.status === "ok")).toBe(true)
  })

  it("blames the FIRST failing rung", () => {
    const v = classifyLadder(ladder({ online: false, stats: stats({ storeLive: false }) }))
    expect(v.blame?.layer).toBe("internet")
  })

  it("marks rungs below the blame unevaluated, not innocent", () => {
    // one broken store makes signalling/ice/media fail as a CONSEQUENCE;
    // reporting four reds for one cause reads as four problems
    const v = classifyLadder(ladder({ online: false }))
    expect(rung(v.rungs, "store-write").status).toBe("unknown")
    expect(rung(v.rungs, "ice").detail).toContain("not evaluated")
  })

  describe("this player's own key (rung 1b)", () => {
    const sealed = (ownKeyMissing: number, ownKeyFound: boolean) =>
      stats({
        sealed: { ownKeyMissing, ownKeyFound, peerIdMissing: 0, openFailed: 0, plaintextDropped: 0, droppedAtLookupCap: 0, droppedInBackoff: 0 },
      })
    const stunOnly = { turnReceived: false, issuerErrors: ["issuer 1: NotAllowlisted"], at: NOW }
    // no co-player gets a frame: nobody gives an endpoint, and ICE has no path
    const dark = { health: [snap("new", false), snap("new", false)], peers: [] }

    it("takes the blame over a failed relay and the rungs it breaks, so the network is not blamed", () => {
      const v = classifyLadder(ladder({ stats: sealed(2, false), ice: stunOnly, ...dark }))
      expect(v.blame?.layer).toBe("own-key")
      expect(rung(v.rungs, "turn-credentials").status).toBe("unknown")
      expect(rung(v.rungs, "signalling").detail).toContain("not evaluated")
    })

    it("takes the blame over nobody having turned up, with the relay working", () => {
      const v = classifyLadder(ladder({ stats: sealed(1, false), ...dark }))
      expect(v.blame?.layer).toBe("own-key")
    })

    it("is ok once a later lookup found the key, whatever missed before", () => {
      const v = classifyLadder(ladder({ stats: sealed(3, true) }))
      expect(rung(v.rungs, "own-key").status).toBe("ok")
      expect(v.blame).toBeNull()
    })

    it("is unknown before the first lookup answers, and ok on a wire that seals nothing", () => {
      expect(rung(classifyLadder(ladder({ stats: sealed(0, false) })).rungs, "own-key").status).toBe("unknown")
      expect(rung(classifyLadder(ladder({ stats: null })).rungs, "own-key").status).toBe("unknown")
      expect(rung(classifyLadder(ladder()).rungs, "own-key")).toMatchObject({ status: "ok", expected: "this wire seals nothing" })
    })

    it("still gives way to being offline", () => {
      expect(classifyLadder(ladder({ online: false, stats: sealed(1, false) })).blame?.layer).toBe("internet")
    })
  })

  describe("the known blocker (rung 2)", () => {
    const stunOnly = { turnReceived: false, issuerErrors: ["issuer 1: Load failed"], at: NOW }

    it("reports red but takes no blame on its own", () => {
      // otherwise it would hold blame permanently and blind the whole ladder
      const v = classifyLadder(ladder({ ice: stunOnly }))
      expect(rung(v.rungs, "turn-credentials").status).toBe("fail")
      expect(rung(v.rungs, "turn-credentials").knownBlocker).toBe(true)
      expect(v.blame).toBeNull()
    })

    it("reports the issuers' real errors in the order tried, never a fixed CORS label", () => {
      const ice = { turnReceived: false, issuerErrors: ["issuer 1: turn/issue-with-proof 400", "issuer 2: Load failed"], at: NOW }
      const detail = rung(classifyLadder(ladder({ ice })).rungs, "turn-credentials").detail
      expect(detail).toBe("STUN-only, no TURN relay. issuer 1: turn/issue-with-proof 400 | issuer 2: Load failed")
      expect(detail).not.toContain("CORS")
    })

    it("says no issuer error was recorded when there is none", () => {
      const ice = { turnReceived: false, issuerErrors: [], at: NOW }
      const detail = rung(classifyLadder(ladder({ ice })).rungs, "turn-credentials").detail
      expect(detail).toBe("STUN-only, no TURN relay. No TURN issuer error was recorded.")
    })

    it("TAKES blame the moment a later rung also fails", () => {
      // STUN-only genuinely IS the cause when no path is ever nominated
      const v = classifyLadder(
        ladder({
          ice: stunOnly,
          peers: [peer({ conn: "failed", pair: undefined }), peer({ id: "peerBBBB", conn: "failed", pair: undefined })],
          health: [snap("failed", true), snap("failed", true)],
        }),
      )
      expect(v.blame?.layer).toBe("turn-credentials")
    })

    it("still yields to an earlier genuine failure", () => {
      const v = classifyLadder(ladder({ online: false, ice: stunOnly }))
      expect(v.blame?.layer).toBe("internet")
    })
  })

  it("splits write health from read health", () => {
    // a single store verdict could not express "we can write
    // but nothing comes back"
    const v = classifyLadder(ladder({ stats: stats({ subActive: false }) }))
    expect(rung(v.rungs, "store-write").status).toBe("ok")
    expect(v.blame?.layer).toBe("store-read")
  })

  it("passes store-read vacuously, and says so, when nobody is publishing", () => {
    // the standard solo/padded-group shape — a notice here would tell a
    // perfectly healthy player they are broken
    const v = classifyLadder(
      ladder({ stats: stats({ framesRecv: 0 }), health: [snap("connecting", false)], peers: [] }),
    )
    const r = rung(v.rungs, "store-read")
    expect(r.status).toBe("ok")
    expect(r.expected).toContain("no peer is publishing")
  })

  describe("ice (rung 6)", () => {
    const unreachable = (n: number) => ({
      peers: Array.from({ length: n }, (_, i) => peer({ id: `peer${i}`, conn: "failed" as const, pair: undefined })),
      health: Array.from({ length: n }, () => snap("failed", true)),
    })

    it("will not blame our network on ONE unreachable peer", () => {
      // ambiguous — it could be them; that belongs on their own row
      const v = classifyLadder(ladder({ ...unreachable(1) }))
      expect(rung(v.rungs, "ice").status).toBe("unknown")
    })

    it("blames it once two published peers are both unreachable", () => {
      const v = classifyLadder(ladder({ ...unreachable(2) }))
      expect(v.blame?.layer).toBe("ice")
    })

    it("#1203 does not blame ICE while its transports are connected and the peer connections settle", () => {
      const settling = {
        peers: Array.from({ length: 2 }, (_, i) =>
          peer({ id: `peer${i}`, conn: "connecting" as const, ice: "connected", pair: undefined }),
        ),
        health: Array.from({ length: 2 }, () =>
          snap("connecting", true, { ice: "connected" }),
        ),
      }
      const v = classifyLadder(ladder(settling))
      expect(rung(v.rungs, "ice")).toMatchObject({ status: "ok" })
      expect(rung(v.rungs, "ice").detail).toContain("settling")
      expect(v.blame).toBeNull()
    })

    it.each(["failed", "closed"] as const)(
      "#1203 does not let connected ICE hide %s peer connections",
      (connectionState) => {
        const failed = {
          peers: Array.from({ length: 2 }, (_, i) =>
            peer({ id: `peer${i}`, conn: connectionState, ice: "connected", pair: undefined }),
          ),
          health: Array.from({ length: 2 }, () =>
            snap(connectionState, true, { ice: "connected" }),
          ),
        }
        const v = classifyLadder(ladder(failed))
        expect(rung(v.rungs, "ice")).toMatchObject({ status: "fail" })
        expect(v.blame?.layer).toBe("ice")
      },
    )

    it("holds the ICE verdict while every unreachable published link is actively recovering", () => {
      const recoveryStartedAt = NOW - 9_000
      const recovering = {
        peers: Array.from({ length: 2 }, (_, i) => peer({ id: `peer${i}`, conn: "failed" as const, pair: undefined })),
        health: Array.from({ length: 2 }, () =>
          snap("failed", true, { recovering: true, recoveryStartedAt }),
        ),
      }
      const v = classifyLadder(ladder(recovering))
      expect(rung(v.rungs, "ice")).toMatchObject({ status: "unknown" })
      expect(rung(v.rungs, "ice").detail).toContain("self-heal in progress")
      expect(v.blame).toBeNull()
    })

    it("restores the real ICE failure after the continuous recovery grace expires", () => {
      const recoveryStartedAt = NOW - RECOVERY_GRACE_MS - 1
      const recovering = {
        peers: Array.from({ length: 2 }, (_, i) => peer({ id: `peer${i}`, conn: "failed" as const, pair: undefined })),
        health: Array.from({ length: 2 }, () =>
          snap("failed", true, { recovering: true, recoveryStartedAt }),
        ),
      }
      const v = classifyLadder(ladder(recovering))
      expect(rung(v.rungs, "ice")).toMatchObject({ status: "fail" })
      expect(v.blame?.layer).toBe("ice")
    })

    it("does not hide never-connected or otherwise unrecovering published peers", () => {
      const v = classifyLadder(
        ladder({
          peers: [
            peer({ conn: "failed", pair: undefined }),
            peer({ id: "peerBBBB", conn: "failed", pair: undefined }),
          ],
          health: [snap("failed", true, { recovering: false }), snap("failed", true)],
        }),
      )
      expect(rung(v.rungs, "ice")).toMatchObject({ status: "fail" })
      expect(v.blame?.layer).toBe("ice")
    })

    it("waits out the network grace window first", () => {
      const v = classifyLadder(ladder({ ...unreachable(2), signalElapsedMs: NET_GRACE_MS - 1 }))
      expect(rung(v.rungs, "ice").status).toBe("unknown")
    })
  })

  it("catches a connected link carrying no frames", () => {
    // conn === "connected" says the LINK is up and nothing about media
    const v = classifyLadder(ladder({ peers: [peer({ frames: 0 })] }))
    expect(v.blame?.layer).toBe("media")
  })

  it("warns, rather than failing, when only some peers are silent", () => {
    const v = classifyLadder(ladder({ peers: [peer(), peer({ id: "peerBBBB", frames: 0 })] }))
    expect(rung(v.rungs, "media").status).toBe("warn")
    expect(v.blame).toBeNull()
  })

  it("leaves camera unevaluated until liveness is sampled", () => {
    const v = classifyLadder(ladder({ selfLive: undefined }))
    expect(rung(v.rungs, "camera").status).toBe("unknown")
    expect(v.blame).toBeNull()
  })

  it("blames this phone when it cannot keep up, last of all", () => {
    expect(rung(classifyLadder(ladder({ struggling: undefined })).rungs, "device").status).toBe("unknown")
    expect(classifyLadder(ladder()).blame).toBeNull()
    expect(classifyLadder(ladder({ struggling: true })).blame?.layer).toBe("device")
    // a link with no video at all is the reason, not a slow phone
    expect(classifyLadder(ladder({ struggling: true, peers: [peer({ frames: 0 })] })).blame?.layer).toBe("media")
  })
})

// ── stall transitions ─────────────────────────────────────────────────────

const blame = (layer: Layer): LayerResult => ({ layer, status: "fail", detail: "x" })

describe("stallTransition", () => {
  it("says nothing while a state persists, in either direction", () => {
    const healthy = stallTransition({ blame: null, now: NOW, prev: NOT_STALLED, lastReconnectAt: 0, stats: null })
    expect(healthy.event).toBeNull()

    const stalled = stallTransition({
      blame: blame("ice"),
      now: NOW,
      prev: { since: NOW - 5_000, layer: "ice" },
      lastReconnectAt: 0,
      stats: null,
    })
    expect(stalled.event).toBeNull()
  })

  it("emits once on entry, carrying the layer and the context", () => {
    const r = stallTransition({
      blame: blame("store-write"),
      now: NOW,
      prev: NOT_STALLED,
      lastReconnectAt: 0,
      stats: stats(),
      context: { gameId: "g1", groupId: "abc", round: 3 },
    })
    expect(r.event?.kind).toBe("connection_stalled")
    expect(r.event?.layer).toBe("store-write")
    expect(r.event?.round).toBe(3)
    expect(r.next.since).toBe(NOW)
  })

  it("recovers with the layer the stall ENTERED with", () => {
    // joins the pair in an export, and keeps the dedupe key varying across
    // back-to-back cycles with different causes
    const r = stallTransition({
      blame: null,
      now: NOW,
      prev: { since: NOW - 8_000, layer: "store-write" },
      lastReconnectAt: 0,
      stats: null,
    })
    expect(r.event?.kind).toBe("connection_recovered")
    expect(r.event?.layer).toBe("store-write")
    expect(r.event?.detail.stallMs).toBe(8_000)
    expect(r.next).toEqual(NOT_STALLED)
  })

  it("credits a tap only when it happened during THIS stall", () => {
    const prev = { since: NOW - 8_000, layer: "ice" }
    const during = stallTransition({ blame: null, now: NOW, prev, lastReconnectAt: NOW - 4_000, stats: null })
    expect(during.event?.detail.recoveredVia).toBe("reconnect-tapped")

    // a tap left over from an EARLIER, unrelated stall must not be credited
    const before = stallTransition({ blame: null, now: NOW, prev, lastReconnectAt: NOW - 30_000, stats: null })
    expect(before.event?.detail.recoveredVia).toBe("self-heal")
  })
})

// ── correlation + dedupe ──────────────────────────────────────────────────

describe("deriveGroupId", () => {
  it("is order-independent, so every member computes the same key", () => {
    expect(deriveGroupId(["c", "a", "b"])).toBe(deriveGroupId(["a", "b", "c"]))
  })

  it("ignores pads, so a padded group still joins to a full one", () => {
    expect(deriveGroupId(["a", "b", "pad:1"])).toBe(deriveGroupId(["a", "b"]))
  })

  it("separates different groups", () => {
    expect(deriveGroupId(["a", "b"])).not.toBe(deriveGroupId(["a", "c"]))
  })
})

describe("dedupeKey", () => {
  // these two properties are invisible in production when broken: the line
  // simply never appears
  it("varies by round, so the same stall in two rounds is two events", () => {
    expect(dedupeKey({ kind: "connection_stalled", layer: "ice", round: 1 })).not.toBe(
      dedupeKey({ kind: "connection_stalled", layer: "ice", round: 2 }),
    )
  })

  it("varies by layer, so a second stall with a different cause survives", () => {
    expect(dedupeKey({ kind: "connection_stalled", layer: "ice" })).not.toBe(
      dedupeKey({ kind: "connection_stalled", layer: "store-write" }),
    )
  })
})

describe("shouldEmit", () => {
  it("passes once, then suppresses inside the window, then passes again", () => {
    const seen = new Map<string, number>()
    expect(shouldEmit(seen, "k", NOW)).toBe(true)
    expect(shouldEmit(seen, "k", NOW + 29_000)).toBe(false)
    expect(shouldEmit(seen, "k", NOW + 31_000)).toBe(true)
  })
})
