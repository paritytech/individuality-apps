// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { AccountId, InvalidTxError, type PolkadotClient } from "polkadot-api"
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"
import { getPublicKey, secretFromSeed, sign } from "@scure/sr25519"
import { DOTNS_CONTRACTS, encodeNote, h160Of, linkMessage, selector, toHex, wrapBytes } from "./dotns-names"
import { linkName, type NameLink } from "./link"

const PRODUCT = "dim2.paseo"
const enc = new TextEncoder()

/** an sr25519 key from a one-byte seed */
function key(n: number) {
  const secret = secretFromSeed(new Uint8Array(32).fill(n))
  const publicKey = getPublicKey(secret)
  return { publicKey, ss58: AccountId().dec(publicKey), sign: (m: Uint8Array) => sign(secret, m) }
}
const JOLLITY = key(1)
const ROOT = key(2)
const OTHER = key(3)

/** ABI return data for `bytes`/`string` */
function dynamic(bytes: Uint8Array): Uint8Array {
  const padded = Math.ceil(bytes.length / 32) * 32
  const out = new Uint8Array(64 + padded)
  out[31] = 0x20
  out.set(new Uint8Array(new BigUint64Array([BigInt(bytes.length)]).buffer).reverse(), 56)
  out.set(bytes, 64)
  return out
}

/**
 * Asset Hub and People as the link sees them: the DotNS store factory and the
 * stores (dry runs and transactions), the two balances, and usernames.
 */
