// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What the automatic and manual `Score.register` paths last decided and did,
 * for the debug panel's own section.
 *
 * The 200-record log buffer rolls over within minutes once the card's 12s
 * refetch starts logging at `debug`, and the registration logs only once per
 * launch, so a person who opens the panel a little later finds nothing about
 * it. This keeps the latest gate decision and the latest run (its stages and
 * outcome) where the panel can always read them. A plain store outside React,
 * subscribed with `useSyncExternalStore`.
 */
import type { RegistrationGate } from "@features/card/domain/personhood-registration.ts";

export interface RegistrationRunOutcome {
  readonly kind: string;
  readonly detail: string;
  readonly txHash?: string;
}

export interface RegistrationRun {
  readonly source: "auto" | "manual";
  readonly startedAt: number;
  readonly stages: readonly string[];
  /** Null while the run is in flight. */
  readonly outcome: RegistrationRunOutcome | null;
}

export interface RegistrationDiagnostics {
  readonly gate: RegistrationGate | null;
  readonly run: RegistrationRun | null;
}

let state: RegistrationDiagnostics = { gate: null, run: null };
const listeners = new Set<() => void>();

function set(next: RegistrationDiagnostics): void {
  state = next;
  for (const listener of listeners) listener();
}

export function registrationDiagnostics(): RegistrationDiagnostics {
  return state;
}

export function subscribeRegistrationDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function recordRegistrationGate(gate: RegistrationGate): void {
  set({ ...state, gate });
}

export function startRegistrationRun(source: RegistrationRun["source"]): void {
  set({ ...state, run: { source, startedAt: Date.now(), stages: [], outcome: null } });
}

export function recordRegistrationStage(stage: string): void {
  if (state.run == null) return;
  set({ ...state, run: { ...state.run, stages: [...state.run.stages, stage] } });
}

export function finishRegistrationRun(outcome: RegistrationRunOutcome): void {
  if (state.run == null) return;
  set({ ...state, run: { ...state.run, outcome } });
}

export function resetRegistrationDiagnosticsForTests(): void {
  state = { gate: null, run: null };
}
