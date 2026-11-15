// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// apps/jollity-app/AGENTS.md, Architecture rule 7: TIME COMES FROM THE SOURCE.
// A countdown or phase test reads the game clock, `source.nowSeconds()`;
// `Date.now()` / `new Date()` are the wall clock, which can jump at any moment
// (time sync, time zone, the user).
//
// SCOPE, stated once (eslint.config.mjs applies it, this header is why): the
// rule runs on `app/` and `components/` — the rendering surface — and on the
// `lib/` modules that drive timed UI: `lib/game-session.ts`,
// `lib/home-gate.ts`, `lib/draw/draw-screen.ts`, `lib/use-*.ts` and
// `lib/*/use-*.ts`. It deliberately does NOT run on the rest of `lib/`: that
// is where the clocks themselves live — `lib/device-clock.ts`,
// `lib/game-source.ts`'s chain anchor, the telemetry stamps, the waits of rule
// 3 and the saved-across-reload stamps of rule 4 of docs/time-and-clocks.md. A
// blanket `Date.now` ban there would flag the code that DEFINES the source
// clock, and the exemptions would outnumber the rule. Those reads are
// governed by docs/time-and-clocks.md's inventory instead.
import { report, staleAllowlist } from "../lib.mjs"

const RULE_ID = "no-device-clock"

/** `Date`, `globalThis.Date`, `window.Date` — the object a clock read hangs off. */
function dateObjectName(node) {
  if (node.type === "Identifier") return node.name === "Date" ? "Date" : undefined
  if (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    (node.object.name === "globalThis" || node.object.name === "window") &&
    (node.property.type === "Identifier"
      ? node.property.name === "Date"
      : node.property.type === "Literal" && node.property.value === "Date")
  ) {
    return `${node.object.name}.Date`
  }
  return undefined
}

/** `now` as written: `.now`, `["now"]` or `['now']`. `computed` lives on the
 *  MEMBER EXPRESSION, not on the property node. */
function isNow(member) {
  if (!member.computed) return member.property.type === "Identifier" && member.property.name === "now"
  return member.property.type === "Literal" && member.property.value === "now"
}

const noDeviceClock = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Timed UI reads the game source's clock, never the device clock (apps/jollity-app/AGENTS.md, Architecture rule 7).",
    },
    messages: {
      deviceClock:
        "`{{call}}` is the DEVICE clock. Timed UI must read the source's clock: `source.nowSeconds()` (apps/jollity-app/AGENTS.md, Architecture rule 7). If this really is device time, add an allowlist entry with the reason.",
      staleAllowlist:
        "Stale allowlist entry for {{file}}: `{{text}}` no longer appears in the file. The exemption outlived the code it covered — remove the entry.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowlist: { type: "array" },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const { allowlist = [] } = context.options[0] ?? {}
    const check = (node, call) =>
      report(context, RULE_ID, allowlist, node, "deviceClock", { call })
    return {
      // The MEMBER EXPRESSION, in any position — a call, a reference handed to
      // `useState`, a default parameter. Matching only the call missed
      // `useState(Date.now)` and every `= Date.now` default.
      MemberExpression(node) {
        const object = dateObjectName(node.object)
        if (!object || !isNow(node)) return
        const asCall = node.parent.type === "CallExpression" && node.parent.callee === node
        const written = context.sourceCode.getText(node)
        check(node, asCall ? `${written}()` : written)
      },
      NewExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "Date" &&
          node.arguments.length === 0
        ) {
          check(node, "new Date()")
        }
      },
      "Program:exit"(node) {
        for (const e of staleAllowlist(context, allowlist, RULE_ID))
          context.report({ node, messageId: "staleAllowlist", data: { file: e.file, text: e.text } })
      },
    }
  },
}

export default noDeviceClock
