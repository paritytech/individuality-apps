// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * HOW TO PLAY, INLINE: the waiting room is page -1, the two steps are pages 0
 * and 1. The pages move side by side, and the clock keeps running off screen.
 * The page dots and the footer stay in place while the pages move.
 */
import { useState, type CSSProperties } from "react"
import { ArrowLeft, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { asset } from "@/lib/asset"
import type { HowToPlayStep } from "@/lib/waiting-room"

const STEPS = [
  { title: "Copy the gesture", img: "/how-to-play/step-1-copy-host.png", ratio: "338 / 295" },
  { title: "Tap other players who also copy the gesture", img: "/how-to-play/step-2-vote.png", ratio: "338 / 278.83" },
] as const

const PAGES: readonly HowToPlayStep[] = [-1, 0, 1]
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)"
/** a page moves a little more than its own width, so a page off screen is fully off */
const SLIDE_PCT = 108

/** a page's move; with reduced motion the page changes at once */
export const SLIDE_CLASS = "transition-transform duration-[480ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
/** the footer's fade and its row's move, on the pages' clock */
const FADE_CLASS = "transition-opacity duration-[480ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
const ROW_CLASS = "transition-[transform,opacity] duration-[480ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
/** under the footer's bottom padding, so the closed row is off screen */
const ROW_OUT = "translateY(calc(100% + max(39px, env(safe-area-inset-bottom))))"

/** where page `page` sits while `step` is open */
export function slideStyle(page: HowToPlayStep, step: HowToPlayStep): CSSProperties {
  return { transform: `translateX(${(page - step) * SLIDE_PCT}%)` }
}

/** one dot a page, the clock page first; the open page's dot is long */
export function PageDots({ step, className = "" }: { step: HowToPlayStep; className?: string }) {
  return (
    <div aria-hidden className={"flex justify-center gap-1.5 " + className}>
      {PAGES.map((page) => (
        <span
          key={page}
          className={"h-1.5 rounded-full " + (page === step ? "w-[18px] bg-foreground" : "w-1.5 bg-muted-foreground")}
          style={{ transition: `width 320ms ${EASE}, background-color 320ms ease` }}
        />
      ))}
    </div>
  )
}

/** the two steps, over the waiting room's own page. The parent is the positioned stage. */
export function HowToPlaySlides({ step }: { step: HowToPlayStep }) {
  return STEPS.map((s, i) => {
    const page = i as 0 | 1
    return (
      <div
        key={s.img}
        aria-hidden={step !== page || undefined}
        className={"pointer-events-none absolute inset-0 " + SLIDE_CLASS}
        style={slideStyle(page, step)}
      >
        <h2 className="mx-auto w-full max-w-[390px] px-6 text-center font-heading text-[32px] leading-10 font-semibold text-balance text-foreground">
          {s.title}
        </h2>
        {/* the picture's space starts under room for a two-line title, so both pictures sit in one place */}
        <div className="absolute inset-x-6 top-[104px] bottom-5 flex items-center justify-center pb-16">
          {/* eslint-disable-next-line @next/next/no-img-element -- static export, local asset */}
          <img src={asset(s.img)} alt="" className="w-full max-w-[338px] object-cover" style={{ aspectRatio: s.ratio }} />
        </div>
      </div>
    )
  })
}

/**
 * "How to play" on the waiting room's page; Back and Next (Done on the last step) on a step.
 * Both stay mounted: the row slides up from under the screen's edge and back. The parent is the positioned slot.
 */
export function HowToPlayFooter({ step, onStep }: { step: HowToPlayStep; onStep: (step: HowToPlayStep) => void }) {
  const open = step !== -1
  // the row keeps the labels of its last step while it slides out
  const [rowStep, setRowStep] = useState<0 | 1>(0)
  if (open && step !== rowStep) setRowStep(step)
  const last = rowStep === STEPS.length - 1
  return (
    <>
      <div inert={open} className={FADE_CLASS + (open ? " pointer-events-none opacity-0" : "")}>
        <Button variant="tertiary" className="h-12 gap-2.5 py-2 pr-5 pl-2 text-base leading-5 font-semibold" onClick={() => onStep(0)}>
          <span aria-hidden className="grid size-8 place-items-center rounded-full bg-white/12">
            <Info className="size-5 text-muted-foreground" strokeWidth={2} />
          </span>
          How to play
        </Button>
      </div>
      <div
        inert={!open}
        className={"absolute inset-x-0 bottom-0 flex gap-3 " + ROW_CLASS + (open ? "" : " pointer-events-none opacity-0")}
        style={{ transform: open ? "translateY(0)" : ROW_OUT }}
      >
        <Button
          variant="tertiary"
          size="icon"
          aria-label={rowStep === 0 ? "Back to the clock" : "Previous"}
          className="size-[52px]"
          onClick={() => onStep(rowStep === 1 ? 0 : -1)}
        >
          <ArrowLeft className="size-[22px]" />
        </Button>
        <Button className="h-[52px] flex-1 px-4 text-base leading-6 font-semibold" onClick={() => onStep(last ? -1 : 1)}>
          {last ? "Done" : "Next"}
        </Button>
      </div>
    </>
  )
}
