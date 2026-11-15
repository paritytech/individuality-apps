// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Card-scenario flows (with the candidate's score and threshold, and a
 * member's weeks) and the daily-dollar win/miss/live simulation chips, split
 * out of `DebugPanel` to keep that file within the LOC convention.
 */
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { clearLastCard } from "@features/card/storage/last-card-store.ts";
import { PROMOTION_STYLES } from "@features/card/domain/promotion-style.ts";

import {
  DEBUG_SCENARIOS,
  MAX_DEBUG_THRESHOLD,
  MEMBER_TIER_WEEKS,
  stepMemberWeeks,
} from "./debug-scenarios.ts";
import { useDebugStore } from "./debug-store.ts";

const DAILY_PRIZE_OUTCOMES = [
  { id: "win" as const, label: "Win" },
  { id: "miss" as const, label: "Miss" },
];

/**
 * One number with a minus and a plus: taps land on a phone where a number
 * field would summon a keyboard over the card being watched.
 */
function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="debug-field">
      <span>{label}</span>
      <div className="debug-flows">
        <button
          type="button"
          className="debug-chip"
          aria-label={`${label} down`}
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
        >
          −
        </button>
        <output className="debug-chip" aria-live="polite">
          {value}
        </output>
        <button
          type="button"
          className="debug-chip"
          aria-label={`${label} up`}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

export function DebugControls() {
  const scenario = useDebugStore((state) => state.scenario);
  const pendingScenario = useDebugStore((state) => state.pendingScenario);
  const applying = useDebugStore((state) => state.applying);
  const setScenario = useDebugStore((state) => state.setScenario);
  const runPromotionFlow = useDebugStore((state) => state.runPromotionFlow);
  const prizeOutcome = useDebugStore((state) => state.prize.outcome);
  const selectPrize = useDebugStore((state) => state.selectPrize);
  const resetPrize = useDebugStore((state) => state.resetPrize);
  const cardHidden = useDebugStore((state) => state.cardHidden);
  const setCardHidden = useDebugStore((state) => state.setCardHidden);
  const promotionStyle = useDebugStore((state) => state.promotionStyle);
  const setPromotionStyle = useDebugStore((state) => state.setPromotionStyle);
  const candidateProgress = useDebugStore((state) => state.candidateProgress);
  const setCandidateProgress = useDebugStore((state) => state.setCandidateProgress);
  const memberWeeks = useDebugStore((state) => state.memberWeeks);
  const setMemberWeeks = useDebugStore((state) => state.setMemberWeeks);
  const picked = pendingScenario ?? scenario;
  const candidatePicked = picked === "candidate";
  const memberPicked = picked === "member" || picked === "membership-ready";
  const queryClient = useQueryClient();

  const readFromChain = useCallback(() => {
    setScenario(null);
    resetPrize();
    clearLastCard();
    void queryClient.removeQueries({ queryKey: ["chain"] });
  }, [queryClient, resetPrize, setScenario]);

  return (
    <>
      <section className="debug-section">
        <h2 className="debug-title">Card</h2>
        <div className="debug-flows">
          <button
            type="button"
            className="debug-chip"
            aria-pressed={cardHidden}
            data-active={cardHidden || undefined}
            onClick={() => setCardHidden(true)}
          >
            Hidden
          </button>
          <button
            type="button"
            className="debug-chip"
            aria-pressed={!cardHidden}
            data-active={!cardHidden || undefined}
            onClick={() => setCardHidden(false)}
          >
            Shown
          </button>
        </div>
        <p className="debug-warn">
          {cardHidden
            ? "Hidden — the host's Pocket card is the card; this page opens beneath it"
            : "Shown — the app draws its own card, for a host with no Pocket"}
        </p>
      </section>
      <section className="debug-section">
        <h2 className="debug-title">Promotion style</h2>
        <div className="debug-flows">
          {PROMOTION_STYLES.map(({ id, label }) => {
            const active = promotionStyle === id;
            return (
              <button
                key={id}
                type="button"
                className="debug-chip"
                aria-pressed={active}
                data-active={active || undefined}
                onClick={() => setPromotionStyle(id)}
              >
                {label}
              </button>
            );
          })}
          <button type="button" className="debug-chip" onClick={runPromotionFlow}>
            Promote → member
          </button>
        </div>
      </section>
      <section className="debug-section">
        <h2 className="debug-title">Flows</h2>
        <div className="debug-flows">
          {DEBUG_SCENARIOS.map(({ id, label }) => {
            const active = (pendingScenario ?? scenario) === id;
            return (
              <button
                key={id}
                type="button"
                className="debug-chip"
                aria-pressed={active}
                data-active={active || undefined}
                data-pending={(active && applying) || undefined}
                onClick={() => setScenario(active ? null : id)}
              >
                {label}
              </button>
            );
          })}
          <button type="button" className="debug-chip" onClick={readFromChain}>
            Read from chain
          </button>
          <button type="button" className="debug-chip" onClick={runPromotionFlow}>
            Promote → member
          </button>
        </div>
        {candidatePicked ? (
          <>
            <Stepper
              label="Score"
              value={candidateProgress.score}
              min={0}
              max={candidateProgress.threshold}
              onChange={(score) => setCandidateProgress({ ...candidateProgress, score })}
            />
            <Stepper
              label="Threshold"
              value={candidateProgress.threshold}
              min={1}
              max={MAX_DEBUG_THRESHOLD}
              onChange={(threshold) => setCandidateProgress({ ...candidateProgress, threshold })}
            />
          </>
        ) : null}
        {memberPicked ? (
          // Steps a tier at a time: every week between two tiers draws the same card.
          <Stepper
            label="Weeks"
            value={memberWeeks}
            min={MEMBER_TIER_WEEKS[0] ?? memberWeeks}
            max={MEMBER_TIER_WEEKS.at(-1) ?? memberWeeks}
            onChange={(weeks) => setMemberWeeks(stepMemberWeeks(memberWeeks, weeks > memberWeeks ? 1 : -1))}
          />
        ) : null}
        {applying ? (
          <p className="debug-warn">Applying in 2s — close the panel to watch it land</p>
        ) : scenario != null ? (
          <p className="debug-warn">Simulated state — chain reads overridden</p>
        ) : null}
      </section>
      <section className="debug-section">
        <h2 className="debug-title">Daily dollar</h2>
        <div className="debug-flows">
          {DAILY_PRIZE_OUTCOMES.map(({ id, label }) => {
            const active = prizeOutcome === id;
            return (
              <button
                key={id}
                type="button"
                className="debug-chip"
                aria-pressed={active}
                data-active={active || undefined}
                onClick={() => selectPrize(id)}
              >
                {label}
              </button>
            );
          })}
          <button
            type="button"
            className="debug-chip"
            aria-pressed={prizeOutcome == null}
            data-active={prizeOutcome == null || undefined}
            onClick={resetPrize}
          >
            Live
          </button>
        </div>
        {prizeOutcome != null ? (
          <p className="debug-warn">Simulated daily-dollar ticket — no chain claim will run</p>
        ) : null}
      </section>
    </>
  );
}
