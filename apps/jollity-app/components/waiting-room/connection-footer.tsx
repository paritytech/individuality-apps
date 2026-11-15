// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * THE CONNECTION FOOTER: a headline and its line, one row of
 * connection dots, each round's group of co-players in turn, then the
 * indicators read almost as a sentence: Stream (your camera), Quality,
 * Network, Chain. Headline, dots and indicators sit 16 apart. The block is
 * FOOTER_H tall and holds its content to its foot, so a state without a line
 * grows down from the same headline space and the dots never move. The words
 * and readings are lib/waiting-room.ts `waitingFooter`, the dots `PeerDot`.
 */
import { Fragment, useEffect, useState, type ReactNode } from "react"
import {
  ArrowLeftRight,
  Cloud,
  Link,
  Loader2,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  SignalZero,
  Unlink,
  VideoOff,
  WifiOff,
  type LucideIcon,
} from "lucide-react"
import { StreamVideo } from "@/components/game/stream-video"
import { attachCameraPreview, type CameraState } from "@/lib/camera"
import type { NetworkIcon, QualityBars } from "@/lib/connection-status"
import { prefersReducedMotion } from "@/lib/reduced-motion"
import { dotRow, trackArrivals, type ChainIcon, type PeerDot, type WaitingFooter, type WaitingPeer } from "@/lib/waiting-room"
import { StatusLine } from "./status-line"

/** the design system's status colours */
const OK = "var(--success)"
const MID = "var(--warning)"
const BAD = "var(--destructive)"
const OFF = "color-mix(in srgb, var(--muted-foreground) 72%, transparent)"

const NETWORK: Record<NetworkIcon, { icon: LucideIcon; label: string; color: string; spin?: boolean }> = {
  checking: { icon: Loader2, label: "Checking", color: OFF, spin: true },
  direct: { icon: ArrowLeftRight, label: "Direct", color: OK },
  relay: { icon: Cloud, label: "Relay", color: MID },
  blocked: { icon: WifiOff, label: "Blocked", color: BAD },
}
const QUALITY: Record<QualityBars, { icon: LucideIcon; label: string; color: string }> = {
  4: { icon: Signal, label: "Great", color: OK },
  3: { icon: SignalHigh, label: "Good", color: OK },
  2: { icon: SignalMedium, label: "Fair", color: MID },
  1: { icon: SignalLow, label: "Poor", color: MID },
}
const NO_QUALITY = { icon: SignalZero, label: "Quality", color: OFF }
/** the bars, none to all four */
const BARS = [SignalZero, SignalLow, SignalMedium, SignalHigh, Signal]
const CHAIN: Record<ChainIcon, { icon: LucideIcon; color: string }> = {
  ok: { icon: Link, color: OK },
  connecting: { icon: Link, color: OFF },
  failing: { icon: Unlink, color: OFF },
}

/** how long Quality's bars take to climb to their first reading */
const CLIMB_MS = 300

const DOT = 11
const DOT_LABEL: Record<PeerDot, string> = {
  direct: "connected directly",
  turn: "connected via TURN",
  connecting: "not connected yet",
  "no-endpoint": "no endpoint",
}
/** the indicators' slot: the Stream circle's size, so every label sits on one line */
const SLOT = 32

/** the footer's height, all of it: the headline and its line (24 + 20), 16,
 *  the dots (11), 16, the indicators (2 over the 32 slot, 4, the 16 label) */
const FOOTER_H = 44 + 16 + DOT + 16 + 2 + SLOT + 4 + 16

const observeSelf = (video: HTMLVideoElement, stream: MediaStream) => attachCameraPreview(video, stream, "open")

export function ConnectionFooter({
  camera,
  footer,
  peers,
}: {
  camera: CameraState
  footer: WaitingFooter
  peers: readonly WaitingPeer[]
}) {
  // who came through, in order, so the dots run in arrival order
  const [arrivals, setArrivals] = useState<ReadonlyMap<string, number>>(() => trackArrivals(new Map(), peers))
  const nextArrivals = trackArrivals(arrivals, peers)
  if (nextArrivals !== arrivals) setArrivals(nextArrivals)
  const { dots, breaks } = dotRow(peers, nextArrivals)
  const quality = useQualityClimb(footer.quality)

  return (
    <div className="flex flex-col items-center justify-end gap-4" style={{ height: FOOTER_H }}>
      <StatusLine footer={footer} />
      <span
        role={dots.length > 0 ? "img" : undefined}
        aria-label={dots.length > 0 ? dots.map((peer) => DOT_LABEL[peer.dot]).join(", ") : undefined}
        className="flex min-h-[11px] flex-wrap items-center justify-center gap-1.5 px-6"
      >
        {dots.map((peer, index) => (
          <Fragment key={`${peer.round}:${peer.id}`}>
            {breaks.includes(index) ? <RoundSeparator /> : null}
            <Dot dot={peer.dot} />
          </Fragment>
        ))}
      </span>
      <span className="flex items-start gap-4 pt-0.5">
        <Stream camera={camera} />
        <Indicator {...quality} />
        <Indicator {...NETWORK[footer.network]} />
        <Indicator {...CHAIN[footer.chain]} label="Chain" />
      </span>
    </div>
  )
}

