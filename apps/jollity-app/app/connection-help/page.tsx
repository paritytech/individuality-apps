// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * Where the game sends you when it can't connect you to ANYONE.
 *
 * It renders the health ladder's last verdict through the same component the
 * in-game "What's wrong?" button opens, so the two surfaces cannot tell
 * different stories, and a refused statement store and dead Wi-Fi get
 * different advice. The network advice ("check your internet", "move closer to
 * your router") is shown only to the players it applies to, as `ice` in
 * lib/health/copy.ts.
 *
 * This is a ROUTE, so the mesh is torn down before it mounts and there is no
 * live verdict to read; `getHealthSnapshot()` keeps the last one from the room
 * that just closed, which is the reading that explains why the player is here.
 */
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { HealthDetails } from "@/components/health/health-details"
import { getHealthSnapshot, subscribeHealth } from "@/lib/health/snapshot"
import type { LadderVerdict } from "@jollity/statement-core"
import { deviceNowMs } from "@/lib/device-clock" // the mesh stamps the snapshot on it (#331)
import { getGameSource } from "@/lib/game-source"
import { resolvePostGameHandoff, tapDestination, waitForPostGameHandoff } from "@/lib/post-game-handoff"
import { devLog } from "@/lib/debug/log-store"

/** Past this, the last reading describes a different session and is no longer
 *  evidence about the one that just failed — better to say nothing than to
 *  name a cause from a game two rooms ago. */
const STALE_AFTER_MS = 120_000

export default function ConnectionHelpPage() {
  const router = useRouter()
  const [verdict, setVerdict] = useState<LadderVerdict | null>(null)
  const [checking, setChecking] = useState(false)
  const handedOff = useRef(false)

  const handoff = (next: Awaited<ReturnType<typeof resolvePostGameHandoff>>) => {
    if (!next || handedOff.current) return false
    handedOff.current = true
    devLog("game", "connection-help post-game handoff", {
      from: "/connection-help",
      to: next.href,
      game: next.gameIndex,
      reportStatus: next.report,
    })
    router.replace(next.href)
    return true
  }

  useEffect(() => {
    const read = () => {
      const snapshot = getHealthSnapshot()
      setVerdict(snapshot && deviceNowMs() - snapshot.at < STALE_AFTER_MS ? snapshot.verdict : null)
    }
    read()
    return subscribeHealth(read)
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    void getGameSource().then(async (source) => {
      if (!source || abort.signal.aborted) return
      handoff(await waitForPostGameHandoff(source, { signal: abort.signal }))
    })
    return () => abort.abort()
  // handoff reads only stable router/ref values; a render must not restart the poll.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

  const tryAgain = async () => {
    if (checking || handedOff.current) return
    setChecking(true)
    try {
      // the watcher can hand off while this read is in flight, so the ref is
      // checked AGAIN inside, after the await (H-P3): a tap that loses the race
      // must not put /game after the collectables screen the watcher already opened.
      const next = await tapDestination(await getGameSource(), () => handedOff.current)
      if (!next) return
      if (next === "/game") {
        router.replace(next)
        return
      }
      handoff(next)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-1 flex-col pt-6">
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="text-xs font-semibold tracking-[0.08em] uppercase text-muted-foreground">
          Connection trouble
        </div>
        <HealthDetails verdict={verdict} />
      </main>
      <footer className="flex flex-col items-center px-4 pt-3 pb-6">
        <Button size="lg" className="w-full max-w-sm" disabled={checking} onClick={() => void tryAgain()}>
          Try again
        </Button>
      </footer>
    </div>
  )
}
