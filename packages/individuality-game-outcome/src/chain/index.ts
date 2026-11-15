// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The credits a game earned, read on the chain pair the nfts SDK reads
 * (./credits.ts). A subpath of its own: it brings the nfts SDK, which the
 * pure reads keep out of a screen's bundle.
 */
export { claimsChain, readGameCredits, type ClaimsChain } from "./credits"