/**
 * Quality as it shows: its reading, or, for CLIMB_MS after the first one
 * comes in, the bars stepping up to it in green under the Quality label.
 */
function useQualityClimb(reading: QualityBars | null): { icon: LucideIcon; label: string; color: string } {
  const [seen, setSeen] = useState(reading)
  const [climb, setClimb] = useState<number | null>(null)
  if (reading !== seen) {
    setSeen(reading)
    setClimb(seen === null && reading !== null && reading > 1 && !prefersReducedMotion() ? 1 : null)
  }
  // one bar, then evenly up to the reading, landing on it CLIMB_MS on
  useEffect(() => {
    if (climb === null || reading === null) return
    const timer = setTimeout(() => setClimb(climb + 1 >= reading ? null : climb + 1), CLIMB_MS / (reading - 1))
    return () => clearTimeout(timer)
  }, [climb, reading])
  if (climb !== null) return { icon: BARS[climb] ?? SignalZero, label: NO_QUALITY.label, color: OK }
  return reading === null ? NO_QUALITY : QUALITY[reading]
}

/** one co-player's dot, in an 11 box whatever the state, so the row keeps its rhythm */
function Dot({ dot }: { dot: PeerDot }) {
  if (dot === "no-endpoint") {
    // two 7 px strokes, 1 wide, crossed at 45° in the box's middle
    return (
      <svg aria-hidden width={DOT} height={DOT} viewBox="0 0 11 11" className="block shrink-0">
        <path d="M3.03 3.03 7.97 7.97M7.97 3.03 3.03 7.97" fill="none" stroke="var(--muted-foreground)" strokeWidth={1} />
      </svg>
    )
  }
  return (
    <span
      aria-hidden
      className="size-[11px] shrink-0 rounded-full transition-[background-color,box-shadow] duration-300"
      style={
        dot === "connecting"
          ? // the ring, 1.5 inside the box, the same amber as the relay's dot
            { boxShadow: "inset 0 0 0 1.5px var(--warning)" }
          : { background: dot === "turn" ? "var(--warning)" : "var(--success)" }
      }
    />
  )
}

/** a line as tall as a dot between two rounds' co-players */
function RoundSeparator() {
  return <span aria-hidden className="h-[11px] w-px shrink-0 bg-input" />
}

/** an indicator: a 32 slot over its label, 4 apart, at least 56 wide; the icon 22 in it */
function Indicator({ icon: Icon, label, color, spin = false, children }: { icon?: LucideIcon; label: string; color: string; spin?: boolean; children?: ReactNode }) {
  return (
    <span className="flex min-w-14 flex-col items-center gap-1" style={{ color }}>
      <span className="grid size-8 place-items-center">
        {children ?? (Icon ? <Icon aria-hidden size={22} strokeWidth={1.75} className={spin ? "animate-spin motion-reduce:animate-none" : undefined} /> : null)}
      </span>
      <span className="text-xs leading-4 whitespace-nowrap text-muted-foreground">{label}</span>
    </span>
  )
}

/** Stream: your camera, mirrored, in the slot's 32 circle; off, a nested disc with the camera-off glyph */
function Stream({ camera }: { camera: CameraState }) {
  const stream = camera.kind === "live" ? camera.stream : null
  return (
    <Indicator label="Stream" color="var(--muted-foreground)">
      <span role="img" aria-label="Your camera" className="grid size-8 place-items-center overflow-hidden rounded-full bg-muted">
        {stream ? <StreamVideo stream={stream} mirrored onAttach={observeSelf} /> : <VideoOff aria-hidden size={16} strokeWidth={1.75} />}
      </span>
    </Indicator>
  )
}
