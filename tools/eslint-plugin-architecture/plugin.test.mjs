// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Fixture tests for the four architecture rules: one valid case, one invalid
// case, and one case proving the allowlist exempts a known offender — plus the
// "moved on" case that proves an entry fails closed when its text goes away,
// and the "stale entry" case that fails the build when an exemption stops
// matching anything.
//
// Run with `npm run test:lint-plugin`. The cases are deliberately tiny: each
// one is the smallest source that exercises its rule, and the filenames are
// repo-relative so the allowlist matcher sees what it sees in the real config.
import { describe, it } from "vitest"
import { RuleTester } from "eslint"
import parser from "@typescript-eslint/parser"
import plugin from "./index.mjs"

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

// The fixtures are TypeScript (`import type`, type annotations), so the tester
// parses them the way the real config does.
const tester = new RuleTester({
  languageOptions: { parser, ecmaVersion: 2022, sourceType: "module" },
})

/** An allowlist entry for `file` whose line contains `text`. */
const allow = (rule, file, text) => [
  { rule, file, text, reason: "fixture: tolerated here for the test" },
]

// ── rule 7: no Date.now / new Date() in timed UI ─────────────────────────────
tester.run("no-device-clock", plugin.rules["no-device-clock"], {
  valid: [
    {
      name: "the source's clock",
      filename: "components/countdown/clock.tsx",
      code: "const left = source.nowSeconds() - gameAt",
    },
    {
      name: "a Date built from an explicit instant is not the device clock",
      filename: "components/debug/stamp.tsx",
      code: "const label = new Date(ms).toISOString()",
    },
    {
      name: "another Date method is not the device clock",
      filename: "components/debug/stamp.tsx",
      code: "const ms = Date.parse(label)",
    },
    {
      name: "the allowlist exempts a known offender",
      filename: "components/debug/clock-view.tsx",
      code: "const t = Date.now()",
      options: [{ allowlist: allow("no-device-clock", "components/debug/clock-view.tsx", "Date.now()") }],
    },
  ],
  invalid: [
    {
      name: "Date.now() in a component",
      filename: "components/game/animations.ts",
      code: "const since = Date.now() - start",
      errors: [{ messageId: "deviceClock", data: { call: "Date.now()" } }],
    },
    {
      name: "new Date() with no argument",
      filename: "app/page.tsx",
      code: "const now = new Date()",
      errors: [{ messageId: "deviceClock", data: { call: "new Date()" } }],
    },
    {
      name: "Date.now as a REFERENCE, not a call (useState(Date.now))",
      filename: "app/collectables/page.tsx",
      code: "const [startedAt] = useState(Date.now)",
      errors: [{ messageId: "deviceClock", data: { call: "Date.now" } }],
    },
    {
      name: "Date.now assigned as a default",
      filename: "lib/use-thing.ts",
      code: "const f = Date.now",
      errors: [{ messageId: "deviceClock", data: { call: "Date.now" } }],
    },
    {
      name: "globalThis.Date.now()",
      filename: "components/game/animations.ts",
      code: "const since = globalThis.Date.now() - start",
      errors: [{ messageId: "deviceClock", data: { call: "globalThis.Date.now()" } }],
    },
    {
      name: "window.Date.now()",
      filename: "components/game/animations.ts",
      code: "const since = window.Date.now() - start",
      errors: [{ messageId: "deviceClock", data: { call: "window.Date.now()" } }],
    },
    {
      name: "Date[\"now\"]() — the computed form",
      filename: "components/game/animations.ts",
      code: 'const since = Date["now"]() - start',
      errors: [{ messageId: "deviceClock", data: { call: 'Date["now"]()' } }],
    },
    {
      name: "an entry whose text is on another line fails closed",
      filename: "components/debug/clock-view.tsx",
      code: "const a = 1\nconst t = Date.now()",
      options: [{ allowlist: allow("no-device-clock", "components/debug/clock-view.tsx", "const a = 1") }],
      errors: [{ messageId: "deviceClock" }],
    },
    {
      name: "a stale entry — its text is gone from the file — fails the build",
      filename: "components/debug/clock-view.tsx",
      code: "const t = source.nowSeconds()",
      options: [{ allowlist: allow("no-device-clock", "components/debug/clock-view.tsx", "Date.now()") }],
      errors: [{ messageId: "staleAllowlist" }],
    },
  ],
})

