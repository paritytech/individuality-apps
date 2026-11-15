// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The panel's job is to separate states the card deliberately merges, so the
 *  matrix label and the score/threshold row are what these tests pin.
 *
 *  The candidate product is a network-resolved module constant, so it is
 *  stubbed here: hard-coding a real network's value would couple these
 *  assertions to ambient `VITE_NETWORK` (CI runs `main` PRs as previewnet,
 *  which resolves a different domain), and a sentinel proves the row can only
 *  have come from the constant. */
import { describe, expect, it, vi } from "vitest";

import {
  buildDebugView,
  groupDebugSections,
  type DebugInput,
} from "@features/debug/debug-view.ts";
import { MISSING } from "@features/debug/debug-format.ts";
import { matrixLabel } from "@features/debug/debug-personhood.ts";
import {
  deriveHumanityCardState,
  personhoodStateFor,
  type HumanityCardParticipant,
  type HumanityCardSnapshot,
} from "@humanity/shared/card/humanity-card-state.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import type { DevicehoodRingProbe } from "@humanity/shared/card/humanity-card-data.ts";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";
import type {
  LiteSignUpBlocker,
  LiteSignUpVerdict,
} from "@features/card/domain/lite-signup.ts";
import type { GameAccountDiagnostics } from "@humanity/shared/identity/game-account.ts";
import type {
  PersonRingStanding,
  RingPosition,
} from "@humanity/shared/chain/ring-membership.ts";

const { GAME_PRODUCT, GAME_INDEX } = vi.hoisted(() => ({
  GAME_PRODUCT: "fixture.product",
  GAME_INDEX: 0,
}));

vi.mock("@humanity/shared/identity/game-account.ts", () => ({
  CANDIDATE_PRODUCT_DOMAIN: GAME_PRODUCT,
  GAME_ACCOUNT_INDEX: GAME_INDEX,
}));

const OWNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const PLAYER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

