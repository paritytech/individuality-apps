// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The candidate's progress stripe, as both cards draw it.
 *
 * A fixed row of segments that fills by the share of the threshold covered,
 * rather than one segment per game: a threshold of 10 and one of 30 draw the
 * same stripe, and a point is always the same length of it. The segment the
 * share ends in is filled partway, so the stripe moves with every point.
 *
 * Shared by the app's card (`MemberCard.tsx`) and the Pocket face
 * (`pocket/humanity-face.ts`), so the two cannot disagree about how far along
 * a person is.
 */

/** Ten segments: each is a tenth of the way to membership. */
export const PROGRESS_SEGMENTS = 10;

/** How much of the threshold a score covers, 0 to 1; 0 for a figure that is not one. */
export function progressShare(score: number, threshold: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(threshold) || threshold <= 0) return 0;
  return Math.min(1, Math.max(0, score / threshold));
}

/**
 * How full each segment is, 0 to 1, left to right, for a share of the whole
 * stripe: `[1, 1, 1, 0.5, 0, ...]` at 35%.
 */
export function segmentFills(share: number, segments: number = PROGRESS_SEGMENTS): number[] {
  const filled = Math.min(1, Math.max(0, Number.isFinite(share) ? share : 0)) * segments;
  return Array.from({ length: segments }, (_, index) => Math.min(1, Math.max(0, filled - index)));
}