// ── rule 1: value imports of the game-chain barrel only in lib/engine.ts ─────
tester.run("no-game-chain-value-import", plugin.rules["no-game-chain-value-import"], {
  valid: [
    {
      name: "the doorway",
      filename: "lib/engine.ts",
      code: 'import { createChainEngine } from "@jollity/game-chain"',
      options: [{ allow: ["lib/engine.ts"] }],
    },
    {
      name: "types anywhere",
      filename: "lib/game-source.ts",
      code: 'import type { GameTimingInfo } from "@jollity/game-chain"',
      options: [{ allow: ["lib/engine.ts"] }],
    },
    {
      name: "a type-only re-export is erased too",
      filename: "lib/game-source.ts",
      code: 'export type { GameTimingInfo } from "@jollity/game-chain"',
      options: [{ allow: ["lib/engine.ts"] }],
    },
    {
      name: "the pure subpath (rule 2)",
      filename: "lib/grid-layout.ts",
      code: 'import { hostSeat } from "@jollity/game-chain/game"',
      options: [{ allow: ["lib/engine.ts"] }],
    },
    {
      name: "the allowlist exempts a known offender",
      filename: "lib/old-seam.ts",
      code: 'import { createPeopleClient } from "@jollity/game-chain"',
      options: [{ allow: ["lib/engine.ts"], allowlist: allow("no-game-chain-value-import", "lib/old-seam.ts", "@jollity/game-chain") }],
    },
  ],
  invalid: [
    {
      name: "a value import outside the doorway",
      filename: "lib/grid-layout.ts",
      code: 'import { createPeopleClient } from "@jollity/game-chain"',
      options: [{ allow: ["lib/engine.ts"] }],
      errors: [{ messageId: "gameChainValue" }],
    },
    {
      name: "a mixed import counts as a value import",
      filename: "lib/grid-layout.ts",
      code: 'import { hostSeat, type GameTimingInfo } from "@jollity/game-chain"',
      options: [{ allow: ["lib/engine.ts"] }],
      errors: [{ messageId: "gameChainValue" }],
    },
    {
      name: "a side-effect import pulls the barrel in",
      filename: "lib/grid-layout.ts",
      code: 'import "@jollity/game-chain"',
      options: [{ allow: ["lib/engine.ts"] }],
      errors: [{ messageId: "gameChainValue" }],
    },
    {
      name: "an empty import list still loads the module",
      filename: "lib/grid-layout.ts",
      code: 'import {} from "@jollity/game-chain"',
      options: [{ allow: ["lib/engine.ts"] }],
      errors: [{ messageId: "gameChainValue" }],
    },
    {
      name: "a dynamic import",
      filename: "lib/grid-layout.ts",
      code: 'const m = await import("@jollity/game-chain")',
      options: [{ allow: ["lib/engine.ts"] }],
      errors: [{ messageId: "gameChainValue" }],
    },
    {
      name: "a named re-export",
      filename: "lib/grid-layout.ts",
      code: 'export { createPeopleClient } from "@jollity/game-chain"',
      options: [{ allow: ["lib/engine.ts"] }],
      errors: [{ messageId: "gameChainValue" }],
    },
    {
      name: "an export-all",
      filename: "lib/grid-layout.ts",
      code: 'export * from "@jollity/game-chain"',
      options: [{ allow: ["lib/engine.ts"] }],
      errors: [{ messageId: "gameChainValue" }],
    },
    {
      name: "a require",
      filename: "lib/grid-layout.ts",
      code: 'const m = require("@jollity/game-chain")',
      options: [{ allow: ["lib/engine.ts"] }],
      errors: [{ messageId: "gameChainValue" }],
    },
  ],
})

