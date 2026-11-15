// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The one doorway of the worker to the host, and the only module here that
 * value-imports `@parity/product-sdk-host`.
 *
 * It keeps the discipline of lib/engine.ts in the app (Architecture rule 1 of
 * apps/jollity-app/AGENTS.md).
 * Everything else in the worker takes a `WorkerHost` and never imports the SDK,
 * so a test can drive the worker with a fake one.
 *
 * Chat goes through `getChatManager()`, which speaks truapi alone and resolves
 * null without a truapi host. Cards render through its
 * `onCustomMessageRenderingRequest`, which also delivers each button press to
 * the card it came from.
 *
 * The footer of the room is truapi only too, and its Card is newer than the
 * `@parity/truapi` this worker runs on. Its client is typed by its shape, so a
 * client without the method or without the Card answers "unsupported" until
 * product-sdk-host carries the release that has it. A docked card reaches the
 * worker through the renderer of truapi, since the chat manager only routes
 * the cards of messages.
 *
 * The accounts give the sign-up of the chat what they give the app, from
 * lib/game-source.ts and lib/host: the signer of the product account, its
 * draw tickets, and the lite key of the person with the proof it mints.
 *
 * The TURN pass is the one the app fetches in lib/host/turn-proof.ts and
 * lib/webrtc/ice.ts, built by the same `buildTurnProof`. The worker keeps it
 * under the same `turnPassKey`, so a pass the chat fetched before the game is
 * the one the app opens its mesh with.
 */
import {
  ChainNotSupportedError,
  deriveEntropy,
  findRingVrfKeyHandle,
  getAccountsProvider,
  getChatManager,
  getHostChainInfo,
  getHostLocalStorage,
  getHostProvider,
  formatHostError,
  fromHex,
  getNotificationManager,
  getPaymentManager,
  getPreimageManager,
  getRendererManager,
  getThemeProvider,
  getTruApi,
  navigateTo as sdkNavigateTo,
  requestDevicePermission as sdkRequestDevicePermission,
  requestResourceAllocation,
  toHex,
  type ChatManager,
  type DevicePermissionKind,
  type PreimageManager,
  type RenderContextTag,
  type RenderHandler as ContextRenderHandler,
} from "@parity/product-sdk-host"
import { blake2b } from "@noble/hashes/blake2.js"
import {
  ringCollectionId,
  type GameRegistrationCapabilities,
  type PersonhoodProver,
  type PersonhoodRing,
} from "@parity/product-sdk-individuality"
import { cancelNextGame, remindNextGame, type GameReminderOutcome, type ReminderErrorListener } from "@individuality/sign-up"
import { topUpErrorOutcome, type TopUpOutcome } from "@individuality/prize"
import {
  buildTurnProof,
  localNetwork,
  redeemTurnProof,
  turnPassFor,
  type TurnIssueCause,
  type TurnPass,
  type TurnProofCode,
} from "@jollity/protocol"
import type { JsonRpcProvider } from "polkadot-api"
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"
import { storedJSON } from "@jollity/collectables"
import type { RendererNode, ChatRoomRegistrationStatus, ChatBotRegistrationStatus } from "@parity/truapi"
import type { HostTheme } from "./card"
import { chatFailure, describeError, nameHostCallError } from "./telemetry"
import { CallDeadlineError, within } from "./state"

/** The message id a docked card of the room is drawn under, which no posted message has. */
export const footerMessageId = (roomId: string) => `footer:${roomId}`

/**
 * The host refuses an `alt` with a control or bidirectional character
 * ("alt must not contain control or bidirectional characters"), and a refused
 * message never posts: the rules' "1. Copy the gesture" line, which has a
 * newline, lost the whole intro that way. Line breaks and tabs become one
 * space, and every other character the host rejects goes. The set mirrors
 * `is_display_unsafe` in truapi's platform module:
 * control characters (Cc), U+200B, U+061C, U+2028/2029, U+202A-202E,
 * U+2066-2069, U+FEFF and the tag block U+E0000-E007F. The rich message is
 * untouched.
 */
function hostSafeAlt(alt: string): string {
  return alt
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/gu, " ")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B\u061C\u202A-\u202E\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim()
}

