// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * LINKING A PLAYER'S NAME (#456): the one-time step after which the draw's
 * wheel shows this player's username on their tickets (./dotns-names.ts).
 * Each surface that signs a player up runs it through its name gate
 * (./name-gate.ts) and hands in what only it can reach; the steps are these:
 *
 *   1. nothing more if the playing account's store already holds a note signed
 *      for it by the owner of this username;
 *   2. the deposit. Asset Hub's contracts take it in PGAS when the account holds
 *      enough (pallet-revive's `PGasDeposit`, falling back to the native coin),
 *      so an account short of both first asks the host for its PGAS allowance,
 *      and waits for it to land. Still short, it stops there;
 *   3. the ROOT account that owns the username signs "<product> names v1\n" +
 *      the playing account's contract address, through the host's raw
 *      signing, which wraps it in `<Bytes>…</Bytes>` so the signature cannot
 *      pass for a transaction's. Whether the player is asked depends on the
 *      host: newer hosts sign such a wrapped message for a product they trust
 *      without a prompt, while other hosts, and a phone signing for a paired
 *      desktop, ask the player to confirm. Do not rely on either;
 *   4. the playing account claims its DotNS User Store if it has none, and keeps
 *      the note in it: two contract calls, signed on transaction pipeline 1,
 *      which pays the fees in PGAS as well.
 *
 * Nothing here can undo a sign-up or fail it: a link that does not happen only
 * leaves the tickets nameless. Never throws; the outcome says what happened
 * and the log says why. Once `signal` aborts, the link starts no further step
 * and ends `failed`, but a step under way finishes first: a root signature the
 * player has not answered yet, or a transaction not yet in a block.
 */
import { AccountId, type PolkadotClient } from "polkadot-api"
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"
import { dispatchErrorName, isNonceRefusal } from "@individuality/people-chain"
import {
  DOTNS_CONTRACTS,
  dotnsNames,
  encodeNote,
  linkMessage,
  NOTE_KEY,
  peopleNames,
  reviveCall,
  selector,
  setValueCalldata,
  usernameOwner,
  verifyLink,
} from "./dotns-names"

export type LinkOutcome =
  /** the note is written and reads back as this username */
  | "linked"
  /** the account already carried a note for this username */
  | "already-linked"
  /** neither PGAS nor the native coin covers the deposit, the allowance included */
  | "unfunded"
  /** the root did not sign: the player declined, or the host could not ask */
  | "not-signed"
  /** nobody owns the username on the People chain, so no root can sign for it:
   *  the owner read answered none before the deposit, or the SDK said so at the signature */
  | "unowned"
  | "failed"

/** The SDK has no error type for this, so its words and the chat's are all there is to read. */
const UNOWNED_USERNAME = /no account owns/i

/** The steps of a link, in order, as `onStage` names them: the read of the
 *  current note, the deposit (with the allowance), the root's signature, the
 *  store's claim, the note's write, and the read back. */
export type LinkStage = "lookup" | "funds" | "sign" | "store" | "note" | "verify"

export interface NameLink {
  /** the product the note is for, such as `dim2.paseo` */
  product: string
  /** the playing account's public key: the one that holds the draw tickets */
  account: Uint8Array
  /** the player's username, as the host gives it */
  username: string
  assetHub: PolkadotClient
  people: PolkadotClient
  /** the playing account's signer, on transaction pipeline 1 (PGAS fees) */
  signer: CommonSignerTxCreator
  /** The root account that owns `username` signs `message`: its key, and the signature. */
  signAsRoot(username: string, message: Uint8Array): Promise<{ root: Uint8Array; signature: Uint8Array }>
  /** Asks the host for the account's PGAS allowance; the host's answer ("Allocated" when it gave it). */
  allowance?(): Promise<string>
  log(message: string, data?: Record<string, unknown>, level?: "info" | "warn"): void
  /** stops the link before its next step (the name gate's deadline) */
  signal?: AbortSignal
  /** Each step as it starts, for telemetry. */
  onStage?(stage: LinkStage): void
  /** What a step found, as fixed words for telemetry: `name_link.lookup_reason`,
   *  `name_link.already_linked`, `name_link.store` (existing, none),
   *  `name_link.allowance` (not-needed, allocated, not-allocated) with the
   *  host's own answer in `name_link.allowance_answer`,
   *  `name_link.paid_in` (pgas, native, none), and
   *  `name_link.nonce_refused` (Stale, Future). */
  onFacts?(facts: Record<string, string>): void
}

/** what a link needs before it starts, in PGAS or the native coin: the store, the note, and the fees */
const NEEDED_WITH_STORE = 7_000_000_000n // 0.7
const NEEDED_NOTE_ONLY = 2_500_000_000n // 0.25
/** the PGAS asset on Asset Hub, when the chain does not say (`Pgas.PgasAssetId`) */
const PGAS_ASSET_ID = 2_000_000_000
/** the host claims the allowance on chain: the PGAS lands a block or two later */
const ALLOWANCE_WAIT_MS = 30_000
/** how often the balance is read while the allowance lands: a best-block read
 *  is cheap, and every second saved here is one the player may be waiting */
const ALLOWANCE_POLL_MS = 1_000

/** a username without the `.dot` a host may add: People keys usernames bare */
const bareUsername = (username: string) => username.replace(/\.dot$/, "")

/**
 * The link reads and writes at the best block: its balances, every DotNS read,
 * and its two transactions, which count as done once a best block holds them.
 * Asset Hub's finality trails the best block by 20 to 40 s. Read at the
 * finalized block, a link once gave up unfunded after its PGAS had landed, and
 * waiting for each write to finalize took a link 80 s. Each step reads what the one before it wrote, so they move together: a
 * write at best followed by a finalized read would not find the store.
 */
type AtBest = { at: "best" }
const AT_BEST: AtBest = { at: "best" }

/** How long one transaction may take to reach a best block. */
const BEST_BLOCK_WAIT_MS = 120_000

/** One event of a transaction's watch, as far as the link reads it. */
interface TxEvent {
  type: string
  ok?: boolean
  block?: { number: number }
}
interface TxWatch {
  subscribe(observer: { next(event: TxEvent): void; error(error: unknown): void; complete(): void }): {
    unsubscribe(): void
  }
}

/**
 * The first best block that holds the transaction, and whether it dispatched.
 * A block that falls out of the best chain (`notInBestBlock`) is waited past.
 */
function inBestBlock(watch: TxWatch): Promise<{ ok: boolean; block: number }> {
  return new Promise((resolve, reject) => {
    let settled = false
    // the watch may emit while subscribe is still running, before `sub` is set
    // eslint-disable-next-line prefer-const
    let sub: { unsubscribe(): void } | undefined
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      sub?.unsubscribe()
      settle()
    }
    const deadline = setTimeout(
      () => finish(() => reject(new Error(`no best block held it in ${BEST_BLOCK_WAIT_MS / 1000}s`))),
      BEST_BLOCK_WAIT_MS,
    )
    sub = watch.subscribe({
      next: (event) => {
        if (event.type === "inBestBlock" || event.type === "finalized")
          finish(() => resolve({ ok: event.ok ?? false, block: event.block?.number ?? -1 }))
      },
      error: (error) => finish(() => reject(error)),
      complete: () => finish(() => reject(new Error("the transaction watch ended before any block held it"))),
    })
    if (settled) sub.unsubscribe()
  })
}

