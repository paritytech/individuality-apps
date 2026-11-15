// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import { useEffect, useRef, type CSSProperties } from "react"
import { observeCameraFrames } from "@/lib/camera-frame"
import { playVideo, releaseVideo } from "@/lib/video-playback"

type Media = { stream: MediaStream; src?: never } | { src: string; stream?: never }

/** A source URL is evidence only after this element presents a frame. */
export function observeFirstPresentedFrame(video: HTMLVideoElement, onFirstFrame: (video: HTMLVideoElement) => void) {
  return observeCameraFrames(video, {
    onFirstFrame: () => onFirstFrame(video),
    onTimeout: () => {},
  })
}

/**
 * Every live <video> in the game. A tile is never pausable: this element sets
 * every inline-playback guard itself, starts playback through playVideo and
 * restarts it when it stops. It carries no autoplay attribute, because iOS Low
 * Power Mode forces native controls onto an autoplay video. A play the phone
 * refuses hides the element until the next tap (lib/video-playback).
 */
export function StreamVideo({
  stream,
  src,
  mirrored,
  poster,
  style,
  onAttach,
  onFirstFrame,
}: Media & {
  mirrored?: boolean
  poster?: string
  style?: CSSProperties
  onAttach?: (video: HTMLVideoElement, stream: MediaStream) => void | (() => void)
  onFirstFrame?: (video: HTMLVideoElement) => void
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // React never writes the muted attribute, and iOS lets play() start inline only on a muted video
    el.muted = true
    el.playsInline = true
    el.setAttribute("playsinline", "")
    el.setAttribute("webkit-playsinline", "")
    const detach = stream && onAttach ? onAttach(el, stream) : undefined
    if (!(stream && onAttach)) {
      if (stream) el.srcObject = stream
      else if (src) el.src = src
      playVideo(el)
    }
    const observer = onFirstFrame ? observeFirstPresentedFrame(el, onFirstFrame) : undefined
    return () => {
      observer?.stop()
      detach?.()
    }
  }, [stream, src, onAttach, onFirstFrame])
  // the element is gone: so is any retry waiting on a tap
  useEffect(() => {
    const el = ref.current
    return () => {
      if (el) releaseVideo(el)
    }
  }, [])
  const resume = (v: HTMLVideoElement) => playVideo(v)
  return (
    <video
      ref={ref}
      playsInline
      muted
      // a clip loops. A stream never ends.
      loop={src !== undefined}
      controls={false}
      disablePictureInPicture
      controlsList="nodownload nofullscreen noremoteplayback"
      tabIndex={-1}
      // shown before the first frame, and while the phone refuses play()
      poster={poster}
      onPause={(e) => resume(e.currentTarget)}
      onLoadedMetadata={(e) => resume(e.currentTarget)}
      className={"pointer-events-none h-full w-full object-cover" + (mirrored ? " -scale-x-100" : "")}
      style={style}
    />
  )
}