export type Unsubscribe = () => void

export type RenderNode = RendererNode

/** One card the host wants drawn. */
export interface RenderRequest {
  messageId: string
  messageType: string
  payload: Uint8Array
}

/** One of the cards of the worker, docked below the messages and drawn like the card of a message. */
interface RoomFooterCard {
  messageType: string
  payload: Uint8Array
}

/** What a room shows below its messages. */
export type RoomFooter = "TextInput" | "Empty" | { card: RoomFooterCard }

export type RoomFooterOutcome = "set" | "unsupported" | "unknown-room" | "failed"

export type ActionListener = (actionId: string, payload: Uint8Array | undefined) => void

export interface WorkerHostInfo {
  name: string
  version: string
  /** The platform the host reports, such as "Android" or "Ios", when it reports one. */
  platform?: string
  /** The truapi release whose runtime the host embeds, when it says. */
  truapiVersion?: string
}

interface WorkerHostInfoRead {
  info: WorkerHostInfo | null
  failed: boolean
}

/** One handler for every card. `onAction` only ever sees the presses of its own card. */
export type RenderHandler = (
  req: RenderRequest,
  send: (node: RenderNode) => void,
  onAction: (cb: ActionListener) => Unsubscribe,
) => Unsubscribe | void

/** What a TURN pass is fetched for: the product that proves, the player, the issuer, and the second the proof is stamped with. */
interface TurnPassRequest {
  productId: string
  account: Uint8Array
  issuer: string
  timestamp: number
}

/** A redeemed pass, or the step that stopped it and why, in the cause codes of the app. */
export type TurnPassOutcome =
  | { pass: TurnPass }
  | { stage: "proof" | "issue"; cause: TurnProofCode | TurnIssueCause | "timeout"; status?: number; reason: string }

