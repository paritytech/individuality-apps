// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { attachCameraPreview } from "@/lib/camera"
import { observeCameraFrames } from "@/lib/camera-frame"
import {
  remoteObservationAllowed,
  RemoteAttachmentGeneration,
  type RemoteVideoObservation,
} from "@/lib/peer-video-observation"
import { playVideo, releaseVideo } from "@/lib/video-playback"

/** the element, with every guard set and no autoplay attribute; a pause is answered
 *  with play, and a play the phone refuses hides it until the next tap (lib/video-playback) */
function makeVideo(): HTMLVideoElement {
  const el = document.createElement("video")
  el.muted = true
  el.playsInline = true
  el.controls = false
  el.disablePictureInPicture = true
  el.tabIndex = -1
  el.setAttribute("muted", "")
  el.setAttribute("playsinline", "")
  el.setAttribute("webkit-playsinline", "")
  el.setAttribute("controlslist", "nodownload nofullscreen noremoteplayback")
  el.setAttribute("aria-hidden", "true")
  const resume = () => playVideo(el)
  el.addEventListener("pause", resume)
  el.addEventListener("loadedmetadata", resume)
  return el
}

/** the tile's video, made on first use. Read it only in effects. */
export type TileVideo = () => HTMLVideoElement

/** a new feed whose video never arrives is switched to after this long anyway,
 *  so a tile is never held on a dead feed by a track that never unmutes */
const SWITCH_WAIT_MS = 4000

/**
 * The tile's ONE `<video>`, made outside React's tree and moved into the
 * showing face's slot at the turn's edge-on (a move in one task keeps it
 * playing), so no hidden copy decodes behind the other face. It keeps
 * StreamVideo's inline-playback guards: a pause is answered with play.
 *
 * A NEW FEED FOR A FACE ALREADY SHOWING — a link rebuilt after a drop — does
 * not blank the face while the new link warms up: the element keeps the old
 * feed, which holds its last frame once its link is gone, until the new feed's
 * video arrives (its track unmutes on the first packets), and only then
 * switches. Still the one element: whatever watches it for frames sees the new
 * feed's from the moment there are any.
 */
export function useTileVideo(
  stream: MediaStream | null,
  mirrored: boolean | undefined,
  poster: string | undefined,
  ownCamera = false,
  observeRemote?: RemoteVideoObservation,
): TileVideo {
  const ref = useRef<HTMLVideoElement | null>(null)
  const observationRef = useRef(observeRemote)
  const attachmentRef = useRef(new RemoteAttachmentGeneration())
  const [shownStream, setShownStream] = useState<MediaStream | null>(null)
  useEffect(() => {
    observationRef.current = observeRemote
  }, [observeRemote])
  const get = useCallback(() => (ref.current ??= makeVideo()), [])
  useEffect(() => {
    const el = get()
    // your own camera: the app's one camera, kept attached and watched (lib/camera)
    if (stream && ownCamera) return attachCameraPreview(el, stream, "join")
    const show = () => {
      if (el.srcObject !== stream) el.srcObject = stream
      // Observation belongs to what this one element actually shows, not the
      // pending stream prop. While a replacement warms up, callbacks still
      // belong to the retained old feed and must not consume the new
      // attachment's one-shot first-frame evidence.
      setShownStream(stream)
      if (stream) playVideo(el)
    }
    const incoming = stream?.getVideoTracks()[0]
    // nothing on the face to keep, or a feed whose video is already here: now
    if (!incoming || !incoming.muted || !el.srcObject || el.srcObject === stream || el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      show()
      return
    }
    let waiting = true
    const stop = () => {
      waiting = false
      clearTimeout(timer)
      incoming.removeEventListener("unmute", arrived)
    }
    const arrived = () => {
      if (!waiting) return
      stop()
      show()
    }
    incoming.addEventListener("unmute", arrived)
    const timer = setTimeout(arrived, SWITCH_WAIT_MS)
    // a newer feed, or the tile gone, before this one's video came
    return stop
  }, [get, stream, ownCamera])
  const observationKey = observeRemote?.key
  const observationGeneration = observeRemote?.generation
  useEffect(() => {
    if (!stream || shownStream !== stream || ownCamera || !observationKey || observationGeneration === undefined) return
    const el = get()
    const lifecycle = attachmentRef.current
    const attachment = lifecycle.attach()
    const allowed = () =>
      attachment.current() && remoteObservationAllowed(el, stream, observationKey, observationGeneration, observationRef.current)
    const watcher = observeCameraFrames(el, {
      onFirstFrame: () => {
        if (allowed()) observationRef.current?.onFirstFrame(el, allowed)
      },
      onWindow: () => {
        if (allowed()) observationRef.current?.onWindow(el, allowed)
      },
      // Peer timeout is intentionally inert. Own-camera recovery stays owned
      // by attachCameraPreview and the camera diagnostics pipeline.
      onTimeout: () => {},
    })
    return () => {
      lifecycle.invalidate()
      watcher.stop()
    }
  }, [get, stream, shownStream, ownCamera, observationKey, observationGeneration])
  useEffect(() => {
    const el = get()
    el.className = "pointer-events-none h-full w-full object-cover" + (mirrored ? " -scale-x-100" : "")
    if (poster) el.poster = poster
    else el.removeAttribute("poster")
  }, [get, mirrored, poster])
  // the tile is gone: so is its feed
  useEffect(
    () => () => {
      attachmentRef.current?.invalidate()
      const el = ref.current
      if (!el) return
      releaseVideo(el)
      el.srcObject = null
      el.remove()
    },
    [],
  )
  return get
}

/** where a face shows the tile's video: the element moves in when this face is the one showing */
export function VideoSlot({ video, active, hidden = false }: { video: TileVideo; active: boolean; hidden?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const slot = ref.current
    const el = video()
    if (active && slot && el.parentElement !== slot) slot.appendChild(el)
  }, [active, video])
  // hidden: the feed stays in this slot, playing, but is not drawn
  return <div ref={ref} aria-hidden className="absolute inset-0" style={hidden ? { visibility: "hidden" } : undefined} />
}
