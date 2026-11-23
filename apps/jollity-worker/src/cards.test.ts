// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tests that `slotInputFor` turns what the worker knows into the question that
 * `gameSlot()` of src/card answers.
 *
 * They run with no host, no I/O and no clock. The faces themselves are tested
 * with the protocol. These check that the chain, the stored outcome and what
 * the app reports land on the right face. Importing ./index runs its module
 * code, but its boot guard skips `main()` under vitest.
 */
import { describe, expect, it } from "vitest"
import { ACTION_REGISTER, cardCopy, gameCardNode, gameSlot, IDLE_UI, INTRO, introRuleByPicture, type GameResults, type RenderNode } from "./card"
import { backfillOutcome, endedCard, humanitySignup, mergePrize, settledCard, signupUi, signupUiWithHumanity, slotInputFor, welcomeCard } from "./index"
import type { ChainRead, RunningGame } from "./chain"
import { UNSEEN, type Seen, type SeenGame, type StoredOutcome } from "./state"

function strings(node: RenderNode): string[] {
  if (node.tag === "String") return [node.value]
  if (node.tag === "Nil") return []
  if (node.tag === "Button") return [`[${node.value.props.text}]`]
  return node.value.children.flatMap(strings)
}

const PLAY = 1_800_000_000
const at = (secondsBeforePlay: number) => (PLAY - secondsBeforePlay) * 1000

function running(overrides: Partial<RunningGame> = {}): RunningGame {
  return {
    index: 7,
    phase: "registration",
    registrationStarts: PLAY - 90 - 2 * 3600,
    registrationEnds: PLAY - 90,
    gamePlayTime: PLAY,
    playEnds: PLAY + 144,
    reportingEnds: PLAY + 600,
    airdropsScheduled: 1,
    registered: false,
    drawOpen: true,
    ...overrides,
  }
}

function read(overrides: Partial<ChainRead> = {}): ChainRead {
  return { running: running(), upcoming: [], clockOffsetMs: 0, member: false, ...overrides }
}

const known = (overrides: Partial<SeenGame> = {}): SeenGame => ({
  index: 7,
  gamePlayTime: PLAY,
  airdropsScheduled: 1,
  endsAt: PLAY + 600,
  registered: true,
  memberBefore: false,
  ...overrides,
})

const RESULTS: GameResults = {
  endedAt: PLAY + 600,
  passed: true,
  collectables: null,
  prize: null,
  membership: { member: false, justBecameMember: false, gamesToMembership: 2 },
  seen: UNSEEN,
}

function slot(
  chainRead: (ChainRead & { gamesToMembership?: number | null }) | null,
  nowMs: number,
  games: SeenGame[] = [],
  outcome: StoredOutcome | null = null,
  seen: Seen = UNSEEN,
) {
  return gameSlot(slotInputFor({ gamePlayTime: PLAY }, chainRead, games, outcome, seen, nowMs))
}

describe("older card drawing works", () => {
  it("keeps drawing the welcome card where it was posted, with How it works", () => {
    // Given
    const welcome = welcomeCard()

    // When
    const drawn = strings(welcome)

    // Then
    expect(drawn).toContain("[How it works]")
  })

  it("draws a card from before the chain reads as ended", () => {
    // Given
    const ended = endedCard()

    // When
    const drawn = strings(ended)

    // Then
    expect(drawn).toEqual(["This game has ended."])
  })
})

describe("humanitySignup works", () => {
  const record = (phase: "registering" | "sent" | "registered" | "failed", gameIndex = 7) =>
    ({ gameIndex, phase, surface: "humanity" as const, at: 0, attempt: 1 })

  it("counts a sign-up Humanity has on the wire or landed as registered, for the card's own game", () => {
    expect(humanitySignup(record("sent"), 7)).toBe("registered")
    expect(humanitySignup(record("registered"), 7)).toBe("registered")
  })

  it("counts one between Humanity's tap and the broadcast as registering", () => {
    expect(humanitySignup(record("registering"), 7)).toBe("registering")
  })

  it("counts nothing after a failure, for another game, or without a record or an index", () => {
    expect(humanitySignup(record("failed"), 7)).toBeNull()
    expect(humanitySignup(record("sent", 8), 7)).toBeNull()
    expect(humanitySignup(null, 7)).toBeNull()
    expect(humanitySignup(record("sent"), undefined)).toBeNull()
  })

  it("marks Register busy while Humanity signs up, and leaves the chat's own sign-up its say", () => {
    expect(signupUiWithHumanity({ kind: "idle" }, "registering", 7, "register")).toEqual({ busy: true, notice: null })
    expect(signupUiWithHumanity({ kind: "idle" }, "registered", 7, "register")).toBe(IDLE_UI)
    expect(signupUiWithHumanity({ kind: "idle" }, null, 7, "register")).toBe(IDLE_UI)
    const busy = signupUiWithHumanity({ kind: "busy", gameIndex: 7, step: "sign" }, "registering", 7, "register")
    expect(busy).toEqual({ busy: true, notice: null })
    const failed = signupUiWithHumanity({ kind: "failed", gameIndex: 7, notice: "no" }, "registering", 7, "register")
    expect(failed.busy).toBe(false)
    expect(failed.notice?.text).toBe("no")
  })
})

