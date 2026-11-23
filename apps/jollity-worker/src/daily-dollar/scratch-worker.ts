// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A Daily Dollar scratch card drawn by this worker through the host's renderer: the card in the
 * chat, scratched with a finger, a win or a miss, and the result back in the card. Its ticket and its claim are
 * stand-ins for now (the outcome alternates and a win's first claim fails, to show the retry), and only a build with
 * DD_SCRATCH=worker posts it; tying it to the Daily Dollar draw is a change of its own.
 *
 * How it scratches. The ticket is a keyed `Gesture` whose pan reports where the finger is (`location`), over the
 * prize and the foil. The foil sits in a `Box` that carries a `Mask` hiding it where the finger went: the mask follows
 * the pan, so the host draws each stroke of the finger into it itself, in the frame of the touch, as a line 52 points
 * wide with round ends, and a lone press leaves a dot. The host paces the pan's moves (at most one a display frame,
 * none while the last is unanswered), and this worker answers only the newest move it holds with an empty
 * `ExtendMask`, a few bytes each way, never a tree. It keeps the points it hears, so a tree that redraws the ticket
 * keeps the strokes. The mask also names a `clearedShare`: once the strokes clear `REVEAL_PERMILLE` of the foil with
 * the finger up, the host sends `SCRATCH_REVEAL`, and a tree without the foil shows the prize, then the result card.
 * The worker keeps no threshold of its own.
 *
 * How it looks. As Daily Dollar's scratch ticket on the same phone: its ticket size, its foil and SCRATCH HERE label,
 * its purple ticket with the prize under the foil (pictures drawn in the font the ticket uses on that platform), and
 * its brush.
 */
import { decodeGestureEvent, extendMask, maskStroke, type RendererNode as WireNode } from "@parity/truapi"
import type { ActionListener, RenderRequest, Unsubscribe, WorkerHost } from "../host"
import { artCard, button, doneButton, spacer, type RenderNode } from "../card"
import { newestOnly } from "../newest-only"
import { toWire } from "../renderer"
import { ROOM_ID, readJSON, tryWriteJSON } from "../state"
import { DAILY_DOLLAR_ART } from "./cards"

export const MESSAGE_DD_SCRATCH = "jollity.ddscratch"

export const SCRATCH_START = "dds.start"
export const SCRATCH_MOVE = "dds.move"
export const SCRATCH_END = "dds.end"
/** Sent by the host, once per lift, when the foil is scratched past `REVEAL_PERMILLE`. */
export const SCRATCH_REVEAL = "dds.reveal"
const RETRY = "dds.retry"
const AGAIN = "dds.again"
/** The ticket's pan, whose moves the host paces. */
export const SCRATCH_PAN_KEY = "dds.pan"
/** The foil's mask, which `ExtendMask` names. */
export const SCRATCH_FOIL_KEY = "dds.foil"
const POSTED_KEY = "jollity.ddscratch.posted.v1"
const COUNT_KEY = "jollity.ddscratch.tickets"
const STATE_KEY = "jollity.ddscratch.state.v1:"

/** A ticket's size, in logical pixels. */
export type Size = { readonly width: number; readonly height: number }
/** How the card looks on one platform: the ticket's size and its pictures. */
export interface Look {
  readonly ticket: Size
  /** The foil with its SCRATCH HERE label. */
  readonly foil: string
  /** The purple ticket under the foil, with the prize. */
  readonly prize: { readonly win: string; readonly miss: string }
}

/**
 * The ticket on each platform, as measured on the phones it was compared on (the iPhone 17 Pro simulator's 290.4 x 380
 * points, the Pixel 9 emulator's 309 x 400 dp), and the pictures drawn at that size. The names are spelled out so the build copies every picture into the archive.
 */
const PLATFORM_LOOKS = {
  Ios: {
    ticket: { width: 290, height: 380 },
    foil: "chat-card/dd-foil-ios.png",
    prize: { win: "chat-card/dd-ticket-ios-win.png", miss: "chat-card/dd-ticket-ios-miss.png" },
  },
  Android: {
    ticket: { width: 309, height: 400 },
    foil: "chat-card/dd-foil-android.png",
    prize: { win: "chat-card/dd-ticket-android-win.png", miss: "chat-card/dd-ticket-android-miss.png" },
  },
} as const

