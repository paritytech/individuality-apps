// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The game card in the vocabulary of the host, with every face the one card
 * shows.
 *
 * It is pure, with a `GameSlot` in and a `RenderNode` out. The worker sends
 * the node through `toWire`. Anything visual added here must stay inside
 * render-node.ts, since the host cannot draw what those nodes cannot say.
 *
 * The faces come in two families, deliberately different.
 *
 * Before the game, the card is the docked "Next game" slab of the design, the
 * RegisterCard of DIM2. It is a nested surface in a heavy frame whose color
 * carries the state, amber while registration is open. Before the window
 * opens the button carries it too, as the same button disabled, so the slab
 * holds its shape when it goes live.
 *
 * After the game, the card is the results in the words of the native results
 * card. A new member gets the moment of the design. Everyone else gets the
 * layout of the missed card, with the verdict over the date in the grey box
 * and one sentence a line under it.
 *
 * The collectibles and the draw follow in boxes of their own, in the order of
 * the design. The draw is the won ticket, shown once the player has watched
 * the draw or at once while the prize can be claimed, and the card keeps
 * rendering as `payoff()` moves.
 */
import {
  background,
  border,
  box,
  bulletinImage,
  button,
  card,
  column,
  fill,
  flexibleSpacer,
  height,
  horizontalSpacer,
  image,
  nil,
  pad,
  row,
  slideToConfirm,
  spacer,
  text,
  width,
  type ColorToken,
  type HorizontalAlignment,
  type Modifier,
  type RenderNode,
} from "./render-node"
import {
  ACTION_OPEN_GAME,
  ACTION_REGISTER,
  ACTION_USERNAME,
  ACTION_STASH,
  ACTION_TURN_ON_CAMERA,
} from "./actions"
import * as copy from "./copy"
import { formatCountdown, formatGameDate, formatGameTime, formatMinutesSeconds, formatPrize, formatPrizeAmount, prizeUnit } from "./format"
import { payoff, type GameResults, type GameSlot, type Payoff, type SlotCollectable } from "./game-slot"
import { claimRefusalWords } from "@jollity/protocol"
import { type ClaimFailure } from "@individuality/prize"
import { hostPillUp, JOIN_LEAD_S } from "@individuality/sign-up/reminder"

/** The transient state of a card, whether a tap is in flight and the notice under it. */
export interface CardUi {
  busy: boolean
  notice: {
    text: string
    status?: string
    tone: "fg.secondary" | "fg.warning" | "fg.error"
    /** Register stays greyed out and takes no tap while the notice holds */
    registerOff?: boolean
  } | null
  /** How far a busy sign-up got, from 0 to 1, which Register shows as a ring that fills. */
  progress?: number
  /** Set when the stored answer is a refusal, which draws the camera line. */
  camera?: "off"
}

export const IDLE_UI: CardUi = { busy: false, notice: null }

/**
 * The steps of a sign-up from the chat as the card shows them, in order.
 *
 * The name is the wait on the name link (./name-gate.ts), usually done before
 * the tap. The bind comes only for a lite person who needs one. The draws are the wait
 * for the prize draw to open, which the engine spends a block at a time, and
 * the sign is the proof and the signature the host asks for.
 */
export type SignupStep = "reminders" | "name" | "signer" | "route" | "bind" | "draws" | "sign"

/**
 * How far along each step leaves the ring of Register.
 *
 * The ring stops short of full until the card turns registered. The steps are
 * declared in the order a sign-up takes them.
 */
export const SIGNUP_PROGRESS: Record<SignupStep, number> = { reminders: 0.1, name: 0.18, signer: 0.25, route: 0.4, bind: 0.5, draws: 0.6, sign: 0.8 }

