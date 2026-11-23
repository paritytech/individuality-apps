// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { CreateTransport, RtcPayload, SealedSignalStats, SignalStats } from "./transport"
import type { ResolveStore, StatementStoreLike } from "./store"
import { fromHex, toHex } from "./store"
import {
  classifySignError,
  channelPriorityFloor,
  errMessage,
  onceByKey,
  isTimeRejection,
  nextSlotExpiry,
  raiseSlotExpiryFloor,
  sha256,
  SIGN_TIMEOUT_MS,
  SIGN_TIMEOUT_PREFIX,
  SUBMIT_TIMEOUT_MS,
  withTimeout,
} from "./statementCommon"
import { sha256 as digestOf } from "@noble/hashes/sha2.js"
import { encryptionKeyBytes, sharedSecret } from "./crypto"
import { createStoreClock, type StoreClock, type StoreStamp } from "./storeClock"

/**
 * WebRTC signalling over the People-chain statement store, modelled on the
 * native apps' wire (an earlier version ran at 4 peers with clean
 * connections and zero submit failures), with the store injected
 * (`ResolveStore`) instead of hard-wired to `@parity/product-sdk-host`.
 *
 * The design, vs naive statement signalling (holding the submit primitive,
 * signing, and the standing allowance constant):
 *   1. LOW VOLUME. The naive approach re-submits a growing `{desc+cands[]}`
 *      bundle on EVERY trickle candidate (O(cands) large submits per
 *      generation → `AccountFull` + `error 0` under 4-5-peer load). Here the
 *      desc is submitted ONCE per negotiation generation (it already carries
 *      the non-trickle gathered candidates), and trickle stragglers are
 *      coalesced + debounced into a SEPARATE, monotonic-expiry-overwritten
 *      candidate slot — a whole pair is ~1 desc + a couple of cand
 *      statements, native's "~2 slots per pair" shape. With `bundle` on
 *      (rule 7) those slots are not statements of their own at all.
 *   2. GENERATION GATING (native's offerId). Every offer mints a `gen`;
 *      answers + candidates carry it; the receiver drops any answer or
 *      candidate whose gen ≠ the current generation for that peer — killing
 *      the stale/duplicate delivery that produces `setRemoteDescription …
 *      wrong state: stable` floods. An answer carries the gen of the offer it
 *      ANSWERS: the offer reaches the mesh with its gen (`rtc.gen`) and the
 *      mesh echoes it, because the mesh answers asynchronously and a newer
 *      offer may have moved the generation meanwhile (F7, #214).
 *   3. SUBMIT BACKPRESSURE. A small semaphore caps concurrent submits (host
 *      submit paths fail under concurrency — the `error 0` path).
 *   4. ONE SUBMIT IN FLIGHT PER CHANNEL. The node keeps one statement per
 *      channel and refuses a replacement whose expiry is not higher
 *      (`channelPriorityTooLow`). Two frames of ours on one channel in flight
 *      at once could land in either order, and the refusal of the older one
 *      looks exactly like a pre-reload holder (a glare rebuild once sent its
 *      offer and its answer to one peer in the same millisecond). So a
 *      newer frame for a busy channel waits in the queue (which keeps only the
 *      newest waiting frame per channel) and goes out when the channel's
 *      current submit finishes. Different channels still share the slots. The
 *      cost: an answer queued behind its own offer waits about one submit
 *      round trip.
 *   5. SESSIONS (#214). Every frame carries `sid`, minted once per page boot
 *      (per `statementTransport(...)` call, when its first room opens) and
 *      prefixed with the session clock's time (`sessionNow`: chain time in
 *      the app), so two sids of one peer order. An offer's gen is
 *      `<sid>.<n>`. A reloaded page's old frames stay in the store for up to
 *      a TTL, so a receiver keeps each peer's current sid, takes d, c and bye
 *      from that sid alone, and lets only a HELLO switch it (the presence
 *      slot is one per account, so a stale hello cannot outlive the live
 *      one). While the current sid is live (a hello within
 *      SESSION_SILENT_MS, or our link to it connected; no bye) a hello
 *      switches only if its sid sorts newer and was not left before. Within a sid, an offer whose counter
 *      is below the last one adopted is dropped, and so is our answer to
 *      one. The ORDER IS A HINT, NOT A LOCK: once the current sid has said
 *      bye or sent no hello for SESSION_SILENT_MS, any sid's hello takes
 *      over, so a wrong clock delays a reload by at most that and never
 *      locks a player out. A new sid resets the peer's negotiation state and
 *      is raised as `onPeerSession`, which is how the mesh learns the peer
 *      reloaded. A frame without a sid is taken as before: no ordering, no
 *      session event.
 *   6. A CONNECTED LINK NEEDS LITTLE OF THE STORE (#457). The mesh says which
 *      of its links are up (`setLinked`). A linked peer holds both
 *      descriptions (a link connects on nothing less) and renegotiates over
 *      the link, so the heartbeat stops re-announcing our desc and
 *      candidates to it, except for FRESH_DESC_MS after a desc that did go by
 *      the store (an ICE restart on a link that still reads connected). Once
 *      EVERY link of ours is up, the hello slows to STABLE_HELLO_MS: it is
 *      still what a reload or a late joiner finds us by. A linked peer is
 *      never forgotten for hello silence, and its session stays live while
 *      the link is up, since its hellos may be that slow. The first send of
 *      every desc and candidate is untouched, so forming and healing a link
 *      is as fast as before: a 6-player room that is all up sends 1
 *      statement per phone per 16 s, where every phone sent up to 11 per 8 s.
 *   7. ONE STATEMENT PER PHONE (`bundle: true`). A game-wide room links each
 *      phone to every co-player of every round, up to 10, which would be up to
 *      21 live statements a phone queued 2 at a time. Instead every frame this
 *      side wants live sits in one map, published as ONE bundle on this
 *      phone's channel under its presence topic (rule 8) and replaced
 *      (debounced) when any of them changes: the hello always, and the desc
 *      and candidates for each
 *      peer still forming (a linked peer's drop out after FRESH_DESC_MS, as the
 *      re-announce does). A receiver takes the hello and only the frames
 *      addressed to it, through the same gates as rules 2 and 5, so a bundle
 *      read twice, or a newer one carrying an unchanged offer, delivers
 *      nothing twice. Tried at 10 links a phone against the real People
 *      chain store: one statement each, links up ~1 s after both
 *      sides published. With `deflateBundles` a bundle that carries more than
 *      a hello goes deflated (a DEFLATED byte, then deflate-raw of the JSON):
 *      the payloads inside are deflated already, but the frames repeat the
 *      same ids and carry their blobs as base64. A receiver reads either.
 *   8. LISTEN TO THE ROSTER (`peers`, #1959). A room topic that every phone
 *      of a game posts under and subscribes to sends every phone every
 *      bundle: n² deliveries from the RPC, and at 300 players 95% of them
 *      were lost and every subscription stalled in a load test.
 *      So a caller that names the room's other members gets a roster wire:
 *      this side's presence (hello, bye, the bundle) goes under its OWN topic
 *      (`from:<id>`), and it subscribes to its members' topics alone, plus
 *      its inbox when directed frames travel on their own (no bundle). A
 *      phone then receives its co-players' bundles and nobody else's, and
 *      the RPC's deliveries grow with the players, not their square. A frame
 *      from outside the roster is dropped. Anyone may put a member's topic on
 *      a statement, so the topic proves nothing: who signed it does
 *      (SIGNERS, below). A member named later (`setPeers`) is subscribed
 *      to as well. The roster only grows while the room is open: a member
 *      with no round left is the mesh's to ignore, and a roster that blinks
 *      empty for a render must not deafen the wire. Without `peers`,
 *      presence stays on the room topic as before.
 *
 * END-TO-END ENCRYPTION (`keys`). Each directed desc/cand payload is deflated
 * and sealed with AES-256-GCM under a pairwise key: P-256 ECDH of this
 * player's registered secret and the peer's ON-CHAIN communication identifier
 * (`Game.CommunicationIdentifiers`), through HKDF as crypto.ts does it, with
 * the label scheme (`labelPrefix`, `jollity:rtc-v5` in the app) as its info,
 * so the pair key is this wire's alone. Both
 * halves are the keys the two players registered for the game, so only those
 * two can open or produce a frame between them: a spoofed `from` cannot. The
 * frame's header (`t|from|to|gen|sid|z`, z the compression flag, 0 when
 * absent) is the AEAD's additional data, so a sealed blob replayed under
 * another generation, peer or session, or with its flag flipped, fails to
 * open. With `keys` set NOTHING directed goes in the clear: a frame waits for
 * the peer's key, and a peer with no identifier on chain (or a player with no
 * secret) gets no frames at all; a plaintext desc/cand that arrives is
 * dropped. Presence (hello, bye: the id, the display name, the view) stays in
 * the clear, since a peer is looked up from it. Without `keys` (standalone)
 * the payloads go in the clear.
 *
 * SIGNERS (`signerOf`, #2014). The node keeps any statement signed by an
 * account with an allowance, whatever topic and `from` it carries, so neither
 * proves who sent it. What does is the proof's signer: in the app a player's
 * transport id IS the account that proves its statements. So with `signerOf`
 * set, a statement (a hello, a bye, a bundle, or a desc or cand on its own)
 * whose signer is missing or is not the account its `from` names is dropped
 * before any frame in it reaches the session gate or a handler: a forged hello
 * can no longer switch a peer to a session that does not exist, nor a forged
 * bye (the sid is in the clear in every hello) end a live one. A bundle's
 * frames must carry the bundle's `from`, so its signer covers all of them.
 * Without `signerOf` (standalone), statements are taken whoever signed
 * them.
 */