export interface WorkerHost {
  /** The native app around this worker, when truApi can identify it. */
  hostInfo?(): Promise<WorkerHostInfoRead>
  chat: {
    registerBot(botId: string, name: string, icon: string): Promise<ChatBotRegistrationStatus>
    registerRoom(roomId: string, name: string, icon: string): Promise<ChatRoomRegistrationStatus>
    /** A custom message, with `alt` for where the host lists it without drawing it. */
    postMessage(roomId: string, messageType: string, payload: Uint8Array, alt: string): Promise<void>
    /** A plain text message, which the host draws as an ordinary chat bubble. */
    postText(roomId: string, text: string): Promise<void>
    /** Resolves the answer of the host and never throws. */
    setRoomFooter(roomId: string, footer: RoomFooter): Promise<RoomFooterOutcome>
  }
  renderer: {
    onRender(handler: RenderHandler): Unsubscribe
  }
  theme?: {
    subscribe(listener: (theme: HostTheme) => void): Unsubscribe
  }
  notifications: {
    push(input: { text: string; deeplink?: string; scheduledAt?: number }): Promise<number>
    cancel(id: number): Promise<void>
  }
  permissions: {
    /** Resolves the answer of the player, or `undefined` when the host call failed and gave none. */
    requestDevice(kind: DevicePermissionKind): Promise<boolean | undefined>
  }
  /**
   * The one reminder the host holds to bring the player back when the game starts.
   *
   * `onError` hears why the host gave an answer other than the one asked for.
   */
  game: {
    /** Replaces the reminder with one for a game starting at `startsAt`, on the device clock, in milliseconds. */
    remindNextGame(startsAt: number, onError?: ReminderErrorListener): Promise<GameReminderOutcome>
    cancelNextGame(onError?: ReminderErrorListener): Promise<GameReminderOutcome>
  }
  /** Resolves `true` on success, `false` on a denied or failed navigation, and never throws. */
  navigate(url: string): Promise<boolean>
  storage: {
    readJSON<T>(key: string): Promise<T | null>
    writeJSON(key: string, value: unknown): Promise<void>
    /** The JSON another product keeps under `key`, which its manifest lets this one read, or null when there is none. */
    readProductJSON<T>(product: string, key: string): Promise<T | null>
  }
  /** Looks up Bulletin content by its digest, which is how the art of a collectible is read, or null when the host cannot. */
  preimages(): Promise<PreimageManager | null>
  /** The genesis the host maps to the People chain, or null when it maps none. */
  peopleGenesis(): Promise<`0x${string}` | null>
  /** The genesis of the Asset Hub the host serves, where the collectibles live, or null when it names none. */
  assetHubGenesis(): Promise<`0x${string}` | null>
  /** A provider for the chain, or null when the host serves no such chain. */
  chainProvider(genesis: `0x${string}`): Promise<JsonRpcProvider | null>
  /** The public key of a product account, or null when the host hands none over. */
  productAccount(name: string, index: number): Promise<Uint8Array | null>
  /**
   * Tops up the CASH purse of the host from the product account at `index`,
   * under the `id` of the caller. Resolves the answer of the host and never throws.
   */
  topUp(index: number, amount: bigint, id: `0x${string}`): Promise<TopUpOutcome>
  accounts: {
    /**
     * The signer of a product account, with which the host builds each
     * transaction, or null when it hands none over. `txExtVersion` picks the
     * transaction pipeline: Asset Hub pays fees in PGAS only on version 1.
     */
    signer(name: string, index: number, options?: { txExtVersion?: number }): Promise<CommonSignerTxCreator | null>
    /**
     * Signs a merlin transcript with the sr25519 key of a product account,
     * which is how a draw ticket is made: the SDK's `signVrf` capability.
     */
    signVrf(name: string, index: number): NonNullable<GameRegistrationCapabilities["signVrf"]>
    /**
     * The personhood product's keys, as the SDK's sign-up takes them
     * (`PersonhoodProver`): whether the host holds this person's key in a
     * ring, and a proof with it, in the context and over the message the SDK
     * hands it. The lite key binds the free seat and re-points a stale one;
     * the full key proves a recognized person's draw entries.
     *
     * A listing that fails rejects, since a lite person taken for nobody would
     * sign up on the deposit route.
     */
    personhood(): PersonhoodProver
    /**
     * The player's primary username, or null. Reads it with no login of its
     * own, so it never prompts: a player who has not granted the name gets null.
     */
    userName?(): Promise<string | null>
    /**
     * `message` signed by the user's own account `root` (a legacy account, not
     * a product's), through the host's raw signing, which wraps it in
     * `<Bytes>…</Bytes>`. A newer host signs it without a prompt for a
     * product it trusts; another host asks the player to confirm. Rejects
     * when they decline or the host cannot ask.
     */
    signAsRoot?(root: Uint8Array, message: Uint8Array): Promise<Uint8Array>
    /** Asks the host for the PGAS allowance of the product account at `index`; the host's answer ("Allocated" when it gave it). */
    pgasAllowance?(index: number): Promise<string>
  }
  /** Bytes the host derives for this product from `key`, the same on every run, or null when it derives none. */
  entropy(key: Uint8Array): Promise<Uint8Array | null>
  /** Proves and redeems a TURN pass for the player. Never throws. */
  turnPass(request: TurnPassRequest): Promise<TurnPassOutcome>
}

// Discovery on a host without the handler may never answer, and the network
// table in @jollity/protocol has the fallback, so it gets the same five seconds
// lib/engine.ts gives it.
const DISCOVERY_TIMEOUT_MS = 5_000
// The bound the app gives the same proof in lib/webrtc/ice.ts, since a stuck host never answers.
const TURN_PROOF_TIMEOUT_MS = 5_000
const TURN_PROOF_TIMED_OUT = Symbol("turn-proof-timed-out")
const HOST_INFO_TIMEOUT_MS = 1_000
const HOST_INFO_TIMED_OUT = Symbol("host-info-timed-out")

async function hostInfoWithinDeadline<T>(read: () => Promise<T>): Promise<T | typeof HOST_INFO_TIMED_OUT> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<typeof HOST_INFO_TIMED_OUT>((resolve) => {
        deadline = setTimeout(() => resolve(HOST_INFO_TIMED_OUT), HOST_INFO_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (deadline !== undefined) clearTimeout(deadline)
  }
}

async function orThrow<T>(value: Promise<T | null>, what: string): Promise<T> {
  const resolved = await value
  if (!resolved) throw new Error(`The ${what} is unavailable outside a host container.`)
  return resolved
}

/** Preserve the original error and stack, but name the worker-owned host call. */
async function callHost<T>(name: string, call: () => PromiseLike<T> | T): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw nameHostCallError(error, name)
  }
}