function fakeChains(
  opts: {
    pgas?: bigint
    native?: bigint
    linkedTo?: Uint8Array
    names?: Record<string, string>
    usernameOwners?: Record<string, string>
    finalityLags?: boolean
    refusesClaim?: unknown
    linkedMeanwhile?: boolean
    claimedMeanwhile?: boolean
    refusesWrites?: unknown[]
    ownerReadFails?: boolean
  } = {},
) {
  const STORE = "0x5100000000000000000000000000000000000051"
  const linkedKey = opts.linkedTo && toHex(opts.linkedTo) === toHex(OTHER.publicKey) ? OTHER : ROOT
  let stored: Uint8Array | null = opts.linkedTo ? encodeNote(opts.linkedTo, linkedKey.sign(wrapBytes(linkMessage(PRODUCT, JOLLITY.publicKey)))) : null
  let claimed = opts.linkedTo !== undefined
  // with finality lagging, a DotNS read anywhere but the best block still sees the starting store
  const initial = { stored, claimed }
  const dotnsSeen = (options?: { at?: string }) => (opts.finalityLags && options?.at !== "best" ? initial : { stored, claimed })
  const balance = { pgas: opts.pgas ?? 10_000_000_000n, native: opts.native ?? 0n }
  // with finality lagging, a read anywhere but the best block still sees the starting balances
  const seen = (options?: { at?: string }) =>
    opts.finalityLags && options?.at !== "best" ? { pgas: opts.pgas ?? 10_000_000_000n, native: opts.native ?? 0n } : balance
  const sent: string[] = []
  const refused: string[] = []
  const writeRefusals = [...(opts.refusesWrites ?? [])]
  const is = (data: Uint8Array, signature: string) => toHex(data.slice(0, 4)) === toHex(selector(signature))

  const call = async (
    _origin: string,
    dest: string,
    _value: bigint,
    _gas: unknown,
    _deposit: unknown,
    data: Uint8Array,
    options?: { at?: string },
  ) => {
    const view = dotnsSeen(options)
    let out: Uint8Array = new Uint8Array(0)
    if (dest === DOTNS_CONTRACTS.storeFactory && is(data, "getUserStore(address)")) {
      out = new Uint8Array(32)
      if (view.claimed && toHex(data.slice(16, 36)) === toHex(h160Of(JOLLITY.publicKey))) out.set(Uint8Array.from(Buffer.from(STORE.slice(2), "hex")), 12)
    } else if (dest === STORE && is(data, "getValue(bytes32)")) out = dynamic(view.stored ?? new Uint8Array(0))
    else if (dest === DOTNS_CONTRACTS.reverseResolver) out = dynamic(new Uint8Array(0))
    return {
      result: { success: true, value: { flags: 0, data: out } },
      weight_required: { ref_time: 1_000n, proof_size: 1_000n },
      storage_deposit: { type: "Charge" as const, value: 1_000n },
    }
  }
  const assetHub = {
    getUnsafeApi: () => ({
      constants: { Pgas: { PgasAssetId: async () => 2_000_000_000 } },
      query: {
        System: { Account: { getValue: async (_who: string, options?: { at?: string }) => ({ data: { free: seen(options).native } }) } },
        Assets: { Account: { getValue: async (_asset: number, _who: string, options?: { at?: string }) => ({ balance: seen(options).pgas }) } },
      },
      apis: { ReviveApi: { call } },
      tx: {
        Revive: {
          call: (args: { dest: string; data: Uint8Array }) => ({
            // lands in a best block at once, emitting while subscribe still runs, as papi can
            createSubmitAndWatch: () => ({
              subscribe(observer: { next(event: unknown): void; error(error: unknown): void }) {
                if (opts.refusesClaim !== undefined && args.dest === DOTNS_CONTRACTS.storeFactory && is(args.data, "claimUserStore()")) {
                  if (opts.linkedMeanwhile) {
                    claimed = true
                    stored = encodeNote(ROOT.publicKey, ROOT.sign(wrapBytes(linkMessage(PRODUCT, JOLLITY.publicKey))))
                  }
                  if (opts.claimedMeanwhile) claimed = true
                  refused.push("claim")
                  observer.error(opts.refusesClaim)
                  return { unsubscribe() {} }
                }
                if (writeRefusals.length > 0 && args.dest === STORE && is(args.data, "setValue(bytes32,bytes)")) {
                  if (opts.linkedMeanwhile) stored = encodeNote(ROOT.publicKey, ROOT.sign(wrapBytes(linkMessage(PRODUCT, JOLLITY.publicKey))))
                  refused.push("write")
                  observer.error(writeRefusals.shift())
                  return { unsubscribe() {} }
                }
                if (args.dest === DOTNS_CONTRACTS.storeFactory && is(args.data, "claimUserStore()")) {
                  claimed = true
                  sent.push("claim")
                } else if (args.dest === STORE && is(args.data, "setValue(bytes32,bytes)")) {
                  const length = Number(BigInt(toHex(args.data.slice(68, 100))))
                  stored = args.data.slice(100, 100 + length)
                  sent.push("write")
                }
                observer.next({ type: "broadcasted" })
                observer.next({ type: "inBestBlock", ok: true, block: { number: 7 } })
                return { unsubscribe() {} }
              },
            }),
          }),
        },
      },
    }),
  } as unknown as PolkadotClient
  const names = opts.names ?? { [ROOT.ss58]: "alice.05" }
  const usernameOwners = opts.usernameOwners ?? { "alice.05": ROOT.ss58 }
  const people = {
    getUnsafeApi: () => ({
      query: {
        Resources: {
          Consumers: {
            getValue: async (who: string) =>
              names[who] ? { lite_username: enc.encode("lite.01"), full_username: enc.encode(names[who]), credibility: { type: "Lite" } } : undefined,
          },
          UsernameOwnerOf: {
            getValue: async (username: Uint8Array, options?: { at?: string }) => {
              if (opts.ownerReadFails) throw new Error("socket closed")
              // with finality lagging, the owner of a just-claimed username is at the best block alone
              if (opts.finalityLags && options?.at !== "best") return undefined
              return usernameOwners[new TextDecoder().decode(username)]
            },
          },
        },
      },
    }),
  } as unknown as PolkadotClient
  return { assetHub, people, sent, refused, balance, stored: () => stored }
}

function linkWith(chains: ReturnType<typeof fakeChains>, overrides: Partial<NameLink> = {}) {
  const signAsRoot = vi.fn(async (_username: string, message: Uint8Array) => ({ root: ROOT.publicKey, signature: ROOT.sign(wrapBytes(message)) }))
  const link: NameLink = {
    product: PRODUCT,
    account: JOLLITY.publicKey,
    username: "alice.05",
    assetHub: chains.assetHub,
    people: chains.people,
    signer: {} as CommonSignerTxCreator,
    signAsRoot,
    log: () => {},
    ...overrides,
  }
  return { link, signAsRoot: (overrides.signAsRoot as typeof signAsRoot | undefined) ?? signAsRoot }
}