// The tiles of the collectables card of the design. The host has no
// proportional width, so every row is pinned to GALLERY_WIDTH, three small
// tiles or two large ones with TILE_GAP between, which fits a 375pt phone. iOS
// stretches an unpinned row across the card, which widened the gap of a row of
// two. The row is spaceBetween, which drops the stack spacing iOS adds, so the
// gap is TILE_GAP on the phone. The hosts draw the padding of a node outside
// its declared size, so a padded tile declares its content size and its outer
// size is the tile constant.
const TILE_GAP = 8
const GALLERY_WIDTH = 304
const SMALL_TILE = {
  width: (GALLERY_WIDTH - 2 * TILE_GAP) / 3,
  height: 142,
  art: 96,
  padding: [10, 10, 12, 10] as const,
  glow: "chat-card/rare-glow-small.png",
}
const LARGE_TILE = {
  width: (GALLERY_WIDTH - TILE_GAP) / 2,
  height: 196,
  art: 150,
  padding: [10, 12, 12, 12] as const,
  glow: "chat-card/rare-glow-large.png",
}
// The host draws no gradient and no icon, so the amber glow and the star of a
// rare tile are pictures of the CSS of the design, at the size of each tile
// with its corners, laid over the tile in a Box.
const RARE_BADGE = { path: "chat-card/rare-badge.png", size: 24 }
// The clock of the pending status in the native results card, its own PDF
// rasterised in its own colour, since the host draws no icon.
const PENDING_CLOCK = { path: "chat-card/pending-clock.png", size: 16 }
const BELL_OFF = { path: "chat-card/bell-off.png", size: 16 }
const CAMERA_OFF = { path: "chat-card/camera-off.png", size: 16 }
// The ticket of a won draw is the rainbow of the design with a notch cut out
// of each side, baked by apps/jollity-app/scripts/bake-prize-ticket.mjs at the width of the
// card of the design and stretched to the width of this one.
const TICKET = { path: "chat-card/prize-ticket.png", height: 136 }
// The host draws no arc, so the ring that fills on Register is one picture a
// step, baked by scripts/bake-signup-ring.mjs. Each path is spelled out, since
// the build ships only the pictures the bundle names whole.
const SIGNUP_RING = {
  size: 22,
  steps: [
    { percent: 10, path: "chat-card/signup-ring-10.png" },
    { percent: 20, path: "chat-card/signup-ring-20.png" },
    { percent: 30, path: "chat-card/signup-ring-30.png" },
    { percent: 40, path: "chat-card/signup-ring-40.png" },
    { percent: 50, path: "chat-card/signup-ring-50.png" },
    { percent: 60, path: "chat-card/signup-ring-60.png" },
    { percent: 70, path: "chat-card/signup-ring-70.png" },
    { percent: 80, path: "chat-card/signup-ring-80.png" },
    { percent: 90, path: "chat-card/signup-ring-90.png" },
  ],
}
// The CASH wordmark beside a won amount, as the app draws it (#431): the host
// draws text in its own typeface only, so it is baked by
// apps/jollity-app/scripts/bake-cash-wordmark.mjs as one line of the amount, and centred in
// the row it sits on the amount's baseline.
const CASH_WORDMARK = { path: "chat-card/cash-wordmark.png", width: 43, height: 32 }

/**
 * The widths that fit "Opening soon", "Register" and "Start playing" in the pills of the card.
 *
 * The iOS host draws a button label at an unbounded width, so a button sized by
 * its text still takes all the room of the row, and the text beside it wraps
 * mid-word.
 */
const REGISTER_WIDTH = 136
const FOOT_TAP_WIDTH = 56
// Fits either line of a foot row on one line. iOS would wrap a line sized by
// its text beside a flexible spacer, and Android gives a filled one all the width.
const FOOT_LINE_WIDTH = 192
const BLOCKED_REGISTER_WIDTH = 104
const BLOCKED_FOOT_PADDING = 8
type PillLook = { padding: [number, number, number, number] }
const DEFAULT_PILL: PillLook = { padding: [12, 16, 12, 16] }
const BLOCKED_PILL: PillLook = { padding: [8, 12, 8, 12] }
const OPENING_SOON_WIDTH = 156
const START_PLAYING_WIDTH = 132
const START_PLAYING_PILL: PillLook = { padding: [10, 12, 10, 12] }

/**
 * A button beside a label rather than under it.
 *
 * It drops the fillWidth of the builder, so the host sizes the button to its
 * text instead of stretching it across the row.
 */
function compact(node: RenderNode): RenderNode {
  if (node.tag !== "Button") return node
  return {
    ...node,
    value: { ...node.value, modifiers: node.value.modifiers.filter((modifier) => modifier.tag !== "fillWidth") },
  }
}

/** A nested surface in a heavy frame, whose color is the state. */
function framed(children: RenderNode[], frame: ColorToken): RenderNode {
  const modifiers: Modifier[] = [fill, pad(16), background("bg.surface.nested", 24), border(4, frame, 24)]
  return column(children, modifiers, { horizontalAlignment: "start" })
}

/**
 * The left column of the slab, a label over the date.
 *
 * With the date at title.medium the pair stands 46px, the height of the button
 * beside it, so the frame sits as far from the top and bottom as from the
 * sides.
 */
function labelOverDate(label: RenderNode, date: RenderNode, alignment: HorizontalAlignment = "start"): RenderNode {
  return column([label, spacer(2), date], [], { horizontalAlignment: alignment })
}

/** The grey box of a game that is over, its label centred over the date it ended. */
function endedBox(label: string | RenderNode, endedAt: number): RenderNode {
  return column(
    [
      labelOverDate(
        typeof label === "string" ? text(label, { style: "body.medium.regular", color: "fg.primary" }) : label,
        text(formatGameDate(endedAt), { style: "title.medium.regular", color: "fg.primary" }),
        "center",
      ),
    ],
    [fill, pad(20), background("bg.surface.container", 24)],
    { horizontalAlignment: "center" },
  )
}

/**
 * The label over the time on the cards of a game ahead, 4px apart as the
 * registration design has it.
 *
 * Space between is what keeps it at 4px on iOS, which puts its default stack
 * spacing between the children of any other column.
 */
function labelOverTime(label: RenderNode, time: RenderNode): RenderNode {
  return column([label, spacer(4), time], [], { horizontalAlignment: "start", verticalArrangement: "spaceBetween" })
}

/** The card with its notice centred under the frame, where it does not crowd the row of the button. */
function withNotice(node: RenderNode, ui: CardUi): RenderNode {
  if (!ui.notice) return node
  return column([node, spacer(4), text(ui.notice.text, { style: "body.small.regular", color: ui.notice.tone })], [fill], {
    horizontalAlignment: "center",
  })
}

