// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { emptyWire, heldExpiryIn, priorityRefusals, reasonsIn, rejectionsOf, wireSummary, type WireRejection } from "./store-wire"

/** a SCALE string: a compact length prefix, then the UTF-8 bytes, inside some framing bytes */
const scaleFrame = (text: string): Buffer => {
  const body = Buffer.from(text, "utf8")
  return Buffer.concat([Buffer.from([0x03, 0x01, 0x00, (body.length << 2) & 0xff, body.length >> 6]), body, Buffer.from([0x00])])
}
const HOST_REPLY = (reason: string) => `statement-store submit failed: statement_submit not accepted: {"reason":"${reason}","status":"rejected"}`

describe("reasonsIn: the host's refusal inside a frame", () => {
  it("finds the reason in a binary (SCALE) frame", () => {
    expect(reasonsIn(scaleFrame(HOST_REPLY("channelPriorityTooLow")))).toEqual(["channelPriorityTooLow"])
  })
  it("finds it in a text frame, and the node's invalid shape too", () => {
    expect(reasonsIn(`statement_submit not accepted: {"reason":"alreadyExpired","status":"invalid"}`)).toEqual(["alreadyExpired"])
  })
  it("matches the reason alone: game 192 bot 9's host line, verbatim, with no other wording around it", () => {
    // truapi-host's own wording (host log, game 192 bot 9)
    expect(reasonsIn(scaleFrame(`statement_submit not accepted: {"reason":"alreadyExpired","status":"invalid"}`))).toEqual(["alreadyExpired"])
    // a host or SDK that rewords the prefix still carries the node's JSON
    expect(reasonsIn(scaleFrame(`{"reason":"channelPriorityTooLow","status":"rejected"}`))).toEqual(["channelPriorityTooLow"])
    expect(reasonsIn(scaleFrame(`submit refused (channelPriorityTooLow)`))).toEqual(["channelPriorityTooLow"])
  })
  it("reads nothing from a frame that names no reason", () => {
    expect(reasonsIn(scaleFrame("statement accepted"))).toEqual([])
    expect(reasonsIn(scaleFrame("alreadyExpiredX"))).toEqual([])
  })
  it("ignores a reason the node does not give", () => {
    expect(reasonsIn(HOST_REPLY("somethingElse"))).toEqual([])
  })
  it("counts a reason once per frame", () => {
    expect(reasonsIn(`${HOST_REPLY("alreadyExpired")} ${HOST_REPLY("alreadyExpired")}`)).toEqual(["alreadyExpired"])
  })
})

describe("the evidence", () => {
  const w = { ...emptyWire(), frames: 40, sockets: 1, rejections: [{ reason: "channelPriorityTooLow", at: "2026-10-04T19:00:05.000Z" }, { reason: "alreadyExpired", at: "2026-10-04T19:01:00.000Z" }] }
  it("filters by reason and time", () => {
    expect(rejectionsOf(w, "channelPriorityTooLow")).toHaveLength(1)
    expect(rejectionsOf(w, "channelPriorityTooLow", "2026-10-04T19:00:06.000Z")).toHaveLength(0)
  })
  it("summarises, telling nothing read apart from nothing refused", () => {
    expect(wireSummary(w)).toBe("40 host frame(s) on 1 socket(s), refusals: channelPriorityTooLow x1, alreadyExpired x1")
    expect(wireSummary(emptyWire())).toBe("0 host frame(s) on 0 socket(s), no store refusal")
  })
})

/** game 199, bot 16 (a live run): reloaded at turn 6 (22:26:07 CEST) with the old page's floor saved; one
 *  channelPriorityTooLow at 22:27:24, 77 s later, while the glare rebuild sent an offer and an answer to one peer in the
 *  same millisecond. The holder it named was the page's own newer desc. The page's chain time ran ~7.4 s behind the
 *  runner's wall, which is why nothing here converts a clock: the holder and the saved floor are both packed expiries. */
const RELOADED = "2026-10-04T20:26:07.535Z"
const REFUSED = "2026-10-04T20:27:24.400Z"
const LAG_MS = 7_400
/** a packed expiry the way statement-core mints it, stamped at `wallIso` on a page whose chain time lags by LAG_MS */
const packed = (wallIso: string, ms = 0) => {
  const chainMs = Date.parse(wallIso) - LAG_MS + ms
  return (BigInt(Math.floor(chainMs / 1000) + 30) << 32n) | (BigInt(chainMs) & 0xffffffffn)
}
const SAVED_FLOOR = packed("2026-10-04T20:26:06.900Z") // the old page's last accepted stamp, just before the reload
const PRIORITY = (minExpiry: bigint, submitted = minExpiry - 1n) =>
  `statement-store submit failed: statement_submit not accepted: {"min_expiry":${minExpiry},"reason":"channelPriorityTooLow","status":"rejected","submitted_expiry":${submitted}}`

