// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Member home — the Humanity card home screen, and the whole of the
 *  onboarding: a person lands on the real screen with one verb and learns
 *  the product by using it. Every state renders, in this order: the card
 *  (only when the debug panel's card toggle shows it — by default the host
 *  draws the card in its Pocket from the worker and this screen opens
 *  beneath it), the line under it, the next game (the one verb), the story
 *  ladder while there is a rung left to climb, and a member's rows. Blocks
 *  that have nothing to say return null. Everything shown comes from chain
 *  reads; no fake timestamps, balances, dates, or product data. */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { animate, stagger, type AnimationPlaybackControlsWithThen } from "motion";

import { Screen } from "@shared/components/chrome.tsx";
import { placeAt, showSettled, useReducedMotion } from "@shared/hooks/motion.ts";
import { power3InOut, power3Out } from "@shared/motion/ease.ts";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";
import type { SuspensionRecovery } from "@features/card/domain/suspension-recovery.ts";
import { useRegisterForGame } from "@features/card/hooks/use-register-for-game.ts";
import { useDebugStore } from "@features/debug/debug-store.ts";
import { MemberCard } from "./MemberCard.tsx";
import { DailyDollarTile, NameClaimRow, UnderCard } from "./home-blocks.tsx";
import { JourneyStory } from "./JourneyStory.tsx";
import { AttendanceRow } from "./AttendanceRow.tsx";
import { WeeklyGameBlock } from "./WeeklyGameBlock.tsx";
import { OnboardingHint } from "./OnboardingHint.tsx";
import { CautionSheet } from "./CautionSheet.tsx";
import { openGame } from "@features/card/domain/game-link.ts";
import {
  answerCautionSheet,
  readCautionSheetAnswered,
} from "@features/card/storage/caution-sheet-store.ts";
import { useOnboardingHint } from "@features/card/hooks/use-onboarding-hint.ts";
import type { OnboardingHintId } from "@features/card/storage/onboarding-hints-store.ts";
import { onboardingHintCopy } from "@features/card/domain/onboarding-hints.ts";
import { resolveWeeklyGameView } from "@features/card/domain/weekly-game-view.ts";
import { cautionChip, cautionDeadline } from "@features/card/domain/caution-deadline.ts";
import {
  formatGameDay,
  formatGameTime,
  formatGameWeekday,
} from "@features/card/domain/game-schedule.ts";
import { useNowSeconds } from "@shared/hooks/use-now-seconds.ts";
import {
  CAUTION_GAME_NOTE,
  firstGameConfirmedNote,
  homeAmbient,
  homeSub,
  homeTitle,
  mayClaimDaily,
} from "@features/card/domain/card-journey-hints.ts";

interface UsernameClaimOffer {
  /** The numbered name on the card today. */
  currentUsername: string;
  onOpen: () => void;
}

export interface MemberHomeScreenProps {
  state: HumanityCardState;
  accountAddress: string;
  /** The connected user's primary DotNS username for the card's identity
   *  label. Omitted in fixture mode, where the card shows the short address. */
  displayName?: string;
  /** The username's finalized owner, for the card's `data-account` hook;
   *  null or omitted when the name has none. */
  ownerAccount?: string | null;
  /** The live weekly game result, or null while it has not resolved. The
   *  account-unavailable arm is passed through, not flattened to null. */
  game: CurrentGameResult | null;
  gamePending: boolean;
  /** True only when the game read itself failed. */
  gameUnavailable: boolean;
  onOpenPrize: () => void;
  /** False once today's ticket has been consumed: the daily-dollar tile is
   *  gone until a new one exists. */
  dailyPrizeAvailable: boolean;
  /** The name upgrade, when it is on offer to this card. */
  usernameClaim?: UsernameClaimOffer;
  /** What the code on the card's back says; null draws the back without one. */
  qrPayload?: string | null;
  /** Called once per completed turn of the card. */
  onFlip?: () => void;
  /** Whether this visit may show an onboarding hint, and whether what it
   *  shows is remembered (fixture screens keep it in memory). */
  hints?: { enabled: boolean; persist?: boolean; only?: OnboardingHintId };
  /** Whether a cautioned member's last-day sheet may lay over the home, and
   *  whether answering it is remembered (fixture screens do not). */
  cautionSheet?: { enabled: boolean; persist?: boolean };
  /** The DIM2 account "Register" signs up: the game account the card reads,
   *  not the signer. Null when unresolved. */
  seatAccount?: string | null;
  /** For a suspended member, whether their games already cover the way back;
   *  picks the line under the card. */
  suspendedRecovery?: SuspensionRecovery;
  /** Where the automatic `Score.register` stands, as one quiet line, or
   *  null when there is nothing to say (`useAutoRegisterPersonhood`). */
  membershipNote?: string | null;
  /** A sign-up of the seat account for the game on screen is on its way,
   *  Jollity's or this home's own from before a reload
   *  (`useGameRegistration`): the block shows the sign-up instead of offering
   *  a second one. */
  signUpUnderWay?: boolean;
}

/** The card rises into place first, then the page builds beneath it: the
 *  same arrival every time, whichever state the card is in. */
