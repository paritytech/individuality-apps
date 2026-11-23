// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Builds the chat-extension WORKER (the long-lived QuickJS context where chat +
// notification APIs live) into apps/jollity-worker/dist/index.js — the second
// executable the deploy manifest ships alongside the app
// (deploy/bulletin-deploy.config.ts).
//
// esbuild rather than Vite, since the app builds with Next. What it keeps:
//   - its own build: no React/app code rides along; only the host wrapper +
//     the @jollity/protocol wire types are imported.
//   - charset "ascii": the host loads worker JS as Latin-1, which would mangle
//     any multi-byte char; escaping keeps it intact.
//   - __PRODUCT_DOTNS__ is baked in as a compile-time define.
//
// EVERY worker build must state its own dotNS name, because the chat card's
// buttons navigate to it BY NAME — a path is silently dropped by the iOS host
// (src/state.ts explains why). Without it SPA_URL falls back to "/" and every
// button on the card becomes a no-op that reports success.
// `PRODUCT_DOTNS=local` is the deliberate opt-out for never-deployed dev builds:
// it bakes EMPTY rather than the literal "local", so SPA_URL takes its
// documented "/" fallback. The built-for vs deployed-to check lives at deploy
// time, in deploy/bulletin-deploy.config.ts.
//
// NEXT_PUBLIC_NETWORK_NAME is mandatory for the same reason the app makes it
// so: @jollity/protocol reads the product account the player signs up with, and
// the fallback People genesis, from its network table. A worker built for the
// other network reads the game of a player who is not this one. The overrides
// the app honours are baked in beside it.
//
// __BOT_ICON__ and __ROOM_ICON__ are baked in the same way: TrUAPI's host rejects a chat icon
// unless it is empty, an https:// URL, or a data:image/{png,jpeg,gif,webp,avif}
// URL under 64 KiB total (the host's chat-icon rule) — a bare monogram string,
// which an older host stack accepted, fails registration with "icon carries a
// scheme that cannot be rendered". Reading
// the PNG at build time and inlining it as a data URL keeps the worker bundle
// self-contained (no runtime fetch of an https:// icon from inside the QuickJS
// sandbox) and keeps state.ts free of binary literals.
//
// The pictures of the cards ride the archive instead, under dist/chat-intro
// for the intro rules and dist/chat-card for the rest, since a chat card names
// an image by its path in the worker archive and the host reads it from there.
// Only the pictures the bundle names are copied, so nothing else dropped into
// those folders of public/ reaches Bulletin.
import { build } from "esbuild"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { chatRelease, loadChatEnvironment } from "./build-config.mjs"

// Both executables read the app env files; shell values retain precedence.
loadChatEnvironment()

const CHAT_ICON_MAX_BYTES = 64 * 1024 // must match the host's chat-icon cap
function chatIconDataUrl(file, shrink) {
  const dataUrl = `data:image/png;base64,${readFileSync(resolve(import.meta.dirname, "../assets", file)).toString("base64")}`
  if (dataUrl.length >= CHAT_ICON_MAX_BYTES) {
    throw new Error(
      `apps/jollity-worker/assets/${file} produces a ${dataUrl.length}-byte data URL, ` +
        `at or over the host's ${CHAT_ICON_MAX_BYTES}-byte cap. Shrink the source PNG (e.g. ${shrink}).`,
    )
  }
  return dataUrl
}
const botIconDataUrl = chatIconDataUrl("bot-icon.png", "sips -Z 96 --out apps/jollity-worker/assets/bot-icon.png deploy/icon.png")
const roomIconDataUrl = chatIconDataUrl(
  "room-icon.png",
  "rsvg-convert -w 256 -h 256 apps/jollity-worker/assets/room-icon.svg -o apps/jollity-worker/assets/room-icon.png",
)

const requested = process.env.PRODUCT_DOTNS
if (!requested) {
  throw new Error(
    `PRODUCT_DOTNS is not set, so the chat card's buttons would silently do nothing on iOS.\n` +
      `  Set it to the name you are deploying to — the SAME one you pass to bulletin-deploy:\n` +
      `    NEXT_PUBLIC_NETWORK_NAME=paseo PRODUCT_DOTNS=my-game.paseo npm run build:chat\n` +
      `  For a local build that will never be deployed: NEXT_PUBLIC_NETWORK_NAME=previewnet PRODUCT_DOTNS=local npm run build:chat`,
  )
}
const productDotns = requested === "local" ? "" : requested

