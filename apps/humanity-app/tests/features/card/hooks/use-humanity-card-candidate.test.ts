// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The card read itself: which accounts it resolves for, and which reads it
 * makes. `toHumanityCardResult` is a spy so the reads are visible as the
 * inputs they produce — and where a test cares about the resulting state, it
 * runs those inputs through the real assembly, so the ring-first rule is
 * proven end to end from stubbed chain storage.
 *
 * That includes the participant key: the account key is our own road, and
 * the `Person(alias)` fallback behind it, which only an alias bound in
 * `Score.score_context()` may answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { ringIdentifier } from "@humanity/shared/chain/ring-membership.ts";
import type * as CardData from "@humanity/shared/card/humanity-card-data.ts";
import type { HumanityCardReadInputs } from "@humanity/shared/card/humanity-card-data.ts";

const OWNER = "5UsernameOwner";
const CANDIDATE = "5CandidateAccount";
/** Key #0, the Membership key the host derives for this product. */
const MEMBERSHIP_KEY = `0x${"11".repeat(32)}`;
/** Key #1, the Devicehood key. A different key in a different ring. */
const LITE_KEY = `0x${"22".repeat(32)}`;
/** The contextual alias a full-key person signed up with. */
const PERSON_ALIAS = `0x${"33".repeat(32)}`;
/** `Score.score_context()`: the only context whose alias keys a participant. */
const SCORE_CONTEXT = `0x${"5c".repeat(32)}`;

const INCLUDED = {
  type: "Included",
  value: { ring_index: 0, ring_page: 0, ring_position: 3 },
};

type CardQuery = {
  enabled: boolean;
  queryKey: readonly unknown[];
  queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
};

const mocks = vi.hoisted(() => {
  const queries: Array<{
    enabled: boolean;
    queryKey: readonly unknown[];
    queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
  }> = [];
  return {
    getPeopleClient: vi.fn(),
    identityQuery: {
      data: undefined as
        | { primaryUsername: string; username: string; isUpgraded: boolean }
        | undefined,
      error: null,
      isFetching: false,
      isPending: true,
    },
    gameAccountQuery: { data: undefined as string | null | undefined, isPending: true },
    queries,
    useGameAccount: vi.fn(),
    readPersonhoodRingKey: vi.fn(),
    toHumanityCardResult: vi.fn(),
  };
});

// Hands the Pocket card its face; covered by its own test.
vi.mock("@features/card/hooks/use-pocket-face-hint.ts", () => ({ usePocketFaceHint: () => undefined }));
vi.mock("@features/card/hooks/use-candidate-overlay.ts", () => ({
  useCandidateOverlay: (card: unknown) => card,
}));

