// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MemberCard, memberDisplayName } from "@features/card/components/MemberCard.tsx";
import { resolveCardStyle } from "@features/card/components/card-state-resolve.ts";
import { heatRankForScore } from "@features/card/domain/card-heat.ts";
import { homeTitle, homeSub, homeAmbient } from "@features/card/domain/card-journey-hints.ts";
import { devCardFixture } from "@features/prize/domain/prize-demo.ts";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";

const candidate = (score: number, personhoodThreshold: number): HumanityCardState => ({
  kind: "candidate",
  score,
  personhoodThreshold,
  gamesRemaining: Math.max(0, personhoodThreshold - score),
});

const ADDRESS = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";

/** Each stripe segment's `--seg-fill` and `--seg-before`, left to right. */
function stripeSegments(html: string): { fill: number; before: number }[] {
  return [...html.matchAll(/<i style="--seg-fill:([\d.]+);--seg-before:([\d.]+)"/g)].map(
    ([, fill, before]) => ({ fill: Number(fill), before: Number(before) }),
  );
}

describe("heatRankForScore", () => {
  it("walks spark through blaze by the share of the threshold covered", () => {
    expect(heatRankForScore(1, 6)?.key).toBe("spark");
    expect(heatRankForScore(2, 6)?.key).toBe("ignition");
    expect(heatRankForScore(3, 6)?.key).toBe("flame");
    expect(heatRankForScore(4, 6)?.key).toBe("fire");
    expect(heatRankForScore(5, 6)?.key).toBe("blaze");
    expect(heatRankForScore(1, 10)?.key).toBe("spark");
    expect(heatRankForScore(4, 10)?.key).toBe("ignition");
    expect(heatRankForScore(9, 10)?.key).toBe("blaze");
  });

  it("has no rank before the first point or without a usable threshold", () => {
    expect(heatRankForScore(0, 6)).toBeNull();
    expect(heatRankForScore(-1, 6)).toBeNull();
    expect(heatRankForScore(3, 0)).toBeNull();
    expect(heatRankForScore(3, Number.NaN)).toBeNull();
  });

  it("holds blaze at and beyond the threshold", () => {
    expect(heatRankForScore(6, 6)?.key).toBe("blaze");
    expect(heatRankForScore(99, 6)?.key).toBe("blaze");
  });
});

describe("resolveCardStyle for candidates", () => {
  it("gives the target fixture two thirds of the stripe on warm red Fire", () => {
    const style = resolveCardStyle(candidate(4, 6));
    expect(style.stripe).toBe(4 / 6);
    expect(style.heatRank?.key).toBe("fire");
    expect(style.vars).toMatchObject({
      "--c-score": "#C43B40",
      "--c-sheen": "#C43B403D",
      "--c-b1": "#DEDFE3",
      "--c-b2": "#BBBCC0",
      "--c-ink": "#101114",
    });
    expect(style.isSash).toBe(false);
  });

  it("measures the stripe as a share of the runtime threshold", () => {
    expect(resolveCardStyle(candidate(4, 10)).stripe).toBe(0.4);
    expect(resolveCardStyle(candidate(12, 30)).stripe).toBe(0.4);
    expect(resolveCardStyle(candidate(0, 1)).stripe).toBe(0);
    expect(resolveCardStyle(candidate(4, 0)).stripe).toBe(0);
  });

  it("stays cold white plastic before the first point, stripe still drawn", () => {
    const style = resolveCardStyle(candidate(0, 6));
    expect(style.stripe).toBe(0);
    expect(style.heatRank).toBeNull();
    expect(style.vars).toMatchObject({ "--c-score": "transparent", "--c-b1": "#DEDFE3" });
  });

  it("maps each heat rank to its mockup accent sheen and stripe fill", () => {
    const ranks = [
      { score: 1, accent: "#E0A400" },
      { score: 2, accent: "#D98A0B" },
      { score: 3, accent: "#E06716" },
      { score: 4, accent: "#C43B40" },
      { score: 5, accent: "#8C2332" },
    ];
    for (const { score, accent } of ranks) {
      const style = resolveCardStyle(candidate(score, 6));
      expect(style.vars).toMatchObject({
        "--c-score": accent,
        "--c-sheen": `${accent}3D`,
      });
    }
  });

  it("leaves the other state palettes untouched", () => {
    expect(resolveCardStyle({ kind: "member", activeWeeks: 2, lastAttendedGame: 4, attendanceHistory: 0, window: 8 }).vars)
      .toMatchObject({ "--c-b2": "#AEA6A5", "--c-sheen": "rgba(244,114,182,0.42)" });
    expect(resolveCardStyle({ kind: "suspended", reason: "attendance" }).isFaded).toBe(true);
    expect(resolveCardStyle({ kind: "devicehood" }).vars).toMatchObject({ "--c-b1": "#DEDFE3", "--c-ink": "#8C8F98", "--c-bw": "1px" });
    expect(resolveCardStyle({ kind: "devicehood" }).heatRank).toBeNull();
    expect(resolveCardStyle({ kind: "devicehood" }).stripe).toBeNull();
    expect(resolveCardStyle({ kind: "devicehood", personhoodThreshold: 6 }).stripe).toEqual(0);
  });

});

