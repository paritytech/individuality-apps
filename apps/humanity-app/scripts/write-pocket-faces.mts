// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Writes the static Pocket card faces the host's approval sheet draws.
 *
 * The sheet shows a card before it is added, when no worker is running to
 * draw one, so the face has to exist as a file in the worker archive. These
 * are generated from the same module the worker renders live
 * (`@humanity/shared/pocket/humanity-face.ts`) rather than written by hand,
 * because a sheet that disagrees with the card it is offering is worse than
 * no sheet.
 *
 * Vite copies `public/` into the worker's `dist/` verbatim, so these land at
 * `pocket/*.json` inside the archive — the path a published
 * `pocket.cards[].preview` resolves.
 *
 *   npm run humanity:pocket:faces
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  humanityFace,
  type PocketFaceState,
} from "../../../packages/humanity-shared/src/pocket/humanity-face.ts";

/** A stand-in name: the sheet is drawn before the host knows whose card it is. */
const SAMPLE_NAME = "alice.01";

const FACES: Record<string, PocketFaceState> = {
  "not-enrolled": { kind: "not-enrolled" },
  devicehood: { kind: "devicehood" },
  candidate: { kind: "candidate", score: 4, threshold: 10 },
  "membership-ready": { kind: "membership-ready", weeks: 3 },
  member: { kind: "member", weeks: 3 },
  "member-dark": { kind: "member", weeks: 20 },
  "member-black": { kind: "member", weeks: 120 },
  caution: { kind: "caution", misses: 2, allowedMisses: 3, window: 8 },
  suspended: { kind: "suspended" },
};

const outDir = fileURLToPath(new URL("../../humanity-worker/public/pocket/", import.meta.url));
mkdirSync(outDir, { recursive: true });

for (const [name, state] of Object.entries(FACES)) {
  const face = humanityFace({ name: SAMPLE_NAME, state });
  const path = `${outDir}${name}.json`;
  writeFileSync(path, `${JSON.stringify(face, null, 2)}\n`);
  console.log(`wrote ${name}.json`);
}
