// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/** Memory-only still candidates offered by the live remote-video observer.
 * There is no DOM sweep and no confirm-grid fallback: only a decoded peer
 * frame in the live grid can offer evidence. */
import { useCallback, useEffect, useRef, useState } from "react"
import type { PlayerId } from "./game-source"
import { devLog } from "./debug/log-store"
import {
  SNAPSHOT_MIN_SOURCE_EDGE,
  SNAPSHOT_SIZE,
  snapshotScore,
  type SnapshotRejectReason,
} from "./snapshot-quality"
import { SnapshotCandidateStore, type SnapshotCandidate } from "./snapshot-candidate-store"


export interface SnapshotCandidates {
  photoFor(id: PlayerId): string | undefined
  offer(id: PlayerId, video: HTMLVideoElement, hostGameplay: boolean, current?: () => boolean): void
  generation(): number
  frozen(): boolean
}

function reject(reason: SnapshotRejectReason): void {
  devLog("video-still", "candidate rejected", { reason })
}

async function captureCandidate(
  video: HTMLVideoElement,
  hostGameplay: boolean,
): Promise<SnapshotCandidate | { reason: SnapshotRejectReason }> {
  const width = video.videoWidth
  const height = video.videoHeight
  const side = Math.min(width, height)
  if (!side || video.readyState < 2) return { reason: "not-drawable" }
  if (side < SNAPSHOT_MIN_SOURCE_EDGE) return { reason: "source-too-small" }
  const sx = (width - side) / 2
  const sy = (height - side) / 2
  try {
    const canvas = document.createElement("canvas")
    canvas.width = SNAPSHOT_SIZE
    canvas.height = SNAPSHOT_SIZE
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (!context) return { reason: "canvas-unreadable" }
    context.drawImage(video, sx, sy, side, side, 0, 0, SNAPSHOT_SIZE, SNAPSHOT_SIZE)
    const quality = snapshotScore(
      width,
      height,
      context.getImageData(0, 0, SNAPSHOT_SIZE, SNAPSHOT_SIZE).data,
      hostGameplay,
    )
    if (!quality.ok) return quality
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.7))
    if (!blob) return { reason: "canvas-unreadable" }
    return { url: URL.createObjectURL(blob), score: quality.score }
  } catch {
    return { reason: "canvas-unreadable" }
  }
}

export function useSnapshots(freeze: boolean): SnapshotCandidates {
  const [, render] = useState(0)
  const candidatesRef = useRef(new SnapshotCandidateStore<PlayerId>())
  const busyRef = useRef(new Set<PlayerId>())

  // The first confirm render is the evidence boundary. An effect would leave
  // one paint where a late observer or canvas result could still commit.
  /* eslint-disable react-hooks/refs -- the evidence contract requires a synchronous render boundary */
  if (freeze) candidatesRef.current.freeze()
  /* eslint-enable react-hooks/refs */

  useEffect(
    () => () => {
      candidatesRef.current.dispose()
    },
    [],
  )

  const offer = useCallback((id: PlayerId, video: HTMLVideoElement, hostGameplay: boolean, current = () => true) => {
    if (!current() || candidatesRef.current.frozen() || busyRef.current.has(id)) return
    const generation = candidatesRef.current.generation()
    busyRef.current.add(id)
    void captureCandidate(video, hostGameplay)
      .then((candidate) => {
        if ("reason" in candidate) {
          reject(candidate.reason)
          return
        }
        if (!current()) {
          if (candidate.url.startsWith("blob:")) URL.revokeObjectURL(candidate.url)
          return
        }
        if (candidatesRef.current.offer(id, candidate, generation)) render((value) => value + 1)
      })
      .finally(() => busyRef.current.delete(id))
  }, [])

  return {
    photoFor: (id) => candidatesRef.current.photoFor(id),
    offer,
    generation: () => candidatesRef.current.generation(),
    frozen: () => candidatesRef.current.frozen(),
  }
}
