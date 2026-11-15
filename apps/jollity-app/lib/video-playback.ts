// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A GAME VIDEO THE PHONE REFUSES TO PLAY, and the native controls that come
 * with it.
 *
 * In Low Power Mode, WebKit forces its media controls onto every video with
 * the `autoplay` attribute, so game videos carry none and start through
 * playVideo. This module hides a video whose play() the phone still refuses:
 * WebKit then draws its own play button over the paused element. Its newer
 * media controls do not answer the ::-webkit-media-controls rules in
 * app/globals.css, so CSS alone does not hide them. A refused element is
 * therefore marked `data-playback-refused`, which globals.css hides with
 * everything WebKit drew on it, and every refused element is tried again on
 * the next tap anywhere on the page: a gesture is what WebKit lets play()
 * through on, and every turn of the game asks for taps. The tile under it
 * (its photo, its static) shows meanwhile.
 *
 * Framework-free: StreamVideo and the tile's own video both call it.
 */
import { devLog } from "./debug/log-store"
import { recordCount } from "./telemetry"

const REFUSED = "data-playback-refused"
/** the gestures WebKit lets a play() through on */
const GESTURES = ["touchend", "click"] as const

const refused = new Set<HTMLVideoElement>()
/** elements whose `playing` event already shows them again */
const watched = new WeakSet<HTMLVideoElement>()
let gestureDoc: Document | null = null

const hasSource = (el: HTMLVideoElement): boolean => Boolean(el.srcObject || el.currentSrc || el.getAttribute("src"))

function showAgain(el: HTMLVideoElement): void {
  refused.delete(el)
  el.removeAttribute(REFUSED)
  if (refused.size === 0) stopListening()
}

function onRefused(el: HTMLVideoElement, error: unknown, doc: Document | undefined): void {
  // an AbortError is a new source replacing the old one: not a refusal
  if ((error as { name?: unknown } | null)?.name !== "NotAllowedError") return
  // playing after all (another play() call won the race): nothing to hide
  if (!el.paused) {
    showAgain(el)
    return
  }
  if (!refused.has(el)) {
    refused.add(el)
    recordCount("video.play_refused", 1, {})
    devLog("video", "play refused, hidden until the next tap", {})
  }
  el.setAttribute(REFUSED, "")
  if (doc) listen(doc)
}

/** Play `el` if it is paused on a source; a refusal hides it until a tap. */
export function playVideo(el: HTMLVideoElement, doc: Document | undefined = globalThis.document): void {
  // however it starts playing (a tap, another play() call), it shows again
  if (!watched.has(el)) {
    watched.add(el)
    el.addEventListener("playing", () => showAgain(el))
  }
  if (!el.paused || el.ended || !hasSource(el)) return
  let playing: Promise<void>
  try {
    playing = el.play()
  } catch (error) {
    onRefused(el, error, doc)
    return
  }
  void playing.then(
    () => showAgain(el),
    (error: unknown) => onRefused(el, error, doc),
  )
}

/** The element is gone (its tile unmounted): stop retrying it. */
export function releaseVideo(el: HTMLVideoElement): void {
  showAgain(el)
}

function retryRefused(): void {
  for (const el of [...refused]) {
    if (!el.isConnected) {
      showAgain(el)
      continue
    }
    playVideo(el, gestureDoc ?? undefined)
  }
}

function listen(doc: Document): void {
  if (gestureDoc) return
  gestureDoc = doc
  for (const type of GESTURES) doc.addEventListener(type, retryRefused, { capture: true, passive: true })
}

function stopListening(): void {
  if (!gestureDoc) return
  for (const type of GESTURES) gestureDoc.removeEventListener(type, retryRefused, { capture: true })
  gestureDoc = null
}

/** tests only: forget every refused element and listener */
export function resetVideoPlaybackForTests(): void {
  refused.clear()
  stopListening()
}