describe("slotInputFor before the game works", () => {
  it("offers registration until registrationEnds, then closes it for the unregistered", () => {
    // Given
    const unregistered = read()

    // When
    const whileOpen = slot(unregistered, at(7200))
    const afterItCloses = slot(unregistered, at(60))

    // Then
    expect(whileOpen).toEqual({ kind: "register", startAt: PLAY, closesAt: PLAY - 90 })
    expect(afterItCloses).toEqual({ kind: "closed", startAt: PLAY })
  })

  it("hands the closed card the next game on the schedule", () => {
    // Given
    const after = { gamePlayTime: PLAY + 86_400, registrationStarts: PLAY + 600, registrationEnds: PLAY + 86_310, reportingEnds: PLAY + 87_000 }
    const scheduled = read({ upcoming: [after] })

    // When
    const closed = slot(scheduled, at(60))
    const open = slot(scheduled, at(7200))

    // Then
    expect(closed).toEqual({ kind: "closed", startAt: PLAY, nextStartAt: PLAY + 86_400 })
    expect(open).toEqual({ kind: "register", startAt: PLAY, closesAt: PLAY - 90 })
  })

  it("tells the card of the next game that the game before waits for results", () => {
    // Given
    const before = PLAY - 86_400
    const upcoming = [{ gamePlayTime: PLAY, registrationStarts: PLAY - 7200, registrationEnds: PLAY - 90, reportingEnds: PLAY + 600 }]
    const played = (overrides: Partial<RunningGame>) =>
      read({ running: running({ index: 6, gamePlayTime: before, playEnds: before + 144, reportingEnds: before + 600, registered: true, ...overrides }), upcoming })
    const nowMs = (before + 300) * 1000

    // When
    const settling = gameSlot(slotInputFor({ gamePlayTime: PLAY }, played({ phase: "settling" }), [], null, UNSEEN, nowMs))
    const reporting = gameSlot(slotInputFor({ gamePlayTime: PLAY }, played({ phase: "reporting" }), [], null, UNSEEN, nowMs))
    const stillPlaying = gameSlot(slotInputFor({ gamePlayTime: PLAY }, played({ phase: "reporting" }), [], null, UNSEEN, (before + 100) * 1000))
    const notSignedUp = gameSlot(slotInputFor({ gamePlayTime: PLAY }, played({ phase: "settling", registered: false }), [], null, UNSEEN, nowMs))
    const seenSignedUp = gameSlot(
      slotInputFor({ gamePlayTime: PLAY }, played({ phase: "settling", registered: null }), [known({ index: 6, gamePlayTime: before })], null, UNSEEN, nowMs),
    )

    // Then
    expect([settling, reporting, stillPlaying, notSignedUp, seenSignedUp].map((face) => "counting" in face && face.counting === true)).toEqual([
      true,
      true,
      false,
      false,
      true,
    ])
  })

  it("holds Register at Opening soon while the prize draw takes no entries", () => {
    // Given
    const closedDraw = read({ running: running({ drawOpen: false }) })
    const unknownDraw = read({ running: running({ drawOpen: null }) })

    // When
    const withClosedDraw = slot(closedDraw, at(7200))
    const withUnknownDraw = slot(unknownDraw, at(7200))

    // Then
    expect(withClosedDraw.kind).toBe("next")
    expect(withUnknownDraw.kind).toBe("register")
  })

  it("shows a registered player registered, then the countdown of the last five minutes", () => {
    // Given
    const registered = read({ running: running({ registered: true }) })

    // When
    const beforeTheCountdown = slot(registered, at(7200))
    const inTheCountdown = slot(registered, at(200))

    // Then
    expect(beforeTheCountdown).toEqual({ kind: "registered", startAt: PLAY })
    expect(inTheCountdown).toEqual({ kind: "starting", startAt: PLAY })
  })

  it("a false or unread registration keeps the card of a player the worker saw registered on Registered", () => {
    // Given
    const unread = read({ running: running({ registered: null }) })

    // When
    const kept = slot(unread, at(3600), [known({ registered: true })])
    const unknown = slot(unread, at(3600), [known({ registered: false })])
    const signedOut = slot(read({ running: running({ registered: false }) }), at(3600), [known({ registered: true })])

    // Then
    expect(kept.kind).toBe("registered")
    expect(unknown.kind).toBe("register")
    expect(signedOut.kind).toBe("registered")
  })

  it("keeps a played player's card pending when PlayerProcess resets the registration row", () => {
    // Given
    const started = PLAY - 300
    const settling = read({
      running: running({
        phase: "settling",
        registered: false,
        gamePlayTime: started,
        registrationEnds: started - 90,
        playEnds: started + 144,
        reportingEnds: started + 600,
      }),
    })
    const played = known({ gamePlayTime: started, endsAt: started + 600, registered: true })

    // When
    const face = gameSlot(slotInputFor({ gamePlayTime: started }, settling, [played], null, UNSEEN, PLAY * 1000))

    // Then
    expect(face.kind).toBe("pending")
  })

  it("keeps the card's confirmed seat in memory when its durable game record was not written", () => {
    // Given
    const seated = read({ running: running({ registered: true }) })
    const unread = read({ running: running({ registered: null }) })
    const first = slotInputFor({ gamePlayTime: PLAY }, seated, [], null, UNSEEN, at(3600))

    // When
    const second = gameSlot(slotInputFor({ gamePlayTime: PLAY }, unread, [], null, UNSEEN, at(3600), first.registered))

    // Then
    expect(second.kind).toBe("registered")
  })

  it("keeps a signed-up player registered while the prize draw takes no entries", () => {
    // Given
    const registeredBeforeTheDraw = read({ running: running({ registered: true, drawOpen: false }) })

    // When
    const face = slot(registeredBeforeTheDraw, at(7200))

    // Then
    expect(face.kind).toBe("registered")
  })

  it("switches to the countdown exactly five minutes out, and closes registration at registrationEnds", () => {
    // Given
    const registered = read({ running: running({ registered: true }) })
    const unregistered = read()

    // When
    const fiveMinutesOut = slot(registered, at(300))
    const justBefore = slot(registered, at(301))
    const atTheClose = slot(unregistered, at(90))
    const beforeTheClose = slot(unregistered, at(91))

    // Then
    expect(fiveMinutesOut.kind).toBe("starting")
    expect(justBefore.kind).toBe("registered")
    expect(atTheClose.kind).toBe("closed")
    expect(beforeTheClose.kind).toBe("register")
  })

  it("reads the time on the chain clock", () => {
    // Given
    const clocksInStep = read()
    const chainTenMinutesBehind = read({ clockOffsetMs: -600_000 })

    // When
    const inStep = slot(clocksInStep, at(60))
    const behind = slot(chainTenMinutesBehind, at(60))

    // Then
    expect(inStep.kind).toBe("closed")
    expect(behind.kind).toBe("register")
  })

  it("follows the window of the schedule while the chain has not created the game yet", () => {
    // Given
    const scheduled = read({
      running: null,
      upcoming: [{ gamePlayTime: PLAY, registrationStarts: PLAY - 3600, registrationEnds: PLAY - 90, reportingEnds: PLAY + 600 }],
    })

    // When
    const beforeItOpens = slot(scheduled, at(7200))
    const afterItOpens = slot(scheduled, at(1800))

    // Then
    expect(beforeItOpens).toEqual({ kind: "next", startAt: PLAY, opensAt: PLAY - 3600 })
    expect(afterItOpens.kind).toBe("register")
  })

  it("carries the games a candidate has left to membership onto the cards of a game ahead and its pending results", () => {
    // Given
    const candidate = { gamesToMembership: 3 }
    const registration = { ...read({ running: running({ phase: "registration" }) }), ...candidate }
    const settling = { ...read({ running: running({ phase: "settling", registered: true }) }), ...candidate }
    const upcoming = {
      ...read({ running: null, upcoming: [{ gamePlayTime: PLAY, registrationStarts: PLAY - 3600, registrationEnds: PLAY - 90, reportingEnds: PLAY + 600 }] }),
      ...candidate,
    }
    const unlisted = { ...read({ running: null }), ...candidate }
    const member = { ...read({ running: running({ phase: "registration" }) }), gamesToMembership: null }

    // When
    const ahead = slot(registration, at(1800))
    const pending = slot(settling, at(-900))
    const listedAhead = slot(upcoming, at(1800))
    const scheduledAhead = slot(unlisted, at(1800))
    const asMember = slot(member, at(1800))

    // Then
    expect(ahead).toMatchObject({ kind: "register", gamesToMembership: 3 })
    expect(pending).toEqual({ kind: "pending", endedAt: PLAY, resultsAt: PLAY + 600, gamesToMembership: 3 })
    expect(listedAhead).toMatchObject({ kind: "register", gamesToMembership: 3 })
    expect(scheduledAhead).toMatchObject({ gamesToMembership: 3 })
    expect(asMember).not.toHaveProperty("gamesToMembership")
  })

  it("says a candidate missed a game they never signed up for in the words it used before the count, while the game settles", () => {
    // Given
    const settling = { ...read({ running: running({ phase: "settling" }) }), gamesToMembership: 3 }

    // When
    const drawn = slot(settling, at(-900))

    // Then
    expect(drawn).toMatchObject({ kind: "missed", reason: "never-registered", gamesToMembership: null })
  })

  it("is cancelled when the chain cancels the game, or two reads in a row list it nowhere", () => {
    // Given
    const cancelledByTheChain = read({ running: running({ phase: "cancelled" }) })
    const listedNowhere = read({ running: null })

    // When
    const cancelled = slot(cancelledByTheChain, at(600))
    const unscheduled = gameSlot(slotInputFor({ gamePlayTime: PLAY }, listedNowhere, [], null, UNSEEN, at(3600), false, listedNowhere))

    // Then
    expect(cancelled).toEqual({ kind: "cancelled", startAt: PLAY })
    expect(unscheduled).toEqual({ kind: "cancelled", startAt: PLAY })
  })

  it("counts down to a game one read lists nowhere, since that read can be a gap", () => {
    // Given
    const listed = read()
    const listedNowhere = read({ running: null })

    // When
    const afterAGap = gameSlot(slotInputFor({ gamePlayTime: PLAY }, listedNowhere, [], null, UNSEEN, at(3600), false, listed))

    // Then
    expect(afterAGap.kind).not.toBe("cancelled")
  })
})