/** What a caller can change about the faces. */
export interface CardOptions {
  /**
   * A design exploration that shows a countdown to the game on the Register
   * face where the date is.
   *
   * Both looks are kept for now. Pick one and delete this, since the worker
   * never sets it.
   */
  registerCountdown?: boolean
  /**
   * Whether the host docks the pill of the last five minutes over the thread,
   * so the card shows the registered face until the join, with "Game starting
   * soon" for the date while the pill counts. iOS and Android
   * dock one for the game whose reminder they hold. Without it the card
   * carries the countdown and the way in itself.
   */
  hostPill?: boolean
  /** Where the claim of the prize of a results card stands. The worker sends
   *  it by itself, so the card has no Claim button and only says how it went. */
  claim?: ClaimUi
  /** Whether the full username of the player is set, which only the worker reads from the People chain. */
  nameSet?: boolean
  /** Whether the chain can take a username claim yet: the Membership key is in the people ring. */
  nameReady?: boolean
  /** Whether the host docks the card in the footer of the room, whose own padding takes the place of the gap under a card in the feed. */
  docked?: boolean
  /**
   * Whether the host draws a slide to confirm, so Register is a slide rather
   * than a tap. The worker sets it only for a host it knows draws one
   * (`drawsSlideToConfirm` in src/renderer.ts); every other host gets the
   * Register button, which sends the same action.
   */
  slide?: boolean
}

/** The 24 under a card in the feed, the gap of the native results card. */
const FEED_GAP: Modifier = { tag: "padding", value: [0, 0, 24, 0] }
const cardFrame = (docked: boolean | undefined): Modifier[] => (docked ? [fill] : [fill, FEED_GAP])

export interface ClaimUi {
  busy: boolean
  failure: ClaimFailure | null
  /** the error a refusal named, which it shows in words */
  refusal?: string
}

