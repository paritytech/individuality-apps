// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * NAMES ON THE WHEEL THROUGH DotNS (a proof of concept, #456): a ticket's
 * name is its holder's username, believed only from a note the holder's ROOT
 * account signed.
 *
 * The link, made once per player right after a sign-up lands (./link.ts):
 *   1. the root account signs `<product> names v1\n` + the playing account's
 *      contract address (the host signs as the root:
 *      `getLegacyAccountSigner({ publicKey: root }).signBytes`, which wraps the
 *      bytes in `<Bytes>…</Bytes>` first, as Playground's identity binding does);
 *   2. the playing account keeps the note in its own DotNS User Store (Asset
 *      Hub), under `owner`: version 1 | root (32) | signature (64).
 *
 * A tap reads the holder's store, checks the signature against the root, and
 * shows the root's username: its People-chain username (`Resources.Consumers`,
 * full, else lite) or, failing that, its DotNS primary name. The signature
 * names the product and that one playing account, so a note copied into
 * another account's store proves nothing.
 *
 * What is public: the playing account ↔ root link, which is the point; the
 * root's address was already public through its username. Never the root's
 * key: the host signs one message with it.
 *
 * Reads only, through the runtime's `ReviveApi.call` (a dry run): no fee.
 * Framework-free; the chains are handed in, so the reading is tested alone.
 */
import { AccountId, type PolkadotClient } from "polkadot-api"
import { displayUsername, lookupUsername, type ConsumersChain, type RawConsumerInfo } from "@parity/product-sdk-individuality"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { verify } from "@scure/sr25519"

/** The DotNS contracts the reads go to: CREATE3 addresses, the same on
 *  paseo-v2 and previewnet (@parity/dotns-cli's environment table). */
export const DOTNS_CONTRACTS = {
  storeFactory: "0x99605a926FcB40aB520F659c6505E5ff862771f6",
  reverseResolver: "0xee3883d7eB60Ee9BCD7F3bcD8f2f05302A9Cc035",
} as const

/** the store key the note lives under */
export const NOTE_KEY = "owner"
const NOTE_VERSION = 1
const NOTE_LENGTH = 1 + 32 + 64

/** A read-only contract call: the return data, or a rejection when it reverts or fails. */
export type ContractCall = (contract: string, data: Uint8Array) => Promise<Uint8Array>
/** A root account's People-chain username (full, else lite), or null. */
export type PeopleName = (root: Uint8Array) => Promise<string | null>

const enc = new TextEncoder()
const dec = new TextDecoder()

