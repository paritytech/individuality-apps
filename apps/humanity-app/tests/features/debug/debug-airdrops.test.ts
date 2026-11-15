// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The airdrops builders are pure, so these tests cover the bits that the
 * buildDebugView tests only sample: the per-draw table cells for every status
 * branch and the new-claimable vs already-claimed distinction the runtime
 * produces by *removing* a winner entry on a successful claim.
 */
import { describe, expect, it } from "vitest";

import { airdropDrawsTable, airdropRows } from "@features/debug/debug-airdrops.ts";
import { buildDebugView, type DebugInput } from "@features/debug/debug-view.ts";
import type {
  AirdropDraw,
  AirdropParticipation,
  AirdropStanding,
} from "@individuality/daily-dollar";

const ALIAS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEEDED = "0x1234567890abcdef1234567890abcdef12345678";
const SLOT = "0x1111111111111111111111111111111111111111111111111111111111111111";
const BLOCK = "0x0000000000000000000000000000000000000000000000000000000000000000";

function draw(overrides: Partial<AirdropDraw> = {}): AirdropDraw {
  return {
    eventId: BLOCK,
    drawIndex: 0n,
    status: "Scheduled",
    registrationStartsSeconds: 1_700_000_000,
    drawTimeSeconds: 1_700_500_000,
    endTimeSeconds: 1_701_500_000,
    prizeAmount: 1000n,
    assetId: 0,
    maxWinners: 1,
    totalParticipants: null,
    effectiveWinners: null,
    claimed: null,
    ...overrides,
  };
}

function participation(overrides: Partial<AirdropParticipation>): AirdropParticipation {
  return {
    draw: draw(),
    slot: SLOT,
    registered: false,
    winner: null,
    claimed: null,
    ...overrides,
  };
}

function standing(participations: AirdropParticipation[], overrides: Partial<AirdropStanding> = {}): AirdropStanding {
  return {
    participations,
    alias: ALIAS,
    airdropsContext: NEEDED,
    aliasContext: NEEDED,
    contextMatches: true,
    atBlockHash: BLOCK,
    ...overrides,
  };
}

const STATUS = 1;
const YOU = 2;
const COUNTS = 3;
const DEADLINE = 4;
const CLAIM_WINDOW = 5;

function tableRow(
  participations: AirdropParticipation[],
  nowSeconds: number,
  label = "#0",
): readonly string[] {
  const row = airdropDrawsTable(standing(participations), nowSeconds)?.rows.find(
    (cells) => cells[0] === label,
  );
  if (row == null) throw new Error(`no ${label} row`);
  return row;
}

describe("airdropRows", () => {
  it("renders the query/account/alias/context/draws header rows", () => {
    const rows = airdropRows(standing([]), false, null, 1_700_000_000);
    const labels = rows.map((row) => row.label);
    expect(labels).toContain("query");
    expect(labels).toContain("airdrop account");
    expect(labels).toContain("alias");
    expect(labels).toContain("context");
    expect(labels).toContain("draws");
    const aliasRow = rows.find((row) => row.label === "alias");
    expect(aliasRow?.value).toBe("0xaaaa…aaaa");
    const contextRow = rows.find((row) => row.label === "context");
    expect(contextRow?.value).toBe("ok");
    const drawsRow = rows.find((row) => row.label === "draws");
    expect(drawsRow?.value).toBe("0 · registered 0 · won 0 · claimable 0");
  });

  it("reports the alias as MISSING when none is set", () => {
    const rows = airdropRows(
      standing([], { alias: null, aliasContext: null, contextMatches: false }),
      false,
      null,
      1_700_000_000,
    );
    const aliasRow = rows.find((row) => row.label === "alias");
    expect(aliasRow?.value).toBe("—");
  });

  it("passes pending and error through queryStatus verbatim", () => {
    expect(airdropRows(undefined, true, null, 1_700_000_000)[0]).toEqual({
      label: "query",
      value: "pending",
    });
    expect(airdropRows(undefined, false, new Error("denied"), 1_700_000_000)[0]).toEqual({
      label: "query",
      value: "error: denied",
    });
    expect(airdropRows(undefined, false, null, 1_700_000_000)[0]).toEqual({
      label: "query",
      value: "no data",
    });
  });

  it("names the context-mismatch row with both contexts", () => {
    const mismatched = standing([], {
      aliasContext: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      contextMatches: false,
    });
    const context = airdropRows(mismatched, false, null, 1_700_000_000).find(
      (row) => row.label === "context",
    )?.value;
    expect(context).toContain("mismatch");
    expect(context).toContain("0xdead…beef");
    expect(context).toContain("0x1234…5678");
  });

  it("emits no per-draw rows: those live in the table", () => {
    const rows = airdropRows(
      standing([participation({ draw: draw({ drawIndex: 7n }) })]),
      false,
      null,
      1_700_000_000,
    );
    expect(rows.map((row) => row.label)).toEqual([
      "query",
      "airdrop account",
      "alias",
      "context",
      "draws",
    ]);
  });

  it("counts registered, won and claimable against the cap-relevant clock", () => {
    const inWindow = draw({
      drawIndex: 0n,
      status: "Claiming",
      endTimeSeconds: 1_700_500_000,
      totalParticipants: 8,
      effectiveWinners: 1,
      claimed: 0,
    });
    const expired = draw({
      drawIndex: 1n,
      status: "Claiming",
      endTimeSeconds: 1_699_500_000,
      totalParticipants: 8,
      effectiveWinners: 1,
      claimed: 0,
    });
    const rows = airdropRows(
      standing([
        participation({ draw: inWindow, registered: true, winner: true, claimed: false }),
        participation({ draw: expired, registered: true, winner: true, claimed: false }),
      ]),
      false,
      null,
      1_700_000_000,
    );
    const draws = rows.find((row) => row.label === "draws")?.value;
    expect(draws).toBe("2 · registered 2 · won 2 · claimable 1");
  });
});

