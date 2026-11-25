// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE COLLECTABLES SCREEN'S UI RENDERS. app/collectables and components/collectables draw what
// useCollectablesScreen (lib/collectables/use-collectables-screen) hands them, and send the page's
// own taps back. The chain, the payoff's journey, storage and telemetry are
// the collectables screen's host's (lib/collectables/collectables-screen-host), which reaches them
// through one module, lib/collectables/collectables-screen-deps. This rule keeps that split
// from creeping back: those modules, and the SDK packages under them, are not
// imported here. Types are erased at compile, so `import type` is fine. A
// relative path (`../../lib/telemetry`) is read as the `@/` path it means.
import { posix } from "node:path"
import { importGuard } from "../lib.mjs"

const RULE_ID = "no-chain-in-collectables-ui"

/** the modules the collectables screen's UI may not import, by their `@/` path; without `exact`, what is under it too */
const FORBIDDEN = [
  { pkg: "@/lib/game-source", exact: true },
  { pkg: "@/lib/telemetry" },
  { pkg: "@/lib/journeys" },
  { pkg: "@/lib/worker-bridge", exact: true },
  { pkg: "@/lib/payoff-session", exact: true },
  { pkg: "@/lib/payoff-screen-runner", exact: true },
  { pkg: "@/lib/collectables-picks", exact: true },
  { pkg: "@/lib/collectables-reread", exact: true },
  { pkg: "@/lib/host" },
  { pkg: "@/lib/membership" },
  { pkg: "@/lib/collectables/collectables-screen-deps", exact: true },
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

const noChainInCollectablesUi = {
  meta: {
    type: "problem",
    docs: {
      description:
        "The collectables screen's UI (app/collectables, components/collectables) imports no chain, journey, storage or telemetry module: its host does.",
    },
    messages: {
      collectablesUi:
        "{{pkg}} is not for the collectables screen's UI. It renders what useCollectablesScreen (lib/collectables/use-collectables-screen) gives it; the chain, the payoff's journey, storage and telemetry are run by the collectables screen's host, through lib/collectables/collectables-screen-deps.",
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
    return importGuard(context, { ruleId: RULE_ID, pkgs: FORBIDDEN, messageId: "collectablesUi", normalize })
  },
}

export default noChainInCollectablesUi
