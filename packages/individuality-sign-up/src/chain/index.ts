// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The sign-up's chain side: the product SDK's game registration in the shape
 * the flow reads, with Jollity's draw rule on top (./sign-up.ts), and the check
 * of a draw ticket's VRF the SDK takes as a capability (./vrf.ts).
 *
 * A subpath of its own: it brings the SDK and papi, which the pure gates of
 * `@individuality/sign-up` keep out of a screen's bundle.
 */
export { signUpFlowChain } from "./sign-up"
export { verifyVrf } from "./vrf"