function participant(
  overrides: Partial<HumanityCardParticipant> = {},
): HumanityCardParticipant {
  return {
    score: 4,
    streak: { tag: "Attended", count: 3 },
    attendanceHistory: 0b0000_0101,
    reachedPersonhood: false,
    hasEverReachedPersonhood: false,
    recognition: "NotRecognized",
    lastAttendedGame: 42,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<HumanityCardSnapshot> = {},
): HumanityCardSnapshot {
  return {
    isLitePerson: false,
    isUpgradedIdentity: false,
    participant: participant(),
    personhoodThreshold: 7,
    policy: { allowedMisses: 5, window: 6 },
    membershipRing: null,
    devicehoodRing: null,
    ...overrides,
  };
}

function card(overrides: Partial<DebugInput> = {}): DebugInput {
  const snap = overrides.card == null ? snapshot() : snapshot();
  const resolved: HumanityCardResult = {
    kind: "card",
    primaryUsername: "bob.02",
    accountAddress: OWNER,
    ownerAccount: OWNER,
    participant: snap.participant,
    devicehood: null,
    membershipStanding: null,
    devicehoodRing: null,
    deviceKeyCheck: null,
    state: { kind: "candidate", score: 4, personhoodThreshold: 7, gamesRemaining: 1 },
    playerIdentities: { accountAddress: PLAYER },
    snapshot: snap,
  };
  return {
    network: "previewnet",
    productDomain: "peopl.testnet",
    card: resolved,
    insideContainer: false,
    providerDiagnostics: undefined,
    gameAccountDiagnostics: undefined,
    resourcesAlias: undefined,
    coinage: undefined,
    payoutBalances: undefined,
    hostCalls: [],
    cardPending: false,
    cardError: null,
    game: undefined,
    gamePending: false,
    gameError: null,
    airdrops: undefined,
    airdropsPending: false,
    airdropsError: null,
    ...overrides,
  };
}

function rows(input: DebugInput, title: string): Record<string, string> {
  const section = buildDebugView(input).find((s) => s.title === title);
  if (section == null) throw new Error(`no ${title} section`);
  return Object.fromEntries(section.rows.map((row) => [row.label, row.value]));
}

describe("matrixLabel", () => {
  /** Both arguments come from one snapshot, so a label can only be asserted
   *  for a state the derivation can actually produce. */
  const label = (overrides: Partial<HumanityCardSnapshot> = {}): string => {
    const snap = snapshot(overrides);
    return matrixLabel(
      deriveHumanityCardState(snap),
      personhoodStateFor(snap),
    );
  };

  it("separates a threshold-cleared candidate from a recognized member", () => {
    expect(label({ participant: participant({ reachedPersonhood: true }) })).toContain(
      "Membership ready",
    );
    expect(
      label({
        participant: participant({
          recognition: "Recognized",
          reachedPersonhood: true,
        }),
      }),
    ).toBe("Member (included)");
  });

  it("keeps external recognition a member, whatever the personhood flag says", () => {
    // Which recognition variant produced the member is the `recognition` row's
    // job; this label only has to not demote them.
    expect(
      label({ participant: participant({ recognition: "ExternallyRecognized" }) }),
    ).toBe("Member (included)");
  });

  it("labels the pre-participant and lost states", () => {
    expect(label({ participant: null })).toContain("Not enrolled");
    expect(label({ participant: null, isLitePerson: true })).toContain("Lite person");
    expect(label({ participant: participant({ recognition: "Suspended" }) })).toContain(
      "Suspended",
    );
    expect(
      label({
        participant: participant({
          recognition: "Recognized",
          reachedPersonhood: true,
          attendanceHistory: 0b0000_0000,
        }),
      }),
    ).toContain("Caution");
  });

  it("counts a candidate's remaining games", () => {
    expect(label()).toContain("Candidate (scoring,");
  });

  it("flags a member the ring included with no Score record behind it", () => {
    // The sudo faucet's shape, and the one case the runtime cannot describe:
    // the ring says Member and `derivePersonhoodState` has nothing to fold.
    expect(
      label({
        participant: null,
        membershipRing: { kind: "included", ringIndex: 0, ringPage: 0, ringPosition: 0 },
      }),
    ).toBe("Member (ring inclusion, no Score recognition)");
  });
});

describe("buildDebugView devicehood", () => {
  const KEY = `0x${"ab".repeat(32)}`;
  const ATTESTER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  it("names the attester behind a unique-device recognition", () => {
    const out = rows(
      card({
        card: {
          ...(card().card as Extract<HumanityCardResult, { kind: "card" }>),
          devicehood: {
            ringVrfKey: KEY,
            method: { kind: "unique-device", attester: ATTESTER },
          },
        },
      }),
      "personhood",
    );

    expect(out["devicehood"]).toContain(ATTESTER);
    expect(out["devicehood ring key"]).toBe(KEY);
  });

  it("says a fee registration attested no device", () => {
    const out = rows(
      card({
        card: {
          ...(card().card as Extract<HumanityCardResult, { kind: "card" }>),
          devicehood: { ringVrfKey: KEY, method: { kind: "fee" } },
        },
      }),
      "personhood",
    );

    expect(out["devicehood"]).toContain("no device attestation");
  });

  it("marks devicehood missing rather than guessing when the chain has none", () => {
    expect(rows(card(), "personhood")["devicehood"]).toBe(MISSING);
  });

  it("separates a lite ring that has no entry from one it could not ask", () => {
    const base = card().card as Extract<HumanityCardResult, { kind: "card" }>;
    const placed = (position: RingPosition): DevicehoodRingProbe => ({
      kind: "placed",
      ringVrfKey: KEY,
      standing: {
        source: "personhood-key",
        personalId: null,
        ringVrfKey: KEY as PersonRingStanding["ringVrfKey"],
        position,
        ring: null,
      },
    });

    expect(rows(card(), "personhood")["devicehood ring"]).toBe(
      "unknown: nothing read people-lite for this card",
    );
    expect(
      rows(
        card({ card: { ...base, devicehoodRing: { kind: "no-record" } } }),
        "personhood",
      )["devicehood ring"],
    ).toBe("unknown: no Devicehood record, so no key to place in people-lite");
    expect(
      rows(
        card({ card: { ...base, devicehoodRing: placed({ kind: "absent" }) } }),
        "personhood",
      )["devicehood ring"],
    ).toContain("no entry for this key");
    expect(
      rows(
        card({
          card: {
            ...base,
            devicehoodRing: placed({ kind: "included", ringIndex: 1, ringPage: 0, ringPosition: 0 }),
          },
        }),
        "personhood",
      )["devicehood ring"],
    ).toContain("included (ring 1)");
  });
});

describe("buildDebugView personhood", () => {
  it("reports score against the threshold with the remaining distance", () => {
    expect(rows(card(), "personhood")["score / threshold"]).toBe("4 / 7 (3 to go)");
  });

  it("marks a cleared threshold instead of a negative distance", () => {
    const cleared = card();
    if (cleared.card?.kind !== "card") throw new Error("fixture");
    cleared.card.snapshot.participant = participant({ score: 9, reachedPersonhood: true });
    expect(rows(cleared, "personhood")["score / threshold"]).toBe("9 / 7 (cleared)");
  });

  it("always exposes the grace policy, not only on a caution card", () => {
    expect(rows(card(), "personhood")["grace policy"]).toBe(
      "5 allowed misses / 6 game window",
    );
  });

  it("prints attendance latest-bit-first", () => {
    expect(rows(card(), "personhood")["attendance"]).toBe("10100000 (latest first)");
  });

  it("omits the personhood section when no card resolved", () => {
    const view = buildDebugView(card({ card: { kind: "account-unavailable" } }));
    expect(view.map((section) => section.title)).not.toContain("personhood");
    expect(rows(card({ card: { kind: "account-unavailable" } }), "identity")).toEqual({
      card: "account-unavailable",
    });
  });
  it("separates the unavailable candidate diagnostic from the username owner", () => {
    const unavailable = {
      kind: "account-unavailable",
      primaryUsername: "bob.02",
      accountAddress: OWNER,
      candidateAccount: null,
    } as unknown as HumanityCardResult;
    expect(rows(card({ card: unavailable }), "identity")).toEqual({
      username: "bob.02",
      "username owner": OWNER,
      "candidate account": "unavailable",
    });
  });
});

describe("buildDebugView chain", () => {
  it("reports the host bridge and its acquisition time", () => {
    expect(
      rows(
        card({
          insideContainer: true,
          providerDiagnostics: { provider: "host-bridge", acquisitionMs: 24 },
        }),
        "chain",
      ),
    ).toEqual({
      "inside container": "true",
      provider: "host-bridge",
      "provider acquisition": "24 ms",
      "game account domain": GAME_PRODUCT,
      "game account index": "0",
      "game account outcome": "unresolved",
      "game account elapsed": "unresolved",
      "game account address": "unresolved",
    });
  });

  it("reports host bridge failure details and acquisition time", () => {
    expect(
      rows(
        card({
          insideContainer: true,
          providerDiagnostics: {
            provider: "host-bridge",
            failureReason: "bridge-unavailable",
            acquisitionMs: 8_006,
          },
        }),
        "chain",
      ),
    ).toEqual({
      "inside container": "true",
      provider: "host-bridge",
      "failure reason": "bridge-unavailable",
      "provider acquisition": "8006 ms",
      "game account domain": GAME_PRODUCT,
      "game account index": "0",
      "game account outcome": "unresolved",
      "game account elapsed": "unresolved",
      "game account address": "unresolved",
    });
  });

  it("marks provider and game account diagnostics that have not resolved yet", () => {
    expect(rows(card(), "chain")).toEqual({
      "inside container": "false",
      provider: "unresolved",
      "provider acquisition": "unresolved",
      "game account domain": GAME_PRODUCT,
      "game account index": "0",
      "game account outcome": "unresolved",
      "game account elapsed": "unresolved",
      "game account address": "unresolved",
    });
  });

  it("reports a game account address returned by the host", () => {
    const diagnostics: GameAccountDiagnostics = {
      productDomain: "dim2.paseo",
      index: 0,
      outcome: "resolved",
      elapsedMs: 24,
      address: PLAYER,
    };
    expect(rows(card({ gameAccountDiagnostics: diagnostics }), "chain")).toMatchObject({
      "game account domain": "dim2.paseo",
      "game account index": "0",
      "game account outcome": "resolved",
      "game account elapsed": "24 ms",
      "game account address": PLAYER,
    });
  });

  it("reports a null answer from the host", () => {
    const diagnostics: GameAccountDiagnostics = {
      productDomain: "dim2.paseo",
      index: 0,
      outcome: "null-answer",
      elapsedMs: 16,
    };
    expect(rows(card({ gameAccountDiagnostics: diagnostics }), "chain")).toMatchObject({
      "game account domain": "dim2.paseo",
      "game account index": "0",
      "game account outcome": "null-answer",
      "game account elapsed": "16 ms",
      "game account address": "—",
    });
  });

  it("reports a host call that timed out", () => {
    const diagnostics: GameAccountDiagnostics = {
      productDomain: "dim2.paseo",
      index: 0,
      outcome: "timeout",
      elapsedMs: 30_000,
    };
    expect(rows(card({ gameAccountDiagnostics: diagnostics }), "chain")).toMatchObject({
      "game account domain": "dim2.paseo",
      "game account index": "0",
      "game account outcome": "timeout",
      "game account elapsed": "30000 ms",
      "game account address": "—",
    });
  });
});

describe("buildDebugView session and game", () => {
  it("surfaces query status rather than hiding a failure", () => {
    const failing = card({ cardError: new Error("chain gone"), card: undefined });
    expect(rows(failing, "session")["card query"]).toBe("error: chain gone");
    expect(rows(card({ gamePending: true, game: undefined }), "session")["game query"]).toBe(
      "pending",
    );
  });

  it("reports the live game index, phase and registration flag", () => {
    const game: CurrentGameResult = {
      kind: "game",
      nextGame: null,
      gameIndex: 8,
      gameDateSeconds: 1_800_000_000,
      registrationEndsSeconds: 1_799_000_000,
      playEndsSeconds: 1_799_000_000 + 300,
      airdropsScheduled: 1,
      phase: { label: "registration", nextDeadlineSeconds: null, secondsRemaining: null },
      registered: null,
      liteSignUp: null,
    };
    const view = rows(card({ game }), "weekly game");
    expect(view["game index"]).toBe("8");
    expect(view["phase"]).toBe("registration");
    expect(view["registered"]).toBe("unknown");
    expect(view["plays at"]).toContain("1800000000");
  });

  it("names the fixed candidate product despite stale configuration input", () => {
    const staleProduct = {
      ...card(),
      gameProductDomain: "wrong.dot",
      gameProductIndex: 1,
    } as unknown as DebugInput;
    expect(rows(staleProduct, "session")["game product"]).toBe(
      `${GAME_PRODUCT} / ${GAME_INDEX}`,
    );
    expect(rows(staleProduct, "session")["product domain"]).toBe("peopl.testnet");
  });
});

describe("buildDebugView coinage", () => {
  it("names an unresolved and an unavailable payment surface distinctly", () => {
    expect(rows(card(), "coinage")).toEqual({ payments: "unresolved" });
    expect(rows(card({ coinage: { status: "unavailable" } }), "coinage")["payments"]).toContain(
      "unavailable",
    );
  });

  it("shows the spendable balance raw and in dollars once the host pushes one", () => {
    const view = rows(
      card({ coinage: { status: "subscribed", available: 1_250_000n, updatedAtMs: 0 } }),
      "coinage",
    );
    expect(view["payments"]).toBe("subscribed");
    expect(view["available (base units)"]).toBe("1250000");
    expect(view["available ($, 6 dp)"]).toBe("$1.25");
    expect(view["updated"]).toBe("1970-01-01T00:00:00.000Z");
  });

  it("says so while subscribed but before the first push, and keeps the last balance on interrupt", () => {
    expect(
      rows(card({ coinage: { status: "subscribed", available: null, updatedAtMs: null } }), "coinage")[
        "available"
      ],
    ).toBe("awaiting first balance");
    const interrupted = rows(
      card({ coinage: { status: "interrupted", available: 5n, reason: "host gone" } }),
      "coinage",
    );
    expect(interrupted["payments"]).toBe("interrupted: host gone");
    expect(interrupted["available (base units)"]).toBe("5");
  });
});

describe("buildDebugView payout balances", () => {
  it("names unresolved, pending, unavailable and errored reads distinctly", () => {
    expect(rows(card(), "payout balances")).toEqual({ read: "unresolved" });
    expect(rows(card({ payoutBalances: { status: "pending" } }), "payout balances")).toEqual({
      read: "pending",
    });
    expect(
      rows(card({ payoutBalances: { status: "unavailable" } }), "payout balances")["read"],
    ).toContain("unavailable");
    expect(
      rows(card({ payoutBalances: { status: "error", reason: "rpc down" } }), "payout balances")["read"],
    ).toBe("error: rpc down");
  });

  it("shows both accounts with the prize balance in dollars and the native balance", () => {
    const view = rows(
      card({
        payoutBalances: {
          status: "ok",
          payout: { address: "5Payout", prize: 3_000_000n, native: 42n },
          airdrop: { address: "5Airdrop", prize: null, native: 0n },
          atBlockHash: "0xhead",
          updatedAtMs: 0,
        },
      }),
      "payout balances",
    );
    expect(view["payout account"]).toBe("5Payout");
    expect(view["payout prize balance"]).toBe("$3 · 3000000 base units");
    expect(view["payout native (plancks)"]).toBe("42");
    expect(view["airdrop account"]).toBe("5Airdrop");
    expect(view["airdrop prize balance"]).toBe("none");
    expect(view["at block"]).toBe("0xhead");
  });
});

describe("buildDebugView truAPI", () => {
  it("says none yet before any host call, with no table", () => {
    const section = buildDebugView(card()).find((s) => s.title === "truAPI");
    expect(section?.rows).toEqual([{ label: "calls", value: "none yet" }]);
    expect(section?.table).toBeUndefined();
  });

  it("tabulates one row per method with counts, outcome, args, result and timing", () => {
    const section = buildDebugView(
      card({
        hostCalls: [
          { method: "accounts.getUserId", calls: 3, lastAt: 0, lastElapsedMs: 12, outcome: "ok", args: "", result: "{primaryUsername}" },
          { method: "host.getPaymentManager", calls: 1, lastAt: 0, lastElapsedMs: null, outcome: "pending", args: "", result: "" },
          { method: "payment.topUp", calls: 1, lastAt: 0, lastElapsedMs: 40, outcome: "error", args: "1000000n, ProductAccount{…}", result: "Error: denied" },
        ],
      }),
    ).find((s) => s.title === "truAPI");
    expect(section?.rows[0]?.value).toBe("5 across 3 methods · pending 1 · failed 1");
    expect(section?.table?.columns).toEqual(["method", "×", "last", "args", "result", "ms"]);
    expect(section?.table?.rows).toEqual([
      ["accounts.getUserId", "3", "ok", "—", "{primaryUsername}", "12"],
      ["host.getPaymentManager", "1", "pending", "—", "…", "—"],
      ["payment.topUp", "1", "error", "1000000n, ProductAccount{…}", "Error: denied", "40"],
    ]);
  });
});

describe("groupDebugSections", () => {
  it("folds every built section into a category, in panel order, dropping none", () => {
    const sections = buildDebugView(card());
    const categories = groupDebugSections(sections);
    expect(categories.map((category) => category.name)).toEqual([
      "connection",
      "identity",
      "prizes",
    ]);
    expect(categories.flatMap((category) => category.sections.map((s) => s.title))).toEqual([
      "session", "chain", "truAPI", "identity", "personhood", "resources alias",
      "weekly game", "coinage", "airdrops", "payout balances",
    ]);
  });

  it("refuses a section it has no category for rather than hiding it", () => {
    expect(() => groupDebugSections([{ title: "mystery", rows: [] }])).toThrow(/mystery/);
  });
});

describe("buildDebugView airdrops", () => {
  it("surfaces the airdrops query row in the session section", () => {
    expect(rows(card({ airdropsPending: true }), "session")["airdrops query"]).toBe(
      "pending",
    );
    expect(
      rows(card({ airdropsError: new Error("denied") }), "session")[
        "airdrops query"
      ],
    ).toBe("error: denied");
  });
});

/** The blocker row is the only place the panel explains a verdict, and a bare
 *  tag already cost one session's worth of debugging: `AliasNotBound` reads
 *  like a client-side flag when it is a missing `PeopleLite.AccountToAlias`
 *  entry. These pin the gloss, not the prose. */
describe("buildDebugView seat blockers", () => {
  const gameWith = (verdict: LiteSignUpVerdict): CurrentGameResult => ({
    kind: "game",
    nextGame: null,
    gameIndex: 8,
    gameDateSeconds: 1_800_000_000,
    registrationEndsSeconds: 1_799_000_000,
    playEndsSeconds: 1_799_000_000 + 300,
    airdropsScheduled: 0,
    phase: {
      label: "registration",
      nextDeadlineSeconds: null,
      secondsRemaining: null,
    },
    registered: false,
    liteSignUp: verdict,
  });

  const blockerRow = (blockers: LiteSignUpBlocker[]): string | undefined =>
    rows(
      card({
        game: gameWith({
          canSignUp: false,
          needsBind: blockers.some((b) => b.tag === "AliasNotBound"),
          blockers,
          invitedAccount: null,
        }),
      }),
      "weekly game",
    )["seat blockers"];

  it("names the storage entry and the call that clears AliasNotBound", () => {
    const value = blockerRow([{ tag: "AliasNotBound" }]);

    expect(value).toContain("AliasNotBound");
    expect(value).toContain("PeopleLite.AccountToAlias");
    expect(value).toContain("PeopleLite.set_alias_account");
  });

  it("explains every blocker the verdict carries, not just the first", () => {
    const value = blockerRow([
      { tag: "AliasBoundElsewhere" },
      { tag: "AlreadyPlaying" },
    ]);

    expect(value).toContain("AliasBoundElsewhere");
    expect(value).toContain("Score.score_context");
    expect(value).toContain("AlreadyPlaying");
    expect(value).toContain("Game.UseInviteButAlreadyPlaying");
  });

  it("still prints a blocker tag the table has no gloss for", () => {
    // The SDK widens `LiteSignUpBlocker` on its own schedule; a panel that
    // dropped an unrecognised arm would hide the one fact the chain reported.
    const value = blockerRow([
      { tag: "SomeFutureBlocker" } as unknown as LiteSignUpBlocker,
    ]);

    expect(value).toBe("SomeFutureBlocker");
  });

  it("keeps saying none when the chain reported no blocker", () => {
    expect(blockerRow([])).toBe("none");
  });
});