export function gameCardNode(slot: GameSlot, ui: CardUi, nowSeconds: number, options: CardOptions = {}): RenderNode {
  const frame = cardFrame(options.docked)
  switch (slot.kind) {
    // A game that is not coming, in the box of an ended game, with nothing under it.
    case "cancelled":
      return column([endedBox(copy.GAME_CANCELLED, slot.startAt)], frame, { horizontalAlignment: "center" })

    // The worker posts a card per game, so no card is ever drawn without one.
    case "none":
      return nil()

    case "next":
      return framed(
        [
          row([
            labelOverTime(
              text(copy.NEXT_GAME, { style: "body.large.regular", color: "fg.secondary" }),
              text(formatGameTime(slot.startAt), { style: "title.medium.regular", color: "fg.primary" }),
            ),
            // The pill of Register in grey, with nothing to tap until the window opens.
            horizontalSpacer(12),
            fixedWidth(pill(copy.OPENING_SOON, "bg.surface.container", "fg.tertiary"), OPENING_SOON_WIDTH),
          ]),
        ],
        "fg.tertiary",
      )

    case "register": {
      const blocked = Boolean(ui.notice?.status)
      const off = Boolean(ui.notice?.registerOff)
      const notice = ui.notice ? registerFoot(ui.notice) : undefined
      // The slide stands in for the label, the time and the pill: it says the
      // time on its second line. A blocked or greyed-out Register keeps the
      // pill, whose look carries why, and the slide shows no ring of progress,
      // only the loading state of the host.
      if (options.slide === true && !blocked && !off)
        return nextFrame(
          [
            slideToConfirm(copy.SLIDE_TO_REGISTER, ACTION_REGISTER, {
              secondaryText: options.registerCountdown ? formatCountdown(slot.startAt, nowSeconds) : formatGameTime(slot.startAt),
              confirmedText: copy.REGISTERED,
              accent: "fg.warning",
              loading: ui.busy,
            }),
          ],
          "fg.warning",
          notice,
        )
      return nextFrame(
        [
          row([
            labelOverTime(
              ui.notice?.status
                ? text(ui.notice.status, { style: "title.medium.regular", color: "fg.warning" })
                : text(copy.NEXT_GAME, { style: "body.large.regular", color: "fg.secondary" }),
              text(options.registerCountdown ? formatCountdown(slot.startAt, nowSeconds) : formatGameTime(slot.startAt), {
                style: "title.medium.regular",
                color: "fg.primary",
              }),
            ),
            horizontalSpacer(12),
            off
              ? fixedWidth(pill(copy.REGISTER, "bg.surface.container", "fg.tertiary"), REGISTER_WIDTH)
              : pillButton(
                  copy.REGISTER,
                  ACTION_REGISTER,
                  "fg.warning",
                  blocked ? BLOCKED_REGISTER_WIDTH : REGISTER_WIDTH,
                  { loading: ui.busy && ui.progress === undefined, enabled: !ui.busy, progress: ui.busy ? ui.progress : undefined },
                  blocked ? BLOCKED_PILL : undefined,
                ),
          ]),
        ],
        blocked ? "bg.surface.container" : "fg.warning",
        notice && blocked && ui.camera === "off" ? [notice, cameraFoot(ui.busy)] : notice,
        blocked ? BLOCKED_FOOT_PADDING : undefined,
      )
    }

    // A posted message cannot be removed, and iOS draws a spinner for a card
    // that renders nothing, so under the pill of the host the card shows the
    // registered face, saying the game is starting soon where the date was:
    // the pill is the only countdown. The host drops its pill at the join, so
    // the card comes back with Start playing then.

    // Before the join, a minute ahead of the start, the card counts down with
    // no button, as the native card does, to the moment the pill of the host
    // counts to. Start playing is the way in from then on.
    case "starting": {
      const joinAt = slot.startAt - JOIN_LEAD_S
      if (options.hostPill === true && nowSeconds < joinAt)
        return withNotice(registeredSlab(text(copy.GAME_STARTING_SOON, { style: "title.medium.regular", color: "fg.primary" })), ui)
      if (nowSeconds < joinAt && joinAt - nowSeconds <= LAST_MINUTE_S)
        return withNotice(lastMinutePill(joinAt - nowSeconds), ui)
      if (nowSeconds < joinAt)
        return withNotice(registeredSlab(text(copy.LEFT_TO_JOIN(formatMinutesSeconds(joinAt, nowSeconds)), { style: "title.medium.regular", color: "fg.primary" })), ui)
      return withNotice(
        framed(
          [
            row([
              labelOverTime(
                text(copy.GAME_IN_PROGRESS, { style: "body.medium.regular", color: "fg.primary" }),
                text(formatGameTime(slot.startAt), { style: "title.medium.regular", color: "fg.warning" }),
              ),
              horizontalSpacer(12),
              pillButton(copy.START_PLAYING, ACTION_OPEN_GAME, "fg.primary", START_PLAYING_WIDTH, {}, START_PLAYING_PILL),
            ]),
          ],
          "fg.warning",
        ),
        ui,
      )
    }

    // The design puts a bell where Register was, and rows for the alarm and the
    // calendar under the slab. The host draws no icons and gives a product no
    // alarm or calendar, so the slab stands alone in its frame.
    case "registered":
      return withNotice(
        registeredSlab(
          text(
            options.hostPill === true && hostPillUp(slot.startAt, nowSeconds) ? copy.GAME_STARTING_SOON : formatGameTime(slot.startAt),
            { style: "title.medium.regular", color: "fg.primary" },
          ),
          ui.camera === "off" ? cameraFoot(ui.busy) : undefined,
        ),
        ui,
      )

    // The "Next game" slab puts the verdict where the date was and has no
    // button, since there is nothing left to tap for this game.

    case "closed":
      return withNotice(
        framed(
          [
            labelOverTime(
              text(copy.NEXT_GAME, { style: "body.large.regular", color: "fg.secondary" }),
              text(copy.REGISTRATION_CLOSED, { style: "title.medium.regular", color: "fg.primary" }),
            ),
          ],
          "fg.tertiary",
        ),
        ui,
      )

    // The pending card of the native app, with no Chat with players button.
    // A row without fill centres the clock and the status as one unit.
    case "pending":
      return column(
        [
          endedBox(
            row(
              [
                image(PENDING_CLOCK.path, [width(PENDING_CLOCK.size), height(PENDING_CLOCK.size)], "fill"),
                horizontalSpacer(6),
                text(copy.RESULTS_PENDING, { style: "body.medium.regular", color: "fg.warning" }),
              ],
              "spaceBetween",
              [],
            ),
            slot.endedAt,
          ),
        ],
        frame,
        { horizontalAlignment: "center" },
      )

    // Never registered and registered but no show read the same to the player.
    // Only a player whose report landed is told they played.
    // The verdict sits under the grey box, and the box keeps what comes next.
    case "missed": {
      // A non-member who never signed up neither failed nor owes a game, so
      // the card says only that the game went by, and only in the feed.
      if (slot.reason === "never-registered" && !slot.member && !slot.membershipPaused) {
        const missedLine = options.docked ? [] : [spacer(4), statusLine(copy.MISSED, "fg.secondary")]
        return column([endedBox(copy.GAME_ENDED, slot.endedAt), ...missedLine], frame, {
          horizontalAlignment: "center",
          verticalArrangement: "spaceBetween",
        })
      }
      const [verdict, next] = slot.member && !slot.membershipPaused
        ? memberMissedLines(slot.missesLeft, slot.reason === "not-passed")
        : missedLines(slot.membershipPaused, slot.gamesToMembership, slot.reason === "not-passed")
      return column(
        [
          endedBox(copy.GAME_ENDED, slot.endedAt),
          spacer(4),
          statusLine(verdict, "fg.secondary"),
          ...(slot.earned ? playedEarned(slot.earned) : []),
          ...(next === null ? [] : [statusLine(next, "fg.secondary")]),
        ],
        // 4 under the box and 24 below the card, the gaps of the native results card.
        frame,
        // Space between drops the default spacing iOS puts between the box and the lines.
        { horizontalAlignment: "center", verticalArrangement: "spaceBetween" },
      )
    }

    case "results":
      return resultsCard(slot.results, options.claim, options.nameSet, options.nameReady, options.docked)
  }
}

