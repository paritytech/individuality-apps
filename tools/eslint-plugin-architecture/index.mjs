// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @jollity/eslint-plugin-architecture — the Architecture rules of
// apps/jollity-app/AGENTS.md, as rules that fail the build. Six rules, each one
// rule of that section or one screen's own boundary:
//
//   no-chain-in-collectables-ui            the collectables screen's UI renders; its host reaches out
//   no-chain-in-draw-ui             the prize draw's UI renders; its host reaches out
//   no-device-clock                 rule 7: time comes from the source
//   no-game-chain-value-import      rule 1: one doorway to the chain
//   no-host-sdk-outside-doorways    rule 5: host capabilities behind a doorway
//   no-papi-outside-engine          the dependency order (papi is an escape hatch)
//
// Every rule takes `{ allow, allowlist }` options. `allow` is the file set the
// rule is scoped to and comes from eslint.config.mjs; `allowlist` is
// ./allowlist.mjs, an entry per tolerated violation, each with its reason.
// An entry is keyed on the violating LINE'S TEXT, not its number, and every
// rule reports an entry whose text no longer appears in its file — a stale
// exemption fails the build instead of sitting there looking load-bearing.
import noChainInCollectablesUi from "./rules/no-chain-in-collectables-ui.mjs"
import noChainInDrawUi from "./rules/no-chain-in-draw-ui.mjs"
import noDeviceClock from "./rules/no-device-clock.mjs"
import noGameChainValueImport from "./rules/no-game-chain-value-import.mjs"
import noHostSdkOutsideDoorways from "./rules/no-host-sdk-outside-doorways.mjs"
import noPapiOutsideEngine from "./rules/no-papi-outside-engine.mjs"

const plugin = {
  meta: { name: "@jollity/eslint-plugin-architecture" },
  rules: {
    "no-chain-in-collectables-ui": noChainInCollectablesUi,
    "no-chain-in-draw-ui": noChainInDrawUi,
    "no-device-clock": noDeviceClock,
    "no-game-chain-value-import": noGameChainValueImport,
    "no-host-sdk-outside-doorways": noHostSdkOutsideDoorways,
    "no-papi-outside-engine": noPapiOutsideEngine,
  },
}

export default plugin