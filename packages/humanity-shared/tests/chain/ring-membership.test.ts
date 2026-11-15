// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The fixtures are real previewnet reads. Person 3's key and its `Included`
 * position, and the fact that 5 of the 8 people there had `account: None` and
 * so were unreachable from an account at all, were taken 2026-09-04.
 *
 * The ring-standing fixtures are the lite ring at block #89396 on 2026-09-08,
 * the block a weekly-game seat bind failed on: the key sat at ring 1 /
 * position 162, `RingKeysStatus` read `{ total: 165, included: 165 }`, the
 * root was at revision 164, and `StaleRings` was empty. Full coverage and no
 * pending rebuild is the shape that says the chain is done and a host still
 * refusing to prove is refusing for a reason of its own.
 */
import { describe, expect, it, vi } from "vitest";

import {
  readLiteRingStandingForAccount,
  readRingStanding,
  readRingStandingForKey,
  ringIdentifier,
  toRingPosition,
  type RawRingPosition,
  type RingMembershipChain,
} from "@humanity/shared/chain/ring-membership.ts";

/** Person 3 — bound to an account, and included in the ring. */
const PERSON_KEY =
  `0x${"b0".repeat(32)}`;
const BOUND_ACCOUNT = "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy";
const PERSONAL_ID = 3n;

/** The Devicehood key `PeopleLite.LitePeople` carries, distinct from the
 *  Membership key so a test can tell which read placed it. */
const LITE_KEY = `0x${"cd".repeat(32)}`;

const INCLUDED = {
  type: "Included",
  value: { ring_index: 0, ring_page: 0, ring_position: 3 },
} as RawRingPosition;

/** The lite ring at the failing block: assigned, and fully built. */
const LITE_INCLUDED = {
  type: "Included",
  value: { ring_index: 1, ring_page: 0, ring_position: 162 },
} as RawRingPosition;
const LITE_STATUS = { total: 165, included: 165 };
const LITE_ROOT = { root: "0xroot", revision: 164, intermediate: "0xmid" };

function chain(
  overrides: {
    personalId?: bigint | undefined;
    key?: string | undefined;
    position?: RawRingPosition | undefined;
    litePerson?: { ring_vrf_key: string } | undefined;
    status?: { total: number; included: number; immutable_since?: bigint };
    root?: { revision: number } | undefined;
    staleRingIndices?: readonly number[];
  } = {},
) {
  const accountToPersonalId = vi.fn().mockResolvedValue(
    "personalId" in overrides ? overrides.personalId : PERSONAL_ID,
  );
  const personRecord = vi
    .fn()
    .mockResolvedValue(
      "key" in overrides && overrides.key === undefined
        ? undefined
        : { key: overrides.key ?? PERSON_KEY },
    );
  const members = vi
    .fn()
    .mockResolvedValue("position" in overrides ? overrides.position : INCLUDED);
  const litePeople = vi
    .fn()
    .mockResolvedValue(
      "litePerson" in overrides
        ? overrides.litePerson
        : { ring_vrf_key: LITE_KEY },
    );
  const ringKeysStatus = vi
    .fn()
    .mockResolvedValue(overrides.status ?? LITE_STATUS);
  const root = vi
    .fn()
    .mockResolvedValue("root" in overrides ? overrides.root : LITE_ROOT);
  const staleRings = vi.fn().mockResolvedValue(
    (overrides.staleRingIndices ?? []).map((index) => ({
      keyArgs: [ringIdentifier("people-lite"), index],
      value: undefined,
    })),
  );
  return {
    api: {
      query: {
        People: {
          AccountToPersonalId: { getValue: accountToPersonalId },
          People: { getValue: personRecord },
        },
        Members: {
          Members: { getValue: members },
          RingKeysStatus: { getValue: ringKeysStatus },
          Root: { getValue: root },
          StaleRings: { getEntries: staleRings },
        },
        PeopleLite: { LitePeople: { getValue: litePeople } },
      },
    } as unknown as RingMembershipChain,
    accountToPersonalId,
    personRecord,
    members,
    litePeople,
    ringKeysStatus,
    root,
    staleRings,
  };
}