/** A member the chain did not suspend is still a member, so the card warns only when no miss is left. */
function memberMissedLines(missesLeft: number | null, played: boolean): [string, string | null] {
  return [played ? copy.PLAYED_NOT_PASSED : copy.MISSED, missesLeft === 0 ? copy.LAST_MISS : null]
}

function missedLines(membershipPaused: boolean, gamesToMembership: number | null, played: boolean): [string, string] {
  const next = membershipPaused
    ? played ? copy.PLAYED_PAUSED : copy.MISSED_PAUSED
    : gamesToMembership !== null && gamesToMembership > 0
      ? copy.MISSED_PLAY_N_MORE(gamesToMembership)
      : copy.PLAY_AGAIN
  if (played) return [copy.PLAYED_NOT_PASSED, next]
  return [membershipPaused ? copy.MISSED : copy.MISSED_OR_FAILED, next]
}

function playedEarned(count: number): RenderNode[] {
  return [
    statusLine(copy.PLAYED_EARNED(count), "fg.secondary"),
    statusLine(copy.PLAYED_CLAIM_IN_STASH(count), "fg.secondary"),
    spacer(8),
    button(copy.OPEN_STASH, ACTION_STASH, "secondary"),
    spacer(8),
  ]
}

/** The amount of a won draw, "$200" and the CASH wordmark; a build that names the prize anything else writes its word. */
function wonAmount(amountUsd: number, ink: ColorToken): RenderNode {
  if (prizeUnit() !== "CASH") return text(formatPrize(amountUsd), { style: "headline.large", color: ink })
  return row(
    [
      text(formatPrizeAmount(amountUsd), { style: "headline.large", color: ink }),
      horizontalSpacer(6),
      image(CASH_WORDMARK.path, [width(CASH_WORDMARK.width), height(CASH_WORDMARK.height)], "fill"),
    ],
    "center",
    [],
  )
}

/**
 * The won ticket of the chat design, dark text over the rainbow picture.
 *
 * The design sets the label at 12, the amount at 32 and the line at 16. The
 * host has no 32 or 16, so the card sets them at 12, 24 and 18.
 *
 * The label of the design reads "Prize draw" and then the draw, and the card
 * leaves the draw out.
 *
 * The design inks the text in `--fg-primary-inverted`, which is the surface
 * colour of its theme, zinc-950 on the dark one. No host token is a fixed
 * dark, and `bg.surface.main` is the surface colour of the host theme, so it
 * follows the design on a light theme too.
 */
function wonTicket(amountUsd: number): RenderNode {
  const ink: ColorToken = "bg.surface.main"
  const lines = column(
    [
      text(copy.PRIZE_DRAW, { style: "body.medium.regular", color: ink }),
      spacer(12),
      wonAmount(amountUsd, ink),
      spacer(12),
      text(copy.YOU_WON, { style: "title.medium.regular", color: ink }),
    ],
    [fill, { tag: "padding", value: [16, 20, 16, 20] }],
    { horizontalAlignment: "center", verticalArrangement: "spaceBetween" },
  )
  return box([image(TICKET.path, [fill, height(TICKET.height)], "fill"), lines], [fill])
}

/**
 * The results, in the words of the native results card.
 *
 * A new member gets the moment of the design. Everyone else gets the verdict
 * over the date in the grey box and one sentence a line under it: a standing
 * member who passed is told of the membership, one who did not that this one
 * got away, and a non-member reads the lines of the missed card, since
 * native says the same for a miss and a fail.
 */
export function resultsCard(results: GameResults, claim?: ClaimUi, nameSet = false, nameReady = false, docked = false): RenderNode {
  const remaining = payoff(results)
  const frame = cardFrame(docked)
  const { member, justBecameMember, gamesToMembership } = results.membership
  if (justBecameMember) return newMemberCard(results, remaining, claim, nameSet, nameReady, frame)
  if (member) {
    return results.passed
      ? endedCard(results, remaining, copy.GAME_SUCCEEDED, [copy.GOT_MEMBERSHIP], claim, frame)
      : endedCard(results, remaining, copy.GAME_ENDED, [copy.GOT_AWAY, copy.NEXT_CHANCE], claim, frame)
  }
  if (!results.passed) return endedCard(results, remaining, copy.GAME_ENDED, missedLines(false, gamesToMembership, true), claim, frame)
  const step = gamesToMembership !== null && gamesToMembership > 0 ? copy.N_MORE_TO_MEMBER(gamesToMembership) : copy.PLAY_AGAIN
  return endedCard(results, remaining, copy.GAME_SUCCEEDED, [step], claim, frame)
}

/**
 * The card of a game that is over, laid out as the missed card is.
 *
 * The verdict sits over the date in the grey box, the lines stand under the
 * box, and the collectibles and the draw follow in boxes of their own, in the
 * order of the design.
 */
function endedCard(results: GameResults, remaining: Payoff, verdict: string, lines: string[], claim: ClaimUi | undefined, frame: Modifier[]): RenderNode {
  const earned = collectiblesBox(results)
  return column(
    [
      endedBox(verdict, results.endedAt),
      spacer(4),
      ...lines.map((line) => text(line, { style: "body.medium.regular", color: "fg.secondary" })),
      ...(earned ? [spacer(8), earned] : []),
      ...drawSheet(results, remaining, claim),
    ],
    frame,
    { horizontalAlignment: "center", verticalArrangement: "spaceBetween" },
  )
}