let chatManager: Promise<ChatManager | null> | undefined

/** One manager for the life of the worker, so every card shares its action routing. */
function chat(): Promise<ChatManager> {
  chatManager ??= getChatManager()
  return callHost("chat.manager", () => orThrow(chatManager!, "chat manager"))
}

let lastPost: Promise<unknown> = Promise.resolve()

/** One post at a time, in request order: the intro, game cards, Daily Dollar and Membership flows post on their own clocks. */
function enqueuePost<T>(post: () => Promise<T>): Promise<T> {
  // The queue waits for the host's answer only as long as a caller would, so a post the host never answers holds no later post hostage.
  const turn = lastPost.then(() => within(post()))
  lastPost = turn.catch(() => undefined)
  return turn
}

type WireRoomFooter = "TextInput" | "Empty" | { tag: "Card"; value: { messageType: string; payload: string } }

interface RoomFooterContext {
  roomId: string
  messageType: string
}

interface RendererAction {
  context: { tag: string; value: Partial<RoomFooterContext> }
  actionId: string
  payload: `0x${string}`
}

interface RoomFooterClient {
  chat: {
    setRoomFooter?(request: { roomId: string; footer: WireRoomFooter }): PromiseLike<{ isOk(): boolean; error?: unknown }>
  }
  renderer: {
    actionSubscribe(): { subscribe(observer: { next(action: RendererAction): void }): { unsubscribe(): void } }
  }
}

const ROOM_FOOTER_CONTEXT = "ChatRoomFooter" as string as RenderContextTag

function roomFooterFailure(error: unknown): RoomFooterOutcome {
  const { tag, value } = (error ?? {}) as { tag?: unknown; value?: { value?: { tag?: unknown } } }
  if (tag === "Unsupported") return "unsupported"
  if (tag === "Domain" && value?.value?.tag === "UnknownRoom") return "unknown-room"
  return "failed"
}

/** Null for a card on a client that has no Card footer. */
function sendRoomFooter(client: RoomFooterClient, roomId: string, footer: RoomFooter) {
  if (typeof footer === "string") return client.chat.setRoomFooter!({ roomId, footer })
  try {
    return client.chat.setRoomFooter!({
      roomId,
      footer: { tag: "Card", value: { messageType: footer.card.messageType, payload: toHex(footer.card.payload) } },
    })
  } catch {
    // The codec of a client older than the Card footer throws on one before
    // anything reaches the host.
    return null
  }
}

async function setRoomFooter(roomId: string, footer: RoomFooter): Promise<RoomFooterOutcome> {
  try {
    const truApi = (await getTruApi()) as unknown as RoomFooterClient | null
    if (!truApi?.chat.setRoomFooter) return "unsupported"
    const sent = sendRoomFooter(truApi, roomId, footer)
    if (!sent) return "unsupported"
    const result = await sent
    return result.isOk() ? "set" : roomFooterFailure(result.error)
  } catch {
    return "failed"
  }
}

/**
 * Draws a docked card through the handler of every other card, with the presses of that card alone.
 *
 * A press carries no game, so while two draws of one footer overlap, only the
 * latest hears it.
 */
function roomFooterRenderer(handler: RenderHandler, client: RoomFooterClient): ContextRenderHandler {
  const latest = new Map<string, ActionListener>()
  return ({ context, payload }, send) => {
    const { roomId, messageType } = (context as unknown as { value: RoomFooterContext }).value
    const key = `${roomId}:${messageType}`
    return handler({ messageId: footerMessageId(roomId), messageType, payload: fromHex(payload) }, send, (listener) => {
      latest.set(key, listener)
      const actions = client.renderer.actionSubscribe().subscribe({
        next: ({ context: pressed, actionId, payload: data }) => {
          if (pressed.tag !== ROOM_FOOTER_CONTEXT || pressed.value.roomId !== roomId || pressed.value.messageType !== messageType) return
          if (latest.get(key) === listener) listener(actionId, data === "0x" ? undefined : fromHex(data))
        },
      })
      return () => actions.unsubscribe()
    })
  }
}