export const toHex = (bytes: Uint8Array) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`

/** the 4-byte selector of a Solidity signature */
export const selector = (signature: string) => keccak_256(enc.encode(signature)).slice(0, 4)

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** a number as a 32-byte ABI word */
const word = (value: number | bigint) => {
  const out = new Uint8Array(32)
  let v = BigInt(value)
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}
/** an address left-padded to a 32-byte ABI word */
const addressWord = (address: Uint8Array) => cat(new Uint8Array(12), address)

/** An account's address on Asset Hub's contracts: the last 20 bytes of
 *  keccak256 of its 32-byte key (pallet-revive's mapping for an account that
 *  is not Ethereum-derived). */
export function h160Of(publicKey: Uint8Array): Uint8Array {
  return keccak_256(publicKey).slice(12)
}

/** ABI `bytes`/`string` return data: an offset word, a length word, the bytes */
export function decodeDynamic(out: Uint8Array): Uint8Array {
  if (out.length < 64) return new Uint8Array(0)
  const offset = Number(BigInt(toHex(out.slice(0, 32))))
  const length = Number(BigInt(toHex(out.slice(offset, offset + 32))))
  return out.slice(offset + 32, offset + 32 + length)
}

/** What the root signs for a playing account of `product`. */
export function linkMessage(product: string, account: Uint8Array): Uint8Array {
  return cat(enc.encode(`${product} names v1\n`), h160Of(account))
}

/** The host's raw-signing wrapper, which the signature covers. */
export const wrapBytes = (message: Uint8Array) => cat(enc.encode("<Bytes>"), message, enc.encode("</Bytes>"))

/** The note a playing account keeps: version | root | signature. */
export function encodeNote(root: Uint8Array, signature: Uint8Array): Uint8Array {
  return cat(Uint8Array.of(NOTE_VERSION), root, signature)
}

export function decodeNote(value: Uint8Array): { root: Uint8Array; signature: Uint8Array } | null {
  if (value.length !== NOTE_LENGTH || value[0] !== NOTE_VERSION) return null
  return { root: value.slice(1, 33), signature: value.slice(33) }
}

/** Whether `signature` is `root`'s over the link message for `account`, raw or `<Bytes>`-wrapped. */
export function verifyLink(product: string, account: Uint8Array, root: Uint8Array, signature: Uint8Array): boolean {
  const message = linkMessage(product, account)
  try {
    return verify(wrapBytes(message), signature, root) || verify(message, signature, root)
  } catch {
    return false
  }
}

/** `setValue(bytes32 keccak256(key), bytes value)` calldata for a User Store */
export function setValueCalldata(key: string, value: Uint8Array): Uint8Array {
  const padding = new Uint8Array((32 - (value.length % 32)) % 32)
  return cat(selector("setValue(bytes32,bytes)"), keccak_256(enc.encode(key)), word(64), word(value.length), value, padding)
}

/** Why a lookup found the name it did, or none, as one fixed word: the telemetry's tag (`why` is the log's sentence). */
export type NameReason = "named" | "no-store" | "no-note" | "not-for-account" | "no-username"

/** A holder's name, or null, with why. */
export interface NameLookup {
  name: string | null
  why: string
  reason: NameReason
  /** the root that signed the holder's note, when there is one that checks out */
  root?: string
}

/** The DotNS name reader over `call` (Asset Hub) and `peopleName` (People), for `product` (`dim2.paseo`). */
export function dotnsNames(call: ContractCall, peopleName: PeopleName, product: string, contracts = DOTNS_CONTRACTS) {
  /** the User Store an account has claimed, or null */
  const storeOf = async (account: Uint8Array): Promise<string | null> => {
    const out = await call(contracts.storeFactory, cat(selector("getUserStore(address)"), addressWord(h160Of(account))))
    const store = out.slice(12, 32)
    return store.length === 20 && store.some((b) => b !== 0) ? toHex(store) : null
  }
  /** the note in an account's store, or null */
  async function noteOf(account: Uint8Array) {
    const store = await storeOf(account)
    if (!store) return { store: null, note: null }
    const value = decodeDynamic(await call(store, cat(selector("getValue(bytes32)"), keccak_256(enc.encode(NOTE_KEY)))))
    return { store, note: decodeNote(value) }
  }
  /** a root's name: its People username, else its DotNS primary name */
  async function nameOfRoot(root: Uint8Array): Promise<string | null> {
    const people = await peopleName(root).catch(() => null)
    if (people) return people
    const out = await call(contracts.reverseResolver, cat(selector("nameOf(address)"), addressWord(h160Of(root))))
    return dec.decode(decodeDynamic(out)) || null
  }

  /** the holder's name, or null with why not */
  async function lookup(holder: string): Promise<NameLookup> {
    const account = AccountId().enc(holder)
    const { store, note } = await noteOf(account)
    if (!store) return { name: null, why: "the holder has no store", reason: "no-store" }
    if (!note) return { name: null, why: "the holder's store holds no signed note", reason: "no-note" }
    if (!verifyLink(product, account, note.root, note.signature))
      return { name: null, why: "the note is not signed for this account", reason: "not-for-account" }
    const name = await nameOfRoot(note.root)
    const root = AccountId().dec(note.root)
    return name
      ? { name, why: "signed by the holder's root", reason: "named", root }
      : { name: null, why: "the root has no username", reason: "no-username", root }
  }
  return { lookup, storeOf, noteOf, nameOfRoot }
}

/** The slices of the unsafe APIs the reads take, typed here once (a chat worker reads without descriptors). */
interface ReviveCallApi {
  apis: {
    ReviveApi: {
      call(
        origin: string,
        dest: string,
        value: bigint,
        gasLimit: undefined,
        storageDepositLimit: undefined,
        data: Uint8Array,
        options?: { at: "best" },
      ): Promise<{ result: { success: boolean; value: unknown } }>
    }
  }
}
interface PeopleNamesApi {
  query: {
    Resources: {
      Consumers: { getValue(account: string, options?: { at?: string; signal?: AbortSignal }): Promise<RawConsumerInfo | undefined> }
      UsernameOwnerOf: { getValue(username: Uint8Array, options?: { at?: string }): Promise<string | undefined> }
    }
  }
}

/**
 * `ContractCall` over a client of Asset Hub: the runtime's `ReviveApi.call`, as
 * a dry run, at the finalized block unless `options` asks for the best one.
 */
export function reviveCall(client: PolkadotClient, options?: { at: "best" }): ContractCall {
  // a read needs an origin, and any will do
  const origin = AccountId().dec(new Uint8Array(32))
  const api = client.getUnsafeApi() as unknown as ReviveCallApi
  return async (contract, data) => {
    // papi takes a trailing options object only when one is passed
    const result = options
      ? await api.apis.ReviveApi.call(origin, contract, 0n, undefined, undefined, data, options)
      : await api.apis.ReviveApi.call(origin, contract, 0n, undefined, undefined, data)
    if (!result.result.success) throw new Error(`the call to ${contract} failed`)
    const { flags, data: out } = result.result.value as { flags: number; data: Uint8Array }
    if (flags & 1) throw new Error(`the call to ${contract} reverted`)
    return out
  }
}

/** The account that owns `username` on the People chain (`Resources.UsernameOwnerOf`,
 *  keyed by the bare name, no `.dot`), or null for nobody. At the finalized
 *  block unless `options` asks for the best one. */
export async function usernameOwner(client: PolkadotClient, username: string, options?: { at: "best" }): Promise<Uint8Array | null> {
  const api = client.getUnsafeApi() as unknown as PeopleNamesApi
  const key = enc.encode(username.replace(/\.dot$/, ""))
  const owner = await (options ? api.query.Resources.UsernameOwnerOf.getValue(key, options) : api.query.Resources.UsernameOwnerOf.getValue(key))
  return owner ? AccountId().enc(owner) : null
}

/** `PeopleName` over a client of the People chain: the product SDK's
 *  `lookupUsername` of `Resources.Consumers(root)`, named by its
 *  `displayUsername` rule (the full username, else the lite one). */
export function peopleNames(client: PolkadotClient): PeopleName {
  return async (root) => {
    const record = await consumerUsernames(client, root)
    return record ? displayUsername(record) : null
  }
}

/** Whether the root holds a full username on the People chain, as opposed to a lite one or none. */
export async function fullUsernameSet(client: PolkadotClient, root: Uint8Array): Promise<boolean> {
  const record = await consumerUsernames(client, root)
  return record?.fullUsername != null
}

async function consumerUsernames(client: PolkadotClient, root: Uint8Array) {
  const api = client.getUnsafeApi() as unknown as PeopleNamesApi
  const chain: ConsumersChain = {
    individuality: {
      query: { Resources: { Consumers: { getValue: (account, options) => api.query.Resources.Consumers.getValue(account, options) } } },
    },
  }
  const found = await lookupUsername(chain, { account: AccountId().dec(root) })
  if (!found.ok) throw found.error
  return found.value
}