/**
 * The card of a game that made the player a member, as the chat design has it.
 *
 * The moment gets a box of its own with the name button, the status line sits
 * under it, then a box that opens the collectibles in the stash, and the prize
 * draw last when there is one. Once the full username is set, the note of an
 * upgraded username stands under the status line in place of the name button.
 * Until the people ring holds the member's key the name cannot be claimed, so
 * the button waits and a line under the status says the membership is finishing.
 * The gaps between and below are the 4 and 24 of the native results card.
 */
function newMemberCard(results: GameResults, remaining: Payoff, claim: ClaimUi | undefined, nameSet: boolean, nameReady: boolean, frame: Modifier[]): RenderNode {
  const note = { style: "body.medium.regular", color: "fg.tertiary" } as const
  const moment = column(
    [
      text(copy.GAME_SUCCEEDED, { style: "title.medium.regular", color: "fg.primary" }),
      text(copy.GOT_MEMBERSHIP, { style: "title.medium.regular", color: "fg.primary" }),
      ...(nameSet || !nameReady ? [] : [spacer(16), button(copy.MEMBER_NAME, ACTION_USERNAME, "primary")]),
    ],
    [fill, pad(20), background("bg.surface.container", 20)],
    { horizontalAlignment: "center", verticalArrangement: "spaceBetween" },
  )
  const status = [text(copy.MEMBER_STATUS, note), ...(nameSet ? [text(copy.NAME_UPGRADED, note)] : nameReady ? [] : [text(copy.NAME_PENDING, note)])]
  const collectibles = [spacer(8), collectiblesBox(results, { announce: true })!]
  return column([moment, spacer(4), ...status, ...collectibles, ...drawSheet(results, remaining, claim)], frame, {
    horizontalAlignment: "center",
    verticalArrangement: "spaceBetween",
  })
}

/**
 * The collectibles a game earned, a tile with the picture of each, and the way to them in the stash.
 *
 * The count comes from the claims and the tiles from the chest, which the
 * worker reads once every claim can be dealt, so the count can stand alone
 * for a while. A game that earned nothing, or whose count is not read yet,
 * gets no box, unless `announce` asks for one anyway, as the new member card
 * does, which says so in words.
 */
function collectiblesBox(results: GameResults, options: { announce?: boolean } = {}): RenderNode | null {
  const count = results.earned ?? results.collectables?.length ?? null
  const surface = [fill, pad(16), background("bg.surface.container", 20)]
  const centred = { horizontalAlignment: "center", verticalArrangement: "spaceBetween" } as const
  if (count === 0) {
    return options.announce ? column([text(copy.NO_REWARDS, { style: "body.medium.regular", color: "fg.primary" })], surface, centred) : null
  }
  if (count === null && !options.announce) return null
  const tiles = galleryRows(results.collectables ?? []).flatMap((tileRow) => [spacer(TILE_GAP), tileRow])
  return column(
    [
      text(copy.EARNED_COLLECTIBLES(count), { style: "body.large.regular", color: "fg.tertiary" }),
      ...(tiles.length ? [spacer(TILE_GAP), ...tiles] : []),
      spacer(TILE_GAP),
      button(copy.OPEN_COLLECTIBLES, ACTION_STASH, "secondary"),
    ],
    surface,
    centred,
  )
}

/**
 * How many tiles each row of the gallery holds, and whether they are the large two-across ones.
 *
 * Rows of three, except that four left over become two rows of two rather
 * than three and one, and two left over are one row of two. A single tile is
 * a large one, centred, rather than a tile stretched across the card.
 */
export function galleryLayout(count: number): { count: number; large: boolean }[] {
  if (count === 1) return [{ count: 1, large: true }]
  const rows: { count: number; large: boolean }[] = []
  let remaining = count
  while (remaining > 0) {
    if (remaining === 4) {
      rows.push({ count: 2, large: true }, { count: 2, large: true })
      break
    }
    if (remaining >= 3) {
      rows.push({ count: 3, large: false })
      remaining -= 3
      continue
    }
    rows.push({ count: remaining, large: true })
    break
  }
  return rows
}

function galleryRows(collectables: SlotCollectable[]): RenderNode[] {
  let start = 0
  return galleryLayout(collectables.length).map(({ count, large }) => {
    const tiles = collectables.slice(start, start + count).map((collectable) => collectibleTile(collectable, large ? LARGE_TILE : SMALL_TILE))
    start += count
    const children = tiles.flatMap((tile, index) => (index ? [horizontalSpacer(TILE_GAP), tile] : [tile]))
    return row(children, tiles.length === 1 ? "center" : "spaceBetween", [width(GALLERY_WIDTH)])
  })
}

