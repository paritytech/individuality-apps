// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The Humanity Pocket card's face, as a renderer tree.
 *
 * This is the app's card (`MemberCard.tsx`, `card-materials.ts`,
 * `idcard.css`) drawn in the host's own vocabulary: the same anatomy (name,
 * status word, the Polkadot wordmark ghosted over the lower half, a
 * candidate's tally stripe, a status ribbon) and the same material
 * per state (plain and warmed white plastic, silver foil, dark silver, black,
 * grey with an amber or red edge).
 *
 * The vocabulary names no colours: nine semantic tokens resolved by the host's
 * theme, five typography presets, one fixed rainbow effect, opacity, borders
 * and Row/Column/Box layout. What makes the materials reachable anyway is that
 * opacity composes. The face lays an opaque `BgSurfaceMain` ground and paints
 * `FgPrimary` over it at a chosen opacity, which in the default (dark) theme
 * is a neutral grey of any lightness: `#0B0C0F` at 0, `#F4F4F5` at 255, and
 * every step between. One such fill, at the design gradient's mid-height
 * grey, stands in for the gradient; ink is the ground token at
 * the opacity that lands on the design's ink over that ground. The numbers in
 * `MATERIALS` are the design's hex values run through that arithmetic.
 *
 * The arithmetic assumes the dark theme: in a light theme `BgSurfaceMain` and
 * `FgPrimary` swap ends, so every material inverts (white plastic draws dark).
 * That, and what cannot be expressed at all (letter-spacing,
 * rotation, skew, diagonal and conic gradients, blur, drop shadows), is listed
 * in `apps/humanity-worker/POCKET.md` and belongs to the renderer to grow.
 *
 * The Polkadot mark in the top-left corner (where the app's card has the
 * avatar), the QR glyph in the top-right and the Polkadot wordmark are images
 * from the worker archive. An image takes no colour token, so these are the
 * one part that does not invert with a light theme: the dark wordmark would
 * vanish on an inverted plastic.
 *
 * Built with `@parity/product-sdk/renderer` rather than by hand, so enum names
 * and node shapes are checked at compile time. One module for two surfaces:
 * the worker sends this tree live over the Pocket manager, and
 * `apps/humanity-app/scripts/write-pocket-faces.mts` writes the same trees to
 * `apps/humanity-worker/public/pocket/*.json` for the host's approval sheet.
 *
 * Every string here is ASCII: the host reads worker JS as Latin-1, and the
 * bundle this ends up in must survive that.
 */
import {
  archive,
  background,
  border,
  box,
  effect,
  fillHeight,
  fillWidth,
  height,
  image,
  opacity,
  padding,
  paddingEach,
  rounded,
  row,
  square,
  text,
  width,
  type ColorToken,
  type ContentAlignment,
  type Modifier,
  type RendererNode,
  type TypographyStyle,
} from "@humanity/shared/renderer/index.ts";

import { PROGRESS_SEGMENTS, progressShare, segmentFills } from "@humanity/shared/card/progress-stripe.ts";

/** Where a person stands, in the only detail the face shows. */
export type PocketFaceState =
  | { kind: "not-enrolled" }
  | { kind: "devicehood" }
  | { kind: "candidate"; score: number; threshold: number }
  | { kind: "membership-ready"; weeks: number }
  | { kind: "member"; weeks: number }
  | { kind: "caution"; misses: number; allowedMisses: number; window?: number }
  | { kind: "suspended" };

export interface PocketFace {
  /** The DotNS username when there is one, otherwise a shortened address. */
  name: string;
  state: PocketFaceState;
  /**
   * The share of a candidate's stripe to draw, 0 to 1, when it is not the
   * standing's own: the worker eases the stripe towards `score / threshold`
   * one frame at a time, since the vocabulary has no animation of its own.
   */
  fill?: number;
}

