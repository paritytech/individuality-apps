// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * THE FINAL-MINUTE ART REGISTRY — swap the countdown art each week here.
 *
 * The waiting room renders ONE art module for the last dial turn. A module is any component that takes CountdownArtProps. The dial
 * is the default. To change the art week to week you have two levers:
 *
 *   · add a component module here and make it the default, or
 *   · leave the code alone and publish a manifest (lib/countdown-art.ts) that
 *     NAMES a registered module — `{ "module": "dial" }` — or ships a one-off
 *     image — `{ "svg": "…" }` / `{ "cid": "…" }` — with no redeploy.
 */
import type { FC } from "react"
import type { CountdownArtChoice } from "@/lib/countdown-art"
import { WaitingDial } from "./waiting-dial"

export interface CountdownArtProps {
  /** the dial's 00, unix seconds, in the frame of nowMs */
  endsAt: number
  nowMs: () => number
  windowSec: number
}
export type CountdownArt = FC<CountdownArtProps>

/** The registered modules. Add one and point the manifest (or DEFAULT_ART) at it. */
const COUNTDOWN_ART: Record<string, CountdownArt> = { dial: WaitingDial }
const DEFAULT_ART = "dial"

/**
 * Pick the art component for the final minute: a named module, else a remote
 * image wrapped as a module, else the default (the dial). Never null — the
 * final minute always has art.
 */
export function resolveCountdownArt(choice: CountdownArtChoice | null): CountdownArt {
  if (choice?.module && COUNTDOWN_ART[choice.module]) return COUNTDOWN_ART[choice.module]
  if (choice?.imageUrl) {
    const url = choice.imageUrl
    const ImageArt: CountdownArt = () => (
      // eslint-disable-next-line @next/next/no-img-element -- remote art blob/gateway
      <img src={url} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" />
    )
    ImageArt.displayName = "ImageArt"
    return ImageArt
  }
  return COUNTDOWN_ART[DEFAULT_ART]
}