/** One collectible, its picture over its name, the name in amber when it is rare. */
function collectibleTile(collectable: SlotCollectable, size: typeof SMALL_TILE | typeof LARGE_TILE): RenderNode {
  const [top, end, bottom, start] = size.padding
  const rare = collectable.rarity === "rare"
  const art = collectable.image
    ? bulletinImage(collectable.image, [width(size.width - start - end), height(size.art)], "contain")
    : spacer(size.art)
  const tileSize = [width(size.width), height(size.height)]
  const inner = [width(size.width - start - end), height(size.height - top - bottom)]
  const content = column(
    [art, text(collectable.name, { style: "body.large.regular", color: rare ? "fg.warning" : "fg.secondary" })],
    [...inner, { tag: "padding", value: [top, end, bottom, start] }, ...(rare ? [] : [background("bg.surface.nested", 20)])],
    { horizontalAlignment: "center", verticalArrangement: "spaceBetween" },
  )
  if (!rare) return content
  const badge = column(
    [image(RARE_BADGE.path, [width(RARE_BADGE.size), height(RARE_BADGE.size)], "fill")],
    [width(size.width - 2 * start), height(size.height - 2 * top), { tag: "padding", value: [top, start, top, start] }],
    { horizontalAlignment: "start", verticalArrangement: "start" },
  )
  return box([image(size.glow, tileSize, "fill"), content, badge], [...tileSize, background("bg.surface.nested", 20)])
}

/**
 * The won ticket once the draw is watched, claimable, claimed or over, and nothing before.
 *
 * It shows nothing for a draw still ahead, nothing for a held draw not yet
 * watched, nothing for a lost one, nothing without a ticket, and nothing for
 * a win the chain will not pay the player: the card never says they won what
 * they cannot have.
 */
function prizeDraw(results: GameResults, remaining: Payoff): RenderNode | null {
  const prize = results.prize
  if (!prize) return null
  switch (remaining.draw) {
    case "claim":
    case "claimed":
    case "revealed":
      return prize.won ? wonTicket(prize.amountUsd) : null
    default:
      return null
  }
}

/**
 * The prize part of the card: the won ticket 4 under what comes before it, with
 * where its claim stands under the ticket, or the lines of a player the chain
 * will not pay, or nothing.
 */
function drawSheet(results: GameResults, remaining: Payoff, claim?: ClaimUi): RenderNode[] {
  if (remaining.draw === "members-only") return notEligibleLines()
  const ticket = prizeDraw(results, remaining)
  if (!ticket) return []
  if (remaining.draw === "claimed") return [spacer(4), ticket, spacer(8), statusLine(copy.CLAIMED, "fg.secondary")]
  return [spacer(4), ticket, ...(remaining.draw === "claim" && claim ? claimStatus(claim) : [])]
}

/** Why there is no prize for this player: one sentence a line, as the missed card has them. */
function notEligibleLines(): RenderNode[] {
  return [spacer(8), statusLine(copy.NOT_ELIGIBLE, "fg.secondary"), statusLine(copy.MEMBERS_ONLY, "fg.secondary")]
}

const statusLine = (line: string, color: "fg.secondary" | "fg.error") => text(line, { style: "body.medium.regular", color })

const CLAIM_NOTICE: Record<Exclude<ClaimFailure, "refused">, string> = {
  cancelled: copy.CLAIM_CANCELLED,
  failed: copy.CLAIM_FAILED,
}

/**
 * Where the worker's claim stands, under the won ticket: under way, or why it
 * did not land. A refusal is the chain's last word; any other failure leaves
 * the claim to the app's draw screen, which sends it by itself too.
 */
function claimStatus(claim: ClaimUi): RenderNode[] {
  if (claim.busy) return [spacer(8), statusLine(copy.CLAIMING, "fg.secondary")]
  if (!claim.failure) return []
  if (claim.failure === "refused") return [spacer(8), statusLine(claimRefusalWords(claim.refusal ?? ""), "fg.error")]
  return [spacer(8), statusLine(CLAIM_NOTICE[claim.failure], "fg.error"), statusLine(copy.CLAIM_IN_APP, "fg.secondary")]
}

/** The same node pinned to a width, with one modifier added to its own. */
/**
 * A pill of the registration design, a label on a colour.
 *
 * The iOS host draws a button white, grey or clear, always with light text on
 * a colour and 12px corners. The orange Register of the design with its dark
 * label is therefore this pill, and a clear button laid over it takes the tap.
 */
/**
 * The label of the clear button over a pill.
 *
 * iOS takes a tap only where a clear button draws its label, so the label is
 * spaces as wide as the pill rather than nothing.
 */
const TAP_AREA = " ".repeat(28)

/** The card shrinks to this pill over the last minute, as the design has it. */
const LAST_MINUTE_S = 60

/** The registered heading over a line, in the slab of a game the player is in. */
function registeredSlab(line: RenderNode, foot?: RenderNode): RenderNode {
  return nextFrame(
    [
      labelOverTime(
        inline([
          text(copy.REGISTERED, { style: "body.large.regular", color: "fg.primary" }),
          horizontalSpacer(6),
          text(copy.SEPARATOR, { style: "body.large.regular", color: "fg.secondary" }),
          horizontalSpacer(6),
          text(copy.NEXT_GAME, { style: "body.large.regular", color: "fg.secondary" }),
        ]),
        line,
      ),
    ],
    "bg.surface.container",
    foot,
  )
}

/**
 * The "Next game" slab of the design, a nested card in a 4px frame whose
 * colour is the state, with a line in the foot of the frame when there is one.
 *
 * The design keeps the line under the card inside the frame, 12px in from
 * it, so the card above it holds its shape whether or not it has one.
 */
