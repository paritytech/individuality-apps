// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { LiteSignUpBlocker } from "@humanity/shared/chain/individuality.ts";

export type { LiteSignUpBlocker } from "@humanity/shared/chain/individuality.ts";

/** What the chain will accept for this seat, narrowed to what the UI decides on. */
export interface LiteSignUpVerdict {
  /** `Game.sign_up_with_account_lite_invite` would dispatch right now. */
  canSignUp: boolean;
  /** The one missing piece is the bind leg THIS app can run (`AliasNotBound`). */
  needsBind: boolean;
  /** Every blocker the chain reported, in SDK order. */
  blockers: LiteSignUpBlocker[];
  /** The seat `Game.LiteInvites` already pinned, when a different one is pinned. */
  invitedAccount: string | null;
}
