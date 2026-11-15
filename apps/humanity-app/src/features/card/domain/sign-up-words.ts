// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The Register button's words for where the shared sign-up flow stands
 *  (`SignupPhase` of `@individuality/sign-up`): Jollity's words
 *  (`apps/jollity-app/lib/registration/register-button.ts`), with this home's
 *  own sentences where it has them. Pure, so every phase is tested. */
import type { SignupPhase } from "@individuality/sign-up";

export interface SignUpWords {
  /** Whether the button is held while the sign-up works. */
  registering: boolean;
  /** The held button's label when it is not "Registering…"; null otherwise. */
  label: string | null;
  /** The line under the button, when there is something to say. */
  note: string | null;
}

const SLOW = "This is taking longer than usual. We're still trying.";
const HOST_CHAIN =
  "The Polkadot app lost its connection to the chain. Close the Polkadot app completely and open it again.";
const NAME_UNOWNED = "Your username isn't registered.";
const NETWORK = "We can't reach the network. Check your connection.";
const CLOSED = "Registration has closed for this game.";
const REFUSED = "We couldn't register you for this game.";

const quiet = (registering: boolean, note: string | null = null): SignUpWords => ({
  registering,
  label: null,
  note,
});

export function signUpWords(phase: SignupPhase): SignUpWords {
  switch (phase) {
    // No reminder gate here: the flow is started without one.
    case "idle":
    case "alarm-required":
    case "reminders-off":
      return quiet(false);
    // The bind and the name link, which a sign-up never goes without.
    case "waiting-seat":
      return { registering: true, label: "Getting your seat ready…", note: null };
    case "reminders":
    case "sending":
    case "chat":
      return quiet(true);
    case "slow":
      return quiet(true, SLOW);
    case "host-chain":
      return quiet(true, HOST_CHAIN);
    case "network":
      return quiet(true, NETWORK);
    case "name-unowned":
      return quiet(true, NAME_UNOWNED);
    case "closed":
      return quiet(false, CLOSED);
    case "refused":
      return quiet(false, REFUSED);
  }
}