/** The host clips the face to a 234dp-tall product card with 24dp corners. */
const CARD_RADIUS = 24;
/** The app's card is designed at 330dp wide; the host gives it the column's width. */
const DESIGN_WIDTH = 330;
const EDGE = 16;
const TOP = 12;
/** The Polkadot mark in the top-left corner, `pocket/card-mark.webp` (200x206). */
const MARK_WIDTH = 44;
const MARK_HEIGHT = 45;
/** Between the mark and the name. */
const MARK_GAP = 8;
/** The name's line, where the status word starts under it. */
const NAME_LINE = 22;
/** The name and status word (about 38dp) centred on the mark's 45dp. */
const WORDS_TOP = 3;
/** The QR glyph in the top-right corner, `pocket/qr-code.png`: a 24-unit icon drawn from 2 to 22. */
const QR_SIZE = 24;
/** Its box's inset, so the drawn glyph sits 24dp in and centred on the mark's row. */
const QR_INSET = 22;
/** `.idcard-pill`'s top, and the glyph's when a ribbon holds the corner: just under it. */
const RIBBON_TOP = 22;
const RIBBON_HEIGHT = 28;
const QR_UNDER_RIBBON = RIBBON_TOP + RIBBON_HEIGHT + 6;
/** The Polkadot wordmark, `pocket/wordmark-*.png`, at its drawn size. */
const WORDMARK_WIDTH = 221;
const WORDMARK_HEIGHT = 48;
const STRIPE_HEIGHT = 7;
const STRIPE_GAP = 4;

/** The two ends of the dark theme's neutral ramp, per channel. */
const GROUND = 11;
const LIGHT = 244;

/** `idcard-wordmark` sits at 14%, and at 10% on a suspended card. */
const WORDMARK_ALPHA = 0.14;
const FADED_WORDMARK_ALPHA = 0.1;

/** A token, drawn at an opacity (1 is solid). */
interface Ink {
  color: ColorToken;
  alpha?: number;
}

/** A stop of a design gradient: where down the card, and how light (0-255). */
type Stop = readonly [position: number, grey: number];

interface Material {
  /** The design's gradient, top to bottom, as greys. */
  ramp: readonly Stop[];
  /** `--c-ink`, `--c-ink2`. */
  ink: Ink;
  ink2: Ink;
  /** `--c-border` at `--c-bw`, where the design draws one. */
  edge?: { ink: Ink; width: number };
  /** The rainbow effect's own opacity: foil on silver, `--c-holo` on black. */
  foil?: number;
  /**
   * Colour laid flat over the ramp: what the design's coloured sheen (a heat
   * rank's accent, a member tier's pink) leaves on the plastic once it has
   * spread across the card, measured off the app's own card on a device.
   */
  tints?: readonly Ink[];
  /** `.idcard-pill`: the ribbon a caution or suspended card carries. */
  ribbon?: { label: string; ground: ColorToken; ink: ColorToken };
  /** `.idcard.is-faded`: the mark at 60%, wordmark at 10%. */
  faded?: boolean;
}

const solid = (color: ColorToken): Ink => ({ color });

/**
 * The ground token at the opacity that reads as `target` over a material of
 * lightness `over`. For dark ink on light plastic.
 */
function darkInk(target: number, over: number): Ink {
  return { color: "BgSurfaceMain", alpha: (over - target) / (over - GROUND) };
}

/**
 * `card-materials.ts`, as greys. Each ramp is the lightness (Rec. 709 luma)
 * the app's card actually shows on a device at 30%, 55% and 80% of its
 * height, sheen and all, which is not always the gradient's stops: a sheen
 * lightens and tints. Each ink is the design's ink over the material's middle.
 */
const BASIC: Material = {
  // linear-gradient(160deg, #DEDFE3 0%, #BBBCC0 100%), the candidate's white
  // plastic, so the ramp is the one measured for it; the inks are grey.
  ramp: [[0, 214], [1, 180]],
  ink: darkInk(143, 197), // #8C8F98
  ink2: darkInk(143, 197), // #8C8F98
  edge: { ink: solid("FgPrimary"), width: 1 }, // 1px #F4F4F5
};

/**
 * `WHITE_PLASTIC_VARS` under the heat rank's sheen (`#E0A4003D` and on up),
 * which the device shows as a warm cast: #CCBDA5 at spark and ignition, from
 * a grey the design sets at #DEDFE3 -> #BBBCC0. The cast is the rank's colour
 * at a sixth, which is how the five warm accents map onto two warm tokens.
 */
function whitePlastic(score: number, threshold: number): Material {
  return { ...WHITE_PLASTIC, tints: heatTint(score, threshold) };
}

function heatTint(score: number, threshold: number): Ink[] {
  if (!(score > 0) || !(threshold > 0)) return [];
  const rank = Math.min(5, Math.max(1, Math.ceil(Math.min(1, score / threshold) * 5)));
  if (rank <= 2) return [{ color: "FgWarning", alpha: 0.17 }];
  if (rank === 3) return [{ color: "FgWarning", alpha: 0.09 }, { color: "FgError", alpha: 0.09 }];
  if (rank === 4) return [{ color: "FgError", alpha: 0.17 }];
  return [{ color: "FgError", alpha: 0.17 }, { color: "BgSurfaceMain", alpha: 0.06 }];
}