describe("heldExpiryIn: the expiry a channelPriorityTooLow says its channel holds", () => {
  it("reads min_expiry exactly (past 2^53) from the host's SCALE frame", () => {
    const held = packed(REFUSED)
    expect(held > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(heldExpiryIn(scaleFrame(PRIORITY(held)))).toBe(held)
  })
  it("reads the spec-v2 camelCase shape too", () => {
    expect(heldExpiryIn(`{"status":"rejected","reason":"channelPriorityTooLow","submittedExpiry":1,"minExpiry":${packed(REFUSED)}}`)).toBe(packed(REFUSED))
  })
  it("is null when the refusal does not name its holder, or is another reason", () => {
    expect(heldExpiryIn(scaleFrame(HOST_REPLY("channelPriorityTooLow")))).toBeNull()
    expect(heldExpiryIn(`{"min_expiry":5,"reason":"alreadyExpired","status":"invalid"}`)).toBeNull()
  })
})

describe("priorityRefusals: the saved floor failing, apart from the page's own newer frame", () => {
  const refusal = (at: string, held: bigint | null): WireRejection => ({ reason: "channelPriorityTooLow", at, ...(held !== null ? { heldExpiry: held.toString() } : {}) })
  const wire = (rejections: WireRejection[], reloads: { at: string; floor: string | null }[] = [{ at: RELOADED, floor: SAVED_FLOOR.toString() }]) => ({ ...emptyWire(), frames: 6413, sockets: 2, rejections, reloads })

  it("game 199 bot 16: the holder is above the saved floor, so it is the page's own newer frame, superseded", () => {
    const r = priorityRefusals(wire([refusal(REFUSED, packed(REFUSED, -5))]))
    expect(r.stale).toEqual([])
    expect(r.superseded).toHaveLength(1)
  })
  it("a race on the reloaded page's FIRST statements (8 s after the load, the page's clock 7.4 s behind) is still the page's own", () => {
    expect(priorityRefusals(wire([refusal("2026-10-04T20:26:16.000Z", packed("2026-10-04T20:26:15.900Z"))])).stale).toEqual([])
  })
  it("a holder at or below the saved floor is stale: the restored floor did not lift the new page above it", () => {
    expect(priorityRefusals(wire([refusal("2026-10-04T20:26:16.000Z", SAVED_FLOOR)])).stale).toHaveLength(1)
    expect(priorityRefusals(wire([refusal("2026-10-04T20:26:16.000Z", packed("2026-10-04T20:26:01.000Z"))])).stale).toHaveLength(1)
  })
  it("a holder stamped AHEAD before the reload (a learned margin) and saved is stale too, though its deadline reads later", () => {
    const ahead = packed("2026-10-04T20:26:06.000Z", 45_000)
    const floor = ahead // it was accepted, so the old page saved it
    expect(priorityRefusals(wire([refusal("2026-10-04T20:26:16.000Z", ahead)], [{ at: RELOADED, floor: floor.toString() }])).stale).toHaveLength(1)
  })
  it("a refusal that names no holder, or a reload that saved no floor, is stale: nothing shows the floor worked", () => {
    expect(priorityRefusals(wire([refusal(REFUSED, null)])).stale).toHaveLength(1)
    expect(priorityRefusals(wire([refusal(REFUSED, packed(REFUSED))], [{ at: RELOADED, floor: null }])).stale).toHaveLength(1)
  })
  it("judges each refusal against the latest reload before it; before any reload the holder is the page's own", () => {
    const early = refusal("2026-10-04T20:20:00.000Z", packed("2026-10-04T20:19:59.000Z"))
    const r = priorityRefusals(wire([early]))
    expect(r.stale).toEqual([])
    expect(r.superseded).toEqual([early])
    const second = { at: "2026-10-04T20:27:00.000Z", floor: packed("2026-10-04T20:26:59.000Z").toString() }
    // above the first reload's floor but at the second's: stale against the second
    expect(priorityRefusals(wire([refusal("2026-10-04T20:27:05.000Z", packed("2026-10-04T20:26:30.000Z"))], [{ at: RELOADED, floor: SAVED_FLOOR.toString() }, second])).stale).toHaveLength(1)
  })
  it("filters by time, and ignores other reasons", () => {
    const w = wire([refusal("2026-10-04T20:26:12.000Z", SAVED_FLOOR), { reason: "alreadyExpired", at: REFUSED }])
    expect(priorityRefusals(w, "2026-10-04T20:26:13.000Z").stale).toEqual([])
    expect(priorityRefusals(w).stale).toHaveLength(1)
  })
})
