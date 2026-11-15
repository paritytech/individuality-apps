// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { AccountId, type PolkadotClient } from "polkadot-api"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { getPublicKey, secretFromSeed, sign } from "@scure/sr25519"
import {
  decodeDynamic,
  decodeNote,
  DOTNS_CONTRACTS,
  dotnsNames,
  encodeNote,
  h160Of,
  linkMessage,
  NOTE_KEY,
  selector,
  setValueCalldata,
  toHex,
  verifyLink,
  wrapBytes,
  type ContractCall,
  fullUsernameSet,
  peopleNames,
} from "./dotns-names"

const enc = new TextEncoder()
const PRODUCT = "dim2.paseo"

/** an sr25519 key from a one-byte seed */
function key(n: number) {
  const secret = secretFromSeed(new Uint8Array(32).fill(n))
  const publicKey = getPublicKey(secret)
  return { publicKey, ss58: AccountId().dec(publicKey), sign: (m: Uint8Array) => sign(secret, m) }
}

/** the note a root signs for `account`, as the host signs it (`<Bytes>`-wrapped) */
const noteFor = (account: ReturnType<typeof key>, root: ReturnType<typeof key>, product = PRODUCT) =>
  encodeNote(root.publicKey, root.sign(wrapBytes(linkMessage(product, account.publicKey))))

/** ABI return data for `bytes`/`string` */
function dynamic(bytes: Uint8Array): Uint8Array {
  const padded = Math.ceil(bytes.length / 32) * 32
  const out = new Uint8Array(64 + padded)
  out[31] = 0x20
  out.set(new Uint8Array(new BigUint64Array([BigInt(bytes.length)]).buffer).reverse(), 56)
  out.set(bytes, 64)
  return out
}

/** A fake Asset Hub: the accounts that claimed a store, what each store keeps under `owner`, and DotNS primary names. */
function fakeChain(world: { notes: Map<string, Uint8Array | null>; dotnsNames?: Map<string, string> }): ContractCall {
  const storeOf = (h160: string) => `0x${h160.slice(2, 6).repeat(10)}`
  return async (contract, data) => {
    const sel = toHex(data.slice(0, 4))
    const arg = data.slice(4)
    if (contract === DOTNS_CONTRACTS.storeFactory && sel === toHex(selector("getUserStore(address)"))) {
      const account = toHex(arg.slice(12, 32))
      const out = new Uint8Array(32)
      if (world.notes.has(account)) out.set(Uint8Array.from(Buffer.from(storeOf(account).slice(2), "hex")), 12)
      return out
    }
    if (contract === DOTNS_CONTRACTS.reverseResolver && sel === toHex(selector("nameOf(address)")))
      return dynamic(enc.encode(world.dotnsNames?.get(toHex(arg.slice(12, 32))) ?? ""))
    if (sel === toHex(selector("getValue(bytes32)"))) {
      const owner = [...world.notes.keys()].find((account) => storeOf(account) === contract.toLowerCase())
      const value = owner && toHex(arg) === toHex(keccak_256(enc.encode(NOTE_KEY))) ? world.notes.get(owner) : null
      return dynamic(value ?? new Uint8Array(0))
    }
    throw new Error(`no such call: ${contract} ${sel}`)
  }
}

const JOLLITY = key(1)
const ROOT = key(2)
const OTHER = key(3)
const at = (k: ReturnType<typeof key>) => toHex(h160Of(k.publicKey))
const peopleNamesOf = (names: Record<string, string>) => async (root: Uint8Array) => names[AccountId().dec(root)] ?? null