describe("resolveCardStyle for members", () => {
  const member = (activeWeeks: number): HumanityCardState => ({
    kind: "member",
    activeWeeks,
    lastAttendedGame: 42,
    attendanceHistory: 0,
    window: 8,
  });

  it("grades the silver sheen by active weeks", () => {
    const tiers = [
      [1, "rgba(255,255,255,0.5)"],
      [2, "rgba(244,114,182,0.42)"],
      [4, "rgba(45,212,191,0.4)"],
      [8, "rgba(139,92,246,0.42)"],
    ] as const;
    for (const [weeks, sheen] of tiers) {
      expect(resolveCardStyle(member(weeks)).vars).toMatchObject({
        "--c-b1": "#DCDEE0",
        "--c-b2": "#AEA6A5",
        "--c-ink": "#0B0C0F",
        "--c-sheen": sheen,
        "--c-holo": "0",
        "--c-bw": "0px",
      });
    }
  });

  it("swaps to dark silver at week 13 and beyond", () => {
    const tiers = [
      [13, "rgba(255,255,255,0.24)"],
      [26, "rgba(232,160,144,0.4)"],
      [39, "rgba(109,58,93,0.5)"],
    ] as const;
    for (const [weeks, sheen] of tiers) {
      expect(resolveCardStyle(member(weeks)).vars).toMatchObject({
        "--c-b1": "#83878E",
        "--c-b2": "#5C6067",
        "--c-ink": "#F4F4F5",
        "--c-sheen": sheen,
        "--c-holo": "0",
        "--c-bw": "0px",
      });
    }
  });

  it("goes black at week 52 with a light edge, then escalates holo", () => {
    const tiers = [
      [52, "rgba(255,255,255,0.12)", "0"],
      [78, "rgba(255,255,255,0.1)", "0.35"],
      [104, "rgba(255,255,255,0.1)", "0.5"],
      [208, "rgba(255,255,255,0.1)", "0.65"],
      [312, "rgba(255,255,255,0.1)", "0.8"],
      [416, "rgba(255,255,255,0.1)", "0.9"],
    ] as const;
    for (const [weeks, sheen, holo] of tiers) {
      expect(resolveCardStyle(member(weeks)).vars).toMatchObject({
        "--c-b1": "#17181C",
        "--c-sheen": sheen,
        "--c-holo": holo,
      });
    }
    expect(resolveCardStyle(member(52)).vars).toMatchObject({
      "--c-b2": "#0C0D10",
      "--c-ink": "#F4F4F5",
      "--c-bw": "1px",
      "--c-border": "rgba(244,244,245,0.65)",
    });
  });

  it("holds each tier until the next threshold", () => {
    expect(resolveCardStyle(member(12)).vars).toMatchObject({
      "--c-b2": "#AEA6A5",
      "--c-sheen": "rgba(139,92,246,0.42)",
    });
    expect(resolveCardStyle(member(51)).vars).toMatchObject({
      "--c-b2": "#5C6067",
      "--c-sheen": "rgba(109,58,93,0.5)",
    });
    expect(resolveCardStyle(member(77)).vars).toMatchObject({
      "--c-b1": "#17181C",
      "--c-holo": "0",
    });
  });

  it("keeps a zero-week member on fresh silver", () => {
    expect(resolveCardStyle(member(0)).vars).toMatchObject({
      "--c-b1": "#DCDEE0",
      "--c-sheen": "rgba(255,255,255,0.5)",
      "--c-holo": "0",
    });
  });

  it("keeps the silver foil ramp for silver members only", () => {
    const bgOf = (weeks: number) =>
      (resolveCardStyle(member(weeks)).vars as Record<string, string | undefined>)["--c-bg"];
    expect(bgOf(8)).toBe(
      "linear-gradient(151deg, #B2B3B3 0%, #DCDEE0 30%, #C5D3ED 48%, #F7F5F4 62%, #F6DCC5 80%, #AEA6A5 100%)",
    );
    expect(bgOf(13)).toBeUndefined();
    expect(bgOf(52)).toBeUndefined();
  });
});