/** Which kind of frame a submit event is about. A desc or cand frame is
 *  directed at one peer (`to`); presence (hello, bye) is for the room; a
 *  bundle carries all of them at once (`bundle: true`). */
export type SubmitFrameKind = "desc" | "cand" | "presence" | "bundle"

/**
 * What the submit pipe tells a host app that listens (`onSubmit`), so a slow or
 * failed submit can be told apart from an ICE problem. Never carries the
 * frame's contents: only its kind, the peer it was for, and the numbers.
 *
 *  - `retry`: a submit failed fast and will be tried again after `delayMs`
 *    (the `attempt` that just failed is 1 or 2)
 *  - `failed`: the submit gave up after `attempts` tries; `timedOut` when the
 *    last error was a timeout (a timeout is never retried)
 *  - `slot_wait`: the frame waited `waitedMs` for one of the concurrent
 *    submit slots (the backpressure), reported from 1 s up
 *  - `replaced`: a frame waiting for its channel was replaced by a newer,
 *    different one before it was sent (an unchanged re-announce is not told)
 */
export type SubmitEvent =
  | { kind: "retry"; frame: SubmitFrameKind; to: string | undefined; attempt: number; delayMs: number; reason: string }
  | { kind: "failed"; frame: SubmitFrameKind; to: string | undefined; attempts: number; reason: string; timedOut: boolean }
  | { kind: "slot_wait"; frame: SubmitFrameKind; to: string | undefined; waitedMs: number }
  | { kind: "replaced"; frame: SubmitFrameKind; to: string | undefined }

/** The keys a player registered for the game, as the transport needs them. */
export interface SignallingKeys {
  /** this player's 32-byte P-256 scalar, the secret of the identifier it
   *  registered on chain; null when none can be found */
  secret(): Promise<Uint8Array | null>
  /** a co-player's (the transport's peer id) 65-byte on-chain
   *  CommunicationIdentifier; null when it has none */
  peerIdentifier(peer: string): Promise<Uint8Array | null>
}

export interface StatementTransportOptions {
  /** Where statements go: hosted (`() => getStatementStore()` from
   *  product-sdk-host) or standalone (`nodeStatementStore(rpc, prover)`). */
  resolveStore: ResolveStore
  /** Namespace every channel/topic label is scoped under — a DotNS name in
   *  hosted mode (e.g. `location.host`), any stable string standalone. */
  namespace: string
  /** Label scheme tag. Default "rtc". Earlier Jollity clients used
   *  "jollity:rtc-v2" — pass that for wire-interop with them. */
  labelPrefix?: string
  /** The registered keys every directed frame is sealed with (header, END-TO-END
   *  ENCRYPTION). Set, encryption is required; absent, frames go in the clear. */
  keys?: SignallingKeys
  /** WHO SIGNED IT (header, SIGNERS). The public key (0x… hex) of the account
   *  that signs the statements of the peer with this transport id, or null when
   *  the id names no account. Set, every statement whose signer (the store's
   *  page says it) is missing or is not `signerOf(from)` is dropped before any
   *  frame in it is read. Absent (standalone), statements are taken
   *  whoever signed them. */
  signerOf?: (peer: string) => string | null
  /** Diagnostics sink. Default console.warn. */
  log?: (message: string) => void
  /** Told of each submit that backs off, waits for a slot, or fails (see
   *  `SubmitEvent`). Optional: the engine knows nothing of its listener, and a
   *  listener that throws is ignored. */
  onSubmit?: (event: SubmitEvent) => void
  /** Unix time in MILLISECONDS for the stamps this transport compares with
   *  each other: the peer TTL, the slot wait and the stats. Default
   *  `Date.now`. A phone's wall clock can be stepped mid-game, so the app
   *  passes a step-free one. */
  now?: () => number
  /** The clock a statement's expiry deadline is stamped from (storeClock.ts):
   *  a base clock plus a learned acceptance margin, re-stamped once on a time
   *  rejection. The NODE judges the deadline against its own clock, so the
   *  app passes chain time as the base and ONE clock for the page, so the
   *  margin is learned once a session, not once a room. Default: `now` as the
   *  base. */
  storeClock?: StoreClock
  /** Unix time in MILLISECONDS the page's session id is stamped from, read
   *  once when the first room opens (header, rule 5). Default `Date.now`. The
   *  app passes chain time, so a wall clock stepped back between a boot and
   *  its reload does not make the reload sort older. Only a hint: a wrong one
   *  delays a reload's frames by up to SESSION_SILENT_MS, never locks it out. */
  sessionNow?: () => number
  /** ONE STATEMENT PER PHONE (rule 7). Every frame this side wants live (its
   *  hello, and the desc and candidates for each peer it is negotiating with)
   *  rides one bundle on this phone's own channel under its presence topic
   *  (rule 8), replaced whenever any of them changes. A receiver unpacks the hello and
   *  the frames addressed to it, and runs each through the same session gate,
   *  generation gates and dedup as a frame of its own. Default false: one
   *  statement per frame, as before. */
  bundle?: boolean
  /** DEFLATE THE BUNDLE (rule 7) once it carries more than a hello: its
   *  frames repeat the same ids and carry their sealed blobs as base64, which
   *  deflate wins back (~45% of a bundle for 10 peers). Its data is then the
   *  DEFLATED byte and the deflate-raw of the JSON. A receiver reads either,
   *  whatever this says. Default false. */
  deflateBundles?: boolean
}

/** How long a bundle waits for the other frames of the same moment (a room
 *  that opens offers to every peer at once) before it goes out. */
const BUNDLE_DEBOUNCE_MS = 60
/** the most topics one subscription may match on: the statement store's
 *  `MAX_ANY_TOPICS` (sp-statement-store). A roster wire's filter is its
 *  roster's topics (10 in a game of two 6-player rounds), plus the inbox
 *  when it does not bundle */
const MAX_FILTER_TOPICS = 128
/** The first byte of a statement's data that is a deflated bundle
 *  (`deflateBundles`); a plain frame is JSON, which starts with `{`. */
const DEFLATED = 0x01
/** A bundle this long or longer goes deflated: a hello alone, which is all a
 *  phone sends once its links are up, stays plain and goes out at once. */
const DEFLATE_FROM_BYTES = 1_024
/** the most a deflated bundle may inflate to: anyone may post under a
 *  member's topic. A bundle for 10 peers is ~16 KB */
const MAX_BUNDLE_INFLATED_BYTES = 256 * 1024
/** A roster as the wire keeps it: the other members, once each. */
const rosterOf = (peers: readonly string[], self: string): Set<string> =>
  new Set(peers.filter((pid) => pid && pid !== self))
const HEARTBEAT_MS = 8_000
/** with every link of ours connected the hello goes out this often, not every
 *  HEARTBEAT_MS (header, rule 6). Under the hello's 30 s TTL in the store, so
 *  a reload or a late joiner still finds a live one. */
const STABLE_HELLO_MS = 16_000
/** a desc we sent over the store is re-announced this long even to a linked
 *  peer: an ICE restart that went by the store on a link still connected */
const FRESH_DESC_MS = 30_000
const PEER_TTL_MS = 45_000
/** a peer whose key came back missing is looked up again after this long */
const KEY_RETRY_MS = 10_000
/** this player's own key is asked again every KEY_RETRY_MS while the room is
 *  younger than OWN_KEY_EAGER_MS (a key kept late, storage that was briefly
 *  away at join, must not cost the game's video), and for this many misses;
 *  after both, every OWN_KEY_RETRY_SLOW_MS, since each try re-reads storage
 *  and the chain */
const OWN_KEY_MISSES_BEFORE_BACKOFF = 3
const OWN_KEY_EAGER_MS = 120_000
const OWN_KEY_RETRY_SLOW_MS = 20_000
/** a key lookup (this player's secret, a peer's identifier) that has not
 *  answered by now is given up and asked again later, so a hung read never
 *  holds a link for good */
const KEY_LOOKUP_TIMEOUT_MS = 15_000
/** key lookups an inbound frame may start at once: anyone with a statement
 *  allowance can post to our inbox under any `from`, so this bounds the chain
 *  reads a stranger can cause, and the frames waiting on them. Above the
 *  co-players a phone links to at once (every co-player of every remaining
 *  round, game-session.ts), so a game start's frames are not dropped to wait
 *  for their sender's re-announce */
const MAX_INBOUND_LOOKUPS = 16
/** peers whose key (or miss) is remembered at once, the oldest let go */
const MAX_KNOWN_PEERS = 256
/** the most a sealed payload may inflate to: a co-player holds the key, so
 *  it could otherwise send a small blob that inflates without bound */
const MAX_INFLATED_BYTES = 64 * 1024
const CAND_DEBOUNCE_MS = 700 // coalesce trickle candidates into one overwriting submit
const MAX_CANDS = 40 // bound the per-generation candidate slot
const SLOT_WAIT_REPORT_MS = 1_000 // a wait for a submit slot is only told from here up

