// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Dev-only debug panel state with durable controls and ephemeral page reads. */
import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  getProviderDiagnostics,
} from "@humanity/shared/chain/connection.ts";
import { getGameAccountDiagnostics } from "@humanity/shared/identity/game-account.ts";
import { getResourcesAliasDiagnostics } from "@humanity/shared/chain/resources-alias.ts";
import { getCoinageBalanceDiagnostics } from "@humanity/shared/chain/coinage-balance.ts";
import { getPayoutBalanceDiagnostics } from "@features/airdrops/chain/payout-balance.ts";
import { getHostCallDiagnostics } from "@humanity/shared/chain/host-call-log.ts";
import { isInsideContainerSync } from "@humanity/shared/chain/host-api.ts";
import {
  DEFAULT_PROMOTION_STYLE,
  isPromotionStyle,
  type PromotionStyle,
} from "@features/card/domain/promotion-style.ts";

import {
  INITIAL_DEBUG_PRIZE_STATE,
  resetDebugPrizeState,
  selectDebugPrize,
  settleDebugPrize,
  type DebugPrizeState,
} from "./debug-prize-state.ts";
import {
  clampCandidateProgress,
  clampMemberWeeks,
  DEFAULT_CANDIDATE_PROGRESS,
  DEFAULT_MEMBER_WEEKS,
  isDebugScenarioId,
  type CandidateProgress,
  type DebugScenarioId,
} from "./debug-scenarios.ts";
import type { DebugInput, DebugPageInput } from "./debug-view.ts";

type PromotionTimer = NodeJS.Timeout;

let promotionTimer: PromotionTimer | undefined;
let applyTimer: PromotionTimer | undefined;

/** A picked scenario lands after this delay, so the panel can be closed and
 *  the card watched changing rather than hidden behind the panel. */
const APPLY_DELAY_MS = 2_000;

interface DebugState {
  /** Whether the summoned panel is on screen. Never persisted: a reload must
   *  leave no trace of a panel that has no visible way back. */
  open: boolean;
  toggle: () => void;
  close: () => void;
  /** Which panel categories are unfolded; absent means folded. */
  expanded: Readonly<Record<string, boolean>>;
  setExpanded: (category: string, open: boolean) => void;
  /**
   * Whether the app draws its own card. Hidden by default: on a host with a
   * Pocket, the card is the one the host draws from the worker and this page
   * opens beneath it, so a second card of the same person would be wrong.
   * Shown for the plain app, which has no card otherwise.
   */
  cardHidden: boolean;
  setCardHidden: (hidden: boolean) => void;
  /** How the promotion is staged; builds without the panel stage the default. */
  promotionStyle: PromotionStyle;
  setPromotionStyle: (style: PromotionStyle) => void;
  /** The simulated candidate's score and threshold, read when the scenario is Candidate. */
  candidateProgress: CandidateProgress;
  setCandidateProgress: (progress: CandidateProgress) => void;
  /** The simulated member's weeks, read when the scenario is Member or Membership ready. */
  memberWeeks: number;
  setMemberWeeks: (weeks: number) => void;
  /** The scenario the card override reads, applied after `APPLY_DELAY_MS`. */
  scenario: DebugScenarioId | null;
  /** The scenario the chips show as picked, ahead of it landing. */
  pendingScenario: DebugScenarioId | null;
  /** True while a pick is waiting out the delay. */
  applying: boolean;
  setScenario: (id: DebugScenarioId | null) => void;
  /** Triggers a candidate→member transition for promotion testing: the
   *  promotion latches when the card turns member, not at membership-ready. */
  runPromotionFlow: () => void;
  /** What the page last read, or null before the first publish. */
  input: DebugInput | null;
  publish: (input: DebugInput) => void;
  /** The debug panel's isolated win/miss/live daily-dollar simulation. */
  prize: DebugPrizeState;
  selectPrize: (outcome: DebugPrizeState["outcome"]) => void;
  settlePrize: () => void;
  resetPrize: () => void;
}