vi.mock("react", () => ({
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: (effect: () => void) => effect(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (query: CardQuery) => {
    mocks.queries.push(query);
    return { data: undefined, error: null, isPending: false };
  },
}));
vi.mock("polkadot-api", () => ({
  Binary: { fromText: (value: string) => value },
  Enum: (kind: string, value: string) => [kind, value],
}));
vi.mock("@humanity/shared/chain/bounded-read.ts", () => ({
  runBoundedChainRead: (
    _signal: AbortSignal,
    read: (signal: AbortSignal & { throwIfAborted: () => void }) => Promise<unknown>,
  ) => read(Object.assign(new AbortController().signal, { throwIfAborted: () => undefined })),
}));
vi.mock("@shared/chain/query-state.ts", () => ({ blockingError: () => null }));
vi.mock("@humanity/shared/chain/client.ts", () => ({ getPeopleClient: mocks.getPeopleClient }));
vi.mock("@humanity/shared/chain/username-signing-context.ts", () => ({ usernameSigningContext: async () => null }));
vi.mock("@humanity/shared/card/humanity-card-data.ts", async (importActual) => ({
  ...(await importActual<typeof import("@humanity/shared/card/humanity-card-data.ts")>()),
  toHumanityCardResult: mocks.toHumanityCardResult,
}));
// The host's key registry, per ring: the two rings are asked for different
// keys, and a host may hold one and not the other.
vi.mock("@humanity/shared/identity/personhood-ring-key.ts", () => ({
  readPersonhoodRingKey: mocks.readPersonhoodRingKey,
}));
vi.mock("@features/card/hooks/use-humanity-user-id.ts", () => ({
  useHumanityUserId: () => mocks.identityQuery,
}));
vi.mock("@features/card/hooks/use-game-account.ts", () => ({
  useGameAccount: (...args: unknown[]) => {
    mocks.useGameAccount(...args);
    return mocks.gameAccountQuery;
  },
}));
vi.mock("@features/card/hooks/use-username-upgrade-marker.ts", () => ({
  useUsernameUpgradeOverlay: (card: unknown) => card,
}));
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

import { useHumanityCard } from "@features/card/hooks/use-humanity-card.ts";
import { toHumanityCardResult } from "@humanity/shared/card/humanity-card-data.ts";

/** The real assembly, for the tests that assert a derived card state. */
const { toHumanityCardResult: assembleCard } = await vi.importActual<
  typeof CardData
>("@humanity/shared/card/humanity-card-data.ts");

function latestCardQuery(): CardQuery {
  const query = mocks.queries.at(-1);
  if (query == null) throw new Error("card query was not created");
  return query;
}

function renderCard(): CardQuery {
  mocks.queries.length = 0;
  useHumanityCard(true);
  return latestCardQuery();
}

/** The reads `toHumanityCardResult` was handed — the card read's real output. */
function cardInputs(): HumanityCardReadInputs {
  const call = mocks.toHumanityCardResult.mock.calls.at(-1);
  if (call == null) throw new Error("the card result was never assembled");
  return call[0] as HumanityCardReadInputs;
}

/** Which ring key the host holds, by ring. Absent means the host has none. */
function hostHoldsKeys(keys: { people?: string; "people-lite"?: string }): void {
  mocks.readPersonhoodRingKey.mockImplementation((_network, ring: string) =>
    Promise.resolve(keys[ring as keyof typeof keys] ?? null),
  );
}

function chainApi() {
  const usernameOwnerOf = { getValue: vi.fn().mockResolvedValue(OWNER) };
  const participants = { getValue: vi.fn().mockResolvedValue(null) };
  const litePeople = { getValue: vi.fn().mockResolvedValue(null) };
  const personhoodThreshold = { getValue: vi.fn().mockResolvedValue(7) };
  const absenceGraceRatio = { getValue: vi.fn().mockResolvedValue("0x0506") };
  const aliases = { getValue: vi.fn().mockResolvedValue(null) };
  // Keyed by account, so the two-account Membership walk is observable.
  const personalIds = new Map<string, bigint>();
  const accountToPersonalId = {
    getValue: vi.fn((account: string) => Promise.resolve(personalIds.get(account))),
  };
  const personRecords = { getValue: vi.fn().mockResolvedValue(undefined) };
  // `Members.Members` is keyed by (ring collection, ring-VRF key), so one
  // stub answers both rings and a missing entry is an absent key.
  const ringEntries = new Map<string, unknown>();
  const ringMembers = {
    getValue: vi.fn((collection: string, key: string) =>
      Promise.resolve(ringEntries.get(`${collection}|${key}`)),
    ),
  };
  // A runtime constant, not storage: the alias fallback asks for it once,
  // and only when the account key came back empty.
  const scoreContext = vi.fn().mockResolvedValue(SCORE_CONTEXT);
  return {
    client: { getFinalizedBlock: vi.fn().mockResolvedValue({ hash: "0xblock" }) },
    api: {
      query: {
        Resources: {
          UsernameOwnerOf: usernameOwnerOf,
          Consumers: { getValue: vi.fn().mockResolvedValue(undefined) },
        },
        Score: {
          Participants: participants,
          PersonhoodThreshold: personhoodThreshold,
          AbsenceGraceRatio: absenceGraceRatio,
        },
        People: {
          AccountToAlias: aliases,
          AccountToPersonalId: accountToPersonalId,
          People: personRecords,
        },
        Members: {
          Members: ringMembers,
          RingKeysStatus: {
            getValue: vi.fn().mockResolvedValue({ total: 1, included: 1 }),
          },
          Root: { getValue: vi.fn().mockResolvedValue({ revision: 1 }) },
          StaleRings: { getEntries: vi.fn().mockResolvedValue([]) },
        },
        PeopleLite: { LitePeople: litePeople },
      },
      constants: { Score: { score_context: scoreContext } },
    },
    absenceGraceRatio,
    accountToPersonalId,
    aliases,
    litePeople,
    participants,
    personalIds,
    personRecords,
    personhoodThreshold,
    ringEntries,
    ringMembers,
    scoreContext,
    usernameOwnerOf,
  };
}

/** Identity resolved and a candidate account in hand — the normal case. */
function resolvedIdentity(): void {
  mocks.identityQuery.data = {
    primaryUsername: "alice.42.dot",
    username: "alice.42",
    isUpgraded: false,
  };
  mocks.identityQuery.isPending = false;
  mocks.gameAccountQuery.data = CANDIDATE;
  mocks.gameAccountQuery.isPending = false;
}

beforeEach(() => {
  mocks.toHumanityCardResult.mockReturnValue({ kind: "card" });
  hostHoldsKeys({});
});

afterEach(() => {
  mocks.getPeopleClient.mockReset();
  mocks.toHumanityCardResult.mockReset();
  mocks.readPersonhoodRingKey.mockReset();
  mocks.identityQuery.data = undefined;
  mocks.identityQuery.isPending = true;
  mocks.gameAccountQuery.data = undefined;
  mocks.gameAccountQuery.isPending = true;
  mocks.useGameAccount.mockClear();
  mocks.queries.length = 0;
});

describe("useHumanityCard candidate account", () => {
  it("uses the finalized linked name even when the host still returns the lite name", async () => {
    mocks.identityQuery.data = {
      primaryUsername: "alice.42.dot", username: "alice.42", isUpgraded: false,
    };
    mocks.identityQuery.isPending = false;
    mocks.gameAccountQuery.data = CANDIDATE;
    mocks.gameAccountQuery.isPending = false;
    const chain = chainApi();
    chain.api.query.Resources.Consumers.getValue.mockResolvedValue({
      full_username: new TextEncoder().encode("aliceperson"),
    });
    mocks.getPeopleClient.mockResolvedValue(chain);
    await renderCard().queryFn({ signal: new AbortController().signal });
    expect(chain.api.query.Resources.Consumers.getValue).toHaveBeenCalledWith(
      OWNER, expect.objectContaining({ at: "0xblock" }),
    );
    expect(toHumanityCardResult).toHaveBeenLastCalledWith(expect.objectContaining({
      primaryUsername: "aliceperson.dot", isUpgradedIdentity: true, ownerAccount: OWNER,
    }));
    expect(mocks.identityQuery.data.username).toBe("alice.42");
  });
  it("starts the card read while the candidate account is pending and refreshes it once resolved", () => {
    expect(renderCard()).toMatchObject({
      enabled: false,
      queryKey: ["chain", "humanity-card", "none", "pending-game-account"],
    });
    expect(mocks.useGameAccount).toHaveBeenLastCalledWith(undefined, true);

    mocks.identityQuery.data = {
      primaryUsername: "alice.42.dot",
      username: "alice.42",
      isUpgraded: false,
    };
    mocks.identityQuery.isPending = false;
    expect(renderCard()).toMatchObject({
      enabled: true,
      queryKey: [
        "chain", "humanity-card", "alice.42", "pending-game-account",
      ],
    });
    expect(mocks.useGameAccount).toHaveBeenLastCalledWith("alice.42", true);

    mocks.gameAccountQuery.data = CANDIDATE;
    mocks.gameAccountQuery.isPending = false;
    expect(renderCard()).toMatchObject({
      enabled: true,
      queryKey: ["chain", "humanity-card", "alice.42", CANDIDATE],
    });
  });

  it("reads the score on the game account alone", async () => {
    resolvedIdentity();
    const record = {
      score: 1,
      streak: { type: "Attended", value: 1 },
      attendance_history: 0b1,
      credit: 0n,
      cashed_out: false,
      reached_personhood: true,
      has_ever_reached_personhood: true,
      recognition: { type: "NotRecognized", value: undefined },
      last_attended_game: 3,
    };
    const chain = chainApi();
    chain.participants.getValue.mockImplementation(([, account]: [string, string]) =>
      Promise.resolve(account === CANDIDATE ? record : null),
    );
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    expect(chain.participants.getValue).toHaveBeenCalledTimes(1);
    expect(chain.participants.getValue).toHaveBeenCalledWith(
      ["Account", CANDIDATE], expect.objectContaining({ at: "0xblock" }),
    );
    expect(cardInputs()).toMatchObject({
      gameAccount: CANDIDATE,
      rawParticipant: record,
      participantKey: "account",
    });
  });

  it("short-circuits a null candidate account to account-unavailable without Score or PeopleLite reads", async () => {
    resolvedIdentity();
    mocks.gameAccountQuery.data = null;
    const chain = chainApi();
    mocks.getPeopleClient.mockResolvedValue(chain);

    const result = await renderCard().queryFn({ signal: new AbortController().signal });

    expect(result).toMatchObject({
      kind: "account-unavailable",
      primaryUsername: "alice.42.dot",
      accountAddress: OWNER,
      candidateAccount: null,
    });
    expect(chain.usernameOwnerOf.getValue).toHaveBeenCalledTimes(1);
    expect(chain.participants.getValue).not.toHaveBeenCalled();
    expect(chain.litePeople.getValue).not.toHaveBeenCalled();
    expect(chain.personhoodThreshold.getValue).not.toHaveBeenCalled();
    expect(chain.absenceGraceRatio.getValue).not.toHaveBeenCalled();
    // No game account means no card at all, so neither ring is asked about.
    expect(mocks.readPersonhoodRingKey).not.toHaveBeenCalled();
    expect(chain.ringMembers.getValue).not.toHaveBeenCalled();
  });
});

/**
 * `Game.sign_up_with_account_lite_invite` — our road — writes
 * `Participants[Account(game account)]`, but a person who already held a full
 * key signed up through `Game.sign_up_with_alias`, which writes
 * `Participants[Person(alias)]`. `People.AccountToAlias` is the only bridge
 * from an account we hold to that alias, and only a binding in
 * `Score.score_context()` is the alias the score pallet keyed.
 */
describe("useHumanityCard alias-keyed participant", () => {
  /** What our own sign-up road writes: a record under the account key. */
  const ACCOUNT_PARTICIPANT = {
    score: 7,
    streak: { type: "Attended", value: 2 },
    attendance_history: 0xff,
    credit: 0n,
    cashed_out: false,
    reached_personhood: true,
    has_ever_reached_personhood: true,
    recognition: { type: "Recognized", value: 3n },
    last_attended_game: 12,
  };
  /** What `onboard_externally_recognized` writes, under the alias key. */
  const PERSON_PARTICIPANT = {
    ...ACCOUNT_PARTICIPANT,
    score: 11,
    recognition: { type: "ExternallyRecognized", value: 5n },
    last_attended_game: 14,
  };

  /** One storage entry as `chainApi` hands its spy over. */
  type StorageSpy = { getValue: Mock };

  /** `People.AccountToAlias` answers for the named accounts and no others. */
  function bindAliases(
    aliases: StorageSpy,
    bindings: Record<string, { context: string; alias: string }>,
  ): void {
    aliases.getValue.mockImplementation((account: string) => {
      const ca = bindings[account];
      return Promise.resolve(ca == null ? undefined : { ca, ring: 0, revision: 1 });
    });
  }

  /** Only the `Person(PERSON_ALIAS)` key holds a record. */
  function answerPersonKey(participants: StorageSpy): void {
    participants.getValue.mockImplementation((key: [string, string]) =>
      Promise.resolve(
        key[0] === "Person" && key[1] === PERSON_ALIAS ? PERSON_PARTICIPANT : null,
      ),
    );
  }

  it("stops at the account key when that key holds the record", async () => {
    resolvedIdentity();
    const chain = chainApi();
    chain.participants.getValue.mockResolvedValue(ACCOUNT_PARTICIPANT);
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    expect(chain.participants.getValue).toHaveBeenCalledTimes(1);
    expect(chain.participants.getValue).toHaveBeenCalledWith(
      ["Account", CANDIDATE],
      expect.any(Object),
    );
    // The score context is a further read, so it is never asked for here.
    expect(chain.scoreContext).not.toHaveBeenCalled();
    expect(cardInputs().rawParticipant).toBe(ACCOUNT_PARTICIPANT);
  });

  it("falls back to the game account's alias when the account key is empty", async () => {
    resolvedIdentity();
    const chain = chainApi();
    bindAliases(chain.aliases, {
      [CANDIDATE]: { context: SCORE_CONTEXT, alias: PERSON_ALIAS },
    });
    answerPersonKey(chain.participants);
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    // The account key is still our own road, and still asked first.
    expect(chain.participants.getValue.mock.calls.map((call) => call[0])).toEqual([
      ["Account", CANDIDATE],
      ["Person", PERSON_ALIAS],
    ]);
    expect(cardInputs().rawParticipant).toMatchObject({
      score: 11,
      recognition: { type: "ExternallyRecognized" },
      last_attended_game: 14,
    });
  });

  it("reads the username owner's alias when the game account has no binding", async () => {
    // The two accounts we hold: an app-made person binds the game account,
    // but a person who arrived with a full key may bind only the owner.
    resolvedIdentity();
    const chain = chainApi();
    bindAliases(chain.aliases, {
      [OWNER]: { context: SCORE_CONTEXT, alias: PERSON_ALIAS },
    });
    answerPersonKey(chain.participants);
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    expect(chain.aliases.getValue).toHaveBeenCalledWith(CANDIDATE, expect.any(Object));
    expect(chain.aliases.getValue).toHaveBeenCalledWith(OWNER, expect.any(Object));
    expect(chain.participants.getValue).toHaveBeenCalledWith(
      ["Person", PERSON_ALIAS],
      expect.any(Object),
    );
    expect(cardInputs().rawParticipant).toBe(PERSON_PARTICIPANT);
  });

  it("asks for the alias once when the owner is the game account", async () => {
    resolvedIdentity();
    const chain = chainApi();
    chain.usernameOwnerOf.getValue.mockResolvedValue(CANDIDATE);
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    expect(chain.aliases.getValue).toHaveBeenCalledTimes(1);
    expect(chain.aliases.getValue).toHaveBeenCalledWith(CANDIDATE, expect.any(Object));
  });

  it("never reads a Person key for an alias bound outside the score context", async () => {
    // Resources and airdrop contexts bind aliases of their own. Those are a
    // different person-to-context alias and can never be the score key.
    resolvedIdentity();
    const chain = chainApi();
    bindAliases(chain.aliases, {
      [CANDIDATE]: { context: `0x${"aa".repeat(32)}`, alias: PERSON_ALIAS },
    });
    answerPersonKey(chain.participants);
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    expect(chain.scoreContext).toHaveBeenCalledTimes(1);
    expect(chain.participants.getValue.mock.calls.map((call) => call[0])).toEqual([
      ["Account", CANDIDATE],
    ]);
    expect(cardInputs().rawParticipant).toBeNull();
  });

  it("matches the score context regardless of hex case", async () => {
    resolvedIdentity();
    const chain = chainApi();
    bindAliases(chain.aliases, {
      [CANDIDATE]: { context: SCORE_CONTEXT.toUpperCase(), alias: PERSON_ALIAS },
    });
    answerPersonKey(chain.participants);
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    expect(chain.participants.getValue).toHaveBeenCalledWith(
      ["Person", PERSON_ALIAS],
      expect.any(Object),
    );
    expect(cardInputs().rawParticipant).toBe(PERSON_PARTICIPANT);
  });

  it("reads no alias beyond the game account when the name has no owner", async () => {
    resolvedIdentity();
    const chain = chainApi();
    chain.usernameOwnerOf.getValue.mockResolvedValue(undefined);
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    expect(chain.aliases.getValue).toHaveBeenCalledTimes(1);
    expect(chain.aliases.getValue).toHaveBeenCalledWith(CANDIDATE, expect.any(Object));
    expect(cardInputs().rawParticipant).toBeNull();
  });
});

describe("useHumanityCard unregistered DotNS name", () => {
  it("still resolves a card, from the rings rather than the name", async () => {
    // The DotNS name used to gate the whole card: no owner on chain meant
    // `account-unavailable`, which hid a person the rings can answer for.
    resolvedIdentity();
    const chain = chainApi();
    chain.usernameOwnerOf.getValue.mockResolvedValue(undefined);
    chain.ringEntries.set(`${ringIdentifier("people")}|${MEMBERSHIP_KEY}`, INCLUDED);
    hostHoldsKeys({ people: MEMBERSHIP_KEY });
    mocks.getPeopleClient.mockResolvedValue(chain);

    const result = await renderCard().queryFn({ signal: new AbortController().signal });

    expect(result).toEqual({ kind: "card", usernameUpgradeSupported: false });
    expect(cardInputs()).toMatchObject({
      ownerAccount: null,
      litePerson: null,
      membershipStanding: {
        source: "personhood-key",
        position: { kind: "included", ringIndex: 0 },
      },
      devicehoodRing: { kind: "no-record" },
    });
    // Both reads keyed by the owner account are skipped, not guessed.
    expect(chain.litePeople.getValue).not.toHaveBeenCalled();
    expect(chain.accountToPersonalId.getValue).not.toHaveBeenCalledWith(
      undefined,
      expect.anything(),
    );
    expect(assembleCard(cardInputs()).state).toEqual({
      kind: "member",
      activeWeeks: 0,
      lastAttendedGame: null,
      attendanceHistory: null,
      window: 6,
    });
  });

  it("reports no display address when neither the name nor the game account resolves", async () => {
    resolvedIdentity();
    mocks.gameAccountQuery.data = null;
    const chain = chainApi();
    chain.usernameOwnerOf.getValue.mockResolvedValue(undefined);
    mocks.getPeopleClient.mockResolvedValue(chain);

    expect(
      await renderCard().queryFn({ signal: new AbortController().signal }),
    ).toMatchObject({
      kind: "account-unavailable",
      primaryUsername: "alice.42.dot",
      accountAddress: undefined,
    });
  });
});

describe("useHumanityCard ring reads", () => {
  it("asks the Membership ring about the host's key, and the lite ring about the record's", async () => {
    resolvedIdentity();
    const chain = chainApi();
    chain.litePeople.getValue.mockResolvedValue({
      ring_vrf_key: LITE_KEY,
      method: { type: "Fee" },
    });
    chain.ringEntries.set(`${ringIdentifier("people-lite")}|${LITE_KEY}`, INCLUDED);
    hostHoldsKeys({ people: MEMBERSHIP_KEY, "people-lite": LITE_KEY });
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    expect(mocks.readPersonhoodRingKey).toHaveBeenCalledWith(
      expect.anything(),
      "people",
    );
    expect(chain.ringMembers.getValue).toHaveBeenCalledWith(
      ringIdentifier("people"),
      MEMBERSHIP_KEY,
      expect.any(Object),
    );
    expect(chain.ringMembers.getValue).toHaveBeenCalledWith(
      ringIdentifier("people-lite"),
      LITE_KEY,
      expect.any(Object),
    );
    const inputs = cardInputs();
    expect(inputs).toMatchObject({
      rawParticipant: null,
      membershipStanding: { position: { kind: "absent" } },
      devicehoodRing: {
        kind: "placed",
        ringVrfKey: LITE_KEY,
        standing: { position: { kind: "included", ringIndex: 0 } },
      },
    });
    expect(chain.accountToPersonalId.getValue).not.toHaveBeenCalled();
    expect(assembleCard(inputs).state).toEqual({ kind: "devicehood", personhoodThreshold: 7 });
  });

  it("places nothing in the lite ring when the host holds a lite key but the chain has no record", async () => {
    resolvedIdentity();
    const chain = chainApi();
    chain.ringEntries.set(`${ringIdentifier("people-lite")}|${LITE_KEY}`, INCLUDED);
    hostHoldsKeys({ people: MEMBERSHIP_KEY, "people-lite": LITE_KEY });
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    expect(chain.ringMembers.getValue).not.toHaveBeenCalledWith(
      ringIdentifier("people-lite"),
      LITE_KEY,
      expect.any(Object),
    );
    expect(cardInputs().devicehoodRing).toEqual({ kind: "no-record" });
  });

  it("reaches the lite ring through PeopleLite when the host has no lite key", async () => {
    // `PeopleLite.LitePeople` is keyed by account and carries the key it
    // registered, so the owner account is a road to the lite ring even with
    // no key from the host and no personal-id binding.
    resolvedIdentity();
    const chain = chainApi();
    chain.litePeople.getValue.mockResolvedValue({
      ring_vrf_key: LITE_KEY,
      method: { type: "Fee" },
    });
    chain.ringEntries.set(`${ringIdentifier("people-lite")}|${LITE_KEY}`, INCLUDED);
    hostHoldsKeys({ people: MEMBERSHIP_KEY });
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    expect(chain.litePeople.getValue).toHaveBeenCalledWith(OWNER, expect.any(Object));
    expect(chain.ringMembers.getValue).toHaveBeenCalledWith(
      ringIdentifier("people-lite"),
      LITE_KEY,
      expect.any(Object),
    );
    const inputs = cardInputs();
    expect(inputs.devicehoodRing).toMatchObject({
      kind: "placed",
      ringVrfKey: LITE_KEY,
      standing: {
        source: "personhood-key",
        ringVrfKey: LITE_KEY,
        position: { kind: "included", ringIndex: 0 },
      },
    });
    expect(assembleCard(inputs).state).toEqual({ kind: "devicehood", personhoodThreshold: 7 });
  });

  it("walks the candidate account then the owner for Membership without a host key", async () => {
    // The fallback depends on a `set_personal_id_account` most people never
    // send, which is why it is second. The candidate account is what the
    // binding names in practice; the owner is the other account we hold.
    resolvedIdentity();
    const chain = chainApi();
    chain.personalIds.set(OWNER, 3n);
    chain.personRecords.getValue.mockResolvedValue({ key: MEMBERSHIP_KEY });
    chain.ringEntries.set(`${ringIdentifier("people")}|${MEMBERSHIP_KEY}`, INCLUDED);
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    expect(chain.accountToPersonalId.getValue).toHaveBeenCalledWith(
      CANDIDATE,
      expect.any(Object),
    );
    expect(chain.accountToPersonalId.getValue).toHaveBeenCalledWith(
      OWNER,
      expect.any(Object),
    );
    expect(cardInputs().membershipStanding).toMatchObject({
      source: "account-binding",
      personalId: 3n,
      position: { kind: "included", ringIndex: 0 },
    });
  });

  it("leaves both standings unanswerable when no key and no binding exist", async () => {
    resolvedIdentity();
    const chain = chainApi();
    mocks.getPeopleClient.mockResolvedValue(chain);

    await renderCard().queryFn({ signal: new AbortController().signal });

    expect(cardInputs()).toMatchObject({
      membershipStanding: null,
      devicehoodRing: { kind: "no-record" },
    });
    // Unanswerable, never "not a member": nothing was read to say otherwise.
    expect(chain.ringMembers.getValue).not.toHaveBeenCalled();
  });
});