function onRender(handler: RenderHandler): Unsubscribe {
  let disposed = false
  let registration: { unsubscribe(): void } | undefined
  let footerRegistration: { unsubscribe(): void } | undefined

  void chat()
    .then((manager) => {
      if (disposed) return
      registration = manager.onCustomMessageRenderingRequest((request) => ({
        subscribe(observer) {
          const teardown = handler(
            { messageId: request.messageId, messageType: request.messageType, payload: request.payload },
            (node) => observer.next?.(node),
            (listener) => request.subscribeActions(listener),
          )
          return { unsubscribe: () => teardown?.() }
        },
      }))
    })
    .catch((error: unknown) => {
      console.error("[jollity-chat] The host has no renderer for the chat.", error)
      chatFailure("host-call-failed", "renderer", { error: describeError(error) })
    })

  void Promise.all([getRendererManager(), getTruApi()])
    .then(([renderer, truApi]) => {
      if (disposed || !renderer || !truApi) return
      footerRegistration = renderer.draw(ROOM_FOOTER_CONTEXT, roomFooterRenderer(handler, truApi as unknown as RoomFooterClient))
    })
    .catch((error: unknown) => {
      console.error("[jollity-chat] The host has no renderer for the room footer.", error)
      chatFailure("host-call-failed", "room-footer-renderer", { error: describeError(error) })
    })

  return () => {
    disposed = true
    registration?.unsubscribe()
    footerRegistration?.unsubscribe()
  }
}

/** The Members pallet index on the People runtime, as host-playground names it. */
const MEMBERS_PALLET_INSTANCE = 67

/**
 * The key the host holds for `ring.owner` in `ring.ring`, under either shape
 * a host may hold that ring in: the SDK builds it from the collection alone
 * and the host resolves the Members pallet by name, while host-playground
 * registers it with the pallet instance in front. Never a guessed handle: a
 * host stores a key only under the product that registered it. Null outside a
 * container, or for a person the host holds no key for.
 */
async function personhoodKey(ring: PersonhoodRing) {
  const accounts = await getAccountsProvider()
  if (!accounts) return null
  const keys = await accounts.listRingVrfKeys(ring.owner).match(
    (value) => value,
    (error) => {
      throw new Error(`the host could not list the keys of ${ring.owner}: ${formatHostError(error)}`)
    },
  )
  const shapes = [
    ring.ring,
    { chainId: ring.ring.chainId, junctions: [{ tag: "PalletInstance" as const, value: MEMBERS_PALLET_INSTANCE }, ...ring.ring.junctions] },
  ] as Parameters<typeof findRingVrfKeyHandle>[1][]
  for (const location of shapes) {
    const handle = findRingVrfKeyHandle(keys, location)
    if (handle) return { accounts, handle, location }
  }
  return null
}

/** What a host call of the personhood keys is named, and what its refusal says it refused. */
interface PersonhoodCall {
  key: string
  proof: string
  words: string
}

/** the sign-up's: the lite key and its proof, a member's key and the proof of a draw */
const signUpCall = (ring: PersonhoodRing): PersonhoodCall =>
  ring.key === "lite"
    ? { key: "accounts.liteKey", proof: "accounts.liteProof", words: "lite proof" }
    : { key: "accounts.memberKey", proof: "accounts.memberDrawProof", words: "draw proof" }

/** the TURN pass's, in either ring */
const turnCall = (): PersonhoodCall => ({ key: "turn.key", proof: "turn.proof", words: "TURN proof" })

/**
 * The personhood keys the host holds, in the SDK's `PersonhoodProver` shape:
 * the sign-up's (`accounts.personhood()`) and the TURN pass's. Every call is
 * bounded and named by `call`. A key that was found is kept for the life of
 * the prover, so a sign-up's draw proofs list the keys once; a lookup that
 * finds nothing or fails is not kept, so the next asks again.
 */
