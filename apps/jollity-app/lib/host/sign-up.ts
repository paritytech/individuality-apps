// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What the host does for a sign-up — the host's keys, behind one door (rule 5).
 *
 * The sign-up (@individuality/sign-up's flow, over the SDK's `registerForGame`)
 * asks the host for what only it holds, as the SDK's
 * `GameRegistrationCapabilities`, and the SDK's `hostGameRegistrationCapabilities`
 * builds them: the game account `dim2.<tld>` (the app's `productAccount()`) at
 * this network's index (`signupAccountIndex`, #85), the submission, the draw
 * tickets and the personhood keys. The app swaps in its own signer, so the
 * sign-up's extrinsic is logged like every other lib/game-source.ts signs.
 *
 * The `/host` entry imports the host SDK, which is ESM riding host globals, so
 * it is imported dynamically, only inside a container.
 */
import type { AccountsProvider } from "@parity/product-sdk-host"
import type { GameRegistrationCapabilities } from "@parity/product-sdk-individuality"
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"

/** What the host does for the sign-up of the game account at `accountIndex`, signed by `signer`. */
export async function signUpCapabilities(
  accounts: AccountsProvider,
  signer: CommonSignerTxCreator,
  options: { tld: string; accountIndex: number },
): Promise<GameRegistrationCapabilities> {
  const { hostGameRegistrationCapabilities } = await import("@parity/product-sdk-individuality/host")
  const built = await hostGameRegistrationCapabilities({ accounts, ...options })
  if (!built.ok) throw built.error
  return { ...built.value, signer }
}