const WHITE_PLASTIC: Material = {
  // linear-gradient(160deg, #DEDFE3 0%, #BBBCC0 100%), under the heat tint
  ramp: [[0, 214], [1, 180]],
  ink: solid("BgSurfaceMain"), // #101114
  ink2: darkInk(114, 205), // #6F727A
};

/**
 * `SILVER_BASE_VARS`: linear-gradient(151deg, #B2B3B3 0%, #DCDEE0 30%,
 * #C5D3ED 48%, #F7F5F4 62%, #F6DCC5 80%, #AEA6A5 100%), smoothed to its
 * lightness.
 */
const SILVER_FOIL: Material = {
  ramp: [[0, 196], [0.3, 218], [0.62, 234], [0.8, 224], [1, 184]],
  ink: solid("BgSurfaceMain"), // #0B0C0F
  ink2: darkInk(114, 215), // #6F727A
  // The foil's cool and warm bands (#C5D3ED, #F6DCC5), which the ramp cannot tint.
  foil: 0.3,
};

/**
 * The silver tiers by their sheen. Week 1's is white, so the foil shows. From
 * week 2 the sheen colours the whole card: pink (#F472B6 at 42%) measures
 * #EDBFDC on a device, which is the error red at 28% over near-white less
 * the lilac; teal (#2DD4BF) is the success green; violet (#8B5CF6) has no
 * token, so it is the rainbow turned up.
 */
function silver(weeks: number): Material {
  if (weeks < 2) return SILVER_FOIL;
  if (weeks < 4) {
    return {
      ...SILVER_FOIL,
      ramp: [[0, 234], [0.5, 245], [1, 236]],
      foil: 0.35,
      ink2: darkInk(114, 225),
      tints: [{ color: "FgError", alpha: 0.24 }],
    };
  }
  if (weeks < 8) return { ...SILVER_FOIL, foil: undefined, tints: [{ color: "FgSuccess", alpha: 0.2 }] };
  return { ...SILVER_FOIL, foil: 0.6 };
}

/** `DARK_SILVER_BASE_VARS`; week 26's salmon and week 39's plum sheens as a red cast. */
function darkSilver(weeks: number): Material {
  if (weeks < 26) return DARK_SILVER;
  if (weeks < 39) return { ...DARK_SILVER, tints: [{ color: "FgError", alpha: 0.12 }] };
  return { ...DARK_SILVER, tints: [{ color: "FgError", alpha: 0.1 }, { color: "BgSurfaceMain", alpha: 0.1 }] };
}

const DARK_SILVER: Material = {
  // #83878E -> #5C6067
  ramp: [[0, 135], [1, 96]],
  ink: solid("FgPrimary"), // #F4F4F5
  ink2: { color: "FgPrimary", alpha: 0.62 }, // rgba(244,244,245,0.62)
};

/** `BLACK_BASE_VARS`, with `--c-holo` climbing past week 78. */
function black(holo: number): Material {
  return {
    // #17181C -> #0C0D10
    ramp: [[0, 24], [1, 13]],
    ink: solid("FgPrimary"),
    ink2: { color: "FgPrimary", alpha: 0.62 },
    // 1px rgba(244,244,245,0.65): the light edge is part of the black card.
    edge: { ink: { color: "FgPrimary", alpha: 0.65 }, width: 1 },
    // The holo layer is a 0.3-alpha conic rainbow at `--c-holo`; the host's
    // rainbow is a 0.3-alpha linear one, so the same opacity carries it.
    ...(holo > 0 ? { foil: holo } : {}),
  };
}

const CAUTION: Material = {
  // linear-gradient(160deg, #B9BBBE 0%, #97999D 100%), 3px #F59E0B; measured #AFB1B5
  ramp: [[0, 193], [1, 155]],
  ink: solid("BgSurfaceMain"), // #101114
  ink2: darkInk(68, 170), // #41444B
  edge: { ink: solid("FgWarning"), width: 3 }, // --warning is #F59E0B, exactly
  ribbon: { label: "CAUTION", ground: "FgWarning", ink: "BgSurfaceMain" },
};

const SUSPENDED: Material = {
  // linear-gradient(160deg, #8A8C90 0%, #707276 100%), 3px #D9363E; measured #828487
  ramp: [[0, 142], [1, 118]],
  ink: solid("BgSurfaceMain"), // #101114
  ink2: darkInk(33, 126), // #202126
  edge: { ink: solid("FgError"), width: 3 }, // --error is #D9363E, exactly
  ribbon: { label: "SUSPENDED", ground: "FgError", ink: "FgPrimary" },
  faded: true,
};

