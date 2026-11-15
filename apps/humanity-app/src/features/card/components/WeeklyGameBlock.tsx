// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The live weekly-game block. Everything shown comes from the chain read:
 * the game date, countdown, phase and whether this account is registered.
 * "Register" signs the game account up from here (`useRegisterForGame`);
 * playing happens in DIM2, the game's own product, which "Registered" and
 * "Play now" hand off to. Rendering is otherwise driven by
 * `resolveWeeklyGameView`, which owns the deadline/cancellation/unknown
 * rules so they remain unit-testable. The home may colour the block for a
 * caution deadline, swap the chip for the days left, and add a line under
 * the action; the rules above never change. */
import type { ReactNode } from "react";

import { Icon } from "@shared/components/icons.tsx";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";
import { openGame } from "@features/card/domain/game-link.ts";
import { resolveWeeklyGameView } from "@features/card/domain/weekly-game-view.ts";

export interface WeeklyGameBlockProps {
  game: CurrentGameResult | null;
  pending: boolean;
  unavailable: boolean;
  /** The home's single wall-clock sample, in Unix seconds. */
  nowSeconds: number;
  /** True when this account has never played a game; only changes copy. */
  firstGame?: boolean;
  /** A line under a confirmed seat, for the states that promise something. */
  confirmedNote?: string;
  /** Caution colours the block's edge and chip: a deadline, not a date. */
  tone?: "caution";
  /** Replaces the countdown chip, e.g. with the days left in a grace window. */
  chip?: string;
  /** A line under the action in every interactive mode. */
  note?: string;
  /** Called whenever an action hands the person to the game. */
  onOpenGame?: () => void;
  /** Sign up from here. Called by "Register". */
  onRegister?: () => void;
  /** True while the sign-up is being signed and lands. */
  registering?: boolean;
  /** The held button's label when it is not "Registering…", such as while
   *  the seat is being prepared; null for "Registering…". */
  registeringLabel?: string | null;
  /** The safe error from a failed sign-up, shown under the button, which
   *  stays available to try again. `null` means nothing to show. */
  registerError?: string | null;
}

function Shell({ children, tone }: { children: ReactNode; tone?: "caution" }) {
  const className = tone === "caution" ? "card-block game-block is-caution" : "card-block game-block";
  return (
    <section className={className} aria-label="Next game">
      {children}
    </section>
  );
}

function Head({
  value,
  chip,
  warn,
  label = "Next game",
}: {
  value: string;
  chip: string;
  warn?: boolean;
  label?: string;
}) {
  return (
    <div className="block-row">
      <div>
        <div className="card-label">{label}</div>
        <div className="card-value">{value}</div>
      </div>
      <span className={warn === true ? "chip is-warning" : "chip"}>{chip}</span>
    </div>
  );
}

function Note({ text }: { text: string | undefined }) {
  return text == null ? null : <div className="block-note">{text}</div>;
}

export function WeeklyGameBlock({
  game,
  pending,
  unavailable,
  nowSeconds,
  firstGame = false,
  confirmedNote,
  tone,
  chip,
  note,
  onOpenGame,
  onRegister,
  registering = false,
  registeringLabel = null,
  registerError = null,
}: WeeklyGameBlockProps) {
  const view = resolveWeeklyGameView(game, pending, unavailable, nowSeconds, firstGame);
  const warnChip = tone === "caution";
  const open = () => {
    onOpenGame?.();
    openGame();
  };

  switch (view.mode) {
    // Nothing until the game is read: the block rises in when it lands.
    case "loading":
    case "unavailable":
      return null;

    case "no-game":
      return (
        <Shell tone={tone}>
          <Head value="Not scheduled yet" chip="no date" />
          <Note text={note} />
        </Shell>
      );

    case "confirmed":
      return (
        <Shell tone={tone}>
          <Head value={view.value} chip={chip ?? view.chip} warn={warnChip} />
          <button
            type="button"
            className="cta-confirmed"
            onClick={open}
            aria-label="Registered, open the game"
          >
            <Icon name="check" size={17} />
            Registered
          </button>
          <Note text={confirmedNote ?? note} />
        </Shell>
      );

    case "registration-open": {
      const label = view.cta;
      return (
        <Shell tone={tone}>
          <Head value={view.value} chip={chip ?? view.chip} warn={warnChip} label={view.eyebrow} />
          <button
            type="button"
            className="cta-pill"
            disabled={registering}
            onClick={onRegister}
            data-hint="register"
            aria-label={registering ? undefined : label}
          >
            {registering ? (registeringLabel ?? "Registering…") : label}
          </button>
          <Note text={registerError ?? note} />
        </Shell>
      );
    }

    case "play-now":
      return (
        <Shell tone={tone}>
          <Head value={view.value} chip={chip ?? view.chip} warn={warnChip} />
          <button
            type="button"
            className="cta-pill"
            onClick={open}
            aria-label={`${view.cta}, open the game`}
          >
            {view.cta}
          </button>
          <Note text={note} />
        </Shell>
      );

    case "results-pending":
      return (
        <Shell tone={tone}>
          <Head value={view.value} chip={chip ?? view.chip} warn={warnChip} />
          <button type="button" className="cta-pill" disabled aria-label={view.cta}>
            {view.cta}
          </button>
          <Note text={note ?? view.note} />
        </Shell>
      );

    case "upcoming":
      return (
        <Shell tone={tone}>
          <Head value={view.value} chip={chip ?? view.chip} warn={warnChip} />
          <Note text={note ?? view.note} />
        </Shell>
      );

    case "closed":
    case "cancelled":
      return (
        <Shell tone={tone}>
          <Head value={view.value} chip={view.chip} warn={view.warn} />
          <div className="block-note">{view.note}</div>
        </Shell>
      );

    case "unknown":
      return (
        <Shell tone={tone}>
          <Head value={view.value} chip={chip ?? view.chip} warn={warnChip} />
          <Note text={note} />
        </Shell>
      );
  }
}