const stale = () => new InvalidTxError({ type: "Invalid", value: { type: "Stale" } })
const future = () => new InvalidTxError({ type: "Invalid", value: { type: "Future" } })

afterEach(() => {
  vi.useRealTimers()
})

describe("linkName", () => {
  it("claims the store, writes the root's note in it, and reads the username back", async () => {
    // Given
    const chains = fakeChains()
    const { link, signAsRoot } = linkWith(chains)

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("linked")
    expect(chains.sent).toEqual(["claim", "write"])
    expect(signAsRoot).toHaveBeenCalledWith("alice.05", linkMessage(PRODUCT, JOLLITY.publicKey))
    expect(chains.stored()?.slice(1, 33)).toEqual(ROOT.publicKey)
  })

  it("asks the root for nothing when the account already carries a note for this username", async () => {
    // Given
    const chains = fakeChains({ linkedTo: ROOT.publicKey })
    const { link, signAsRoot } = linkWith(chains, { username: "alice.05.dot" })

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("already-linked")
    expect(signAsRoot).not.toHaveBeenCalled()
    expect(chains.sent).toEqual([])
  })

  it("recognizes an existing link by root when the root's display name differs from the lite username", async () => {
    // Given: alice.07 belongs to this root, whose People display name is alicewood
    const chains = fakeChains({
      linkedTo: ROOT.publicKey,
      names: { [ROOT.ss58]: "alicewood" },
      usernameOwners: { "alice.07": ROOT.ss58 },
    })
    const facts: Record<string, string> = {}
    const { link, signAsRoot } = linkWith(chains, {
      username: "alice.07",
      onFacts: (found) => Object.assign(facts, found),
    })

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("already-linked")
    expect(signAsRoot).not.toHaveBeenCalled()
    expect(chains.sent).toEqual([])
    expect(facts).toEqual({ "name_link.lookup_reason": "named", "name_link.already_linked": "true" })
  })

  it("recognizes an existing link by root when the root username read is unavailable", async () => {
    const chains = fakeChains({
      linkedTo: ROOT.publicKey,
      names: {},
      usernameOwners: { "alice.07": ROOT.ss58 },
    })
    const { link, signAsRoot } = linkWith(chains, { username: "alice.07" })

    await expect(linkName(link)).resolves.toBe("already-linked")
    expect(signAsRoot).not.toHaveBeenCalled()
    expect(chains.sent).toEqual([])
  })

  it("re-links when the existing note was signed by a different root", async () => {
    // Given: the requested username belongs to ROOT, but OTHER signed the stored note
    const chains = fakeChains({
      linkedTo: OTHER.publicKey,
      names: { [OTHER.ss58]: "someone-else", [ROOT.ss58]: "alice.05" },
      usernameOwners: { "alice.05": ROOT.ss58 },
    })
    const { link, signAsRoot } = linkWith(chains)

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("linked")
    expect(signAsRoot).toHaveBeenCalledTimes(1)
    expect(chains.sent).toEqual(["write"])
  })

  it("asks for the PGAS allowance when short, and links once it lands", async () => {
    // Given: no PGAS, and an allowance that lands a poll later
    vi.useFakeTimers()
    const chains = fakeChains({ pgas: 0n })
    const allowance = vi.fn(async () => {
      setTimeout(() => (chains.balance.pgas = 50_000_000_000n), 1_000)
      return "Allocated"
    })
    const { link } = linkWith(chains, { allowance })

    // When
    const linking = linkName(link)
    await vi.advanceTimersByTimeAsync(3_000)
    const outcome = await linking

    // Then
    expect(allowance).toHaveBeenCalledTimes(1)
    expect(outcome).toBe("linked")
  })

  it("sees the allowance at the best block, before Asset Hub finalizes it", async () => {
    // Given: no PGAS, and an allowance that lands a poll later on a chain whose finality trails the wait
    vi.useFakeTimers()
    const chains = fakeChains({ pgas: 0n, finalityLags: true })
    const allowance = vi.fn(async () => {
      setTimeout(() => (chains.balance.pgas = 50_000_000_000n), 1_000)
      return "Allocated"
    })
    const { link } = linkWith(chains, { allowance })

    // When
    const linking = linkName(link)
    await vi.advanceTimersByTimeAsync(3_000)
    const outcome = await linking

    // Then
    expect(outcome).toBe("linked")
    expect(chains.sent).toEqual(["claim", "write"])
  })

  it("claims the store and writes the note at the best block, before Asset Hub finalizes either", async () => {
    // Given: a chain whose finality trails the link, so only best-block reads see its writes
    const chains = fakeChains({ finalityLags: true })
    const { link } = linkWith(chains)

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("linked")
    expect(chains.sent).toEqual(["claim", "write"])
  })

  it("ends already linked when the pool refuses the store claim as Stale and the name is linked meanwhile", async () => {
    // Given
    const chains = fakeChains({ refusesClaim: stale(), linkedMeanwhile: true })
    const { link } = linkWith(chains)

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("already-linked")
  })

  it("writes the note without a second claim when the pool refuses the claim as Stale and the store is claimed meanwhile", async () => {
    // Given
    const chains = fakeChains({ refusesClaim: stale(), claimedMeanwhile: true })
    const { link } = linkWith(chains)

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("linked")
    expect(chains.refused).toEqual(["claim"])
    expect(chains.sent).toEqual(["write"])
  })

  it("sends the note once more when the pool refuses it as Stale and the name is not linked yet", async () => {
    // Given
    const facts: Record<string, string> = {}
    const chains = fakeChains({ refusesWrites: [stale()] })
    const { link } = linkWith(chains, { onFacts: (found) => Object.assign(facts, found) })

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("linked")
    expect(chains.refused).toEqual(["write"])
    expect(chains.sent).toEqual(["claim", "write"])
    expect(facts["name_link.nonce_refused"]).toBe("Stale")
  })

  it("fails, naming Stale, when the pool refuses the same step twice", async () => {
    // Given
    const logged: string[] = []
    const chains = fakeChains({ refusesClaim: stale() })
    const { link } = linkWith(chains, { log: (message, data) => logged.push(`${message} ${String(data?.detail ?? "")}`) })

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("failed")
    expect(chains.refused).toEqual(["claim", "claim"])
    expect(logged.at(-1)).toMatch(/^linking the name failed .*twice \(Stale\)$/)
  })

  it("fails without a resend when the pool refuses the claim for a reason other than the nonce", async () => {
    // Given
    const chains = fakeChains({ refusesClaim: new InvalidTxError({ type: "Invalid", value: { type: "Payment" } }) })
    const { link } = linkWith(chains)

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("failed")
    expect(chains.refused).toEqual(["claim"])
    expect(chains.sent).toEqual([])
  })

  it("ends already linked by root when the pool refuses the claim as Stale and the name is linked meanwhile under another display name", async () => {
    // Given
    const chains = fakeChains({
      refusesClaim: stale(),
      linkedMeanwhile: true,
      names: { [ROOT.ss58]: "alicewood" },
      usernameOwners: { "alice.07": ROOT.ss58 },
    })
    const { link } = linkWith(chains, { username: "alice.07" })

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("already-linked")
    expect(chains.refused).toEqual(["claim"])
    expect(chains.sent).toEqual([])
  })

  it("sends the note once more when the pool refuses it as Future", async () => {
    // Given
    const facts: Record<string, string> = {}
    const chains = fakeChains({ refusesWrites: [future()] })
    const { link } = linkWith(chains, { onFacts: (found) => Object.assign(facts, found) })

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("linked")
    expect(chains.refused).toEqual(["write"])
    expect(chains.sent).toEqual(["claim", "write"])
    expect(facts["name_link.nonce_refused"]).toBe("Future")
  })

  it("ends already linked when the pool refuses the note as Stale and the name is linked meanwhile", async () => {
    // Given
    const chains = fakeChains({ refusesWrites: [stale()], linkedMeanwhile: true })
    const { link } = linkWith(chains)

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("already-linked")
    expect(chains.refused).toEqual(["write"])
    expect(chains.sent).toEqual(["claim"])
  })

  it("sends the note once more when the pool refuses it as Stale and the note still shows another name", async () => {
    // Given
    const chains = fakeChains({
      linkedTo: OTHER.publicKey,
      names: { [OTHER.ss58]: "someone-else", [ROOT.ss58]: "alice.05" },
      usernameOwners: { "alice.05": ROOT.ss58 },
      refusesWrites: [stale()],
    })
    const { link } = linkWith(chains)

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("linked")
    expect(chains.refused).toEqual(["write"])
    expect(chains.sent).toEqual(["write"])
  })

  it("asks the root while the allowance lands, so the signature adds no time of its own", async () => {
    // Given: no PGAS, an allowance that lands 5 s later, and a root that takes 4 s to sign
    vi.useFakeTimers()
    const chains = fakeChains({ pgas: 0n })
    const allowance = vi.fn(async () => {
      setTimeout(() => (chains.balance.pgas = 50_000_000_000n), 5_000)
      return "Allocated"
    })
    const signedAt: number[] = []
    const signAsRoot = vi.fn(async (_username: string, message: Uint8Array) => {
      signedAt.push(Date.now())
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      return { root: ROOT.publicKey, signature: ROOT.sign(wrapBytes(message)) }
    })
    const { link } = linkWith(chains, { allowance, signAsRoot })
    const startedAt = Date.now()
    let outcome: string | undefined

    // When
    void linkName(link).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(6_000)

    // Then: asked at once, and the link is done a second after the PGAS landed, not five
    expect(signedAt[0]! - startedAt).toBeLessThan(1_000)
    expect(outcome).toBe("linked")
    expect(chains.sent).toEqual(["claim", "write"])
  })

  it("ends unfunded, writing nothing, when a granted allowance never lands", async () => {
    // Given
    vi.useFakeTimers()
    const chains = fakeChains({ pgas: 0n })
    const { link } = linkWith(chains, { allowance: async () => "Allocated" })
    let outcome: string | undefined

    // When
    void linkName(link).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(31_000)

    // Then
    expect(outcome).toBe("unfunded")
    expect(chains.sent).toEqual([])
  })

  it("returns unfunded only once the root's prompt it raised is answered", async () => {
    // Given: an allowance that never lands, and a player who answers the root's prompt after 40 s
    vi.useFakeTimers()
    const chains = fakeChains({ pgas: 0n })
    const signAsRoot = vi.fn(async (_username: string, message: Uint8Array) => {
      await new Promise((resolve) => setTimeout(resolve, 40_000))
      return { root: ROOT.publicKey, signature: ROOT.sign(wrapBytes(message)) }
    })
    const { link } = linkWith(chains, { allowance: async () => "Allocated", signAsRoot })
    let outcome: string | undefined

    // When
    void linkName(link).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(31_000)

    // Then: the prompt is still up, so the link is not over
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(outcome).toBe("unfunded")
    expect(chains.sent).toEqual([])
  })

  it("starts no further step once it is stopped, after the prompt up is answered", async () => {
    // Given: the PGAS lands in 5 s, the root signs in 10 s, and the link is stopped at 2 s
    vi.useFakeTimers()
    const chains = fakeChains({ pgas: 0n })
    const allowance = vi.fn(async () => {
      setTimeout(() => (chains.balance.pgas = 50_000_000_000n), 5_000)
      return "Allocated"
    })
    const signAsRoot = vi.fn(async (_username: string, message: Uint8Array) => {
      await new Promise((resolve) => setTimeout(resolve, 10_000))
      return { root: ROOT.publicKey, signature: ROOT.sign(wrapBytes(message)) }
    })
    const stop = new AbortController()
    const { link } = linkWith(chains, { allowance, signAsRoot, signal: stop.signal })
    let outcome: string | undefined

    // When
    void linkName(link).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(2_000)
    stop.abort(new Error("the link ran out of time"))
    await vi.advanceTimersByTimeAsync(5_000)

    // Then: not over while the prompt is up, and nothing written after it
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(outcome).toBe("failed")
    expect(signAsRoot).toHaveBeenCalledTimes(1)
    expect(chains.sent).toEqual([])
  })

  it("stops unfunded, before any signature, when the allowance is refused", async () => {
    // Given
    const chains = fakeChains({ pgas: 0n, native: 0n })
    const { link, signAsRoot } = linkWith(chains, { allowance: async () => "Rejected" })

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("unfunded")
    expect(signAsRoot).not.toHaveBeenCalled()
    expect(chains.sent).toEqual([])
  })

  it("writes nothing when the root does not sign", async () => {
    // Given: the player declines the host's confirmation
    const chains = fakeChains()
    const { link } = linkWith(chains, { signAsRoot: async () => Promise.reject(new Error("Rejected")) })

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("not-signed")
    expect(chains.sent).toEqual([])
  })

  it.each(['No account owns DotNS username "alice.05"', "no account owns alice.05"])("says nobody owns the username when signing fails with: %s", async (error) => {
    // Given
    const chains = fakeChains()
    const { link } = linkWith(chains, { signAsRoot: async () => Promise.reject(new Error(error)) })

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("unowned")
    expect(chains.sent).toEqual([])
  })

  it("says nobody owns the username before the deposit when the People chain answers none (#1115)", async () => {
    // Given: the host's username has no owner on chain
    const chains = fakeChains({ pgas: 0n, usernameOwners: {} })
    const stages: string[] = []
    const allowance = vi.fn(async () => "Allocated")
    const { link, signAsRoot } = linkWith(chains, { allowance, onStage: (stage) => stages.push(stage) })

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("unowned")
    expect(stages).toEqual(["lookup"])
    expect(allowance).not.toHaveBeenCalled()
    expect(signAsRoot).not.toHaveBeenCalled()
    expect(chains.sent).toEqual([])
  })

  it("reads the owner at the best block, so a username claimed a few blocks ago is not unowned", async () => {
    // Given: finality trails the claim
    const chains = fakeChains({ finalityLags: true })
    const { link } = linkWith(chains)

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("linked")
  })

  it("goes on with the link when the owner read fails, and never calls that unowned", async () => {
    // Given: the People read of the owner throws
    const chains = fakeChains({ ownerReadFails: true })
    const { link, signAsRoot } = linkWith(chains)

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("linked")
    expect(signAsRoot).toHaveBeenCalledTimes(1)
    expect(chains.sent).toEqual(["claim", "write"])
  })

  it("writes nothing for a signature that is not the root's", async () => {
    // Given
    const chains = fakeChains()
    const { link } = linkWith(chains, { signAsRoot: async (_name, message) => ({ root: ROOT.publicKey, signature: OTHER.sign(wrapBytes(message)) }) })

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("failed")
    expect(chains.sent).toEqual([])
  })

  it("names each step as it starts, and what the deposit found", async () => {
    // Given
    const chains = fakeChains()
    const stages: string[] = []
    const facts: Record<string, string> = {}
    const { link } = linkWith(chains, { onStage: (stage) => stages.push(stage), onFacts: (found) => Object.assign(facts, found) })

    // When
    await linkName(link)

    // Then
    expect(stages).toEqual(["lookup", "funds", "sign", "store", "note", "verify"])
    expect(facts).toEqual({
      "name_link.lookup_reason": "no-store",
      "name_link.already_linked": "false",
      "name_link.store": "none",
      "name_link.allowance": "not-needed",
      "name_link.paid_in": "pgas",
    })
  })

  it("says the host refused the allowance and nothing pays, then stops at the deposit", async () => {
    // Given
    const chains = fakeChains({ pgas: 0n, native: 0n })
    const stages: string[] = []
    const facts: Record<string, string> = {}
    const { link } = linkWith(chains, {
      allowance: async () => "Rejected",
      onStage: (stage) => stages.push(stage),
      onFacts: (found) => Object.assign(facts, found),
    })

    // When
    await linkName(link)

    // Then
    expect(stages).toEqual(["lookup", "funds"])
    expect(facts).toMatchObject({ "name_link.allowance": "not-allocated", "name_link.allowance_answer": "Rejected", "name_link.paid_in": "none" })
  })

  it("links all the same when a telemetry hook throws", async () => {
    // Given
    const chains = fakeChains()
    const boom = () => {
      throw new Error("telemetry")
    }
    const { link } = linkWith(chains, { onStage: boom, onFacts: boom })

    // When
    const outcome = await linkName(link)

    // Then
    expect(outcome).toBe("linked")
  })
})
