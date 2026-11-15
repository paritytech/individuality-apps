// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Choosing a name: the one mutation a numbered card can make. The bare
 *  name is offered as the default, the person can type any other, and the
 *  chain says live whether it is free. Registering as a full person links
 *  the numbered identity to the new name, publicly and for good, so the
 *  form says so once, plainly, above the button — and the button asks for
 *  a second tap before it sends anything. Typing again disarms it, and so
 *  does anything that makes the name stop being free.
 *
 *  The form is presentation only: it validates and submits a name while its
 *  owner handles the chain mutation in the background. */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Icon } from "@shared/components/icons.tsx";
import {
  FULL_USERNAME,
  type UsernameAvailability,
} from "@features/card/hooks/use-username-availability.ts";

const MAX_LENGTH = 32;
const MIN_LENGTH = 6;
const NOT_A_LETTER = /[^a-z]/g;
/** A confirm this soon after arming is a held key or a double tap, not a
 *  second decision. */
const CONFIRM_GUARD_MS = 500;

export interface UsernameUpgradeAction {
  /** Reset the form if the active wallet changes. */
  identityKey?: string;
  /** The numbered name the card carries today. */
  currentUsername?: string;
  /** The numbered name without its digits; still subject to availability. */
  suggestedUsername?: string;
  /** The name of the last claim that was broadcast but never landed, so the
   *  form can say so and offer it again. */
  failedUsername?: string;
  /** A submission is in flight: the form is inert until it settles. */
  pending: boolean;
  /** Submitted but not confirmed: never offer a second submission, which
   *  would risk a duplicate registration. */
  unknown: boolean;
  /** Confirmed on chain: the card read is still catching up, and a second
   *  submission would register a name that is already claimed. */
  confirmed: boolean;
  onSubmit: (fullUsername: string) => void;
}

export interface UsernameUpgradeBlockProps extends UsernameUpgradeAction {
  /** What the chain says about the name being typed. */
  availability?: UsernameAvailability;
  /** The form reports what it holds, so its owner can check the name. */
  onChange?: (value: string) => void;
}

/** The status line under the field, from the chain's answer. */
export function availabilityLine(
  availability: UsernameAvailability | undefined,
  value: string,
): { text: string; tone: "quiet" | "ok" | "warn"; retry?: () => void } {
  if (value === "" || availability == null || availability.status === "idle") {
    return { text: `${MIN_LENGTH} to ${MAX_LENGTH} letters, a to z.`, tone: "quiet" };
  }
  switch (availability.status) {
    case "invalid":
      return {
        text:
          value.length < MIN_LENGTH
            ? `At least ${MIN_LENGTH} letters.`
            : `${MIN_LENGTH} to ${MAX_LENGTH} letters, a to z.`,
        tone: "quiet",
      };
    case "checking":
      return { text: "Checking availability", tone: "quiet" };
    case "available":
      return { text: `${availability.name} is available`, tone: "ok" };
    case "taken":
      return { text: `${availability.name} is taken`, tone: "warn" };
    case "error":
      return { text: "Couldn't check availability.", tone: "warn", retry: availability.retry };
  }
}

export function UsernameUpgradeBlock({
  pending,
  unknown,
  confirmed,
  currentUsername,
  suggestedUsername = "",
  availability,
  onChange,
  onSubmit,
}: UsernameUpgradeBlockProps) {
  // Untouched, the field follows a late suggestion (a failed claim), as the page's preview does.
  const [edited, setEdited] = useState<string | null>(null);
  const value = edited ?? suggestedUsername;
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const armedAt = useRef(0);
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;

  const locked = pending || unknown || confirmed;
  // Free means the chain's answer is for this exact name, not the one the
  // field held a moment ago (or before a wallet switch).
  const free =
    availability == null ||
    (availability.status === "available" && availability.name === value);
  const ready = FULL_USERNAME.test(value) && free && !locked;
  // Armed only while the name it was armed for is still the one, and free.
  const armed = armedFor === value && ready;
  useEffect(() => {
    if (armedFor != null && !armed) setArmedFor(null);
  }, [armed, armedFor]);
  const line = availabilityLine(availability, value);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready) return;
    if (!armed) {
      setArmedFor(value);
      armedAt.current = Date.now();
      return;
    }
    if (Date.now() - armedAt.current < CONFIRM_GUARD_MS) return;
    setArmedFor(null);
    // Pinned: sending the claim clears the failed record behind the suggestion.
    setEdited(value);
    onSubmit(value);
  };

  const label = pending
    ? "Claiming"
    : unknown
      ? "Waiting for confirmation"
      : !FULL_USERNAME.test(value)
        ? "Claim"
        : armed
          ? `Confirm ${value}`
          : `Claim ${value}`;

  return (
    <form
      className="card-block block-stack name-form"
      onSubmit={submit}
      onKeyDown={(event) => {
        // A held Enter repeats the submit; only a fresh press is a decision.
        if (event.key === "Enter" && event.repeat) event.preventDefault();
      }}
    >
      <div className="name-field">
        <label className="card-label" htmlFor={fieldId}>
          Your name
        </label>
        <input
          id={fieldId}
          className="name-input"
          type="text"
          value={value}
          onChange={(event) => {
            const next = event.target.value
              .toLowerCase()
              .replace(NOT_A_LETTER, "")
              .slice(0, MAX_LENGTH);
            setEdited(next);
            setArmedFor(null);
            onChange?.(next);
          }}
          placeholder="yourname"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          minLength={MIN_LENGTH}
          maxLength={MAX_LENGTH}
          disabled={locked}
          aria-describedby={hintId}
        />
        <div
          className={`block-note name-status is-${line.tone}`}
          id={hintId}
          aria-live="polite"
        >
          {line.tone === "ok" && <Icon name="check" size={13} />}
          {line.text}
          {line.retry != null && (
            <button type="button" className="name-retry" onClick={line.retry}>
              Try again
            </button>
          )}
        </div>
      </div>

      <div className="block-note name-warn" aria-live="polite">
        {armed
          ? "Tap again to confirm."
          : currentUsername == null
            ? "Anyone can see your new name belongs to your numbered one, and you can't change it later."
            : `Anyone can see ${currentUsername} and your new name belong together, and you can't change it later.`}
      </div>

      <button type="submit" className={armed ? "cta-pill is-armed" : "cta-pill"} disabled={!ready}>
        {label}
      </button>
    </form>
  );
}
