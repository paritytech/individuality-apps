// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE HOST WIRE AND ITS CONNECTION SIGNAL, PINNED.
 *
 * Two contracts live here, both load-bearing and both invisible when broken:
 *
 *  1. **The truapi the host package rides.** The host and the SDK do not
 *     negotiate: a codec-3 peer refuses a codec-2 one at the handshake, and the
 *     failure reads as "not in a host". `apps/jollity-worker/src/hostStack.test.ts` is the ONE
 *     home of the codec/schema pin and the one-copy check; this suite adds the
 *     half that matters to the app — the truapi the host package DECLARES is
 *     the one the tree RESOLVES, so a host bump cannot leave the app on a
 *     different wire than the host it talks to.
 *
 *  2. **`subscribeConnectionStatus` replays the CURRENT status synchronously.**
 *     `waitForHostReconnect` subscribes and then waits for a "connected"
 *     report; on a live host that report arrives inside the subscribe call
 *     itself. Without the replay the helper waits for an EDGE that already
 *     happened, times out, and every safe host read after a WebView resume
 *     fails. The assertion below is written so that removing the replay — or
 *     deferring it to a microtask — turns this red with the reason named.
 */
import { afterEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import semver from "semver"
import { waitForHostReconnect, HOST_RECONNECT_WAIT_MS } from "../host/safe-call"
import { emitConnectionStatus, setTruApiClient, createFakeTruApiClient } from "@parity/product-sdk-host/testing"
import { subscribeConnectionStatus } from "@parity/product-sdk-host"

// the repo root: the workspace manifests and the hoisted node_modules live there
const ROOT = new URL("../../../../", import.meta.url)

afterEach(() => {
  // the seam is process-wide; leaving a fake client installed would reroute
  // every later host call in this worker
  setTruApiClient(null)
})

describe("the truapi the host package rides", () => {
  it("is the same truapi version the host package declares, so the app and its host half cannot drift apart", async () => {
    const host = JSON.parse(readFileSync(new URL("node_modules/@parity/product-sdk-host/package.json", ROOT), "utf8")) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const truapi = JSON.parse(readFileSync(new URL("node_modules/@parity/truapi/package.json", ROOT), "utf8")) as { version: string }
    // the host may declare truapi as any of the three; a peer range is as
    // load-bearing as a dependency one, and reading only `dependencies` used to
    // throw a TypeError on the `.replace` below
    const declared =
      host.dependencies?.["@parity/truapi"] ?? host.peerDependencies?.["@parity/truapi"] ?? host.optionalDependencies?.["@parity/truapi"]
    expect(
      declared,
      "product-sdk-host no longer declares @parity/truapi in any dependency field. The app and the worker share the " +
        "host's truapi; without the declaration there is nothing tying the two, and issue #94's split codecs can return.",
    ).toBeDefined()
    expect(
      semver.satisfies(truapi.version, declared!, { includePrerelease: true }),
      `product-sdk-host declares truapi "${declared}" but the tree resolves ${truapi.version}, which that range does not ` +
        `satisfy. A second truapi copy is how the worker and the app once ended up on different codecs (issue #94), and ` +
        `the codec moves with the version. Bump product-sdk-host and truapi in one change, then check ` +
        `\`npm ls @parity/truapi\` shows one copy.`,
    ).toBe(true)
  })
})

describe("subscribeConnectionStatus replays the current status synchronously", () => {
  it("reports the live status inside the subscribe call, not on a later tick", () => {
    // A live host: the injected client is connected by definition.
    setTruApiClient(createFakeTruApiClient())
    const seen: string[] = []
    const unsubscribe = subscribeConnectionStatus((status) => seen.push(status))
    unsubscribe()

    expect(
      seen,
      "subscribeConnectionStatus did NOT replay the current status synchronously. waitForHostReconnect (lib/host/safe-call.ts) " +
        "subscribes and then waits for 'connected'; on a live host it depends on that replay arriving inside the subscribe " +
        "call. Without it every safe host read after a WebView resume waits out HOST_RECONNECT_WAIT_MS and fails. " +
        "If the replay moved to a microtask, queueMicrotask(() => finish(true)) in waitForHostReconnect covers it — but " +
        "if the replay was removed, the recovery path is broken: restore it or rework waitForHostReconnect in the same change.",
    ).toEqual(["connected"])
  })

  it("replays 'disconnected' outside a host, so a subscriber is never left waiting for a first report", () => {
    const seen: string[] = []
    const unsubscribe = subscribeConnectionStatus((status) => seen.push(status))
    unsubscribe()
    expect(
      seen,
      "Outside a host the first status must still arrive synchronously. waitForHostReconnect's timeout is the fallback, " +
        "not the mechanism; a subscriber that gets nothing until an edge waits the full 2 s on every call.",
    ).toEqual(["disconnected"])
  })

  it("a host that is already connected reconnects in well under the wait bound (lane R H-R3)", () => {
    // The regression this pins: subscribing on a live host must not wait for a
    // connect EDGE that already happened.
    setTruApiClient(createFakeTruApiClient())
    const started = Date.now()
    return waitForHostReconnect({ subscribeConnectionStatus }, HOST_RECONNECT_WAIT_MS).then((connected) => {
      expect(
        connected,
        "waitForHostReconnect resolved false against a CONNECTED host. This is lane R's H-R3 refutation turning red: " +
          "the replay that makes it resolve true is gone, so the recovery path is dead on a live host.",
      ).toBe(true)
      expect(
        Date.now() - started,
        "waitForHostReconnect took the full timeout on a connected host. It resolved, but only because the fake host " +
          "emitted an edge; the synchronous replay is not doing its job.",
      ).toBeLessThan(HOST_RECONNECT_WAIT_MS / 4)
    })
  })

  it("still delivers real edges after the replay, and suppresses a repeat of the status it already sent", () => {
    setTruApiClient(createFakeTruApiClient())
    const seen: string[] = []
    const unsubscribe = subscribeConnectionStatus((status) => seen.push(status))
    emitConnectionStatus("connected") // repeat of the replayed status: suppressed
    emitConnectionStatus("disconnected")
    emitConnectionStatus("connecting")
    unsubscribe()
    emitConnectionStatus("connected") // after unsubscribe: not delivered
    expect(
      seen,
      "The status stream must be: the replayed status, then every CHANGE, with repeats suppressed and nothing after " +
        "unsubscribe. watchHostChannel counts a disconnect after a connect to decide on a reload; a duplicate or a " +
        "late report changes that decision.",
    ).toEqual(["connected", "disconnected", "connecting"])
  })
})