function hostPersonhood(call: (ring: PersonhoodRing) => PersonhoodCall): PersonhoodProver {
  const found = new Map<string, NonNullable<Awaited<ReturnType<typeof personhoodKey>>>>()
  const keyFor = async (ring: PersonhoodRing) => {
    const id = `${ring.owner}|${JSON.stringify(ring.ring)}`
    const kept = found.get(id)
    if (kept) return kept
    const key = await personhoodKey(ring)
    if (key) found.set(id, key)
    return key
  }
  return {
    holds: (ring) => boundedHostCall(call(ring).key, async () => (await keyFor(ring)) !== null),
    prove: (ring, context, message) =>
      boundedHostCall(call(ring).proof, async () => {
        const key = await keyFor(ring)
        if (!key) throw new Error(`no ${ring.owner} key for the ${ring.key === "lite" ? "people-lite" : "people"} ring on this host`)
        return key.accounts
          .createRingVRFProof(key.handle, context as Parameters<typeof key.accounts.createRingVRFProof>[1], key.location, message)
          .match(
            (proof) => proof,
            (error) => {
              throw new Error(`the host refused the ${call(ring).words}: ${formatHostError(error)}`)
            },
          )
      }),
  }
}

/**
 * How long one host call of a sign-up may take, the step deadline of
 * apps/jollity-worker/src/signup.ts (`SIGNUP_STEP_DEADLINE_MS`), which this module cannot
 * import: the signup module imports this one.
 */
const REGISTRATION_CALL_DEADLINE_MS = 30_000
const TOP_UP_DEADLINE_MS = 10_000

/**
 * A host call of the sign-up, named and bounded: a deadline is a refusal like
 * any other. A host that drops its answer, as product-sdk-host does for a call
 * truapi rejects, would otherwise hold the sign-up for the life of the worker:
 * the draw tickets and the proofs are asked for before the broadcast, where
 * nothing else bounds the sign-up.
 */
function boundedHostCall<T>(name: string, call: () => PromiseLike<T> | T): Promise<T> {
  return within(callHost(name, call), REGISTRATION_CALL_DEADLINE_MS).catch((error: unknown) => {
    throw error instanceof CallDeadlineError ? nameHostCallError(error, name) : error
  })
}

async function peopleGenesis(): Promise<`0x${string}` | null> {
  const local = localNetwork()
  if (local) return local.genesis.people
  const discovery = await Promise.race([
    getHostChainInfo(["People"]).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), DISCOVERY_TIMEOUT_MS)),
  ])
  return discovery?.chains?.People ?? null
}

export const blake2b256 = (bytes: Uint8Array) => blake2b(bytes, { dkLen: 32 })

