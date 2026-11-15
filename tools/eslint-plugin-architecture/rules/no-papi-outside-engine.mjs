// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// apps/jollity-app/AGENTS.md, Architecture rules 0 (the dependency order) and
// 1: polkadot-api is the ESCAPE HATCH. In the app it lives in lib/engine.ts
// (the seam) and nowhere else; the engine packages own their own use. Anywhere
// else it is debt, justified in the module header and raised upstream to fold
// back into the SDK.
//
// The scope is both spellings: `polkadot-api` and its subpaths, and the
// `@polkadot-api/*` packages (`signers-common`, …) that ride the same substrate.
// A TYPE import of the latter is free — `CommonSignerTxCreator` is a signature,
// erased at compile — so the scoped package is `typesOnly: false` while the
// escape hatch proper is not.
import { importGuard } from "../lib.mjs"

const RULE_ID = "no-papi-outside-engine"

const noPapiOutsideEngine = {
  meta: {
    type: "problem",
    docs: {
      description:
        "polkadot-api only in lib/engine.ts and the engine packages (dependency order).",
    },
    messages: {
      papi:
        "Import of `{{pkg}}`. polkadot-api is the ESCAPE HATCH: it belongs in lib/engine.ts or a packages/* engine, not here. Use @parity/product-sdk first, truapi second; if papi is genuinely required, justify it in the module header and add an allowlist entry.",
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
      pkgs: [
        { pkg: "polkadot-api", typesOnly: true },
        { pkg: "@polkadot-api", typesOnly: false },
      ],
      messageId: "papi",
    })
  },
}

export default noPapiOutsideEngine