/**
 * `MEMBER_MATERIALS`, by first active week: silver foil (1-12), dark silver
 * (13-51), black from 52 with holo climbing from 78. Anything below the first
 * tier stays silver: a member card is always silver. The per-tier sheen is a
 * diagonal highlight the vocabulary cannot draw; its colour survives as a cast.
 */
function memberMaterial(weeks: number): Material {
  if (!Number.isFinite(weeks) || weeks < 13) return silver(weeks);
  if (weeks < 52) return darkSilver(weeks);
  if (weeks < 78) return black(0);
  if (weeks < 104) return black(0.35);
  if (weeks < 208) return black(0.5);
  if (weeks < 312) return black(0.65);
  if (weeks < 416) return black(0.8);
  return black(0.9);
}

function materialOf(state: PocketFaceState): Material {
  switch (state.kind) {
    case "not-enrolled":
    case "devicehood":
      return BASIC;
    case "candidate":
      return whitePlastic(state.score, state.threshold);
    case "membership-ready":
    case "member":
      return memberMaterial(state.weeks);
    case "caution":
      return CAUTION;
    case "suspended":
      return SUSPENDED;
  }
}

/** The status word under the name, as `cardStatusLabel` spells it; the face sets it in capitals. */
export function faceStatusLabel(state: PocketFaceState): string {
  switch (state.kind) {
    case "not-enrolled":
      return "Not enrolled";
    case "devicehood":
      return "Devicehood";
    case "candidate":
      return "Candidate";
    case "membership-ready":
      return "Membership Ready";
    case "member":
    case "caution":
      return "Member";
    case "suspended":
      return "Suspended";
  }
}

/** Opacity as the protocol carries it: a whole number of 255ths. */
function alphaOf(alpha: number): number {
  return Math.round(Math.min(1, Math.max(0, alpha)) * 255);
}

/** The modifiers that draw `ink` at `extra` of its own opacity, as a text or fill colour. */
function inkOpacity(ink: Ink, extra = 1): Modifier[] {
  const alpha = (ink.alpha ?? 1) * extra;
  return alpha >= 1 ? [] : [opacity(alphaOf(alpha))];
}

function inkText(content: string, style: TypographyStyle, ink: Ink, extra = 1, modifiers: Modifier[] = []): RendererNode {
  return text(content, { style, color: ink.color, modifiers: [...inkOpacity(ink, extra), ...modifiers] });
}

/** A layer of the face: full size, its content pinned to one corner. */
function layer(child: RendererNode, align: ContentAlignment, modifiers: Modifier[] = []): RendererNode {
  return box([child], { modifiers: [fillWidth(), fillHeight(), ...modifiers], contentAlignment: align });
}

/** The grey at `position` down the card, interpolated between the ramp's stops. */
function greyAt(ramp: readonly Stop[], position: number): number {
  const after = ramp.findIndex(([at]) => at >= position);
  if (after <= 0) return (ramp[Math.max(0, after)] ?? ramp[0] ?? [0, GROUND])[1];
  const [p0, g0] = ramp[after - 1] ?? [0, GROUND];
  const [p1, g1] = ramp[after] ?? [1, GROUND];
  return g0 + ((g1 - g0) * (position - p0)) / (p1 - p0);
}

/**
 * The material's colour: one `FgPrimary` fill over the opaque ground, at the
 * grey the design's gradient has halfway down. Solid until the renderer can
 * draw gradients: stacked bands faking one show as lines on some hosts.
 */
function ramp(material: Material): RendererNode {
  const grey = greyAt(material.ramp, 0.5);
  return box([], {
    modifiers: [fillWidth(), fillHeight(), opacity(alphaOf((grey - GROUND) / (LIGHT - GROUND))), background("FgPrimary")],
  });
}

/** A colour laid flat over the whole face. */
function tint(ink: Ink): RendererNode {
  return box([], { modifiers: [fillWidth(), fillHeight(), ...inkOpacity(ink), background(ink.color)] });
}

/** The rainbow effect over the whole face at `alpha`: foil on silver, holo on black. */
function foil(alpha: number): RendererNode {
  return box([effect("Rainbow", [box([], { modifiers: [fillWidth(), fillHeight()] })])], {
    modifiers: [fillWidth(), fillHeight(), opacity(alphaOf(alpha))],
  });
}

