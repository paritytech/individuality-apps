// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * NUX — the first-run intro: a 5-slide carousel, navigated by SWIPING
 * (scroll-snap) instead of a Next button. The last slide's "Get started"
 * goes to the permission gate (/permissions).
 */
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { asset } from "@/lib/asset"

type Fact = { t: string; s: string }
type Step =
  | { kind: "illus"; img: string; eyebrow?: string; stepno?: number; title: string; body: string }
  | { kind: "facts"; title: string; facts: Fact[] }

// the slides, in order
const STEPS: Step[] = [
  {
    kind: "illus",
    img: "/chat-intro/cash.png",
    eyebrow: "Weekly Game",
    title: "Win cash prizes",
    body: "Play a free, fun, two-minute game — and earn your Polkadot Membership while you're at it.",
  },
  {
    kind: "illus",
    img: "/how-to-play/intro-why.png",
    eyebrow: "Proof of personhood",
    title: "A game for real humans",
    body: "Why gestures? It's very difficult for bots to convincingly copy them live. Playing helps everyone know who the real humans are.",
  },
  {
    kind: "illus",
    img: "/chat-intro/host-you.png",
    stepno: 1,
    title: "Copy the gesture",
    body: "A rotating host makes a hand gesture on camera. Mimic it live before the timer runs out.",
  },
  {
    kind: "illus",
    img: "/how-to-play/intro-tap.png",
    stepno: 2,
    title: "Tap the humans",
    body: "Accept the other players who also copied. Leave out anything that looks like AI — that's how humans verify humans.",
  },
  {
    kind: "facts",
    title: "Good to know",
    facts: [
      { t: "A short game", s: "Lasts ~2–5 min · groups of ≤6" },
      { t: "Become a Peer in 6 games", s: "Play 6 in a row for full status" },
      { t: "Attendance matters", s: "Missing a game pauses your status" },
    ],
  },
]

function StepDots({ n, at, goTo }: { n: number; at: number; goTo: (i: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: n }, (_, i) => (
        <button
          key={i}
          aria-label={`Slide ${i + 1}`}
          onClick={() => goTo(i)}
          className={
            "h-2 w-[22px] rounded-full transition-[background-color] duration-250 " +
            (i === at ? "bg-primary" : i < at ? "bg-muted" : "bg-secondary")
          }
        />
      ))}
    </div>
  )
}

function StepBody({ step }: { step: Step }) {
  if (step.kind === "facts") {
    return (
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-8 text-left">
        <div className="text-xs font-semibold tracking-[0.08em] uppercase text-muted-foreground">
          {step.title}
        </div>
        {step.facts.map((fact) => (
          <div key={fact.t} className="flex flex-col gap-1">
            <h2 className="text-xl leading-7 font-bold">{fact.t}</h2>
            <p className="m-0 text-base leading-6 text-muted-foreground">{fact.s}</p>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3.5 text-center">
      {/* app container: surface-container + 1px stroke-primary, radius 16 */}
      <div className="aspect-[3/2] w-full max-w-[320px] overflow-hidden rounded-xl border bg-card">
        {/* eslint-disable-next-line @next/next/no-img-element -- static export, local asset */}
        <img src={asset(step.img)} alt="" className="block h-full w-full object-cover" />
      </div>

      {step.eyebrow ? (
        <div className="text-xs font-semibold tracking-[0.08em] uppercase text-muted-foreground">
          {step.eyebrow}
        </div>
      ) : null}
      {step.stepno !== undefined ? (
        <div className="flex items-center gap-2">
          <span className="grid size-7 flex-none place-items-center rounded-lg bg-primary text-base font-semibold text-primary-foreground">
            {step.stepno}
          </span>
          <h1 className="text-[28px] leading-9 font-bold">{step.title}</h1>
        </div>
      ) : (
        <h1 className="text-[28px] leading-9 font-bold">{step.title}</h1>
      )}

      <p className="m-0 max-w-[38ch] text-base leading-6 text-muted-foreground">{step.body}</p>
    </div>
  )
}

export default function NuxPage() {
  const router = useRouter()
  // arriving via the worker's DEEP LINK leaves the fallback flag set — clear
  // it here so the next boot of "/" doesn't spuriously re-route to the
  // tutorial (the flag is the fallback for hosts that drop the deep link's
  // path; see lib/worker-bridge.ts)
  useEffect(() => {
    void import("@/lib/worker-bridge").then(({ consumeTutorialRequest }) => consumeTutorialRequest())
  }, [])
  const trackRef = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState(0)
  const isLast = at === STEPS.length - 1

  const done = () => router.push("/permissions")

  const goTo = (i: number) => {
    const track = trackRef.current
    if (track) track.scrollTo({ left: i * track.clientWidth, behavior: "smooth" })
  }

  const onScroll = () => {
    const track = trackRef.current
    if (!track) return
    setAt(Math.max(0, Math.min(STEPS.length - 1, Math.round(track.scrollLeft / track.clientWidth))))
  }

  return (
    <div className="flex min-h-dvh flex-1 flex-col gap-3.5 pt-6">
      <div className="flex flex-none items-center justify-center px-4">
        <StepDots n={STEPS.length} at={at} goTo={goTo} />
      </div>

      {/* the swipe track: one full-width snap slide per step */}
      <div
        ref={trackRef}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {STEPS.map((step, i) => (
          <div key={i} className="flex min-h-0 w-full flex-none snap-center flex-col px-6">
            <StepBody step={step} />
          </div>
        ))}
      </div>

      {/* action footer — only the terminal action; navigation is the swipe */}
      <footer className="flex min-h-20 flex-col items-center gap-2 px-4 pt-3 pb-6">
        {isLast ? (
          <Button size="lg" className="w-full max-w-sm" onClick={done}>
            Get started
          </Button>
        ) : (
          <span className="pt-3 text-xs font-medium tracking-wide text-muted-foreground/60">
            Swipe to continue
          </span>
        )}
      </footer>
    </div>
  )
}
