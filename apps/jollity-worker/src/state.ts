// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Constants of the chat worker, and the host storage it keeps.
 *
 * Storage goes through the injected `WorkerHost` of host.ts, never a direct
 * host import, which is why `readJSON` and `writeJSON` below take it as their
 * first argument. The app reads `jollity.showTutorial` and writes
 * `jollity.seen`, both in lib/worker-bridge.ts. Every other key is the memory
 * of the worker, kept so a restart does not repeat itself.
 */
import type { GameResults } from "./card"
import type { WorkerHost } from "./host"
import { chatCount, describeError } from "./telemetry"

// Bot + room identity. Names are text-only (no emoji) — the host loads worker
// JS as Latin-1, and the copy stays emoji-free. The icons are NOT
// text any more: TrUAPI's host (unlike the older @novasamatech one) parses the
// icon field as a scheme — empty, an https:// URL, or a data:image/{png,jpeg,
// gif,webp,avif} URL under 64 KiB — and rejects a bare monogram string like
// "WG"/"J" with "icon carries a scheme that cannot be rendered" (the host's
// chat-icon rule). Both icons are PNGs of assets/, inlined as data URLs at
// build time (scripts/build.mjs).
//
// __BOT_ICON__ is the game app's own icon.png, downscaled. Neither phone shows
// it: iOS and Android both refuse registerBot.
//
// __ROOM_ICON__ is the Polkadot app's icon, since the room is the Polkadot room.
// assets/room-icon.svg is the Polkadot app icon's own glyph (its paths
// untouched) on its black ground,
// and room-icon.png is its 256 px render. The host takes one image per room,
// so there is no light or dark variant.
//
// esbuild's `define` substitutes the literal text, so each one is read at ONE
// site: a second reference would double its string in the bundle.
export const BOT_ID = "weekly-game-bot"
export const BOT_NAME = "Weekly Game"
export const BOT_ICON = __BOT_ICON__
// The id stays "jollity": the host keys the room on it, and a new id would
// register a second room beside the old one.
export const ROOM_ID = "jollity"
export const ROOM_NAME = "Polkadot"
export const ROOM_ICON = __ROOM_ICON__

// Mirrors the host's chat-icon rule (`validate_chat_icon` in truapi's platform
// crate) so a regression — reverting an icon to a bare string, growing the asset past the
// cap, or picking an unsupported media type — fails a fast local test instead of
// only surfacing as a runtime "icon carries a scheme that cannot be rendered" from
// inside a real host. Kept in sync deliberately, same discipline as the codec pin
// in hostStack.test.ts: if the host's rule moves, this moves with it, in the same
// change.
export const CHAT_ICON_MAX_BYTES = 64 * 1024
const ALLOWED_DATA_URL_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]
export function isAcceptableChatIcon(icon: string): boolean {
  if (icon.trim() === "") return true
  // >=, not >: matches scripts/build.mjs's own guard (the stricter, safe-side
  // reading of the host's "under 64 KiB" — an icon exactly at the cap is
  // rejected by both, so the two guards never disagree at the boundary).
  if (icon.length >= CHAT_ICON_MAX_BYTES) return false
  if (icon.startsWith("https://")) return true
  if (icon.startsWith("data:")) {
    const mediaType = icon.slice("data:".length).split(/[;,]/, 1)[0] ?? ""
    return ALLOWED_DATA_URL_MEDIA_TYPES.includes(mediaType)
  }
  return false
}

/** The one-shot marker the app records when a reminder opens it. */
export const REMINDER_PATH = "/?jollity-notification=reminder"

/**
 * Where the cards send the player: THIS PRODUCT'S OWN dotNS NAME, not a path.
 *
 * It used to be "/" and that is silently dead on iOS. `navigateTo` there resolves
 * the destination to a `ProductHost` — a name plus a root, with no path or query —
 * and if it cannot parse one it returns without navigating and without throwing.
 * A relative "/" has no host component, so
 * `ProductHost.fromNavigationDestination` falls through to a label parse, fails,
 * and the external-link branch then rejects it for having no URL scheme. Nothing
 * happens, no error is reported, and the worker log still says "navigated".
 * Android is more forgiving — it hands the whole URI to a navigation policy — so
 * this only ever broke on one platform.
 *
 * The bare name works on both. Falls back to "/" for local dev, where there is no
 * host and navigation is a no-op anyway.
 */