/** The look for the platform the host reports ("Ios", "Android"); the iOS one when it reports another or none. */
export function lookFor(platform: string | undefined): Look {
  return platform === "Android" ? PLATFORM_LOOKS.Android : PLATFORM_LOOKS.Ios
}

/** The brush radius and the share scratched, in thousandths, that reveals the ticket (26 points, 55%). */
export const BRUSH = 26
export const REVEAL_PERMILLE = 550
/**
 * After the reveal: a win shows the prize for 1.8 s, then says the claim did not go through, and the result card
 * follows 0.9 s later; a miss shows the open ticket for 0.6 s before its result card.
 */
const CONFETTI_MS = 1800
const RESULT_DELAY_MS = { win: 900, miss: 600 } as const
const PRIZE_LABEL = { win: "You won today’s Daily Dollar: $1.00", miss: "Not today. A new ticket comes tomorrow" } as const

type Point = { x: number; y: number }

interface Ticket {
  day: string
  outcome: "win" | "miss"
}

type CardState =
  | { kind: "ticket"; ticket: Ticket }
  | { kind: "revealed"; ticket: Ticket; claimFailed?: boolean }
  | { kind: "won"; ticket: Ticket; claim: "failed" | "sent" }
  | { kind: "miss"; ticket: Ticket }