describe("slotInputFor after the game works", () => {
  it("keeps the way in for a registered player while the game plays, and waits while it settles", () => {
    // Given
    const registered = { registered: true }
    const playingRegistered = read({ running: running({ phase: "reporting", ...registered }) })
    const playingUnregistered = read({ running: running({ phase: "reporting" }) })
    const settlingRegistered = read({ running: running({ phase: "settling", ...registered }) })

    // When
    const wayIn = slot(playingRegistered, at(-30))
    const noWayIn = slot(playingUnregistered, at(-30))
    const waiting = slot(settlingRegistered, at(-900))

    // Then
    expect(wayIn.kind).toBe("starting")
    expect(noWayIn.kind).toBe("closed")
    expect(waiting).toEqual({ kind: "pending", endedAt: PLAY, resultsAt: PLAY + 600 })
  })

  it("keeps the way in from the play time until the last turn, then waits for the results", () => {
    // Given
    const reporting = read({ running: running({ phase: "reporting", registered: true }) })

    // When
    const atThePlayTime = slot(reporting, at(0))
    const duringTheLastTurn = slot(reporting, at(-143))
    const afterTheLastTurn = slot(reporting, at(-144))

    // Then
    expect(atThePlayTime.kind).toBe("starting")
    expect(duringTheLastTurn.kind).toBe("starting")
    expect(afterTheLastTurn).toEqual({ kind: "pending", endedAt: PLAY, resultsAt: PLAY + 600 })
  })

  it("waits on a past game the chain has let go when the player signed up for it", () => {
    // Given
    const later = read({ running: running({ index: 8, gamePlayTime: PLAY + 86_400 }) })
    const gamesSignedUp = [known()]
    const gamesNotSignedUp = [known({ registered: false })]

    // When
    const signedUp = slot(later, at(-3600), gamesSignedUp)
    const notSignedUp = slot(later, at(-3600), gamesNotSignedUp)

    // Then
    expect(signedUp.kind).toBe("pending")
    expect(notSignedUp.kind).toBe("missed")
  })

  it("draws a backfilled miss as never registered without pausing a membership, and a backfilled play as succeeded with Play again", () => {
    // Given
    const memberToday = read({ running: running({ index: 8, gamePlayTime: PLAY + 86_400 }), member: true })
    const skipped = backfillOutcome(7, PLAY, false)
    const attended = backfillOutcome(7, PLAY, true)

    // When
    const miss = slot(memberToday, at(-3600), [], skipped)
    const play = slot(memberToday, at(-3600), [], attended)
    const missLines = strings(gameCardNode(miss, IDLE_UI, PLAY + 3600))
    const playLines = strings(gameCardNode(play, IDLE_UI, PLAY + 3600))

    // Then
    expect(miss).toEqual({ kind: "missed", endedAt: PLAY, reason: "never-registered", member: false, membershipPaused: false, missesLeft: null, gamesToMembership: null })
    expect(play).toMatchObject({ kind: "results", results: { endedAt: PLAY } })
    expect(missLines).toEqual([cardCopy.GAME_ENDED, expect.any(String), cardCopy.MISSED])
    expect(playLines).toEqual(expect.arrayContaining([cardCopy.GAME_SUCCEEDED, cardCopy.PLAY_AGAIN]))
    expect(settledCard(skipped, UNSEEN)).toBe(true)
    expect(settledCard(attended, UNSEEN)).toBe(true)
  })

  it("draws the stored results, with what the app says the player has done", () => {
    // Given
    const nothingRunning = read({ running: null })
    const games = [known()]
    const outcome: StoredOutcome = { cancelled: false, results: RESULTS, gamesToMembership: 2 }
    const seen = { chest: true, draw: false }

    // When
    const drawn = slot(nothingRunning, at(-3600), games, outcome, seen)

    // Then
    expect(drawn).toEqual({ kind: "results", results: { ...RESULTS, endedAt: PLAY, seen } })
  })

  it("draws the stored results over a stale sign-up flag", () => {
    // Given
    const nothingRunning = read({ running: null })
    const games = [known({ registered: false })]
    const outcome: StoredOutcome = { cancelled: false, results: RESULTS, gamesToMembership: 2, gameIndex: 7, registered: false, memberBefore: false }

    // When
    const drawn = slot(nothingRunning, at(-3600), games, outcome)

    // Then
    expect(drawn).toEqual({ kind: "results", results: { ...RESULTS, endedAt: PLAY } })
  })

  it("draws the collectables a player who played but did not pass earned", () => {
    // Given
    const nothingRunning = read({ running: null })
    const outcome: StoredOutcome = { cancelled: false, results: null, gamesToMembership: 2, gameIndex: 7, registered: true, earned: 2 }

    // When
    const reportedByTheChain = slot(nothingRunning, at(-3600), [known()], { ...outcome, reported: true })
    const reportedByTheApp = slot(nothingRunning, at(-3600), [known()], outcome, { ...UNSEEN, report: true })

    // Then
    expect(reportedByTheChain).toMatchObject({ kind: "missed", reason: "not-passed", earned: 2 })
    expect(reportedByTheApp).toMatchObject({ kind: "missed", reason: "not-passed", earned: 2 })
  })

  it("draws a stored miss with the count of the chain, and pauses only a member the chain suspended", () => {
    // Given
    const nothingRunning = read({ running: null })
    const outcome: StoredOutcome = { cancelled: false, results: null, gamesToMembership: 3 }
    const seenAsNonMember = [known()]
    const seenAsMember = [known({ memberBefore: true })]

    // When
    const nonMember = slot(nothingRunning, at(-3600), seenAsNonMember, outcome)
    const member = slot(nothingRunning, at(-3600), seenAsMember, { ...outcome, paused: false, missesLeft: 3 })
    const suspended = slot(nothingRunning, at(-3600), seenAsMember, { ...outcome, paused: true, missesLeft: null })
    const olderOutcome = slot(nothingRunning, at(-3600), seenAsMember, outcome)

    // Then
    expect(nonMember).toMatchObject({
      kind: "missed",
      reason: "no-show",
      gamesToMembership: 3,
      membershipPaused: false,
    })
    expect(member).toMatchObject({ member: true, membershipPaused: false, missesLeft: 3 })
    expect(suspended).toMatchObject({ member: true, membershipPaused: true, missesLeft: null })
    expect(olderOutcome).toMatchObject({ member: true, membershipPaused: false, missesLeft: null })
  })

  it("draws a stored miss as not passed when the app says the report landed", () => {
    // Given
    const nothingRunning = read({ running: null })
    const outcome: StoredOutcome = { cancelled: false, results: null, gamesToMembership: 3 }
    const reported: Seen = { chest: true, draw: true, report: true }

    // When
    const face = slot(nothingRunning, at(-3600), [known()], outcome, reported)

    // Then
    expect(face).toMatchObject({ kind: "missed", reason: "not-passed", gamesToMembership: 3 })
  })

  it("draws a stored miss as not passed when the chain held the report", () => {
    // Given
    const nothingRunning = read({ running: null })
    const outcome: StoredOutcome = { cancelled: false, results: null, gamesToMembership: 3, reported: true }

    // When
    const face = slot(nothingRunning, at(-3600), [known()], outcome, UNSEEN)

    // Then
    expect(face).toMatchObject({ kind: "missed", reason: "not-passed", gamesToMembership: 3 })
  })

  it("draws an old miss with the sign-up and membership stored with it", () => {
    // Given
    const outcome: StoredOutcome = { cancelled: false, results: null, gamesToMembership: 3, gameIndex: 7, registered: true, memberBefore: false }
    const memberNow = read({ running: null, member: true })

    // When
    const face = slot(memberNow, at(-30 * 86_400), [], outcome)

    // Then
    expect(face).toMatchObject({ kind: "missed", reason: "no-show", membershipPaused: false })
  })

  it("draws a stored cancellation as cancelled", () => {
    // Given
    const nothingRunning = read({ running: null })
    const games = [known()]
    const outcome: StoredOutcome = { cancelled: true, results: null, gamesToMembership: null }

    // When
    const drawn = slot(nothingRunning, at(-3600), games, outcome)

    // Then
    expect(drawn.kind).toBe("cancelled")
  })

  it("keeps the circles of a stored cancellation of a candidate", () => {
    // Given
    const nothingRunning = read({ running: null })
    const outcome: StoredOutcome = { cancelled: true, results: null, gamesToMembership: 3 }

    // When
    const drawn = slot(nothingRunning, at(-3600), [known()], outcome)

    // Then
    expect(drawn).toEqual({ kind: "cancelled", startAt: PLAY, gamesToMembership: 3 })
  })
})

