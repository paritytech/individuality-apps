// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The SPS tap's hook (#629): the mesh hands a link's first video receiver to
 * `tapVideo` inside ontrack, once per connection, and a tap that throws
 * never costs the link its stream.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { FakePC, setupMesh } from "./test-pc"

const track = (kind: string) => ({ kind, addEventListener: () => {} })
const receiver = (name: string) => ({ name }) as unknown as RTCRtpReceiver

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the mesh's tapVideo hook", () => {
  it("hands over the first video receiver of a connection, once, and never an audio one", async () => {
    const tapped: Array<[string, RTCRtpReceiver]> = []
    const { mesh, pc } = await setupMesh("a", "b", { tapVideo: (peer, r) => tapped.push([peer, r]) })
    const stream = {} as MediaStream
    pc.ontrack!({ track: track("audio"), streams: [stream], receiver: receiver("audio") })
    pc.ontrack!({ track: track("video"), streams: [stream], receiver: receiver("first") })
    pc.ontrack!({ track: track("video"), streams: [stream], receiver: receiver("second") })
    expect(tapped).toEqual([["b", receiver("first")]])
    mesh.close()
  })

  it("taps a rebuilt connection afresh: a new link", async () => {
    const tapped: string[] = []
    const { mesh, pc } = await setupMesh("a", "b", { tapVideo: (_peer, r) => tapped.push((r as unknown as { name: string }).name) })
    pc.ontrack!({ track: track("video"), streams: [], receiver: receiver("old") })
    mesh.removePeer("b")
    mesh.addPeer("b")
    const fresh = FakePC.last.at(-1)!
    fresh.ontrack!({ track: track("video"), streams: [], receiver: receiver("new") })
    expect(tapped).toEqual(["old", "new"])
    mesh.close()
  })

  it("still delivers the stream when the tap throws", async () => {
    const streams: MediaStream[] = []
    const { mesh, pc } = await setupMesh(
      "a",
      "b",
      {
        tapVideo: () => {
          throw new Error("tap failed")
        },
      },
      undefined,
      (_peer, s) => streams.push(s),
    )
    const stream = {} as MediaStream
    pc.ontrack!({ track: track("video"), streams: [stream], receiver: receiver("r") })
    expect(streams).toEqual([stream])
    mesh.close()
  })
})
