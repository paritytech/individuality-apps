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
 * Before the game, the card is the Party clock of DIM2: a nested card in a
 * frame of the container colour, with a circle for each game left to
 * membership along the top. The words, and the button where there is one,
 * carry the state. Before the window opens the button is there in grey, so the
 * card holds its shape when it goes live. While the results are pending, the
 * same frame holds the votes on the player, with no circles.
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
import { formatCountdown, formatGameDate, formatGameTime, formatPrize, formatPrizeAmount, prizeUnit } from "./format"
import { payoff, type GameResults, type GameSlot, type Payoff, type SlotCollectable } from "./game-slot"
import { claimRefusalWords } from "@jollity/protocol"
import { type ClaimFailure } from "@individuality/prize"
import { JOIN_LEAD_S } from "@individuality/sign-up/reminder"

/** The transient state of a card, whether a tap is in flight and the notice under it. */
export interface CardUi {
  busy: boolean
  notice: {
    text: string
    /** The host or the phone refuses the reminders of the game, which draws the bell line in the foot. */
    blocked?: true
    tone: "fg.secondary" | "fg.warning" | "fg.error"
    /** I'll be there stays greyed out and takes no tap while the notice holds */
    registerOff?: boolean
  } | null
  /** Set when the stored answer is a refusal, which draws the camera line. */
  camera?: "off"
}

export const IDLE_UI: CardUi = { busy: false, notice: null }

/**
 * The steps of a sign-up from the chat, in order.
 *
 * The name is the wait on the name link (./name-gate.ts), usually done before
 * the tap. The bind comes only for a lite person who needs one. The draws are the wait
 * for the prize draw to open, which the engine spends a block at a time, and
 * the sign is the proof and the signature the host asks for.
 */
export type SignupStep = "reminders" | "name" | "signer" | "route" | "bind" | "draws" | "sign"

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
const BELL_OFF = { path: "chat-card/bell-off.png", size: 16 }
const CAMERA_OFF = { path: "chat-card/camera-off.png", size: 16 }
// The ticket of a won draw is the rainbow of the design with a notch cut out
// of each side, baked by apps/jollity-app/scripts/bake-prize-ticket.mjs at the width of the
// card of the design and stretched to the width of this one.
const TICKET = { path: "chat-card/prize-ticket.png", height: 136 }
// The host draws no icon, so the tick of a vote that is in is a picture,
// baked by apps/jollity-app/scripts/bake-vote-tick.mjs in the ink of the main
// surface, which does not follow a light theme.
const VOTE_TICK = { path: "chat-card/vote-tick.png", size: 16 }
// The CASH wordmark beside a won amount, as the app draws it (#431): the host
// draws text in its own typeface only, so it is baked by
// apps/jollity-app/scripts/bake-cash-wordmark.mjs as one line of the amount, and centred in
// the row it sits on the amount's baseline.
const CASH_WORDMARK = { path: "chat-card/cash-wordmark.png", width: 43, height: 32 }

