// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The tips a visit gets. The home says which targets are on screen; the
 * rules for which tip, and when, are `chooseOnboardingHint`'s. A tip is
 * remembered as shown the moment it appears; putting it away, or doing what
 * it explains, retires it for good, and so does the next visit starting
 * while it was still up. A tip whose target leaves the screen has done its
 * job (the register button turning into "Registered", say) and retires too.
 *
 * Nothing is retired on unmount: a closed webview never unmounts, and
 * StrictMode's rehearsal unmount would retire the first tip the moment it
 * mounted. Visits are told apart instead (`CURRENT_VISIT`).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  NO_TARGETS,
  chooseOnboardingHint,
  settleEarlierVisit,
  type HintTargets,
} from "@features/card/domain/onboarding-hints.ts";
import {
  CURRENT_VISIT,
  emptyHintRecord,
  markOnboardingHintShown,
  readOnboardingHints,
  retireOnboardingHint,
  withShown,
  type OnboardingHintId,
  type OnboardingHintRecord,
} from "@features/card/storage/onboarding-hints-store.ts";

export interface OnboardingHintController {
  /** The tip on screen, or null. */
  active: OnboardingHintId | null;
  /** The person put the tip on screen away: done for good. The first
   *  visit's next tip follows. */
  retire: () => void;
  /** The person did what `id` explains, whether or not its tip is up. */
  retireId: (id: OnboardingHintId) => void;
}

export interface OnboardingHintOptions {
  /** Off while the card is not real (loading) or tips are not wanted. */
  enabled: boolean;
  /** Fixture screens keep the record in memory so nothing is remembered. */
  persist?: boolean;
  /** Fixture screens can ask for one tip by name, whatever the order. */
  only?: OnboardingHintId;
}

const NONE: OnboardingHintController = {
  active: null,
  retire: () => undefined,
  retireId: () => undefined,
};

export function useOnboardingHint(
  targets: HintTargets,
  { enabled, persist = true, only }: OnboardingHintOptions,
): OnboardingHintController {
  const [active, setActive] = useState<OnboardingHintId | null>(null);
  const activeRef = useRef<OnboardingHintId | null>(null);
  const memory = useRef<OnboardingHintRecord>(emptyHintRecord());

  const record = useCallback((): OnboardingHintRecord => {
    if (persist) return readOnboardingHints();
    memory.current = settleEarlierVisit(memory.current, CURRENT_VISIT);
    return memory.current;
  }, [persist]);
  const shown = useCallback(
    (id: OnboardingHintId) => {
      if (persist) markOnboardingHintShown(id);
      else memory.current = withShown(memory.current, id, Date.now(), CURRENT_VISIT);
    },
    [persist],
  );
  const retired = useCallback(
    (id: OnboardingHintId) => {
      if (persist) retireOnboardingHint(id);
      else if (memory.current.retired[id] == null) {
        memory.current = { ...memory.current, retired: { ...memory.current.retired, [id]: Date.now() } };
      }
    },
    [persist],
  );

  const { card, register, stripe } = targets;
  const wanted = useCallback(
    (): HintTargets => {
      const all: HintTargets = { card, register, stripe };
      return only == null ? all : { ...NO_TARGETS, [only]: all[only] };
    },
    [card, register, stripe, only],
  );

  const show = useCallback(
    (id: OnboardingHintId | null) => {
      if (id != null && activeRef.current !== id) shown(id);
      activeRef.current = id;
      setActive(id);
    },
    [shown],
  );

  // Keep the tip on screen honest: retire one whose target has gone, and
  // pick the next whenever nothing is up (a late target gets its turn).
  useEffect(() => {
    if (!enabled) return;
    const current = activeRef.current;
    if (current != null) {
      if (wanted()[current]) return;
      retired(current);
    }
    show(chooseOnboardingHint(wanted(), record(), Date.now(), CURRENT_VISIT));
  }, [enabled, active, wanted, record, retired, show]);

  const retire = useCallback(() => {
    const current = activeRef.current;
    if (current == null) return;
    retired(current);
    show(chooseOnboardingHint(wanted(), record(), Date.now(), CURRENT_VISIT));
  }, [retired, show, wanted, record]);

  const retireId = useCallback(
    (id: OnboardingHintId) => {
      if (activeRef.current === id) retire();
      else retired(id);
    },
    [retire, retired],
  );

  return enabled ? { active, retire, retireId } : NONE;
}