describe("slotInputFor without a chain read fails", () => {
  it("counts down on the guess rather than calling the game cancelled", () => {
    // Given
    const noChainRead = null

    // When
    const guessed = slot(noChainRead, at(600))

    // Then
    expect(guessed.kind).toBe("register")
  })
})

describe("prize merging works", () => {
  const WIN = { amountUsd: 200, ticket: "ab", drawAt: PLAY + 3600, phase: "drawn" as const, won: true, claimable: true }

  it("keeps a win once the claim removes its row", () => {
    // Given
    const claimed = { ...WIN, ticket: "", won: false, claimable: false }

    // When
    const merged = mergePrize(WIN, claimed)

    // Then
    expect(merged).toEqual({ ...WIN, claimable: false })
  })

  it("keeps the amount, the time and the win once the draw is gone", () => {
    // Given
    const gone = { amountUsd: 0, ticket: "", drawAt: PLAY + 600, phase: "over" as const, won: false, claimable: false }

    // When
    const merged = mergePrize(WIN, gone)

    // Then
    expect(merged).toEqual({ ...WIN, phase: "over", claimable: false })
  })

  it("keeps a confirmed claim through later readings", () => {
    // Given
    const claimed = { ...WIN, claimable: false, claimed: true }
    const later = { ...WIN, ticket: "", won: false, claimable: false }

    // When
    const merged = mergePrize(claimed, later)

    // Then
    expect(merged).toEqual(claimed)
  })

  it("takes a fresh reading for a ticket that had not won", () => {
    // Given
    const waiting = { ...WIN, phase: "waiting" as const, won: false, claimable: false }

    // When
    const merged = mergePrize(waiting, WIN)

    // Then
    expect(merged).toEqual(WIN)
  })

  it("closes a stored prize whose draw the chain no longer lists", () => {
    // Given
    const noDraw = null

    // When
    const merged = mergePrize(WIN, noDraw)

    // Then
    expect(merged).toEqual({ ...WIN, phase: "over", claimable: false })
  })
})

