// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The collectables screen for React: one host (./collectables-screen-host) for the page's
 * life, its view read with useSyncExternalStore, and what the shared hooks
 * know sent in: the chain-health card and the launch stall become one
 * `health` verdict.
 */
import { useEffect, useState, useSyncExternalStore } from "react"
import { useChainHealthCard } from "@/lib/use-chain-health-card"
import { useLaunchStall } from "@/lib/use-launch-stall"
import { useReconnectWindow } from "@/lib/use-reconnect-window"
import { useScene } from "@/lib/telemetry/use-scene"
import { browserCollectablesScreenDeps } from "./collectables-screen-deps"
import { createCollectablesScreenHost, type CollectablesScreenHost } from "./collectables-screen-host"
import type { CollectablesScreenView } from "./collectables-screen"

export interface CollectablesScreen {
  view: CollectablesScreenView
  send: CollectablesScreenHost["send"]
  /** the restart card's advice: reconnecting, rather than restart */
  reconnecting: boolean
  /** the album over the collectables screen */
  closing: { srcs: string[]; refusals: number } | null
}

export function useCollectablesScreen(): CollectablesScreen {
  const [host] = useState(() => createCollectablesScreenHost(browserCollectablesScreenDeps()))
  const view = useSyncExternalStore(host.subscribe, host.view, host.view)
  const source = useSyncExternalStore(host.subscribe, host.source, host.source)

  useEffect(() => {
    host.attach()
    return () => host.detach()
  }, [host])

  const { card, consecutiveLost, probe } = useChainHealthCard({
    source,
    waiting: false,
    phase: "post-game",
    registered: false,
    probeOnOpen: false,
  })
  // Arm the shared host proof while nothing has answered yet, rather than
  // adding its 45-second window after the read already exhausted.
  const stall = useLaunchStall({
    loading: host.waiting(),
    hasSource: source !== undefined && source !== null,
    probe,
    latch: true,
  })
  useEffect(() => {
    host.send({ type: "health", health: { lost: card.lost, reason: card.reason, stall } })
  }, [host, card.lost, card.reason, stall])

  const restart = view.kind === "restart"
  const reconnecting = useReconnectWindow({
    visible: restart,
    reason: restart ? view.reason : card.lost ? (card.reason ?? "chain-lost") : stall,
    consecutiveLost,
    healthy: card.answering === true,
    where: "open",
    since: card.lost ? card.reconnectingSince : undefined,
  })

  // the collectables screen's frame timing, for as long as it is on screen
  useScene("chest")
  return {
    view,
    send: host.send,
    reconnecting,
    closing: view.kind === "chest" ? view.closing : null,
  }
}
