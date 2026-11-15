// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// apps/jollity-app/AGENTS.md, Architecture rule 1: ONE DOORWAY TO THE CHAIN.
// `lib/engine.ts` is the only module in the app that value-imports the
// @jollity/game-chain BARREL, because the barrel re-exports chain/client and
// pulls polkadot-api and the generated descriptors into that bundle. Rule 2
// draws the other half: values come from the pure `@jollity/game-chain/game`
// subpath, which is why this rule matches the barrel alone and lets the
// subpaths through. Types are erased
// at compile, so `import type` is fine anywhere.
import { importGuard } from "../lib.mjs"

const RULE_ID = "no-game-chain-value-import"

const noGameChainValueImport = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Value imports of @jollity/game-chain only in lib/engine.ts (apps/jollity-app/AGENTS.md, Architecture rule 1).",
    },
    messages: {
      gameChainValue:
        "Value import of the @jollity/game-chain barrel. Only lib/engine.ts may value-import it; elsewhere take values from the pure `@jollity/game-chain/game` subpath (rule 2) and types with `import type` (apps/jollity-app/AGENTS.md, Architecture rule 1).",
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
      pkg: "@jollity/game-chain",
      exact: true,
      messageId: "gameChainValue",
    })
  },
}

export default noGameChainValueImport