describe("sign-up on the card works", () => {
  it("marks Register busy while the sign-up goes and says what failed, on the card of that game alone", () => {
    // Given
    // When
    const busy = signupUi({ kind: "busy", gameIndex: 7, step: "route" }, 7)
    const failed = signupUi({ kind: "failed", gameIndex: 7, notice: "Couldn't sign you up." }, 7)
    const quiet = [signupUi({ kind: "busy", gameIndex: 7, step: "route" }, 8), signupUi({ kind: "sent", gameIndex: 7 }, 7), signupUi({ kind: "idle" }, 7)]

    // Then
    expect(busy).toEqual({ busy: true, notice: null })
    expect(failed).toEqual({ busy: false, notice: { text: "Couldn't sign you up.", tone: "fg.error" } })
    expect(quiet).toEqual([IDLE_UI, IDLE_UI, IDLE_UI])
  })
})

describe("the face of a blocked sign-up works", () => {
  it("is drawn from what the sign-up needs, and not from the words of its notice", () => {
    // Given
    const notice = cardCopy.NOTIFICATIONS_REQUIRED

    // When
    const needing = signupUi({ kind: "failed", gameIndex: 7, notice, needs: "notifications" }, 7, "register")
    const plain = signupUi({ kind: "failed", gameIndex: 7, notice }, 7, "register")

    // Then
    expect(needing.notice).toEqual({ text: notice, blocked: true, tone: "fg.error" })
    expect(plain.notice).toEqual({ text: notice, tone: "fg.error" })
  })

  it("turns Register off under a username nobody owns", () => {
    // When
    const unowned = signupUi({ kind: "failed", gameIndex: 7, notice: cardCopy.NAME_UNOWNED, needs: "username" }, 7, "register", true)

    // Then
    expect(unowned.notice).toEqual({ text: cardCopy.NAME_UNOWNED, tone: "fg.error", registerOff: true })
    expect(cardCopy.NAME_UNOWNED).toBe("Your username isn't registered. Open your membership card to set it up.")
  })

  it("turns Register off in a host too old to remind, since no tap there can sign up", () => {
    // When
    const outdated = signupUi({ kind: "failed", gameIndex: 7, notice: cardCopy.REMINDERS_UNSUPPORTED, needs: "update" }, 7, "register")

    // Then
    expect(outdated.notice).toEqual({ text: cardCopy.REMINDERS_UNSUPPORTED, tone: "fg.error", registerOff: true })
    expect(cardCopy.REMINDERS_UNSUPPORTED).toBe("Update to new version to join game.")
  })

  it("keeps Register to tap again after a sign-up that failed with nothing to wait on", () => {
    // Given
    const failed = { kind: "failed" as const, gameIndex: 7, notice: cardCopy.SIGN_UP_FAILED }

    // When
    const node = gameCardNode({ kind: "register", startAt: PLAY, closesAt: PLAY - 300 }, signupUi(failed, 7, "register"), PLAY - 1200)

    // Then
    expect(strings(node)).toContain(cardCopy.SIGN_UP_FAILED)
    expect(JSON.stringify(node)).toContain('"clickAction":"jollity.register"')
  })

  it("gives Register back once the name gate no longer finds the username unowned", () => {
    // Given
    const stopped = { kind: "failed" as const, gameIndex: 7, notice: cardCopy.NAME_UNOWNED, needs: "username" as const }

    // When
    const owned = signupUi(stopped, 7, "register", false)

    // Then
    expect(owned).toEqual(IDLE_UI)
  })

  it("asks for nothing on the closed face, where turning the notifications on cannot help, and still says the tap came late", () => {
    // Given
    const needing = { kind: "failed" as const, gameIndex: 7, notice: cardCopy.NOTIFICATIONS_REQUIRED, needs: "notifications" as const }
    const late = { kind: "failed" as const, gameIndex: 7, notice: cardCopy.REGISTRATION_CLOSED_NOTICE }

    // When
    const onClosed = signupUi(needing, 7, "closed")
    const lateOnClosed = signupUi(late, 7, "closed")

    // Then
    expect(onClosed).toEqual(IDLE_UI)
    expect(lateOnClosed.notice).toEqual({ text: cardCopy.REGISTRATION_CLOSED_NOTICE, tone: "fg.error" })
  })
})