describe("homeSub for candidates", () => {
  it("promises silver when the next game meets the threshold", () => {
    expect(homeSub(candidate(5, 6))).toBe("One more game to go.");
    expect(homeSub(candidate(7, 8))).toBe("One more game to go.");
  });

  it("stays vague until the next game reaches silver", () => {
    expect(homeSub(candidate(4, 6))).toBe("Each game counts toward membership.");
    expect(homeSub(candidate(0, 6))).toBe("Each game counts toward membership.");
    expect(homeSub(candidate(15, 20))).toBe("Each game counts toward membership.");
    expect(homeSub(candidate(4, 0))).toBe("Each game counts toward membership.");
  });

  it("never names an internal heat rank in the subtitle", () => {
    for (const score of [0, 1, 2, 3, 4, 5, 6]) {
      expect(homeSub(candidate(score, 6))).not.toMatch(/Flame|Blaze|Spark|Ignition|Fire/);
    }
  });
});

describe("homeAmbient", () => {
  it("warms with the heat rank", () => {
    expect(homeAmbient(candidate(4, 6))).toBe("rgba(229,72,77,0.14)");
    expect(homeAmbient(candidate(1, 6))).toBe("rgba(255,216,77,0.13)");
  });
});

describe("home copy for members", () => {
  it("gives members no title or subtitle, regardless of streak", () => {
    for (const activeWeeks of [0, 4]) {
      const state: HumanityCardState = { kind: "member", activeWeeks, lastAttendedGame: 7, attendanceHistory: 0, window: 8 };
      expect(homeTitle(state), state.kind).toBeNull();
      expect(homeSub(state), state.kind).toBeNull();
    }
  });
});

describe("devCardFixture", () => {
  it("pins the candidate demo to the Fire target", () => {
    const state = devCardFixture("candidate").state;
    expect(state).toEqual({ kind: "candidate", score: 4, personhoodThreshold: 6, gamesRemaining: 1 });
    expect(resolveCardStyle(state).stripe).toBe(4 / 6);
  });
});