// ── rule 5: the host SDK only behind a doorway ───────────────────────────────
tester.run("no-host-sdk-outside-doorways", plugin.rules["no-host-sdk-outside-doorways"], {
  valid: [
    {
      name: "lib/host/**",
      filename: "lib/host/storage.ts",
      code: 'import type { HostLocalStorage } from "@parity/product-sdk-host"',
      options: [{ allow: ["lib/host/**", "lib/permissions.ts"] }],
    },
    {
      name: "lib/permissions.ts",
      filename: "lib/permissions.ts",
      code: 'import { requestPermission } from "@parity/product-sdk-host"',
      options: [{ allow: ["lib/host/**", "lib/permissions.ts"] }],
    },
    {
      name: "lib/collectable-art.ts is a documented doorway (rule 5)",
      filename: "lib/collectable-art.ts",
      code: 'const sdk = await import("@parity/product-sdk-host")',
      options: [{ allow: ["lib/host/**", "lib/permissions.ts", "lib/collectable-art.ts"] }],
    },
    {
      name: "the allowlist exempts a known offender",
      filename: "lib/game-source.ts",
      code: 'import type { TruApi } from "@parity/product-sdk-host"',
      options: [{ allow: ["lib/host/**"], allowlist: allow("no-host-sdk-outside-doorways", "lib/game-source.ts", "@parity/product-sdk-host") }],
    },
  ],
  invalid: [
    {
      name: "a screen reaching for the host SDK",
      filename: "app/collectables/page.tsx",
      code: 'import { getHostProvider } from "@parity/product-sdk-host"',
      options: [{ allow: ["lib/host/**", "lib/permissions.ts"] }],
      errors: [{ messageId: "hostSdk" }],
    },
    {
      name: "another lib module outside the doorways",
      filename: "lib/draw/name-link.ts",
      code: 'import type { ProductAccount } from "@parity/product-sdk-host"',
      options: [{ allow: ["lib/host/**", "lib/permissions.ts"] }],
      errors: [{ messageId: "hostSdk" }],
    },
    {
      name: "a dynamic import is a value import, wherever it sits",
      filename: "lib/draw/name-link.ts",
      code: 'const sdk = await import("@parity/product-sdk-host")',
      options: [{ allow: ["lib/host/**", "lib/permissions.ts"] }],
      errors: [{ messageId: "hostSdk" }],
    },
    {
      name: "a re-export",
      filename: "lib/draw/name-link.ts",
      code: 'export { getHostProvider } from "@parity/product-sdk-host"',
      options: [{ allow: ["lib/host/**", "lib/permissions.ts"] }],
      errors: [{ messageId: "hostSdk" }],
    },
  ],
})

// ── the dependency order: papi only in the seam and the engines ──────────────
tester.run("no-papi-outside-engine", plugin.rules["no-papi-outside-engine"], {
  valid: [
    {
      name: "the engine seam",
      filename: "lib/engine.ts",
      code: 'import { createClient } from "polkadot-api"',
      options: [{ allow: ["lib/engine.ts"] }],
    },
    {
      name: "an engine package",
      filename: "packages/jollity-game-chain/src/engine.ts",
      code: 'import { AccountId } from "polkadot-api"',
      options: [{ allow: ["packages/**"] }],
    },
    {
      name: "a type-only import of a @polkadot-api helper stays legal",
      filename: "lib/game-source.ts",
      code: 'import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"',
      options: [{ allow: ["lib/engine.ts"] }],
    },
    {
      name: "the allowlist exempts a known offender",
      filename: "lib/game-source.ts",
      code: 'import { AccountId } from "polkadot-api"',
      options: [{ allow: ["lib/engine.ts"], allowlist: allow("no-papi-outside-engine", "lib/game-source.ts", "polkadot-api") }],
    },
  ],
  invalid: [
    {
      name: "a subpath import outside the seam",
      filename: "lib/draw/name-link.ts",
      code: 'import { getWsProvider } from "polkadot-api/ws"',
      options: [{ allow: ["lib/engine.ts", "packages/**"] }],
      errors: [{ messageId: "papi" }],
    },
    {
      name: "a type-only import is still an import of the escape hatch",
      filename: "app/page.tsx",
      code: 'import type { PolkadotClient } from "polkadot-api"',
      options: [{ allow: ["lib/engine.ts", "packages/**"] }],
      errors: [{ messageId: "papi" }],
    },
    {
      name: "a dynamic import of a papi subpath",
      filename: "lib/draw/draw-name-lookup.ts",
      code: 'const [, { createClient }] = await Promise.all([import("../engine"), import("polkadot-api")])',
      options: [{ allow: ["lib/engine.ts"] }],
      errors: [{ messageId: "papi" }],
    },
    {
      name: "the @polkadot-api scope, as a value import",
      filename: "lib/webrtc/ice.ts",
      code: 'import { Signer } from "@polkadot-api/signers-common"',
      options: [{ allow: ["lib/engine.ts"] }],
      errors: [{ messageId: "papi" }],
    },
  ],
})