describe("airdropDrawsTable", () => {
  it("is undefined without a standing or without draws", () => {
    expect(airdropDrawsTable(undefined, 1_700_000_000)).toBeUndefined();
    expect(airdropDrawsTable(standing([]), 1_700_000_000)).toBeUndefined();
  });

  it("names its columns and puts the draw index first", () => {
    const table = airdropDrawsTable(
      standing([participation({ draw: draw({ drawIndex: 27n, status: "Registering" }) })]),
      1_700_000_000,
    );
    expect(table?.columns).toEqual(["#", "status", "you", "in / won / claimed", "deadline", "claim window"]);
    expect(table?.rows).toEqual([
      ["#27", "open", "not registered", "—", "2023-11-20 17:06Z", "opens in 5d 18h"],
    ]);
  });

  it("labels every status branch distinctly", () => {
    const make = (status: AirdropDraw["status"], p: Partial<AirdropParticipation> = {}) =>
      tableRow([participation({ draw: draw({ status }), ...p })], 1_700_000_000);
    expect(make("Scheduled")[STATUS]).toBe("scheduled");
    expect(make("Scheduled")[YOU]).toBe("—");
    expect(make("Registering", { registered: false })[YOU]).toBe("not registered");
    expect(make("Registering", { registered: true })[YOU]).toBe("registered");
    expect(make("Registering", { registered: null })[YOU]).toBe("registration unknown");
    expect(make("AwaitingEntropy")[STATUS]).toBe("AwaitingEntropy");
    expect(make("DrawWinners")[STATUS]).toBe("DrawWinners");
    expect(make("Claiming", { winner: true })[YOU]).toBe("won · claimable");
    expect(make("Claiming", { winner: true, claimed: true })[YOU]).toBe("won · claimed");
    expect(make("Claiming", { winner: false })[YOU]).toBe("did not win");
    expect(make("Claiming", { winner: null })[YOU]).toBe("winner unknown");
    expect(make("ClearingRegistrations")[STATUS]).toBe("ClearingRegistrations");
    expect(make("ClearingRegistrations", { registered: true })[YOU]).toBe("registered");
    expect(make("ClearingRegistrations", { registered: null })[YOU]).toBe("—");
    expect(make("ClearingWinners")[STATUS]).toBe("ClearingWinners");
    expect(make("Finalizing")[STATUS]).toBe("Finalizing");
  });

  it("prints counts as in / won / claimed with — for what the status omits", () => {
    const full = tableRow(
      [participation({ draw: draw({ status: "Claiming", totalParticipants: 8, effectiveWinners: 1, claimed: 0 }) })],
      1_700_000_000,
    );
    expect(full[COUNTS]).toBe("8 / 1 / 0");
    const partial = tableRow(
      [participation({ draw: draw({ status: "Registering", totalParticipants: 3 }) })],
      1_700_000_000,
    );
    expect(partial[COUNTS]).toBe("3 / — / —");
    expect(tableRow([participation({})], 1_700_000_000)[COUNTS]).toBe("—");
  });

  it("anchors the deadline on drawTime while open and endTime afterwards", () => {
    const open = tableRow([participation({ draw: draw({ status: "Registering" }) })], 1_700_000_000);
    expect(open[DEADLINE]).toBe("2023-11-20 17:06Z");
    const claiming = tableRow([participation({ draw: draw({ status: "Claiming" }) })], 1_700_000_000);
    expect(claiming[DEADLINE]).toBe("2023-12-02 06:53Z");
  });

  it("says when the claim window opens, how long it stays open, and when it closed", () => {
    const entry = participation({ draw: draw({ status: "Claiming" }), winner: true });
    expect(tableRow([entry], 1_700_000_000)[CLAIM_WINDOW]).toBe("opens in 5d 18h");
    expect(tableRow([entry], 1_700_500_000)[CLAIM_WINDOW]).toBe("open · closes in 11d 13h");
    expect(tableRow([entry], 1_701_499_000)[CLAIM_WINDOW]).toBe("open · closes in 16m");
    expect(tableRow([entry], 1_701_507_200)[CLAIM_WINDOW]).toBe("closed 2h 0m ago");
  });

  it("names an elapsed registration window distinctly from a live one", () => {
    // The runtime rejects `register_slot` past drawTime even while the
    // stored status is still Registering.
    const entry = participation({
      draw: draw({ status: "Registering", totalParticipants: 8, effectiveWinners: 1 }),
    });
    expect(tableRow([entry], 1_701_000_000)[STATUS]).toBe("registration closed");
    expect(tableRow([entry], 1_700_000_000)[STATUS]).toBe("open");
  });

  it("names an elapsed claim window distinctly from a live claim", () => {
    // The runtime answers `ClaimingWindowClosed` past endTime, so an
    // unclaimed prize must not read as claimable.
    const pastEnd = draw({ status: "Claiming", totalParticipants: 8, effectiveWinners: 1, claimed: 0 });
    const unclaimed = participation({ draw: pastEnd, registered: true, winner: true, claimed: false });
    expect(tableRow([unclaimed], 1_702_000_000)[STATUS]).toBe("claim window closed");
    expect(tableRow([unclaimed], 1_702_000_000)[YOU]).toBe("won · window closed");
    expect(tableRow([unclaimed], 1_700_000_000)[STATUS]).toBe("claiming");
    expect(tableRow([unclaimed], 1_700_000_000)[YOU]).toBe("won · claimable");
    const claimed = participation({ draw: pastEnd, registered: true, winner: true, claimed: true });
    expect(tableRow([claimed], 1_700_000_000)[YOU]).toBe("won · claimed");
  });

  it("orders rows newest-first regardless of input order", () => {
    const table = airdropDrawsTable(
      standing([
        participation({ draw: draw({ drawIndex: 5n }), registered: null }),
        participation({ draw: draw({ drawIndex: 12n }), registered: null }),
        participation({ draw: draw({ drawIndex: 3n }), registered: null }),
      ]),
      1_700_000_000,
    );
    expect(table?.rows.map((cells) => cells[0])).toEqual(["#12", "#5", "#3"]);
  });

  it("caps the rows at 20 with a trailing `… N more` row", () => {
    const participations: AirdropParticipation[] = [];
    for (let i = 0; i < 25; i += 1) {
      participations.push(participation({ draw: draw({ drawIndex: BigInt(i) }), registered: null }));
    }
    const rows = airdropDrawsTable(standing(participations), 1_700_000_000)?.rows ?? [];
    expect(rows.filter((cells) => /^#\d+$/.test(cells[0] ?? ""))).toHaveLength(20);
    expect(rows.at(-1)).toEqual(["… 5 more", "capped at 20", "", "", "", ""]);
  });
});

describe("buildDebugView airdrops section", () => {
  const baseInput: DebugInput = {
    network: "previewnet",
    productDomain: "humanityy.testnet",
    card: undefined,
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
  };

  it("always renders the section, even with no standing", () => {
    const section = buildDebugView(baseInput).find((s) => s.title === "airdrops");
    expect(section).toBeDefined();
    expect(section!.rows.find((row) => row.label === "query")).toEqual({
      label: "query",
      value: "no data",
    });
    // The context row has to say *something* useful when nothing loaded.
    expect(section!.rows.find((row) => row.label === "context")?.value).toBe(
      "no standing",
    );
  });

  it("renders the section while pending and still names the context failure", () => {
    const section = buildDebugView({ ...baseInput, airdropsPending: true }).find(
      (s) => s.title === "airdrops",
    );
    expect(section?.rows.find((row) => row.label === "query")?.value).toBe("pending");
    expect(section?.rows.find((row) => row.label === "context")?.value).toBe(
      "no standing",
    );
  });

  it("surfaces a query error and still produces a useful context row", () => {
    const section = buildDebugView({
      ...baseInput,
      airdropsError: new Error("context dead"),
    }).find((s) => s.title === "airdrops");
    expect(section?.rows.find((row) => row.label === "query")?.value).toBe(
      "error: context dead",
    );
    expect(section?.rows.find((row) => row.label === "context")?.value).toBe(
      "no standing",
    );
  });

  it("names both contexts on a mismatch", () => {
    const data: AirdropStanding = standing([], {
      aliasContext: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      contextMatches: false,
    });
    const section = buildDebugView({ ...baseInput, airdrops: data }).find(
      (s) => s.title === "airdrops",
    );
    const context = section!.rows.find((row) => row.label === "context")?.value;
    expect(context).toContain("mismatch");
    expect(context).toContain("0xdead…beef");
    expect(context).toContain("0x1234…5678");
  });

  it("distinguishes a missing-alias failure from a context mismatch", () => {
    const noAlias = standing([], {
      alias: null,
      aliasContext: null,
      contextMatches: false,
    });
    const noAliasCtx = buildDebugView({ ...baseInput, airdrops: noAlias })
      .find((s) => s.title === "airdrops")!
      .rows.find((row) => row.label === "context")!.value;
    expect(noAliasCtx).toContain("registration will bind");
    const mismatch = standing([], {
      aliasContext: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      contextMatches: false,
    });
    const mismatchCtx = buildDebugView({ ...baseInput, airdrops: mismatch })
      .find((s) => s.title === "airdrops")!
      .rows.find((row) => row.label === "context")!.value;
    expect(mismatchCtx).not.toContain("no alias");
    expect(mismatchCtx).not.toBe(noAliasCtx);
  });

  const drawRow = (input: DebugInput, label = "#0"): readonly string[] => {
    const row = buildDebugView(input)
      .find((s) => s.title === "airdrops")
      ?.table?.rows.find((cells) => cells[0] === label);
    if (row == null) throw new Error(`no ${label} row`);
    return row;
  };

  it("omits the table when the standing has no draws", () => {
    const section = buildDebugView({ ...baseInput, airdrops: standing([]) }).find(
      (s) => s.title === "airdrops",
    );
    expect(section?.table).toBeUndefined();
  });

  it("distinguishes every Registering tri-state in the you column", () => {
    const baseDraw: AirdropDraw = {
      eventId: BLOCK,
      drawIndex: 0n,
      status: "Registering",
      registrationStartsSeconds: 1_699_000_000,
      drawTimeSeconds: 2_000_000_000,
      endTimeSeconds: 2_001_000_000,
      prizeAmount: 1000n,
      assetId: 0,
      maxWinners: 1,
      totalParticipants: 4,
      effectiveWinners: null,
      claimed: null,
    };
    const you = (overrides: Partial<AirdropParticipation>) =>
      drawRow({
        ...baseInput,
        airdrops: standing([
          participation({ draw: baseDraw, registered: false, winner: null, claimed: null, ...overrides }),
        ]),
      })[YOU];
    expect(you({ registered: false })).toBe("not registered");
    expect(you({ registered: true })).toBe("registered");
    expect(you({ registered: null })).toBe("registration unknown");
  });

  it("distinguishes every Claiming tri-state in the you column", () => {
    const baseDraw: AirdropDraw = {
      eventId: BLOCK,
      drawIndex: 0n,
      status: "Claiming",
      registrationStartsSeconds: 1_699_000_000,
      drawTimeSeconds: 2_000_000_000,
      endTimeSeconds: 2_001_000_000,
      prizeAmount: 1000n,
      assetId: 0,
      maxWinners: 1,
      totalParticipants: 8,
      effectiveWinners: 1,
      claimed: 0,
    };
    const you = (overrides: Partial<AirdropParticipation>) =>
      drawRow({
        ...baseInput,
        airdrops: standing([
          participation({ draw: baseDraw, registered: true, winner: false, claimed: null, ...overrides }),
        ]),
      })[YOU];
    expect(you({ winner: true })).toBe("won · claimable");
    expect(you({ winner: false })).toBe("did not win");
    expect(you({ winner: null })).toBe("winner unknown");
  });

  it("reports a claimed prize from local observation, not as still-claimable", () => {
    const draw: AirdropDraw = {
      eventId: BLOCK,
      drawIndex: 0n,
      status: "Claiming",
      registrationStartsSeconds: 1_699_000_000,
      drawTimeSeconds: 2_000_000_000,
      endTimeSeconds: 2_001_000_000,
      prizeAmount: 1000n,
      assetId: 0,
      maxWinners: 1,
      totalParticipants: 8,
      effectiveWinners: 1,
      claimed: 1,
    };
    const row = drawRow({
      ...baseInput,
      airdrops: standing([
        // The runtime removes the winner entry after claim, so the real
        // post-claim shape is winner=false plus the session's claimed marker.
        participation({ draw, registered: true, winner: false, claimed: true }),
      ]),
    });
    expect(row[YOU]).toBe("won · claimed");
    expect(row[COUNTS]).toBe("8 / 1 / 1");
  });

  it("orders draw rows newest-first regardless of input order", () => {
    const at = (index: bigint): AirdropDraw => ({
      eventId: BLOCK,
      drawIndex: index,
      status: "Scheduled",
      registrationStartsSeconds: 1_699_000_000,
      drawTimeSeconds: 2_000_000_000,
      endTimeSeconds: 2_001_000_000,
      prizeAmount: 1000n,
      assetId: 0,
      maxWinners: 1,
      totalParticipants: null,
      effectiveWinners: null,
      claimed: null,
    });
    const standingData: AirdropStanding = {
      participations: [
        { draw: at(3n), slot: null, registered: null, winner: null, claimed: null },
        { draw: at(9n), slot: null, registered: null, winner: null, claimed: null },
        { draw: at(1n), slot: null, registered: null, winner: null, claimed: null },
      ],
      alias: ALIAS,
      airdropsContext: NEEDED,
      aliasContext: NEEDED,
      contextMatches: true,
      atBlockHash: BLOCK,
    };
    const section = buildDebugView({ ...baseInput, airdrops: standingData }).find(
      (s) => s.title === "airdrops",
    );
    expect(section?.table?.rows.map((cells) => cells[0])).toEqual(["#9", "#3", "#1"]);
  });

  it("caps at 20 draws with a trailing `… N more` row and drops nothing above the cap", () => {
    const at = (index: bigint): AirdropDraw => ({
      eventId: BLOCK,
      drawIndex: index,
      status: "Scheduled",
      registrationStartsSeconds: 1_699_000_000,
      drawTimeSeconds: 2_000_000_000,
      endTimeSeconds: 2_001_000_000,
      prizeAmount: 1000n,
      assetId: 0,
      maxWinners: 1,
      totalParticipants: null,
      effectiveWinners: null,
      claimed: null,
    });
    const participations: AirdropParticipation[] = [];
    for (let i = 0; i < 23; i += 1) {
      participations.push({
        draw: at(BigInt(i)),
        slot: null,
        registered: null,
        winner: null,
        claimed: null,
      });
    }
    const standingData: AirdropStanding = standing(participations);
    const rows =
      buildDebugView({ ...baseInput, airdrops: standingData }).find(
        (s) => s.title === "airdrops",
      )?.table?.rows ?? [];
    expect(rows.filter((cells) => /^#\d+$/.test(cells[0] ?? ""))).toHaveLength(20);
    expect(rows.at(-1)?.[0]).toBe("… 3 more");
  });

  it("counts registered, won and claimable in the draws row", () => {
    const drawAt = (index: bigint, overrides: Partial<AirdropDraw> = {}): AirdropDraw => ({
      eventId: BLOCK,
      drawIndex: index,
      status: "Scheduled",
      registrationStartsSeconds: 1_699_000_000,
      drawTimeSeconds: 2_000_000_000,
      endTimeSeconds: 2_001_000_000,
      prizeAmount: 1000n,
      assetId: 0,
      maxWinners: 1,
      totalParticipants: null,
      effectiveWinners: null,
      claimed: null,
      ...overrides,
    });
    const standingData: AirdropStanding = standing([
      {
        draw: drawAt(0n, { status: "Registering" }),
        slot: null,
        registered: true,
        winner: null,
        claimed: null,
      },
      {
        draw: drawAt(1n, { status: "Claiming" }),
        slot: null,
        registered: true,
        winner: true,
        claimed: false,
      },
      {
        draw: drawAt(2n, { status: "Registering" }),
        slot: null,
        registered: false,
        winner: null,
        claimed: null,
      },
      {
        draw: drawAt(3n, { status: "Claiming" }),
        slot: null,
        registered: true,
        winner: false,
        claimed: null,
      },
    ]);
    const section = buildDebugView({ ...baseInput, airdrops: standingData }).find(
      (s) => s.title === "airdrops",
    );
    expect(section!.rows.find((row) => row.label === "draws")?.value).toBe(
      "4 · registered 3 · won 1 · claimable 1",
    );
  });
});