/** A gesture payload's point in logical pixels (it travels in hundredths). */
export function pointOf(payload: Uint8Array): { phase: string; point: Point } {
  const event = decodeGestureEvent(payload)
  return { phase: event.phase, point: { x: event.x / 100, y: event.y / 100 } }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const today = () => {
  const now = new Date()
  return `${MONTHS[now.getMonth()]} ${now.getDate()}`
}

const textNode = (text: string, style: "HeadlineLarge" | "TitleMediumRegular" | "BodyLargeRegular" | "BodyMediumRegular" | "BodySmallRegular", color: "FgPrimary" | "FgSecondary" | "FgWarning"): WireNode => ({
  tag: "Text",
  value: { modifiers: [], props: { style, color }, children: [{ tag: "String", value: { text } }] },
})

const sizeOf = (ticket: Size) => [{ tag: "Width", value: ticket.width }, { tag: "Height", value: ticket.height }] as const

const picture = (path: string, ticket: Size): WireNode => ({
  tag: "Image",
  value: { modifiers: [...sizeOf(ticket)], props: { source: { tag: "Archive", value: path }, fit: "Fill" } },
})

/**
 * The ticket card: header, the ticket (the prize under the foil while it is not revealed) and a hint. The prize is the
 * purple ticket with its prize, drawn as a picture so it keeps the ticket's type; the gesture's label says it once
 * revealed.
 *
 * While the ticket is scratched (`strokes` given), the foil's mask hides it along the strokes heard so far and follows
 * the pan, so the host draws each new stroke itself. Revealed (`strokes` null), the foil is gone.
 */
export function ticketTree(look: Look, ticket: Ticket, strokes: ReadonlyArray<ReadonlyArray<Point>> | null, hint: string): WireNode {
  const size = sizeOf(look.ticket)
  const foil: WireNode[] = strokes == null
    ? []
    : [{
        tag: "Box",
        value: {
          modifiers: [...size, {
            tag: "Mask",
            value: {
              key: SCRATCH_FOIL_KEY,
              mode: "Hide",
              shapes: strokes.filter((stroke) => stroke.length > 0).map((stroke) => maskStroke(2 * BRUSH, stroke)),
              // The host draws the finger's line itself: 52 points wide, round ends.
              follow: { pan: SCRATCH_PAN_KEY, width: 100 * 2 * BRUSH },
              // The host says when the foil is scratched enough, on a lift: one shared rule on every host.
              clearedShare: { atPermille: REVEAL_PERMILLE, action: SCRATCH_REVEAL },
            },
          }],
          props: { contentAlignment: "TopStart" },
          children: [picture(look.foil, look.ticket)],
        },
      }]
  const ticketNode: WireNode = {
    tag: "Gesture",
    value: {
      modifiers: [...size],
      props: {
        key: SCRATCH_PAN_KEY,
        accessibilityLabel: strokes == null ? PRIZE_LABEL[ticket.outcome] : "Scratch the ticket",
        enabled: strokes != null,
        pan: { axis: "Free", startAction: SCRATCH_START, moveAction: SCRATCH_MOVE, endAction: SCRATCH_END, location: true },
      },
      children: [picture(look.prize[ticket.outcome], look.ticket), ...foil],
    },
  }
  return {
    tag: "Column",
    value: {
      modifiers: [{ tag: "FillWidth", value: true }, { tag: "Padding", value: { top: 16, end: 16, bottom: 16, start: 16 } }, { tag: "Background", value: { color: "BgSurfaceContainer", shape: { tag: "Rounded", value: 16 } } }],
      props: { horizontalAlignment: "Center" },
      children: [
        {
          tag: "Row",
          value: {
            modifiers: [{ tag: "Width", value: look.ticket.width }],
            props: { verticalAlignment: "Center", horizontalArrangement: "SpaceBetween" },
            children: [textNode("Daily Dollar", "TitleMediumRegular", "FgPrimary"), textNode(today(), "BodySmallRegular", "FgSecondary")],
          },
        },
        { tag: "Spacer", value: { modifiers: [{ tag: "Height", value: 12 }] } },
        {
          tag: "Box",
          value: {
            modifiers: [...size, { tag: "Background", value: { color: "BgSurfaceNested", shape: { tag: "Rounded", value: 18 } } }],
            props: { contentAlignment: "TopStart" },
            children: [ticketNode],
          },
        },
        { tag: "Spacer", value: { modifiers: [{ tag: "Height", value: 12 }] } },
        textNode(hint, "BodyMediumRegular", "FgSecondary"),
      ],
    },
  }
}

function resultTree(state: CardState): RenderNode {
  switch (state.kind) {
    case "miss":
      return artCard(DAILY_DOLLAR_ART.miss, "Not today. A new ticket comes tomorrow.", [spacer(12), button("New test ticket", AGAIN, "secondary")])
    case "won":
      if (state.claim === "sent") {
        return artCard(DAILY_DOLLAR_ART.won, "You won $1.00. It is on its way to your wallet.", [spacer(12), doneButton("Claimed"), spacer(12), button("New test ticket", AGAIN, "secondary")])
      }
      return artCard(DAILY_DOLLAR_ART.won, "You won $1.00. The claim did not go through.", [spacer(12), button("Retry claim", RETRY)])
    default:
      throw new Error(`${state.kind} is drawn as a ticket`)
  }
}

const hex64 = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

/** The worker-drawn card's state, kept per message so a redraw after scrolling shows the same thing. */
export function createWorkerScratchCard(host: WorkerHost, schedule?: (flush: () => void) => void) {
  const states = new Map<string, CardState>()
  // The strokes heard on each ticket, for a tree that redraws it: a tree always wins over what the host drew.
  const heard = new Map<string, Point[][]>()
  const senders = new Map<string, (node: WireNode) => void>()
  // The look follows the platform the host reports, read once before the first ticket is drawn.
  let look = lookFor(undefined)
  let looked: Promise<void> | null = null
  const readLook = () =>
    (looked ??= (async () => {
      try {
        look = lookFor((await host.hostInfo?.())?.info?.platform)
      } catch {
        // No platform: the iOS look.
      }
    })())

  function revealedHint(state: Extract<CardState, { kind: "revealed" }>): string {
    if (state.claimFailed) return "The claim did not go through"
    return state.ticket.outcome === "win" ? "Nice one! Claiming it now" : "Better luck tomorrow"
  }

  function tree(messageId: string, state: CardState): WireNode {
    switch (state.kind) {
      case "ticket":
        return ticketTree(look, state.ticket, heard.get(messageId) ?? [], "Scratch the ticket with your finger")
      case "revealed":
        return ticketTree(look, state.ticket, null, revealedHint(state))
      default:
        return toWire(resultTree(state))
    }
  }

  function set(messageId: string, state: CardState) {
    states.set(messageId, state)
    // A ticket half scratched when the worker stops comes back unscratched; the strokes are kept in memory only.
    void tryWriteJSON(host, `${STATE_KEY}${messageId}`, state.kind === "revealed" ? { kind: "ticket", ticket: state.ticket } : state)
    senders.get(messageId)?.(tree(messageId, state))
  }

  async function newTicket(): Promise<Ticket> {
    const count = (await readJSON<number>(host, COUNT_KEY)) ?? 0
    void tryWriteJSON(host, COUNT_KEY, count + 1)
    return { day: hex64(count + 1), outcome: count % 2 === 0 ? "win" : "miss" }
  }

  function reveal(messageId: string, ticket: Ticket) {
    set(messageId, { kind: "revealed", ticket })
    const showResult = () => {
      if (states.get(messageId)?.kind !== "revealed") return
      // The claim is a stand-in: a win's first claim fails, so the card offers a retry.
      set(messageId, ticket.outcome === "win" ? { kind: "won", ticket, claim: "failed" } : { kind: "miss", ticket })
    }
    if (ticket.outcome === "miss") {
      setTimeout(showResult, RESULT_DELAY_MS.miss)
      return
    }
    // A win: the prize for a while, then the failed-claim line, then the result.
    setTimeout(() => {
      if (states.get(messageId)?.kind !== "revealed") return
      set(messageId, { kind: "revealed", ticket, claimFailed: true })
      setTimeout(showResult, RESULT_DELAY_MS.win)
    }, CONFETTI_MS)
  }

  function onAction(messageId: string, send: (node: WireNode) => void): ActionListener {
    let stroking = false

    /**
     * Keeps `point` on the current stroke and answers the move. The host drew the line already: the answer only lets
     * its next move go.
     */
    function scratchTo(point: Point, begins = false): void {
      const state = states.get(messageId)
      if (state?.kind !== "ticket") return
      const strokes = heard.get(messageId) ?? []
      heard.set(messageId, strokes)
      if (begins || strokes.length === 0) strokes.push([])
      strokes.at(-1)?.push(point)
      send(extendMask(SCRATCH_FOIL_KEY))
    }

    /** The host said the foil is scratched enough: a tree without the foil shows the prize. */
    function revealNow(): void {
      const state = states.get(messageId)
      if (state?.kind !== "ticket") return
      reveal(messageId, state.ticket)
    }

    const answerMove = newestOnly<Uint8Array>((payload) => {
      if (!stroking) return
      scratchTo(pointOf(payload).point)
    }, schedule)

    return (actionId, payload) => {
      const state = states.get(messageId)
      if (!state) return
      switch (actionId) {
        case SCRATCH_START:
          if (state.kind !== "ticket" || !payload) return
          stroking = true
          scratchTo(pointOf(payload).point, true)
          return
        case SCRATCH_MOVE:
          if (payload) answerMove.offer(payload)
          return
        case SCRATCH_END: {
          answerMove.drop()
          if (payload && state.kind === "ticket") scratchTo(pointOf(payload).point)
          stroking = false
          return
        }
        case SCRATCH_REVEAL:
          revealNow()
          return
        case RETRY:
          if (state.kind === "won" && state.claim === "failed") set(messageId, { kind: "won", ticket: state.ticket, claim: "sent" })
          return
        case AGAIN:
          heard.delete(messageId)
          void newTicket().then((ticket) => set(messageId, { kind: "ticket", ticket }))
          return
      }
    }
  }

  return {
    async post(): Promise<void> {
      if (await readJSON<boolean>(host, POSTED_KEY)) return
      await host.chat.postMessage(ROOM_ID, MESSAGE_DD_SCRATCH, new TextEncoder().encode("{}"), "Your Daily Dollar ticket is ready.")
      await tryWriteJSON(host, POSTED_KEY, true)
    },

    render(req: RenderRequest, send: (node: WireNode) => void, subscribe: (cb: ActionListener) => Unsubscribe): Unsubscribe {
      const { messageId } = req
      senders.set(messageId, send)
      const known = states.get(messageId)
      if (known) {
        send(tree(messageId, known))
      } else {
        void readLook().then(() => readJSON<CardState>(host, `${STATE_KEY}${messageId}`)).then(async (saved) => {
          if (states.has(messageId)) return
          const restored: CardState = saved ?? { kind: "ticket", ticket: await newTicket() }
          if (states.has(messageId)) return
          set(messageId, restored)
        })
      }
      const stop = subscribe(onAction(messageId, send))
      return () => {
        stop()
        if (senders.get(messageId) === send) senders.delete(messageId)
      }
    },
  }
}
