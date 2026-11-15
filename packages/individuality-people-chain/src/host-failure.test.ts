// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { chainVerdict, classifyHostFailure, HOST_FAILURE_CLASSES, walkTags, type HostFailureClass } from "./host-failure"

const named = (name: string, message: string, cause?: unknown) => Object.assign(new Error(message, { cause }), { name })

const reset = named("ConnectionResetError", "TrUAPI host connection interrupted")
const sdkWrapped =
  "Could not process the host's response to createTransaction failed: TrUAPI host connection interrupted. The usual cause is a protocol-version skew between the host app and the @parity/truapi version this product is built against; a host channel that closed mid-call looks the same."

describe("classifyHostFailure", () => {
  it.each<[string, unknown, HostFailureClass]>([
    ["the host cannot resolve the block", new Error("createTransaction failed: cannot get the current block"), "cannot-get-current-block"],
    ["the Rust variant name", new Error("createTransaction failed: CannotGetCurrentBlock"), "cannot-get-current-block"],
    ["the block before the dropped subscription", new Error("cannot get the current block: subscription dropped"), "cannot-get-current-block"],
    ["the block after the dropped subscription", new Error("subscription dropped, CannotGetCurrentBlock"), "cannot-get-current-block"],
    ["a TURN proof refusal", "no proof: CannotGetCurrentBlock { reason: Rpc(SubscriptionDropped) }", "cannot-get-current-block"],
    ["a dropped subscription alone", new Error("RPC error: subscription dropped"), "subscription-dropped"],
    ["a follow the core lost", new Error("unknown follow subscription id FollowId(3)"), "follow-unknown"],
    ["the unpinned block of papi", "Block 0x89b2 is not pinned (stop-storage) <- BlockNotPinnedError", "block-not-pinned"],
    ["the unpinned block as a message", new Error("Block 0x12 is not pinned (stop-storage)"), "block-not-pinned"],
    ["the raw transport reset", reset, "host-interrupted"],
    ["the reset under the SDK wrapper", new Error(sdkWrapped, { cause: reset }), "host-interrupted"],
    ["the SDK wrapper as text", sdkWrapped, "host-interrupted"],
    ["the describeError rendering", "The host channel was interrupted (the app likely resumed). <- TrUAPI host connection interrupted", "host-interrupted"],
    ["the protocol-skew wrapper", new Error("usual cause is protocol-version skew", { cause: new Error("TrUAPI host connection interrupted") }), "host-interrupted"],
    ["an interrupted Result", { ok: false, error: new Error("TrUAPI host connection interrupted") }, "host-interrupted"],
    ["the timeout of the client by name", named("RequestTimeoutError", "p:17 timed out after 390000ms"), "timeout"],
    ["the SDK timeout wrapper by name", named("HostTimeoutError", "The host did not answer createTransaction within 390s.", named("RequestTimeoutError", "p:17")), "timeout"],
    ["a compact timeout", "operation timeout", "timeout"],
    ["a run-together timeout", "operation timedout", "timeout"],
    ["a separated timeout", "operation timed out", "timeout"],
    ["a read with no answer", new Error("ReadTimeoutError: no answer after 15 seconds"), "timeout"],
    ["a bounded TURN proof", "turn/proof: no answer in 5000ms", "timeout"],
    ["a signing the player cancelled by name", named("TxSigningRejectedError", "Transaction signing was rejected."), "declined"],
    ["a signing the player cancelled as text", "Transaction signing was rejected.", "declined"],
    ["the refusal of the signer", "HostRejectedError: Host rejected the request", "declined"],
    ["a no from the host", "createTransaction failed: user rejected the confirmation", "declined"],
    ["the bare rejection of the host", "createTransaction failed: Rejected", "declined"],
    ["the bare rejection over its cause", "createTransaction failed: Rejected <- CallError", "declined"],
    ["the bare rejection alone", "Rejected", "declined"],
    ["the bare rejection as a variant", { tag: "Rejected" }, "declined"],
    ["the bare rejection under a wrapper", new Error("claim did not land", { cause: new Error("Rejected") }), "declined"],
    ["a transaction the pool rejected", "transaction rejected: Invalid.Payment", "unknown"],
    ["a pool verdict ending in rejected", "pool: transaction rejected", "unknown"],
    ["a host that went away", "HostDisconnectedError: host went away", "network"],
    ["a device with no link", "the device is offline", "network"],
    ["a closed socket", new Error("WebSocket connection closed"), "network"],
    ["an offline device", "fetch failed: offline", "network"],
    ["a refusal nobody classed", new Error("user refused"), "unknown"],
    ["a decode failure", new Error("Offset is outside the bounds of the DataView"), "unknown"],
    ["a text nobody has met", "something nobody has met", "unknown"],
    ["nothing", undefined, "unknown"],
  ])("classes %s", (_, value, failureClass) => {
    expect(classifyHostFailure(value)).toBe(failureClass)
  })

  it("reads a host-tagged refusal down to its reason", () => {
    expect(
      classifyHostFailure({
        tag: "CallError",
        value: { tag: "Domain", value: { tag: "V1", value: { tag: "HostFailure", value: { reason: "cannot get the current block" } } } },
      }),
    ).toBe("cannot-get-current-block")
  })

  it("lets the name of the error beat the words under it", () => {
    expect(classifyHostFailure(named("ConnectionResetError", "cannot get the current block"))).toBe("host-interrupted")
    expect(classifyHostFailure(new Error("cannot get the current block", { cause: reset }))).toBe("host-interrupted")
  })

  it("lets a reset anywhere in the chain beat a timeout around it", () => {
    expect(classifyHostFailure(named("RequestTimeoutError", "p:17 timed out", reset))).toBe("host-interrupted")
    expect(classifyHostFailure(named("ConnectionResetError", "TrUAPI host connection interrupted", named("RequestTimeoutError", "p:17")))).toBe("host-interrupted")
  })

  it("reads a variant name only for the host variants", () => {
    expect(classifyHostFailure({ tag: "Timeout" })).toBe("unknown")
    expect(classifyHostFailure({ tag: "Domain", value: { tag: "ConnectionClosed" } })).toBe("unknown")
    expect(classifyHostFailure({ type: "NetworkDown" })).toBe("unknown")
    expect(classifyHostFailure({ tag: "Domain", value: { tag: "V1", value: { tag: "CannotGetCurrentBlock" } } })).toBe("cannot-get-current-block")
    expect(classifyHostFailure({ tag: "SubscriptionDropped" })).toBe("subscription-dropped")
    expect(classifyHostFailure({ type: "BlockNotPinned" })).toBe("block-not-pinned")
    expect(classifyHostFailure({ tag: "Domain", value: { tag: "V1", value: { tag: "UnableToSign" } } })).toBe("declined")
    expect(classifyHostFailure({ tag: "SigningRejected" })).toBe("declined")
    expect(classifyHostFailure({ tag: "HostRejected" })).toBe("declined")
  })

  it("survives a cycle in the cause chain", () => {
    const inner = new Error("subscription dropped")
    const outer = new Error("sign-up did not land", { cause: inner })
    ;(inner as { cause?: unknown }).cause = outer
    expect(classifyHostFailure(outer)).toBe("subscription-dropped")
  })
})

describe("chainVerdict", () => {
  it("is the only place that says which classes mean a lost chain", () => {
    expect(HOST_FAILURE_CLASSES.map((failureClass) => [failureClass, chainVerdict(failureClass)])).toEqual([
      ["cannot-get-current-block", "lost"],
      ["subscription-dropped", "lost"],
      ["follow-unknown", "lost"],
      ["block-not-pinned", "lost"],
      ["host-interrupted", "interrupted"],
      ["timeout", "unanswered"],
      ["declined", "declined"],
      ["network", "unknown"],
      ["unknown", "unknown"],
    ])
  })
})

describe("walkTags", () => {
  it("collects the tags down to the leaf", () => {
    expect(walkTags({ tag: "Domain", value: { tag: "V1", value: { reason: "x" } } }, "tag")).toEqual({ tags: ["Domain", "V1"], leaf: { reason: "x" } })
    expect(walkTags("plain", "type")).toEqual({ tags: [], leaf: "plain" })
  })
})
