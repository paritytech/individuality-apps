// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { encodeGesture } from "./gesture"

const meshes = vi.hoisted(() => [] as Array<{ onData: (peerId: string, bytes: Uint8Array) => void }>)

vi.mock("./mesh", () => {
  function ownMemberOrNoop(target: object, key: string | symbol) {
    // A noop then would make the fake a thenable that never settles when awaited.
    if (key === "then") return undefined
    return key in target ? Reflect.get(target, key) : () => undefined
  }
  return {
    monoNow: () => performance.now(),
    Mesh: class {
      applyVideoRung = async () => {}
      // the roster effect reads both on a roster change
      setPeers = () => []
      links = () => new Map()
      constructor(...args: unknown[]) {
        meshes.push({ onData: args[6] as (peerId: string, bytes: Uint8Array) => void })
        return new Proxy(this, { get: (target, key) => ownMemberOrNoop(target, key) })
      }
    },
  }
})
vi.mock("./ice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ice")>()),
  fetchIceServers: async () => [],
  lateIceServers: async () => null,
}))
vi.mock("../camera", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../camera")>()),
  holdCamera: () => () => {},
  waitForCamera: async () => new EventTarget(),
}))

const { useMesh } = await import("./useMesh")

const transport = new Proxy({}, { get: (_, key) => (key === "then" ? undefined : () => undefined) })
const createTransport = () => transport as never
const peers = ["bob"]
const accept = encodeGesture({ tag: "Accept", roundIndex: 0, acceptorAccountId: new Uint8Array(32) })!

function mountMesh(gameTurn: number) {
  return renderHook(
    ({ gameTurn }) =>
      useMesh({ roomKey: "g7", selfId: "me", peers, createTransport, round: 0, gameIndex: 7, gameTurn }),
    { initialProps: { gameTurn } },
  )
}

afterEach(() => {
  cleanup()
  meshes.length = 0
})

describe("useMesh gestures", () => {
  it("stamps each gesture with the game turn this phone was on when it arrived", async () => {
    // Given
    const hook = mountMesh(1)
    await waitFor(() => expect(meshes).toHaveLength(1))

    // When
    act(() => meshes[0]!.onData("bob", accept))
    hook.rerender({ gameTurn: 2 })
    act(() => meshes[0]!.onData("bob", accept))

    // Then
    expect(hook.result.current.gestures).toEqual([
      { peerId: "bob", tag: "Accept", round: 0, turn: 1 },
      { peerId: "bob", tag: "Accept", round: 0, turn: 2 },
    ])
  })
})

describe("useMesh, the wire listens to the roster (#1959)", () => {
  function recordingTransport() {
    const opened: Array<{ room: string; peers?: string[] }> = []
    const setPeers = vi.fn<(peers: string[]) => void>()
    const wire = new Proxy({ setPeers }, {
      get: (target, key) => (key === "then" ? undefined : key in target ? Reflect.get(target, key) : () => undefined),
    })
    const create = (cfg: { room: string; peers?: string[] }) => {
      opened.push(cfg)
      return wire as never
    }
    return { opened, setPeers, create }
  }

  it("opens the wire with the round's group and the later rounds' co-players", async () => {
    // Given
    const { opened, create } = recordingTransport()

    // When
    renderHook(() =>
      useMesh({ roomKey: "g7", selfId: "me", peers: ["bob"], standby: ["cat", "dan"], createTransport: create, round: 0, gameIndex: 7, gameTurn: 1 }),
    )

    // Then
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(opened[0]).toMatchObject({ room: "g7", peers: ["bob", "cat", "dan"] })
  })

  it("names the roster to the open wire again when it changes", async () => {
    // Given
    const { opened, setPeers, create } = recordingTransport()
    const hook = renderHook(
      ({ standby }) => useMesh({ roomKey: "g7", selfId: "me", peers: ["bob"], standby, createTransport: create, round: 0, gameIndex: 7, gameTurn: 1 }),
      { initialProps: { standby: ["cat"] } },
    )
    await waitFor(() => expect(opened).toHaveLength(1))

    // When
    hook.rerender({ standby: ["cat", "eve"] })

    // Then
    expect(setPeers).toHaveBeenLastCalledWith(["bob", "cat", "eve"])
    expect(opened).toHaveLength(1)
  })
})
