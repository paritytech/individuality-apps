// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE SPS TAP'S WORKER (#629). One per mesh; sps-tap.ts is the other end.
// Frames arrive two ways: an RTCRtpScriptTransform's `rtctransform` event
// (its options carry the link id), or encoded streams transferred in a
// "streams" message (the createEncodedStreams fallback). Either way
// sps-tap-core.ts runs the link: every frame passes, the first key frame is
// parsed, and the rest is piped natively. A "ping" is answered "ready", and
// the main thread attaches nothing before that answer.

import { runTap, type SpsTapResult, type TapFrame } from './sps-tap-core'

interface Transformer {
  readable: ReadableStream<TapFrame>
  writable: WritableStream<TapFrame>
  options?: { id?: number }
  sendKeyFrameRequest?: () => Promise<void>
}

interface Scope {
  onrtctransform: ((event: { transformer: Transformer }) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  postMessage(message: unknown): void
}

const scope = self as unknown as Scope

function run(id: number, readable: ReadableStream<TapFrame>, writable: WritableStream<TapFrame>, requestKeyFrame?: () => unknown): void {
  runTap({ readable, writable, now: () => performance.now(), requestKeyFrame })
    .then((result: SpsTapResult) => scope.postMessage({ kind: 'result', id, result }))
    .catch(() => {
      // getReader on a locked stream: nothing was read, nothing to report
    })
}

scope.onrtctransform = ({ transformer: t }) => {
  const ask = typeof t.sendKeyFrameRequest === 'function' ? () => t.sendKeyFrameRequest!() : undefined
  run(t.options?.id ?? -1, t.readable, t.writable, ask)
}

scope.onmessage = (event: MessageEvent) => {
  const message = event.data as { kind?: string; id?: number; readable?: ReadableStream<TapFrame>; writable?: WritableStream<TapFrame> }
  if (message?.kind === 'ping') scope.postMessage({ kind: 'ready' })
  else if (message?.kind === 'streams' && message.readable && message.writable) run(message.id ?? -1, message.readable, message.writable)
}