describe("ringIdentifier", () => {
  it("matches the identifiers previewnet keys Members.Members under", () => {
    // `pop:polkadot.network/people` and `…/people-lite`, space-padded to 32
    // bytes. Network-independent — the same on every chain.
    expect(ringIdentifier("people")).toBe(
      "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652020202020",
    );
    expect(ringIdentifier("people-lite")).toBe(
      "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652d6c697465",
    );
  });

  it("separates the two rings, which differ only by collection", () => {
    expect(ringIdentifier("people")).not.toBe(ringIdentifier("people-lite"));
  });
});

/** The ring standing the stubbed reads answer with: the lite ring's real
 *  numbers, whichever collection a plumbing test happens to ask about. */
const BUILT_RING = {
  ringIndex: 0,
  totalKeys: 165,
  includedKeys: 165,
  immutableSinceSeconds: null,
  rootRevision: 164,
  stale: false,
};

describe("toRingPosition", () => {
  it("reads an included key, keeping the slot it landed in", () => {
    // The slot is the whole value: ring, page and position. Anything about
    // whether the root covers it is a property of the ring, not the key.
    expect(toRingPosition(INCLUDED)).toEqual({
      kind: "included",
      ringIndex: 0,
      ringPage: 0,
      ringPosition: 3,
    });
    expect(toRingPosition(LITE_INCLUDED)).toEqual({
      kind: "included",
      ringIndex: 1,
      ringPage: 0,
      ringPosition: 162,
    });
  });

  it("reads onboarding as a waiting room with a queue page and a timestamp", () => {
    // Queued, with the ring not yet rebuilt: earned and not yet provable.
    // The page says where in the queue, which is how far off it is.
    expect(
      toRingPosition({
        type: "Onboarding",
        value: { queue_page: 2, queued_at: 1_788_533_994n },
      } as RawRingPosition),
    ).toEqual({
      kind: "onboarding",
      queuePage: 2,
      queuedAtSeconds: 1_788_533_994,
    });
  });

  it("reads suspension", () => {
    expect(toRingPosition({ type: "Suspended" } as RawRingPosition)).toEqual({
      kind: "suspended",
    });
  });

  it("answers `absent` for a key the ring has never held", () => {
    // An empty storage entry is the ring saying it does not hold this key,
    // which is an answer the card acts on — not a failure to ask.
    expect(toRingPosition(undefined)).toEqual({ kind: "absent" });
    expect(toRingPosition(null)).toEqual({ kind: "absent" });
  });
});