const FOOT_TAP_WIDTH = 56
// Fits either line of a foot row on one line. iOS would wrap a line sized by
// its text beside a flexible spacer, and Android gives a filled one all the width.
const FOOT_LINE_WIDTH = 192
const BLOCKED_FOOT_PADDING = 8
const CIRCLE_HOLE = 10
const CIRCLE_RING = 2
const CIRCLE_DOT = 4
const CIRCLE_GAP = 5
// Six circles and the caption still fit one row on a 375pt iPhone, and the count says the rest.
const MAX_CIRCLES = 6
// Fits the count of games on one line at body.small on iOS, which measured about
// 133 with one digit and 141 with two, for the same reason as FOOT_LINE_WIDTH.
const GAMES_CAPTION_WIDTH = 168
const LIVE_DOT = 8
// The votes on the player show as tenths of the most that can come, so vote weights read as a share.
const VOTES_OF = 10
const VOTE_CIRCLE = 26
const VOTE_RING = 2

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
   * A design exploration that shows a countdown to the game on the sign-up
   * face where the date is.
   *
   * Both looks are kept for now. Pick one and delete this, since the worker
   * never sets it.
   */
  registerCountdown?: boolean
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
   * Whether the host draws a slide to confirm, so I'll be there is a slide
   * rather than a tap. The worker sets it only for a host it knows draws one
   * (`drawsSlideToConfirm` in src/renderer.ts); every other host gets the
   * I'll be there button, which sends the same action.
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
    case "cancelled":
      return column([endedBox(copy.GAME_CANCELLED, slot.startAt)], frame, { horizontalAlignment: "center" })

    // The worker posts a card per game, so no card is ever drawn without one.
    case "none":
      return nil()

    case "next":
      return openingSoon(slot.startAt, { gamesLeft: slot.gamesToMembership, counting: slot.counting })

    case "register": {
      const blocked = ui.notice?.blocked === true
      const off = Boolean(ui.notice?.registerOff)
      const notice = ui.notice ? registerFoot(ui.notice) : undefined
      const date = options.registerCountdown ? formatCountdown(slot.startAt, nowSeconds) : formatGameTime(slot.startAt)
      // The slide stands in for the label, the time and the button: it says the
      // time on its second line. A blocked or greyed-out sign-up keeps the
      // button, whose look carries why, and the slide shows no fill of progress,
      // only the loading state of the host.
      if (options.slide === true && !blocked && !off)
        return partyClock(
          [
            slideToConfirm(copy.SLIDE_TO_REGISTER, ACTION_REGISTER, {
              secondaryText: date,
              confirmedText: copy.REGISTERED,
              accent: "fg.warning",
              loading: ui.busy,
            }),
          ],
          { gamesLeft: slot.gamesToMembership, counting: slot.counting, foot: notice },
        )
      // The tap shows Left to join at once, and a sign-up that fails puts Register back with its notice.
      if (ui.busy && !blocked && !off) return withNotice(leftToJoin(slot.startAt, nowSeconds, { gamesLeft: slot.gamesToMembership, counting: slot.counting }), ui)
      return partyClock(
        [
          ...heading(copy.NEXT_GAME, date),
          spacer(12),
          off
            ? actionPill(copy.ILL_BE_THERE, "bg.surface.container", "fg.tertiary")
            : actionPill(copy.ILL_BE_THERE, "fg.warning", "bg.surface.main", ACTION_REGISTER),
        ],
        {
          gamesLeft: slot.gamesToMembership,
          counting: slot.counting,
          foot: notice && blocked && ui.camera === "off" ? [notice, cameraFoot(ui.busy)] : notice,
          footPadding: blocked ? BLOCKED_FOOT_PADDING : undefined,
        },
      )
    }

    // Before the join, a minute ahead of the start, the card counts down with
    // no button, to the moment the pill of the host counts to. Start playing
    // is the way in from then on.
    case "starting": {
      const progress = { gamesLeft: slot.gamesToMembership, counting: slot.counting }
      if (nowSeconds < slot.startAt - JOIN_LEAD_S) return withNotice(leftToJoin(slot.startAt, nowSeconds, progress), ui)
      return withNotice(
        partyClock(
          [
            ...heading(liveNow(), dateLine(slot.startAt, "fg.warning")),
            spacer(12),
            actionPill(copy.START_PLAYING, "fg.primary", "bg.surface.main", ACTION_OPEN_GAME),
          ],
          progress,
        ),
        ui,
      )
    }

    case "registered":
      return withNotice(
        leftToJoin(slot.startAt, nowSeconds, {
          gamesLeft: slot.gamesToMembership,
          counting: slot.counting,
          foot: ui.camera === "off" ? cameraFoot(ui.busy) : undefined,
        }),
        ui,
      )

    // The game after, where the chain lists one, since nothing is left to tap
    // for this one. Without it, Registration closed where the date was.
    case "closed":
      if (slot.nextStartAt !== undefined) return withNotice(openingSoon(slot.nextStartAt, { gamesLeft: slot.gamesToMembership, counting: slot.counting }), ui)
      return withNotice(partyClock(heading(copy.NEXT_GAME, copy.REGISTRATION_CLOSED), { gamesLeft: slot.gamesToMembership, counting: slot.counting, off: true }), ui)

    case "pending": {
      const votingEnds = slot.resultsAt !== undefined && nowSeconds < slot.resultsAt ? formatCountdown(slot.resultsAt, nowSeconds) : null
      return column([partyClock(
        [
          text(copy.VOTES_COMING, { style: "body.large.regular", color: "fg.primary" }),
          ...(slot.votes ? [spacer(12), votesRow(slot.votes)] : []),
          ...(votingEnds === null ? [] : [spacer(12), text(copy.VOTING_ENDS(votingEnds), { style: "body.large.regular", color: "fg.secondary" })]),
        ],
      )], frame)
    }

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
 * The count comes from the claims and the tiles from the collectables screen, which the
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
 * spaces that cover most of the pill rather than nothing.
 */