describe("sign-up on the card of a registered player works", () => {
  it("draws no failed sign-up under the slab once the player is registered", () => {
    // Given: the chat's own sign-up failed while the app's landed
    const failed = { kind: "failed" as const, gameIndex: 7, notice: cardCopy.SIGN_UP_FAILED }

    // When
    const faces = (["registered", "starting", "pending"] as const).map((kind) => signupUi(failed, 7, kind))
    const node = gameCardNode({ kind: "registered", startAt: PLAY }, signupUi(failed, 7, "registered"), PLAY - 600)
    const onRegister = signupUi(failed, 7, "register")

    // Then
    expect(faces).toEqual([IDLE_UI, IDLE_UI, IDLE_UI])
    expect(strings(node)).not.toContain(cardCopy.SIGN_UP_FAILED)
    expect(onRegister.notice).toEqual({ text: cardCopy.SIGN_UP_FAILED, tone: "fg.error" })
  })
})

describe("finding an intro rule by its picture works", () => {
  it("finds every rule that has a picture by the path of that picture", () => {
    // Given
    const pictured = INTRO.filter((rule) => rule.image)

    // When
    const found = pictured.map((rule) => introRuleByPicture(rule.image!.path))

    // Then
    expect(found).toEqual(pictured)
  })

  it.each([
    ["a path no rule names", "chat-intro/gone.png"],
    ["a number", 0],
    ["nothing", undefined],
  ])("finds nothing for %s", (_label, path) => {
    // When
    const found = introRuleByPicture(path)

    // Then
    expect(found).toBeNull()
  })
})