export const SPA_URL = __PRODUCT_DOTNS__ || "/"

/**
 * Whether truapi takes `name` for the game product, the one product its game
 * service answers.
 *
 * The label is exactly dim2, on any TLD truapi knows (`is_game_product` in
 * the truapi platform). Every other name gets `unsupported`. A TLD truapi does
 * not know would be read here as the game product and get no reminder at all,
 * and no build uses one.
 */
export function isGameProduct(name: string): boolean {
  const dot = name.lastIndexOf(".")
  return dot > 0 && name.slice(0, dot) === "dim2"
}

export const IS_GAME_PRODUCT = isGameProduct(__PRODUCT_DOTNS__)

/**
 * The flag the How it works button leaves for the app, which routes to /nux on
 * boot when lib/worker-bridge.ts finds it.
 *
 * The button also opens /nux as a deep link. The flag is for the hosts that
 * drop the path of a navigation and open the product root, where the query of
 * a URL cannot carry the request either, as SPA_URL explains.
 */
export const TUTORIAL_KEY = "jollity.showTutorial"

/**
 * A DEEP LINK into one of the SPA's pages. Newer iOS hosts parse a full URL in
 * navigateTo and KEEP the relative part — so `https://<name>/<path>` lands on
 * the page itself. A bare name still resolves to the root, which is why the
 * storage-flag handoff stays as the fallback for older hosts.
 * Dev fallback (no baked name): just the path, for a plain browser.
 */
export function spaPage(path: string): string {
  if (SPA_URL === "/") return path
  return `https://${SPA_URL}${path}`
}

/**
 * The play times of the last few games a card was posted for, newest last.
 * Older workers stored one play time as a bare number.
 */
export const ANNOUNCED_KEY = "jollity.wg.announced"
/** When the game whose card the footer of the room holds starts, or null with the footer empty. */
export const DOCKED_KEY = "jollity.wg.docked"
/** The highest game index whose past card the worker has posted or found already posted. */
export const BACKFILL_KEY = "jollity.wg.backfilled"
/** The notification ids booked for one game. */
export const NOTIFICATIONS_KEY = "jollity.wg.notifs"
/** How many of the eight rules were posted. */
export const INTRO_KEY = "jollity.wg.intro.v3"
/** The last games seen running, newest last. */
export const GAMES_KEY = "jollity.wg.games"
/** The chain clock minus the device clock of the last good read, in milliseconds. */
export const CLOCK_OFFSET_KEY = "jollity.wg.clockOffset"
/** How the game ended for the player, keyed by its play time. */
export const RECAP_KEY = "jollity.wg.recap"
/** The number of the last migration of apps/jollity-worker/src/migrations this phone ran. */
export const MIGRATIONS_KEY = "jollity.wg.migrations"
/** The app's proof that this worker executable is alive and belongs to the same deployed build. */
export const WORKER_HEARTBEAT_KEY = "jollity.wg.workerHeartbeat"
/** Give a stuck host write up before the next 30-second pulse is due. */
export const WORKER_HEARTBEAT_WRITE_DEADLINE_MS = 10_000

interface WorkerHeartbeat {
  /** Device-wall milliseconds. The app and worker run on the same phone. */
  at: number
  /** Sentry release shape, shared with the app: jollity@<build hash>. */
  release: string
}

const chatRelease = () => (typeof __CHAT_RELEASE__ === "string" && __CHAT_RELEASE__ ? __CHAT_RELEASE__ : "unknown")