/**
 * `inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(0,0,0,0.15)`:
 * the hairlines that make the plastic read as an edge rather than a fill.
 */
function hairlines(): RendererNode[] {
  const line = (color: ColorToken, alpha: number) =>
    box([], { modifiers: [fillWidth(), height(1), opacity(alphaOf(alpha)), background(color)] });
  return [layer(line("FgPrimary", 0.22), "TopStart"), layer(line("BgSurfaceMain", 0.15), "BottomStart")];
}

/**
 * The Polkadot mark in the top-left corner, where the app's card has the
 * avatar. An image from the worker archive: the host fetches it, and a host
 * that cannot (the debug face preview) draws empty space in its place.
 */
function mark(material: Material): RendererNode {
  return image(archive("pocket/card-mark.webp"), {
    fit: "Contain",
    modifiers: [width(MARK_WIDTH), height(MARK_HEIGHT), ...(material.faded ? [opacity(alphaOf(0.6))] : [])],
  });
}

/**
 * The QR glyph in the top-right corner, as the host's own Pocket cards carry
 * it: a hint that the card can be shown as a code. Grey on every material,
 * like the mark.
 */
function qrGlyph(material: Material): RendererNode {
  return image(archive("pocket/qr-code.png"), {
    fit: "Contain",
    modifiers: [width(QR_SIZE), height(QR_SIZE), ...(material.faded ? [opacity(alphaOf(0.6))] : [])],
  });
}

/**
 * `.idcard-top`: the mark, then the name and the status word in capitals,
 * 16/12 from the corner, the words roughly centred on the mark.
 *
 * Built only from what the Android (Compose) and iOS (SwiftUI) hosts draw
 * alike: Boxes that name their alignment (iOS centres a Box that does not),
 * offsets by padding on nodes without a fixed size (iOS puts padding inside a
 * fixed size, Android outside it), and no Row or Column (iOS adds its own gap
 * between their children). The face tests pin all three.
 */
function identity(name: string, state: PocketFaceState, material: Material): RendererNode {
  const status = box([inkText(faceStatusLabel(state).toUpperCase(), "BodySmallRegular", material.ink2)], {
    modifiers: [paddingEach({ top: NAME_LINE, end: 0, bottom: 0, start: 0 })],
    contentAlignment: "TopStart",
  });
  const words = box([inkText(name, "TitleMediumRegular", material.ink), status], {
    modifiers: [paddingEach({ top: WORDS_TOP, end: 0, bottom: 0, start: MARK_WIDTH + MARK_GAP })],
    contentAlignment: "TopStart",
  });
  return box([mark(material), words], { contentAlignment: "TopStart" });
}

/**
 * The wordmark ghosted over the lower half: the brand's Polkadot wordmark,
 * as a PNG from the worker archive since the host cannot set it (a PNG, not
 * the SVG it is rendered from: the iOS host decodes no SVG). An image
 * takes no colour token, so it comes in the two inks the materials use, dark
 * on the light plastics and light on dark silver and black.
 */
function wordmark(material: Material, raised: boolean): RendererNode {
  const alpha = material.faded ? FADED_WORDMARK_ALPHA : WORDMARK_ALPHA;
  const file = material.ink.color === "FgPrimary" ? "pocket/wordmark-light.png" : "pocket/wordmark-dark.png";
  // The offset on a Box of its own: a padding beside the image's fixed size
  // lands outside it on Android and inside it on iOS, which shrinks the image.
  const mark = image(archive(file), {
    fit: "Contain",
    modifiers: [width(WORDMARK_WIDTH), height(WORDMARK_HEIGHT), opacity(alphaOf(alpha))],
  });
  return box([mark], {
    modifiers: [paddingEach({ top: 0, end: 0, bottom: raised ? 50 : 40, start: 0 })],
    contentAlignment: "TopStart",
  });
}

/**
 * The lit part of a segment in `heatRankForScore`'s accent. Two warm tokens
 * and opacity reach all five: spark and ignition (#E0A400, #D98A0B) are the
 * warning amber, flame (#E06716) is amber half over red, fire (#C43B40) is the
 * error red, and blaze (#8C2332) is that red under a third of the ground. The
 * rank is the standing's, not the frame's, so the colour holds while it fills.
 */
