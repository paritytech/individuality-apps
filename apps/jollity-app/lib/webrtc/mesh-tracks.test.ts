// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A lane offer applied before our tracks are on (#544). setRemoteDescription
 * of an offer with video makes a video transceiver whose sender holds no
 * track, so a guard on "any sender" took that as our tracks already added:
 * the answer went out with no video of ours and with the browser's default
 * codecs, RTX included (#497).
 *
 * The fake below models the transceiver rules the mesh relies on, as the
 * WebRTC spec writes them and Chrome does them: a remote offer's m-section
 * makes a recvonly transceiver; addTrack reuses a transceiver of the same
 * kind whose sender has no track and has never sent, turning it sendrecv; an
 * answer writes, per m-section, the direction, our SSRC when a track is on,
 * and RTX unless codec preferences without it were set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  decodeChannelMessage,
  decodePeerConnectionSignal,
  encodeChannelMessage,
  encodePeerConnectionSignal,
  USE_CASE_RENEGOTIATION,
} from "@jollity/statement-core"
import { FakeChannel, FakePC, sdp, setupMesh } from "./test-pc"

const codec = (mimeType: string, sdpFmtpLine?: string): RTCRtpCodec => ({ mimeType, clockRate: 90000, ...(sdpFmtpLine ? { sdpFmtpLine } : {}) })
const CODECS = [codec("video/VP8"), codec("video/rtx", "apt=96")]

interface Transceiver {
  kind: string
  sender: { track: MediaStreamTrack | null; getParameters: () => RTCRtpSendParameters; setParameters: () => Promise<void> }
  direction: RTCRtpTransceiverDirection
  sent: boolean
  prefs: RTCRtpCodec[] | null
  setCodecPreferences: (codecs: RTCRtpCodec[]) => void
}

/** Give a FakePC the transceiver rules above; returns its transceivers. */
function withTransceivers(pc: FakePC) {
  const transceivers: Transceiver[] = []
  const make = (kind: string, direction: RTCRtpTransceiverDirection): Transceiver => {
    const t: Transceiver = {
      kind,
      sender: { track: null, getParameters: () => ({ encodings: [] }) as unknown as RTCRtpSendParameters, setParameters: async () => {} },
      direction,
      sent: false,
      prefs: null,
      setCodecPreferences: (codecs) => (t.prefs = codecs),
    }
    transceivers.push(t)
    return t
  }
  const setRemote = pc.setRemoteDescription.bind(pc)
  const setLocal = pc.setLocalDescription.bind(pc)
  Object.assign(pc, {
    getSenders: () => transceivers.map((t) => t.sender),
    getTransceivers: () => transceivers,
    addTrack: (track: MediaStreamTrack) => {
      const reused = transceivers.find((t) => t.kind === track.kind && !t.sender.track && !t.sent)
      const t = reused ?? make(track.kind, "sendrecv")
      t.sender.track = track
      if (reused) t.direction = "sendrecv"
      return t.sender
    },
    setRemoteDescription: async (desc: { type: string; sdp?: string }) => {
      await setRemote(desc)
      if (desc.type !== "offer") return
      const kinds = (desc.sdp ?? "").split(/\r?\n/).filter((l) => l.startsWith("m=") && !l.startsWith("m=application")).map((l) => l.slice(2).split(" ")[0]!)
      kinds.forEach((kind, i) => transceivers[i] ?? make(kind, "recvonly"))
    },
    setLocalDescription: async () => {
      await setLocal()
      const media = transceivers.map((t, i) => {
        if (t.sender.track) t.sent = true
        const rtx = !t.prefs || t.prefs.some((c) => c.mimeType === "video/rtx")
        return [
          `m=${t.kind} 9 UDP/TLS/RTP/SAVPF 96${rtx ? " 97" : ""}`,
          `a=mid:${i + 1}`,
          `a=${t.direction}`,
          "a=rtpmap:96 VP8/90000",
          ...(rtx ? ["a=rtpmap:97 rtx/90000", "a=fmtp:97 apt=96"] : []),
          ...(t.sender.track ? [`a=ssrc:${1000 + i} cname:me`] : []),
          ...(t.sender.track && rtx ? [`a=ssrc-group:FID ${1000 + i} ${2000 + i}`] : []),
        ].join("\r\n")
      })
      pc.localDescription = { type: pc.localDescription!.type, sdp: [sdp("999"), ...media].join("\r\n") }
    },
  })
  return transceivers
}

function camera() {
  const track = { kind: "video", id: "cam" } as MediaStreamTrack
  return { getVideoTracks: () => [track], getTracks: () => [track] }
}

/** the lane answers this side wrote on `channel`, as SDP */
function laneAnswers(channel: FakeChannel): string[] {
  return channel.send.mock.calls.flatMap(([bytes]) => {
    try {
      const frame = decodeChannelMessage(bytes as Uint8Array)
      if (frame.id !== USE_CASE_RENEGOTIATION) return []
      const signal = decodePeerConnectionSignal(frame.data)
      return signal.tag === "Answer" ? [signal.value] : []
    } catch {
      return []
    }
  })
}

describe("our tracks when a lane offer lands first (#544)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => ({ codecs: CODECS, headerExtensions: [] }) })
    vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: CODECS, headerExtensions: [] }) })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("puts our video on the offer's transceiver and answers sendrecv, with no RTX", async () => {
    // "b" answers: it adopts the offerer's channel while it is still
    // connecting, and the lane offer is read before our open handler runs
    const { mesh, pc } = await setupMesh("b", "a", {}, camera())
    const transceivers = withTransceivers(pc)
    const channel = new FakeChannel()
    pc.channels.push(channel)
    ;(pc.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel })
    channel.readyState = "open"

    const offer = sdp("111", { media: ["video"] }).replace("UDP/TLS/RTP/SAVPF 96", "UDP/TLS/RTP/SAVPF 96 97") + "a=rtpmap:97 rtx/90000\r\n"
    const frame = encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal({ tag: "Offer", value: offer }) })
    ;(channel.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
    await vi.waitFor(() => expect(laneAnswers(channel)).toHaveLength(1))

    expect(transceivers).toHaveLength(1) // reused, not a second m-section
    expect(transceivers[0]!.sender.track?.kind).toBe("video")
    const answer = laneAnswers(channel)[0]!
    expect(answer).toMatch(/a=sendrecv/)
    expect(answer).toMatch(/a=ssrc:\d+ cname/)
    expect(answer).not.toMatch(/rtx\/90000/)
    expect(answer).not.toMatch(/ssrc-group:FID/)
    mesh.close()
  })

  it("does not add the camera twice once a sender holds it", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    const transceivers = withTransceivers(pc)
    pc.channels[0]!.readyState = "open"
    ;(pc.channels[0]!.onopen as () => void)()
    ;(pc.channels[0]!.onopen as () => void)()
    expect(transceivers).toHaveLength(1)
    mesh.close()
  })
})
