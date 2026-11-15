// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// apps/jollity-app/AGENTS.md, Architecture rule 5: HOST CAPABILITIES GO BEHIND
// A DOORWAY. Only lib/host/**,
// lib/permissions.ts, lib/collectable-art.ts (preimages) and lib/game-source.ts
// (the one doorway to chain state) touch @parity/product-sdk-host. Screens and
// components never do.
//
// Unlike rule 1 there is no `import type` carve-out here: the rule is about
// which modules may NAME the host SDK at all, and a type-only import is still
// a module reaching for it. lib/draw/name-link.ts's type-only import is
// allowlisted with its reason.
import { importGuard } from "../lib.mjs"

const RULE_ID = "no-host-sdk-outside-doorways"

const noHostSdkOutsideDoorways = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Host SDK imports only behind the lib/host doorways and lib/permissions.ts (apps/jollity-app/AGENTS.md, Architecture rule 5).",
    },
    messages: {
      hostSdk:
        "Import of `{{pkg}}`. Host capabilities go through a doorway: lib/host/** (identity, navigate, storage, …), lib/permissions.ts or lib/collectable-art.ts. Screens and components never import the host SDK directly (apps/jollity-app/AGENTS.md, Architecture rule 5).",
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
    return importGuard(context, {
      ruleId: RULE_ID,
      pkg: "@parity/product-sdk-host",
      typesOnly: true,
      messageId: "hostSdk",
    })
  },
}

export default noHostSdkOutsideDoorways
