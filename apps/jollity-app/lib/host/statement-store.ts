// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The host's statement store, proving AS THE PLAYER.
 *
 * Who signs a statement decides whether the node keeps it. The store checks
 * `:statement_allowance:` for the PROOF's signer, and the Game pallet grants
 * that allowance to the account that signed up (`PlayerStatementLimit`, on
 * every `sign_up*` of an account-identified player). So game signalling must
 * be proved by the playing product account — `truApi.statementStore
 * .createProof({ productAccountId })` — and never by `createProofAuthorized`,
 * which signs with the product's allowance account (TrUAPI RFC-0010; the RFCs
 * live in github.com/paritytech/truapi under docs/rfcs/): a different key,
 * with no allowance from the pallet (`noAllowance` on submit; on the CLI host
 * it cannot even sign: `UnableToSign`). Both were measured on truapi-host
 * 0.13.1. The `/permissions` allowance step is about the product's own slot
 * and is irrelevant here.
 *
 * `createProof` is marked deprecated upstream in favour of the authorized
 * path; that recommendation is for products whose statements are the
 * product's. Ours are the player's, by the pallet's rule — the seam
 * (`StatementStoreLike.createProofAuthorized`) keeps its name because the
 * policy layer does not care which key, only that a proof comes back.
 *
 * Subscribe and submit go through `getStatementStore()`, the host's gossip.
 */
import type { ProductAccount } from "@parity/product-sdk-host"
import type { StatementStoreLike, WireStatement } from "@jollity/statement-core"
import { devLog } from "../debug/log-store"

type HostSdk = typeof import("@parity/product-sdk-host")

/** What the caller wants told about a subscription: this doorway knows no
 *  telemetry, the caller hangs it on. */
export interface SubscriptionHooks {
  /** the host subscription is about to open */
  onSubscribed?(): void
  /** the subscription delivered its first page */
  onFirstPage?(): void
  /** the host ended the subscription (it is opened again, see RESUBSCRIBE_MS) */
  onInterrupted?(reason: string): void
  /** the subscription was opened again after the host ended it; `attempt`
   *  counts the reopenings since pages last flowed */
  onResubscribed?(attempt: number): void
}

/** How long to wait before opening a subscription the host ended, by attempt:
 *  a room whose subscription died hears nobody, so it is opened again until
 *  pages flow, which starts the count over. */
const RESUBSCRIBE_MS = [1000, 2000, 4000, 8000, 16000]

/**
 * A `StatementStoreLike` over the host for `account`, or null when the host
 * offers no store (the mesh then stays dark, by design — never a fake store).
 */
export async function playerStatementStore(
  sdk: HostSdk,
  account: ProductAccount,
  hooks: SubscriptionHooks = {},
): Promise<StatementStoreLike | null> {
  const [store, truApi] = await Promise.all([sdk.getStatementStore(), sdk.getTruApi()])
  if (!store || !truApi) return null
  const productAccountId = {
    dotNsIdentifier: account.dotNsIdentifier,
    derivationIndex: { tag: "Index" as const, value: account.derivationIndex },
  }
  const toHostStatement = (wire: WireStatement) => ({
    expiry: wire.expiry,
    channel: wire.channel as `0x${string}`,
    topics: wire.topics as `0x${string}`[],
    data: wire.data as `0x${string}`,
  })
  return {
    async createProofAuthorized(wire) {
      const result = await truApi.statementStore.createProof({
        productAccountId,
        statement: toHostStatement(wire),
      })
      return result.match(
        (value) => value.proof,
        (error) => {
          throw new Error(`statement proof refused: ${sdk.formatHostError(error)}`)
        },
      )
    },
    async submit(wire) {
      await store.submit({
        ...toHostStatement(wire),
        proof: wire.proof as Parameters<typeof store.submit>[0]["proof"],
      })
    },
    subscribe(filter, onPage) {
      // Every page and every interruption goes to the debug sheet: a phone
      // that "never receives anything" is only diagnosable if
      // the export shows whether the host delivered empty pages, no pages,
      // or ended the subscription — the SDK reports the last one only
      // through `onInterrupt`, and nothing else in the app would ever see it.
      // An ended subscription is opened again (RESUBSCRIBE_MS), with the same
      // page handler: the transport drops what it has already seen.
      let pages = 0
      let statements = 0
      let attempt = 0
      let closed = false
      let retry: ReturnType<typeof setTimeout> | null = null
      let current: { unsubscribe(): void } | null = null
      hooks.onSubscribed?.()
      const open = () => {
        const subscription = store.subscribe({ matchAny: filter.matchAny as `0x${string}`[] }, (page) => {
          attempt = 0 // pages flow: the backoff starts over
          pages += 1
          statements += page.statements.length
          if (pages === 1) hooks.onFirstPage?.()
          if (pages <= 3 || pages % 25 === 0)
            devLog("statement", `page ${pages}: ${page.statements.length} statements (${statements} total)`)
          onPage({ statements: page.statements.map((statement) => ({ data: statement.data })) })
        })
        current = subscription
        devLog("statement", attempt === 0 ? "host subscription opened" : `host subscription opened again (attempt ${attempt})`, {
          topics: filter.matchAny.length,
        })
        const withInterrupt = subscription as typeof subscription & {
          onInterrupt?: (callback: (reason?: unknown) => void) => () => void
        }
        withInterrupt.onInterrupt?.((reason) => {
          if (closed || current !== subscription) return
          const why = reason === undefined ? "completed" : sdk.formatHostError(reason as never)
          const wait = RESUBSCRIBE_MS[Math.min(attempt, RESUBSCRIBE_MS.length - 1)]!
          devLog("statement", "host subscription ENDED by the host", { reason: why, pages, statements, reopenInMs: wait }, "error")
          hooks.onInterrupted?.(why)
          attempt += 1
          retry = setTimeout(() => {
            retry = null
            if (closed) return
            hooks.onResubscribed?.(attempt)
            open()
          }, wait)
        })
      }
      open()
      return {
        unsubscribe: () => {
          closed = true
          if (retry) clearTimeout(retry)
          current?.unsubscribe()
        },
      }
    },
  }
}
