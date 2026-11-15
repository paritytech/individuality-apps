// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

// The real build in scripts/build.mjs bakes these in as esbuild defines, and
// vitest does not run through them, so the tests declare the same names with
// the values `PRODUCT_DOTNS=local` gives. __BOT_ICON__ and __ROOM_ICON__ are
// read from the same assets the build inlines, so state.test.ts checks the icons
// that ship against the validate_chat_icon rule of the host.
// NEXT_PUBLIC_NETWORK_NAME is what @jollity/protocol reads the product account
// and genesis from.
const iconDataUrl = (file: string) =>
  `data:image/png;base64,${readFileSync(resolve(import.meta.dirname, "./assets", file)).toString("base64")}`

export default defineConfig({
  define: {
    __SENTRY_DSN__: JSON.stringify(""),
    __SENTRY_DSN_TEST__: JSON.stringify(""),
    __CHAT_RELEASE__: JSON.stringify(""),
    __PRODUCT_DOTNS__: JSON.stringify(""),
    __BOT_ICON__: JSON.stringify(iconDataUrl("bot-icon.png")),
    __ROOM_ICON__: JSON.stringify(iconDataUrl("room-icon.png")),
  },
  test: {
    env: { NEXT_PUBLIC_NETWORK_NAME: "paseo" },
  },
})