describe("MemberCard candidate markup", () => {
  it("fills two thirds of ten segments with no rank text on the face", () => {
    const html = renderToStaticMarkup(
      createElement(MemberCard, { state: candidate(4, 6), accountAddress: ADDRESS }),
    );
    const fills = stripeSegments(html).map(({ fill }) => fill);
    expect(html.match(/<i /g) ?? []).toHaveLength(10);
    expect(fills.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(fills[6]).toBeCloseTo(2 / 3);
    expect(fills.slice(7)).toEqual([0, 0, 0]);
    expect(html).toContain("--c-score:#C43B40");
    expect(html).toContain("Progress to membership: 4 of 6");
    expect(html).not.toContain("Fire · candidate");
    expect(html).not.toContain("idcard-ranklabel");
    expect(html).not.toContain("idcard-rank");
  });

  it("starts each segment's sweep where the fill before it ends", () => {
    const html = renderToStaticMarkup(
      createElement(MemberCard, { state: candidate(7, 20), accountAddress: ADDRESS }),
    );
    expect(stripeSegments(html)).toEqual([
      { fill: 1, before: 0 },
      { fill: 1, before: 1 },
      { fill: 1, before: 2 },
      { fill: 0.5, before: 3 },
      { fill: 0, before: 3.5 },
      { fill: 0, before: 3.5 },
      { fill: 0, before: 3.5 },
      { fill: 0, before: 3.5 },
      { fill: 0, before: 3.5 },
      { fill: 0, before: 3.5 },
    ]);
    expect(html).toContain("Progress to membership: 7 of 20");
  });

  it("keeps an empty stripe on a fresh candidate, and draws one on a person's card that knows the threshold", () => {
    const fresh = renderToStaticMarkup(
      createElement(MemberCard, { state: candidate(0, 1), accountAddress: ADDRESS }),
    );
    expect(fresh).toContain("has-stripe");
    expect(stripeSegments(fresh).map(({ fill }) => fill)).toEqual(Array(10).fill(0));
    const lite = renderToStaticMarkup(
      createElement(MemberCard, { state: { kind: "devicehood" }, accountAddress: ADDRESS }),
    );
    const person = renderToStaticMarkup(
      createElement(MemberCard, { state: { kind: "devicehood", personhoodThreshold: 6 }, accountAddress: ADDRESS }),
    );
    expect(lite).not.toContain("has-stripe");
    expect(lite).not.toContain("idcard-stripe");
    expect(person).toContain("has-stripe");
    expect(person).toContain("Progress to membership: 0 of 6");
    expect(stripeSegments(person).map(({ fill }) => fill)).toEqual(Array(10).fill(0));
  });
});

describe("MemberCard identity label", () => {
  const address = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";

  it("shows the host DotNS username and its initial when one is supplied", () => {
    const html = renderToStaticMarkup(
      createElement(MemberCard, {
        state: { kind: "member", activeWeeks: 2, lastAttendedGame: 42, attendanceHistory: 0, window: 8 },
        accountAddress: address,
        ownerAccount: address,
        displayName: "erinb",
      }),
    );
    expect(html).toContain('<div class="idcard-name" data-testid="card-username">erinb</div>');
    expect(html).toContain('<div class="idcard-avatar">e</div>');
    // The owner address is in the DOM only as the end-to-end hook, never shown.
    expect(html.split("5FLSig").length - 1).toBe(1);
    expect(html).toContain(`data-account="${address}"`);
  });

  it("falls back to the shortened owner address when no name is supplied", () => {
    const html = renderToStaticMarkup(
      createElement(MemberCard, {
        state: { kind: "member", activeWeeks: 2, lastAttendedGame: 42, attendanceHistory: 0, window: 8 },
        accountAddress: address,
      }),
    );
    expect(html).toContain('<div class="idcard-name" data-testid="card-username">5FLSig…S59Y</div>');
    expect(html).toContain('<div class="idcard-avatar">L</div>');
  });

  it("treats a blank host name as absent", () => {
    const html = renderToStaticMarkup(
      createElement(MemberCard, {
        state: { kind: "member", activeWeeks: 2, lastAttendedGame: 42, attendanceHistory: 0, window: 8 },
        accountAddress: address,
        displayName: "   ",
      }),
    );
    expect(html).toContain('<div class="idcard-name" data-testid="card-username">5FLSig…S59Y</div>');
  });
});

describe("memberDisplayName", () => {
  it("preserves the lite suffix even on member-family cards", () => {
    const member = { kind: "member", activeWeeks: 2, lastAttendedGame: 42, attendanceHistory: 0, window: 8 } as const;
    expect(memberDisplayName(member, "erin.80")).toBe("erin.80");
    expect(memberDisplayName(member, "marlow.42")).toBe("marlow.42");
    expect(memberDisplayName({ kind: "caution", activeWeeks: 0, misses: 1, allowedMisses: 2, window: 4, lastAttendedGame: 3, attendanceHistory: 0 }, "marlow.42")).toBe("marlow.42");
    expect(memberDisplayName({ kind: "suspended", reason: "attendance" }, "marlow.42")).toBe("marlow.42");
  });

  it("does not reinterpret the supplied identity label", () => {
    const member = { kind: "member", activeWeeks: 2, lastAttendedGame: 42, attendanceHistory: 0, window: 8 } as const;
    expect(memberDisplayName(member, "a.b.7")).toBe("a.b.7");
    expect(memberDisplayName(member, "jet.dev")).toBe("jet.dev");
    expect(memberDisplayName(member, "jet.")).toBe("jet.");
    expect(memberDisplayName(member, "42")).toBe("42");
  });

  it("renders non-member states verbatim", () => {
    expect(memberDisplayName(candidate(4, 6), "marlow.42")).toBe("marlow.42");
    expect(memberDisplayName({ kind: "devicehood" }, "marlow.42")).toBe("marlow.42");
    expect(memberDisplayName({ kind: "not-enrolled" }, "marlow.42")).toBe("marlow.42");
  });

  it("trims whitespace and keeps blanks as absent", () => {
    const member = { kind: "member", activeWeeks: 2, lastAttendedGame: 42, attendanceHistory: 0, window: 8 } as const;
    expect(memberDisplayName(member, "  marlow.42  ")).toBe("marlow.42");
    expect(memberDisplayName(member, "")).toBe("");
    expect(memberDisplayName(member, undefined)).toBeUndefined();
  });
});

describe("MemberCard member-family name suffix", () => {
  const address = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";

  it("shows the owned lite name on a caution card", () => {
    const html = renderToStaticMarkup(
      createElement(MemberCard, {
        state: { kind: "caution", activeWeeks: 0, misses: 1, allowedMisses: 2, window: 4, lastAttendedGame: 3, attendanceHistory: 0 },
        accountAddress: address,
        displayName: "marlow.42",
      }),
    );
    expect(html).toContain('<div class="idcard-name" data-testid="card-username">marlow.42</div>');
    expect(html).toContain('<div class="idcard-avatar">m</div>');
    expect(html).not.toContain('<div class="idcard-name" data-testid="card-username">marlow</div>');
  });
});

describe("MemberCard end-to-end hooks", () => {
  const owner = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";
  const states: Record<HumanityCardState["kind"], HumanityCardState> = {
    "not-enrolled": { kind: "not-enrolled" },
    devicehood: { kind: "devicehood", personhoodThreshold: 6 },
    candidate: candidate(4, 6),
    "membership-ready": { kind: "membership-ready", activeWeeks: 3, lastAttendedGame: 9, attendanceHistory: 0, window: 8 },
    member: { kind: "member", activeWeeks: 5, lastAttendedGame: 9, attendanceHistory: 0, window: 8 },
    caution: { kind: "caution", activeWeeks: 1, misses: 2, allowedMisses: 2, window: 8, lastAttendedGame: 9, attendanceHistory: 0 },
    suspended: { kind: "suspended", reason: "attendance" },
  };
  const render = (state: HumanityCardState, extra: Partial<Parameters<typeof MemberCard>[0]> = {}) =>
    renderToStaticMarkup(createElement(MemberCard, { state, accountAddress: ADDRESS, ...extra }));
  const attr = (html: string, name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1];

  it("names the card, its username and its status label in every state", () => {
    for (const state of Object.values(states)) {
      const html = render(state);
      expect(html, state.kind).toContain('data-testid="membership-card"');
      expect(attr(html, "data-card-state"), state.kind).toBe(state.kind);
      expect(html, state.kind).toContain('class="idcard-name" data-testid="card-username"');
      expect(html, state.kind).toContain('class="sr-only" data-testid="card-label"');
    }
  });

  it("carries score, misses and streak only in the states that have them", () => {
    const figures = (state: HumanityCardState) => {
      const html = render(state);
      return { score: attr(html, "data-score"), misses: attr(html, "data-misses"), streak: attr(html, "data-streak") };
    };
    const none = { score: undefined, misses: undefined, streak: undefined };
    expect(figures(states["not-enrolled"])).toEqual(none);
    expect(figures(states.devicehood)).toEqual(none);
    expect(figures(states.suspended)).toEqual(none);
    expect(figures(states.candidate)).toEqual({ ...none, score: "4" });
    expect(figures(states["membership-ready"])).toEqual({ ...none, streak: "3" });
    expect(figures(states.member)).toEqual({ ...none, streak: "5" });
    expect(figures(states.caution)).toEqual({ ...none, misses: "2", streak: "1" });
  });

  it("carries the finalized owner as data-account, and nothing without one", () => {
    expect(attr(render(states.member, { ownerAccount: owner }), "data-account")).toBe(owner);
    for (const ownerAccount of [undefined, null, ""]) {
      const html = render(states.member, { ownerAccount });
      expect(html).not.toContain("data-account");
      expect(html).not.toContain(ADDRESS);
    }
  });

  it("marks the badge only when the card wears a pill", () => {
    for (const state of Object.values(states)) {
      const html = render(state);
      expect(html.includes('data-testid="card-badge"'), state.kind).toBe(resolveCardStyle(state).hasPill);
    }
    expect(render(states.suspended)).toContain('class="idcard-pill" role="status" data-testid="card-badge"');
  });

  it("marks the back's code only on an interactive card with a payload", () => {
    expect(render(states.member, { interactive: true, qrPayload: "humanity:code" })).toContain(
      'class="idcard-qr-relief" data-testid="card-qr"',
    );
    expect(render(states.member, { interactive: true, qrPayload: null })).not.toContain('data-testid="card-qr"');
    expect(render(states.member, { qrPayload: "humanity:code" })).not.toContain('data-testid="card-qr"');
  });
});