const TAP_AREA = " ".repeat(28)
/** The same for the button across the slab, about 261pt of spaces, so the ends of a wider pill take no tap on iOS. */
const ACTION_TAP_AREA = " ".repeat(60)

/**
 * The Party clock of the design: a nested card in a frame of the container
 * colour, a circle for each game still between a candidate and membership
 * along the top of the frame, and a line in its foot when there is one.
 *
 * The frame carries no state colour: the words and the button of the card
 * do. A member, or a player whose games are unknown, gets no circles.
 */
function partyClock(
  content: RenderNode[],
  options: { gamesLeft?: number | null; caption?: (count: number) => string; counting?: boolean; off?: boolean; foot?: RenderNode | RenderNode[]; footPadding?: number } = {},
): RenderNode {
  const games = options.gamesLeft ? gamesRow(options.gamesLeft, options) : null
  const slab = column(content, [fill, pad(16), background("bg.surface.nested", 20)], { horizontalAlignment: "start", verticalArrangement: "spaceBetween" })
  const foot = options.foot ? column([options.foot].flat(), [fill, pad(options.footPadding ?? 12)], { horizontalAlignment: "start" }) : null
  return column([games, slab, foot].filter((node) => node !== null), [fill, pad(4), background("bg.surface.container", 24)], {
    horizontalAlignment: "start",
    verticalArrangement: "spaceBetween",
  })
}

/** The label over the big line of the card, a date, a countdown or a verdict. */
function heading(label: string | RenderNode, line: string | RenderNode): RenderNode[] {
  return [
    typeof label === "string" ? text(label, { style: "body.large.regular", color: "fg.secondary" }) : label,
    spacer(2),
    typeof line === "string" ? text(line, { style: "title.medium.regular", color: "fg.primary" }) : line,
  ]
}

function openingSoon(startAt: number, options: Parameters<typeof partyClock>[1]): RenderNode {
  return partyClock([...heading(copy.NEXT_GAME, dateLine(startAt)), spacer(12), actionPill(copy.OPENING_SOON, "bg.surface.container", "fg.tertiary")], options)
}

function leftToJoin(startAt: number, nowSeconds: number, options: Parameters<typeof partyClock>[1]): RenderNode {
  return partyClock(heading(copy.LEFT_TO_JOIN, formatCountdown(startAt - JOIN_LEAD_S, nowSeconds)), { ...options, caption: copy.GAMES_LEFT })
}

function votesRow(votes: { received: number; most: number }): RenderNode {
  const tenthsIn = votes.most > 0 ? Math.min(VOTES_OF, Math.floor((votes.received * VOTES_OF) / votes.most)) : 0
  return row(Array.from({ length: VOTES_OF }, (_, i) => (i < tenthsIn ? voteIn() : voteToCome())))
}

function voteToCome(): RenderNode {
  const hole = VOTE_CIRCLE - 2 * VOTE_RING
  return column([column([spacer(hole)], [width(hole), height(hole), background("bg.surface.nested", hole / 2)])], [
    pad(VOTE_RING),
    background("fg.tertiary", VOTE_CIRCLE / 2),
  ])
}

function voteIn(): RenderNode {
  return box([filledDot(VOTE_CIRCLE, "fg.warning"), image(VOTE_TICK.path, [width(VOTE_TICK.size), height(VOTE_TICK.size)], "fill")])
}

/** The date of a game, in the size of every line under the label. */
function dateLine(startAt: number, color: ColorToken = "fg.primary"): RenderNode {
  return text(formatGameTime(startAt), { style: "title.medium.regular", color })
}

