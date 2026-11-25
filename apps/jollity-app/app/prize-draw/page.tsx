// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The prize draw — THE WHEEL (the draw scene in lib/draw/wheel), driven by
 * REAL CHAIN DATA read from pallet `airdrop`.
 *
 * This page only renders. What it shows, and when it lets go, is the draw
 * screen's reducer (lib/draw/draw-screen), run by its host
 * (lib/draw/draw-screen-host) through usePrizeDraw: the read, the rule check
 * that decides between the wheel and the words, the stage, the claim of a won
 * prize, the idle, the payoff's way to the chest and the debug log.
 */
import { useEffect, useState } from "react"
import { WheelStage } from "@/components/draw/wheel-stage"
import { HoldToChest } from "@/components/draw/hold-to-chest"
import { autoBackToWheel } from "@/lib/draw/hold/scene"
import { MessageScreen } from "@/components/ui/screen"
import { PrizeText } from "@/components/prize-text"
import { Button } from "@/components/ui/button"
import { usePrizeDraw } from "@/lib/draw/use-prize-draw"
import { drawIntro, drawMissReason, drawResultLine } from "@/lib/draw/draw-miss"

export default function PrizeDrawPage() {
  const { view, host } = usePrizeDraw()
  // the stage's own element, for the hold to read and move
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  // a win goes back to the wheel by itself, whatever the way on
  useEffect(() => (stage ? autoBackToWheel(stage) : undefined), [stage])
  const bypass = () => host.send({ type: "bypass" })
  const next = () => host.send({ type: "continue" })

  switch (view.kind) {
    // still loading, and nothing true to say yet: the wheel's own black; or
    // no draw, the route held inert while the chest replaces it
    case "blank":
      return <div className="fixed inset-0 bg-black" aria-busy="true" aria-label={view.label} />
    case "message":
      return (
        <MessageScreen
          eyebrow="Prize draw"
          heading={MESSAGES[view.message].heading}
          body={MESSAGES[view.message].body}
          action={<ContinueButton onClick={bypass} />}
        />
      )
    case "words": {
      // the chain's result in words, where the wheel cannot tell it
      const { heading, body } = drawResultLine(view.draw, view.draw.userTicket ? null : drawMissReason(view.miss))
      return (
        <MessageScreen
          eyebrow="Prize draw"
          heading={heading}
          body={body ? <PrizeText text={body} /> : null}
          action={<ContinueButton onClick={next} />}
        />
      )
    }
    case "wheel":
      // not in the draw: they still watch it, told first what the draw is (the
      // intro); why they are not in it only where the stage fails (the words)
      // the way on is a hold, not the stage's Continue (components/draw/hold-to-chest);
      // a stage that failed keeps the page's own Continue
      return (
        <>
          <WheelStage
            stageRef={host.stageElement}
            hostRef={setStage}
            hold={!view.fallback}
            intro={view.intro ? { ...drawIntro(view.draw), leaving: view.intro === "leaving" } : null}
            fallback={view.fallback ? drawResultLine(view.draw, view.draw.userTicket ? null : drawMissReason(view.miss)) : null}
            onContinue={next}
          />
          {view.fallback ? null : <HoldToChest stage={stage} offered={view.offered} onContinue={next} />}
        </>
      )
  }
}

/** the screens with nothing of the draw to show yet, each with Continue on to the chest */
const MESSAGES = {
  waiting: { heading: "Drawing the winners…", body: undefined },
  // the draw is not marked seen on the way past, so the chat keeps offering it
  failed: { heading: "Couldn't load the draw", body: "You can open it later from the Jollity chat." },
  "no-identity": {
    heading: "Player identity needed",
    body: "No player identity here — open Jollity in the Polkadot app to see your draw.",
  },
} as const

function ContinueButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="lg" className="w-full" onClick={onClick}>
      Continue
    </Button>
  )
}