describe("dotns names", () => {
  it("names a holder whose root signed their note, with the root's People username", async () => {
    const call = fakeChain({ notes: new Map([[at(JOLLITY), noteFor(JOLLITY, ROOT)]]) })
    const found = await dotnsNames(call, peopleNamesOf({ [ROOT.ss58]: "alice.05" }), PRODUCT).lookup(JOLLITY.ss58)
    expect(found).toEqual({ name: "alice.05", why: "signed by the holder's root", reason: "named", root: ROOT.ss58 })
  })

  it("falls back to the root's DotNS primary name when it has no People username", async () => {
    const call = fakeChain({ notes: new Map([[at(JOLLITY), noteFor(JOLLITY, ROOT)]]), dotnsNames: new Map([[at(ROOT), "jollity-ana.paseo"]]) })
    expect((await dotnsNames(call, async () => null, PRODUCT).lookup(JOLLITY.ss58)).name).toBe("jollity-ana.paseo")
  })

  it("believes no note copied into another account's store: the signature names the account it was made for", async () => {
    const call = fakeChain({ notes: new Map([[at(OTHER), noteFor(JOLLITY, ROOT)]]) })
    const found = await dotnsNames(call, peopleNamesOf({ [ROOT.ss58]: "alice.05" }), PRODUCT).lookup(OTHER.ss58)
    expect(found).toEqual({ name: null, why: "the note is not signed for this account", reason: "not-for-account" })
  })

  it("believes no note signed for another product", async () => {
    const call = fakeChain({ notes: new Map([[at(JOLLITY), noteFor(JOLLITY, ROOT, "stash.paseo")]]) })
    expect((await dotnsNames(call, async () => "alice.05", PRODUCT).lookup(JOLLITY.ss58)).why).toBe("the note is not signed for this account")
  })

  it("names nobody without a store, a note, or a name", async () => {
    expect((await dotnsNames(fakeChain({ notes: new Map() }), async () => null, PRODUCT).lookup(JOLLITY.ss58)).reason).toBe("no-store")
    const empty = fakeChain({ notes: new Map([[at(JOLLITY), null]]) })
    expect((await dotnsNames(empty, async () => null, PRODUCT).lookup(JOLLITY.ss58)).reason).toBe("no-note")
    const unnamed = fakeChain({ notes: new Map([[at(JOLLITY), noteFor(JOLLITY, ROOT)]]) })
    expect(await dotnsNames(unnamed, async () => null, PRODUCT).lookup(JOLLITY.ss58)).toEqual({ name: null, why: "the root has no username", reason: "no-username", root: ROOT.ss58 })
  })

  it("checks a signature over the bare message too, and nothing signed by another key", () => {
    const message = linkMessage(PRODUCT, JOLLITY.publicKey)
    expect(verifyLink(PRODUCT, JOLLITY.publicKey, ROOT.publicKey, ROOT.sign(wrapBytes(message)))).toBe(true)
    expect(verifyLink(PRODUCT, JOLLITY.publicKey, ROOT.publicKey, ROOT.sign(message))).toBe(true)
    expect(verifyLink(PRODUCT, JOLLITY.publicKey, ROOT.publicKey, OTHER.sign(wrapBytes(message)))).toBe(false)
    expect(verifyLink(PRODUCT, JOLLITY.publicKey, ROOT.publicKey, new Uint8Array(64))).toBe(false)
  })

  it("encodes the note and the store write, and decodes ABI bytes", () => {
    const note = noteFor(JOLLITY, ROOT)
    expect(note.length).toBe(97)
    expect(decodeNote(note)?.root).toEqual(ROOT.publicKey)
    expect(decodeNote(note.slice(1))).toBeNull()
    expect(decodeNote(Uint8Array.of(2, ...note.slice(1)))).toBeNull()
    const data = setValueCalldata(NOTE_KEY, note)
    expect(toHex(data.slice(0, 4))).toBe(toHex(selector("setValue(bytes32,bytes)")))
    expect(data.slice(4, 36)).toEqual(keccak_256(enc.encode(NOTE_KEY)))
    expect(data.length).toBe(4 + 32 + 32 + 32 + 128)
    // the arguments: the key, the offset of the bytes (64), then their length and the bytes
    expect(Number(BigInt(toHex(data.slice(36, 68))))).toBe(64)
    expect(Number(BigInt(toHex(data.slice(68, 100))))).toBe(97)
    expect(data.slice(100, 197)).toEqual(note)
    expect(decodeDynamic(new Uint8Array(0))).toEqual(new Uint8Array(0))
  })

  it("maps an account to its contract address as pallet-revive does", () => {
    // the paseo-v2 test account play1 and its address, as `dotns account map` printed them
    expect(toHex(h160Of(AccountId().enc("5D9w8D4DHyeDpfEhtXx6gfAYhRPkLLXAKe17qqbxQ3TUwu5U")))).toBe("0x82e3d6dc2fdae6d6eff58c79492a79076c74b8d9")
  })
})

describe("peopleNames — the SDK's username read", () => {
  /** a People client whose `Resources.Consumers` holds `records`, by SS58 */
  const people = (records: Record<string, { lite: string; full?: string }>) =>
    ({
      getUnsafeApi: () => ({
        query: {
          Resources: {
            Consumers: {
              getValue: async (who: string) => {
                const record = records[who]
                if (!record) return undefined
                return {
                  lite_username: new TextEncoder().encode(record.lite),
                  ...(record.full ? { full_username: new TextEncoder().encode(record.full) } : {}),
                  credibility: { type: "Lite" },
                }
              },
            },
          },
        },
      }),
    }) as unknown as PolkadotClient

  it("names a root by its full username, else its lite one, and nobody without a record", async () => {
    const name = peopleNames(people({ [ROOT.ss58]: { lite: "alice.05", full: "alice" }, [OTHER.ss58]: { lite: "bob.07" } }))
    expect(await name(ROOT.publicKey)).toBe("alice")
    expect(await name(OTHER.publicKey)).toBe("bob.07")
    expect(await name(JOLLITY.publicKey)).toBeNull()
  })

  it("holds a full username only for a root whose record carries one", async () => {
    const client = people({ [ROOT.ss58]: { lite: "alice.05", full: "alice" }, [OTHER.ss58]: { lite: "bob.07" } })
    expect(await fullUsernameSet(client, ROOT.publicKey)).toBe(true)
    expect(await fullUsernameSet(client, OTHER.publicKey)).toBe(false)
    expect(await fullUsernameSet(client, JOLLITY.publicKey)).toBe(false)
  })
})