/** Best-effort proof of life. A storage failure is telemetry, never a reason to stop the worker. */
export function writeWorkerHeartbeat(
  host: StorageHost,
  at = Date.now(),
  release = chatRelease(),
): Promise<boolean> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  const write = host.storage
    .writeJSON(WORKER_HEARTBEAT_KEY, { at, release } satisfies WorkerHeartbeat)
    .then(() => true)
    .catch(() => false)
  return Promise.race([
    write,
    new Promise<false>((resolve) => {
      deadline = setTimeout(() => resolve(false), WORKER_HEARTBEAT_WRITE_DEADLINE_MS)
    }),
  ]).finally(() => {
    if (deadline !== undefined) clearTimeout(deadline)
  })
}

/**
 * Run beside the chain loop, so a slow game read cannot age out this proof.
 * The immediate pulse plus 30-second cadence and 90-second app freshness
 * window tolerate hosts that run the worker in roughly one-minute bursts.
 */
export function startWorkerHeartbeat(host: StorageHost, everyMs = 30_000): () => void {
  let writing = false
  const pulse = () => {
    if (writing) return
    writing = true
    void writeWorkerHeartbeat(host).finally(() => {
      writing = false
    })
  }
  pulse()
  const interval = setInterval(pulse, everyMs)
  return () => clearInterval(interval)
}

/**
 * What the player has done in the app around a game, keyed by its index.
 *
 * The app writes it with markSeen in lib/worker-bridge.ts, and the card holds
 * the won ticket back until the draw is watched, unless the prize can be
 * claimed, which shows it at once.
 */
export const SEEN_KEY = "jollity.seen"
/** `report` is set once the report of the player landed, and is absent on records the app wrote before it knew. */
export type Seen = { chest: boolean; draw: boolean; report?: boolean }
export const UNSEEN: Seen = { chest: false, draw: false }

/**
 * One game as it ran, kept for its results after the chain has let it go.
 *
 * `airdropsScheduled` is unreadable once the game ends, and the prize read of
 * the SDK needs it to find the draws of the game. The sign-up and the
 * membership going in are read while the game runs, since a missed game
 * pauses a membership and the card says so.
 */
export type SeenGame = {
  index: number
  gamePlayTime: number
  airdropsScheduled: number
  endsAt: number
  registered: boolean
  memberBefore: boolean | null
  /** The chain held the report of the player while the game ran, which its row no longer says after the settle. */
  reported?: boolean
}

/**
 * How a game ended for the player, stored once the chain has decided it, which
 * can be before the game settles (`early`).
 * `results` is null when the player did not play it, or played and was not
 * confirmed, which the card draws as missed.
 */
export type StoredOutcome = {
  cancelled: boolean
  results: GameResults | null
  gamesToMembership: number | null
  /** Outlives the games list, which keeps only the last few, as do the two below. Absent on older outcomes. */
  gameIndex?: number
  registered?: boolean
  memberBefore?: boolean | null
  /** The chain suspended the membership by the time the outcome was read. Absent on older outcomes, as is the one below. */
  paused?: boolean
  /** Games the player can still miss before the chain suspends them, for a member only. */
  missesLeft?: number | null
  /** The position of the prize draw among the draws of the game, so a refresh reads the same one. */
  drawIndex?: number
  /** The prize read failed when the outcome was stored, and a later poll reads it again. */
  prizeUnread?: boolean
  /** Stored before the game settled, once the chain applied the player's
   *  attendance early (#1096): its collectibles still land, and the settle
   *  reads it once more. */
  early?: boolean
  /** The chain held the report of the player while the game ran. Absent on outcomes read after the settle with no poll during the game. */
  reported?: boolean
  /** What a player who played and did not pass was credited, kept here because such an outcome has no results to hold it. */
  earned?: number
}

/**
 * The reminders booked for one game and sign-up, so a change of either cancels them.
 *
 * A booking where a push failed, such as before the notification permission is
 * granted, is not complete. A poll from `retryAt` on books it again, so a
 * denied permission does not fail on every poll.
 */
