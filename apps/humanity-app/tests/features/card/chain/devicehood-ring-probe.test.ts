// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The lite-ring probe, on the state that cost a three-agent investigation.
 *
 * The fixtures are previewnet at block #89396 on 2026-09-08, the block a
 * weekly-game seat bind failed on: `PeopleLite.LitePeople` recorded the key
 * below, and `Members.Members(people-lite, key)` answered `Included { ring 1,
 * page 0, position 162 }` in a ring of 166 keys with all 166 in the root and
 * no rebuild queued. The panel had no row for any of it, because nothing ever
 * read the lite ring with the key the chain itself recorded.
 *
 * Two of these are about what the probe must NOT do: it must read nothing when
 * there is no record to take a key from, and it must never turn a read that
 * failed into the ring's own "no entry".
 */
import { describe, expect, it, vi } from "vitest";

import { probeDevicehoodRing } from "@humanity/shared/card/humanity-card-data.ts";
import {
  ringIdentifier,
  type RingMembershipChain,
} from "@humanity/shared/chain/ring-membership.ts";

/** The key `PeopleLite.attest` wrote for this person, and the only key the
 *  lite ring was ever told about. */
const RECORD_KEY =
  "0x8cad933a3e1ff2614e9572c9eab78eccb983aa524fa68d53dc00395c35f0b5ee";

const LITE_PERSON = {
  ring_vrf_key: RECORD_KEY,
  method: {
    type: "UniqueDevice",
    value: "5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL",
  },
};

/** The card's pinned block, passed through unchanged: a standing read at a
 *  different block than the record it explains is evidence of nothing. */
const AT = { at: "0xblock89396" } as never;

const INCLUDED_RAW = {
  type: "Included",
  value: { ring_index: 1, ring_page: 0, ring_position: 162 },
};

function chain(overrides: { members?: () => Promise<unknown> } = {}) {
  const members = vi.fn(
    overrides.members ?? (() => Promise.resolve(INCLUDED_RAW)),
  );
  const ringKeysStatus = vi
    .fn()
    .mockResolvedValue({ total: 166, included: 166, immutable_since: undefined });
  const root = vi.fn().mockResolvedValue({ revision: 171 });
  const staleRings = vi.fn().mockResolvedValue([]);
  return {
    api: {
      query: {
        People: {
          AccountToPersonalId: { getValue: vi.fn() },
          People: { getValue: vi.fn() },
        },
        Members: {
          Members: { getValue: members },
          RingKeysStatus: { getValue: ringKeysStatus },
          Root: { getValue: root },
          StaleRings: { getEntries: staleRings },
        },
      },
    } as unknown as RingMembershipChain,
    members,
    ringKeysStatus,
    root,
    staleRings,
  };
}

describe("probeDevicehoodRing", () => {
  it("places the record's key in the lite ring at the card's own block", async () => {
    const stub = chain();

    expect(await probeDevicehoodRing(stub.api, LITE_PERSON, AT)).toEqual({
      kind: "placed",
      ringVrfKey: RECORD_KEY,
      standing: {
        source: "personhood-key",
        personalId: null,
        ringVrfKey: RECORD_KEY,
        position: {
          kind: "included",
          ringIndex: 1,
          ringPage: 0,
          ringPosition: 162,
        },
        ring: {
          ringIndex: 1,
          totalKeys: 166,
          includedKeys: 166,
          immutableSinceSeconds: null,
          rootRevision: 171,
          stale: false,
        },
      },
    });
    // Collection and key as two positional arguments, on the block the caller
    // pinned. The tuple form this storage entry does not take throws instead.
    expect(stub.members).toHaveBeenCalledWith(
      ringIdentifier("people-lite"),
      RECORD_KEY,
      AT,
    );
    expect(stub.ringKeysStatus).toHaveBeenCalledWith(
      ringIdentifier("people-lite"),
      1,
      AT,
    );
  });

  it("reads nothing at all when the chain holds no Devicehood record", async () => {
    const stub = chain();

    expect(await probeDevicehoodRing(stub.api, null, AT)).toEqual({
      kind: "no-record",
    });
    expect(stub.members).not.toHaveBeenCalled();
    expect(stub.ringKeysStatus).not.toHaveBeenCalled();
  });

  it("reports a failed read as a failure, never as a key the ring lacks", async () => {
    const stub = chain({
      members: () => Promise.reject(new Error("Incompatible runtime entry")),
    });

    expect(await probeDevicehoodRing(stub.api, LITE_PERSON, AT)).toEqual({
      kind: "failed",
      ringVrfKey: RECORD_KEY,
      error: expect.stringContaining("Incompatible runtime entry"),
    });
  });

  it("keeps the ring's own no-entry an answer rather than a failure", async () => {
    // The one negative that is a fact about the chain: the read succeeded, and
    // the lite ring holds no entry for the attested key.
    const stub = chain({ members: () => Promise.resolve(undefined) });

    expect(await probeDevicehoodRing(stub.api, LITE_PERSON, AT)).toEqual({
      kind: "placed",
      ringVrfKey: RECORD_KEY,
      standing: {
        source: "personhood-key",
        personalId: null,
        ringVrfKey: RECORD_KEY,
        position: { kind: "absent" },
        ring: null,
      },
    });
    expect(stub.ringKeysStatus).not.toHaveBeenCalled();
  });
});