function nextFrame(children: RenderNode[], frame: ColorToken, foot?: RenderNode | RenderNode[], footPadding = 12): RenderNode {
  const slab = column(children, [fill, pad(16), background("bg.surface.nested", 20)], { horizontalAlignment: "start" })
  return column(foot ? [slab, column([foot].flat(), [fill, pad(footPadding)], { horizontalAlignment: "start" })] : [slab], [fill, pad(4), background(frame, 24)], {
    horizontalAlignment: "start",
    verticalArrangement: "spaceBetween",
  })
}

/** The line of the foot, 12px as the design has it. */
function footLine(line: string, ink: ColorToken): RenderNode {
  return text(line, { style: "body.medium.regular", color: ink })
}
function registerFoot(notice: NonNullable<CardUi["notice"]>): RenderNode {
  if (!notice.status) return footLine(notice.text, "bg.surface.main")
  return footRow(BELL_OFF, notice.text)
}
function cameraFoot(busy: boolean): RenderNode {
  return footRow(CAMERA_OFF, copy.CAMERA_OFF, { label: copy.TURN_ON, action: ACTION_TURN_ON_CAMERA, busy })
}
/**
 * A picture and a line at the left, and a word that takes a tap at the right edge when there is one.
 *
 * A filled column here would leave the word no width on Android, which measures
 * the children of a row in order, so the flexible spacer does the pushing.
 */
function footRow(picture: { path: string; size: number }, line: string, tap?: { label: string; action: string; busy: boolean }): RenderNode {
  return row(
    [
      image(picture.path, [width(picture.size), height(picture.size)], "fill"),
      horizontalSpacer(8),
      column([text(line, { style: "body.small.regular", color: "fg.secondary" })], [width(FOOT_LINE_WIDTH)], { horizontalAlignment: "start" }),
      ...(tap
        ? [
            flexibleSpacer(),
            box([
              text(tap.label, { style: "body.large.regular", color: tap.busy ? "fg.tertiary" : "fg.warning" }),
              fixedWidth(compact(button(TAP_AREA, tap.action, "text", { enabled: !tap.busy })), FOOT_TAP_WIDTH),
            ]),
          ]
        : []),
    ],
    "start",
  )
}

/**
 * The card of the last minute, a pill with the seconds left in a dark ring.
 *
 * The ring is a padded column in the container colour, which stands in for the
 * 4px border of the design, since the host draws a border outside the shape.
 */
function lastMinutePill(secondsLeft: number): RenderNode {
  return column(
    [column([pill(copy.GAME_STARTS_IN(secondsLeft), "fg.warning", "bg.surface.main")], [pad(4), background("bg.surface.container", 28)])],
    [fill],
    { horizontalAlignment: "center" },
  )
}

/**
 * Children side by side with only the spacers between them.
 *
 * Space between drops the default spacing iOS puts between the children of a
 * row, and a row that does not fill has no room to spread them.
 */
function inline(children: RenderNode[]): RenderNode {
  return { tag: "Row", value: { modifiers: [], props: { verticalAlignment: "center", horizontalArrangement: "spaceBetween" }, children } }
}

/**
 * A pill with dark text that takes a tap, through a clear button laid over it.
 *
 * While the button loads, the host draws its spinner in the middle of the
 * pill, and with a `progress` the ring of that step stands there instead. The
 * spinner is what a busy card with no step shows, which is the card during the
 * ask for the camera. The label takes the colour of the pill under either, so
 * the pill keeps its size.
 */
function pillButton(
  label: string,
  action: string,
  fill: ColorToken,
  width: number,
  state: { enabled?: boolean; loading?: boolean; progress?: number } = {},
  look?: PillLook,
): RenderNode {
  const { progress, ...buttonState } = state
  const hidden = state.loading || progress !== undefined
  return box([
    fixedWidth(pill(label, fill, hidden ? fill : "bg.surface.main", look), width),
    ...(progress === undefined ? [] : [progressRing(progress)]),
    fixedWidth(compact(button(TAP_AREA, action, "text", buttonState)), width),
  ])
}

/** The baked ring nearest to `progress`, never empty and never full, since a full ring would say it is done. */
function progressRing(progress: number): RenderNode {
  const percent = progress * 100
  const step = SIGNUP_RING.steps.reduce((best, candidate) =>
    Math.abs(candidate.percent - percent) < Math.abs(best.percent - percent) ? candidate : best,
  )
  return image(step.path, [width(SIGNUP_RING.size), height(SIGNUP_RING.size)], "fill")
}

function pill(label: string, fill: ColorToken, ink: ColorToken, look: PillLook = DEFAULT_PILL): RenderNode {
  return column([text(label, { style: "title.medium.regular", color: ink })], [{ tag: "padding", value: look.padding }, background(fill, 24)], {
    horizontalAlignment: "center",
  })
}

function fixedWidth(node: RenderNode, width: number): RenderNode {
  if (node.tag === "Nil" || node.tag === "String") return node
  return { ...node, value: { ...node.value, modifiers: [...node.value.modifiers, { tag: "width", value: width }] } } as RenderNode
}

/** The bordered shell, which the older welcome card of the worker still uses. */
export { card }