const CARD_RISE = { y: 22, duration: 0.58, ease: power3InOut };
const BLOCKS_FROM = 0.36;
const BLOCK_FROM = { opacity: 0, y: 18, scale: 0.985 };
const BLOCK_RISE = {
  opacity: [BLOCK_FROM.opacity, 1],
  y: [BLOCK_FROM.y, 0],
  scale: [BLOCK_FROM.scale, 1],
};
const BLOCK_TIMING = { duration: 0.55, ease: power3Out };

export function MemberHomeScreen({
  state,
  accountAddress,
  displayName,
  ownerAccount,
  game,
  gamePending,
  gameUnavailable,
  onOpenPrize,
  dailyPrizeAvailable,
  usernameClaim,
  qrPayload = null,
  onFlip,
  hints = { enabled: false },
  cautionSheet = { enabled: false },
  seatAccount = null,
  suspendedRecovery = "unknown",
  membershipNote = null,
  signUpUnderWay = false,
}: MemberHomeScreenProps) {
  const cardWrapRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Blocks the entrance moved into place; one mounting later fades in alone. */
  const entered = useRef(new WeakSet<Element>());
  const cardHidden = useDebugStore((state) => state.cardHidden);
  const reduced = useReducedMotion();
  const kind = state.kind;
  // A failed game read must not leave stale schedule labels behind: drop the
  // game entirely so the weekday and countdown go quiet and the weekly block
  // renders its unavailable state.
  const shownGame = gameUnavailable ? null : game;
  const scheduled = shownGame != null && shownGame.kind === "game" ? shownGame : null;
  const now = useNowSeconds(scheduled?.gameDateSeconds);
  // `seatAccount` is the DIM2 account the sign-up registers; the lite proof
  // behind its bind is this product's own. A landed sign-up refreshes the
  // game read, and the block turns to "Registered" — no hand-off. A sign-up
  // this home cannot carry (no host sign-up, or a name it cannot link) is
  // handed to DIM2.
  const signUp = useRegisterForGame(seatAccount, shownGame, openGame);
  // Whether the entrance has finished moving things into place: a tip
  // measured before then would point at where a block was, not where it is.
  const [settled, setSettled] = useState(false);
  const [cardFlipped, setCardFlipped] = useState(false);

  useEffect(() => {
    const cardWrap = cardWrapRef.current;
    const body = bodyRef.current;
    if (body == null) return;
    // The card is drawn only when the debug toggle shows it; the blocks
    // under it are everything else in the column.
    const rest = Array.from(body.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child !== cardWrap,
    );
    for (const block of rest) entered.current.add(block);
    if (reduced) {
      showSettled(cardWrap == null ? rest : [cardWrap, ...rest]);
      setSettled(true);
      return;
    }
    if (cardWrap != null) placeAt([cardWrap], { opacity: 0, y: CARD_RISE.y });
    placeAt(rest, BLOCK_FROM);
    const entrance: AnimationPlaybackControlsWithThen[] = [];
    if (cardWrap != null) {
      entrance.push(
        animate(
          cardWrap,
          { opacity: [0, 1], y: [CARD_RISE.y, 0] },
          { duration: CARD_RISE.duration, ease: CARD_RISE.ease },
        ),
      );
    }
    if (rest.length > 0) {
      entrance.push(
        animate(rest, BLOCK_RISE, {
          ...BLOCK_TIMING,
          delay: stagger(0.07, { startDelay: cardWrap == null ? 0 : BLOCKS_FROM }),
        }),
      );
    }
    let live = true;
    void Promise.all(entrance).then(() => {
      if (live) setSettled(true);
    });
    return () => {
      live = false;
      for (const animation of entrance) animation.stop();
    };
  }, [reduced, cardHidden]);

  const showDollar = mayClaimDaily(state) && dailyPrizeAvailable;

  // A block that mounts after the entrance, such as the next game once its
  // read lands, the registration note or the daily-dollar tile, rises in
  // alone instead of popping in.
  const lateRises = useRef<AnimationPlaybackControlsWithThen[]>([]);
  useEffect(() => {
    const body = bodyRef.current;
    if (body == null || reduced) return;
    const late = Array.from(body.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child !== cardWrapRef.current &&
        // The onboarding tip floats over the column with its own fade.
        child.getAttribute("role") !== "tooltip" &&
        !entered.current.has(child),
    );
    if (late.length === 0) return;
    for (const block of late) entered.current.add(block);
    placeAt(late, BLOCK_FROM);
    const rise = animate(late, BLOCK_RISE, BLOCK_TIMING);
    lateRises.current.push(rise);
    void rise.then(() => {
      lateRises.current = lateRises.current.filter((r) => r !== rise);
    });
  });
  useEffect(
    () => () => {
      for (const rise of lateRises.current) rise.stop();
    },
    [],
  );

  const early = kind === "not-enrolled" || kind === "devicehood" || kind === "candidate";
  const showName = usernameClaim != null && kind === "member";
  const gameView = resolveWeeklyGameView(
    shownGame,
    gamePending,
    gameUnavailable,
    now,
    kind === "devicehood",
  );
  const register = () => {
    if (gameView.mode === "registration-open") signUp.register();
    else openGame();
  };
  const hint = useOnboardingHint(
    {
      // Both point at the card, so neither has anything to point at while it is hidden.
      card: !cardHidden,
      register:
        kind !== "not-enrolled" &&
        gameView.mode === "registration-open",
      stripe:
        !cardHidden &&
        (kind === "candidate" || (kind === "devicehood" && state.personhoodThreshold != null)),
    },
    // Tips are for a newcomer; a member has seen this screen many times.
    { enabled: hints.enabled && early, persist: hints.persist ?? true, only: hints.only },
  );

  // A cautioned member's deadline, in local calendar days from the real next
  // game. On the last day of the grace window the game is today and it is
  // the one that keeps the membership: one sheet per game, put away for good
  // by either answer.
  const caution =
    kind === "caution"
      ? cautionDeadline(shownGame, gamePending, gameUnavailable, now)
      : null;
  // The day the caution line names, by the same calendar as the chip. No
  // game the person can still act on names no day at all; a week or more
  // out, the weekday alone would read as this week's, so it carries a date.
  const cautionWhen =
    caution == null
      ? null
      : caution.daysLeft === 0
        ? "today"
        : caution.daysLeft === 1
          ? "tomorrow"
          : caution.daysLeft < 7
            ? `this ${formatGameWeekday(caution.gameDateSeconds)}`
            : `on ${formatGameDay(caution.gameDateSeconds)}`;
  const [sheetAnswered, setSheetAnswered] = useState<number | null>(() =>
    cautionSheet.persist === false ? null : readCautionSheetAnswered(),
  );
  const sheet =
    cautionSheet.enabled && caution?.urgent === true && sheetAnswered !== caution.gameIndex
      ? caution
      : null;
  const answerSheet = () => {
    if (sheet == null) return;
    if (cautionSheet.persist !== false) answerCautionSheet(sheet.gameIndex);
    setSheetAnswered(sheet.gameIndex);
  };

  // The home's light sits on the one verb: the next-game block glows in the
  // card's colour instead of a wash pinned to the top of the screen.
  const glow = { "--ambient-c": homeAmbient(state) } as CSSProperties;

  return (
    <Screen>
      <div
        className="body-col member-home-col"
        ref={bodyRef}
        style={glow}
        data-testid="humanity-home"
        data-card-state={state.kind}
      >
        {!cardHidden && (
          <div className="card-wrap" ref={cardWrapRef}>
            <MemberCard
              state={state}
              accountAddress={accountAddress}
              displayName={displayName}
              ownerAccount={ownerAccount}
              interactive
              qrPayload={qrPayload}
              onFlip={onFlip}
              onFaceChange={(back) => {
                setCardFlipped(back);
                // Turning the card over is what the card tip asks for.
                if (back) hint.retireId("card");
              }}
            />
          </div>
        )}

        <UnderCard title={homeTitle(state)} sub={homeSub(state, cautionWhen, suspendedRecovery)} />

        {/* Above the next game: finishing the membership is what this home
            is doing for the person right now. */}
        {membershipNote != null && (
          <p className="block-note membership-note">
            {membershipNote}
          </p>
        )}

        {kind !== "not-enrolled" && (
          <WeeklyGameBlock
            game={shownGame}
            pending={gamePending}
            unavailable={gameUnavailable}
            nowSeconds={now}
            firstGame={kind === "devicehood"}
            confirmedNote={kind === "devicehood" ? firstGameConfirmedNote() : undefined}
            tone={kind === "caution" ? "caution" : undefined}
            chip={caution == null ? undefined : cautionChip(caution)}
            note={kind === "caution" ? CAUTION_GAME_NOTE : undefined}
            onOpenGame={() => hint.retireId("register")}
            onRegister={register}
            registering={signUp.registering || signUpUnderWay}
            registeringLabel={signUp.registeringLabel}
            registerError={signUp.error}
          />
        )}

        {showDollar && <DailyDollarTile onOpen={onOpenPrize} />}

        {early && <JourneyStory state={state} />}

        <AttendanceRow state={state} />

        {showName && (
          <NameClaimRow
            currentUsername={usernameClaim.currentUsername}
            onOpen={usernameClaim.onOpen}
          />
        )}

        {hint.active != null && settled && !cardFlipped && sheet == null && (
          <OnboardingHint
            // A new tip is a new element, so it fades in like the first.
            key={hint.active}
            id={hint.active}
            {...onboardingHintCopy(hint.active)}
            columnRef={bodyRef}
            // The stripe sits on the card's bottom edge: the tip points down at
            // it from the card's face rather than up from the text below.
            prefer={hint.active === "stripe" ? "above" : "below"}
            onDismiss={hint.retire}
          />
        )}
      </div>
      {sheet != null && (
        <CautionSheet
          key={sheet.gameIndex}
          time={formatGameTime(sheet.gameDateSeconds)}
          action={sheet.action}
          closesIn={sheet.registrationCloses}
          onGo={() => {
            answerSheet();
            hint.retireId("register");
            register();
          }}
          onLater={answerSheet}
        />
      )}
    </Screen>
  );
}