export type Scheduled = {
  gamePlayTime: number
  registered: boolean
  hostReminds?: boolean
  /** Every id the host gave back for this booking, which lib/debug/worker-evidence.ts counts. */
  ids: number[]
  /**
   * Each reminder of the booking by its moment, with the id the host gave
   * back, or null while it is claimed. `pushing` marks a push that started:
   * after its deadline the host may hold it under an id the worker never
   * learnt, so it is never pushed again for this booking. A claimed moment
   * never started is pushed by the retry. Absent on older records.
   */
  moments?: Record<string, { id: number | null; at: number; pushing?: boolean }>
  /** Ids whose cancel the host refused, cancelled again on the next booking until their time has passed. */
  stale?: { id: number; at?: number }[]
  complete?: boolean
  retryAt?: number
  /** A push was refused for device permission; retry only after permission reads granted. */
  permissionRefused?: boolean
}

/** The moments a record holds, from an older record too, which kept its ids alone. */
export function idsOf(moments: Scheduled["moments"]): number[] {
  return Object.values(moments ?? {}).flatMap((booked) => (booked.id === null ? [] : [booked.id]))
}

/** A host or chain call that never answers must not hold the poll for good. */
export const CALL_DEADLINE_MS = 45_000

/** Distinguishes a silent host call from a prompt rejection we can retry differently. */
export class CallDeadlineError extends Error {}

/** "jollity.wg.recap:1800" is of the class "jollity.wg.recap": the key without what varies per game. */
const keyClass = (key: string) => key.split(":")[0]!

/** The canary for a host with no storage: once per key class and direction per run, never throws. */
function storageFailed(name: "chat.storage.read_failed" | "chat.storage.write_failed", key: string, error: unknown): void {
  chatCount(name, { key_class: keyClass(key) }, { detail: { error: describeError(error) }, key: keyClass(key), once: true })
}

/** The promise, or a rejection once `ms` has passed without an answer. */
export function within<T>(promise: Promise<T>, ms = CALL_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallDeadlineError(`No answer within ${ms}ms.`)), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/** The part of the host the storage helpers use. */
export type StorageHost = Pick<WorkerHost, "storage">

/**
 * The stored value, null when the key holds nothing, or undefined when the
 * read failed.
 *
 * A caller must tell the last two apart. The native chat runtime of iOS
 * release builds gives the worker no storage at all, and a failed read taken
 * as an empty key posts the rules, the card or the reminders again.
 */
export async function readJSON<T>(host: StorageHost, key: string): Promise<T | null | undefined> {
  try {
    return await within(host.storage.readJSON<T>(key))
  } catch (error) {
    storageFailed("chat.storage.read_failed", key, error)
    return undefined
  }
}
/** Whether the value was stored. A write that is a claim must know it failed. */
export async function tryWriteJSON(host: StorageHost, key: string, value: unknown): Promise<boolean> {
  try {
    await within(host.storage.writeJSON(key, value))
    return true
  } catch (error) {
    storageFailed("chat.storage.write_failed", key, error)
    return false
  }
}
export async function writeJSON(host: StorageHost, key: string, value: unknown): Promise<void> {
  await tryWriteJSON(host, key, value)
}

/** A diagnostic log in host storage, for developers rather than the player. */
const LOG_KEY = "jollity.wg.workerLog"
const LOG_MAX = 100
export type LogEntry = { time: number; kind: "info" | "success" | "error"; text: string }
// Every write reads the log first, so the writes run one at a time or two
// appends in flight keep only one of their entries.
let logQueue: Promise<void> = Promise.resolve()
function queued(task: () => Promise<void>): Promise<void> {
  logQueue = logQueue.then(task, task)
  return logQueue
}

export const workerLog = {
  append(host: StorageHost, kind: LogEntry["kind"], text: string): Promise<void> {
    return queued(async () => {
      const entries = await readJSON<LogEntry[]>(host, LOG_KEY)
      if (entries === undefined) return
      await writeJSON(host, LOG_KEY, [...(entries ?? []), { time: Date.now(), kind, text }].slice(-LOG_MAX))
    })
  },
  clear(host: StorageHost): Promise<void> {
    return queued(() => writeJSON(host, LOG_KEY, []))
  },
}