describe("the slider of Register works", () => {
  type Slide = Extract<RenderNode, { tag: "Slider" }>
  const slot = { kind: "register" as const, startAt: PLAY, closesAt: PLAY - 90 }
  const now = PLAY - 3600

  function find(node: RenderNode, tag: RenderNode["tag"]): RenderNode[] {
    if (node.tag === "Nil" || node.tag === "String") return []
    return [...(node.tag === tag ? [node] : []), ...node.value.children.flatMap((child) => find(child, tag))]
  }

  it("draws the worker's own slider, with the time on its second line, in place of the Register pill", () => {
    // When
    const node = gameCardNode(slot, IDLE_UI, now, { slide: true })

    // Then
    const [slide] = find(node, "Slider") as Slide[]
    expect(find(node, "Button")).toEqual([])
    expect(slide!.value.props).toEqual({
      text: cardCopy.SLIDE_TO_REGISTER,
      secondaryText: strings(gameCardNode(slot, IDLE_UI, now))[1],
      enabled: true,
      loading: false,
      confirmed: false,
      action: ACTION_REGISTER,
    })
  })

  it("docked with nothing under it, is the footer itself: the slider alone, 80 tall and 8 from each side", () => {
    // When
    const node = gameCardNode(slot, IDLE_UI, now, { slide: true, docked: true })

    // Then
    expect(node.tag).toBe("Slider")
    expect(node.tag === "Slider" && node.value.modifiers).toEqual([
      { tag: "fillWidth", value: true },
      { tag: "height", value: 80 },
      { tag: "padding", value: [0, 8, 0, 8] },
    ])
  })

  it("sends the same action as the Register button it falls back to", () => {
    // When
    const [pill] = find(gameCardNode(slot, IDLE_UI, now), "Button")
    const [slide] = find(gameCardNode(slot, IDLE_UI, now, { slide: true }), "Slider") as Slide[]

    // Then
    expect(pill!.tag === "Button" && pill!.value.props.clickAction).toBe(slide!.value.props.action)
  })

  it("loads and takes no slide while the sign-up is busy", () => {
    // When
    const [slide] = find(gameCardNode(slot, { busy: true, notice: null }, now, { slide: true }), "Slider") as Slide[]

    // Then
    expect(slide!.value.props).toMatchObject({ loading: true, action: undefined })
  })

  it("keeps the pill where Register is off or blocked, whose look says why", () => {
    // Given
    const off = { busy: false, notice: { text: cardCopy.NAME_UNOWNED, tone: "fg.error" as const, registerOff: true } }
    const blocked = { busy: false, notice: { text: cardCopy.NOTIFICATIONS_REQUIRED, blocked: true as const, tone: "fg.error" as const } }

    // When / Then
    for (const ui of [off, blocked]) {
      expect(find(gameCardNode(slot, ui, now, { slide: true }), "Slider")).toEqual([])
      expect(gameCardNode(slot, ui, now, { slide: true })).toEqual(gameCardNode(slot, ui, now))
    }
  })
})
