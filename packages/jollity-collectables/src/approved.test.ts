// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { getApprovedCollections } from "@parity/product-sdk-nfts"
import { NETWORK_CONFIG, type NetworkName } from "@jollity/protocol"

// The chest offers only the collections the SDK approves for the build's
// network, and that list ships with the SDK. A network without one opens no
// chest at all, and rereading never fills it in, so it fails here instead.
describe("approved collections", () => {
  it.each(Object.keys(NETWORK_CONFIG) as NetworkName[])("the SDK approves some on %s", (network) => {
    expect(getApprovedCollections(network).length).toBeGreaterThan(0)
  })
})