describe("ring standing of an included key", () => {
  it("reports coverage, revision and staleness at the caller's block", async () => {
    // The lite ring at the block a seat bind failed: every key in the root,
    // a root built at revision 164, nothing queued for a rebuild. Chain-side
    // lag is ruled out, so a host that still refuses is refusing on its own.
    const { api, ringKeysStatus, root, staleRings } = chain({
      position: LITE_INCLUDED,
    });
    const at = { at: "0x89396" } as never;

    const standing = await readRingStandingForKey(
      api,
      PERSON_KEY,
      "people-lite",
      at,
    );

    expect(standing.ring).toEqual({
      ringIndex: 1,
      totalKeys: 165,
      includedKeys: 165,
      immutableSinceSeconds: null,
      rootRevision: 164,
      stale: false,
    });
    // The same pinned block as the `Members.Members` read they explain — a
    // second block would let coverage and position disagree.
    const collection = ringIdentifier("people-lite");
    expect(ringKeysStatus).toHaveBeenCalledWith(collection, 1, at);
    expect(root).toHaveBeenCalledWith(collection, 1, at);
    expect(staleRings).toHaveBeenCalledWith(collection, at);
  });

  it("reports a ring that is still building, and says it is stale", async () => {
    // The state that would exonerate the host: the slot is assigned, the root
    // covers only part of the ring, and a rebuild is queued.
    const { api } = chain({
      position: LITE_INCLUDED,
      status: { total: 165, included: 120 },
      staleRingIndices: [1],
    });

    expect(
      (await readRingStandingForKey(api, PERSON_KEY, "people-lite", {} as never))
        .ring,
    ).toEqual({
      ringIndex: 1,
      totalKeys: 165,
      includedKeys: 120,
      immutableSinceSeconds: null,
      rootRevision: 164,
      stale: true,
    });
  });

  it("ignores a stale entry for some other ring of the same collection", async () => {
    const { api } = chain({ position: LITE_INCLUDED, staleRingIndices: [0, 2] });
    expect(
      (await readRingStandingForKey(api, PERSON_KEY, "people-lite", {} as never))
        .ring?.stale,
    ).toBe(false);
  });

  it("reports a ring with no root at all rather than inventing a revision", async () => {
    const { api } = chain({ position: LITE_INCLUDED, root: undefined });
    expect(
      (await readRingStandingForKey(api, PERSON_KEY, "people-lite", {} as never))
        .ring?.rootRevision,
    ).toBeNull();
  });

  it("keeps a sealed ring's immutable-since", async () => {
    // Lite ring 0 is sealed on previewnet; a sealed ring can never take the
    // key, which is why the ring a key is *in* is the one worth reading.
    const { api } = chain({
      position: LITE_INCLUDED,
      status: { total: 255, included: 255, immutable_since: 1_788_533_994n },
    });
    expect(
      (await readRingStandingForKey(api, PERSON_KEY, "people-lite", {} as never))
        .ring?.immutableSinceSeconds,
    ).toBe(1_788_533_994);
  });

  it("does not read a ring for a position that names none", async () => {
    for (const position of [
      undefined,
      { type: "Suspended" } as RawRingPosition,
      {
        type: "Onboarding",
        value: { queue_page: 0, queued_at: 0n },
      } as RawRingPosition,
    ]) {
      const { api, ringKeysStatus, root, staleRings } = chain({ position });
      const standing = await readRingStandingForKey(
        api,
        PERSON_KEY,
        "people-lite",
        {} as never,
      );
      expect(standing.ring).toBeNull();
      expect(ringKeysStatus).not.toHaveBeenCalled();
      expect(root).not.toHaveBeenCalled();
      expect(staleRings).not.toHaveBeenCalled();
    }
  });
});

describe("readRingStandingForKey", () => {
  it("asks the ring about the key directly, with no account walk", async () => {
    const { api, accountToPersonalId, personRecord, members } = chain();
    const at = { at: "0xblock" } as never;

    expect(await readRingStandingForKey(api, PERSON_KEY, "people", at)).toEqual({
      source: "personhood-key",
      personalId: null,
      ringVrfKey: PERSON_KEY,
      position: { kind: "included", ringIndex: 0, ringPage: 0, ringPosition: 3 },
      ring: BUILT_RING,
    });
    expect(members).toHaveBeenCalledWith(ringIdentifier("people"), PERSON_KEY, at);
    // The point of the key-first read: neither of these is needed, so a
    // person who never bound an account is answerable all the same.
    expect(accountToPersonalId).not.toHaveBeenCalled();
    expect(personRecord).not.toHaveBeenCalled();
  });

  it("answers 'not a member' for a key the ring has never held", async () => {
    // With the person's own key in hand, absence from the ring is a fact
    // about them, not a gap in what we could look up — so it is a position
    // of its own and never a missing one.
    const { api } = chain({ position: undefined });
    expect(
      await readRingStandingForKey(api, PERSON_KEY, "people", {} as never),
    ).toEqual({
      source: "personhood-key",
      personalId: null,
      ringVrfKey: PERSON_KEY,
      position: { kind: "absent" },
      ring: null,
    });
  });

  it("reads the Devicehood ring under its own collection", async () => {
    const { api, members } = chain();
    await readRingStandingForKey(api, PERSON_KEY, "people-lite", {} as never);
    expect(members).toHaveBeenCalledWith(
      ringIdentifier("people-lite"),
      PERSON_KEY,
      {},
    );
  });
});