async function provenTurnBody(request: TurnPassRequest) {
  if (!(await getAccountsProvider())) return { code: "no-accounts" as const, reason: "no accounts provider" }
  const genesis = await peopleGenesis()
  if (!genesis) return { code: "no-chain-info" as const, reason: "no People genesis from the host" }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof TURN_PROOF_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TURN_PROOF_TIMED_OUT), TURN_PROOF_TIMEOUT_MS)
  })
  const proof = buildTurnProof(hostPersonhood(turnCall), {
    productId: request.productId,
    genesis,
    timestamp: request.timestamp,
    collectionId: ringCollectionId,
    hash: blake2b256,
    describe: formatHostError,
  })
  try {
    return await Promise.race([proof, deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function turnPass(request: TurnPassRequest): Promise<TurnPassOutcome> {
  try {
    const proven = await provenTurnBody(request)
    if (proven === TURN_PROOF_TIMED_OUT) return { stage: "proof", cause: "timeout", reason: `no proof in ${TURN_PROOF_TIMEOUT_MS}ms` }
    if (!("body" in proven)) return { stage: "proof", cause: proven.code, reason: proven.reason }
    const redeemed = await redeemTurnProof((url, init) => globalThis.fetch(url, init), request.issuer, proven.body)
    if (!("credentials" in redeemed)) {
      return { stage: "issue", cause: redeemed.cause, ...(redeemed.status !== undefined ? { status: redeemed.status } : {}), reason: redeemed.reason }
    }
    return { pass: turnPassFor(redeemed.credentials, Date.now()) }
  } catch (error) {
    return { stage: "proof", cause: "proof-threw", reason: describeError(error) }
  }
}

export function createWorkerHost(): WorkerHost {
  return {
    async hostInfo() {
      try {
        const read = await hostInfoWithinDeadline(async () => {
          const truApi = await getTruApi()
          if (!truApi) return null
          return truApi.system.info()
        })
        if (read === HOST_INFO_TIMED_OUT) return { info: null, failed: true }
        if (read === null) return { info: null, failed: false }
        const result = read
        if (!result.isOk()) return { info: null, failed: true }
        const { name, version, platform, truapiVersion } = result.value
        return {
          info: {
            name: String(name),
            version: version == null ? "" : String(version),
            ...(platform == null ? {} : { platform: String(platform) }),
            ...(truapiVersion ? { truapiVersion: String(truapiVersion) } : {}),
          },
          failed: false,
        }
      } catch (error) {
        // A host older than truapi 0.27 sends no truapiVersion, so the 0.27 decoder throws a RangeError on its answer.
        if (error instanceof RangeError) return { info: { name: "", version: "older than truapi 0.27" }, failed: false }
        return { info: null, failed: true }
      }
    },
    chat: {
      async registerBot(botId, name, icon) {
        return callHost("chat.registerBot", async () => (await chat()).registerBot({ botId, name, icon }))
      },
      async registerRoom(roomId, name, icon) {
        return callHost("chat.registerRoom", async () => (await chat()).registerRoom({ roomId, name, icon }))
      },
      postMessage(roomId, messageType, payload, alt) {
        return enqueuePost(() =>
          callHost("chat.postMessage", async () => {
            await (await chat()).sendMessage(roomId, { tag: "Custom", value: { messageType, payload: toHex(payload) } }, { alt: hostSafeAlt(alt) })
          }),
        )
      },
      postText(roomId, text) {
        return enqueuePost(() =>
          callHost("chat.postText", async () => {
            await (await chat()).sendMessage(roomId, { tag: "Text", value: { text } })
          }),
        )
      },
      setRoomFooter,
    },
    renderer: { onRender },
    notifications: {
      async push(input) {
        return callHost("notifications.push", async () => {
          const manager = await orThrow(getNotificationManager(), "notification manager")
          return manager.push({
            text: input.text,
            deeplink: input.deeplink,
            scheduledAt: input.scheduledAt !== undefined ? BigInt(input.scheduledAt) : undefined,
          })
        })
      },
      async cancel(id) {
        await callHost("notifications.cancel", async () => {
          const manager = await orThrow(getNotificationManager(), "notification manager")
          await manager.cancel(id)
        })
      },
    },
    permissions: {
      async requestDevice(kind) {
        return callHost("permissions.requestDevice", async () => {
          const result = await sdkRequestDevicePermission(kind)
          return result.ok ? result.value : undefined
        })
      },
    },
    theme: {
      subscribe(listener) {
        let disposed = false
        let subscription: { unsubscribe(): void } | undefined
        void getThemeProvider()
          .then((provider) => {
            if (disposed || !provider) return
            subscription = provider.subscribeTheme(({ name, variant }) =>
              listener({ name: name.tag === "Custom" ? name.value : null, light: variant === "Light" }),
            )
          })
          .catch((error: unknown) => {
            console.error("[jollity-chat] The host has no theme to subscribe to.", error)
            chatFailure("host-call-failed", "theme", { error: describeError(error) })
          })
        return () => {
          disposed = true
          subscription?.unsubscribe()
        }
      },
    },
    game: {
      async remindNextGame(startsAt, onError) {
        return callHost("game.remindNextGame", async () => {
          const truApi = await getTruApi()
          return truApi ? remindNextGame(truApi, startsAt, onError) : "unsupported"
        })
      },
      async cancelNextGame(onError) {
        return callHost("game.cancelNextGame", async () => {
          const truApi = await getTruApi()
          return truApi ? cancelNextGame(truApi, onError) : "unsupported"
        })
      },
    },
    async navigate(url) {
      return callHost("navigate", async () => {
        const result = await sdkNavigateTo(url)
        return result.ok
      })
    },
    storage: {
      async readJSON<T>(key: string) {
        return callHost("storage.readJSON", async () => {
          const store = await orThrow(getHostLocalStorage(), "host local storage")
          return (await store.readJSON(key)) as T | null
        })
      },
      async writeJSON(key, value) {
        await callHost("storage.writeJSON", async () => {
          const store = await orThrow(getHostLocalStorage(), "host local storage")
          await store.writeJSON(key, value)
        })
      },
      async readProductJSON<T>(product: string, key: string) {
        return callHost("storage.readProductJSON", async () => {
          const truApi = await orThrow(getTruApi(), "truapi")
          const result = await truApi.localStorage.read({ product, key })
          const value = result.match(
            (response) => response.value ?? null,
            (error) => {
              throw new Error(`the storage of ${product} refused ${key}: ${formatHostError(error)}`)
            },
          )
          return value ? (storedJSON(value) as T) : null
        })
      },
    },
    async preimages() {
      return callHost("preimages", () => getPreimageManager())
    },
    peopleGenesis,
    async assetHubGenesis() {
      const local = localNetwork()
      if (local) return local.genesis.hubNextV2
      const discovery = await Promise.race([
        getHostChainInfo(["AssetHub"]).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), DISCOVERY_TIMEOUT_MS)),
      ])
      return discovery?.chains?.AssetHub ?? null
    },
    async chainProvider(genesis) {
      return callHost("chainProvider", async () => {
        try {
          return await getHostProvider(genesis)
        } catch (error) {
          if (error instanceof ChainNotSupportedError) return null
          throw error
        }
      })
    },
    async productAccount(name, index) {
      return callHost("accounts.productAccount", async () => {
        const accounts = await getAccountsProvider()
        if (!accounts) return null
        return accounts.getProductAccount(name, index).match(
          (account) => account.publicKey,
          () => null,
        )
      })
    },
    async topUp(index, amount, id) {
      try {
        const payments = await getPaymentManager()
        if (!payments) return "no-host"
        await within(
          payments.topUp({ id, amount, source: { tag: "ProductAccount", value: { derivationIndex: { tag: "Index", value: index } } } }),
          TOP_UP_DEADLINE_MS,
        )
        return "sent"
      } catch (error) {
        if (error instanceof CallDeadlineError) return "timeout"
        return topUpErrorOutcome(error)
      }
    },
    accounts: {
      async signer(name, index, options) {
        return callHost("accounts.signer", async () => {
          const accounts = await getAccountsProvider()
          if (!accounts) return null
          const account = await accounts.getProductAccount(name, index).match(
            (value) => value,
            () => null,
          )
          if (!account) return null
          return options ? accounts.getProductAccountSigner(account, options) : accounts.getProductAccountSigner(account)
        })
      },
      async signAsRoot(root, message) {
        return callHost("accounts.signAsRoot", async () => {
          const accounts = await orThrow(getAccountsProvider(), "accounts")
          return accounts.getLegacyAccountSigner({ publicKey: root }).signBytes(message)
        })
      },
      async pgasAllowance(index) {
        return callHost("accounts.pgasAllowance", async () => {
          const outcome = await requestResourceAllocation([{ tag: "SmartContractAllowance", value: { tag: "Index", value: index } }])
          return outcome.ok ? String(outcome.value[0]) : formatHostError(outcome.error)
        })
      },
      signVrf(name, index) {
        return (transcriptLabel, items) =>
          boundedHostCall("accounts.signVrf", async () => {
            const accounts = await orThrow(getAccountsProvider(), "accounts")
            return accounts.signVrf({ dotNsIdentifier: name, derivationIndex: index }, transcriptLabel, [...items]).match(
              (signature) => ({ preOutput: signature.preOutput, proof: signature.proof }),
              (error) => {
                throw new Error(`the host refused the draw ticket: ${formatHostError(error)}`)
              },
            )
          })
      },
      personhood() {
        return hostPersonhood(signUpCall)
      },
      async userName() {
        return callHost("accounts.userName", async () => {
          const accounts = await getAccountsProvider()
          if (!accounts) return null
          return accounts.getUserId().match(
            (value) => value.primaryUsername?.trim() || null,
            () => null,
          )
        })
      },
    },
    async entropy(key) {
      return callHost("entropy", async () => {
        const result = await deriveEntropy(key)
        return result.ok ? result.value : null
      })
    },
    turnPass,
  }
}