/** The slice of Asset Hub's unsafe API a link takes, typed here once (a chat worker links without descriptors). */
interface AssetHubLinkApi {
  constants: { Pgas: { PgasAssetId(): Promise<number | bigint> } }
  query: {
    System: { Account: { getValue(account: string, options: AtBest): Promise<{ data: { free: bigint } }> } }
    Assets: { Account: { getValue(asset: number, account: string, options: AtBest): Promise<{ balance: bigint } | undefined> } }
  }
  apis: {
    ReviveApi: {
      call(
        origin: string,
        dest: string,
        value: bigint,
        gasLimit: undefined,
        storageDepositLimit: undefined,
        data: Uint8Array,
        options: AtBest,
      ): Promise<{
        result: { success: boolean; value: { flags: number } }
        weight_required: { ref_time: bigint; proof_size: bigint }
        storage_deposit: { type: "Charge" | "Refund"; value: bigint }
      }>
    }
  }
  tx: {
    Revive: {
      call(args: {
        dest: string
        value: bigint
        weight_limit: { ref_time: bigint; proof_size: bigint }
        storage_deposit_limit: bigint
        data: Uint8Array
      }): { createSubmitAndWatch(signer: CommonSignerTxCreator): TxWatch }
    }
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const units = (amount: bigint) => Number(amount) / 1e10

/** Links the player's username to their playing account, the steps in the module header. Never throws: the outcome says what happened. */
export async function linkName(link: NameLink): Promise<LinkOutcome> {
  const { log } = link
  // telemetry's hooks never fail a link
  const stage = (next: LinkStage) => {
    try {
      link.onStage?.(next)
    } catch {
      /* never throws */
    }
  }
  const facts = (found: Record<string, string>) => {
    try {
      link.onFacts?.(found)
    } catch {
      /* never throws */
    }
  }
  // the root's signature, once asked for (see "funds")
  let signing: Promise<{ signed: { root: Uint8Array; signature: Uint8Array } } | { error: unknown }> | undefined
  /** A link never returns while the root prompt it raised is still up: the
   *  next link would ask over it. */
  const answered = async () => {
    if (signing) await signing
  }
  /** Throws once `signal` aborted. */
  const checkpoint = async () => {
    const signal = link.signal
    if (!signal?.aborted) return
    await answered()
    throw signal.reason instanceof Error ? signal.reason : new Error("the link was stopped")
  }
  try {
    stage("lookup")
    const playing = AccountId().dec(link.account)
    const names = dotnsNames(reviveCall(link.assetHub, AT_BEST), peopleNames(link.people), link.product)
    const api = link.assetHub.getUnsafeApi() as unknown as AssetHubLinkApi
    const pgasId = api.constants.Pgas.PgasAssetId()
      .then(Number)
      .catch(() => PGAS_ASSET_ID)
    const balances = async () => {
      const asset = await pgasId
      const [native, pgas] = await Promise.all([
        api.query.System.Account.getValue(playing, AT_BEST).then((account) => account.data.free),
        api.query.Assets.Account.getValue(asset, playing, AT_BEST).then((account) => account?.balance ?? 0n),
      ])
      return { native, pgas }
    }
    // ONE ROUND for the reads the link starts from: the current note, the
    // store and the balances. A name already linked has read a little more
    // than it needed; every other link starts its deposit a round sooner.
    const [now, store, firstBalances] = await Promise.all([
      names.lookup(playing),
      names.storeOf(link.account),
      balances().catch(() => null),
    ])
    const sameName = !!now.name && bareUsername(now.name) === bareUsername(link.username)
    // The username's owner on the People chain, read once. A read that
    // answered "nobody" is the one sign of an unowned username before the
    // deposit; a read that failed says nothing, and the link goes on (#1115).
    // At the best block, as every read here: a username claimed a few blocks
    // ago is not "nobody".
    const ownerRead: { owner: Uint8Array | null } | { error: unknown } | null = sameName
      ? null
      : await usernameOwner(link.people, link.username, AT_BEST).then(
          (owner) => ({ owner }),
          (error: unknown) => ({ error }),
        )
    const owner = ownerRead && "owner" in ownerRead ? ownerRead.owner : null
    const sameRoot = !!owner && !!now.root && AccountId().dec(owner) === now.root
    const alreadyLinked = sameName || sameRoot
    facts({ "name_link.lookup_reason": now.reason, "name_link.already_linked": alreadyLinked ? "true" : "false" })
    if (alreadyLinked) {
      log(`already linked: ${now.name}`)
      return "already-linked"
    }
    if (ownerRead && "owner" in ownerRead && !ownerRead.owner) {
      // no root can sign for it: the allowance and the signature would only be asked for in vain
      log("no account owns the username on the People chain", undefined, "warn")
      return "unowned"
    }

    await checkpoint()
    stage("funds")
    facts({ "name_link.store": store ? "existing" : "none" })
    const needed = store ? NEEDED_NOTE_ONLY : NEEDED_WITH_STORE
    let has = firstBalances ?? (await balances())
    // the root's signature: the proof the wheel believes. It needs nothing the
    // deposit does, so it is asked for as soon as the link can be paid, and
    // runs while the allowance lands. Never before: a host that still asks
    // the player (a desktop paired with a phone) must not ask for a link that
    // cannot be paid.
    const signRoot = () =>
      link.signAsRoot(bareUsername(link.username), linkMessage(link.product, link.account)).then(
        (signed) => ({ signed }),
        (error: unknown) => ({ error }),
      )
    const covered = () => has.pgas >= needed || has.native >= needed
    if (!covered() && link.allowance) {
      await checkpoint()
      const answer = await link.allowance().catch((error: unknown) => `failed: ${messageOf(error)}`)
      log(`asked the host for the playing account's PGAS allowance: ${answer}`)
      facts({ "name_link.allowance": answer === "Allocated" ? "allocated" : "not-allocated", "name_link.allowance_answer": answer })
      if (answer === "Allocated") signing = signRoot()
      for (let waited = 0; answer === "Allocated" && waited < ALLOWANCE_WAIT_MS && has.pgas < needed; waited += ALLOWANCE_POLL_MS) {
        await new Promise((resolve) => setTimeout(resolve, ALLOWANCE_POLL_MS))
        await checkpoint()
        has = await balances()
      }
    }
    else facts({ "name_link.allowance": "not-needed" })
    log("the playing account's balances", { account: playing, pgas: units(has.pgas), native: units(has.native) })
    facts({ "name_link.paid_in": has.pgas >= needed ? "pgas" : has.native >= needed ? "native" : "none" })
    if (!covered()) {
      log("the playing account cannot pay the link's deposit on Asset Hub", { needs: units(needed) }, "warn")
      await answered()
      return "unfunded"
    }

    await checkpoint()
    stage("sign")
    const answer = await (signing ?? signRoot())
    if ("error" in answer) {
      log("the root did not sign the note", { detail: messageOf(answer.error) }, "warn")
      return UNOWNED_USERNAME.test(messageOf(answer.error)) ? "unowned" : "not-signed"
    }
    const { signed } = answer
    if (!verifyLink(link.product, link.account, signed.root, signed.signature)) {
      log("the root's signature does not check out", undefined, "warn")
      return "failed"
    }

    const submit = async (label: string, dest: string, data: Uint8Array): Promise<"Stale" | "Future" | undefined> => {
      await checkpoint()
      const dry = await api.apis.ReviveApi.call(playing, dest, 0n, undefined, undefined, data, AT_BEST)
      if (!dry.result.success || dry.result.value.flags & 1) throw new Error(`${label}: the dry run failed`)
      const { ref_time, proof_size } = dry.weight_required
      const tx = api.tx.Revive.call({
        dest,
        value: 0n,
        weight_limit: { ref_time: (ref_time * 13n) / 10n, proof_size: (proof_size * 13n) / 10n },
        storage_deposit_limit: dry.storage_deposit.type === "Charge" ? (dry.storage_deposit.value * 12n) / 10n + 1n : 0n,
        data,
      })
      let result: { ok: boolean; block: number }
      try {
        result = await inBestBlock(tx.createSubmitAndWatch(link.signer))
      } catch (error) {
        const refusal = dispatchErrorName(error)
        if (!isNonceRefusal(refusal)) throw error
        log(`${label}: the pool refused the nonce`, { detail: messageOf(error) }, "warn")
        facts({ "name_link.nonce_refused": refusal })
        return refusal
      }
      if (!result.ok) throw new Error(`${label}: the transaction failed`)
      log(`${label} in best block #${result.block}`, { deposit: units(dry.storage_deposit.value) })
      return undefined
    }
    /** Two surfaces can link with one account at the same time, so a
     *  transaction of the other can take the nonce. A refused step is sent
     *  once more, unless the chain already holds the name or what the step was for. */
    const sendOrResend = async (label: string, dest: string, data: Uint8Array, landedMeanwhile?: () => Promise<boolean>) => {
      if (!(await submit(label, dest, data))) return "sent"
      const seen = await names.lookup(playing)
      const sameName = !!seen.name && bareUsername(seen.name) === bareUsername(link.username)
      const owner = !sameName && seen.root ? await usernameOwner(link.people, link.username, AT_BEST).catch(() => null) : null
      if (sameName || (!!owner && AccountId().dec(owner) === seen.root)) {
        log(`already linked: ${seen.name}`)
        return "already-linked"
      }
      if (await landedMeanwhile?.()) return "sent"
      const again = await submit(label, dest, data)
      if (again) throw new Error(`${label}: the pool refused the nonce twice (${again})`)
      return "sent"
    }
    if (!store) {
      stage("store")
      const storeNow = async () => !!(await names.storeOf(link.account))
      if ((await sendOrResend("claimed the DotNS store", DOTNS_CONTRACTS.storeFactory, selector("claimUserStore()"), storeNow)) === "already-linked")
        return "already-linked"
    }
    stage("note")
    const ours = store ?? (await names.storeOf(link.account))
    if (!ours) throw new Error("the store did not appear")
    const note = setValueCalldata(NOTE_KEY, encodeNote(signed.root, signed.signature))
    if ((await sendOrResend("wrote the signed note", ours, note)) === "already-linked") return "already-linked"
    await checkpoint()
    stage("verify")
    const after = await names.lookup(playing)
    if (!after.name) {
      log(`written, but the note shows no name: ${after.why}`, undefined, "warn")
      return "failed"
    }
    log(`linked: tickets now show ${after.name}`)
    return "linked"
  } catch (error) {
    log(link.signal?.aborted ? "the link stopped" : "linking the name failed", { detail: messageOf(error) }, "warn")
    await answered()
    return "failed"
  }
}