describe("readRingStanding", () => {
  it("walks account → personal id → key → ring position", async () => {
    const { api, accountToPersonalId, personRecord, members } = chain();
    const at = { at: "0xblock" } as never;

    expect(await readRingStanding(api, BOUND_ACCOUNT, "people", at)).toEqual({
      source: "account-binding",
      personalId: PERSONAL_ID,
      ringVrfKey: PERSON_KEY,
      position: { kind: "included", ringIndex: 0, ringPage: 0, ringPosition: 3 },
      ring: BUILT_RING,
    });
    expect(accountToPersonalId).toHaveBeenCalledWith(BOUND_ACCOUNT, at);
    expect(personRecord).toHaveBeenCalledWith(PERSONAL_ID, at);
    expect(members).toHaveBeenCalledWith(ringIdentifier("people"), PERSON_KEY, at);
  });

  it("stops at the first read for an unbound account, without guessing", async () => {
    // Both roads into the ring write `account: None`, so this is the common
    // case — 5 of previewnet's 8 people. `null` says "cannot tell from an
    // account", which is not the same as "not a member".
    const { api, personRecord, members } = chain({ personalId: undefined });

    expect(await readRingStanding(api, BOUND_ACCOUNT, "people", {} as never)).toBeNull();
    expect(personRecord).not.toHaveBeenCalled();
    expect(members).not.toHaveBeenCalled();
  });

  it("is null when a bound id has no person record behind it", async () => {
    const { api, members } = chain({ key: undefined });
    expect(await readRingStanding(api, BOUND_ACCOUNT, "people", {} as never)).toBeNull();
    expect(members).not.toHaveBeenCalled();
  });

  it("distinguishes a key the ring does not hold from an unanswerable account", async () => {
    const { api } = chain({ position: undefined });
    expect(
      await readRingStanding(api, BOUND_ACCOUNT, "people", {} as never),
    ).toEqual({
      source: "account-binding",
      personalId: PERSONAL_ID,
      ringVrfKey: PERSON_KEY,
      position: { kind: "absent" },
      ring: null,
    });
  });

  it("reads the Devicehood ring under its own collection", async () => {
    const { api, members } = chain();
    await readRingStanding(api, BOUND_ACCOUNT, "people-lite", {} as never);
    expect(members).toHaveBeenCalledWith(
      ringIdentifier("people-lite"),
      PERSON_KEY,
      {},
    );
  });
});

describe("readLiteRingStandingForAccount", () => {
  it("takes the key off the lite record and places it in the lite ring", async () => {
    // `PeopleLite.LitePeople` is keyed by account and carries the key the
    // same call registered, so the Devicehood ring is reachable from an
    // account with no `set_personal_id_account` binding at all.
    const { api, members, litePeople, accountToPersonalId, personRecord } =
      chain();
    const at = { at: "0xblock" } as never;

    expect(
      await readLiteRingStandingForAccount(api, BOUND_ACCOUNT, at),
    ).toEqual({
      source: "account-binding",
      personalId: null,
      ringVrfKey: LITE_KEY,
      position: { kind: "included", ringIndex: 0, ringPage: 0, ringPosition: 3 },
      ring: BUILT_RING,
    });
    expect(litePeople).toHaveBeenCalledWith(BOUND_ACCOUNT, at);
    expect(members).toHaveBeenCalledWith(
      ringIdentifier("people-lite"),
      LITE_KEY,
      at,
    );
    // The shortcut's whole point: neither personal-id read is needed.
    expect(accountToPersonalId).not.toHaveBeenCalled();
    expect(personRecord).not.toHaveBeenCalled();
  });

  it("answers `absent` for a lite key the lite ring has no entry for", async () => {
    // Registered once and since dropped from the ring: the key is known, so
    // this is an answer about the person and not a gap.
    const { api } = chain({ position: undefined });
    expect(
      await readLiteRingStandingForAccount(api, BOUND_ACCOUNT, {} as never),
    ).toMatchObject({ ringVrfKey: LITE_KEY, position: { kind: "absent" } });
  });

  it("is null with no lite record, leaving the ring unasked", async () => {
    const { api, members } = chain({ litePerson: undefined });
    expect(
      await readLiteRingStandingForAccount(api, BOUND_ACCOUNT, {} as never),
    ).toBeNull();
    expect(members).not.toHaveBeenCalled();
  });
});