function litBar(rank: number, barWidth: number): RendererNode {
  const size = [width(barWidth), height(STRIPE_HEIGHT)];
  const over = (color: ColorToken, alpha: number) =>
    box([], { modifiers: [...size, opacity(alphaOf(alpha)), background(color, rounded(2))] });
  const base: ColorToken = rank <= 2 ? "FgWarning" : "FgError";
  const tint = rank === 3 ? [over("FgWarning", 0.5)] : rank === 5 ? [over("BgSurfaceMain", 0.35)] : [];
  return box(tint, { modifiers: [...size, background(base, rounded(2))] });
}

/**
 * `.idcard-stripe`, by `segmentFills`: ten segments that fill by the share of
 * the threshold covered, the last lit one partway. 16dp in from each side, 8dp
 * up, 7dp tall. The design's segments share the width (`flex: 1`) and lean at
 * -22deg; the vocabulary has neither weights nor skew, so each segment is
 * sized for the design's 330dp card and the row spreads them across whatever
 * width the host gives it. A partial fill is a lit bar of whole dp inside the
 * unlit track, so a tween has one step per dp to draw.
 */
function stripe(standing: number, shown: number): RendererNode {
  const rank = Math.min(5, Math.max(1, Math.ceil(standing * 5)));
  const segmentWidth = Math.floor((DESIGN_WIDTH - 2 * EDGE - STRIPE_GAP * (PROGRESS_SEGMENTS - 1)) / PROGRESS_SEGMENTS);
  const segments = segmentFills(shown).map((fill) => {
    const bar = Math.round(fill * segmentWidth);
    const track = box([], {
      modifiers: [
        width(segmentWidth),
        height(STRIPE_HEIGHT),
        opacity(alphaOf(0.09)), // rgba(16,17,20,0.09)
        background("BgSurfaceMain", rounded(2)),
      ],
    });
    return box(bar > 0 ? [track, litBar(rank, bar)] : [track], {
      modifiers: [width(segmentWidth), height(STRIPE_HEIGHT)],
      contentAlignment: "CenterStart",
    });
  });
  return row(segments, {
    modifiers: [fillWidth()],
    verticalAlignment: "Center",
    horizontalArrangement: "SpaceBetween",
  });
}

/**
 * `.idcard-pill`: a ribbon across the top-right corner, in the edge's colour.
 * The design turns it 33deg across the corner; with no rotation it lies flat
 * against the right edge, with the QR glyph moved just under it.
 */
function ribbon({ label, ground, ink }: NonNullable<Material["ribbon"]>): RendererNode {
  return box([text(label, { style: "BodySmallRegular", color: ink })], {
    modifiers: [width(124), background(ground, square()), padding(6, 0)],
    contentAlignment: "Center",
  });
}

/** The material's own edge (`--c-border` at `--c-bw`), drawn over everything like the CSS border. */
function edge({ ink, width: size }: NonNullable<Material["edge"]>): RendererNode {
  return box([], {
    modifiers: [fillWidth(), fillHeight(), ...inkOpacity(ink), border(size, ink.color, rounded(CARD_RADIUS))],
  });
}

export function humanityFace({ name, state, fill }: PocketFace): RendererNode {
  const material = materialOf(state);
  const candidate = state.kind === "candidate" ? state : null;
  const standing = candidate == null ? 0 : progressShare(candidate.score, candidate.threshold);

  return box(
    [
      ramp(material),
      ...(material.tints ?? []).map(tint),
      ...(material.foil === undefined ? [] : [foil(material.foil)]),
      ...hairlines(),
      layer(wordmark(material, candidate != null), "BottomStart"),
      layer(identity(name, state, material), "TopStart", [paddingEach({ top: TOP, end: EDGE, bottom: 0, start: EDGE })]),
      layer(qrGlyph(material), "TopEnd", [
        paddingEach({ top: material.ribbon === undefined ? QR_INSET : QR_UNDER_RIBBON, end: QR_INSET, bottom: 0, start: 0 }),
      ]),
      ...(material.ribbon === undefined
        ? []
        : [layer(ribbon(material.ribbon), "TopEnd", [paddingEach({ top: RIBBON_TOP, end: 0, bottom: 0, start: 0 })])]),
      ...(candidate == null
        ? []
        : [
            layer(stripe(standing, fill ?? standing), "BottomStart", [
              paddingEach({ top: 0, end: EDGE, bottom: 8, start: EDGE }),
            ]),
          ]),
      ...(material.edge === undefined ? [] : [edge(material.edge)]),
    ],
    {
      modifiers: [fillWidth(), fillHeight(), background("BgSurfaceMain", rounded(CARD_RADIUS))],
      contentAlignment: "TopStart",
    },
  );
}
