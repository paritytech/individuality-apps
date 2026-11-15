// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The membership rows of the debug panel, on the state that cost a three-agent
 * investigation: the chain calls a key `Included` and the host refuses to
 * prove for it.
 *
 * The fixtures are the live lite ring at block #89396 on 2026-09-08, where a
 * weekly-game seat bind failed with `Domain.V1.NotMember` — ring 1, position
 * 162, `RingKeysStatus { total: 165, included: 165 }`, root revision 164,
 * `StaleRings` empty. Reading those four facts off a pasted snapshot is the
 * difference between "the chain has not finished building" and "the host is
 * proving with a key of its own", and the panel could not tell them apart.
 */
import { describe, expect, it } from "vitest";

import { personhoodRows } from "@features/debug/debug-personhood.ts";
import { scenarioSnapshot } from "@features/debug/debug-scenarios.ts";
import { deriveHumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import type {
  DeviceKeyCheck,
  Devicehood,
  DevicehoodRingProbe,
} from "@humanity/shared/card/humanity-card-data.ts";
import type {
  PersonRingStanding,
  RingBuildState,
  RingPosition,
} from "@humanity/shared/chain/ring-membership.ts";

const RING_KEY =
  "0x8cad933a3e1ff2614e9572c9eab78eccb983aa524fa68d53dc00395c35f0b5ee";

/** The key-first read, which is what a run with a host actually produces. */
const KEY_READ: PersonRingStanding = {
  source: "personhood-key",
  personalId: null,
  ringVrfKey: RING_KEY,
  position: { kind: "absent" },
  ring: null,
};

/** The failing bind's own slot: assigned to lite ring 1, position 162. */
const INCLUDED: RingPosition = {
  kind: "included",
  ringIndex: 1,
  ringPage: 0,
  ringPosition: 162,
};

/** Fully built, nothing queued — the chain has no work left to do. */
const BUILT: RingBuildState = {
  ringIndex: 1,
  totalKeys: 165,
  includedKeys: 165,
  immutableSinceSeconds: null,
  rootRevision: 164,
  stale: false,
};

/** The personhood section as a label → value table, which is how the section
 *  is read off a pasted snapshot. */
function rows(
  standing: PersonRingStanding | null,
  extras: {
    devicehood?: Devicehood;
    devicehoodRing?: DevicehoodRingProbe;
    deviceKeyCheck?: DeviceKeyCheck;
  } = {},
): Record<string, string> {
  const snapshot = scenarioSnapshot("member");
  return Object.fromEntries(
    personhoodRows(
      deriveHumanityCardState(snapshot),
      snapshot,
      extras.devicehood ?? null,
      standing,
      extras.devicehoodRing ?? null,
      extras.deviceKeyCheck ?? null,
    ).map(({ label, value }) => [label, value]),
  );
}

describe("membership rows for an included key", () => {
  it("names the slot, the coverage and the revision the proof is tagged with", () => {
    const shown = rows({ ...KEY_READ, position: INCLUDED, ring: BUILT });

    expect(shown["membership ring"]).toBe("included (ring 1)");
    expect(shown["ring slot"]).toBe(
      "ring 1, position 162 of 165 keys (page 0), 165 included in the root",
    );
    expect(shown["ring root"]).toBe("revision 164, not stale");
  });

  it("says a ring is stale and short of full coverage when it is", () => {
    // The reading that exonerates the host: the slot is assigned, the root
    // covers 120 of the ring's 165 keys, and a rebuild is queued. No proof
    // for position 162 can exist yet, so the refusal is the chain's.
    const shown = rows({
      ...KEY_READ,
      position: INCLUDED,
      ring: { ...BUILT, includedKeys: 120, rootRevision: 3, stale: true },
    });

    expect(shown["ring slot"]).toBe(
      "ring 1, position 162 of 165 keys (page 0), 120 included in the root",
    );
    expect(shown["ring root"]).toBe("revision 3, stale (rebuild queued)");
  });

  it("distinguishes a ring never built from one built at revision 0", () => {
    expect(
      rows({
        ...KEY_READ,
        position: INCLUDED,
        ring: { ...BUILT, rootRevision: null },
      })["ring root"],
    ).toBe("never built, not stale");
    expect(
      rows({
        ...KEY_READ,
        position: INCLUDED,
        ring: { ...BUILT, rootRevision: 0 },
      })["ring root"],
    ).toBe("revision 0, not stale");
  });

  it("reports a sealed ring's immutable-since, which no rebuild can move", () => {
    expect(
      rows({
        ...KEY_READ,
        position: INCLUDED,
        ring: { ...BUILT, immutableSinceSeconds: 1_788_533_994 },
      })["ring root"],
    ).toBe(
      "revision 164, not stale, immutable since 1788533994 · 2026-09-04 14:59Z",
    );
  });

  it("keeps the slot row honest when the ring itself was not read", () => {
    // `ring` is nullable independently of `position`, so a standing produced
    // without the ring read still has a real slot. Reporting it with an
    // unknown root beats inventing either.
    const shown = rows({ ...KEY_READ, position: INCLUDED });
    expect(shown["ring slot"]).toBe("ring 1, position 162 (page 0)");
    expect(shown["ring root"]).toBe("—");
  });

  it("keeps the ring detail between the ring and the read that found it", () => {
    // The new rows explain `membership ring`, so they belong under it and
    // above `ring read`, which is about the lookup rather than the ring.
    const labels = Object.keys(
      rows({ ...KEY_READ, position: INCLUDED, ring: BUILT }),
    );
    const first = labels.indexOf("membership ring");
    expect(labels.slice(first, first + 6)).toEqual([
      "membership ring",
      "ring slot",
      "ring root",
      "ring read",
      "personal id",
      "person ring key",
    ]);
  });
});

describe("membership rows for every other standing", () => {
  it("reports onboarding with the queue page it is parked on", () => {
    expect(
      rows({
        ...KEY_READ,
        position: {
          kind: "onboarding",
          queuePage: 2,
          queuedAtSeconds: 1_788_533_994,
        },
      })["membership ring"],
    ).toBe("onboarding since 2026-09-04T14:59:54.000Z (queue page 2)");
  });

  it("reports suspension plainly", () => {
    expect(
      rows({ ...KEY_READ, position: { kind: "suspended" } })["membership ring"],
    ).toBe("suspended from the ring");
  });

  it("adds no ring rows to a standing that names no ring", () => {
    const positions: readonly RingPosition[] = [
      { kind: "absent" },
      { kind: "suspended" },
      { kind: "onboarding", queuePage: 0, queuedAtSeconds: 0 },
    ];
    for (const position of positions) {
      const shown = rows({ ...KEY_READ, position });
      expect(shown).not.toHaveProperty("ring slot");
      expect(shown).not.toHaveProperty("ring root");
    }
  });

  it("still separates a key the ring does not hold from the read that asked", () => {
    const shown = rows(KEY_READ);
    expect(shown["membership ring"]).toBe("no entry for this key");
    expect(shown["ring read"]).toBe("personhood-key");
    expect(shown["person ring key"]).toBe(RING_KEY);
    expect(shown["personal id"]).toBe("—");
  });

  it("still calls a missing standing unanswerable rather than not a member", () => {
    const shown = rows(null);

    expect(shown["membership ring"]).toBe(
      "unanswerable (no ring key from the host, no personal id bound)",
    );
    expect(shown).not.toHaveProperty("ring read");
    expect(shown).not.toHaveProperty("ring slot");
  });
});

/**
 * The two rings, side by side, in the state previewnet actually held on
 * 2026-09-08: the key the chain recorded for this person is a fully built
 * member of the lite ring, and the key our host discloses is in no ring at
 * all. Only both halves together say a host refusal is the host's own doing,
 * and the panel used to show the first key with no standing whatsoever.
 *
 * This is `PeopleLite.LitePeople`'s own record, carrying the same key the
 * ring rows below place, so the whole group reads as one block.
 */
const DEVICEHOOD: Devicehood = {
  ringVrfKey: RING_KEY,
  method: {
    kind: "unique-device",
    attester: "5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL",
  },
};

/** The lite ring at that block: 166 keys assigned, all 166 in the root, no
 *  rebuild queued. Nothing left for the chain to do. */
const LITE_RING: RingBuildState = {
  ringIndex: 1,
  totalKeys: 166,
  includedKeys: 166,
  immutableSinceSeconds: null,
  rootRevision: 171,
  stale: false,
};

const PLACED: DevicehoodRingProbe = {
  kind: "placed",
  ringVrfKey: RING_KEY,
  standing: {
    source: "personhood-key",
    personalId: null,
    ringVrfKey: RING_KEY,
    position: INCLUDED,
    ring: LITE_RING,
  },
};

/**
 * A key our own host derived and no `attest` ever enrolled — a live sweep of
 * all 440 `Members.Members` entries found it nowhere. It stands in for the
 * host-disclosed person key the `membership ring` row reads the *full* people
 * ring with: the row does not care which key it is, only that it is a
 * different key from the record's and that the ring holds no entry for it.
 */
const HOST_KEY =
  "0x936d177b3a002d37c890b0e95fce4de2362d38a7ae36ecff3b9c2f0467b46de0";

/** The full-people read as it really answers for a lite person. */
const FULL_RING_MISS: PersonRingStanding = {
  ...KEY_READ,
  ringVrfKey: HOST_KEY,
};

describe("devicehood ring rows", () => {
  it("places the chain-recorded key in the lite ring, coverage included", () => {
    const shown = rows(FULL_RING_MISS, {
      devicehood: DEVICEHOOD,
      devicehoodRing: PLACED,
    });

    expect(shown["devicehood ring"]).toBe(
      "included (ring 1) — devicehood key 0x8cad…b5ee in people-lite",
    );
    // The rows `0804d6f` added, rendered for this standing for free.
    expect(shown["devicehood ring slot"]).toBe(
      "ring 1, position 162 of 166 keys (page 0), 166 included in the root",
    );
    expect(shown["devicehood ring root"]).toBe("revision 171, not stale");
  });

  it("leaves the full-people rows saying exactly what they said before", () => {
    const shown = rows(FULL_RING_MISS, {
      devicehood: DEVICEHOOD,
      devicehoodRing: PLACED,
    });

    // The whole point of the pair: included in one ring, absent from the
    // other, and neither row rewritten to agree with the other.
    expect(shown["membership ring"]).toBe("no entry for this key");
    expect(shown["ring read"]).toBe("personhood-key");
    expect(shown["person ring key"]).toBe(HOST_KEY);
  });

  it("names the key and the ring on every row it adds", () => {
    const shown = rows(FULL_RING_MISS, {
      devicehood: DEVICEHOOD,
      devicehoodRing: PLACED,
    });
    const group = Object.entries(shown).filter(([label]) =>
      label.startsWith("devicehood ring"),
    );

    expect(group.map(([label]) => label)).toEqual([
      "devicehood ring key",
      "devicehood ring",
      "devicehood ring slot",
      "devicehood ring root",
      "devicehood ring lookup",
    ]);
    // The standing and the read that produced it name the collection in
    // full, so no row of this group can be mistaken for one about the
    // membership ring — the confusion that hid this state for days.
    expect(shown["devicehood ring lookup"]).toBe(
      `Members.Members(people-lite, ${RING_KEY})`,
    );
    expect(shown["devicehood ring"]).toContain("people-lite");
  });

  it("calls a missing Devicehood record unknown, never absent from the ring", () => {
    const shown = rows(FULL_RING_MISS, { devicehoodRing: { kind: "no-record" } });

    expect(shown["devicehood ring"]).toBe(
      "unknown: no Devicehood record, so no key to place in people-lite",
    );
    // Nothing was read, so nothing may claim to report a read.
    expect(shown).not.toHaveProperty("devicehood ring lookup");
    expect(shown).not.toHaveProperty("devicehood ring slot");
    expect(shown).not.toHaveProperty("devicehood ring root");
  });

  it("calls a failed read unknown rather than a key the ring does not hold", () => {
    const shown = rows(FULL_RING_MISS, {
      devicehood: DEVICEHOOD,
      devicehoodRing: {
        kind: "failed",
        ringVrfKey: RING_KEY,
        error: "Incompatible runtime entry",
      },
    });

    expect(shown["devicehood ring"]).toBe(
      "unknown: the people-lite read failed, see the error row",
    );
    expect(shown["devicehood ring error"]).toBe("Incompatible runtime entry");
    // A failure that reads as "not a member" is the false negative this
    // group exists to prevent.
    expect(shown["devicehood ring"]).not.toContain("no entry");
    expect(shown["devicehood ring lookup"]).toBe(
      `Members.Members(people-lite, ${RING_KEY})`,
    );
  });

  it("says so when the card carried no lite-ring read at all", () => {
    // The mock backend, a debug scenario override, or a card restored from
    // storage: nobody asked, which is not an answer about the ring.
    expect(rows(FULL_RING_MISS)["devicehood ring"]).toBe(
      "unknown: nothing read people-lite for this card",
    );
  });

  it("still reports the slot when only the ring read is missing", () => {
    const shown = rows(FULL_RING_MISS, {
      devicehood: DEVICEHOOD,
      devicehoodRing: {
        ...PLACED,
        standing: { ...PLACED.standing, ring: null },
      },
    });

    expect(shown["devicehood ring slot"]).toBe("ring 1, position 162 (page 0)");
    expect(shown["devicehood ring root"]).toBe("—");
  });

  it("reports the lite ring's own no-entry as the answer it is", () => {
    // Distinct from every unknown above: `Members.Members` answered, and its
    // answer was that the ring holds no entry for the record's key. That is
    // a real negative — a device whose attestation never reached the ring.
    const shown = rows(FULL_RING_MISS, {
      devicehood: DEVICEHOOD,
      devicehoodRing: {
        ...PLACED,
        standing: { ...PLACED.standing, position: { kind: "absent" }, ring: null },
      },
    });

    expect(shown["devicehood ring"]).toBe(
      "no entry for this key — devicehood key 0x8cad…b5ee in people-lite",
    );
    expect(shown).not.toHaveProperty("devicehood ring slot");
  });
});

/**
 * The device-key check row: the panel's own explanation for why the
 * weekly-game card suppressed its seat-binding "Register", placed beside
 * the devicehood ring rows above so the attested key and this verdict read
 * together.
 */
describe("device key check row", () => {
  it("reports a match with the key involved", () => {
    const shown = rows(FULL_RING_MISS, { deviceKeyCheck: { kind: "matches", key: RING_KEY } });
    expect(shown["device key check"]).toBe(`matches — ${RING_KEY}`);
  });

  it("names both keys on a mismatch — the panel is the place for hex", () => {
    const shown = rows(FULL_RING_MISS, {
      deviceKeyCheck: { kind: "mismatch", hostKey: HOST_KEY, chainKey: RING_KEY },
    });
    expect(shown["device key check"]).toBe(
      `mismatch — this device holds ${HOST_KEY}, chain attested ${RING_KEY}`,
    );
  });

  it("names the owner when the host declares no key at all", () => {
    const shown = rows(FULL_RING_MISS, {
      deviceKeyCheck: { kind: "no-host-key", owner: "5CandidateAccount" },
    });
    expect(shown["device key check"]).toBe(
      "no key — 5CandidateAccount declares none on this device",
    );
  });

  it("reports the reason when the check could not answer", () => {
    const shown = rows(FULL_RING_MISS, {
      deviceKeyCheck: { kind: "unknown", reason: "host read timed out" },
    });
    expect(shown["device key check"]).toBe("unknown: host read timed out");
  });

  it("reads as unknown, never as a negative, when nothing checked at all", () => {
    const shown = rows(FULL_RING_MISS);
    expect(shown["device key check"]).toBe("— (nothing checked)");
  });

  it("sits beside the devicehood ring rows so both read together", () => {
    const labels = Object.keys(
      rows(FULL_RING_MISS, {
        devicehood: DEVICEHOOD,
        devicehoodRing: PLACED,
        deviceKeyCheck: { kind: "matches", key: RING_KEY },
      }),
    );
    const ringGroupEnd = labels.indexOf("devicehood ring lookup");
    expect(labels[ringGroupEnd + 1]).toBe("device key check");
  });
});

/**
 * The bind path's own ring-key row — distinct from `device key check row`
 * above, which is sourced from a different, non-bind selection algorithm.
 */
