// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { INCLUSION_SLACK_S, OWN_GAME_PLAYS_IN_S, SIGN_UP_NEEDS_S, chainedNth, ownGamePlayTime, standingLabel } from '../previewnet-poc/rules.ts';

describe('the card label a lite person has on chain', () => {
  it('is Person before her first sign-up, when the chain holds no score record', () => {
    expect(standingLabel(undefined)).toBe('Person');
  });
  it('is Candidate once a sign-up wrote her record', () => {
    // plabpoc.44 on live Previewnet, 20 November 2026, after two sign-ups she did not attend.
    expect(standingLabel({ reached_personhood: false, has_ever_reached_personhood: false })).toBe('Candidate');
    expect(standingLabel({})).toBe('Candidate');
  });
  it('names none for someone who reached personhood: she is past this scenario', () => {
    expect(standingLabel({ reached_personhood: true, has_ever_reached_personhood: true })).toBeUndefined();
    expect(standingLabel({ reached_personhood: false, has_ever_reached_personhood: true })).toBeUndefined();
  });
});

describe("when the lab's own game plays", () => {
  const live = { registration: 300, shuffle: 60, post_shuffle_margin: 30 };
  it('is 20 minutes from now on a chain without a game, with room to sign up', () => {
    const at = ownGamePlayTime(1_795_135_000.4, undefined, live);
    expect(at).toBe(1_795_135_001 + OWN_GAME_PLAYS_IN_S);
    expect(at - 1_795_135_001).toBeGreaterThanOrEqual(SIGN_UP_NEEDS_S);
  });
  it('takes the lead a lab asks for, as the play lab does to keep its wait short', () => {
    expect(ownGamePlayTime(1_795_135_000, undefined, live, 780)).toBe(1_795_135_000 + 780);
    // never under what the runtime allows: 300 + 60 + 30 and the slack
    expect(ownGamePlayTime(1_795_135_000, undefined, live, 60)).toBe(1_795_135_000 + 390 + INCLUSION_SLACK_S);
  });
  it('follows the game already on the chain', () => {
    expect(ownGamePlayTime(1_795_135_000, 1_795_135_300, live)).toBe(1_795_135_300 + OWN_GAME_PLAYS_IN_S);
  });
  it('is never sooner than the runtime allows', () => {
    const long = { registration: 3600, shuffle: 90, post_shuffle_margin: 0 };
    expect(ownGamePlayTime(1_795_135_000, undefined, long)).toBe(1_795_135_000 + 3600 + 90 + INCLUSION_SLACK_S);
  });
  it('refuses a time the runtime cannot hold', () => {
    expect(() => ownGamePlayTime(0xffff_ffff, undefined, live)).toThrow(/u32/);
  });
});

describe("a selector with Playwright's nth chain, for a page that takes CSS only", () => {
  it("splits the play loop's tile selector into its CSS and the index", () => {
    // The selector that failed on the phone in Paseo game 363 (22 November 2026): "is not a valid selector".
    const tile = '[data-id="5D5ZV72aAyWpa1YEzb5dBRpQtGFF3iM26NQHA8GsJj1hiLCA"][data-tile-slot] .cursor-pointer[data-tile-verdict="reject"]';
    expect(chainedNth(`${tile} >> nth=0`)).toEqual({ css: tile, nth: 0 });
    expect(chainedNth(`${tile}>>nth=2 `)).toEqual({ css: tile, nth: 2 });
    expect(chainedNth('li >> nth=-1')).toEqual({ css: 'li', nth: -1 });
  });
  it('leaves plain CSS and other chains alone', () => {
    expect(chainedNth('body')).toBeUndefined();
    expect(chainedNth('[data-x="a >> nth=0"] b')).toBeUndefined();
    expect(chainedNth('ul >> li')).toBeUndefined();
  });
});