// ── the prize draw's UI renders; its host reaches the chain ─────────────────
tester.run("no-chain-in-draw-ui", plugin.rules["no-chain-in-draw-ui"], {
  valid: [
    {
      name: "the page takes everything from its hook",
      filename: "apps/jollity-app/app/prize-draw/page.tsx",
      code: 'import { usePrizeDraw } from "@/lib/draw/use-prize-draw"',
    },
    {
      name: "pure helpers and types are fine",
      filename: "apps/jollity-app/components/draw/wheel-stage.tsx",
      code: 'import { PRIZE_UNIT } from "@/lib/draw/prize-unit"\nimport type { GameSource } from "@/lib/game-source"',
    },
    {
      name: "a relative path to a pure module",
      filename: "apps/jollity-app/components/draw/wheel-stage.tsx",
      code: 'import { drawIntro } from "../../lib/draw/draw-miss"',
    },
    {
      name: "the allowlist exempts a known offender",
      filename: "apps/jollity-app/components/draw/old.tsx",
      code: 'import { devLog } from "@/lib/telemetry"',
      options: [{ allowlist: allow("no-chain-in-draw-ui", "apps/jollity-app/components/draw/old.tsx", "@/lib/telemetry") }],
    },
  ],
  invalid: [
    {
      name: "the chain's doorway",
      filename: "apps/jollity-app/app/prize-draw/page.tsx",
      code: 'import { getGameSource } from "@/lib/game-source"',
      errors: [{ messageId: "drawUi", data: { pkg: "@/lib/game-source" } }],
    },
    {
      name: "telemetry, under its folder",
      filename: "apps/jollity-app/components/draw/wheel-stage.tsx",
      code: 'import { useScene } from "@/lib/telemetry/use-scene"',
      errors: [{ messageId: "drawUi" }],
    },
    {
      name: "a relative path is the module it names",
      filename: "apps/jollity-app/components/draw/wheel-stage.tsx",
      code: 'import { reportDrawCeremony } from "../../lib/telemetry"',
      errors: [{ messageId: "drawUi", data: { pkg: "../../lib/telemetry" } }],
    },
    {
      name: "a dynamic import of the draw's read",
      filename: "apps/jollity-app/app/prize-draw/page.tsx",
      code: 'void import("@/lib/draw/draw-load")',
      errors: [{ messageId: "drawUi" }],
    },
    {
      name: "an SDK package, and a re-export of the journey",
      filename: "apps/jollity-app/components/draw/names.ts",
      code: 'import { linkName } from "@individuality/name-link"\nexport * from "@/lib/journeys/game-trace"',
      errors: [{ messageId: "drawUi" }, { messageId: "drawUi" }],
    },
    {
      name: "a stale entry — its text is gone from the file — fails the build",
      filename: "apps/jollity-app/components/draw/old.tsx",
      code: 'import { usePrizeDraw } from "@/lib/draw/use-prize-draw"',
      options: [{ allowlist: allow("no-chain-in-draw-ui", "apps/jollity-app/components/draw/old.tsx", "@/lib/telemetry") }],
      errors: [{ messageId: "staleAllowlist" }],
    },
  ],
})

// ── the collectables screen's UI renders; its host reaches the chain ───────────────────────
tester.run("no-chain-in-collectables-ui", plugin.rules["no-chain-in-collectables-ui"], {
  valid: [
    {
      name: "the page reads its screen from the hook",
      filename: "apps/jollity-app/app/collectables/page.tsx",
      code: 'import { useCollectablesScreen } from "@/lib/collectables/use-collectables-screen"\nimport { canChangePick } from "@jollity/collectables"',
    },
    {
      name: "a type from the source is erased",
      filename: "apps/jollity-app/components/collectables/collectables-scene.tsx",
      code: 'import type { GameSource } from "@/lib/game-source"',
    },
  ],
  invalid: [
    {
      name: "the source, by its alias",
      filename: "apps/jollity-app/app/collectables/page.tsx",
      code: 'import { getGameSource } from "@/lib/game-source"',
      errors: [{ messageId: "collectablesUi", data: { pkg: "@/lib/game-source" } }],
    },
    {
      name: "picks storage, by a relative path",
      filename: "apps/jollity-app/components/collectables/collectables-scene.tsx",
      code: 'import { saveCollectablesPick } from "../../lib/collectables-picks"',
      errors: [{ messageId: "collectablesUi", data: { pkg: "../../lib/collectables-picks" } }],
    },
    {
      name: "the host's own way out, and the journey under it",
      filename: "apps/jollity-app/app/collectables/page.tsx",
      code: 'import { browserCollectablesScreenDeps } from "@/lib/collectables/collectables-screen-deps"\nimport { collectablesShown } from "@/lib/journeys/game-trace"',
      errors: [{ messageId: "collectablesUi" }, { messageId: "collectablesUi" }],
    },
  ],
})
