// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { Signer } from "@parity/product-lab/ports/chain";

/** A game player as the games integration sees one. Consumers bind their own
 * actors to this shape; games never derives or stores player keys. */
export interface GameParticipant {
  readonly name: string;
  readonly address: string;
  readonly signer: Signer;
  /** People `identifier_key` for `Game.sign_up_with_account`. */
  readonly identifier: string;
}

/** The account that signs Game root calls. Only games code holds it. */
export interface GameAuthority {
  readonly address: string;
  readonly signer: Signer;
}
