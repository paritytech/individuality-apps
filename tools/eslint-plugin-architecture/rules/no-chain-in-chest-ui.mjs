// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE CHEST'S UI RENDERS. app/chest and components/chest draw what
// useChestScreen (lib/chest/use-chest-screen) hands them, and send the page's
// own taps back. The chain, the payoff's journey, storage and telemetry are
// the chest screen's host's (lib/chest/chest-screen-host), which reaches them
// through one module, lib/chest/chest-screen-deps. This rule keeps that split
// from creeping back: those modules, and the SDK packages under them, are not
// imported here. Types are erased at compile, so `import type` is fine. A
// relative path (`../../lib/telemetry`) is read as the `@/` path it means.
import { posix } from "node:path"
import { importGuard } from "../lib.mjs"

const RULE_ID = "no-chain-in-chest-ui"

/** the modules the chest's UI may not import, by their `@/` path; without `exact`, what is under it too */
const FORBIDDEN = [
  { pkg: "@/lib/game-source", exact: true },
  { pkg: "@/lib/telemetry" },
  { pkg: "@/lib/journeys" },
  { pkg: "@/lib/worker-bridge", exact: true },
  { pkg: "@/lib/payoff-session", exact: true },
  { pkg: "@/lib/payoff-screen-runner", exact: true },
  { pkg: "@/lib/chest-picks", exact: true },
  { pkg: "@/lib/chest-reread", exact: true },
  { pkg: "@/lib/host" },
  { pkg: "@/lib/membership" },
  { pkg: "@/lib/chest/chest-screen-deps", exact: true },
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

const noChainInChestUi = {
  meta: {
    type: "problem",
    docs: {
      description:
        "The chest's UI (app/chest, components/chest) imports no chain, journey, storage or telemetry module: its host does.",
    },
    messages: {
      chestUi:
        "{{pkg}} is not for the chest's UI. It renders what useChestScreen (lib/chest/use-chest-screen) gives it; the chain, the payoff's journey, storage and telemetry are run by the chest screen's host, through lib/chest/chest-screen-deps.",
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
    return importGuard(context, { ruleId: RULE_ID, pkgs: FORBIDDEN, messageId: "chestUi", normalize })
  },
}

export default noChainInChestUi
