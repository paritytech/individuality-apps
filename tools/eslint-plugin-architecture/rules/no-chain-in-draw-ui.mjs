// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE PRIZE DRAW'S UI RENDERS. app/prize-draw and components/draw draw what
// usePrizeDraw (lib/draw/use-prize-draw) hands them, and send the page's own
// taps back. The chain, the journey, the idle and telemetry are the draw
// screen's host's (lib/draw/draw-screen-host), which reaches them through one
// module, lib/draw/draw-screen-deps. This rule keeps that split from creeping
// back: those modules, and the SDK packages under them, are not imported here.
// Types are erased at compile, so `import type` is fine. A relative path
// (`../../lib/telemetry`) is read as the `@/` path it means.
import { posix } from "node:path"
import { importGuard } from "../lib.mjs"

const RULE_ID = "no-chain-in-draw-ui"

/** the modules the draw's UI may not import, by their `@/` path; without `exact`, what is under it too */
const FORBIDDEN = [
  { pkg: "@/lib/game-source", exact: true },
  { pkg: "@/lib/telemetry" },
  { pkg: "@/lib/journeys" },
  { pkg: "@/lib/worker-bridge", exact: true },
  { pkg: "@/lib/player-names", exact: true },
  { pkg: "@/lib/payoff-session", exact: true },
  { pkg: "@/lib/draw/draw-load", exact: true },
  { pkg: "@/lib/draw/auto-claim", exact: true },
  { pkg: "@/lib/draw/draw-name-lookup", exact: true },
  { pkg: "@/lib/draw/draw-idle", exact: true },
  { pkg: "@/lib/draw/payoff-runner", exact: true },
  { pkg: "@/lib/draw/draw-screen-deps", exact: true },
  { pkg: "@individuality" },
  { pkg: "@parity" },
]

/** the app's `@/*` is apps/jollity-app/* (its tsconfig.json paths) */
const APP = "apps/jollity-app/"

/** a relative specifier as the `@/` path it means, from the importing file */
function normalize(source, file) {
  if (!source.startsWith(".")) return source
  const resolved = posix.normalize(posix.join(posix.dirname(file), source))
  return resolved.startsWith(APP) ? `@/${resolved.slice(APP.length)}` : source
}

const noChainInDrawUi = {
  meta: {
    type: "problem",
    docs: {
      description:
        "The prize draw's UI (app/prize-draw, components/draw) imports no chain, journey, idle or telemetry module: its host does.",
    },
    messages: {
      drawUi:
        "{{pkg}} is not for the prize draw's UI. It renders what usePrizeDraw (lib/draw/use-prize-draw) gives it; the chain, the journey, the idle and telemetry are run by the draw screen's host, through lib/draw/draw-screen-deps.",
      staleAllowlist:
        "Stale allowlist entry for {{file}}: `{{text}}` no longer appears in the file. The exemption outlived the code it covered — remove the entry.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: { type: "array", items: { type: "string" } },
          allowlist: { type: "array" },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    return importGuard(context, { ruleId: RULE_ID, pkgs: FORBIDDEN, messageId: "drawUi", normalize })
  },
}

export default noChainInDrawUi