const enc = new TextEncoder()
const dec = new TextDecoder()
/** a hex string as one spelling: lower case, 0x-prefixed */
const normalHex = (hex: string): string => {
  const lower = hex.toLowerCase()
  return lower.startsWith("0x") ? lower : `0x${lower}`
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── sessions ────────────────────────────────────────────────────────────────
// A sid is `<session-clock ms>-<random tag>`: the time orders two boots of one
// peer, and the tag breaks a tie. The session clock is `sessionNow` (the app
// passes chain time, which no wall step moves; the default is the wall clock).
// Order is only a HINT, never a lock: a clock can still be wrong (a wall clock
// corrected back an hour between the boot and the reload makes the new boot
// sort older), so the session gate fails open (admitSession).
const SID_RE = /^(\d+)-([0-9a-z]+)$/
const mintSid = (ms: number): string => {
  const tag = (globalThis.crypto?.randomUUID?.() as string | undefined)?.replace(/-/g, "").slice(0, 10) ??
    Math.floor(Math.random() * 2 ** 40).toString(36)
  // a session clock that gives no number falls back to the wall clock: a sid
  // that does not parse would silently turn the gate off for every peer
  return `${Math.max(0, Math.floor(Number.isFinite(ms) ? ms : Date.now()))}-${tag}`
}
/** A peer's current session that has not been heard for this long (its bye
 *  ends it at once) gives way to any other session that is heard: 2.5
 *  heartbeats, so a live boot's beat is never missed, and a session that
 *  keeps beating is never held out for longer than this past the old one's
 *  last frame, whatever the clocks say. A peer whose links are all up beats
 *  only every STABLE_HELLO_MS, so while our link to it is connected its
 *  session is live whatever this says (admitSession). */
const SESSION_SILENT_MS = 20_000
/** superseded sessions kept per peer: a boot never comes back */
const RETIRED_KEPT = 8
/** The frame's sid when it is one we can order; anything else is a frame without a sid. */
const sidOfFrame = (f: { sid?: unknown }): string | null =>
  typeof f.sid === "string" && SID_RE.test(f.sid) ? f.sid : null
/** Is sid `a` from an older boot than sid `b`? */
function olderSid(a: string, b: string): boolean {
  const [, aMs, aTag] = SID_RE.exec(a)!
  const [, bMs, bTag] = SID_RE.exec(b)!
  const am = Number(aMs)
  const bm = Number(bMs)
  return am !== bm ? am < bm : aTag! < bTag!
}
/** The counter of an offer gen minted under the frame's sid, else null. */
function counterOf(f: { gen: string }, sid: string | null): number | null {
  if (!sid || !f.gen.startsWith(`${sid}.`)) return null
  const n = f.gen.slice(sid.length + 1)
  return /^\d+$/.test(n) ? Number(n) : null
}

// ── compression (deflate) — best-effort, degrades to identity ────────────────
const b64 = (b: Uint8Array): string => {
  let s = ""
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!)
  return btoa(s)
}
const unb64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const CS_OK =
  typeof (globalThis as { CompressionStream?: unknown }).CompressionStream !==
  "undefined"
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw")
  const w = cs.writable.getWriter()
  void w.write(data as BufferSource)
  void w.close()
  return new Uint8Array(await new Response(cs.readable).arrayBuffer())
}
async function inflate(data: Uint8Array, limit = MAX_INFLATED_BYTES, what = "sealed payload"): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw")
  const w = ds.writable.getWriter()
  void w.write(data as BufferSource).catch(() => {})
  void w.close().catch(() => {})
  const reader = ds.readable.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      void reader.cancel().catch(() => {})
      throw new Error(`${what} inflates past ${limit} bytes`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

// Wire frames. Directed d/c carry EITHER plaintext (`desc`/`cands`) OR a
// sealed blob (`s`) — sealed once the per-peer key is derived; plaintext is
// the safe fallback before keys exist or if crypto/compression is unavailable.
type Sealed = { iv: string; ct: string; z?: 1 } // z=1 → deflate-compressed plaintext inside
// `sid` rides every frame (header, rule 5); a frame without one is an older
// sender's, taken as before.
type DescFrame = {
  t: "d"
  from: string
  sid?: string
  name: string
  gen: string
  desc?: RTCSessionDescriptionInit
  s?: Sealed
}
type CandFrame = {
  t: "c"
  from: string
  sid?: string
  gen: string
  cands?: RTCIceCandidateInit[]
  s?: Sealed
}
type PresenceFrame =
  | { t: "hello"; from: string; sid?: string; name: string; view?: string }
  | { t: "bye"; from: string; sid?: string }
type Frame = DescFrame | CandFrame | PresenceFrame
/** One phone's live frames in one statement (rule 7): `p` its presence, and
 *  `d:<to>` / `c:<to>` the desc and candidates for each peer it negotiates with. */
type BundleFrame = { t: "b"; from: string; sid?: string; f: Record<string, Frame> }
type WireFrame = Frame | BundleFrame

function zeroStats(kind: string, lastError = ""): SignalStats {
  return {
    kind,
    storeLive: false,
    subActive: false,
    submitsOk: 0,
    submitsFailed: 0,
    framesSent: 0,
    framesRecv: 0,
    lastSubmitOkAt: 0,
    lastInboundAt: 0,
    lastError,
    inflight: 0,
    firstSendAt: 0,
    signTimeouts: 0,
  }
}

const frameKind = (frame: WireFrame): SubmitFrameKind =>
  frame.t === "d" ? "desc" : frame.t === "c" ? "cand" : frame.t === "b" ? "bundle" : "presence"

/** Build a `CreateTransport` bound to a store + namespace. */
export function statementTransport(
  options: StatementTransportOptions,
): CreateTransport {
  const KEYS = options.keys
  const SIGNER_OF = options.signerOf
  const BUNDLE = options.bundle ?? false
  const DEFLATE_BUNDLES = BUNDLE && (options.deflateBundles ?? false) && CS_OK
  const PREFIX = options.labelPrefix ?? "rtc"
  const log = options.log ?? ((m: string) => console.warn(m))
  const now = options.now ?? (() => Date.now())
  const storeClock = options.storeClock ?? createStoreClock({ base: () => ({ ms: now(), kind: "now" }) })
  // ONE session per page boot, shared by every room this factory opens, and
  // one offer counter under it (header, rule 5). Minted when the first room
  // opens, not when the page builds the factory: by then the session clock
  // (chain time in the app) has had its first block.
  const sessionNow = options.sessionNow ?? (() => Date.now())
  let pageSid: string | undefined
  let offers = 0

  return ({ room, id, name, handlers, peers: members }) => {
    const sid = (pageSid ??= mintSid(sessionNow()))
    const label = (s: string) => `${options.namespace}|${PREFIX}:${room}:${s}`
    // WHO WE LISTEN TO (rule 8). A caller that names the room's other members
    // gets a roster wire: this side's presence (its hello, bye and bundle)
    // goes under its OWN topic, and it subscribes to its roster's. Without
    // one, presence goes under the room topic and everyone hears everyone.
    const ROSTER = members !== undefined
    const roster = rosterOf(members ?? [], id)
    const presenceTopic = ROSTER ? label(`from:${id}`) : label("")
    const stats: SignalStats = zeroStats("statement")
    const sealedStats: SealedSignalStats | undefined = KEYS
      ? (stats.sealed = {
          ownKeyMissing: 0,
          ownKeyFound: false,
          peerIdMissing: 0,
          openFailed: 0,
          plaintextDropped: 0,
          droppedAtLookupCap: 0,
          droppedInBackoff: 0,
        })
      : undefined
    if (SIGNER_OF) stats.signerDropped = 0
    // a statement whose signer is not its `from`: said once per `from`
    const firstForeignSigner = onceByKey()
    // The store is ASYNCHRONOUS: hosted resolution answers `null` when the
    // host has no statement store. The factory is synchronous, so the store
    // is awaited behind a gate and every send waits on it — a caller that
    // sends before the store resolves is queued rather than dropped.
    const storeReady: Promise<StatementStoreLike | null> = (async () => {
      try {
        const resolved = await options.resolveStore()
        if (!resolved) throw new Error("no statement store available")
        stats.storeLive = true
        log(`[statement-core] store live (room ${room})`)
        return resolved
      } catch (e) {
        log(`[statement-core] store unavailable: ${errMessage(e)}`)
        stats.storeLive = false
        stats.lastError = "statement store unavailable"
        return null
      }
    })()
    let closed = false

    // ── flow control / backpressure ─────────────────────────────────────────
    // The native apps' session is half-duplex ack-gated. The actual
    // bottleneck here is different: submit paths fail under CONCURRENCY. So
    // instead of an app-level ack, cap how many submits are in flight — the
    // whole mesh's offers/answers/candidate flushes queue through a small
    // semaphore. Order matters only WITHIN a channel, and a channel has at
    // most one submit in flight (rule 4 in the header): `busy` below.
    //
    // The queue holds AT MOST ONE waiting frame per channel (F3,
    // found by a model check): the store keeps only the newest statement per
    // channel anyway, so a newer submit for a channel that is still waiting
    // REPLACES the waiting frame in place (keeping its turn) instead of
    // queuing behind it. Without this the heartbeat's 1 + 2·peers re-submits
    // every 8 s outran a slow or hung signer and the queue grew without
    // bound; a heartbeat re-announce of an unchanged frame is now a no-op.
    const MAX_INFLIGHT = 2
    let inflight = 0
    const waiters: Array<() => void> = []
    async function acquireSlot() {
      while (inflight >= MAX_INFLIGHT)
        await new Promise<void>((r) => waiters.push(r))
      inflight++
      stats.inflight = inflight
    }
    function releaseSlot() {
      inflight = Math.max(0, inflight - 1)
      stats.inflight = inflight
      waiters.shift()?.()
    }

    // ── end-to-end encryption to the peers' on-chain keys (header) ─────────
    // what this side sees of the room (setView), carried by every hello
    let myView = ""
    let mySecret: Promise<Uint8Array | null> | undefined
    let secretMissedAt = -Infinity
    const peerAes = new Map<string, Promise<CryptoKey | null>>() // lookups in flight
    const readyKeys = new Map<string, CryptoKey>() // the pair keys found
    const missedAt = new Map<string, number>() // peer → when its key last came back missing
    const pendingSealedIn = new Map<string, Array<DescFrame | CandFrame>>() // sealed frames waiting for their key or their turn
    const flushing = new Set<string>() // peers whose waiting frames are being opened
    // `d:<to>` / `c:<to>` → the last frame sealed on that channel (its plaintext
    // by digest), re-sent as it is for an unchanged re-announce
    const lastSealed = new Map<string, { key: CryptoKey; gen: string; digest: string; sealed: Sealed }>()
    let inboundLookups = 0
    /** Sets `key` as the newest entry, letting the oldest go past MAX_KNOWN_PEERS:
     *  anyone can post to our inbox under any `from`, so nothing keyed by it grows unbounded. */
    function remember<V>(map: Map<string, V>, key: string, value: V) {
      map.delete(key)
      map.set(key, value)
      if (map.size > MAX_KNOWN_PEERS) map.delete(map.keys().next().value!)
    }
    /** The pair key found for `peer`, made the newest entry: the strangers a
     *  forged `from` makes us look up push out the keys least recently USED,
     *  never a co-player's that is sealing and opening frames */
    function readyKey(peer: string): CryptoKey | undefined {
      const key = readyKeys.get(peer)
      if (key) remember(readyKeys, peer, key)
      return key
    }
    let secretMisses = 0
    let subscribedAt = now() // set again when the room subscribes
    /** This player's registered secret. A miss (none found, a read that failed
     *  or hung) is asked again after KEY_RETRY_MS, not kept for the room; once
     *  the room is past OWN_KEY_EAGER_MS and OWN_KEY_MISSES_BEFORE_BACKOFF
     *  misses, after OWN_KEY_RETRY_SLOW_MS. */
    function secret(): Promise<Uint8Array | null> {
      if (mySecret) return mySecret
      const slow = secretMisses >= OWN_KEY_MISSES_BEFORE_BACKOFF && now() - subscribedAt >= OWN_KEY_EAGER_MS
      if (now() - secretMissedAt < (slow ? OWN_KEY_RETRY_SLOW_MS : KEY_RETRY_MS)) return Promise.resolve(null)
      const lookup = withTimeout(KEYS!.secret(), KEY_LOOKUP_TIMEOUT_MS).catch((e: unknown) => {
        log(`[statement-core] the registered secret could not be read: ${errMessage(e)}`)
        return null
      })
      mySecret = lookup
      void lookup.then((found) => {
        if (found) sealedStats!.ownKeyFound = true
        if (found || mySecret !== lookup) return
        sealedStats!.ownKeyMissing++
        noteCryptoFailure("secret", "no registered secret for this player → no peer gets a frame")
        mySecret = undefined
        secretMissedAt = now()
        secretMisses++
      })
      return lookup
    }
    async function derive(peer: string): Promise<CryptoKey | null> {
      const [mine, theirs] = await Promise.all([
        secret(),
        withTimeout(KEYS!.peerIdentifier(peer), KEY_LOOKUP_TIMEOUT_MS),
      ])
      if (!mine) return null
      if (!theirs) {
        sealedStats!.peerIdMissing++
        noteCryptoFailure(`id:${peer}`, `${peer} has no communication identifier on chain → no frames to it`)
        return null
      }
      return crypto.subtle.importKey(
        "raw",
        // the label as HKDF's info (header): both sides run the same scheme,
        // or they would never meet. The game index is not known here, and the
        // registered keys are per game already
        encryptionKeyBytes(sharedSecret(mine, theirs), enc.encode(PREFIX)) as BufferSource,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      )
    }
    /** The pair key, looked up once per peer when there is something to send
     *  it or a frame from it (never on a hello: the game's room carries every
     *  player's, and only co-players need a key). A miss, or a lookup that
     *  hung past KEY_LOOKUP_TIMEOUT_MS, is asked again after KEY_RETRY_MS, on
     *  the next frame, never in a loop. An inbound frame starts at most
     *  MAX_INBOUND_LOOKUPS at once: those are the reads a stranger can cause. */
    function peerKey(peer: string, inbound = false): Promise<CryptoKey | null> {
      const ready = readyKey(peer)
      if (ready) return Promise.resolve(ready)
      const running = peerAes.get(peer)
      if (running) return running
      if (now() - (missedAt.get(peer) ?? -Infinity) < KEY_RETRY_MS) return Promise.resolve(null)
      if (inbound && inboundLookups >= MAX_INBOUND_LOOKUPS) return Promise.resolve(null)
      if (inbound) inboundLookups++
      const lookup = derive(peer).catch((e: unknown) => {
        noteCryptoFailure(`key:${peer}`, `key for ${peer} failed: ${errMessage(e)}`)
        return null
      })
      peerAes.set(peer, lookup)
      void lookup.then((key) => {
        if (inbound) inboundLookups--
        if (peerAes.get(peer) !== lookup) return // forgotten meanwhile
        peerAes.delete(peer)
        if (!key) {
          remember(missedAt, peer, now())
          pendingSealedIn.delete(peer) // nothing it sent can be opened
          return
        }
        missedAt.delete(peer)
        remember(readyKeys, peer, key)
        void flushSealedIn(peer) // open anything that arrived before the key
      })
      return lookup
    }
    // a wrong key fails every frame of a peer: the first one says it
    const firstCryptoFailure = onceByKey()
    function noteCryptoFailure(key: string, text: string) {
      if (firstCryptoFailure(key)) log(`[statement-core] ${text}`)
    }
    /** The AEAD's additional data: everything outside the seal a receiver acts on. */
    const header = (t: "d" | "c", from: string, to: string, gen: string, frameSid: string, z: 1 | undefined) =>
      enc.encode(`${t}|${from}|${to}|${gen}|${frameSid}|${z ?? 0}`)
    /** Seals for `to`, or null when it has no key or the seal failed: then
     *  nothing is sent, and the heartbeat's re-announce tries again. */
    async function seal(to: string, t: "d" | "c", gen: string, payload: unknown): Promise<Sealed | null> {
      const key = await peerKey(to)
      if (!key) return null
      // a re-announce of an unchanged frame sends the same blob again, not a
      // fresh IV's: its statement's bytes stay the same, so the wait for its
      // channel is not told as `replaced`. Reused only for the exact same
      // plaintext under the same key and header, so no IV meets two plaintexts
      const plain = enc.encode(JSON.stringify(payload))
      const digest = toHex(digestOf(plain))
      const slot = `${t}:${to}`
      const last = lastSealed.get(slot)
      if (last && last.key === key && last.gen === gen && last.digest === digest) return last.sealed
      try {
        const z: 1 | undefined = CS_OK ? 1 : undefined
        const body = CS_OK ? await deflate(plain) : plain
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ct = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: header(t, id, to, gen, sid, z) as BufferSource },
            key,
            body as BufferSource,
          ),
        )
        const sealed: Sealed = { iv: b64(iv), ct: b64(ct), z }
        remember(lastSealed, slot, { key, gen, digest, sealed })
        return sealed
      } catch (e) {
        noteCryptoFailure(`seal:${to}`, `seal to ${to} failed, nothing sent: ${errMessage(e)}`)
        return null
      }
    }
    async function open(f: DescFrame | CandFrame, s: Sealed, key: CryptoKey): Promise<unknown | null> {
      try {
        const raw = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: unb64(s.iv) as BufferSource,
              additionalData: header(f.t, f.from, id, f.gen, f.sid ?? "", s.z) as BufferSource,
            },
            key,
            unb64(s.ct) as BufferSource,
          ),
        )
        const body = s.z ? await inflate(raw) : raw
        return JSON.parse(dec.decode(body))
      } catch (e) {
        sealedStats!.openFailed++
        noteCryptoFailure(`open:${f.from}`, `open from ${f.from} failed: ${errMessage(e)}`)
        return null
      }
    }
    function bufferSealedIn(f: DescFrame | CandFrame) {
      const arr = pendingSealedIn.get(f.from) ?? []
      arr.push(f)
      while (arr.length > 24) arr.shift()
      pendingSealedIn.set(f.from, arr)
    }
    /** Opens a peer's waiting frames in order, and any that queue meanwhile. */
    async function flushSealedIn(from: string) {
      if (flushing.has(from)) return
      flushing.add(from)
      try {
        for (let arr = pendingSealedIn.get(from); arr; arr = pendingSealedIn.get(from)) {
          // the key is held for the batch: an eviction from the bounded cache
          // meanwhile must not drop the frames already taken off the queue
          const key = readyKey(from)
          if (!key) return // forgotten or evicted: the frames wait for a lookup again
          pendingSealedIn.delete(from)
          for (const f of arr) await openDirected(f, key)
        }
      } finally {
        flushing.delete(from)
      }
    }

    // per-peer OUTGOING negotiation state
    type OutPeer = {
      gen: string
      descSent?: RTCSessionDescriptionInit
      /** when descSent was sent (now()); -Infinity before any */
      descAt: number
      cands: RTCIceCandidateInit[]
      timer: ReturnType<typeof setTimeout> | null
    }
    const out = new Map<string, OutPeer>()
    const outPeer = (to: string): OutPeer => {
      let o = out.get(to)
      if (!o) out.set(to, (o = { gen: "", descAt: -Infinity, cands: [], timer: null }))
      return o
    }
    // per-peer INBOUND generation + dedup
    const genOf = new Map<string, string>() // current generation for a peer (offerer minted / answerer adopted)
    const seenDesc = new Map<string, string>() // from → last delivered `${gen}|${sdp}` (dedup)
    // from → the generations of their offers already delivered. The heartbeat
    // re-announces an offer every HEARTBEAT_MS, and our own offer clears
    // seenDesc for that peer: without this the old offer reached the mesh
    // again, took the generation back, and the mesh's answer to it went out
    // under the old gen, overwriting our offer in the store, while the peer's
    // answer to ours then failed the answer gate. An offer is delivered once.
    const offeredGens = new Map<string, string[]>()
    const OFFERED_GENS_KEPT = 16
    // from → identities of the candidates delivered for the current gen. By
    // IDENTITY, not index: a re-answer under the same gen restarts the
    // sender's list at 0, and the MAX_CANDS window slides, so a position in
    // the list says nothing about whether that candidate was delivered.
    const seenCands = new Map<string, Set<string>>()
    const pendingCand = new Map<string, CandFrame>() // from → a cand frame that arrived before its desc (store reorders)
    const lastBeat = new Map<string, number>()
    // the peers our mesh says it is connected to (setLinked), and when our
    // last hello went out: a room whose links are all up needs far less of
    // the store (header, rule 6)
    const linked = new Set<string>()
    let lastHelloAt = -Infinity
    // from → the newest session heard from that peer, and the counter of the
    // last offer adopted from it (header, rule 5). Neither is cleared by a
    // bye or a TTL forget: the old boot's frames outlive its bye in the store,
    // and forgetting either would take them as live again (F1 R3). A new
    // session starts the count over.
    const sidOf = new Map<string, string>()
    const lastOffer = new Map<string, number>()
    // from → when its current session was last heard (-Infinity once it said
    // bye), and the sessions it has left
    const sidHeardAt = new Map<string, number>()
    const retiredSids = new Map<string, string[]>()

    // A leave always reclaims the PRESENCE and key-exchange state. What
    // happens to the NEGOTIATION state (`out` and its debounce timer, genOf,
    // seenDesc, seenCands, pendingCand) depends on how the peer left:
    //   - `bye` is explicit and final (its transport closed): reclaim it all,
    //     so we stop spending statement allowance re-announcing our desc to
    //     a peer that is gone, and no debounce timer fires after departure.
    //   - PEER_TTL_MS of hello silence may be a backgrounded phone that comes
    //     back: KEEP it, because the mesh ignores onPeerLeft and keeps its PC.
    //     Deleting `out` made the answer gate drop every answer to our live
    //     offer and stopped the heartbeat re-announcing it, stranding the
    //     link until the round ended (F4, found by a model check). genOf
    //     also labels our ANSWER (send()), so deleting it sent an answer to
    //     a live offer under a stale gen, and
    //     seenDesc/seenCands keep a re-announced desc the PC already applied
    //     from reaching it again (rule 2 in the header). The cost is a desc
    //     re-announce per heartbeat to a silent peer until the round ends.
    function forgetPeer(pid: string, how: "bye" | "ttl") {
      if (how === "bye") {
        resetNegotiation(pid)
        linked.delete(pid) // its transport closed: the link goes with it
      }
      forgetKeys(pid)
      lastBeat.delete(pid)
    }
    function resetNegotiation(pid: string) {
      const o = out.get(pid)
      if (o?.timer) clearTimeout(o.timer)
      out.delete(pid)
      // its frames leave our bundle with it (rule 7)
      slots.delete(`d:${pid}`)
      slots.delete(`c:${pid}`)
      genOf.delete(pid)
      seenDesc.delete(pid)
      offeredGens.delete(pid)
      seenCands.delete(pid)
      pendingCand.delete(pid)
    }
    function forgetKeys(pid: string) {
      peerAes.delete(pid)
      readyKeys.delete(pid)
      missedAt.delete(pid)
      pendingSealedIn.delete(pid)
      lastSealed.delete(`d:${pid}`)
      lastSealed.delete(`c:${pid}`)
    }

    // The session gate (header, rule 5), run on every frame before anything
    // reads it. False drops the frame.
    //
    // ONLY A HELLO SWITCHES SESSIONS, and only a hello says a session is
    // heard. A desc or cand slot is per pair and lives out its TTL after its
    // boot is gone, so a resubscribe or a paged re-read can hand back a dead
    // boot's d or c at any time within it, and nothing in the frame says it
    // is a re-read. The presence slot is one per account: a new boot's hello
    // overwrites the old boot's hello and bye, so a stale hello cannot outlive
    // the live one. So d, c and bye are taken only from the current session,
    // and the current session's liveness is the time of its last hello (a bye
    // ends it). The cost: a new boot's desc that lands before its first hello
    // is dropped, and waits for the heartbeat's re-announce (8 s at most).
    //
    // A hello from another session: while the current one is LIVE (a hello
    // within SESSION_SILENT_MS, no bye) it switches only if it sorts newer
    // and is not one the peer has left. Once the current one is SILENT, any
    // other session's hello switches, whatever it sorts as. That is the
    // fail-open: sids order by a clock, and a clock can be wrong, so a reload
    // whose sid sorts older (a phone clock corrected back between boot and
    // reload) is held out only until its old boot has been quiet for
    // SESSION_SILENT_MS, never for good. (Dropping the sessions it has left
    // even then would let a stale never-seen hello lock the live one out.)
    //
    // A NEW session starts the peer over: our negotiation with its old boot
    // is dead (its answer to our old offer, read off the store by the new
    // boot, must not reach a PC that will be rebuilt), its keys went with
    // it, and the mesh is told before any of the new session's frames is
    // delivered, so they land on the rebuilt connection. The first sid heard
    // from a peer is no change: nothing was negotiated with an earlier one.
    // Taken from a d or c, it is not yet heard (silent), so the peer's first
    // hello, from whatever boot, takes over at once.
    function admitSession(f: Frame): boolean {
      const theirs = sidOfFrame(f)
      if (!theirs) return true // a frame without a sid: as before
      const current = sidOf.get(f.from)
      const at = now()
      const heard = () => {
        if (f.t === "hello") sidHeardAt.set(f.from, at)
        else if (f.t === "bye") sidHeardAt.set(f.from, -Infinity)
      }
      if (current === theirs) {
        heard()
        return true
      }
      if (current) {
        if (f.t !== "hello") return false
        // a connected link is the current session beating, however slowly it says hello
        const silent = !linked.has(f.from) && at - (sidHeardAt.get(f.from) ?? -Infinity) > SESSION_SILENT_MS
        const left = retiredSids.get(f.from)?.includes(theirs) ?? false
        if (!silent && (left || olderSid(theirs, current))) return false
      }
      sidOf.set(f.from, theirs)
      sidHeardAt.set(f.from, -Infinity)
      heard()
      if (!current) return true
      const retired = (retiredSids.get(f.from) ?? []).filter((s) => s !== theirs)
      retired.push(current)
      if (retired.length > RETIRED_KEPT) retired.shift()
      retiredSids.set(f.from, retired)
      resetNegotiation(f.from)
      linked.delete(f.from) // the link was to the old boot; the mesh rebuilds it
      lastOffer.delete(f.from) // a bye keeps it: only a new session starts the count over
      forgetKeys(f.from)
      handlers.onPeerSession?.(f.from, theirs)
      return true
    }

    // Deliver the not-yet-seen candidates from a (gen-matched) cand frame.
    function deliverCands(from: string, f: CandFrame) {
      let seen = seenCands.get(from)
      if (!seen) seenCands.set(from, (seen = new Set()))
      for (const cand of f.cands ?? []) {
        const key = `${cand.usernameFragment ?? ""}|${cand.candidate ?? ""}`
        if (seen.has(key)) continue
        seen.add(key)
        handlers.onSignal(from, { rtc: { cand } } satisfies RtcPayload)
      }
    }

    // channel label → the frame waiting to go out on that channel. A
    // replacement swaps the frame and keeps its turn. `busy` holds the
    // channels with a submit running (from its turn at the semaphore to its
    // last retry); a frame queued for a busy channel is started by that
    // submit when it finishes, so one channel never has two in flight.
    type Job = { topicLabels: string[]; data: string; frame: SubmitFrameKind; to: string | undefined }
    const queued = new Map<string, Job>()
    const busy = new Set<string>()
    const tell = (event: SubmitEvent) => {
      try {
        options.onSubmit?.(event)
      } catch {
        /* a listener never breaks signalling */
      }
    }
    // the ONE place a submit is given up on: counted, remembered and told
    const failed = ({ frame, to }: Pick<Job, "frame" | "to">, attempts: number, reason: string) => {
      stats.submitsFailed++
      stats.lastError = reason
      tell({ kind: "failed", frame, to, attempts, reason, timedOut: /timeout/i.test(reason) })
    }

    // Sign ONCE (fixed expiry = LWW priority), then retry only proof+submit on
    // fast errors, never on `timeout`; bail once closed. The expiry is minted
    // once a slot is held, not when the frame is queued: its TTL deadline
    // counts from the sign, so a frame that waited is not already expired
    // when it goes out (F3).
    //
    // A TIME rejection (the node's `alreadyExpired`) is not a fast error: the
    // same wire would fail the same way. The statement is re-stamped ONCE from
    // the store clock's retry stamp, re-signed (the expiry is signed material)
    // and resubmitted; the clock learns the margin the store accepted. Both
    // stamps rejected is one failure, never a loop.
    //
    // A `channelPriorityTooLow` on our OWN channel (every channel this
    // transport writes is ours) means a statement this page never sent holds
    // it with a higher expiry: one from before a reload. Our own frames cannot
    // race on a channel (rule 4), so re-stamp ONCE above the one it names.
    // A retry gives way to a newer frame waiting for its channel: the newer
    // one replaces this one, so it goes now instead of behind this one's
    // remaining tries. Counted as a coalesced frame is: the pair is one entry
    // in `framesSent`. A final failure is still a failure.
    const replacedBeforeRetry = (channelLabel: string): boolean => {
      if (!queued.has(channelLabel)) return false
      stats.framesSent--
      return true
    }
    function startChannel(channelLabel: string, frame: SubmitFrameKind, to: string | undefined) {
      busy.add(channelLabel)
      void signAndSubmit(channelLabel)
        .catch((e) => failed({ frame, to }, 0, errMessage(e)))
        .finally(() => {
          busy.delete(channelLabel)
          // the frame that waited for this channel goes now
          const next = queued.get(channelLabel)
          if (next && !busy.has(channelLabel)) startChannel(channelLabel, next.frame, next.to)
        })
    }
    async function signAndSubmit(channelLabel: string): Promise<void> {
      const live = await storeReady
      if (!live) {
        queued.delete(channelLabel)
        return
      }
      const waitStart = now()
      await acquireSlot() // backpressure: cap concurrent submits
      try {
        const job = queued.get(channelLabel)
        queued.delete(channelLabel)
        if (!job) return
        const waitedMs = now() - waitStart
        if (waitedMs >= SLOT_WAIT_REPORT_MS) tell({ kind: "slot_wait", frame: job.frame, to: job.to, waitedMs })
        const channel = toHex(await sha256(channelLabel))
        const topics = await Promise.all(
          job.topicLabels.map(async (t) => toHex(await sha256(t))),
        )
        let stamp: StoreStamp = storeClock.stamp()
        let wire = { expiry: nextSlotExpiry(stamp.ms), channel, topics, data: job.data }
        let fastRetries = 0
        let lifted = false
        for (let tries = 1; ; tries++) {
          try {
            const proof = await withTimeout(
              live.createProofAuthorized(wire),
              SIGN_TIMEOUT_MS,
            ).catch((e) => {
              // A hung sign is the failure mode that produces ZERO ok / ZERO
              // failed: the proof never returns, holds a slot forever, and
              // every later frame queues behind acquireSlot(). Tag it
              // distinctly via the shared classifier.
              const err = classifySignError(e)
              if (err.message.startsWith(SIGN_TIMEOUT_PREFIX))
                stats.signTimeouts++
              throw err
            })
            await withTimeout(live.submit({ ...wire, proof }), SUBMIT_TIMEOUT_MS)
            stats.submitsOk++
            stats.lastSubmitOkAt = now()
            storeClock.accepted(stamp)
            return
          } catch (e) {
            const msg = errMessage(e)
            const late = isTimeRejection(e)
            if (late && !stamp.retry && !closed) {
              if (replacedBeforeRetry(channelLabel)) return
              stamp = storeClock.retryStamp(stamp)
              wire = { ...wire, expiry: nextSlotExpiry(stamp.ms) }
              tell({ kind: "retry", frame: job.frame, to: job.to, attempt: tries, delayMs: 0, reason: msg })
              continue
            }
            const held = late ? null : channelPriorityFloor(e)
            if (held !== null && !lifted && !closed) {
              if (replacedBeforeRetry(channelLabel)) return
              lifted = true
              raiseSlotExpiryFloor(held)
              wire = { ...wire, expiry: nextSlotExpiry(stamp.ms) }
              tell({ kind: "retry", frame: job.frame, to: job.to, attempt: tries, delayMs: 0, reason: msg })
              continue
            }
            if (late && stamp.retry) storeClock.rejected(stamp, msg)
            else if (!late && fastRetries < 2 && !closed && !/timeout/i.test(msg)) {
              if (replacedBeforeRetry(channelLabel)) return
              fastRetries++
              const delayMs = 400 * fastRetries
              tell({ kind: "retry", frame: job.frame, to: job.to, attempt: tries, delayMs, reason: msg })
              await sleep(delayMs)
              if (replacedBeforeRetry(channelLabel)) return // replaced while it waited
              continue
            }
            failed(job, tries, msg)
            log(
              late
                ? `[statement-core] submit failed (${msg}) — rejected for time on both stamps`
                : `[statement-core] submit failed (${msg}) — allowance provisioned?`,
            )
            return
          }
        }
      } finally {
        releaseSlot()
      }
    }
    // Queue a frame for its channel. The data is serialized NOW; only the
    // expiry waits for the slot. `framesSent` counts queue entries, so a frame that replaced a
    // waiting one for its channel is not counted twice. A frame for a busy
    // channel waits for that channel's submit to finish (rule 4).
    //
    // Once closed only the bye goes out: a frame issued after close() (a
    // late send(), or a seal that finished after it) is refused here, and
    // close() drops the frames already waiting.
    const submit = (channelLabel: string, topicLabels: string[], frame: Frame, to?: string) => {
      if (closed && frame.t !== "bye") return
      if (BUNDLE) return holdInBundle(frame, to)
      submitWire(channelLabel, topicLabels, frame, to)
    }

    // ── one statement per phone (rule 7) ─────────────────────────────────────
    // slot → the frame this side wants live: "p" its presence, "d:<to>" and
    // "c:<to>" its desc and candidates for a peer. The bundle is rebuilt from
    // these on every flush, so a frame replaced here is replaced on the wire.
    const slots = new Map<string, Frame>()
    let bundleTimer: ReturnType<typeof setTimeout> | null = null
    const bundleChannel = () => label(`bundle:${id}`)
    function holdInBundle(frame: Frame, to?: string) {
      const slot = frame.t === "d" ? `d:${to}` : frame.t === "c" ? `c:${to}` : "p"
      slots.set(slot, frame)
      if (frame.t === "bye") {
        // the leave goes at once, alone: the frames for peers die with the room
        if (bundleTimer) clearTimeout(bundleTimer)
        bundleTimer = null
        submitWire(bundleChannel(), [presenceTopic], { t: "b", from: id, sid, f: { p: frame } })
        return
      }
      if (!bundleTimer) bundleTimer = setTimeout(flushBundle, BUNDLE_DEBOUNCE_MS)
    }
    function flushBundle() {
      bundleTimer = null
      if (closed) return
      const at = now()
      const f: Record<string, Frame> = {
        // always present, so a bundle is a hello whatever else it carries
        p: slots.get("p") ?? { t: "hello", from: id, sid, name, view: myView || undefined },
      }
      for (const [slot, frame] of slots) {
        if (slot === "p") continue
        const to = slot.slice(2)
        const o = out.get(to)
        // a peer we no longer negotiate with, or a linked one past a fresh
        // desc, needs nothing more from the store (rule 6)
        if (!o || (linked.has(to) && at - o.descAt > FRESH_DESC_MS)) continue
        f[slot] = frame
      }
      sendBundle({ t: "b", from: id, sid, f })
    }
    // A DEFLATED BUNDLE (`deflateBundles`) takes a moment to compress, and an
    // older bundle must never reach the channel after a newer one, so with it
    // on every bundle goes through one chain, in the order it was built. The
    // bye skips it (holdInBundle): it goes at once, and once closed nothing
    // the chain still holds goes out (submitWire).
    let bundlesOut: Promise<void> = Promise.resolve()
    function sendBundle(frame: BundleFrame) {
      if (!DEFLATE_BUNDLES) return submitWire(bundleChannel(), [presenceTopic], frame)
      const json = enc.encode(JSON.stringify(frame))
      bundlesOut = bundlesOut.then(async () => {
        let data = json
        if (json.length >= DEFLATE_FROM_BYTES) {
          try {
            const body = await deflate(json)
            data = new Uint8Array(body.length + 1)
            data[0] = DEFLATED
            data.set(body, 1)
          } catch {
            data = json // a receiver reads plain JSON as well
          }
        }
        submitWire(bundleChannel(), [presenceTopic], frame, undefined, toHex(data))
      })
      // one bundle that failed must not stop the ones after it
      bundlesOut = bundlesOut.catch((e) => log(`[statement-core] bundle not sent: ${errMessage(e)}`))
    }

    const submitWire = (channelLabel: string, topicLabels: string[], frame: WireFrame, to?: string, encoded?: string) => {
      if (closed && frame.t !== "bye" && !(frame.t === "b" && frame.f.p?.t === "bye")) return
      if (stats.firstSendAt === 0) stats.firstSendAt = now()
      const data = encoded ?? toHex(enc.encode(JSON.stringify(frame)))
      const waiting = queued.get(channelLabel)
      queued.set(channelLabel, { topicLabels, data, frame: frameKind(frame), to })
      // coalesced: the waiting entry now carries this frame (the hello -> bye
      // swap at close is not an in-game replacement, so it is not told)
      if (waiting && waiting.data !== data && !closed) tell({ kind: "replaced", frame: waiting.frame, to: waiting.to })
      if (!waiting) stats.framesSent++
      // A busy channel's frame waits for it (rule 4), except once closed: the
      // bye must not wait behind an in-flight hello, since on unload the JS
      // often dies first and peers would wait out the TTL. Its own submit
      // dequeues it; the lift is off once closed, so the hello cannot be put
      // back over it.
      if (!busy.has(channelLabel) || closed) startChannel(channelLabel, frameKind(frame), to)
    }

    // A directed frame is sealed BEFORE it is queued, and with `keys` set
    // two seals for one channel finish in either order. The queue keeps the
    // frame that reaches it last, so without a ticket a heartbeat re-announce
    // of the old offer could land over a rebuild's new one, or a shorter
    // candidate list over the cumulative one. Each frame takes a ticket for
    // its channel when it is ISSUED, before the seal, and goes to the queue
    // only if no newer frame was issued for that channel meanwhile (that one
    // is on its way). Without `keys` nothing is sealed and frames resolve in
    // issue order, so no frame is ever dropped here.
    const issued = new Map<string, number>()
    let tickets = 0
    const takeTicket = (channelLabel: string): number => {
      issued.set(channelLabel, ++tickets)
      return tickets
    }
    const superseded = (channelLabel: string, ticket: number) => issued.get(channelLabel) !== ticket

    // Submit one desc statement: sealed with `keys` (none at all while the peer
    // has no key; the heartbeat's re-announce tries again), else in the clear.
    async function submitDesc(
      to: string,
      gen: string,
      desc: RTCSessionDescriptionInit,
    ) {
      const channelLabel = label(`${id}->${to}:d`)
      const ticket = takeTicket(channelLabel)
      const s = KEYS ? await seal(to, "d", gen, { desc }) : null
      if (superseded(channelLabel, ticket) || (KEYS && !s)) return
      const frame: DescFrame = s
        ? { t: "d", from: id, sid, name, gen, s }
        : { t: "d", from: id, sid, name, gen, desc }
      submit(channelLabel, [label(`inbox:${to}`)], frame, to)
    }
    async function flushCands(to: string) {
      const o = out.get(to)
      if (closed || !o || !o.gen || o.cands.length === 0) return
      // Overwrite the pair's single candidate slot with the cumulative
      // (bounded) list for this generation — NOT a fresh statement per
      // candidate. Sealed as submitDesc's is.
      //
      // The generation and the list are read BEFORE the seal's await: a new
      // offer sent while the seal runs mints a new gen and empties the list,
      // and the old candidates must never go out under the new gen's label.
      // Nor under the old one: once the new offer is out they are dead, and
      // would only overwrite the cand slot and the receiver's pending buffer.
      // So a flush whose generation moved (or whose peer left) is dropped.
      const gen = o.gen
      const cands = o.cands.slice()
      const channelLabel = label(`${id}->${to}:c`)
      const ticket = takeTicket(channelLabel)
      const s = KEYS ? await seal(to, "c", gen, { cands }) : null
      if ((KEYS && !s) || superseded(channelLabel, ticket) || out.get(to) !== o || o.gen !== gen) return
      const frame: CandFrame = s
        ? { t: "c", from: id, sid, gen, s }
        : { t: "c", from: id, sid, gen, cands }
      submit(channelLabel, [label(`inbox:${to}`)], frame, to)
    }

    async function onStatement(st: { data?: string; signer?: string }): Promise<void> {
      if (!st.data) return
      let w: WireFrame
      try {
        let bytes = fromHex(st.data)
        // a deflated bundle (`deflateBundles`): read whatever the sender chose
        if (bytes[0] === DEFLATED) bytes = await inflate(bytes.subarray(1), MAX_BUNDLE_INFLATED_BYTES, "deflated bundle")
        w = JSON.parse(dec.decode(bytes)) as WireFrame
      } catch {
        return
      }
      const from = (w as { from?: unknown }).from
      if (from === id) return
      // a roster wire takes its roster's frames alone (rule 8): anyone can put
      // a co-player's topic on a statement, so the topic proves nothing
      if (ROSTER && (typeof from !== "string" || !roster.has(from))) return
      // nor does `from`: only the account that signed the statement may speak
      // for it (header, SIGNERS). A bundle is one statement, so its own `from`
      // covers every frame in it (each must carry the same `from`, below)
      if (SIGNER_OF && !signedBy(st.signer, from)) {
        stats.signerDropped!++
        if (firstForeignSigner(String(from)))
          log(`[statement-core] dropped a statement for ${String(from)} that its account did not sign (signer ${st.signer ? "other" : "missing"})`)
        return
      }
      stats.framesRecv++
      stats.lastInboundAt = now()
      if (w.t !== "b") return onFrame(w)
      // A bundle (rule 7): its presence first, so a new session is switched to
      // before its frames are read; then only what is addressed to us, desc
      // before candidates. Each goes through the gates as a frame of its own.
      const frames = w.f && typeof w.f === "object" ? w.f : {}
      for (const slot of ["p", `d:${id}`, `c:${id}`]) {
        const f = frames[slot]
        if (f && typeof f === "object" && f.from === w.from) await onFrame(f)
      }
    }

    /** Is `signer` the account `from` names (hex compared without case)? */
    function signedBy(signer: string | undefined, from: unknown): boolean {
      if (typeof signer !== "string" || typeof from !== "string") return false
      const expected = SIGNER_OF!(from)
      return !!expected && normalHex(signer) === normalHex(expected)
    }

    async function onFrame(f: Frame): Promise<void> {
      if (!admitSession(f)) return

      if (f.t === "hello") {
        handlers.onPeerJoined(f.from, f.name, true)
        if (typeof f.view === "string") handlers.onView?.(f.from, f.view)
        lastBeat.set(f.from, now())
        return
      }
      if (f.t === "bye") {
        forgetPeer(f.from, "bye")
        handlers.onPeerLeft(f.from)
        return
      }
      lastBeat.set(f.from, now())
      await handleDirected(f)
    }

    // Resolve a directed d/c frame to PLAINTEXT: with `keys`, open the sealed
    // blob and drop one sent in the clear; without, take it as it came. Then
    // run the gated delivery. A peer's frames are opened in the order they
    // were read: while its key is looked up, or its earlier frames are still
    // being drained, a new one queues behind them. A lookup is never waited
    // on here: a page's statements are read one after another, and one peer's
    // chain read must not hold every other peer's frames.
    async function handleDirected(raw: DescFrame | CandFrame) {
      if (!KEYS) return dispatchDirected(raw)
      if (!raw.s) {
        sealedStats!.plaintextDropped++ // in the clear: never taken with keys
        return
      }
      if (!readyKeys.has(raw.from)) {
        void peerKey(raw.from, true)
        // no lookup running (a recent miss, or too many at once): dropped, the
        // sender's re-announce brings it again
        if (peerAes.has(raw.from)) bufferSealedIn(raw)
        else if (now() - (missedAt.get(raw.from) ?? -Infinity) < KEY_RETRY_MS) sealedStats!.droppedInBackoff++
        else sealedStats!.droppedAtLookupCap++
        return
      }
      // pages are read concurrently, so even a peer whose key is known goes
      // through its queue: one drain at a time opens its frames in order
      bufferSealedIn(raw)
      await flushSealedIn(raw.from)
    }
    async function openDirected(raw: DescFrame | CandFrame, key: CryptoKey) {
      if (!raw.s) return
      const p = await open(raw, raw.s, key)
      if (!p) return // decrypt failed → drop; a re-announce / fresh gen re-delivers
      dispatchDirected(
        raw.t === "d"
          ? {
              t: "d",
              from: raw.from,
              sid: raw.sid,
              name: raw.name,
              gen: raw.gen,
              desc: (p as { desc?: RTCSessionDescriptionInit }).desc,
            }
          : {
              t: "c",
              from: raw.from,
              sid: raw.sid,
              gen: raw.gen,
              cands: (p as { cands?: RTCIceCandidateInit[] }).cands,
            },
      )
    }

    // Generation-gated delivery of a PLAINTEXT directed frame.
    function dispatchDirected(f: DescFrame | CandFrame) {
      // a sealed frame waited for its key or its open(): its peer may have
      // moved to a newer session meanwhile
      const theirs = sidOfFrame(f)
      if (theirs && sidOf.get(f.from) !== theirs) return
      if (f.t === "d") {
        const desc = f.desc
        if (!desc) return
        // OFFER from a session we can order: one whose counter is below the
        // last adopted is older than the offer the mesh already has (F1 R1/R2),
        // and the last adopted one itself is taken again only while it is
        // still the current generation (a heartbeat re-announce). The count
        // outlives a bye, so the old boot's last offer re-read after its bye
        // is not new again (F1 R3), where offeredGens went with the bye.
        const n = desc.type === "offer" ? counterOf(f, theirs) : null
        const last = lastOffer.get(f.from) ?? 0
        if (n !== null && (n < last || (n === last && genOf.get(f.from) !== f.gen))) return
        // ANSWER: generation gate — accept only the answer for OUR current
        // outgoing offer.
        if (desc.type === "answer" && f.gen !== out.get(f.from)?.gen) return // stale/superseded → drop
        // OFFER: one delivery per generation (offeredGens, above)
        const offered = offeredGens.get(f.from) ?? []
        if (desc.type === "offer" && offered.includes(f.gen) && genOf.get(f.from) !== f.gen) return
        // Adopt the generation. Reset candidate delivery ONLY on a real gen
        // change (the offerer pre-sets genOf at send() time, so its answer
        // shares that gen and its candidates were already recorded; a paged
        // re-read of the same offer must not reset either).
        const genChanged = genOf.get(f.from) !== f.gen
        genOf.set(f.from, f.gen)
        if (n !== null) lastOffer.set(f.from, n)
        if (genChanged) {
          seenCands.delete(f.from)
          if (pendingCand.get(f.from)?.gen !== f.gen)
            pendingCand.delete(f.from) // drop a stale prior-gen buffer
        }
        const dkey = `${f.gen}|${desc.sdp ?? ""}`
        if (seenDesc.get(f.from) !== dkey) {
          seenDesc.set(f.from, dkey)
          if (desc.type === "offer" && !offered.includes(f.gen)) {
            offered.push(f.gen)
            if (offered.length > OFFERED_GENS_KEPT) offered.shift()
            offeredGens.set(f.from, offered)
          }
          // an offer goes with its gen, which the mesh echoes on its answer (F7)
          const rtc: RtcPayload["rtc"] = desc.type === "offer" ? { desc, gen: f.gen } : { desc }
          handlers.onSignal(f.from, { rtc } satisfies RtcPayload)
        }
        // release any candidates that arrived before this generation's desc
        // (the store may reorder)
        const pc = pendingCand.get(f.from)
        if (pc && pc.gen === f.gen) {
          pendingCand.delete(f.from)
          deliverCands(f.from, pc)
        }
        return
      }
      // t === "c"
      if (f.gen !== genOf.get(f.from)) {
        pendingCand.set(f.from, f) // cand ahead of its desc → hold until the desc establishes the gen
        return
      }
      deliverCands(f.from, f)
    }

    // What this side subscribes to. A roster wire (rule 8): its roster's own
    // topics, plus the inbox while directed frames still travel alone (no
    // bundle). Otherwise: the inbox (directed) and the room topic (presence).
    let sub: { unsubscribe?: () => void } | null = null
    let subscriptions = 0 // of two subscribes racing, the newer wins
    async function subscribe(live: StatementStoreLike): Promise<void> {
      const mine = ++subscriptions
      const labels = [
        ...(ROSTER && BUNDLE ? [] : [label(`inbox:${id}`)]),
        ...(ROSTER ? [...roster].sort().map((pid) => label(`from:${pid}`)) : [label("")]),
      ]
      if (labels.length > MAX_FILTER_TOPICS)
        log(`[statement-core] ${labels.length} topics is past the store's filter: listening to the first ${MAX_FILTER_TOPICS}`)
      const matchAny = await Promise.all(labels.slice(0, MAX_FILTER_TOPICS).map(async (l) => toHex(await sha256(l))))
      if (mine !== subscriptions || closed) return
      const previous = sub
      sub = null
      // nobody to hear: no filter is sent, since a store may read an empty one as "everything"
      if (matchAny.length > 0) {
        // process a page's statements sequentially (onStatement is async: it
        // may open sealed frames) so gen-gating/dedup see a stable order.
        sub = live.subscribe({ matchAny }, (page) => {
          void (async () => {
            for (const st of page.statements) await onStatement(st)
          })()
        })
      }
      // the old subscription goes only once the new one is up, so a roster
      // that grows misses nothing in between (what both deliver is deduped)
      try {
        previous?.unsubscribe?.()
      } catch {
        /* ignore */
      }
    }
    void (async () => {
      const live = await storeReady
      if (!live) return
      await subscribe(live)
      if (closed) return
      stats.subActive = true
      log(`[statement-core] subscribed (${ROSTER ? `roster of ${roster.size}${BUNDLE ? "" : " + inbox"}` : "inbox + room presence"})`)
      // this player's own secret is looked up now, not on the first send, so
      // the first offer waits only for the peer's identifier (a peer is
      // still looked up only when there is something to send it or open)
      // a (re)subscribed room starts the own key's retries eager again
      subscribedAt = now()
      secretMisses = 0
      secretMissedAt = -Infinity
      if (KEYS) void secret()
      for (const pid of room.split(","))
        if (pid && pid !== id) handlers.onPeerJoined(pid, pid)
      handlers.onOpen?.()
      void heartbeat()
    })()

    async function heartbeat(): Promise<void> {
      while (!closed) {
        const beatAt = now()
        // EVERY LINK UP: the hello slows to STABLE_HELLO_MS. Every beat while
        // any link of ours is forming or down, and before we know of anyone.
        const peers = new Set([...lastBeat.keys(), ...out.keys()])
        const stable = peers.size > 0 && [...peers].every((pid) => linked.has(pid))
        if (!stable || beatAt - lastHelloAt >= STABLE_HELLO_MS - HEARTBEAT_MS / 2) {
          lastHelloAt = beatAt
          submit(label(`presence:${id}`), [presenceTopic], {
            t: "hello",
            from: id,
            sid,
            name,
            view: myView || undefined,
          })
        }
        // Re-announce the current description to each peer: the desc is
        // submitted ONCE per generation, so a dropped/timed-out submit would
        // otherwise strand the generation until the mesh rebuilds it (~18s);
        // and the slot expires at TTL_S=30s. Re-sending keeps it alive +
        // self-heals within a heartbeat. Idempotent on the receiver (deduped
        // by `gen|sdp`), so no re-negotiation churn.
        for (const [to, o] of out) {
          // A LINKED PEER HAS BOTH DESCRIPTIONS: a link connects on nothing
          // less, and renegotiates over itself. Re-announcing to it is
          // statements for nothing, except a desc sent over the store just now
          // (FRESH_DESC_MS): an ICE restart on a link still connected.
          if (linked.has(to) && beatAt - o.descAt > FRESH_DESC_MS) continue
          if (o.descSent && o.gen) void submitDesc(to, o.gen, o.descSent)
          if (o.gen && o.cands.length > 0) void flushCands(to) // self-heal a lost/TTL-expired cand slot too
        }
        const at = now()
        for (const [pid, ts] of lastBeat) {
          if (linked.has(pid)) continue // a connected link is proof enough the peer is here
          if (at - ts > PEER_TTL_MS) {
            forgetPeer(pid, "ttl")
            handlers.onPeerLeft(pid)
          }
        }
        await sleep(HEARTBEAT_MS)
      }
    }

    return {
      send(to, data) {
        if (!data || typeof data !== "object" || !("rtc" in data)) return
        const payload = (data as RtcPayload).rtc
        const o = outPeer(to)
        if (payload.desc) {
          // A new LOCAL description = a new generation. Offer → mint the gen
          // (native's offerId); answer → echo the gen of the offer we're
          // answering: the one the mesh hands back with it (F7). `genOf` is
          // only the fallback for a payload without one: it holds the
          // generation NOW, and a newer offer may have moved it while the
          // mesh was answering the older one.
          if (payload.desc.type === "offer") {
            o.gen = `${sid}.${++offers}`
            genOf.set(to, o.gen)
            // New outgoing generation: reset THIS peer's receive-side
            // delivery state too, so a reordered new-gen candidate frame
            // (arriving before the peer's answer, which shares this gen) is
            // delivered in full instead of being deduped against the old
            // gen's candidates.
            seenCands.delete(to)
            seenDesc.delete(to)
            pendingCand.delete(to)
          } else {
            // an answer to an offer older than the last one adopted from that
            // boot is dead (the peer's gate drops it): sending it would only
            // overwrite the live answer in the queue, the store's slot and
            // the heartbeat's re-announce, and leave the link dark
            const n = payload.gen ? counterOf({ gen: payload.gen }, sidOf.get(to) ?? null) : null
            if (n !== null && n < (lastOffer.get(to) ?? 0)) return
            o.gen = payload.gen ?? genOf.get(to) ?? o.gen
          }
          o.descSent = payload.desc
          o.descAt = now()
          o.cands = []
          if (o.timer) {
            clearTimeout(o.timer)
            o.timer = null
          } // any straggler timer belongs to the old gen
          // ONE desc statement per generation, DIRECTED only (inbox:to) — the
          // desc already carries the non-trickle gathered candidates, and
          // fanning it to the whole room is exactly the volume this design
          // cuts.
          void submitDesc(to, o.gen, payload.desc)
        }
        if (payload.cand) {
          // KNOWN (deferred): during an ICE-restart/rebuild the mesh gathers
          // for ~3s before it sends the new offer, so `o.gen` is still the
          // PREVIOUS generation while these renegotiation candidates arrive →
          // they flush under the stale gen and the peer rejects them (ufrag
          // mismatch, caught) until the new offer lands. Self-corrects, no
          // candidate loss (they're in the fresh non-trickle SDP). A clean
          // fix needs a mesh→transport `beginNegotiation(to)` hook.
          if (!o.gen) return // candidates before any desc (in-gather; already embedded in the SDP) — drop
          o.cands.push(payload.cand)
          if (o.cands.length > MAX_CANDS)
            o.cands.splice(0, o.cands.length - MAX_CANDS)
          if (!o.timer)
            o.timer = setTimeout(() => {
              o.timer = null
              void flushCands(to)
            }, CAND_DEBOUNCE_MS)
        }
      },
      close() {
        closed = true
        for (const o of out.values()) if (o.timer) clearTimeout(o.timer)
        // Frames still waiting for their channel would go out after the
        // leave: drop them (a submit already in flight cannot be recalled).
        // The presence channel's waiting hello is replaced by the bye below.
        const presence = label(`presence:${id}`)
        for (const channelLabel of [...queued.keys()]) {
          if (channelLabel === presence) continue
          queued.delete(channelLabel)
          stats.framesSent--
        }
        submit(presence, [presenceTopic], { t: "bye", from: id, sid })
        try {
          sub?.unsubscribe?.()
        } catch {
          /* ignore */
        }
      },
      stats: () => ({ ...stats }),
      setView(view: string) {
        myView = view
      },
      setPeers(next: string[]) {
        if (!ROSTER || closed) return
        // grows only (rule 8): a member gone needs nothing, a new one is
        // subscribed to (the newer subscribe wins one racing it)
        const added = [...rosterOf(next, id)].filter((pid) => !roster.has(pid))
        if (added.length === 0) return
        for (const pid of added) roster.add(pid)
        void storeReady.then((live) => (live && !closed ? subscribe(live) : undefined))
      },
      setLinked(peerId: string, isLinked: boolean) {
        if (isLinked) linked.add(peerId)
        else linked.delete(peerId)
      },
    }
  }
}