/**
 * The circles of the games left, with how many in words at the right.
 *
 * While the results of a game are pending, its circle holds a dot and the
 * words go, since the count changes once the results land.
 */
function gamesRow(gamesLeft: number, look: { caption?: (count: number) => string; counting?: boolean; off?: boolean }): RenderNode {
  const ink: ColorToken = look.off ? "fg.tertiary" : "fg.secondary"
  const circles = Array.from({ length: Math.min(gamesLeft, MAX_CIRCLES) }, (_, i) =>
    look.counting && i === 0 ? circle("fg.warning", true) : circle(ink, false),
  )
  return row(
    [
      inline(circles.flatMap((node, i) => (i === 0 ? [node] : [horizontalSpacer(CIRCLE_GAP), node]))),
      ...(look.counting ? [] : [
            flexibleSpacer(),
            column([text((look.caption ?? copy.GAMES_TO_MEMBERSHIP)(gamesLeft), { style: "body.small.regular", color: ink })], [width(GAMES_CAPTION_WIDTH)], {
              horizontalAlignment: "end",
            }),
          ]),
    ],
    "start",
    [fill, { tag: "padding", value: [4, 12, 6, 12] }],
  )
}

/**
 * A ring, with a dot in it when `dot`.
 *
 * The host draws a border outside the shape, so the ring is a padded circle
 * in its colour around one in the colour of the frame.
 */
function circle(ink: ColorToken, dot: boolean): RenderNode {
  const hole = column(dot ? [filledDot(CIRCLE_DOT, ink)] : [spacer(CIRCLE_HOLE)], [
    width(CIRCLE_HOLE),
    height(CIRCLE_HOLE),
    background("bg.surface.container", CIRCLE_HOLE / 2),
  ])
  return column([hole], [pad(CIRCLE_RING), background(ink, CIRCLE_HOLE / 2 + CIRCLE_RING)])
}

function filledDot(size: number, ink: ColorToken): RenderNode {
  return column([spacer(size)], [width(size), height(size), background(ink, size / 2)])
}

/** The red dot and Live now, over the start of a game that has begun. */
function liveNow(): RenderNode {
  return inline([
    filledDot(LIVE_DOT, "fg.error"),
    horizontalSpacer(6),
    text(copy.LIVE_NOW, { style: "body.large.regular", color: "fg.primary" }),
  ])
}

/** The line of the foot, 12px as the design has it. */
function footLine(line: string, ink: ColorToken): RenderNode {
  return text(line, { style: "body.medium.regular", color: ink })
}
function registerFoot(notice: NonNullable<CardUi["notice"]>): RenderNode {
  if (!notice.blocked) return footLine(notice.text, notice.tone)
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
 * Children side by side with only the spacers between them.
 *
 * Space between drops the default spacing iOS puts between the children of a
 * row, and a row that does not fill has no room to spread them.
 */
function inline(children: RenderNode[]): RenderNode {
  return { tag: "Row", value: { modifiers: [], props: { verticalAlignment: "center", horizontalArrangement: "spaceBetween" }, children } }
}

/**
 * The button of the card, a pill across the slab, with dark text, that takes a
 * tap through a clear button laid over it when given an action.
 */
function actionPill(label: string, tone: ColorToken, ink: ColorToken, action?: string): RenderNode {
  const face = pill(label, tone, ink)
  if (!action) return face
  return box([face, button(ACTION_TAP_AREA, action, "text")], [fill])
}

function pill(label: string, tone: ColorToken, ink: ColorToken): RenderNode {
  return column([text(label, { style: "title.medium.regular", color: ink })], [fill, { tag: "padding", value: [12, 16, 12, 16] }, background(tone, 24)], {
    horizontalAlignment: "center",
  })
}

function fixedWidth(node: RenderNode, width: number): RenderNode {
  if (node.tag === "Nil" || node.tag === "String") return node
  return { ...node, value: { ...node.value, modifiers: [...node.value.modifiers, { tag: "width", value: width }] } } as RenderNode
}

/** The bordered shell, which the older welcome card of the worker still uses. */
export { card }
