// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The personhood product id follows the network suffix, like every other
 * product id — because the live iOS host derives and enrols people under
 * `peopl.<tld>`, so that is the only id whose keys are in the rings on a test
 * network. Pinned against the two neighbouring facts it must agree with: our
 * own deploy name (same label, same suffix) and the proof contexts (same
 * suffix, different derivation).
 */
import { describe, expect, it } from "vitest";

import {
  PERSONHOOD_LABEL,
  personhoodProductId,
} from "@humanity/shared/identity/product-domain.ts";
import { NETWORKS, dotnsName } from "@humanity/shared/chain/networks.ts";
import { personhoodContext } from "@humanity/shared/chain/individuality.ts";

describe("personhoodProductId", () => {
  it("is peopl under the network's own suffix", () => {
    expect(personhoodProductId(NETWORKS.previewnet)).toBe("peopl.testnet");
    expect(personhoodProductId(NETWORKS["paseo-next-v2"])).toBe("peopl.paseo");
  });

  it("is never the reserved `.dot` literal on a test network", () => {
    // On a test network `peopl.dot` is a person nobody's device is: the phone
    // never used it, and the Rust core stopped with host-rust-core PR 627.
    for (const network of Object.values(NETWORKS)) {
      expect(personhoodProductId(network), network.key).not.toBe("peopl.dot");
    }
  });

  it("is the deploy name when the deploy label is the personhood label", () => {
    for (const network of Object.values(NETWORKS)) {
      expect(personhoodProductId(network)).toBe(
        dotnsName(network, PERSONHOOD_LABEL),
      );
    }
  });

  it("shares the suffix with the proof contexts", () => {
    // Same network, same suffix, two different derivations: a key is not a
    // context. Verified against both chains' `Score.score_context` in
    // individuality.test.ts.
    const previewnet = personhoodContext(NETWORKS.previewnet.dotnsSuffix, "score");
    const paseo = personhoodContext(NETWORKS["paseo-next-v2"].dotnsSuffix, "score");
    expect(previewnet).not.toBe(paseo);
  });
});
