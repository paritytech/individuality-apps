// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Violations the architecture rules tolerate TODAY, one entry per violation,
// each with the reason it stands. An entry is `{ rule, file, text, reason }`:
// `text` must still appear on the offending line, so the exemption covers that
// line and only that line. Edit the line and the rule speaks up again; delete
// the line and the entry becomes stale, which every rule reports at the end of
// the file. Nothing here is a blanket disable — every entry is a line someone
// has to justify.
//
// Keyed on TEXT, not on a line number: a number churns on every edit above it
// and says nothing about what is tolerated, and it cannot be checked for
// staleness. Two entries in one file may share text only if they are different
// rules; one rule's entry covers every line containing its text.
//
// Keep this list shrinking. An entry added without a reason is a bug.
const allowlist = [
  // ── rule 7: the device clock, where the device clock is the subject ────────
  {
    rule: "no-device-clock",
    file: "apps/jollity-app/components/debug/clock-view.tsx",
    text: "const [nowMs, setNowMs] = useState(() => Date.now())",
    reason:
      "The debug sheet's whole job is to show DEVICE time beside the source clock's offset and T, so the two can be compared by eye. Reading the source clock here would make the comparison meaningless.",
  },
  {
    rule: "no-device-clock",
    file: "apps/jollity-app/components/debug/clock-view.tsx",
    text: "const id = setInterval(() => setNowMs(Date.now()), 1000)",
    reason:
      "The same device-time read, on its 1 s tick. It is the tick of the debug readout above, not a phase or a countdown.",
  },
  {
    rule: "no-device-clock",
    file: "apps/jollity-app/components/debug/use-debug-sheet.ts",
    text: "const now = Date.now()",
    reason:
      "A tap gesture's window (TAP_COUNT taps within TAP_WINDOW_MS) at the top of the screen. It measures the user's fingers on this device and never compares against a game phase or chain time.",
  },
  {
    rule: "no-device-clock",
    file: "apps/jollity-app/components/game/animations.ts",
    text: "const since = Date.now() - startAt * 1000",
    reason:
      "`useTilesEnter` turns `startAt` (a device-clock unix-seconds reading captured when the round begins) into a CSS animation DELAY, so a mount mid-round joins the move-in where the clock has it. It animates; it never decides a phase.",
  },

  // ── rule 7, the lib/ modules that drive timed UI ───────────────────────────
  // The rule now covers lib/game-session.ts, lib/home-gate.ts and the use-*
  // hooks. What it finds there is already catalogued in
  // docs/time-and-clocks.md: the Rule 3 waits (allowed to read the device
  // clock) and the Rule 1 violations the doc lists as debt to fix. Each is
  // a separate entry so a fix deletes exactly one and the rest stay visible.
  {
    rule: "no-device-clock",
    file: "apps/jollity-app/lib/game-session.ts",
    text: "return Date.now() / 1000",
    reason:
      "KNOWN RULE 1 DEBT, listed in docs/time-and-clocks.md's inventory: the session's local `nowSeconds()` is `Date.now()/1000`. It drives the boundary timers — the fix is to route them through the source clock, which is a behaviour change, not a lint fix. Tracked in the doc, not silently tolerated.",
  },
  {
    rule: "no-device-clock",
    file: "apps/jollity-app/lib/game-session.ts",
    text: "return Date.now()",
    reason:
      "The injected auto-confirm away-latch clock: how long the page has been HIDDEN, including the return leg when timers froze. Step 2 preserves today's Date.now semantics behind this one adapter; correcting the known clock gap is a separate behaviour PR.",
  },
  {
    rule: "no-device-clock",
    file: "apps/jollity-app/lib/use-game-status.ts",
    text: "const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))",
    reason:
      "KNOWN RULE 1 DEBT, listed in docs/time-and-clocks.md's inventory: the initial value before the source resolves. Once it resolves the tick below reads `source.nowSeconds()`; the fix is to seed it from the source (or leave it undefined until it arrives), a prop/behaviour change across the home page.",
  },
  {
    rule: "no-device-clock",
    file: "apps/jollity-app/lib/use-game-status.ts",
    text: "const tick = () => setNow(source ? source.nowSeconds() : Math.floor(Date.now() / 1000))",
    reason:
      "The same known Rule 1 debt's fallback branch: it reads the device clock ONLY when there is no source at all (no host, no dev override — the gate screen), where there is no chain clock to read. The source branch is the conforming one.",
  },
  {
    rule: "no-device-clock",
    file: "apps/jollity-app/lib/webrtc/use-path-mode.ts",
    text: "if (!fresh || Date.now() - fresh.at > PROBE_FRESH_MS) void run(false)",
    reason:
      "How old the last ICE path probe is, to decide whether to run another. A Rule 3 cooldown; it never decides a game phase.",
  },
  {
    rule: "no-device-clock",
    file: "apps/jollity-app/lib/webrtc/use-turn-warmup.ts",
    text: "export function warmupRefreshDelays(gameAt: number, nowMs = Date.now()): number[] {",
    reason:
      "The default `nowMs` for a pure delay calculation: `gameAt` comes from chain time and the function only converts it into setTimeout delays for the TURN refresh. The caller may pass any clock; the default is a Rule 3 convenience.",
  },

  // ── the dependency order: papi where the host does not reach yet ───────────
  {
    rule: "no-papi-outside-engine",
    file: "apps/jollity-app/lib/game-source.ts",
    text: 'import { AccountId } from "polkadot-api"',
    reason:
      "AccountId().dec(account.publicKey) is the one decode the host SDK does not offer: turning the host's raw public key into the SS58 form the pallet reads. It is an AccountId codec, not a chain client, and lives in the doorway that the SDK cannot yet cover.",
  },
  {
    rule: "no-papi-outside-engine",
    file: "apps/jollity-app/lib/draw/name-link.ts",
    text: 'import { createClient, type PolkadotClient } from "polkadot-api"',
    reason:
      "Name linking opens its own Asset Hub / People clients when the host serves none (the standalone preview path); product-sdk's host provider cannot build a client for a chain it was not given. Justified in the module header.",
  },
  {
    rule: "no-papi-outside-engine",
    file: "apps/jollity-app/lib/draw/name-link.ts",
    text: 'import { fromHex } from "polkadot-api/utils"',
    reason:
      "`fromHex` is the same standalone name-link path's hex decode for the link transaction; it is a codec helper, not a client.",
  },
  {
    rule: "no-papi-outside-engine",
    file: "apps/jollity-app/lib/draw/name-link.ts",
    text: 'import { getWsProvider } from "polkadot-api/ws"',
    reason:
      "The WS transport for those standalone clients, same module and same reason as the `createClient` entry above.",
  },
  {
    rule: "no-papi-outside-engine",
    file: "apps/jollity-app/lib/player-names.ts",
    text: 'import("polkadot-api"),',
    reason:
      "The DotNS name reader of the draw, loaded lazily so a page with no names never pays for the client. It is the same standalone fallback as name-link's: the host's chain when there is one, the network's own endpoint in a preview. Justified in the module header.",
  },
  {
    rule: "no-papi-outside-engine",
    file: "apps/jollity-app/lib/player-names.ts",
    text: 'import("polkadot-api/ws"),',
    reason:
      "The WS transport for that same lazy client, same module and same reason as the entry above.",
  },
  {
    rule: "no-papi-outside-engine",
    file: "apps/jollity-app/lib/engine.test.ts",
    text: 'import { createClient } from "polkadot-api"',
    reason:
      "This is the seam's OWN test: it mocks `createClient` to prove lib/engine.ts picks the chain engine without opening a socket. A test of the escape hatch has to name it.",
  },

  // ── rule 5: a doorway that is not under lib/host/ ─────────────────────────
  {
    rule: "no-host-sdk-outside-doorways",
    file: "apps/jollity-app/lib/draw/name-link.ts",
    text: 'import type { ProductAccount } from "@parity/product-sdk-host"',
    reason:
      "Type-only: the link function's `product` parameter is the host product account. The VALUE (accounts, signer) is passed in by lib/game-source.ts, which is the sanctioned doorway; nothing here calls the host SDK.",
  },
  {
    rule: "no-host-sdk-outside-doorways",
    file: "apps/jollity-app/lib/draw/name-link.ts",
    text: 'const sdk = await import("@parity/product-sdk-host")',
    reason:
      "The link's OWN read of the host, in the background run lib/game-source.ts starts: it asks for the accounts provider to find the username's root and has the host sign. It belongs to the same standalone name-link path as the papi entries above and is justified in the module header; folding it into lib/host/identity.ts is the follow-up.",
  },
  {
    rule: "no-host-sdk-outside-doorways",
    file: "apps/jollity-app/lib/contracts/host-wire.test.ts",
    text: 'from "@parity/product-sdk-host/testing"',
    reason:
      "A contract test: it pins the host SDK's connection-status wire, so it drives the SDK's own fake client on purpose. Test code, never shipped; screens still go through the doorways.",
  },
  {
    rule: "no-host-sdk-outside-doorways",
    file: "apps/jollity-app/lib/contracts/host-wire.test.ts",
    text: 'import { subscribeConnectionStatus } from "@parity/product-sdk-host"',
    reason:
      "Same contract test: the subscription it pins IS the SDK export, so the test imports it directly to fail when its shape changes.",
  },
  ]

export default allowlist
