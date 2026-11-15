// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Shared pieces for the debug panel's mutation triggers. */
import { useEffect } from "react";

import { errorText } from "./debug-format.ts";
import {
  recordMutation,
  type MutationOutcome,
} from "./debug-mutation-journal.ts";

/**
 * Records a settled outcome in the mutation journal.
 *
 * An effect because two of the three triggers read their outcome from a
 * production hook whose `useMutation` callbacks this panel does not own, so a
 * settle is only observable as a state transition. The journal is a plain store
 * outside React, which is exactly the external-system sync effects are for.
 */
export function useRecordSettle(
  mutation: string,
  outcome: MutationOutcome | null,
  detail: string,
): void {
  useEffect(() => {
    if (outcome == null) return;
    recordMutation(mutation, outcome, detail);
  }, [mutation, outcome, detail]);
}

interface FieldProps {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

export function Field({ label, value, placeholder, onChange }: FieldProps) {
  return (
    <label className="debug-field">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/** Pending beats error beats result: the newest fact about the submission wins,
 *  so a stale success never sits above a fresh failure. */
export function Outcome({
  pending,
  error,
  result,
}: {
  pending: boolean;
  error: unknown;
  result: string | null;
}) {
  if (pending) return <p className="debug-note">submitting…</p>;
  if (error != null) return <p className="debug-warn">{errorText(error)}</p>;
  return result == null ? null : <p className="debug-note">{result}</p>;
}
