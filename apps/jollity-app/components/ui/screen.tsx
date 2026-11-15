// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * SCREEN PRIMITIVES — the shared type scale (eyebrow, heading, body) and
 * layout for full-page message screens, so one type scale lives in one place.
 *
 * A page styles `ActionFooter` only through the classNames it passes, never
 * through its internals, which is what makes it safe to share.
 */
import type { ReactNode, Ref } from "react"

/** the small label above a title — "One-time setup" */
function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={
        "text-xs font-semibold tracking-[0.08em] uppercase text-muted-foreground " + className
      }
    >
      {children}
    </div>
  )
}

/** the screen's title */
function Heading({
  children,
  className,
  headingRef,
}: {
  children: ReactNode
  /** replaces the standard block entirely — ceremony display type */
  className?: string
  headingRef?: Ref<HTMLHeadingElement>
}) {
  return (
    <h1 ref={headingRef} className={className ?? "text-[28px] leading-9 font-bold"}>
      {children}
    </h1>
  )
}

/** one paragraph of explanation, measured for reading */
export function Body({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={"max-w-[38ch] text-base leading-6 text-muted-foreground " + className}>
      {children}
    </p>
  )
}

function ActionFooter({
  above,
  note,
  secondary,
  anchor = "flow",
  className = "",
  children,
}: {
  above?: ReactNode
  /** status line directly above the CTA */
  note?: ReactNode
  /** the one action beneath the CTA; its row is reserved either way */
  secondary?: ReactNode
  /** "pinned" for an inset:0 ceremony stage — a PROP, not a className, so it
   *  cannot lose a specificity tie with `.relative` */
  anchor?: "flow" | "pinned"
  className?: string
  children?: ReactNode
}) {
  return (
    <div
      className={
        "flex flex-col items-center gap-3 px-6 pt-3 pb-8 " +
        (anchor === "pinned" ? "absolute inset-x-0 bottom-0 z-10 " : "") +
        className
      }
    >
      {above}
      {note ? (
        <span className="max-w-sm text-center text-xs font-medium text-muted-foreground/70">
          {note}
        </span>
      ) : null}
      <div className="w-full max-w-sm">{children}</div>
      {secondary ? <div className="w-full max-w-sm">{secondary}</div> : null}
    </div>
  )
}

/**
 * A whole screen that is just something to say — loading, nothing here, no
 * identity. Centred, with an optional action underneath.
 */
export function MessageScreen({
  eyebrow,
  heading,
  body,
  action,
  note,
  rootAttrs,
}: {
  eyebrow?: ReactNode
  heading: ReactNode
  body?: ReactNode
  action?: ReactNode
  /** status line directly above the action */
  note?: ReactNode
  /** attributes for the root element (test hooks); no behaviour */
  rootAttrs?: Record<string, string | number | boolean | undefined>
}) {
  return (
    <div {...rootAttrs} className="flex min-h-dvh flex-1 flex-col pt-6">
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <Heading>{heading}</Heading>
        {body ? <Body>{body}</Body> : null}
      </main>
      {action ? <ActionFooter note={note}>{action}</ActionFooter> : null}
    </div>
  )
}