const network = process.env.NEXT_PUBLIC_NETWORK_NAME
if (!network) {
  throw new Error(
    `NEXT_PUBLIC_NETWORK_NAME is not set, so the worker would not know whose game to read.\n` +
      `  Set it to the network of the build, the same value the app build takes:\n` +
      `    NEXT_PUBLIC_NETWORK_NAME=paseo PRODUCT_DOTNS=dim2.paseo npm run build:chat`,
  )
}
const protocolEnv = [
  "NEXT_PUBLIC_NETWORK_NAME",
  "NEXT_PUBLIC_SIGNUP_ACCOUNT_INDEX",
  "NEXT_PUBLIC_PEOPLE_WS",
  "NEXT_PUBLIC_ASSET_HUB_WS",
  "NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS",
  "NEXT_PUBLIC_PEOPLE_GENESIS",
  "NEXT_PUBLIC_ASSET_HUB_GENESIS",
  "NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL",
  "NEXT_PUBLIC_PRIZE_UNIT",
]

// DD_SCRATCH=worker builds a worker that posts the Daily Dollar scratch card it
// draws itself (src/daily-dollar/scratch-worker.ts). Its ticket and claim are
// stand-ins, so the default posts none.
const ddScratch = process.env.DD_SCRATCH ?? "none"
if (!["worker", "none"].includes(ddScratch)) throw new Error("DD_SCRATCH must be worker or none")

await build({
  entryPoints: [resolve(import.meta.dirname, "../src/index.ts")],
  outfile: resolve(import.meta.dirname, "../dist/index.js"),
  bundle: true,
  format: "esm",
  charset: "ascii",
  define: {
    __DD_SCRATCH__: JSON.stringify(ddScratch),
    __PRODUCT_DOTNS__: JSON.stringify(productDotns),
    __BOT_ICON__: JSON.stringify(botIconDataUrl),
    __ROOM_ICON__: JSON.stringify(roomIconDataUrl),
    // The worker's own telemetry (src/telemetry.ts). Empty means it sends nothing.
    __SENTRY_DSN__: JSON.stringify(process.env.NEXT_PUBLIC_SENTRY_DSN || ""),
    // The test project's DSN: a worker built as `local` or served
    // from localhost writes there instead (chatDsnFor). Empty = production only.
    __SENTRY_DSN_TEST__: JSON.stringify(process.env.NEXT_PUBLIC_SENTRY_DSN_TEST || ""),
    // The release is the app's (lib/telemetry/init.ts): jollity@<NEXT_PUBLIC_APP_VERSION>, the
    // source hash in CI, so identical sources build an identical worker and the deploy cache holds.
    __CHAT_RELEASE__: JSON.stringify(chatRelease()),
    ...Object.fromEntries(
      protocolEnv.map((name) => {
        const value = process.env[name]
        return [`process.env.${name}`, value === undefined ? "undefined" : JSON.stringify(value)]
      }),
    ),
  },
})
const pictureFolders = ["chat-intro", "chat-card"]
for (const folder of pictureFolders) rmSync(resolve(import.meta.dirname, "../dist", folder), { recursive: true, force: true })
const bundle = readFileSync(resolve(import.meta.dirname, "../dist/index.js"), "utf8")
const named = [...new Set(bundle.match(/chat-(?:intro|card)\/[\w./-]+\.(?:png|jpe?g|webp|gif|avif|svg)/g) ?? [])]
const unnamed = pictureFolders.filter((folder) => !named.some((path) => path.startsWith(`${folder}/`)))
if (unnamed.length > 0) {
  throw new Error(
    `The build found no picture of ${unnamed.join(" or ")} in the bundle, though the intro rules and the rare badge of the results card always name one. The pattern that finds them has missed.`,
  )
}
const missing = named.filter((path) => !existsSync(resolve(import.meta.dirname, "../../jollity-app/public", path)))
if (missing.length > 0) {
  throw new Error(`The worker names pictures the archive would not hold: ${missing.join(", ")}. Add them to public/chat-intro or public/chat-card.`)
}
for (const path of named) {
  const to = resolve(import.meta.dirname, "../dist", path)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(resolve(import.meta.dirname, "../../jollity-app/public", path), to)
}
console.log(
  `The build wrote apps/jollity-worker/dist/index.js for PRODUCT_DOTNS=${productDotns || "empty, the dev fallback"} on ${network}.`,
)