export const useDebugStore = create<DebugState>()(
  persist(
    (set) => ({
      open: false,
      toggle: () => set((state) => ({ open: !state.open })),
      close: () => set({ open: false }),
      expanded: { simulate: true, prizes: true },
      setExpanded: (category, open) =>
        set((state) => ({ expanded: { ...state.expanded, [category]: open } })),
      cardHidden: true,
      setCardHidden: (cardHidden) => set({ cardHidden }),
      promotionStyle: DEFAULT_PROMOTION_STYLE,
      setPromotionStyle: (promotionStyle) => set({ promotionStyle }),
      candidateProgress: DEFAULT_CANDIDATE_PROGRESS,
      setCandidateProgress: (progress) => set({ candidateProgress: clampCandidateProgress(progress) }),
      memberWeeks: DEFAULT_MEMBER_WEEKS,
      setMemberWeeks: (weeks) => set({ memberWeeks: clampMemberWeeks(weeks) }),
      scenario: null,
      pendingScenario: null,
      applying: false,
      setScenario: (scenario) => {
        clearTimeout(promotionTimer);
        clearTimeout(applyTimer);
        promotionTimer = undefined;
        if (scenario == null) {
          applyTimer = undefined;
          set({ scenario: null, pendingScenario: null, applying: false });
          return;
        }
        set({ pendingScenario: scenario, applying: true });
        applyTimer = setTimeout(() => {
          applyTimer = undefined;
          set({ scenario, applying: false });
        }, APPLY_DELAY_MS);
      },
      runPromotionFlow: () => {
        clearTimeout(promotionTimer);
        clearTimeout(applyTimer);
        promotionTimer = undefined;
        set({ pendingScenario: "candidate", applying: true });
        applyTimer = setTimeout(() => {
          applyTimer = undefined;
          set({ scenario: "candidate", applying: false });
          promotionTimer = setTimeout(() => {
            promotionTimer = undefined;
            set({ scenario: "member", pendingScenario: "member" });
          }, 700);
        }, APPLY_DELAY_MS);
      },
      input: null,
      publish: (input) => set({ input }),
      prize: INITIAL_DEBUG_PRIZE_STATE,
      selectPrize: (outcome) =>
        set((state) => ({ prize: selectDebugPrize(state.prize, outcome) })),
      settlePrize: () => set((state) => ({ prize: settleDebugPrize(state.prize) })),
      resetPrize: () => set({ prize: resetDebugPrizeState() }),
    }),
    {
      name: "humanity-prizes:debug",
      // A scenario id an earlier build persisted may no longer exist; the
      // override would then derive a state from nothing and crash the card.
      // `open` and the old dock `pos` are dropped the same way: earlier builds
      // wrote them, and a rehydrated `open: true` would show a panel nobody
      // summoned. A stored candidate progress or member weeks is clamped,
      // never trusted.
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<DebugState> & { pos?: unknown };
        const { pos: _pos, ...rest } = stored;
        return {
          ...current,
          ...rest,
          open: false,
          scenario: isDebugScenarioId(stored.scenario) ? stored.scenario : null,
          promotionStyle: isPromotionStyle(stored.promotionStyle)
            ? stored.promotionStyle
            : DEFAULT_PROMOTION_STYLE,
          candidateProgress: clampCandidateProgress({
            ...DEFAULT_CANDIDATE_PROGRESS,
            ...stored.candidateProgress,
          }),
          memberWeeks: clampMemberWeeks(stored.memberWeeks ?? DEFAULT_MEMBER_WEEKS),
        };
      },
      partialize: (state) => ({
        expanded: state.expanded,
        cardHidden: state.cardHidden,
        promotionStyle: state.promotionStyle,
        candidateProgress: state.candidateProgress,
        memberWeeks: state.memberWeeks,
        scenario: state.scenario,
        prize: state.prize,
      }),
    },
  ),
);

/** Captures the transport state when the panel's page state is published or rendered. */
export function withChainDiagnostics(input: DebugPageInput): DebugInput {
  return {
    ...input,
    insideContainer: isInsideContainerSync(),
    providerDiagnostics: getProviderDiagnostics(),
    gameAccountDiagnostics: getGameAccountDiagnostics(),
    resourcesAlias: getResourcesAliasDiagnostics(),
    coinage: getCoinageBalanceDiagnostics(),
    payoutBalances: getPayoutBalanceDiagnostics(),
    hostCalls: getHostCallDiagnostics(),
  };
}

/**
 * Publish the page's reads to the panel. The fields are destructured so the
 * effect depends on the values rather than on the wrapper object, which the
 * caller rebuilds every render: publishing then happens only when a read
 * actually changed.
 */
export function usePublishDebugInput(input: DebugPageInput): void {
  const publish = useDebugStore((state) => state.publish);
  const {
    network,
    productDomain,
    card,
    cardPending,
    cardError,
    game,
    gamePending,
    gameError,
    airdrops,
    airdropsPending,
    airdropsError,
  } = input;
  useEffect(() => {
    publish(
      withChainDiagnostics({
        network,
        productDomain,
        card,
        cardPending,
        cardError,
        game,
        gamePending,
        gameError,
        airdrops,
        airdropsPending,
        airdropsError,
      }),
    );
  }, [
    publish,
    network,
    productDomain,
    card,
    cardPending,
    cardError,
    game,
    gamePending,
    gameError,
    airdrops,
    airdropsPending,
    airdropsError,
  ]);
}
